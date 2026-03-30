import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { SessionFile } from '../types';
import { TASK_DETECTOR_POLL_MS, TASK_NOTIFICATION_COOLDOWN_MS } from '../constants';

interface SessionWatch {
  jsonlPath: string;
  lastSize: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastNotifiedAt: number;
}

export class TaskCompletionDetector implements vscode.Disposable {
  private readonly _onTaskCompleted = new vscode.EventEmitter<{
    sessionId: string;
    cwd: string;
  }>();
  readonly onTaskCompleted = this._onTaskCompleted.event;

  private watches = new Map<string, SessionWatch>();
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private idleThresholdMs = 10_000;

  constructor(idleThresholdSeconds: number = 10) {
    this.idleThresholdMs = idleThresholdSeconds * 1000;
    this.pollInterval = setInterval(() => this.pollAll(), TASK_DETECTOR_POLL_MS);
  }

  updateIdleThreshold(seconds: number): void {
    this.idleThresholdMs = seconds * 1000;
  }

  updateSessions(sessions: SessionFile[], claudeHomePath: string): void {
    const activeIds = new Set(sessions.map((s) => s.sessionId));

    // Remove watches for sessions that are no longer active
    for (const [sessionId, watch] of this.watches) {
      if (!activeIds.has(sessionId)) {
        if (watch.idleTimer) clearTimeout(watch.idleTimer);
        this.watches.delete(sessionId);
      }
    }

    // Add watches for new active sessions
    for (const session of sessions) {
      if (!this.watches.has(session.sessionId)) {
        const jsonlPath = findJsonlPath(session.sessionId, claudeHomePath);
        if (jsonlPath) {
          const size = getFileSize(jsonlPath);
          this.watches.set(session.sessionId, {
            jsonlPath,
            lastSize: size,
            idleTimer: null,
            lastNotifiedAt: 0,
          });
        }
      }
    }
  }

  private pollAll(): void {
    for (const [sessionId, watch] of this.watches) {
      const currentSize = getFileSize(watch.jsonlPath);
      if (currentSize > watch.lastSize) {
        this.onFileChanged(sessionId, watch, currentSize);
      }
    }
  }

  private onFileChanged(sessionId: string, watch: SessionWatch, newSize: number): void {
    // Read only the new bytes
    const newContent = readNewBytes(watch.jsonlPath, watch.lastSize, newSize);
    watch.lastSize = newSize;

    // Cancel any pending idle timer — new activity detected
    if (watch.idleTimer) {
      clearTimeout(watch.idleTimer);
      watch.idleTimer = null;
    }

    // Check if the last event is an assistant end_turn
    if (hasEndTurn(newContent)) {
      // Start idle timer — if no new activity within threshold, task is complete
      watch.idleTimer = setTimeout(() => {
        watch.idleTimer = null;
        const now = Date.now();
        if (now - watch.lastNotifiedAt >= TASK_NOTIFICATION_COOLDOWN_MS) {
          watch.lastNotifiedAt = now;
          // Find cwd from the session data
          const cwd = extractCwd(watch.jsonlPath, sessionId);
          this._onTaskCompleted.fire({ sessionId, cwd });
        }
      }, this.idleThresholdMs);
    }
  }

  dispose(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    for (const [, watch] of this.watches) {
      if (watch.idleTimer) clearTimeout(watch.idleTimer);
    }
    this.watches.clear();
    this._onTaskCompleted.dispose();
  }
}

function findJsonlPath(sessionId: string, claudeHomePath: string): string | null {
  const projectsDir = path.join(claudeHomePath, 'projects');
  try {
    const dirs = fs.readdirSync(projectsDir);
    for (const dir of dirs) {
      const jsonlPath = path.join(projectsDir, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(jsonlPath)) {
        return jsonlPath;
      }
    }
  } catch (_e) {
    // projects directory might not exist
  }
  return null;
}

function getFileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch (_e) {
    return 0;
  }
}

function readNewBytes(filePath: string, fromByte: number, toByte: number): string {
  try {
    const fd = fs.openSync(filePath, 'r');
    const length = toByte - fromByte;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, fromByte);
    fs.closeSync(fd);
    return buffer.toString('utf-8');
  } catch (_e) {
    return '';
  }
}

function hasEndTurn(content: string): boolean {
  const lines = content.split('\n').filter((l) => l.trim());
  // Check lines in reverse — we care about the last assistant message
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i]);
      if (event.type === 'assistant' && event.message?.stop_reason === 'end_turn') {
        return true;
      }
      // If we hit a user message or tool_use, stop looking
      if (event.type === 'user') return false;
      if (event.type === 'assistant' && event.message?.stop_reason === 'tool_use') return false;
    } catch (_e) {
      // skip malformed lines
    }
  }
  return false;
}

function extractCwd(jsonlPath: string, sessionId: string): string {
  // The project directory name in the path encodes the cwd
  // e.g., ~/.claude/projects/-Users-alireza-WebstormProjects-claude-pulse/sessionId.jsonl
  const projectDir = path.basename(path.dirname(jsonlPath));
  // Convert dashes back to path separators: -Users-alireza → /Users/alireza
  const cwd = projectDir.replace(/^-/, '/').replace(/-/g, '/');
  return cwd || sessionId;
}
