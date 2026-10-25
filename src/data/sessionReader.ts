import * as fs from 'fs';
import * as path from 'path';
import { SessionFile } from '../types';

export async function readSessions(claudeHomePath: string): Promise<SessionFile[]> {
  const sessionsDir = path.join(claudeHomePath, 'sessions');

  try {
    const files = await fs.promises.readdir(sessionsDir);
    const jsonFiles = files.filter((f) => f.endsWith('.json'));

    const sessions: SessionFile[] = [];
    for (const file of jsonFiles) {
      try {
        const content = await fs.promises.readFile(path.join(sessionsDir, file), 'utf-8');
        const session: unknown = JSON.parse(content);
        if (isValidSessionFile(session)) {
          sessions.push(session);
        }
      } catch {
        // Skip malformed session files
      }
    }

    return sessions;
  } catch {
    return [];
  }
}

/**
 * Session files are written by another program, and their fields reach process signals, file
 * paths and the dashboard's HTML. The sessionId pattern keeps `../` out of the transcript paths
 * built from it; a non-integer pid would otherwise be rendered and signalled as-is.
 */
function isValidSessionFile(value: unknown): value is SessionFile {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.pid === 'number' &&
    Number.isInteger(s.pid) &&
    s.pid > 0 &&
    typeof s.sessionId === 'string' &&
    /^[A-Za-z0-9_-]+$/.test(s.sessionId) &&
    typeof s.cwd === 'string'
  );
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function getActiveSessions(sessions: SessionFile[]): SessionFile[] {
  return sessions.filter((s) => isProcessAlive(s.pid));
}

export function getMostRecentSession(sessions: SessionFile[]): SessionFile | null {
  if (sessions.length === 0) return null;
  return sessions.reduce((latest, s) => (s.startedAt > latest.startedAt ? s : latest));
}

/**
 * Finds the session belonging to one of the open workspace folders.
 *
 * With several Claude sessions running at once, picking the first one off disk shows
 * another project's state — its model in particular, which is per-session. An exact cwd
 * match wins; otherwise the deepest containing folder wins, so a session started in a
 * subdirectory still resolves. Ties break toward the most recently started session.
 *
 * Returns null when no session belongs to the workspace, leaving the caller to fall back.
 */
export function findSessionForWorkspace(
  sessions: SessionFile[],
  workspacePaths: string[]
): SessionFile | null {
  if (sessions.length === 0 || workspacePaths.length === 0) return null;

  const roots = workspacePaths.map(normalizePath).filter((p) => p.length > 0);
  if (roots.length === 0) return null;

  let best: SessionFile | null = null;
  let bestScore = -1;

  for (const session of sessions) {
    if (!session.cwd) continue;
    const cwd = normalizePath(session.cwd);

    // Score = length of the matched root, so the deepest containing folder wins.
    let score = -1;
    for (const root of roots) {
      if (cwd === root) {
        score = Math.max(score, root.length + 1); // exact match outranks containment
      } else if (cwd.startsWith(`${root}${path.sep}`)) {
        score = Math.max(score, root.length);
      }
    }
    if (score < 0) continue;

    if (score > bestScore || (score === bestScore && best && session.startedAt > best.startedAt)) {
      best = session;
      bestScore = score;
    }
  }

  return best;
}

/** Trailing separators removed; case-folded on the case-insensitive platforms. */
function normalizePath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? resolved.toLowerCase()
    : resolved;
}
