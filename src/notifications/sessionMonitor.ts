import * as vscode from 'vscode';
import { SessionFile } from '../types';
import { isProcessAlive } from '../data/sessionReader';
import { LIVENESS_CHECK_INTERVAL_MS } from '../constants';

export class SessionMonitor implements vscode.Disposable {
  private readonly _onSessionStarted = new vscode.EventEmitter<SessionFile>();
  private readonly _onSessionEnded = new vscode.EventEmitter<SessionFile>();

  readonly onSessionStarted = this._onSessionStarted.event;
  readonly onSessionEnded = this._onSessionEnded.event;

  private knownPids = new Map<number, SessionFile>();
  private livenessInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Periodically check if known PIDs are still alive
    this.livenessInterval = setInterval(() => this.checkLiveness(), LIVENESS_CHECK_INTERVAL_MS);
  }

  updateSessions(sessions: SessionFile[]): void {
    const currentPids = new Set(sessions.map((s) => s.pid));

    // Detect new sessions
    for (const session of sessions) {
      if (!this.knownPids.has(session.pid) && isProcessAlive(session.pid)) {
        this.knownPids.set(session.pid, session);
        this._onSessionStarted.fire(session);
      }
    }

    // Detect ended sessions (file removed)
    for (const [pid, session] of this.knownPids) {
      if (!currentPids.has(pid)) {
        this.knownPids.delete(pid);
        this._onSessionEnded.fire(session);
      }
    }
  }

  private checkLiveness(): void {
    for (const [pid, session] of this.knownPids) {
      if (!isProcessAlive(pid)) {
        this.knownPids.delete(pid);
        this._onSessionEnded.fire(session);
      }
    }
  }

  dispose(): void {
    if (this.livenessInterval) {
      clearInterval(this.livenessInterval);
      this.livenessInterval = null;
    }
    this._onSessionStarted.dispose();
    this._onSessionEnded.dispose();
  }
}
