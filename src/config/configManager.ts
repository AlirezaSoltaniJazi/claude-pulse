import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import {
  DEFAULT_POLLING_INTERVAL_SEC,
  DEFAULT_PROMPT_CACHE_TTL_MINUTES,
  DEFAULT_SESSION_RESET_MINUTES,
  DEFAULT_SESSION_TOKEN_LIMIT,
  DEFAULT_TASK_IDLE_SECONDS,
  DEFAULT_USAGE_REFRESH_INTERVAL_SEC,
  MAX_PROMPT_CACHE_TTL_MINUTES,
  MIN_PROMPT_CACHE_TTL_MINUTES,
  MIN_TASK_IDLE_SECONDS,
  MIN_USAGE_REFRESH_INTERVAL_SEC,
} from '../constants';

export interface ClaudePulseConfig {
  statusBar: {
    showResetTimer: boolean;
    showTokenCount: boolean;
    showSessionCount: boolean;
    showModel: boolean;
    showEffort: boolean;
    showCacheWarmth: boolean;
    showScopedUsage: boolean;
  };
  showAgentMap: boolean;
  showAgentGraph: boolean;
  promptCacheTtlMinutes: number;
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
    onApiRefresh: boolean;
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
        showModel: cfg.get<boolean>('statusBar.showModel', true),
        showEffort: cfg.get<boolean>('statusBar.showEffort', true),
        showCacheWarmth: cfg.get<boolean>('statusBar.showCacheWarmth', false),
        showScopedUsage: cfg.get<boolean>('statusBar.showScopedUsage', true),
      },
      showAgentMap: cfg.get<boolean>('showAgentMap', true),
      showAgentGraph: cfg.get<boolean>('showAgentGraph', true),
      // Clamped: a zero or negative TTL would render a permanently-cold cache, and an
      // absurdly long one a permanently-warm one. Both look like the feature is broken.
      promptCacheTtlMinutes: Math.min(
        MAX_PROMPT_CACHE_TTL_MINUTES,
        Math.max(
          MIN_PROMPT_CACHE_TTL_MINUTES,
          cfg.get<number>('promptCacheTtlMinutes', DEFAULT_PROMPT_CACHE_TTL_MINUTES)
        )
      ),
      sessionResetIntervalMinutes: cfg.get<number>(
        'sessionResetIntervalMinutes',
        DEFAULT_SESSION_RESET_MINUTES
      ),
      sessionTokenLimit: cfg.get<number>('sessionTokenLimit', DEFAULT_SESSION_TOKEN_LIMIT),
      pollingIntervalSeconds: cfg.get<number>(
        'pollingIntervalSeconds',
        DEFAULT_POLLING_INTERVAL_SEC
      ),
      usageRefreshIntervalSeconds: Math.max(
        cfg.get<number>('usageRefreshIntervalSeconds', DEFAULT_USAGE_REFRESH_INTERVAL_SEC),
        MIN_USAGE_REFRESH_INTERVAL_SEC
      ),
      notifications: {
        enabled: cfg.get<boolean>('notifications.enabled', false),
        useSystemNotifications: cfg.get<boolean>('notifications.useSystemNotifications', false),
        onNewSession: cfg.get<boolean>('notifications.onNewSession', true),
        onSessionEnd: cfg.get<boolean>('notifications.onSessionEnd', true),
        onResetTimerComplete: cfg.get<boolean>('notifications.onResetTimerComplete', true),
        onTaskComplete: cfg.get<boolean>('notifications.onTaskComplete', true),
        onApiRefresh: cfg.get<boolean>('notifications.onApiRefresh', true),
      },
      taskCompletionIdleSeconds: Math.max(
        cfg.get<number>('taskCompletionIdleSeconds', DEFAULT_TASK_IDLE_SECONDS),
        MIN_TASK_IDLE_SECONDS
      ),
      claudeHomePath,
    };
  }

  dispose(): void {
    this.disposable.dispose();
    this._onConfigChanged.dispose();
  }
}
