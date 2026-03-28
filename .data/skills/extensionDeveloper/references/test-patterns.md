# Test Patterns for Chrome Extensions

## Chrome API Mocking Setup

```typescript
// test/setup.ts — Global chrome mock
import { vi } from 'vitest';

const chromeMock = {
  runtime: {
    id: 'test-extension-id',
    sendMessage: vi.fn(),
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    onInstalled: { addListener: vi.fn() },
    onConnect: { addListener: vi.fn() },
    connect: vi.fn(),
    getManifest: vi.fn(() => ({ version: '1.0.0' })),
    getContexts: vi.fn(async () => []),
  },
  storage: {
    local: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      getBytesInUse: vi.fn(async () => 0),
    },
    session: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => undefined),
    },
    onChanged: { addListener: vi.fn() },
  },
  tabs: {
    query: vi.fn(async () => []),
    sendMessage: vi.fn(async () => undefined),
    create: vi.fn(async () => ({ id: 1 })),
    update: vi.fn(async () => ({})),
  },
  action: {
    setBadgeText: vi.fn(async () => undefined),
    setBadgeBackgroundColor: vi.fn(async () => undefined),
    onClicked: { addListener: vi.fn() },
  },
  alarms: {
    create: vi.fn(),
    get: vi.fn(async () => null),
    onAlarm: { addListener: vi.fn() },
  },
  contextMenus: {
    create: vi.fn(),
    removeAll: vi.fn(async () => undefined),
    onClicked: { addListener: vi.fn() },
  },
  scripting: {
    executeScript: vi.fn(async () => []),
  },
};

// Assign to global
Object.assign(globalThis, { chrome: chromeMock });

export { chromeMock };
```

## Vitest Configuration

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    environment: 'node',
    globals: true,
    mockReset: true,
  },
});
```

## Testing Message Handlers

```typescript
// test/message-handler.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chromeMock } from './setup';

// Import the handler function (not the listener registration)
import { handleMessage } from '../src/background/message-handler';

describe('handleMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handles FETCH_DATA message', async () => {
    const message = { type: 'FETCH_DATA', payload: { url: 'https://example.com' } };
    const sender = { tab: { id: 1 }, id: 'test-extension-id' };

    const response = await handleMessage(message, sender);

    expect(response.success).toBe(true);
    expect(response.data).toBeDefined();
  });

  it('returns error for unknown message type', async () => {
    const message = { type: 'UNKNOWN' };
    const sender = { tab: { id: 1 }, id: 'test-extension-id' };

    const response = await handleMessage(message, sender);

    expect(response.success).toBe(false);
    expect(response.error).toContain('Unknown');
  });

  it('handles errors gracefully', async () => {
    // Force an error
    chromeMock.storage.local.get.mockRejectedValueOnce(new Error('Storage error'));

    const message = { type: 'GET_STATUS' };
    const sender = { tab: { id: 1 }, id: 'test-extension-id' };

    const response = await handleMessage(message, sender);

    expect(response.success).toBe(false);
    expect(response.error).toBeDefined();
  });
});
```

## Testing Storage Wrappers

```typescript
// test/storage.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chromeMock } from './setup';
import { getStorage, setStorage } from '../src/shared/storage';

describe('Storage wrappers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when key not found', async () => {
    chromeMock.storage.local.get.mockResolvedValueOnce({});
    const result = await getStorage('settings');
    expect(result).toBeNull();
  });

  it('returns typed data when key exists', async () => {
    const mockSettings = { theme: 'dark', enabled: true };
    chromeMock.storage.local.get.mockResolvedValueOnce({ settings: mockSettings });

    const result = await getStorage('settings');
    expect(result).toEqual(mockSettings);
  });

  it('handles storage errors gracefully', async () => {
    chromeMock.storage.local.get.mockRejectedValueOnce(new Error('Quota exceeded'));
    const result = await getStorage('settings');
    expect(result).toBeNull();
  });

  it('sets storage value', async () => {
    const success = await setStorage('settings', { theme: 'dark', enabled: true });
    expect(success).toBe(true);
    expect(chromeMock.storage.local.set).toHaveBeenCalledWith({
      settings: { theme: 'dark', enabled: true },
    });
  });
});
```

## Testing Content Scripts (DOM)

```typescript
// test/content-script.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Use jsdom environment for content script tests
// vitest.config.ts: test.environmentMatchGlobs: [['test/content-*.test.ts', 'jsdom']]

import { injectUI, removeUI } from '../src/content/content-script';

describe('Content Script UI', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('injects shadow DOM element', () => {
    injectUI();
    const host = document.getElementById('my-extension-root');
    expect(host).not.toBeNull();
    expect(host?.shadowRoot).toBeNull(); // closed shadow root is not accessible
  });

  it('removes injected UI', () => {
    injectUI();
    removeUI();
    const host = document.getElementById('my-extension-root');
    expect(host).toBeNull();
  });
});
```

## E2E Testing with Puppeteer

```typescript
// test/e2e/extension.e2e.test.ts
import puppeteer, { Browser, Page } from 'puppeteer';
import path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const EXTENSION_PATH = path.resolve(__dirname, '../../dist');

describe('Extension E2E', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
      ],
    });
  });

  afterAll(async () => {
    await browser.close();
  });

  it('extension loads without errors', async () => {
    const targets = await browser.targets();
    const serviceWorker = targets.find(
      (t) => t.type() === 'service_worker'
    );
    expect(serviceWorker).toBeDefined();
  });
});
```

## Key Testing Rules

1. **Mock `chrome.*` globally** in setup file — every test gets clean mocks
2. **Reset mocks in `beforeEach`** — prevent state leakage between tests
3. **Test handlers, not listeners** — export handler functions separately from listener registration
4. **Use `mockResolvedValueOnce`** for async chrome APIs — one-time mock per test
5. **Test error paths** — verify graceful failure with `mockRejectedValueOnce`
6. **jsdom for content scripts** — use environment matching to switch test environment
