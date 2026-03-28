# Common Chrome Extension Issues

## Service Worker

### "Service worker was destroyed before the message was handled"
**Cause**: Async message handler didn't return `true` from `onMessage`.
**Fix**: Always `return true` from `onMessage` listener when response is async.

### "Context invalidated" errors
**Cause**: Extension was updated or reloaded while content script was still running.
**Fix**: Wrap all `chrome.runtime.sendMessage` calls in try/catch. Detect invalidation:
```typescript
if (!chrome.runtime?.id) {
  // Extension context invalidated — stop all operations
  return;
}
```

### Service worker not waking for events
**Cause**: Event listeners registered inside async functions or after a `setTimeout`.
**Fix**: Register ALL event listeners synchronously at top level of service-worker.ts.

### State lost between service worker wake-ups
**Cause**: Using global variables for state.
**Fix**: Use `chrome.storage.session` to persist state across terminations.

## Content Scripts

### Content script not injecting
**Cause**: `matches` pattern doesn't match the URL, or `run_at` timing is wrong.
**Fix**: Check `manifest.json` matches pattern. Use `chrome.scripting.executeScript()` for dynamic injection.

### CSS conflicts with host page
**Cause**: Content script styles leak into page or page styles leak into injected UI.
**Fix**: Use shadow DOM (`attachShadow({ mode: 'closed' })`) for all injected UI.

### Content script can't access page JS variables
**Cause**: Content scripts run in `ISOLATED` world by default.
**Fix**: Use `world: "MAIN"` in manifest or `chrome.scripting.executeScript({ world: 'MAIN' })`. Communicate via `window.postMessage`.

## Message Passing

### sendMessage returns undefined
**Cause**: No listener registered, or listener didn't call `sendResponse`.
**Fix**: Ensure service worker has `onMessage` listener. Always call `sendResponse`, even for errors.

### "Could not establish connection. Receiving end does not exist."
**Cause**: Sending message to tab without content script, or extension context invalid.
**Fix**: Check content script is injected before sending. Use try/catch around `chrome.tabs.sendMessage`.

### Port disconnected immediately
**Cause**: Service worker terminated while port was open.
**Fix**: Handle `port.onDisconnect` and implement reconnection logic with backoff.

## Storage

### chrome.storage.local.set silently fails
**Cause**: Exceeded 10MB quota.
**Fix**: Monitor usage with `chrome.storage.local.getBytesInUse()`. Clean old data.

### Storage changes not detected
**Cause**: Not listening to `chrome.storage.onChanged`.
**Fix**: Register listener and check `areaName` parameter:
```typescript
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.myKey) {
    // Handle change
  }
});
```

## Build & Packaging

### "Refused to execute inline script" in popup/options
**Cause**: Inline `<script>` tags violate CSP.
**Fix**: Move all JavaScript to external `.js` files. Reference with `<script src="popup.js"></script>`.

### "Refused to evaluate a string as JavaScript"
**Cause**: Using `eval()`, `new Function()`, or template literals with `innerHTML`.
**Fix**: Remove `eval` usage. Use DOM API (`createElement`, `textContent`) instead of `innerHTML`.

### Extension not loading in Chrome
**Cause**: Invalid `manifest.json` syntax or schema errors.
**Fix**: Validate manifest against Chrome's schema. Check `chrome://extensions` for error details.

## Chrome Web Store

### Rejection: "Excessive permissions"
**Fix**: Replace `tabs` with `activeTab`, remove unused permissions, use `optional_permissions`.

### Rejection: "Remotely hosted code"
**Fix**: Bundle all code locally. No CDN scripts, no `fetch` + `eval` patterns.

### Rejection: "Missing privacy policy"
**Fix**: Add privacy policy URL to Chrome Web Store listing. Required if collecting any user data.
