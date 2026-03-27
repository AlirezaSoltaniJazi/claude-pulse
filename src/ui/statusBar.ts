import * as vscode from 'vscode';
import { ClaudePulseConfig } from '../config/configManager';
import { ClaudeUsage, DailyActivity, SessionFile } from '../types';

export class StatusBar implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  private currentSession: SessionFile | null = null;
  private todayActivity: DailyActivity | null = null;
  private config: ClaudePulseConfig | null = null;
  private usage: ClaudeUsage | null = null;

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
    usage: ClaudeUsage | null
  ): void {
    this.config = config;
    this.currentSession = activeSession;
    this.todayActivity = todayActivity;
    this.usage = usage;
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

    // Usage percentage — show max across all windows
    if (this.usage) {
      const windows = [
        { label: '5h', data: this.usage.five_hour },
        { label: '7d', data: this.usage.seven_day },
        { label: '7d Sonnet', data: this.usage.seven_day_sonnet },
        { label: '7d Opus', data: this.usage.seven_day_opus },
      ].filter((w): w is { label: string; data: NonNullable<typeof w.data> } => w.data !== null);

      if (windows.length > 0) {
        const maxWindow = windows.reduce((max, w) =>
          w.data.utilization > max.data.utilization ? w : max, windows[0]);
        const pct = Math.round(maxWindow.data.utilization);
        parts.push(`${pct}%`);

        // Show all windows in tooltip
        for (const w of windows) {
          tooltipParts.push(`${w.label}: ${Math.round(w.data.utilization)}%`);
        }

        // Color based on max utilization
        if (pct >= 90) {
          this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        } else if (pct >= 75) {
          this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else {
          this.statusBarItem.backgroundColor = undefined;
        }

        // Reset timer — use the most utilized window's reset time
        if (this.config.statusBar.showResetTimer && maxWindow.data.resets_at) {
          const resetsAtMs = new Date(maxWindow.data.resets_at).getTime();
          const remaining = resetsAtMs - Date.now();

          if (remaining > 0) {
            parts.push(this.formatDuration(remaining));
            const resetTime = new Date(resetsAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            tooltipParts.push(`Resets at ${resetTime}`);
          } else {
            parts.push('Ready');
            tooltipParts.push('Session reset');
          }
        }
      } else {
        this.statusBarItem.backgroundColor = undefined;
      }
    } else {
      this.statusBarItem.backgroundColor = undefined;

      // Fallback reset timer when no API data
      if (this.config.statusBar.showResetTimer) {
        if (this.currentSession) {
          const resetMs = this.config.sessionResetIntervalMinutes * 60 * 1000;
          const elapsed = Date.now() - this.currentSession.startedAt;
          const remaining = resetMs - elapsed;

          if (remaining > 0) {
            parts.push(`~${this.formatDuration(remaining)}`);
          } else {
            parts.push('Ready');
          }
        } else {
          parts.push('No session');
          tooltipParts.push('No active Claude session');
        }
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
