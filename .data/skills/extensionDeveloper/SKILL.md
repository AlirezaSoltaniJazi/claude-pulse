---
name: extensionDeveloper
description: >-
  Chrome extension development skill for the claude-pulse project. Covers Manifest V3
  patterns, service worker lifecycle, content script injection, message passing architecture,
  chrome.* API usage, popup/options/side panel UI, chrome.storage patterns, CSP compliance,
  declarativeNetRequest, esbuild bundling, TypeScript strict-mode, testing with Vitest,
  and Chrome Web Store publishing. Activates for any manifest.json change, content script,
  service worker, popup/options page, message passing, chrome.* API usage, or extension
  security review.
compatibility: "Manifest V3, TypeScript 5.3+, Node.js 20+, esbuild, Vitest, Chrome 120+"
metadata:
  author: skillnir
  version: "1.0.0"
  sdlc-phase: development
allowed-tools: Read Edit Write Bash(npm:*) Bash(npx:*) Bash(node:*) Glob Grep Agent
---

<!-- SKILL.md target: ≤300 lines / <3,500 tokens. Tables, rules, checklists, links only. Code examples go in references/. -->

## Before You Start

**Read [LEARNED.md](LEARNED.md) first.** It contains corrections, preferences, and conventions accumulated from previous sessions. Apply every rule in that file — they override defaults in this skill.

**Announce skill usage.** Always say "Using: extensionDeveloper skill" at the very start of your response before doing any work.

## When to Use

1. Writing or modifying `manifest.json`, content scripts, service worker, or popup/options pages
2. Working with any `chrome.*` API (runtime, tabs, storage, scripting, action, sidePanel, contextMenus)
3. Implementing message passing (content↔background, popup↔background, external messaging)
4. Modifying build config for extension bundling (esbuild, webpack, vite, crxjs)
5. Reviewing extension security (CSP, permissions, web_accessible_resources, origin verification)
6. Writing or running tests that mock `chrome.*` APIs

## Do NOT Use

- **VS Code extension tasks** (activation, commands, status bar, webview) — use the jsDeveloper skill
- **General TypeScript/JavaScript** without Chrome extension context — use a general JS/TS skill
- **Backend API, web app UI, mobile code** — out of scope for this skill
- **Skill system meta-tasks** (LEARNED.md, INJECT.md, skill structure) — use the skill system meta-skill

## Architecture

```
extension/
├── manifest.json                 # V3 manifest — permissions, content_scripts, service_worker
├── src/
│   ├── background/
│   │   └── service-worker.ts     # Event-driven background logic, message routing
│   ├── content/
│   │   └── content-script.ts     # DOM injection, shadow DOM UI, page messaging
│   ├── popup/
│   │   ├── popup.html            # Action popup markup
│   │   └── popup.ts              # Popup logic, state display
│   ├── options/
│   │   ├── options.html          # Options page markup
│   │   └── options.ts            # Settings management
│   ├── sidepanel/
│   │   ├── sidepanel.html        # Side panel markup
│   │   └── sidepanel.ts          # Side panel logic
│   ├── types.ts                  # Shared type definitions, message schemas
│   └── shared/
│       ├── storage.ts            # Typed chrome.storage wrappers
│       └── messages.ts           # Typed message passing helpers
├── assets/                       # Icons, CSS, static resources
├── dist/                         # Built output
├── esbuild.js                    # Multi-entry build config
└── tsconfig.json                 # TypeScript strict config
```

**Message flow**: Content script ↔ Service worker ↔ Popup/Options/SidePanel. All messages use typed schemas. Service worker is the central hub — no direct content↔popup communication.

## Key Patterns

| Pattern | Approach | Key Rule |
|---|---|---|
| Manifest V3 | Declarative config, no remote code | No `eval`, no `new Function`, no remotely hosted scripts |
| Service worker lifecycle | Event-driven, stateless between wake-ups | Recover state from `chrome.storage.session` on every wake |
| Message passing | Typed schemas with discriminated unions | Always include `type` field; always call `sendResponse` or return `true` |
| Content script isolation | Shadow DOM for injected UI | Never pollute page globals; use `closed` shadow root |
| Storage | `chrome.storage.local` for persistent, `.session` for ephemeral | Always handle quota errors; batch writes with `set()` |
| Permissions | Least-privilege, prefer `activeTab` | Request optional_permissions at runtime; justify every permission |
| Error handling | Silent try/catch, return null | Never throw from message handlers — callers expect graceful failure |
| CSP | Strict policy, no inline scripts | Use separate `.js` files; no `unsafe-eval` or `unsafe-inline` |

## Code Style

| Rule | Convention |
|---|---|
| Classes | PascalCase: `MessageRouter`, `StorageManager` |
| Functions/variables | camelCase: `handleMessage`, `tabId` |
| Constants | SCREAMING_SNAKE_CASE: `STORAGE_KEY`, `MESSAGE_TYPES` |
| Message types | String literal union: `type MessageType = 'FETCH_DATA' \| 'UPDATE_UI'` |
| Imports | Named imports for project modules; `chrome.*` used globally |
| Module system | ES modules source → bundled per entry point via esbuild |
| Type annotations | Required on all function signatures and message schemas |
| `any` usage | Forbidden — use `unknown` + narrowing |
| Unused variables | Forbidden — prefix with `_` if intentionally unused |

See [references/code-style.md](references/code-style.md) for full examples.

## Common Recipes

1. **Add a new chrome API**: Declare permission in `manifest.json` → add types in `types.ts` → implement in service worker → expose via message passing → update tests
2. **Create a content script**: Add entry in `manifest.json` `content_scripts` → create script in `src/content/` → use shadow DOM for UI → add message handler → register in esbuild config
3. **Add context menu**: Call `chrome.contextMenus.create()` in service worker `onInstalled` → handle click in `onClicked` listener → send result via messaging
4. **Add storage-backed setting**: Define key constant → create typed getter/setter in `shared/storage.ts` → use in options page → listen for changes via `chrome.storage.onChanged`
5. **Add a popup action**: Create HTML + TS in `src/popup/` → register in `manifest.json` `action.default_popup` → communicate with service worker via `chrome.runtime.sendMessage`
6. **Write a test**: Create `*.test.ts` in `test/` → mock `chrome.*` APIs with `vi.fn()` → use Vitest assertions → run `npm test`

## Testing Standards

- **Framework**: Vitest with `--experimental-vm-modules`
- **Chrome API mocking**: Create `chrome` global mock object with `vi.fn()` for each API
- **Coverage focus**: Message handlers, storage logic, content script DOM manipulation
- **E2E**: Puppeteer/Playwright with `--load-extension` flag for integration tests
- **No inline snapshots**: Use explicit assertions for message schemas

See [references/test-patterns.md](references/test-patterns.md) for full testing examples.

## Performance Rules

- Bundle each entry point separately — service worker, content scripts, popup, options
- Use `chrome.scripting.executeScript()` for lazy content script injection (avoid matching all URLs)
- Minimize service worker wake-ups — batch alarms, debounce storage writes
- Use `chrome.storage.session` for ephemeral state — avoids disk I/O
- Content scripts: use `MutationObserver` over polling for DOM changes
- Limit `web_accessible_resources` to only files that content scripts need
- Mark all Chrome types as ambient — never bundle type definitions

## Security

- **Least-privilege permissions**: `activeTab` over `tabs`; `declarativeNetRequest` over `webRequest`
- **CSP**: No `unsafe-eval`, no `unsafe-inline`, no remote scripts
- **Origin verification**: Always check `sender.origin` and `sender.id` in `onMessageExternal`
- **No secrets in code**: Use `chrome.storage.local` with encryption wrapper for sensitive data
- **Content script isolation**: Never expose extension internals to page context
- **web_accessible_resources**: Restrict `matches` to specific origins, never `<all_urls>`

See [references/security-checklist.md](references/security-checklist.md) for full checklist.

## Anti-Patterns

| Anti-Pattern | Why It's Wrong |
|---|---|
| Using Manifest V2 patterns | V2 is deprecated — persistent background pages, `webRequest` blocking are gone |
| Storing state in service worker globals | Service worker terminates unpredictably — state is lost |
| Not returning `true` from async `onMessage` | Message channel closes before `sendResponse` is called |
| Using `eval()` or `new Function()` | Violates CSP, blocked in MV3, security risk |
| Requesting `<all_urls>` permission | Over-privileged; Chrome Web Store will reject or delay review |
| Injecting CSS/JS into page without shadow DOM | Causes style conflicts and global namespace pollution |
| Hardcoding extension ID | Use `chrome.runtime.id` — IDs change between dev and published |
| Putting code examples in SKILL.md | Budget is ≤300 lines — code goes in `references/` |
| Skipping `sendResponse` in message handlers | Sender hangs waiting; always respond even on error |

## Code Generation Rules

1. **Read before writing** — always read the target file and `types.ts` before modifying
2. **Manifest first** — any new API usage must be declared in `manifest.json` permissions
3. **Type all messages** — every message must have a typed schema in `types.ts`
4. **Return null on error** — message handlers and data fetchers catch all exceptions
5. **On correction** — acknowledge, restate as rule, apply immediately, write to [LEARNED.md](LEARNED.md) under `## Corrections`
6. **On ambiguity** — check [LEARNED.md](LEARNED.md) first, then project files, ask ONE question, write to [LEARNED.md](LEARNED.md) under `## Preferences`

## Adaptive Interaction Protocols

Corrections and preferences persist via [LEARNED.md](LEARNED.md).

| Mode | Detection Signal | Behavior |
|---|---|---|
| Diagnostic | "manifest.json error", "content script not injecting", "service worker died", "message not received" | Trace message flow; check manifest config; inspect service worker lifecycle; verify permissions |
| Efficient | "another content script like X", "add context menu", "new storage key" | Follow existing patterns, minimal explanation, write immediately |
| Teaching | "what does chrome.runtime do", "how does message passing work", "explain service worker lifecycle" | Walk through architecture, reference Chrome extension docs, show message flow diagram |
| Review | "audit permissions", "check CSP", "review security", "check manifest" | Read-only analysis, check patterns against rules, report findings |

**Self-Learning**: All learnings are **written** to LEARNED.md — not suggested, written:

- Corrections → `## Corrections` section
- Preferences → `## Preferences` section
- Discovered conventions → `## Discovered Conventions` section
- Format: `- YYYY-MM-DD: rule description`

## Sub-Agent Delegation

| Agent | Role | Spawn When | Tools |
|---|---|---|---|
| code-reviewer | Read-only Chrome extension code analysis | PR review, architecture compliance, pattern audit | Read Glob Grep |
| security-auditor | CSP and permissions audit | Security review, permission audit, CSP verification | Read Glob Grep |
| test-writer | Test generation following project Vitest patterns | "write tests for X", new content script, coverage gaps | Read Edit Write Glob Grep Bash |

See [agents/](agents/) for full definitions.

## References

| File | Description |
|---|---|
| [LEARNED.md](LEARNED.md) | **Auto-updated.** Corrections, preferences, conventions across sessions |
| [INJECT.md](INJECT.md) | Always-loaded quick reference (hallucination firewall) |
| [references/manifest-patterns.md](references/manifest-patterns.md) | Manifest V3 configuration patterns and examples |
| [references/message-passing-guide.md](references/message-passing-guide.md) | Typed message schemas, routing, port lifecycle examples |
| [references/service-worker-patterns.md](references/service-worker-patterns.md) | Persistence, lifecycle, state recovery patterns |
| [references/code-style.md](references/code-style.md) | TypeScript conventions, imports, formatting with full examples |
| [references/security-checklist.md](references/security-checklist.md) | Per-permission, per-CSP, per-content-script verification checklists |
| [references/common-issues.md](references/common-issues.md) | Troubleshooting common Chrome extension pitfalls |
| [references/test-patterns.md](references/test-patterns.md) | Vitest patterns for mocking chrome.* APIs |
| [references/ai-interaction-guide.md](references/ai-interaction-guide.md) | Anti-dependency strategies, correction protocols |
| [assets/manifest-template.json](assets/manifest-template.json) | Manifest V3 starter template |
| [scripts/validate-chrome-extension.sh](scripts/validate-chrome-extension.sh) | Manifest + structure convention checker |
