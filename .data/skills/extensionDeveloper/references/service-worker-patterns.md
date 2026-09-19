# Extension Host Lifecycle Patterns

A VS Code extension host is **not** a browser extension service worker. There is no
event-driven wake/idle/terminate cycle to design around: once `activate()` runs, the extension
host process stays alive for as long as the VS Code window is open. This file covers the real
lifecycle and background-task patterns used in `claude-pulse`.

## Lifecycle Overview

```text
VS Code window opens → onStartupFinished fires → activate(context) runs once
  → extension host stays alive for the life of the window →
  window closes / extension disabled or reloaded → deactivate() runs
```

There is no analogue to "the process terminates after ~30s idle and must recover state on next
wake" — `cachedData` and every module-level cache in this codebase simply stay in memory for as
long as the window is open. Don't add service-worker-style state recovery logic; it solves a
problem this runtime doesn't have.

## `activate()` — Real Wiring (`src/extension.ts`, abridged)

```typescript
export function activate(context: vscode.ExtensionContext): void {
  configManager = new ConfigManager();
  fileWatcher = new FileWatcher(config.claudeHomePath, config.pollingIntervalSeconds * 1000);
  fileWatcher.start();

  statusBar = new StatusBar();
  dashboardPanel = new DashboardPanel();
  sessionMonitor = new SessionMonitor();
  taskCompletionDetector = new TaskCompletionDetector(config.taskCompletionIdleSeconds);
  notificationManager = new NotificationManager(config, sessionMonitor, taskCompletionDetector);

  refreshData(false);
  refreshUsageData(true);
  startUsageRefreshInterval(config.usageRefreshIntervalSeconds);

  // Wire events (see references/message-passing-guide.md), register commands, then:
  context.subscriptions.push(
    configManager, fileWatcher, statusBar, dashboardPanel,
    sessionMonitor, taskCompletionDetector, notificationManager,
    { dispose: () => { if (usageRefreshInterval) clearInterval(usageRefreshInterval); } }
  );
}
```

**Rule**: every object that owns a timer, a filesystem watcher, or an `EventEmitter` must
either implement `vscode.Disposable` and be pushed to `context.subscriptions`, or be wrapped in
an inline `{ dispose: () => {...} }` object (as done above for the plain `setInterval` handle).

## Module-Level State, Not Per-Wake Recovery

`cachedData` in `extension.ts` is the single mutable object holding everything the UI renders
(`stats`, `sessions`, `usage`, `modelInfo`, ...). It is built up once at activation and merged
into on every refresh — there is no "cold start" to recover from on each timer tick, because the
process never actually stops between ticks.

```typescript
let cachedData: ClaudePulseData = {
  stats: null, sessions: [], activeSessions: [], mostRecentSession: null,
  weeklyUsage: null, todayActivity: null, usage: null, modelInfo: null,
};
```

## Background Work Uses Plain Timers, Not `chrome.alarms`

There is no alarms API and no reason for one — `setInterval`/`setTimeout` are simply left
running for the life of the extension host:

| Timer | Owner | Interval |
|---|---|---|
| Usage API refresh | `extension.ts` (`startUsageRefreshInterval`) | `claudePulse.usageRefreshIntervalSeconds` (min 60s) |
| Status bar re-render | `StatusBar` | `STATUS_BAR_TICK_MS` (1s) |
| Task-completion poll | `TaskCompletionDetector` | `TASK_DETECTOR_POLL_MS` (2s) |
| File watcher fallback poll | `FileWatcher` | `pollingIntervalSeconds` (stats) / `WATCH_POLL_INTERVAL_MS` (settings + transcript) |
| Session liveness check | `SessionMonitor` | `LIVENESS_CHECK_INTERVAL_MS` (10s) |

Every one of these is cleared in its owner's `dispose()`. None of them need to persist state to
survive a restart — if the window closes, the timers simply stop.

## Guarding Out-of-Order Async Writes

Because the process is long-lived and several async operations can be in flight at once, the
real hazard here is **race conditions between concurrent writers to `cachedData`**, not
"lost state on wake". `extension.ts` handles this with a monotonically increasing sequence
token for `modelInfo`, which two independent async paths can both resolve:

```typescript
let modelInfoSeq = 0;

async function refreshData(): Promise<void> {
  const modelToken = ++modelInfoSeq;
  const freshModelInfo = await readModelInfo(/* ... */); // may take a while (weekly scan runs alongside it)
  // A faster, later call to refreshModelInfo() may have already advanced modelInfoSeq —
  // if so, THIS result is stale and must be discarded rather than overwriting the newer one.
  const modelInfo = modelToken === modelInfoSeq ? freshModelInfo : cachedData.modelInfo;
}
```

This pattern — a sequence counter compared after an await — is the idiomatic way to guard
shared module state in this codebase; reach for it instead of a mutex/lock abstraction.

## `deactivate()`

```typescript
export function deactivate(): void {
  // Cleanup handled by disposables
}
```

Because every stateful object is already registered in `context.subscriptions`, VS Code disposes
them automatically on deactivation — `deactivate()` itself currently does nothing extra. Don't
add manual cleanup here for anything that's already a `Disposable` pushed in `activate()`.

## Key Rules

1. **No wake/sleep cycle** — the extension host runs continuously; don't design around
   ephemeral termination
2. **Every stateful class implements `vscode.Disposable`** and is pushed to
   `context.subscriptions` in `activate()`
3. **Plain timers, cleared in `dispose()`** — there is no alarms API and no minimum-interval
   restriction beyond what this project's own settings enforce (e.g. `MIN_USAGE_REFRESH_INTERVAL_SEC`)
4. **Guard concurrent async writers with a sequence token**, not a service-worker-style
   storage-backed state machine
5. **`deactivate()` is a no-op by design** here — real cleanup happens via disposables, not a
   dedicated shutdown handler
