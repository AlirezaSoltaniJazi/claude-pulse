# Security Checklist

This is a VS Code extension with no browser CSP/permissions model. The real attack surface is:
credential handling, the webview's generated HTML, the extension's own network calls, and
untrusted content on disk under `~/.claude/`.

## Credential Handling

- [ ] **Read-only, never persisted by the extension** — `getOAuthCredentials()` in `usageApi.ts` only *reads* the macOS Keychain (`security find-generic-password -s "Claude Code-credentials"`) or `~/.claude/.credentials.json` on other platforms; the extension must never write its own copy of a token to disk
- [ ] **No token in logs** — the `log()` helper in `usageApi.ts` writes to a `vscode.OutputChannel`; never log the raw `accessToken`/`refreshToken` value, only status codes and high-level messages
- [ ] **`exec()` arguments are trusted, not user input** — the keychain lookup interpolates `KEYCHAIN_SERVICE` (a hardcoded constant) and an account name (regex-extracted from the Keychain's own output, or `os.userInfo().username`) into a shell command string; if this is ever extended to take workspace- or network-derived input, switch to `execFile`/argument arrays rather than string interpolation
- [ ] **No token refresh implemented** — `OAuthCredentials.refreshToken` is read but unused (see the `TODO` in `usageApi.ts`); a 401 is surfaced to the user as `auth_error` rather than silently retried with a refreshed token — don't assume refresh happens automatically

## Webview Content (`src/ui/webviewContent.ts` / `webviewPanel.ts`)

- [ ] **`enableScripts: true` runs only first-party, string-templated JS** — no remote scripts, no CDN references
- [ ] **No `eval`/`new Function`** anywhere in the generated HTML or its inline `<script>`
- [ ] **Escape file- and network-derived strings** before interpolating them into `generateDashboardHtml()`'s HTML — session working directories, model ids, and API response fields all ultimately come from outside this extension's control
- [ ] **No Content-Security-Policy `<meta>` tag is set today** — `generateDashboardHtml()` does not include one. If tightening this, use `webview.cspSource` for `script-src`/`style-src` and re-verify the existing inline `<script>` still runs (it will need a nonce or `'unsafe-inline'` scoped narrowly, since the current script has no nonce)
- [ ] **`postMessage` command strings** — validate `message.command` against the known set (`'resetTimer' | 'refreshData'`) in `DashboardPanel`'s `onDidReceiveMessage` handler rather than trusting arbitrary shapes, even though the webview content is first-party today

## Network

- [ ] **HTTPS only** — `usageApi.ts` calls `api.anthropic.com` via Node's `https` module; never downgrade to `http`
- [ ] **Fixed hostname/path** — `USAGE_API_HOSTNAME`/`USAGE_API_PATH` are constants, never built from user or workspace input
- [ ] **Timeouts and bounded retries** — `API_TIMEOUT_MS`, `MAX_RETRIES`, `MAX_BACKOFF_MS` bound every call; don't add an unbounded retry loop
- [ ] **Respect `Retry-After`** on 429s, capped at `MAX_BACKOFF_MS` — don't hold a request (or the in-flight dedupe slot) open for a server-supplied delay of several minutes

## Untrusted Input on Disk (`~/.claude/`)

- [ ] **Every reader treats `~/.claude/` content as untrusted** — session files, `stats-cache.json`, JSONL transcripts, and `settings.json` are all written by the separate Claude Code CLI, not by this extension, and are parsed defensively (`try`/`catch` around every `JSON.parse`, malformed lines skipped rather than crashing the extension)
- [ ] **No path built from file content is used unsanitized** — `encodeProjectDirName()`/`resolveTranscriptPath()` only ever join a `path.join()`'d, extension-controlled directory with a `sessionId` already validated to look like a session id; don't start interpolating raw file content into filesystem paths
- [ ] **Malformed JSON degrades to "no data", not a thrown error** — keep this behavior for any new reader under `src/data/`

## Workspace Trust

- [ ] `package.json` does not currently declare `capabilities.untrustedWorkspaces` — VS Code applies its default (restricted-mode) behavior for this extension. If this extension is ever evaluated for explicit untrusted-workspace support, confirm every file/network operation still only touches `~/.claude/` and `api.anthropic.com`, never workspace-provided paths, since restricted mode does not automatically constrain plain Node `fs`/`https` calls made by extension code

## Build & Dependency Security

- [ ] **`npm run audit:security`** (`npm audit --omit=dev --audit-level=critical`) is run in CI (`pr-security-audit.yml`) and in the `pre-push` Husky hook — keep it passing
- [ ] **No source maps in the production build** — `esbuild.js` sets `sourcemap: !production`; `.vscodeignore` also excludes `**/*.map` from the packaged `.vsix` regardless
- [ ] **`node-notifier` stays a lazy `require()`**, not a static import, and stays listed in `esbuild.js`'s `external` array and `.vscodeignore`'s exceptions (`!node_modules/node-notifier/**`) — it's the only runtime dependency this extension ships
- [ ] **No telemetry** — the README's Privacy & Security section states no analytics/telemetry are collected; don't add any without updating that section and getting it reviewed as a deliberate change
