import * as vscode from 'vscode';
import { ClaudePulseConfig } from '../config/configManager';
import { ClaudeUsage, DailyActivity, ModelInfo, PromptCacheInfo, SessionFile } from '../types';
import {
  formatDuration,
  formatDurationDays,
  formatDurationShort,
  formatEffortLevel,
  formatModelName,
  formatNumber,
} from '../utils/formatting';
import {
  limitShortLabel,
  pickDisplayLimit,
  pickMaxLimit,
  resolveLimits,
} from '../utils/usageLimits';
import {
  USAGE_TIER_HIGH,
  USAGE_TIER_CRITICAL,
  STATUS_BAR_TICK_MS,
  MODEL_EFFORT_SEPARATOR,
  STATUS_BAR_SEGMENT_SEPARATOR,
} from '../constants';

export class StatusBar implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  private currentSession: SessionFile | null = null;
  private todayActivity: DailyActivity | null = null;
  private config: ClaudePulseConfig | null = null;
  private usage: ClaudeUsage | null = null;
  private modelInfo: ModelInfo | null = null;
  private promptCache: PromptCacheInfo | null = null;

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
    usage: ClaudeUsage | null,
    modelInfo: ModelInfo | null,
    promptCache: PromptCacheInfo | null = null
  ): void {
    this.config = config;
    this.currentSession = activeSession;
    this.todayActivity = todayActivity;
    this.usage = usage;
    this.modelInfo = modelInfo;
    this.promptCache = promptCache;
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

    // Usage percentage — every window the API named, whatever it named them.
    const limits = resolveLimits(this.usage);
    const displayLimit = pickDisplayLimit(limits);
    const maxLimit = pickMaxLimit(limits);

    if (displayLimit && maxLimit) {
      const pct = Math.round(displayLimit.percent);
      const maxPct = Math.round(maxLimit.percent);
      parts.push(`${pct}%`);

      // Show all windows in tooltip — this is where a model-scoped limit ('7d Fable')
      // becomes visible without stealing the bar's single number slot.
      for (const l of limits) {
        tooltipParts.push(`${limitShortLabel(l)}: ${Math.round(l.percent)}%`);
      }

      // Color based on max utilization (3-tier: VS Code only supports warning + error backgrounds)
      if (maxPct >= USAGE_TIER_CRITICAL) {
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      } else if (maxPct >= USAGE_TIER_HIGH) {
        this.statusBarItem.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.warningBackground'
        );
      } else {
        this.statusBarItem.backgroundColor = undefined;
      }

      // Reset timer — matches the displayed window (session preferred, max fallback)
      if (this.config.statusBar.showResetTimer) {
        const resetsAt = displayLimit.resets_at;

        if (resetsAt) {
          const resetsAtMs = new Date(resetsAt).getTime();
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
      }
    } else {
      this.statusBarItem.backgroundColor = undefined;

      // No usable window — either no API data at all, or a response whose windows were all
      // null. Both mean the same thing to the user, so both get the estimated timer.
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

    // Model + effort level — one combined segment, rendered last so the color-coded
    // usage percentage keeps the leftmost slot and existing segments never shift.
    if (this.modelInfo) {
      const modelLabel = this.config.statusBar.showModel
        ? formatModelName(this.modelInfo.model)
        : '';
      const effortLabel = this.config.statusBar.showEffort
        ? formatEffortLevel(this.modelInfo.effort)
        : '';
      // '~' marks a non-authoritative value, matching the estimated-timer convention. It binds
      // to whatever it actually describes: an unconfirmed global /model selection taints only
      // the model, so the effort — which the transcript may well have proven — is left clean.
      // A dead session taints everything, because nothing shown is current.
      const optimisticModel = this.modelInfo.modelSource === 'settings' ? '~' : '';
      const segment = [modelLabel ? `${optimisticModel}${modelLabel}` : '', effortLabel]
        .filter((s) => s.length > 0)
        .join(MODEL_EFFORT_SEPARATOR);

      if (segment.length > 0) {
        const prefix = this.modelInfo.isSessionLive ? '' : '~';
        parts.push(`$(sparkle) ${prefix}${segment}`);

        // Tooltip carries the raw id — the bar shows the pretty label.
        if (modelLabel.length > 0 && this.modelInfo.model) {
          tooltipParts.push(
            this.modelInfo.modelSource === 'settings'
              ? `Model: ${this.modelInfo.model} (latest /model selection, unconfirmed)`
              : `Model: ${this.modelInfo.model}`
          );
        }
        if (effortLabel.length > 0 && this.modelInfo.effort) {
          tooltipParts.push(
            this.modelInfo.effortSource === 'settings'
              ? `Effort: ${this.modelInfo.effort} (global setting)`
              : `Effort: ${this.modelInfo.effort}`
          );
        }
      }
    }

    // Prompt cache warmth — always '~', because this is inferred from the last request rather
    // than reported. Rendered after the model so it never displaces an authoritative value,
    // and omitted entirely once cold: a countdown that has run out tells the user nothing.
    if (this.config.statusBar.showCacheWarmth && this.promptCache) {
      const remaining = this.promptCache.warmUntil - Date.now();
      if (remaining > 0) {
        parts.push(`$(flame) ~${formatDurationShort(remaining)}`);
        tooltipParts.push(
          `Prompt cache warm for about ${formatDurationShort(remaining)} ` +
            `(assumes a ${Math.round(this.promptCache.ttlMs / 60_000)}m TTL)`
        );
      }
    }

    // Model-scoped windows, rendered last. Generic on purpose: the segment is built from
    // whatever the API scoped the window to, so Fable appears today and the next scoped model
    // appears without a code change.
    //
    // Gated on the ROUNDED percentage rather than the raw one — a window at 0.4% would
    // otherwise render as 'Fable 0%', which reads as a bug rather than as barely-used.
    if (this.config.statusBar.showScopedUsage) {
      // The divider is pushed once, before the first scoped window, and only when something
      // precedes it — a bar that opens '$(pulse) | Fable 2%' has nothing to divide from.
      let dividerPushed = false;

      for (const limit of limits) {
        if (!limit.modelLabel) continue;

        const pct = Math.round(limit.percent);
        if (pct <= 0) continue;

        if (!dividerPushed && parts.length > 1) {
          parts.push(STATUS_BAR_SEGMENT_SEPARATOR);
          dividerPushed = true;
        }

        const remaining = limit.resets_at ? new Date(limit.resets_at).getTime() - Date.now() : 0;
        const resetLabel = remaining > 0 ? ` ${formatDurationDays(remaining)}` : '';
        parts.push(`${limit.modelLabel} ${pct}%${resetLabel}`);

        if (remaining > 0) {
          tooltipParts.push(
            `${limit.modelLabel}: ${pct}% — resets in ${formatDurationDays(remaining)}`
          );
        }
      }
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
