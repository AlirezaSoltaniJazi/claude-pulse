import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';

export interface ClaudePulseConfig {
  statusBar: {
    showResetTimer: boolean;
    showTokenCount: boolean;
    showSessionCount: boolean;
  };
  sessionResetIntervalMinutes: number;
  sessionTokenLimit: number;
  pollingIntervalSeconds: number;
  usageRefreshIntervalSeconds: number;
  notifications: {
    enabled: boolean;
    useSystemNotifications: boolean;
    onNewSession: boolean;
    onSessionEnd: boolean;
    onResetTimerComplete: boolean;
    onTaskComplete: boolean;
  };
  taskCompletionIdleSeconds: number;
  claudeHomePath: string;
}

export class ConfigManager implements vscode.Disposable {
  private readonly _onConfigChanged = new vscode.EventEmitter<ClaudePulseConfig>();
  readonly onConfigChanged = this._onConfigChanged.event;

  private disposable: vscode.Disposable;

  constructor() {
    this.disposable = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudePulse')) {
        this._onConfigChanged.fire(this.getConfig());
      }
    });
  }

  getConfig(): ClaudePulseConfig {
    const cfg = vscode.workspace.getConfiguration('claudePulse');

    const customPath = cfg.get<string>('claudeHomePath', '');
    const claudeHomePath = customPath || path.join(os.homedir(), '.claude');

    return {
      statusBar: {
        showResetTimer: cfg.get<boolean>('statusBar.showResetTimer', true),
        showTokenCount: cfg.get<boolean>('statusBar.showTokenCount', false),
        showSessionCount: cfg.get<boolean>('statusBar.showSessionCount', false),
      },
      sessionResetIntervalMinutes: cfg.get<number>('sessionResetIntervalMinutes', 300),
      sessionTokenLimit: cfg.get<number>('sessionTokenLimit', 8_000_000),
      pollingIntervalSeconds: cfg.get<number>('pollingIntervalSeconds', 30),
      usageRefreshIntervalSeconds: Math.max(
        cfg.get<number>('usageRefreshIntervalSeconds', 3600),
        60
      ),
      notifications: {
        enabled: cfg.get<boolean>('notifications.enabled', false),
        useSystemNotifications: cfg.get<boolean>('notifications.useSystemNotifications', false),
        onNewSession: cfg.get<boolean>('notifications.onNewSession', true),
        onSessionEnd: cfg.get<boolean>('notifications.onSessionEnd', true),
        onResetTimerComplete: cfg.get<boolean>('notifications.onResetTimerComplete', true),
        onTaskComplete: cfg.get<boolean>('notifications.onTaskComplete', true),
      },
      taskCompletionIdleSeconds: Math.max(cfg.get<number>('taskCompletionIdleSeconds', 10), 5),
      claudeHomePath,
    };
  }

  dispose(): void {
    this.disposable.dispose();
    this._onConfigChanged.dispose();
  }
}
