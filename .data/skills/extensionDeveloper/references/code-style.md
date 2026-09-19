# Code Style Guide

## Naming Conventions

```typescript
// Classes — PascalCase (real examples from src/)
class ConfigManager { }
class StatusBar { }
class FileWatcher { }
class DashboardPanel { }
class TaskCompletionDetector { }

// Functions and variables — camelCase, verb-first for functions
async function readStats(claudeHomePath: string) { }
function getActiveSessions(sessions: SessionFile[]) { }
let cachedData: ClaudePulseData;

// Constants — SCREAMING_SNAKE_CASE (from constants.ts)
export const USAGE_CACHE_TTL_MS = 30_000;
export const KEYCHAIN_SERVICE = 'Claude Code-credentials';
export const MODEL_INFO_CACHE_TTL_MS = 10_000;

// Interfaces — PascalCase, no "I" prefix
export interface ClaudePulseConfig { /* ... */ }
export interface SessionFile { pid: number; sessionId: string; cwd: string; startedAt: number; }
export interface ModelInfo { model: string | null; modelSource: ModelSource | null; /* ... */ }

// Private EventEmitters — underscore prefix, public event re-exported without it
export class ConfigManager implements vscode.Disposable {
  private readonly _onConfigChanged = new vscode.EventEmitter<ClaudePulseConfig>();
  readonly onConfigChanged = this._onConfigChanged.event;
  // ...
}

// Booleans — is/has/should/use prefix
function isProcessAlive(pid: number): boolean { /* ... */ }
// config field: notifications.useSystemNotifications
```

## Import Order

```typescript
// 1. Node.js built-ins and vscode — star import
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// 2. Local modules — named imports
import { ConfigManager } from './config/configManager';
import { readStats } from './data/statsReader';
import { readSessions, getActiveSessions, getMostRecentSession } from './data/sessionReader';

// 3. Types — same style as named imports, no separate `import type` convention in src/
import { ClaudePulseData, SessionFile } from './types';
import { MIN_USAGE_REFRESH_INTERVAL_SEC } from './constants';
```

## Function Signatures

```typescript
// Always annotate parameters and return types
export async function readModelInfo(
  claudeHomePath: string,
  session: SessionFile | null,
  isSessionLive: boolean
): Promise<ModelInfo | null> {
  // ...
}

// Avoid `any` — use `unknown` + narrowing, then a defensive cast after validation
const record = JSON.parse(line) as {
  type?: unknown;
  message?: { model?: unknown; content?: unknown };
};
if (typeof record.message?.model !== 'string') continue;
```

## Error Handling

Three patterns are used consistently across the codebase:

```typescript
// 1. Data readers — return null/[] on failure, NEVER throw
export async function readStats(claudeHomePath: string): Promise<StatsCache | null> {
  try {
    const content = await fs.promises.readFile(statsPath, 'utf-8');
    // ...
    return data as StatsCache;
  } catch {
    return null;
  }
}

// 2. Status-result objects — used where the caller needs to distinguish failure modes
export interface FetchUsageResult {
  data: ClaudeUsage | null;
  status: 'success' | 'cached' | 'rate_limited' | 'auth_error' | 'error' | 'no_credentials';
  message: string;
}

// 3. Logged warnings — non-fatal, prefixed so they're greppable in the Output panel
console.warn(
  `Claude Pulse: Failed to read model info: ${e instanceof Error ? e.message : String(e)}`
);
```

User-facing errors go through `vscode.window.showErrorMessage` / `showWarningMessage` / `showInformationMessage` — see `extension.ts`'s `showRefreshFeedback()`. File watching uses a fourth, silent-catch pattern for directories that may not exist yet (e.g. `~/.claude/sessions` before the first Claude Code session runs).

## Typed Configuration Access

```typescript
// config/configManager.ts — every setting read with an explicit default matching package.json
export class ConfigManager implements vscode.Disposable {
  private readonly _onConfigChanged = new vscode.EventEmitter<ClaudePulseConfig>();
  readonly onConfigChanged = this._onConfigChanged.event;
  private disposable: vscode.Disposable;

  constructor() {
    this.disposable = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudePulse')) {
        this._onConfigChanged.fire(this.getConfig());
      }
    });
  }

  getConfig(): ClaudePulseConfig {
    const cfg = vscode.workspace.getConfiguration('claudePulse');
    return {
      pollingIntervalSeconds: cfg.get<number>('pollingIntervalSeconds', DEFAULT_POLLING_INTERVAL_SEC),
      // ... one cfg.get<T>(key, default) per setting, default MUST match package.json
    };
  }

  dispose(): void {
    this.disposable.dispose();
    this._onConfigChanged.dispose();
  }
}
```

## Disposable Pattern

```typescript
// Every class that holds a timer, watcher, or EventEmitter implements vscode.Disposable
export class SessionMonitor implements vscode.Disposable {
  private readonly _onSessionStarted = new vscode.EventEmitter<SessionFile>();
  readonly onSessionStarted = this._onSessionStarted.event;
  private livenessInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.livenessInterval = setInterval(() => this.checkLiveness(), LIVENESS_CHECK_INTERVAL_MS);
  }

  dispose(): void {
    if (this.livenessInterval) {
      clearInterval(this.livenessInterval);
      this.livenessInterval = null;
    }
    this._onSessionStarted.dispose();
  }
}

// In extension.ts's activate(): every disposable instance is registered once
context.subscriptions.push(configManager, fileWatcher, statusBar, dashboardPanel, sessionMonitor, /* ... */);
```

## Module-Level Cache Pattern

```typescript
// data/usageApi.ts — module-scope cache + explicit invalidation, not a class instance
interface UsageCache { data: ClaudeUsage; timestamp: number; }
let cache: UsageCache | null = null;

export async function fetchUsage(forceRefresh = false): Promise<FetchUsageResult> {
  if (!forceRefresh && cache && Date.now() - cache.timestamp < USAGE_CACHE_TTL_MS) {
    return { data: cache.data, status: 'cached', message: 'Using cached data' };
  }
  // ... fetch, then `cache = { data, timestamp: Date.now() }`
}

export function clearUsageCache(): void {
  cache = null;
}
```

## File Organization

```text
src/
├── extension.ts                # activate()/deactivate(), refresh orchestration, cachedData
├── types.ts                    # All shared interfaces
├── constants.ts                # TTLs, thresholds, API endpoints, defaults
├── config/
│   └── configManager.ts        # ClaudePulseConfig — settings read + change events
├── data/
│   ├── statsReader.ts
│   ├── sessionReader.ts
│   ├── modelReader.ts
│   ├── usageApi.ts
│   ├── fileWatcher.ts
│   ├── jsonlScanner.ts
│   ├── taskCompletionDetector.ts
│   └── dataAggregator.ts
├── notifications/
│   ├── sessionMonitor.ts
│   └── notificationManager.ts
├── ui/
│   ├── statusBar.ts
│   ├── webviewPanel.ts
│   └── webviewContent.ts       # Largest file — inline HTML/CSS/JS, excluded from coverage
└── utils/
    ├── formatting.ts
    └── dateUtils.ts
```
