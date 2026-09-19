# INJECT.md — extensionDeveloper Quick Reference

<!-- Always-loaded hallucination firewall. Keep concise. -->

## Critical Rules

1. **This is a VS Code extension** — `vscode.*` APIs and `package.json` contribution points, not `chrome.*`/`manifest.json`/service workers
2. **Extension host is long-lived** — `activate(context)` runs once per window on `onStartupFinished`; there is no ephemeral wake/terminate cycle to design around
3. **Config lives in two places** — every setting must exist in BOTH `package.json` `contributes.configuration` AND `ConfigManager.getConfig()` with matching defaults
4. **Disposables go through `context.subscriptions`** — every class implementing `vscode.Disposable` must be pushed there in `activate()`
5. **Data readers never throw** — functions under `src/data/` return `null`/`[]` on failure; `extension.ts` treats that as "no data yet"
6. **Module-level caches need a clear function** — any `let cache` at module scope pairs with an exported `clearXCache()` (see `usageApi.ts`, `modelReader.ts`, `jsonlScanner.ts`)
7. **UI never does I/O** — `statusBar.ts` and `webviewContent.ts` only render `cachedData`; all file/network access lives in `src/data/`
8. **Webview ↔ extension messaging** — webview calls `acquireVsCodeApi().postMessage({ command: ... })`; `DashboardPanel` handles it via `panel.webview.onDidReceiveMessage`; the extension pushes updates by reassigning `panel.webview.html`, not by posting incremental patches
9. **esbuild bundling** — single entry `src/extension.ts` → `dist/extension.js`, CJS, `external: ['vscode', 'node-notifier']`
10. **TypeScript strict mode** — no `any` (warn-level lint), explicit function signatures, `strict: true` in `tsconfig.json`

## Project Conventions (from claude-pulse)

- camelCase functions/variables (verb-first), PascalCase classes/interfaces, SCREAMING_SNAKE_CASE constants
- Null/empty-return error handling in data readers — never throw; `usageApi.ts` instead returns a `{ data, status, message }` result object
- Module-level caches with explicit TTL constants (in `constants.ts`) and exported `clearCache()`-style functions
- `require('node-notifier')` is a deliberate dynamic import (lazy-loaded only when system notifications are enabled) — do not make it static
- Vitest for testing; `vscode` is aliased to `test/__mocks__/vscode.ts` (a manual mock, not auto-mocked)
- ESLint with `@typescript-eslint` — `eqeqeq` and `no-throw-literal` are errors; `no-explicit-any` and unused vars (except `_`-prefixed) are warnings

## Do NOT Hallucinate

- `manifest.json`, `chrome.*` APIs, service workers, content scripts, popup/options pages — **none of this exists in claude-pulse**; it is a VS Code extension
- A `jsDeveloper` skill, or any other skill covering VS Code extension work — **this skill covers it**; there is nothing to defer
- Chrome Web Store review/CSP/permissions concepts — the equivalent concerns here are the VS Code Marketplace (see `PUBLISHING.md`) and the checklist in `references/security-checklist.md`
- A `background/service-worker.ts` file, `popup/`, `options/`, or `sidepanel/` directories — the real UI surfaces are `src/ui/statusBar.ts` and `src/ui/webviewPanel.ts` + `webviewContent.ts`
- Fine-grained webview → extension incremental DOM patching over `postMessage` — the actual pattern re-renders the whole dashboard via `generateDashboardHtml()` on every update
