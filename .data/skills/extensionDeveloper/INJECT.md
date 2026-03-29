# INJECT.md — extensionDeveloper Quick Reference

<!-- Always-loaded hallucination firewall. Keep concise. -->

## Critical Rules

1. **Manifest V3 only** — no persistent background pages, no `webRequest` blocking, no remotely hosted code
2. **Service worker is ephemeral** — never store state in globals; use `chrome.storage.session` for recovery
3. **Typed messages** — every `sendMessage`/`onMessage` uses discriminated union types from `types.ts`
4. **Return `true` from async `onMessage`** — or message channel closes before `sendResponse` fires
5. **Least-privilege permissions** — `activeTab` over `tabs`; justify every permission for Chrome Web Store
6. **No `eval`/`new Function`** — CSP forbids it in MV3; no `unsafe-eval` in policy
7. **Shadow DOM for content script UI** — never inject styles/elements into page global scope
8. **Error handling** — catch all exceptions in handlers; return null, never throw
9. **esbuild bundling** — separate entry point per context (service worker, content script, popup)
10. **TypeScript strict mode** — no `any`, explicit return types, strict null checks

## Project Conventions (from claude-pulse)

- camelCase functions/variables, PascalCase classes, SCREAMING_SNAKE_CASE constants
- Silent error handling — return null on failure, never throw from data fetchers
- In-memory caches with explicit TTL constants and `clearCache()` methods
- ES modules source → CommonJS/ESM output via esbuild
- Vitest for testing (mock `chrome.*` with `vi.fn()`)
- ESLint with `@typescript-eslint` — warn on `any`, warn on unused vars (except `_` prefix)

## Do NOT Hallucinate

- `chrome.webRequest.onBeforeRequest` with `blocking` — **removed in MV3**, use `declarativeNetRequest`
- `chrome.browserAction` — **removed in MV3**, use `chrome.action`
- `chrome.extension.getBackgroundPage()` — **removed in MV3**, use message passing
- `chrome.tabs.executeScript()` — **removed in MV3**, use `chrome.scripting.executeScript()`
- Persistent background pages — **MV3 uses service workers only**
- `manifest_version: 2` — **deprecated, do not generate**
