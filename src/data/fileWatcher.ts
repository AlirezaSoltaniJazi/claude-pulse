import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { MODEL_WATCH_DEBOUNCE_MS, SETTINGS_POLL_INTERVAL_MS } from '../constants';

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
  private settingsPollInterval: ReturnType<typeof setInterval> | null = null;

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
    private settingsPollIntervalMs: number = SETTINGS_POLL_INTERVAL_MS
  ) {}

  start(): void {
    this.watchSessions();
    this.watchClaudeHome();
    this.startPolling();
    this.startSettingsPolling();
  }

  updatePollingInterval(ms: number): void {
    this.pollingIntervalMs = ms;
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.startPolling();
    }
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
    this.lastTranscriptModified = 0;
    this.lastTranscriptSize = -1;
    if (!transcriptPath) return;

    try {
      // A file-level watch is safe here and only here: transcripts are append-only and are
      // never rewritten via temp+rename, so the inode this watcher holds stays the live file.
      this.transcriptWatcher = fs.watch(transcriptPath, () => void this.checkTranscript());
    } catch (_e) {
      // Transcript not created yet — the next refresh re-arms it
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
   */
  private startSettingsPolling(): void {
    this.settingsPollInterval = setInterval(
      () => void this.checkSettings(),
      this.settingsPollIntervalMs
    );
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

    for (const timer of [this.pollingInterval, this.settingsPollInterval]) {
      if (timer) clearInterval(timer);
    }
    this.pollingInterval = null;
    this.settingsPollInterval = null;

    // Cleared BEFORE the emitters go, so a pending timer can never fire into a disposed one.
    this.clearDebounce('settingsDebounce');
    this.clearDebounce('transcriptDebounce');

    this._onStatsChanged.dispose();
    this._onSessionsChanged.dispose();
    this._onModelSettingsChanged.dispose();
    this._onTranscriptChanged.dispose();
  }
}
