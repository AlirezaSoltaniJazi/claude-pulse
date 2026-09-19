---
name: extensionDeveloper
description: >-
  VS Code extension development skill for the claude-pulse project (Claude Pulse Monitor).
  Covers the activate/deactivate lifecycle, vscode.* APIs, status bar items, webview panels,
  package.json contribution points (commands, configuration, activationEvents), esbuild
  bundling of the extension host, TypeScript strict-mode, testing with Vitest, and VS Code
  Marketplace publishing. Activates for any package.json contribution change, activate()/
  deactivate() work, vscode.* API usage, status bar or webview work, a new data source under
  src/data/, or an extension security review.
compatibility: "VS Code ^1.85.0, TypeScript 6.0+, Node.js 20+, esbuild, Vitest, @vscode/vsce"
metadata:
  author: skillnir
  version: "2.0.0"
  sdlc-phase: development
allowed-tools: Read Edit Write Bash(npm:*) Bash(npx:*) Bash(node:*) Glob Grep Agent
---

<!-- SKILL.md target: ≤300 lines / <3,500 tokens. Tables, rules, checklists, links only. Code examples go in references/. -->

## Before You Start

**Read [LEARNED.md](LEARNED.md) first.** It contains corrections, preferences, and conventions accumulated from previous sessions. Apply every rule in that file — they override defaults in this skill.

**Announce skill usage.** Always say "Using: extensionDeveloper skill" at the very start of your response before doing any work.

## When to Use

1. Writing or modifying `package.json` contribution points (`contributes.commands`, `contributes.configuration`, `activationEvents`) or `activate()`/`deactivate()` in `src/extension.ts`
2. Working with any `vscode.*` API (`window`, `workspace`, `commands`, `StatusBarItem`, `WebviewPanel`, `ExtensionContext`, `EventEmitter`, `Disposable`)
3. Building or updating the status bar item (`src/ui/statusBar.ts`) or the dashboard webview (`src/ui/webviewPanel.ts`, `src/ui/webviewContent.ts`)
4. Adding or modifying a data source under `src/data/` (`usageApi.ts`, `modelReader.ts`, `sessionReader.ts`, `statsReader.ts`, `jsonlScanner.ts`, `taskCompletionDetector.ts`, `fileWatcher.ts`)
5. Modifying build config for the extension host bundle (`esbuild.js`) or VS Code Marketplace packaging (`npm run package`, `vsce`)
6. Reviewing extension security (credential handling, webview content, workspace trust, dependency audit)
7. Writing or running Vitest tests that mock the `vscode` module

## Do NOT Use

- **Chrome/browser extension tasks** (`manifest.json`, service workers, content scripts, `chrome.*` APIs) — claude-pulse is a VS Code extension and ships no browser extension code; there is nothing to defer here, this skill IS the extension-development skill for this project
- **General TypeScript/JavaScript** without VS Code extension context — use a general JS/TS skill
- **Backend API, standalone web app UI, mobile code** — out of scope for this skill
- **Skill system meta-tasks** (LEARNED.md, INJECT.md, skill structure) — use the skill system meta-skill

## Architecture

```text
claude-pulse/
├── package.json                   # Extension manifest — contributes.commands, .configuration, engines.vscode, activationEvents
├── src/
│   ├── extension.ts               # activate()/deactivate() — wires data sources, UI, notifications; owns cachedData
│   ├── types.ts                   # Shared interfaces: ClaudePulseData, StatsCache, SessionFile, ClaudeUsage, ModelInfo...
│   ├── constants.ts                # TTLs, thresholds, API endpoints, defaults — single source for magic numbers
│   ├── config/
│   │   └── configManager.ts       # ConfigManager — reads claudePulse.* settings, fires onConfigChanged
│   ├── data/
│   │   ├── statsReader.ts         # readStats(), readUsageFromCache() — ~/.claude/stats-cache.json
│   │   ├── sessionReader.ts       # readSessions(), isProcessAlive(), getActiveSessions(), findSessionForWorkspace()
│   │   ├── modelReader.ts         # readModelInfo() — active model/effort from transcript tail + settings.json
│   │   ├── usageApi.ts            # fetchUsage() — Anthropic OAuth usage API, keychain/file credentials, retry/backoff
│   │   ├── fileWatcher.ts         # FileWatcher — hybrid fs.watch + polling for stats/sessions/settings/transcript
│   │   ├── jsonlScanner.ts        # scanWeeklyUsage() — scans ~/.claude/projects/**/*.jsonl for weekly totals
│   │   ├── taskCompletionDetector.ts # TaskCompletionDetector — idle-after-end_turn task-complete signal
│   │   └── dataAggregator.ts      # getWeeklyUsage(), getTodayActivity(), getModelBreakdown()
│   ├── notifications/
│   │   ├── sessionMonitor.ts      # SessionMonitor — PID liveness → onSessionStarted/onSessionEnded
│   │   └── notificationManager.ts # NotificationManager — vscode.window.show*Message + optional node-notifier
│   ├── ui/
│   │   ├── statusBar.ts           # StatusBar — vscode.StatusBarItem, 1s tick render
│   │   ├── webviewPanel.ts        # DashboardPanel — WebviewPanel lifecycle + postMessage routing
│   │   └── webviewContent.ts      # generateDashboardHtml() — templated dashboard HTML/CSS/inline JS
│   └── utils/
│       ├── formatting.ts          # formatDuration, formatNumber, parseModelId, formatModelName...
│       └── dateUtils.ts           # getCurrentWeekBounds, formatDate
├── test/                          # Vitest — test/__mocks__/vscode.ts is a manual mock, aliased in vitest.config.ts
├── esbuild.js                     # Single entry (src/extension.ts) → dist/extension.js, CJS, external: vscode, node-notifier
├── tsconfig.json                  # strict TypeScript, target ES2022, module commonjs
└── PUBLISHING.md                  # Release/publish process — see this file, not this skill, for packaging steps
```

**Data flow**: File/API/timer events → `refreshData()` / `refreshUsageData()` in `extension.ts` → merged into module-level `cachedData` → `updateUI()` pushes to `StatusBar` and, if open, `DashboardPanel`. UI code never reads files or calls the network directly.

## Key Patterns

| Pattern | Approach | Key Rule |
|---|---|---|
| Activation | `onStartupFinished` event, single `activate(context)` | Register every disposable via `context.subscriptions.push(...)` |
| Commands | `vscode.commands.registerCommand(id, handler)` | Command id must match the id declared in `package.json` `contributes.commands` |
| Settings | `vscode.workspace.getConfiguration('claudePulse')` inside `ConfigManager` | Every setting must exist in BOTH `package.json` `contributes.configuration` AND `ConfigManager.getConfig()` |
| Status bar | Single `vscode.StatusBarItem`, re-rendered on a 1s tick and on data update | Mutate `.text`/`.tooltip`/`.backgroundColor` in place — never recreate the item |
| Webview | One `DashboardPanel` wrapping a `WebviewPanel`; HTML regenerated wholesale | `enableScripts: true` + `retainContextWhenHidden: true`; webview → extension via `acquireVsCodeApi().postMessage()` |
| Data readers | Return `null`/`[]` on any failure | Never throw from a data reader — `extension.ts` treats null as "no data yet" |
| Module caches | `let cache` at module scope, TTL constant, exported `clearXCache()` | Every new cache needs an explicit clear function so tests and the manual refresh command can invalidate it |
| Disposables | Every stateful class implements `vscode.Disposable` | Register the instance in `context.subscriptions`, not just a bare `dispose()` call |

## Code Style

| Rule | Convention |
|---|---|
| Classes | PascalCase: `ConfigManager`, `StatusBar`, `FileWatcher`, `DashboardPanel` |
| Functions/variables | camelCase, verb-first: `readStats`, `getActiveSessions`, `resolveModelSelection` |
| Interfaces | PascalCase, no `I` prefix: `ClaudePulseConfig`, `SessionFile`, `ModelInfo` |
| Constants | SCREAMING_SNAKE_CASE: `USAGE_CACHE_TTL_MS`, `KEYCHAIN_SERVICE` |
| Private EventEmitters | `_` prefix, public event re-exported: `_onConfigChanged` / `onConfigChanged` |
| Booleans | `is`/`has`/`should`/`use` prefix: `isProcessAlive`, `useSystemNotifications` |
| Imports | `import * as vscode/fs/path` for built-ins/vscode; named imports for project modules |
| Type annotations | Required on all function signatures; `strict: true` in `tsconfig.json` |
| `any` usage | Warn-level (`@typescript-eslint/no-explicit-any`) — prefer `unknown` + narrowing |
| Unused variables | Warn-level — prefix with `_` if intentionally unused |

See [references/code-style.md](references/code-style.md) for full examples.

## Common Recipes

1. **Add a new setting**: declare it in `package.json` `contributes.configuration.properties` → add the field to `ClaudePulseConfig` in `types.ts` → read it in `configManager.ts` with the identical default → consume it where needed → update the settings table in `README.md`
2. **Add a new data source**: create a reader in `src/data/` returning `null`/`[]` on failure → add types in `types.ts` → call it from `refreshData()` in `extension.ts` → fold the result into `cachedData` → surface it in `statusBar.ts` and/or `webviewContent.ts`
3. **Add a command**: register it in `package.json` `contributes.commands` → call `vscode.commands.registerCommand()` in `activate()` → push the result to `context.subscriptions`
4. **Add a status bar segment**: extend `StatusBar`'s render logic, respecting existing segment order → gate it behind a `claudePulse.statusBar.show*` setting if it should be optional
5. **Add a dashboard section**: extend `generateDashboardHtml()` in `webviewContent.ts` → keep all styles/scripts inline (no external files) → escape any file- or workspace-derived string before interpolating it into HTML
6. **Add a module-level cache**: `let cache: X | null = null` plus a TTL constant in `constants.ts` plus an exported `clearXCache()` → call the clear function from the relevant refresh path and from test `beforeEach`
7. **Write a test**: create `test/<name>.test.ts` → the `vscode` module resolves to `test/__mocks__/vscode.ts` via the Vitest alias, no manual `vi.mock` needed → reset mock state in `beforeEach` → run `npm test`

## Testing Standards

- **Framework**: Vitest, `environment: 'node'`, `globals: true` (see `vitest.config.ts`)
- **`vscode` mocking**: NOT auto-mocked — the module is aliased to the hand-written `test/__mocks__/vscode.ts`, which exports `setMockConfig`/`clearMockConfig`, a minimal `EventEmitter`, `StatusBarAlignment`, `ThemeColor`, `ConfigurationTarget`, `ViewColumn`, and `vi.fn()` stubs for `workspace`/`window`/`commands`
- **Coverage**: v8 provider over `src/**/*.ts`, excludes `src/ui/webviewContent.ts` (generated HTML, not asserted against)
- **Test files** (9 files, 213 test cases as of this audit): `configManager.test.ts`, `dataAggregator.test.ts`, `fileWatcher.test.ts`, `formatting.test.ts`, `modelReader.test.ts`, `sessionReader.test.ts`, `statsReader.test.ts`, `statusBar.test.ts`, `taskCompletionDetector.test.ts`
- **Run**: `npm test` (`node --experimental-vm-modules node_modules/.bin/vitest run`) or `npm run test:coverage`

See [references/test-patterns.md](references/test-patterns.md) for full testing examples.

## Performance Rules

- Data readers are plain async functions, not classes — keep them cheap enough to run on every `refreshData()` tick
- `modelReader.ts`'s transcript read is incremental (append-only tail scan) specifically to avoid re-reading multi-megabyte transcripts on every poll — don't "simplify" it into a full re-read
- `fileWatcher.ts` uses `fs.watch` AND a polling fallback for the same paths — an atomic rewrite (write-temp + rename) silently kills a bare `fs.watch` on some platforms; don't drop the polling half
- Debounce rapid file events (`MODEL_WATCH_DEBOUNCE_MS`) before firing a refresh — transcripts append many times per turn
- `usageApi.ts` deduplicates concurrent callers onto one in-flight request — never let two callers race independent HTTP calls
- Status bar re-render is O(1) string building on a 1s tick — don't move file or network I/O into `StatusBar`'s render path
- Webview HTML is regenerated wholesale on every update (`generateDashboardHtml()`) — keep it cheap; don't wire it to fire on every keystroke

## Security

- **Credentials are read-only**: the OAuth token comes from the macOS Keychain (`security find-generic-password`) or `~/.claude/.credentials.json` on other platforms — the extension never writes or caches credentials to disk itself
- **No `eval`/`new Function`/dynamic `require` of untrusted content** anywhere, including the webview's inline script
- **HTTPS only**: all Anthropic API calls use Node's `https` module against a fixed hostname (`api.anthropic.com`) — never build the request target from user/workspace input
- **Webview content**: `enableScripts: true` runs only first-party, string-templated JS from `generateDashboardHtml()`; nothing from the workspace or network is injected into that HTML unescaped — verify any new dashboard field is escaped
- **Treat `~/.claude/` file contents as untrusted input from disk** (session files, transcripts, `settings.json`) — every reader already parses defensively (try/catch around `JSON.parse`, skip malformed lines) and must keep doing so
- **No telemetry**: don't add analytics/tracking without updating the README's Privacy & Security section, which currently promises none
- **Dependency hygiene**: `npm run audit:security` (`npm audit --omit=dev --audit-level=critical`) runs in CI and pre-push — keep it clean

See [references/security-checklist.md](references/security-checklist.md) for the full checklist.

## Anti-Patterns

| Anti-Pattern | Why It's Wrong |
|---|---|
| Using `chrome.*` APIs, `manifest.json`, or service worker patterns | This is a VS Code extension — there is no browser runtime here; use `vscode.*` APIs and `package.json` contribution points |
| Adding a setting to only `package.json` or only `configManager.ts` | The two must stay in sync — a setting missing from either silently falls back to the wrong default |
| Throwing from a data reader in `src/data/` | Callers expect `null`/`[]` on failure, not an exception — `extension.ts` doesn't wrap every call in try/catch |
| Reading files or calling the network from `src/ui/` | UI code (`statusBar.ts`, `webviewContent.ts`) only renders `cachedData` — all I/O lives in `src/data/` |
| Replacing `fileWatcher.ts`'s dual fs.watch+poll strategy with fs.watch only | Atomic rewrites (write-temp + rename) can leave a bare `fs.watch` permanently dead |
| Converting the dynamic `require('node-notifier')` to a static import | It's loaded lazily so the dependency is only needed when system notifications are enabled |
| Forgetting `context.subscriptions.push(...)` for a new Disposable | The resource leaks for the life of the VS Code window instead of being cleaned up on deactivation |
| Putting code examples in SKILL.md | Budget is ≤300 lines — code goes in `references/` |
| Adding a module-level cache without an exported `clearXCache()` | Tests and the manual refresh command can't invalidate it |

## Code Generation Rules

1. **Read before writing** — always read the target file and `types.ts` before modifying
2. **Config first** — any new setting must be added to `package.json` `contributes.configuration` AND `configManager.ts` in the same change
3. **Type all shared data** — every cross-module value flows through an interface in `types.ts`
4. **Return null/empty on error** — data readers and file/network fetchers catch all exceptions
5. **On correction** — acknowledge, restate as rule, apply immediately, write to [LEARNED.md](LEARNED.md) under `## Corrections`
6. **On ambiguity** — check [LEARNED.md](LEARNED.md) first, then `types.ts`/`constants.ts`, ask ONE question, write to [LEARNED.md](LEARNED.md) under `## Preferences`

## Adaptive Interaction Protocols

Corrections and preferences persist via [LEARNED.md](LEARNED.md).

| Mode | Detection Signal | Behavior |
|---|---|---|
| Diagnostic | "extension not activating", "status bar not updating", "webview blank", "setting not applying" | Trace `activate()` wiring, `context.subscriptions`, `configManager` ↔ `package.json` sync, and the `cachedData` flow |
| Efficient | "add a setting like X", "add a data reader", "new status bar segment" | Follow existing patterns, minimal explanation, write immediately |
| Teaching | "how does the webview talk to the extension", "explain the file watcher", "how is the model resolved" | Walk through the relevant module, reference `agents.md`/`INJECT.md` at the project root, show the actual data flow |
| Review | "audit credential handling", "check the webview for injection", "review security" | Read-only analysis, check against `references/security-checklist.md`, report findings |

**Self-Learning**: All learnings are **written** to LEARNED.md — not suggested, written:

- Corrections → `## Corrections` section
- Preferences → `## Preferences` section
- Discovered conventions → `## Discovered Conventions` section
- Format: `- YYYY-MM-DD: rule description`

## Sub-Agent Delegation

| Agent | Role | Spawn When | Tools |
|---|---|---|---|
| code-reviewer | Read-only VS Code extension code analysis | PR review, architecture compliance, pattern audit | Read Glob Grep |
| security-auditor | Credential handling, webview, and dependency audit | Security review, credential-handling audit, pre-release check | Read Glob Grep |
| test-writer | Test generation following project Vitest patterns | "write tests for X", new data reader, coverage gaps | Read Edit Write Glob Grep Bash |

See [agents/](agents/) for full definitions.

## References

| File | Description |
|---|---|
| [LEARNED.md](LEARNED.md) | **Auto-updated.** Corrections, preferences, conventions across sessions |
| [INJECT.md](INJECT.md) | Always-loaded quick reference (hallucination firewall) |
| [references/manifest-patterns.md](references/manifest-patterns.md) | `package.json` contribution points (commands, configuration, activation) — VS Code's equivalent of a manifest |
| [references/message-passing-guide.md](references/message-passing-guide.md) | Internal `vscode.EventEmitter` pub/sub and webview↔extension `postMessage` patterns |
| [references/service-worker-patterns.md](references/service-worker-patterns.md) | Extension host lifecycle: `activate()`/`deactivate()`, the Disposable pattern, interval-based background refresh |
| [references/code-style.md](references/code-style.md) | TypeScript conventions, imports, formatting with full examples |
| [references/security-checklist.md](references/security-checklist.md) | Credential-handling, webview, workspace-trust, and dependency checklists |
| [references/common-issues.md](references/common-issues.md) | Troubleshooting common pitfalls in this codebase |
| [references/test-patterns.md](references/test-patterns.md) | Vitest patterns for mocking the `vscode` module |
| [references/ai-interaction-guide.md](references/ai-interaction-guide.md) | Anti-dependency strategies, correction protocols |
| [assets/manifest-template.json](assets/manifest-template.json) | Starter template for a new `package.json` command + configuration entry |
| [scripts/validate-chrome-extension.sh](scripts/validate-chrome-extension.sh) | Structure/convention checker for this VS Code extension (legacy filename — see the header comment in the script) |
