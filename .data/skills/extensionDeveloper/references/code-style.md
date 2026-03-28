# Code Style Guide

## Naming Conventions

```typescript
// Classes — PascalCase
class StorageManager { }
class MessageRouter { }
class ContentInjector { }

// Functions and variables — camelCase
function handleMessage() { }
const activeTabId = 42;
let isEnabled = true;

// Constants — SCREAMING_SNAKE_CASE
const STORAGE_KEY = 'settings';
const CACHE_TTL_MS = 30_000;
const MAX_RETRY_COUNT = 3;
const MESSAGE_TYPES = {
  FETCH_DATA: 'FETCH_DATA',
  UPDATE_UI: 'UPDATE_UI',
} as const;

// Private fields — underscore prefix
class Manager {
  private _cache: Map<string, unknown> = new Map();
  private _listeners: Set<() => void> = new Set();
}

// Type aliases — PascalCase
type MessageType = 'FETCH_DATA' | 'UPDATE_UI';
interface StorageData { key: string; value: unknown; }

// Enum-like objects — PascalCase const
const Permission = {
  Storage: 'storage',
  ActiveTab: 'activeTab',
  Alarms: 'alarms',
} as const;
```

## Import Order

```typescript
// 1. Chrome types (ambient, no import needed)

// 2. Node built-ins (if applicable in build tooling)

// 3. Third-party packages
import { z } from 'zod';

// 4. Project shared modules
import type { ContentMessage, MessageResponse } from '../types';
import { getStorage, setStorage } from '../shared/storage';
import { sendTypedMessage } from '../shared/messages';

// 5. Local module imports
import { renderCard } from './components/card';
```

## Function Signatures

```typescript
// Always annotate parameters and return types
async function fetchData(url: string, options?: FetchOptions): Promise<MessageResponse<Data>> {
  // ...
}

// Arrow functions for callbacks
const handleClick = (event: MouseEvent): void => {
  // ...
};

// Avoid `any` — use `unknown` + narrowing
function parseMessage(raw: unknown): ContentMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  if (!('type' in raw)) return null;
  return raw as ContentMessage; // After validation
}
```

## Error Handling

```typescript
// Data fetchers — return null, never throw
async function readFromStorage(key: string): Promise<StorageData | null> {
  try {
    const result = await chrome.storage.local.get(key);
    return result[key] ?? null;
  } catch {
    return null;
  }
}

// Message handlers — return error response, never throw
async function handleMessage(message: ContentMessage): Promise<MessageResponse> {
  try {
    switch (message.type) {
      case 'FETCH_DATA':
        const data = await fetchData(message.payload.url);
        return { success: true, data };
      default:
        return { success: false, error: `Unknown message type` };
    }
  } catch (error) {
    return { success: false, error: String(error) };
  }
}
```

## Chrome Storage Typed Wrappers

```typescript
// shared/storage.ts — Typed storage access

interface StorageSchema {
  settings: { theme: 'light' | 'dark'; enabled: boolean };
  cache: { data: unknown; timestamp: number };
  version: string;
}

async function getStorage<K extends keyof StorageSchema>(
  key: K
): Promise<StorageSchema[K] | null> {
  try {
    const result = await chrome.storage.local.get(key);
    return (result[key] as StorageSchema[K]) ?? null;
  } catch {
    return null;
  }
}

async function setStorage<K extends keyof StorageSchema>(
  key: K,
  value: StorageSchema[K]
): Promise<boolean> {
  try {
    await chrome.storage.local.set({ [key]: value });
    return true;
  } catch {
    return false;
  }
}
```

## Content Script Shadow DOM Pattern

```typescript
// content-script.ts — Isolated UI injection

function injectUI(): void {
  const host = document.createElement('div');
  host.id = 'my-extension-root';
  const shadow = host.attachShadow({ mode: 'closed' });

  // Styles scoped to shadow DOM
  const style = document.createElement('style');
  style.textContent = `
    .container { position: fixed; bottom: 16px; right: 16px; z-index: 999999; }
    .panel { background: #fff; border-radius: 8px; padding: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.15); }
  `;

  const container = document.createElement('div');
  container.className = 'container';
  container.innerHTML = `<div class="panel">Extension UI</div>`;

  shadow.appendChild(style);
  shadow.appendChild(container);
  document.body.appendChild(host);
}
```

## File Organization

```
src/
├── background/
│   └── service-worker.ts      # Single entry — event registration + handlers
├── content/
│   ├── content-script.ts      # DOM interaction, shadow DOM UI
│   └── page-observer.ts       # MutationObserver patterns
├── popup/
│   ├── popup.html             # Minimal HTML shell
│   ├── popup.ts               # Popup logic
│   └── popup.css              # Popup styles
├── options/
│   ├── options.html
│   ├── options.ts
│   └── options.css
├── shared/
│   ├── storage.ts             # Typed chrome.storage wrappers
│   └── messages.ts            # Typed message helpers
└── types.ts                   # All shared type definitions
```
