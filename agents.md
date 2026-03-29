# Claude Pulse — AI Agent Context

## What This Is

VS Code extension that monitors Claude Code usage, sessions, and token consumption from the status bar. Reads `~/.claude/` files and the Anthropic OAuth usage API to display real-time rate-limit windows, session reset countdowns, and token breakdowns — all without leaving the editor.

## Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript 5.3 (strict mode) |
| Platform | VS Code Extension API (^1.85.0) |
| Build | esbuild (CJS output for Node.js) |
| Tests | Vitest (node environment, globals enabled) |
| Lint | ESLint + @typescript-eslint + Prettier |
| Git hooks | Husky + lint-staged (pre-commit) |
| CI/CD | GitHub Actions (lint, test, build on Node 18 & 20) |
| Runtime dep | node-notifier (optional, system notifications) |

## Project Structure

```
src/
├── extension.ts              # Entry point — activate(), deactivate(), refresh loop
├── types.ts                  # All interfaces (ClaudePulseData, StatsCache, SessionFile, etc.)
├── constants.ts              # API endpoints, thresholds, TTLs, defaults
├── config/
│   └── configManager.ts      # Reads VS Code settings, emits change events
├── data/
│   ├── statsReader.ts        # Reads ~/.claude/stats-cache.json
│   ├── sessionReader.ts      # Reads ~/.claude/sessions/*.json, detects active PIDs
│   ├── usageApi.ts           # Anthropic OAuth API client (retry, cache, credentials)
│   ├── fileWatcher.ts        # Hybrid: FSWatch + polling for ~/.claude/ changes
│   ├── jsonlScanner.ts       # Scans JSONL session logs for weekly token counts
│   └── dataAggregator.ts     # Aggregates daily activity from StatsCache
├── notifications/
│   ├── sessionMonitor.ts     # PID liveness detection for session tracking
│   └── notificationManager.ts # VS Code + system notification delivery
├── ui/
│   ├── statusBar.ts          # Status bar item — tick-based rendering (1s interval)
│   ├── webviewPanel.ts       # Webview lifecycle and message routing
│   └── webviewContent.ts     # Dashboard HTML/CSS/JS generation (inline)
└── utils/
    ├── formatting.ts         # formatNumber, formatDuration
    └── dateUtils.ts          # getCurrentWeekBounds, formatDate
test/
├── __mocks__/vscode.ts       # Manual VS Code API mock
├── configManager.test.ts
├── dataAggregator.test.ts
├── formatting.test.ts
├── sessionReader.test.ts
└── statsReader.test.ts
```

## How To Run

```bash
# Install dependencies
npm install

# Dev mode (watch + Extension Host)
npm run watch          # then F5 in VS Code to launch Extension Host

# Production build
npm run build

# Tests (66 tests)
npm test
npm run test:coverage

# Lint & format
npm run lint
npm run format:check
```

## Development Conventions

### Code Style

- **Formatter**: Prettier — 100 char width, single quotes, trailing commas (es5), semicolons
- **Linter**: ESLint — `eqeqeq` (error), `no-throw-literal` (error), `no-explicit-any` (warn)
- **Type annotations**: Required on all function signatures. Strict mode enforced.
- **`any` usage**: Warn-level — use `unknown` + narrowing instead
- **Unused vars**: Warn-level — prefix with `_` if intentionally unused

### Naming Conventions

| Category | Convention | Examples |
|----------|-----------|---------|
| Functions/variables | camelCase, verb-first | `readStats()`, `getActiveSessions()` |
| Classes | PascalCase | `ConfigManager`, `StatusBar`, `FileWatcher` |
| Interfaces | PascalCase, no "I" prefix | `ClaudePulseConfig`, `SessionFile`, `StatsCache` |
| Constants | SCREAMING_SNAKE_CASE | `USAGE_CRITICAL_THRESHOLD`, `KEYCHAIN_SERVICE` |
| Private EventEmitters | `_` prefix | `_onConfigChanged`, `_onSessionStarted` |
| Booleans | `is`/`has`/`should`/`use` prefix | `isProcessAlive()`, `useSystemNotifications` |

### Import Order

```typescript
// 1. Node.js builtins (star import)
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// 2. Local modules (named imports)
import { ConfigManager } from './config/configManager';
import { readStats, readUsageFromCache } from './data/statsReader';

// 3. Types (same as named imports — no explicit type-only imports in src)
import { SessionFile, ClaudeUsage } from './types';
```

### Error Handling

Five patterns used consistently:

1. **Try-catch with null return** — data readers return `null` on failure, never throw
2. **Status result objects** — API layer returns `{ data, status, message }` union
3. **`console.warn`** — non-fatal logged warnings with `"Claude Pulse:"` prefix
4. **`vscode.window.show*Message`** — user-facing errors/warnings
5. **Silent catch** — file watching swallows errors for missing directories

## Architecture Rules

- **Event-driven data flow**: File changes → `refreshData()` → update `cachedData` → `updateUI()`. Never read files from UI code.
- **All state in `cachedData`**: Single mutable object in `extension.ts`. No global singletons in other modules.
- **Module-level caches with TTL**: `usageApi.ts` and `jsonlScanner.ts` cache results with explicit TTL constants and `clearCache()` exports.
- **Disposable pattern required**: Every class that holds resources must implement `vscode.Disposable` with a `dispose()` method.
- **Platform-aware credentials**: macOS uses Keychain (`/usr/bin/security`), others use `~/.claude/.credentials.json`. Always check `process.platform`.
- **Config defaults in two places**: `package.json` contributes.configuration AND `configManager.ts` fallback. Keep synchronized.
- **JSONL parsing is lenient**: Skip malformed lines, never throw. Accumulate valid results.

## Files To Know

| File | Purpose |
|------|---------|
| `src/extension.ts` | Orchestration: init, refresh loop, command registration |
| `src/types.ts` | All shared interfaces — read before modifying any data flow |
| `src/constants.ts` | All magic numbers, API endpoints, thresholds |
| `src/data/usageApi.ts` | Anthropic API integration — OAuth, retry, caching |
| `src/config/configManager.ts` | VS Code settings → typed config object |
| `src/ui/webviewContent.ts` | Dashboard HTML generation (largest file, inline JS/CSS) |
| `package.json` | Extension manifest: commands, settings schema, activation |
| `test/__mocks__/vscode.ts` | VS Code API mock — modify when testing new APIs |
| `esbuild.js` | Build config — single entry, CJS output, external: vscode |

## Files To Never Touch

- `dist/` — esbuild output, regenerated on build
- `package-lock.json` — auto-generated by npm
- `claude-pulse-*.vsix` — packaged extension binary
- `.idea/` — WebStorm IDE config (user-specific)
- `node_modules/` — npm dependencies

## Common Patterns

### Adding a new VS Code setting

1. Add schema to `package.json` under `contributes.configuration.properties`:
```json
"claudePulse.myNewSetting": {
  "type": "boolean",
  "default": false,
  "description": "Description here"
}
```

2. Add to `ClaudePulseConfig` interface in `src/types.ts`

3. Read in `src/config/configManager.ts`:
```typescript
myNewSetting: cfg.get<boolean>('myNewSetting', false),
```

### Adding a new data source

1. Create reader in `src/data/newReader.ts` — return `null` on failure
2. Add types to `src/types.ts`
3. Call from `refreshData()` in `src/extension.ts`
4. Store result in `cachedData`
5. Update UI in `statusBar.ts` and/or `webviewContent.ts`

### Writing a test

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { clearMockConfig } from './__mocks__/vscode';

describe('MyModule', () => {
  beforeEach(() => { clearMockConfig(); });
  afterEach(() => { /* dispose */ });

  it('should do the thing', () => {
    const result = myFunction(input);
    expect(result).toBe(expected);
  });
});
```

## External Services

| Service | Purpose | Local strategy |
|---------|---------|---------------|
| Anthropic Usage API (`api.anthropic.com/api/oauth/usage`) | Rate-limit windows, token usage | Falls back to estimated timer if unavailable |
| macOS Keychain | OAuth credential storage | File fallback at `~/.claude/.credentials.json` |
| `~/.claude/` filesystem | Sessions, stats cache, JSONL logs | Extension watches these files directly |

## Testing

- **Framework**: Vitest (globals enabled — no manual imports needed)
- **Mock**: Manual VS Code mock in `test/__mocks__/vscode.ts` (aliased via vitest.config.ts)
- **Coverage excluded**: `src/ui/webviewContent.ts` (HTML generation)
- **Run**: `npm test` (66 tests) or `npm run test:coverage`
- **Pattern**: Setup mock state → call function → assert result → dispose

## Known Gotchas

- **`package.json` and `configManager.ts` must stay in sync** — config defaults are duplicated in both places. Adding a setting to one without the other causes silent fallback to wrong defaults.
- **`types.ts` and readers must update together** — adding a field to an interface without updating the corresponding reader means the field is always `undefined`.
- **`constants.ts` thresholds affect multiple files** — `USAGE_CRITICAL_THRESHOLD` is used in both `statusBar.ts` and `webviewContent.ts` for color coding. Change once, verify both.
- **`webviewContent.ts` contains inline JS/CSS** — no external files. All dashboard logic is string-templated HTML. Easy to break with unescaped quotes.
- **FileWatcher uses dual strategy (FSWatch + polling)** — `stats-cache.json` is polled via mtime because FSWatch is unreliable for atomic rewrites on some platforms. Don't "simplify" to FSWatch-only.
- **Module-level caches are NOT class instances** — `usageApi.ts` and `jsonlScanner.ts` use `let cache` at module level. Always export and call `clearCache()` when testing.
- **`node-notifier` is dynamically required** — loaded via `require()` at runtime only when system notifications are enabled. Don't convert to static import.
- **Keychain parsing uses regex on command output** — `security find-generic-password` output is parsed with regex. Fragile if macOS changes output format.

## Freedom Levels

| MUST follow | SHOULD follow | CAN customize |
|-------------|---------------|---------------|
| TypeScript strict mode | Disposable pattern for new classes | Dashboard HTML/CSS layout |
| Naming conventions (table above) | Module-level cache + TTL pattern | Notification wording |
| Error handling (null return, no throws) | Event-driven data flow | Status bar text formatting |
| Prettier + ESLint rules | Test structure (describe/it/expect) | Polling intervals |
| `package.json` ↔ `configManager.ts` sync | JSONL lenient parsing | Webview chart styles |

## AI Interaction Guidelines

- **Interaction modes**: Teaching (VS Code API questions, architecture) · Efficient (add setting, add reader, add test) · Diagnostic (extension not activating, data not loading, credentials failing)
- **On correction**: Restate as rule, apply consistently, suggest persisting to LEARNED.md
- **On ambiguity**: Check `types.ts` and `constants.ts` first, ask ONE question, apply consistently
- **Adaptive**: Match proficiency to user — skip boilerplate explanations for repeated patterns

## Skills Reference

> Project-specific conventions live in `.data/skills/`. Check before making architectural decisions.
> Skills available: **extensionDeveloper** (Chrome/VS Code extension development patterns, code style, testing standards)

## Sub-Agent Capabilities

> The extensionDeveloper skill supports sub-agent delegation for complex workflows.
> Available agents: `code-reviewer` (read-only analysis), `security-auditor` (CSP/permissions audit), `test-writer` (Vitest test generation)
> Ensure `Agent` is in allowed-tools when using these skills.
