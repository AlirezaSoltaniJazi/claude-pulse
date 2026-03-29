import * as vscode from 'vscode';
import { ClaudePulseConfig } from '../config/configManager';
import { ClaudeUsage, DailyActivity, SessionFile } from '../types';
import { formatDuration, formatNumber } from '../utils/formatting';
import { USAGE_TIER_HIGH, USAGE_TIER_CRITICAL, STATUS_BAR_TICK_MS } from '../constants';

export class StatusBar implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  private currentSession: SessionFile | null = null;
  private todayActivity: DailyActivity | null = null;
  private config: ClaudePulseConfig | null = null;
  private usage: ClaudeUsage | null = null;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBarItem.command = 'claudePulse.showDashboard';
    this.statusBarItem.show();

    this.tickInterval = setInterval(() => this.render(), STATUS_BAR_TICK_MS);
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
        const maxWindow = windows.reduce(
          (max, w) => (w.data.utilization > max.data.utilization ? w : max),
          windows[0]
        );
        const pct = Math.round(maxWindow.data.utilization);
        parts.push(`${pct}%`);

        // Show all windows in tooltip
        for (const w of windows) {
          tooltipParts.push(`${w.label}: ${Math.round(w.data.utilization)}%`);
        }

        // Color based on max utilization (3-tier: VS Code only supports warning + error backgrounds)
        if (pct >= USAGE_TIER_CRITICAL) {
          this.statusBarItem.backgroundColor = new vscode.ThemeColor(
            'statusBarItem.errorBackground'
          );
        } else if (pct >= USAGE_TIER_HIGH) {
          this.statusBarItem.backgroundColor = new vscode.ThemeColor(
            'statusBarItem.warningBackground'
          );
        } else {
          this.statusBarItem.backgroundColor = undefined;
        }

        // Reset timer — always use 5-hour session window (most relevant to users)
        const fiveHour = this.usage.five_hour;
        if (this.config.statusBar.showResetTimer && fiveHour?.resets_at) {
          const resetsAtMs = new Date(fiveHour.resets_at).getTime();
          const remaining = resetsAtMs - Date.now();

          if (remaining > 0) {
            const resetDate = new Date(resetsAtMs);
            const hh = resetDate.getHours().toString().padStart(2, '0');
            const mm = resetDate.getMinutes().toString().padStart(2, '0');
            parts.push(`${formatDuration(remaining)} (${hh}:${mm})`);
            tooltipParts.push(`Resets at ${hh}:${mm}`);
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
            const resetDate = new Date(Date.now() + remaining);
            const hh = resetDate.getHours().toString().padStart(2, '0');
            const mm = resetDate.getMinutes().toString().padStart(2, '0');
            parts.push(`~${formatDuration(remaining)} (${hh}:${mm})`);
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
      parts.push(`${formatNumber(tokens)} msgs`);
      tooltipParts.push(`Today: ${formatNumber(tokens)} messages`);
    }

    // Session count
    if (this.config.statusBar.showSessionCount && this.todayActivity) {
      parts.push(`${this.todayActivity.sessionCount}s`);
      tooltipParts.push(`Today: ${this.todayActivity.sessionCount} sessions`);
    }

    this.statusBarItem.text = parts.join(' ');
    this.statusBarItem.tooltip =
      tooltipParts.length > 0 ? tooltipParts.join(' | ') : 'Click to open Claude Pulse dashboard';
  }

  dispose(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    this.statusBarItem.dispose();
  }
}
