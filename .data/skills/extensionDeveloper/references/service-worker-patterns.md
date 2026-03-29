# Service Worker Patterns

## Lifecycle Overview

Chrome MV3 service workers are **ephemeral** — they start on events, run handlers, and terminate when idle (~30 seconds of inactivity).

```
Install → Activate → Idle → Terminate → (event) → Wake → Handle → Idle → Terminate → ...
```

## Event Registration (Must Be Synchronous)

All event listeners MUST be registered synchronously at the top level of the service worker. Chrome only dispatches events to listeners registered during the initial execution.

```typescript
// service-worker.ts — TOP LEVEL, synchronous registration

// CORRECT: registered at top level
chrome.runtime.onInstalled.addListener(handleInstalled);
chrome.runtime.onMessage.addListener(handleMessage);
chrome.alarms.onAlarm.addListener(handleAlarm);
chrome.action.onClicked.addListener(handleActionClick);
chrome.contextMenus.onClicked.addListener(handleContextMenu);

// WRONG: registered inside async function or setTimeout — events will be missed
// setTimeout(() => { chrome.runtime.onMessage.addListener(...) }); // DON'T DO THIS
```

## State Recovery Pattern

Never rely on in-memory state. Always recover from `chrome.storage.session`:

```typescript
// State management with session storage
interface ServiceWorkerState {
  lastFetchTime: number;
  activeTabId: number | null;
  featureFlags: Record<string, boolean>;
}

const DEFAULT_STATE: ServiceWorkerState = {
  lastFetchTime: 0,
  activeTabId: null,
  featureFlags: {},
};

async function getState(): Promise<ServiceWorkerState> {
  const result = await chrome.storage.session.get('swState');
  return result.swState ?? DEFAULT_STATE;
}

async function setState(updates: Partial<ServiceWorkerState>): Promise<void> {
  const current = await getState();
  await chrome.storage.session.set({
    swState: { ...current, ...updates },
  });
}

// Usage in handler
async function handleMessage(
  message: ContentMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: MessageResponse) => void
): Promise<void> {
  const state = await getState(); // Always recover state first
  // ... handle message using state
  await setState({ lastFetchTime: Date.now() }); // Persist updates
}
```

## Keep-Alive with Alarms

For periodic background tasks, use `chrome.alarms` (minimum interval: 1 minute in production, 30 seconds with dev flag):

```typescript
// service-worker.ts
chrome.runtime.onInstalled.addListener(() => {
  // Create periodic alarm
  chrome.alarms.create('periodic-sync', { periodInMinutes: 5 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  switch (alarm.name) {
    case 'periodic-sync':
      await performSync();
      break;
  }
});
```

## Offscreen Documents (Long-Running Tasks)

For tasks that exceed service worker lifetime (audio, DOM parsing, etc.):

```typescript
// service-worker.ts
async function ensureOffscreenDocument(): Promise<void> {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });

  if (existingContexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: [chrome.offscreen.Reason.DOM_PARSER],
      justification: 'Parse HTML content from fetched pages',
    });
  }
}
```

## onInstalled Handler

```typescript
chrome.runtime.onInstalled.addListener(async (details) => {
  switch (details.reason) {
    case 'install':
      // First install — set defaults, open onboarding
      await chrome.storage.local.set({ version: chrome.runtime.getManifest().version });
      await chrome.tabs.create({ url: 'onboarding/welcome.html' });
      break;

    case 'update':
      // Extension updated — run migrations
      const previousVersion = details.previousVersion;
      await runMigrations(previousVersion);
      break;
  }

  // Always re-create context menus on install/update
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: 'main-action',
    title: 'Extension Action',
    contexts: ['page', 'selection'],
  });
});
```

## Error Handling in Service Worker

```typescript
// Global error handler
self.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled rejection in service worker:', event.reason);
  // Log to chrome.storage for debugging
  chrome.storage.local.get('errorLog').then((result) => {
    const log = result.errorLog ?? [];
    log.push({
      timestamp: Date.now(),
      error: String(event.reason),
      stack: event.reason?.stack,
    });
    // Keep last 50 errors
    chrome.storage.local.set({ errorLog: log.slice(-50) });
  });
});
```

## Key Rules

1. **Register all listeners at top level** — synchronously, not inside async functions
2. **Never store state in globals** — use `chrome.storage.session` for ephemeral state
3. **Recover state on every wake** — assume all in-memory state is gone
4. **Use alarms for periodic tasks** — not `setInterval` (lost on termination)
5. **Use offscreen documents** for long-running tasks — service worker has ~5 minute max
6. **Re-create context menus in `onInstalled`** — they persist but need re-registration after updates
7. **Handle `unhandledrejection`** — uncaught promises can crash the service worker
