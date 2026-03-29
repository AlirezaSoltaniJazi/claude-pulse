import * as vscode from 'vscode';
import { ClaudePulseConfig } from '../config/configManager';
import { SessionFile } from '../types';
import { SessionMonitor } from './sessionMonitor';

export class NotificationManager implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private config: ClaudePulseConfig;
  private resetTimerFired = false;

  constructor(config: ClaudePulseConfig, sessionMonitor: SessionMonitor) {
    this.config = config;

    this.disposables.push(
      sessionMonitor.onSessionStarted((session) => {
        if (this.config.notifications.enabled && this.config.notifications.onNewSession) {
          this.notify(
            `Claude session started (PID: ${session.pid})`,
            `Working directory: ${session.cwd}`
          );
        }
      })
    );

    this.disposables.push(
      sessionMonitor.onSessionEnded((session) => {
        if (this.config.notifications.enabled && this.config.notifications.onSessionEnd) {
          this.notify(
            `Claude session ended (PID: ${session.pid})`,
            `Session ${session.sessionId.substring(0, 8)} has ended`
          );
        }
      })
    );
  }

  updateConfig(config: ClaudePulseConfig): void {
    this.config = config;
  }

  checkResetTimer(activeSession: SessionFile | null, resetTimerAnchor: number | null): void {
    if (!this.config.notifications.enabled || !this.config.notifications.onResetTimerComplete) {
      return;
    }

    if (!activeSession || !resetTimerAnchor) {
      this.resetTimerFired = false;
      return;
    }

    const resetMs = this.config.sessionResetIntervalMinutes * 60 * 1000;
    const elapsed = Date.now() - resetTimerAnchor;

    if (elapsed >= resetMs && !this.resetTimerFired) {
      this.resetTimerFired = true;
      this.notify(
        'Claude session reset complete',
        'Your Claude session limit has been reset. You can start a new session.'
      );
    } else if (elapsed < resetMs) {
      this.resetTimerFired = false;
    }
  }

  private notify(title: string, body: string): void {
    // VS Code in-app notification
    vscode.window.showInformationMessage(`Claude Pulse: ${title}`);

    // OS-level notification
    if (this.config.notifications.useSystemNotifications) {
      this.sendSystemNotification(title, body);
    }
  }

  private sendSystemNotification(title: string, body: string): void {
    try {
      // Dynamic import to avoid requiring node-notifier when not needed
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const notifier = require('node-notifier');
      notifier.notify({
        title: `Claude Pulse: ${title}`,
        message: body,
        sound: true,
      });
    } catch (e) {
      // node-notifier not available or failed
      console.warn(
        `Claude Pulse: System notification failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}
