# Manifest V3 Patterns

## Minimal Manifest

```json
{
  "manifest_version": 3,
  "name": "Extension Name",
  "version": "1.0.0",
  "description": "Brief description",
  "permissions": ["storage", "activeTab"],
  "background": {
    "service_worker": "dist/service-worker.js",
    "type": "module"
  },
  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": {
      "16": "assets/icon-16.png",
      "48": "assets/icon-48.png",
      "128": "assets/icon-128.png"
    }
  },
  "icons": {
    "16": "assets/icon-16.png",
    "48": "assets/icon-48.png",
    "128": "assets/icon-128.png"
  }
}
```

## Content Scripts Declaration

```json
{
  "content_scripts": [
    {
      "matches": ["https://specific-domain.com/*"],
      "js": ["dist/content-script.js"],
      "css": ["assets/content-style.css"],
      "run_at": "document_idle",
      "world": "ISOLATED"
    }
  ]
}
```

### `run_at` Values

| Value | When | Use Case |
|---|---|---|
| `document_idle` | After DOM loaded, page idle | Default — safest, least intrusive |
| `document_end` | After DOM loaded, before subresources | Need early DOM access |
| `document_start` | Before DOM exists | Inject CSS, intercept requests |

### `world` Values

| Value | Behavior |
|---|---|
| `ISOLATED` (default) | Separate JS context, shared DOM access |
| `MAIN` | Shares page's JS context — can access page variables, but risks conflicts |

## Permissions Strategy

```json
{
  "permissions": ["storage", "activeTab", "alarms", "contextMenus"],
  "optional_permissions": ["notifications", "tabs"],
  "host_permissions": ["https://api.example.com/*"],
  "optional_host_permissions": ["https://*/*"]
}
```

### Permission Decision Matrix

| Need | Permission | Why |
|---|---|---|
| Read current tab URL/content | `activeTab` | Granted on user gesture only — least privilege |
| Access any tab URL | `tabs` | Over-privileged — use `activeTab` instead when possible |
| Persistent key-value storage | `storage` | Required for `chrome.storage.*` |
| Network request modification | `declarativeNetRequest` | Replaces `webRequest` blocking in MV3 |
| Background timers | `alarms` | Keep service worker alive, schedule tasks |
| Right-click menus | `contextMenus` | Adds items to browser context menu |
| Side panel | `sidePanel` | Enables `chrome.sidePanel` API |

## Web Accessible Resources (V3)

```json
{
  "web_accessible_resources": [
    {
      "resources": ["assets/injected-style.css", "assets/icon.png"],
      "matches": ["https://specific-domain.com/*"]
    }
  ]
}
```

**Rules**:
- Never use `<all_urls>` in `matches` — restrict to specific origins
- Only expose files that content scripts need to inject into pages
- Never expose service worker or popup scripts

## Content Security Policy

```json
{
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'",
    "sandbox": "sandbox allow-scripts; script-src 'self'"
  }
}
```

**MV3 CSP Rules**:
- Cannot relax `script-src` beyond `'self'`
- No `unsafe-eval`, no `unsafe-inline`
- No remote script sources
- `object-src 'self'` blocks plugin content

## Side Panel Configuration

```json
{
  "permissions": ["sidePanel"],
  "side_panel": {
    "default_path": "sidepanel/sidepanel.html"
  }
}
```

## Externally Connectable

```json
{
  "externally_connectable": {
    "matches": ["https://your-webapp.com/*"],
    "ids": ["other-extension-id"]
  }
}
```

**Security**: Always verify `sender.origin` and `sender.id` in `onMessageExternal` handlers.
