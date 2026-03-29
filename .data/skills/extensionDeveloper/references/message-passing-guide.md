# Message Passing Guide

## Typed Message Schemas

Define all messages as discriminated unions in `types.ts`:

```typescript
// types.ts — Message type definitions

/** Content script → Service worker messages */
export type ContentMessage =
  | { type: 'FETCH_DATA'; payload: { url: string } }
  | { type: 'UPDATE_BADGE'; payload: { count: number } }
  | { type: 'LOG_EVENT'; payload: { event: string; metadata?: unknown } };

/** Service worker → Content script messages */
export type BackgroundMessage =
  | { type: 'DATA_READY'; payload: { data: unknown } }
  | { type: 'SETTINGS_CHANGED'; payload: { key: string; value: unknown } };

/** Popup → Service worker messages */
export type PopupMessage =
  | { type: 'GET_STATUS' }
  | { type: 'TOGGLE_FEATURE'; payload: { feature: string; enabled: boolean } };

/** Standard response wrapper */
export interface MessageResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
```

## One-Time Messages (sendMessage/onMessage)

### Sending from Content Script

```typescript
// content-script.ts
async function fetchData(url: string): Promise<MessageResponse> {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'FETCH_DATA',
      payload: { url },
    } satisfies ContentMessage);
    return response;
  } catch {
    return { success: false, error: 'Message send failed' };
  }
}
```

### Handling in Service Worker

```typescript
// service-worker.ts
chrome.runtime.onMessage.addListener(
  (message: ContentMessage | PopupMessage, sender, sendResponse) => {
    // CRITICAL: return true for async handlers
    handleMessage(message, sender).then(sendResponse);
    return true; // Keep message channel open for async response
  }
);

async function handleMessage(
  message: ContentMessage | PopupMessage,
  sender: chrome.runtime.MessageSender
): Promise<MessageResponse> {
  try {
    switch (message.type) {
      case 'FETCH_DATA':
        const data = await doFetch(message.payload.url);
        return { success: true, data };

      case 'GET_STATUS':
        const status = await getStatus();
        return { success: true, data: status };

      case 'TOGGLE_FEATURE':
        await toggleFeature(message.payload.feature, message.payload.enabled);
        return { success: true };

      default:
        return { success: false, error: `Unknown message type` };
    }
  } catch (error) {
    return { success: false, error: String(error) };
  }
}
```

### Sending to Specific Tab

```typescript
// service-worker.ts — Send to content script in a specific tab
async function notifyTab(tabId: number, message: BackgroundMessage): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // Tab may have been closed or content script not injected
  }
}
```

## Long-Lived Connections (Ports)

Use for ongoing communication (e.g., streaming data, live updates):

### Content Script Side

```typescript
// content-script.ts
function connectToBackground(): chrome.runtime.Port {
  const port = chrome.runtime.connect({ name: 'content-stream' });

  port.onMessage.addListener((message: BackgroundMessage) => {
    switch (message.type) {
      case 'DATA_READY':
        updateUI(message.payload.data);
        break;
      case 'SETTINGS_CHANGED':
        applySetting(message.payload.key, message.payload.value);
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    // Service worker terminated — reconnect after delay
    setTimeout(() => connectToBackground(), 1000);
  });

  return port;
}
```

### Service Worker Side

```typescript
// service-worker.ts
const activePorts = new Map<string, chrome.runtime.Port>();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'content-stream') {
    const portId = `${port.sender?.tab?.id}-${Date.now()}`;
    activePorts.set(portId, port);

    port.onMessage.addListener((message: ContentMessage) => {
      handlePortMessage(message, port);
    });

    port.onDisconnect.addListener(() => {
      activePorts.delete(portId);
    });
  }
});
```

## External Messaging

```typescript
// service-worker.ts — Handle messages from allowed web pages
chrome.runtime.onMessageExternal.addListener(
  (message, sender, sendResponse) => {
    // ALWAYS verify sender
    if (!sender.origin || !allowedOrigins.includes(sender.origin)) {
      sendResponse({ success: false, error: 'Unauthorized origin' });
      return;
    }

    handleExternalMessage(message, sender).then(sendResponse);
    return true;
  }
);

const allowedOrigins = ['https://your-webapp.com'];
```

## Key Rules

1. **Always return `true`** from `onMessage` listener when using async `sendResponse`
2. **Always wrap in try/catch** — never let message handlers throw
3. **Always verify sender** for `onMessageExternal` — check `sender.origin` and `sender.id`
4. **Use discriminated unions** — `type` field enables exhaustive switch/case
5. **Handle port disconnects** — service worker can terminate, ports will disconnect
6. **Don't store ports in service worker globals** — they're lost on termination; re-establish on connect
