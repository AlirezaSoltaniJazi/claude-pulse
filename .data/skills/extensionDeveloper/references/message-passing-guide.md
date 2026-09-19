# Internal Event & Webview Messaging Guide

This project has no background/content-script split, so there is no cross-context message bus
in the Chrome-extension sense. Two real patterns carry information between parts of the
extension:

1. **Internal pub/sub** via `vscode.EventEmitter`, used between long-lived classes inside the
   extension host (e.g. `FileWatcher` telling `extension.ts` a file changed).
2. **Webview ↔ extension messaging** via `postMessage`, used between the dashboard's webview
   content (a sandboxed HTML document) and `DashboardPanel` in the extension host.

## Pattern 1 — `vscode.EventEmitter` Pub/Sub

Every long-lived class that needs to notify the rest of the extension exposes a private
`_onX` emitter and a public `onX` event, matching the naming convention in `references/code-style.md`:

```typescript
// config/configManager.ts (real shape)
export class ConfigManager implements vscode.Disposable {
  private readonly _onConfigChanged = new vscode.EventEmitter<ClaudePulseConfig>();
  readonly onConfigChanged = this._onConfigChanged.event;

  constructor() {
    this.disposable = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudePulse')) {
        this._onConfigChanged.fire(this.getConfig());
      }
    });
  }
}
```

`extension.ts`'s `activate()` subscribes to these events to drive its own refresh logic:

```typescript
fileWatcher.onStatsChanged(() => refreshData(false));
fileWatcher.onSessionsChanged(() => refreshData(false));
fileWatcher.onModelSettingsChanged(() => void refreshModelInfo());
taskCompletionDetector.onTaskCompleted(() => void refreshUsageOpportunistically());
configManager.onConfigChanged((newConfig) => { /* re-wire intervals, notify managers */ });
```

Real emitters in this codebase, for reference:

| Class | Event(s) |
|---|---|
| `ConfigManager` | `onConfigChanged` |
| `FileWatcher` | `onStatsChanged`, `onSessionsChanged`, `onModelSettingsChanged`, `onTranscriptChanged` |
| `SessionMonitor` | `onSessionStarted`, `onSessionEnded` |
| `TaskCompletionDetector` | `onTaskCompleted` |
| `DashboardPanel` | `onResetTimer`, `onRefreshData` |

**Rules**:
- Always dispose the emitter in the owning class's `dispose()` — never leave a fired-but-unheard listener hanging past disposal
- Fire the *result* of a computation (e.g. the new `ClaudePulseConfig`), not just a bare signal, when the listener would otherwise have to re-fetch it
- Don't reach across modules to call another class's private state directly — go through its public event or a public method

## Pattern 2 — Webview ↔ Extension `postMessage`

The dashboard webview is a sandboxed document; it cannot call extension code directly. It can
only post messages out, and the extension can only push a full HTML replacement in.

### Webview → Extension (real code, `webviewContent.ts`'s inline `<script>`)

```typescript
const vscode = acquireVsCodeApi();
// ... on a button click:
vscode.postMessage({ command: 'refreshData' });
```

### Extension side (real code, `webviewPanel.ts`)

```typescript
export class DashboardPanel implements vscode.Disposable {
  private readonly _onResetTimer = new vscode.EventEmitter<void>();
  readonly onResetTimer = this._onResetTimer.event;
  private readonly _onRefreshData = new vscode.EventEmitter<void>();
  readonly onRefreshData = this._onRefreshData.event;

  show(data: ClaudePulseData, resetIntervalMinutes: number): void {
    // ... panel created with { enableScripts: true, retainContextWhenHidden: true }
    this.panel!.webview.onDidReceiveMessage((message) => {
      if (message.command === 'resetTimer') this._onResetTimer.fire();
      else if (message.command === 'refreshData') this._onRefreshData.fire();
    });
    this.panel!.webview.html = generateDashboardHtml(data, resetIntervalMinutes);
  }
}
```

`extension.ts` then subscribes to `dashboardPanel.onResetTimer` / `onRefreshData` exactly like
any other internal emitter.

### Extension → Webview

There is **no fine-grained update channel today** — the extension never posts an incremental
update message into the webview. Instead, whenever `cachedData` changes and the panel is
visible, `extension.ts` calls `dashboardPanel.update(cachedData, ...)`, which regenerates the
entire HTML string via `generateDashboardHtml()` and reassigns `panel.webview.html`. Don't
assume a `postMessage` path exists from the extension to the webview unless you add one.

## Key Rules

1. **Command strings must match exactly** between the webview's inline script and the
   `onDidReceiveMessage` handler — there's no shared constant for them today, so this is a
   manual sync point (see `references/common-issues.md`)
2. **Escape before interpolating** — any value baked into `generateDashboardHtml()`'s HTML
   string that originates from a file or the network must be escaped; the webview has no CSP
   meta tag today restricting inline script execution beyond VS Code's own webview sandboxing
3. **Dispose emitters** — `DashboardPanel.dispose()` must dispose `_onResetTimer` and
   `_onRefreshData` alongside the panel itself
4. **Don't invent a Chrome-style message envelope** (`{ type, payload }` discriminated unions
   routed through a central hub) — this project's internal messaging is plain typed
   `EventEmitter` events, and its webview messaging is a small, ad hoc `{ command: string }`
   shape. Match the existing pattern rather than introducing a new abstraction.
