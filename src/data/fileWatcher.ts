import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export class FileWatcher implements vscode.Disposable {
  private readonly _onStatsChanged = new vscode.EventEmitter<void>();
  private readonly _onSessionsChanged = new vscode.EventEmitter<void>();

  readonly onStatsChanged = this._onStatsChanged.event;
  readonly onSessionsChanged = this._onSessionsChanged.event;

  private sessionWatcher: fs.FSWatcher | null = null;
  private pollingInterval: ReturnType<typeof setInterval> | null = null;
  private lastStatsModified: number = 0;

  constructor(
    private claudeHomePath: string,
    private pollingIntervalMs: number = 30000
  ) {}

  start(): void {
    this.watchSessions();
    this.startPolling();
  }

  updatePollingInterval(ms: number): void {
    this.pollingIntervalMs = ms;
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.startPolling();
    }
  }

  private watchSessions(): void {
    const sessionsDir = path.join(this.claudeHomePath, 'sessions');

    try {
      this.sessionWatcher = fs.watch(sessionsDir, (_eventType, _filename) => {
        this._onSessionsChanged.fire();
      });
    } catch (_e) {
      // Sessions directory might not exist yet — will retry on next poll
    }
  }

  private startPolling(): void {
    const statsPath = path.join(this.claudeHomePath, 'stats-cache.json');

    this.pollingInterval = setInterval(async () => {
      try {
        const stat = await fs.promises.stat(statsPath);
        const mtime = stat.mtimeMs;
        if (mtime > this.lastStatsModified) {
          this.lastStatsModified = mtime;
          this._onStatsChanged.fire();
        }
      } catch {
        // File might not exist
      }
    }, this.pollingIntervalMs);
  }

  dispose(): void {
    this.sessionWatcher?.close();
    this.sessionWatcher = null;

    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    this._onStatsChanged.dispose();
    this._onSessionsChanged.dispose();
  }
}
