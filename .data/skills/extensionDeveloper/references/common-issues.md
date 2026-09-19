# Common Issues in This VS Code Extension

## Activation

### Extension doesn't activate
**Cause**: `activationEvents` in `package.json` doesn't cover the scenario, or `activate()` throws before wiring finishes.
**Fix**: This project uses `"activationEvents": ["onStartupFinished"]` — it activates once VS Code's own startup work is done, not on a command or file type. Check the Extension Host output channel for an exception thrown synchronously inside `activate()`.

### Command not found / "command 'claudePulse.x' not found"
**Cause**: Command id mismatch between `package.json` `contributes.commands` and the string passed to `vscode.commands.registerCommand()` in `extension.ts`.
**Fix**: The two ids must match exactly, including the `claudePulse.` prefix.

## Status Bar

### Status bar stuck on "Loading..."
**Cause**: `StatusBar.update()` hasn't been called yet — its `render()` shows a placeholder until `this.config` is set.
**Fix**: Confirm `refreshData()`/`updateUI()` ran in `activate()` and that `configManager.getConfig()` didn't throw.

### Background color doesn't match the "five-tier" usage description
**Cause**: `vscode.ThemeColor` only exposes `statusBarItem.warningBackground` and `statusBarItem.errorBackground` — there is no native "amber" or "info" background tier.
**Fix**: This is expected. The five logical tiers (`USAGE_TIER_LOW/MEDIUM/HIGH/CRITICAL` in `constants.ts`) drive text/percentage display and the dashboard's colored bars; the status bar item itself only ever switches between undefined / warning / error background.

## Webview (Dashboard)

### Dashboard shows stale data after `Show Dashboard` again
**Cause**: `DashboardPanel.update()` only rewrites `panel.webview.html` when `isVisible` is true; if the panel was disposed, `show()` must be called again to recreate it.
**Fix**: Check `dashboardPanel.isVisible` before assuming an update landed.

### Clicking a dashboard button does nothing
**Cause**: The command string sent by the webview's inline script (`vscode.postMessage({ command: 'refreshData' })` in `webviewContent.ts`) doesn't match the string checked in `DashboardPanel`'s `onDidReceiveMessage` handler in `webviewPanel.ts`.
**Fix**: Keep the `command` string literal identical in both files — there is no shared constant for it today, so this is a manual sync point.

### Webview appears blank
**Cause**: `enableScripts` not set, or an unhandled exception inside `generateDashboardHtml()`'s string templating (e.g. an unescaped value producing invalid HTML).
**Fix**: `webviewPanel.ts` sets `enableScripts: true` and `retainContextWhenHidden: true` when creating the panel — verify both are still present. If a new dashboard field can contain arbitrary text (from a file or the API), make sure it's escaped before being interpolated into the HTML string.

## Configuration

### Setting change in the Settings UI has no effect
**Cause**: Most likely the setting exists in `package.json` but was never added to `ConfigManager.getConfig()` (or vice versa), or the extension holds a config snapshot it never refreshes.
**Fix**: `ConfigManager` listens once at the `claudePulse` namespace level (`e.affectsConfiguration('claudePulse')`) and re-emits the *entire* config object on any change under that namespace — so a missing effect is almost always a missing `cfg.get(...)` line, not a listener problem.

## File Watching / Model Detection

### Model/effort in the status bar doesn't update after `/model`
**Cause**: The transcript watch is re-targeted per session via `resolveTranscriptPath()`/`retargetTranscriptWatch()`; if the primary session changed (e.g. a different workspace window) the watch may still be pointed at the old transcript.
**Fix**: Confirm `pickPrimarySession()` in `extension.ts` resolves to the session you expect — it prefers a session whose `cwd` matches an open workspace folder, then falls back to the most recently started session.

### Model/effort silently stops updating after a while
**Cause**: `fileWatcher.ts`'s transcript watch is a plain `fs.watch`, which dies permanently if the file's underlying inode is replaced (a rewrite or compaction).
**Fix**: This is why `fileWatcher.ts` also polls (`WATCH_POLL_INTERVAL_MS`) as a fallback for both `settings.json` and the transcript — don't remove the polling half when "cleaning up" this file.

## Credentials & Usage API

### Status shows `no_credentials`
**Cause**: No OAuth token found — on macOS, `security find-generic-password -s "Claude Code-credentials"` failed; elsewhere, `~/.claude/.credentials.json` is missing or has no `claudeAiOauth.accessToken`.
**Fix**: Confirm the user is logged in via the Claude Code CLI. This extension never performs its own OAuth flow — it only reads credentials the CLI already wrote.

### Status shows `auth_error` (401)
**Cause**: The stored access token expired or was revoked.
**Fix**: `usageApi.ts` does not implement token refresh yet (see the `refreshToken` TODO comment in `OAuthCredentials`) — ask the user to re-authenticate via the Claude Code CLI, e.g. by reopening a terminal session.

### Status shows `rate_limited`
**Cause**: The Anthropic usage API returned 429.
**Fix**: `callUsageApi()` already retries with backoff honoring `Retry-After` (capped by `MAX_BACKOFF_MS`); the opportunistic refresh path additionally backs off for `USAGE_RATE_LIMIT_COOLOFF_MS` after a 429. Don't add another retry loop on top of this — extend the existing one if the behavior needs to change.

## Testing

### `import * as vscode from 'vscode'` fails or returns `undefined` members in a test
**Cause**: `vitest.config.ts` aliases the `vscode` module to `test/__mocks__/vscode.ts`; a `vscode.*` API used in source but not stubbed in that mock file resolves to `undefined`.
**Fix**: Add the missing API to `test/__mocks__/vscode.ts` (following the existing `vi.fn()` stub style) rather than reaching for an auto-mocking library.

## Build & Packaging

### `npm run package` fails or produces a stale `.vsix`
**Cause**: `package` runs `npm run build` (esbuild) then `vsce package --no-update-package-json` — a build error upstream surfaces here.
**Fix**: Run `npm run build` on its own first to isolate an esbuild/TypeScript error from a `vsce` packaging error.

### Full publishing/release process questions
**Fix**: Don't improvise a publish flow here — see `PUBLISHING.md` at the project root. Releases are cut entirely by the GitHub Actions release workflow; there is no local `vsce publish` step.
