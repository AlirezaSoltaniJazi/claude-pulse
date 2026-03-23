import * as vscode from 'vscode';
import { ClaudePulseConfig } from '../config/configManager';
import { DailyActivity, SessionFile } from '../types';

export class StatusBar implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  private currentSession: SessionFile | null = null;
  private todayActivity: DailyActivity | null = null;
  private config: ClaudePulseConfig | null = null;
  private resetTimerAnchor: number | null = null;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusBarItem.command = 'claudePulse.showDashboard';
    this.statusBarItem.show();

    this.tickInterval = setInterval(() => this.render(), 1000);
  }

  update(
    config: ClaudePulseConfig,
    activeSession: SessionFile | null,
    todayActivity: DailyActivity | null
  ): void {
    this.config = config;
    this.currentSession = activeSession;
    this.todayActivity = todayActivity;

    if (activeSession && !this.resetTimerAnchor) {
      this.resetTimerAnchor = activeSession.startedAt;
    }

    this.render();
  }

  resetTimer(): void {
    this.resetTimerAnchor = Date.now();
    this.render();
  }

  private render(): void {
    if (!this.config) {
      this.statusBarItem.text = '$(pulse) Claude Pulse';
      this.statusBarItem.tooltip = 'Loading...';
      return;
    }

    const parts: string[] = ['$(pulse)'];
    const tooltipParts: string[] = [];

    // Reset timer / session status
    if (this.config.statusBar.showResetTimer) {
      if (this.currentSession && this.resetTimerAnchor) {
        const resetMs = this.config.sessionResetIntervalMinutes * 60 * 1000;
        const elapsed = Date.now() - this.resetTimerAnchor;
        const remaining = resetMs - elapsed;

        if (remaining > 0) {
          parts.push(this.formatDuration(remaining));
          tooltipParts.push(`Reset in ${this.formatDuration(remaining)}`);
        } else {
          parts.push('Ready');
          tooltipParts.push('Session reset - Claude is ready');
        }
      } else {
        parts.push('No session');
        tooltipParts.push('No active Claude session');
      }
    }

    // Token count
    if (this.config.statusBar.showTokenCount && this.todayActivity) {
      const tokens = this.todayActivity.messageCount;
      parts.push(`${this.formatNumber(tokens)} msgs`);
      tooltipParts.push(`Today: ${this.formatNumber(tokens)} messages`);
    }

    // Session count
    if (this.config.statusBar.showSessionCount && this.todayActivity) {
      parts.push(`${this.todayActivity.sessionCount}s`);
      tooltipParts.push(`Today: ${this.todayActivity.sessionCount} sessions`);
    }

    this.statusBarItem.text = parts.join(' ');
    this.statusBarItem.tooltip = tooltipParts.length > 0
      ? tooltipParts.join(' | ')
      : 'Click to open Claude Pulse dashboard';
  }

  private formatDuration(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
    }
    return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  }

  private formatNumber(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toString();
  }

  dispose(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    this.statusBarItem.dispose();
  }
}
