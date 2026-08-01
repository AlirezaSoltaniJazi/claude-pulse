import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { MODEL_WATCH_DEBOUNCE_MS, WATCH_POLL_INTERVAL_MS } from '../constants';

type DebounceSlot = 'settingsDebounce' | 'transcriptDebounce';

export class FileWatcher implements vscode.Disposable {
  private readonly _onStatsChanged = new vscode.EventEmitter<void>();
  private readonly _onSessionsChanged = new vscode.EventEmitter<void>();
  private readonly _onModelSettingsChanged = new vscode.EventEmitter<void>();
  private readonly _onTranscriptChanged = new vscode.EventEmitter<void>();

  readonly onStatsChanged = this._onStatsChanged.event;
  readonly onSessionsChanged = this._onSessionsChanged.event;
  readonly onModelSettingsChanged = this._onModelSettingsChanged.event;
  readonly onTranscriptChanged = this._onTranscriptChanged.event;

  private sessionWatcher: fs.FSWatcher | null = null;
  private homeWatcher: fs.FSWatcher | null = null;
  private transcriptWatcher: fs.FSWatcher | null = null;

  private pollingInterval: ReturnType<typeof setInterval> | null = null;
  private watchPollInterval: ReturnType<typeof setInterval> | null = null;

  private settingsDebounce: ReturnType<typeof setTimeout> | null = null;
  private transcriptDebounce: ReturnType<typeof setTimeout> | null = null;

  private lastStatsModified: number = 0;
  private lastSettingsModified: number = 0;

  private transcriptPath: string | null = null;
  private lastTranscriptModified: number = 0;
  private lastTranscriptSize: number = -1;

  constructor(
    private claudeHomePath: string,
    private pollingIntervalMs: number = 30000,
    // Injectable so tests can drive the poll path deterministically instead of waiting on
    // FSEvents, whose delivery latency is not something a test should depend on.
    private watchPollIntervalMs: number = WATCH_POLL_INTERVAL_MS
  ) {}

  start(): void {
    this.watchSessions();
    this.watchClaudeHome();
    this.startPolling();
    this.startWatchPolling();
  }

  updatePollingInterval(ms: number): void {
    this.pollingIntervalMs = ms;
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.startPolling();
    }
  }

  /**
   * Re-points every watcher at a new `claudePulse.claudeHomePath`.
   *
   * Without this the sessions watch, the home-directory watch, the stats poll and the settings
   * poll all stay bound to the path captured at construction, so after the setting changes the
   * extension reads the new location but only ever reacts to events from the old one.
   *
   * No-op when the path is unchanged, so the caller can invoke it on every config change.
   */
  updateClaudeHomePath(claudeHomePath: string): void {
    if (claudeHomePath === this.claudeHomePath) return;
    this.claudeHomePath = claudeHomePath;

    this.sessionWatcher?.close();
    this.homeWatcher?.close();
    this.sessionWatcher = null;
    this.homeWatcher = null;

    for (const timer of [this.pollingInterval, this.watchPollInterval]) {
      if (timer) clearInterval(timer);
    }
    this.pollingInterval = null;
    this.watchPollInterval = null;

    // Baselines describe files under the OLD root, so keeping them would suppress the first
    // report from the new one. The transcript is re-targeted by the caller's next refresh.
    this.lastStatsModified = 0;
    this.lastSettingsModified = 0;
    this.clearDebounce('settingsDebounce');

    this.start();
  }

  /**
   * Points the transcript watcher at `transcriptPath`, or tears it down when null.
   *
   * Idempotent — re-arming on the same path is a no-op, so the caller can invoke this on
   * every refresh without churning watchers or leaking FSWatcher handles.
   */
  watchTranscript(transcriptPath: string | null): void {
    const alreadyArmed =
      transcriptPath === this.transcriptPath &&
      (transcriptPath === null || this.transcriptWatcher !== null);
    if (alreadyArmed) return;

    this.transcriptWatcher?.close();
    this.transcriptWatcher = null;
    // A pending fire belongs to the old path — it must not be attributed to the new one.
    this.clearDebounce('transcriptDebounce');

    this.transcriptPath = transcriptPath;
    // Adopt the file's current state as the baseline rather than resetting to "never seen".
    // Arming is not itself news, and the poll below would otherwise report every re-target as
    // a change. A file that is missing keeps the 0/-1 baseline, so its later appearance IS
    // reported — that is the brand-new-session case, and it is genuinely news.
    this.lastTranscriptModified = 0;
    this.lastTranscriptSize = -1;
    if (!transcriptPath) return;
    this.primeTranscript(transcriptPath);

    try {
      // Append-only files make a file-level watch the cheapest option, but never the only one:
      // a rewrite or compaction replaces the inode and kills this watcher silently, so the
      // poll in startWatchPolling() is what actually guarantees delivery.
      this.transcriptWatcher = fs.watch(transcriptPath, () => void this.checkTranscript());
    } catch (_e) {
      // Transcript not created yet — the poll picks it up, and the next refresh re-arms
    }
  }

  /** Synchronous on purpose: the baseline must be in place before the watch can fire. */
  private primeTranscript(transcriptPath: string): void {
    try {
      const stat = fs.statSync(transcriptPath);
      this.lastTranscriptModified = stat.mtimeMs;
      this.lastTranscriptSize = stat.size;
    } catch (_e) {
      // Missing transcript — leave the 0/-1 baseline so its creation is reported
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

  /**
   * Watches the ~/.claude DIRECTORY rather than settings.json itself. An editor or CLI that
   * rewrites the file atomically (write temp + rename) replaces the inode, which leaves a
   * file-level watch permanently attached to a file nobody writes to again.
   */
  private watchClaudeHome(): void {
    try {
      this.homeWatcher = fs.watch(this.claudeHomePath, (_eventType, filename) => {
        // macOS may deliver a null filename, and reports in-place rewrites as 'rename'.
        // Any event means "go re-stat"; the mtime guard decides whether anything happened.
        if (filename !== null && filename !== 'settings.json') return;
        void this.checkSettings();
      });
    } catch (_e) {
      // ~/.claude may not exist yet — the settings poll covers it once it appears
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

  /**
   * Dual strategy, matching the stats-cache rule: an FSWatch is never trusted on its own for a
   * file whose write style is an upstream implementation detail, and FSEvents can be dropped.
   *
   * Covers the transcript as well as settings.json. The transcript watch is file-level, so it
   * goes permanently dead if the inode is ever replaced — and unlike settings.json, nothing
   * else re-reads it on a timer, so a dead watch would freeze the model indefinitely. Both
   * checks are one `stat` guarded by mtime+size, so sharing a single tick costs nothing.
   */
  private startWatchPolling(): void {
    this.watchPollInterval = setInterval(() => {
      void this.checkSettings();
      void this.checkTranscript();
    }, this.watchPollIntervalMs);
  }

  /** The sole gate for the settings event — both the directory watch and the poll funnel here. */
  private async checkSettings(): Promise<void> {
    try {
      const stat = await fs.promises.stat(path.join(this.claudeHomePath, 'settings.json'));
      if (stat.mtimeMs <= this.lastSettingsModified) return;
      this.lastSettingsModified = stat.mtimeMs;
      this.schedule('settingsDebounce', this._onModelSettingsChanged);
    } catch (_e) {
      // Missing settings.json — nothing to report
    }
  }

  /**
   * mtime+size guard. This is not only noise filtering: it is the loop guard. The handler for
   * this event reads the transcript, and an atime bump would otherwise re-trigger the watcher
   * forever.
   */
  private async checkTranscript(): Promise<void> {
    const target = this.transcriptPath;
    if (!target) return;

    try {
      const stat = await fs.promises.stat(target);
      if (stat.mtimeMs === this.lastTranscriptModified && stat.size === this.lastTranscriptSize) {
        return;
      }
      this.lastTranscriptModified = stat.mtimeMs;
      this.lastTranscriptSize = stat.size;
      this.schedule('transcriptDebounce', this._onTranscriptChanged);
    } catch (_e) {
      // Transcript removed — leave the watcher; the next refresh re-targets it
    }
  }

  /** Independent timers per slot, so transcript chatter never delays a settings change. */
  private schedule(slot: DebounceSlot, emitter: vscode.EventEmitter<void>): void {
    this.clearDebounce(slot);
    this[slot] = setTimeout(() => {
      this[slot] = null;
      emitter.fire();
    }, MODEL_WATCH_DEBOUNCE_MS);
  }

  private clearDebounce(slot: DebounceSlot): void {
    const pending = this[slot];
    if (pending) clearTimeout(pending);
    this[slot] = null;
  }

  dispose(): void {
    this.sessionWatcher?.close();
    this.homeWatcher?.close();
    this.transcriptWatcher?.close();
    this.sessionWatcher = null;
    this.homeWatcher = null;
    this.transcriptWatcher = null;

    for (const timer of [this.pollingInterval, this.watchPollInterval]) {
      if (timer) clearInterval(timer);
    }
    this.pollingInterval = null;
    this.watchPollInterval = null;

    // Cleared BEFORE the emitters go, so a pending timer can never fire into a disposed one.
    this.clearDebounce('settingsDebounce');
    this.clearDebounce('transcriptDebounce');

    this._onStatsChanged.dispose();
    this._onSessionsChanged.dispose();
    this._onModelSettingsChanged.dispose();
    this._onTranscriptChanged.dispose();
  }
}
