# Package.json Contribution Patterns

VS Code extensions have no separate `manifest.json`. The extension manifest IS `package.json` —
`engines.vscode`, `activationEvents`, `main`, and the `contributes` block together declare
everything the Chrome-extension world would put in a manifest. This file documents the shape
`claude-pulse`'s real `package.json` uses; see the project root `package.json` for the full,
current file.

## Extension Identity & Activation (as declared in this project)

```json
{
  "name": "claude-pulse-monitor",
  "displayName": "Claude Pulse Monitor",
  "publisher": "AlirezaSoltaniJazi",
  "engines": { "vscode": "^1.85.0" },
  "categories": ["Other"],
  "activationEvents": ["onStartupFinished"],
  "main": "./dist/extension.js"
}
```

- `engines.vscode` pins the minimum VS Code (and therefore minimum Node/Electron) API surface — `esbuild.js` targets `node18` specifically because `^1.85.0` ships Electron 25 / Node 18
- `activationEvents: ["onStartupFinished"]` means the extension activates once VS Code's own startup work is done, not lazily on a command or file type. Other activation events exist in the VS Code API generally (`onCommand`, `onLanguage`, `workspaceContains`, etc.) but this project does not use them — don't add one without a reason
- `main` points at the esbuild output (`dist/extension.js`), not a `src/` file

## Commands Contribution

```json
{
  "contributes": {
    "commands": [
      { "command": "claudePulse.showDashboard", "title": "Claude Pulse: Show Dashboard" },
      { "command": "claudePulse.refreshData", "title": "Claude Pulse: Refresh Data" },
      { "command": "claudePulse.resetTimer", "title": "Claude Pulse: Reset Session Timer" },
      { "command": "claudePulse.toggleNotifications", "title": "Claude Pulse: Toggle Notifications" }
    ]
  }
}
```

**Rule**: every entry here must have a matching `vscode.commands.registerCommand('claudePulse.x', ...)` call in `src/extension.ts`, and vice versa. The `title` convention in this project is always `"Claude Pulse: <Action>"`.

## Configuration Contribution

```json
{
  "contributes": {
    "configuration": {
      "title": "Claude Pulse",
      "properties": {
        "claudePulse.pollingIntervalSeconds": {
          "type": "number",
          "default": 30,
          "minimum": 5,
          "description": "How often to refresh data from Claude files (seconds)"
        }
      }
    }
  }
}
```

**Rule**: every property here must be read in `src/config/configManager.ts`'s `getConfig()` with an identical default, and reflected in the `ClaudePulseConfig` interface in `src/types.ts`. This is the single most common place for the two halves of "the manifest" (`package.json`) and the code to drift apart — see `references/common-issues.md`.

## Extension Host Bundling (esbuild, not a browser bundler)

```js
// esbuild.js (actual config, abridged)
esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',              // pinned to the OLDEST VS Code this extension claims to support
  outfile: 'dist/extension.js',
  external: ['vscode', 'node-notifier'],
  sourcemap: !production,        // no source maps in the production build
});
```

- Single entry point (`src/extension.ts`) — there is no separate service-worker/content-script/popup bundle to configure, because none of those concepts exist for a VS Code extension
- `external: ['vscode']` is required — the `vscode` module is provided by the Extension Host at runtime, never bundled
- `external: ['node-notifier']` — kept external and `require()`'d dynamically at runtime (see `notificationManager.ts`) rather than bundled, so the dependency is only touched when system notifications are enabled

## Marketplace Publishing

Packaging (`npm run package` → `vsce package --no-update-package-json`) and the full release process (version bumps, CHANGELOG promotion, CI-only publishing via `vsce publish`) are documented in **`PUBLISHING.md`** at the project root — don't duplicate those steps here. This skill's job is the extension code itself, not the release pipeline.
