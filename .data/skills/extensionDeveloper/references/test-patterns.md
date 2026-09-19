# Test Patterns for This VS Code Extension

## `vscode` Module Mocking Setup

Unlike a typical Vitest project, `vscode` is **not** auto-mocked per test file — it's aliased
project-wide in `vitest.config.ts` to a hand-written mock:

```typescript
// vitest.config.ts (real config)
import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/ui/webviewContent.ts'],
    },
  },
  resolve: {
    alias: { vscode: path.resolve(__dirname, 'test/__mocks__/vscode.ts') },
  },
});
```

`test/__mocks__/vscode.ts` exports, among others:

```typescript
export const StatusBarAlignment = { Left: 1, Right: 2 };
export class ThemeColor { constructor(public id: string) {} }
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
export const ViewColumn = { One: 1, Two: 2, Three: 3 };
export class EventEmitter { /* minimal real EventEmitter with .event()/.fire()/.dispose() */ }
export class Disposable { constructor(private callOnDispose: () => void) {} dispose() { this.callOnDispose(); } }

export function setMockConfig(values: Record<string, unknown>): void;
export function clearMockConfig(): void;

export const workspace = { getConfiguration, onDidChangeConfiguration, onDidChangeWorkspaceFolders, workspaceFolders };
export const window = { createStatusBarItem, createOutputChannel, createWebviewPanel, showInformationMessage, showWarningMessage, showErrorMessage };
export const commands = { registerCommand };
export const Uri = { file, parse };
```

**If a source file starts using a `vscode.*` API not listed above, add it to this mock file
first** — following the existing `vi.fn()` stub style — rather than reaching for an
auto-mocking library or `vi.mock('vscode', ...)` inline in a test file.

## Testing Config (real pattern, `test/configManager.test.ts`)

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigManager } from '../src/config/configManager';
import { setMockConfig, clearMockConfig } from './__mocks__/vscode';

describe('ConfigManager', () => {
  let configManager: ConfigManager;

  beforeEach(() => {
    clearMockConfig();
    configManager = new ConfigManager();
  });

  afterEach(() => {
    configManager.dispose();
  });

  it('should return default config values when no custom values are set', () => {
    const config = configManager.getConfig();
    expect(config.sessionResetIntervalMinutes).toBe(300);
  });

  it('should respect notifications.onApiRefresh when disabled', () => {
    setMockConfig({ 'notifications.onApiRefresh': false });
    expect(configManager.getConfig().notifications.onApiRefresh).toBe(false);
  });
});
```

`setMockConfig`/`clearMockConfig` drive the settings the mocked `workspace.getConfiguration()`
returns — this is the standard way to test anything that reads `claudePulse.*` settings.

## Testing a Class That Renders UI (real pattern, `test/statusBar.test.ts`)

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StatusBar } from '../src/ui/statusBar';
import { ClaudePulseConfig } from '../src/config/configManager';
import { ModelInfo } from '../src/types';

const makeConfig = (overrides: Partial<ClaudePulseConfig['statusBar']> = {}): ClaudePulseConfig => ({
  statusBar: { showResetTimer: false, showTokenCount: false, showSessionCount: false, showModel: true, showEffort: true, ...overrides },
  sessionResetIntervalMinutes: 300, sessionTokenLimit: 8_000_000, pollingIntervalSeconds: 30,
  usageRefreshIntervalSeconds: 3600,
  notifications: { enabled: false, useSystemNotifications: false, onNewSession: true, onSessionEnd: true, onResetTimerComplete: true, onTaskComplete: true, onApiRefresh: true },
  taskCompletionIdleSeconds: 10, claudeHomePath: '/fake/.claude',
});

describe('StatusBar model and effort segment', () => {
  let statusBar: StatusBar;
  beforeEach(() => { statusBar = new StatusBar(); });
  afterEach(() => { statusBar.dispose(); });
  // ... update() with a real ClaudePulseConfig + ModelInfo, then assert on the mocked
  // StatusBarItem's .text (available via the mock returned by window.createStatusBarItem)
});
```

Build a full, realistic fixture object (as `makeConfig`/`makeModelInfo` do) rather than a
partial one cast with `as` — every field is read somewhere in `render()`.

## Testing Data Readers

Data readers (`readStats`, `readSessions`, `readModelInfo`, ...) take a filesystem path and are
plain async functions with no `vscode` dependency — test them by pointing at a temp directory
or by mocking `fs`/`fs.promises` directly with `vi.fn()`, not by touching the `vscode` mock at
all. Always include a "malformed/missing file → returns `null`/`[]`" case alongside the happy
path, matching the null-return convention in `references/code-style.md`.

## Testing Module-Level Caches

Every module-level cache (`usageApi.ts`'s `cache`, `modelReader.ts`'s three caches,
`jsonlScanner.ts`'s `scanCache`) is invisible to a test unless it's explicitly cleared:

```typescript
import { clearUsageCache } from '../src/data/usageApi';

beforeEach(() => {
  clearUsageCache(); // otherwise a previous test's cached response leaks into this one
});
```

## Coverage Notes

- Coverage provider is `v8`, scoped to `src/**/*.ts`
- `src/ui/webviewContent.ts` is **excluded from coverage** — it's templated HTML/CSS/JS, not logic worth asserting against line-by-line
- Current suite: 9 test files, 213 test cases (`configManager`, `dataAggregator`, `fileWatcher`, `formatting`, `modelReader`, `sessionReader`, `statsReader`, `statusBar`, `taskCompletionDetector`)
- Run: `npm test` (`node --experimental-vm-modules node_modules/.bin/vitest run`) or `npm run test:coverage`

## Key Testing Rules

1. **`vscode` is a project-wide alias, not a per-test mock** — extend `test/__mocks__/vscode.ts` when a new API is needed
2. **`clearMockConfig()`/`setMockConfig()` in `beforeEach`** for anything touching `ConfigManager`
3. **`clearXCache()` in `beforeEach`** for anything touching a module-level cache
4. **Dispose what you construct** — every test that builds a `Disposable` (`StatusBar`, `FileWatcher`, `ConfigManager`, ...) calls `.dispose()` in `afterEach`
5. **Build full fixtures**, not partial casts, for config/data objects passed into render or comparison logic
6. **Test the null/empty path** for every data reader alongside its happy path
