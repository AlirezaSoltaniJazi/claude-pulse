# Security Checklist

## Permissions Audit

For each permission in `manifest.json`, verify:

- [ ] **Justification documented** — can you explain why this permission is needed to Chrome Web Store reviewers?
- [ ] **Least privilege** — is there a less powerful alternative? (`activeTab` over `tabs`, `declarativeNetRequest` over `webRequest`)
- [ ] **Optional when possible** — non-critical permissions should be `optional_permissions` requested at runtime
- [ ] **No `<all_urls>`** — host permissions should be scoped to specific domains

### Permission Quick Reference

| Permission | Risk Level | Alternative |
|---|---|---|
| `tabs` | High — exposes all tab URLs | `activeTab` (user gesture only) |
| `webRequest` | High — sees all network traffic | `declarativeNetRequest` (declarative rules) |
| `<all_urls>` | Critical — full host access | Specific domain patterns |
| `history` | High — browsing history | Avoid unless core feature |
| `storage` | Low — extension-scoped storage | N/A — always safe |
| `activeTab` | Low — only on user gesture | N/A — preferred approach |
| `alarms` | Low — background timers | N/A — safe |
| `contextMenus` | Low — right-click menus | N/A — safe |

## Content Security Policy

- [ ] **No `unsafe-eval`** — blocked by MV3, but verify not in sandbox policy
- [ ] **No `unsafe-inline`** — all scripts in separate files
- [ ] **No remote scripts** — all code bundled locally
- [ ] **`object-src 'self'`** — block plugin content
- [ ] **Sandbox pages** (if used) have restricted CSP

## Content Script Security

- [ ] **Shadow DOM for injected UI** — `mode: 'closed'` to prevent page access
- [ ] **No global namespace pollution** — wrap in IIFE or use module bundling
- [ ] **Validate data from page** — never trust `window.postMessage` data without validation
- [ ] **Don't expose extension APIs to page** — content scripts in `ISOLATED` world (default)
- [ ] **MAIN world scripts** — only when absolutely necessary; audit for XSS risks

## Message Passing Security

- [ ] **Verify `sender.id`** in `onMessageExternal` — ensure message is from known extension
- [ ] **Verify `sender.origin`** in `onMessageExternal` — ensure message is from allowed website
- [ ] **Validate message shape** — don't trust message payloads; validate with type guards or zod
- [ ] **Don't pass sensitive data** in messages visible to content scripts — they share DOM with untrusted pages

## Web Accessible Resources

- [ ] **Restricted `matches`** — never use `<all_urls>`; scope to specific origins
- [ ] **Minimal exposure** — only files content scripts need (icons, CSS, fonts)
- [ ] **No sensitive files** — never expose service worker, popup scripts, or config files
- [ ] **Use `use_dynamic_url: true`** when possible — prevents URL-based fingerprinting

## Storage Security

- [ ] **No secrets in `chrome.storage.local`** — not encrypted; accessible via devtools
- [ ] **Sensitive tokens** — use platform keychain or encrypt before storing
- [ ] **Quota awareness** — `chrome.storage.local` has 10MB limit (5MB for `.sync`)
- [ ] **Clear sensitive data** on extension uninstall — use `chrome.runtime.onSuspend`

## Build Security

- [ ] **No source maps in production** — don't ship `.map` files to Chrome Web Store
- [ ] **Lock dependencies** — use `package-lock.json`, audit with `npm audit`
- [ ] **No `.env` files in extension bundle** — secrets go in chrome.storage, not source
- [ ] **Review third-party code** — bundled dependencies become part of your extension
