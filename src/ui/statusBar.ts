import * as vscode from 'vscode';
import { ClaudePulseConfig } from '../config/configManager';
import { DailyActivity, RateLimitInfo, SessionFile } from '../types';

export class StatusBar implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  private currentSession: SessionFile | null = null;
  private todayActivity: DailyActivity | null = null;
  private config: ClaudePulseConfig | null = null;
  private rateLimitInfo: RateLimitInfo | null = null;

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
    todayActivity: DailyActivity | null,
    rateLimitInfo: RateLimitInfo | null
  ): void {
    this.config = config;
    this.currentSession = activeSession;
    this.todayActivity = todayActivity;
    this.rateLimitInfo = rateLimitInfo;
    this.render();
  }

  resetTimer(): void {
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

    // Reset timer from real rate limit data
    if (this.config.statusBar.showResetTimer) {
      if (this.rateLimitInfo && this.rateLimitInfo.resetsAt > 0) {
        const resetsAtMs = this.rateLimitInfo.resetsAt * 1000;
        const remaining = resetsAtMs - Date.now();

        if (remaining > 0) {
          parts.push(this.formatDuration(remaining));
          const resetTime = new Date(resetsAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          tooltipParts.push(`Session resets at ${resetTime}`);
        } else {
          parts.push('Ready');
          tooltipParts.push('Session reset - Claude is ready');
        }

        if (this.rateLimitInfo.status === 'allowed_warning') {
          this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else if (this.rateLimitInfo.status === 'rejected') {
          this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        } else {
          this.statusBarItem.backgroundColor = undefined;
        }
      } else if (this.currentSession) {
        // Fallback: estimate from config
        const resetMs = this.config.sessionResetIntervalMinutes * 60 * 1000;
        const elapsed = Date.now() - this.currentSession.startedAt;
        const remaining = resetMs - elapsed;

        if (remaining > 0) {
          parts.push(`~${this.formatDuration(remaining)}`);
          tooltipParts.push(`Est. reset in ${this.formatDuration(remaining)}`);
        } else {
          parts.push('Ready');
          tooltipParts.push('Session likely reset');
        }

        this.statusBarItem.backgroundColor = undefined;
      } else {
        parts.push('No session');
        tooltipParts.push('No active Claude session');
        this.statusBarItem.backgroundColor = undefined;
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
    const totalSeconds = Math.floor(Math.abs(ms) / 1000);
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
