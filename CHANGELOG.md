# Changelog

All notable changes to the Claude Pulse extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Model and effort level in the status bar** — a new trailing segment shows the Claude model currently in use
  and its reasoning effort level, e.g. `$(sparkle) Opus 5 · xhigh`. Both values come from the last assistant
  record in the active session's transcript (`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`); the effort
  falls back to the global `effortLevel` in `~/.claude/settings.json` for models that predate the per-turn field,
  which the tooltip marks as `(global default)`. When the owning session's process is no longer alive the segment
  is prefixed with `~`, matching the existing estimated-timer convention.
  Controlled by two new settings, **both defaulting to `true`**, so the status bar gains this segment on upgrade:
  `claudePulse.statusBar.showModel` and `claudePulse.statusBar.showEffort`. Set either to `false` to hide that
  half; set both to `false` to restore the previous status bar exactly. Only the tail of the transcript is read,
  so the cost does not grow with session length.
- **Per-window session selection** — the status bar now describes the Claude session belonging to the window's
  own workspace folder, matching on `cwd` (exact match preferred, then the deepest containing folder, ties broken
  toward the most recently started session). Previously the first session found on disk was used, so anyone
  running Claude in several projects at once saw another project's state — visible as the wrong model, since the
  model is chosen per session. Windows with no folder open now fall back to the most recently started session
  rather than an arbitrary one. This also makes the reset timer describe the same session as the model.

### Security

- Regenerated `package-lock.json`, clearing 8 advisories (7 high, 1 moderate) in transitive dev dependencies:
  `brace-expansion`, `fast-uri`, `form-data`, `js-yaml`, `linkify-it`, `markdown-it` and `undici`
  (all via `@vscode/vsce`), plus `postcss` (via `vitest` → `vite`). `npm audit` and `npm audit --omit=dev`
  both report 0 vulnerabilities. No production dependency was ever affected.

### Fixed

- **Release packaging** — `vsce package` refused to run because `@types/vscode` (`^1.120.0`) exceeded
  `engines.vscode` (`^1.85.0`), which vsce treats as a hard error. Pinned `@types/vscode` to `~1.85.0` to match
  the declared engine. The extension's newest API use is `StatusBarItem.backgroundColor` (VS Code 1.53), so no
  functionality is lost and no user on an older VS Code is dropped.
- **Type checking** — `tsc --noEmit` failed with 56 `Cannot find name` errors for Node globals (`fs`, `process`,
  `setInterval`, …). TypeScript 6 defaults `moduleResolution` to `bundler`, which does not auto-include `@types`.
  Added `"types": ["node", "vscode"]` to `tsconfig.json`. Not caught by CI, which builds with esbuild only.
- **CI matrix** — the Node 18 leg could no longer install, since vitest 4 and eslint 10 require
  Node `^20.19 || ^22.13 || >=24`. Matrix moved to Node 20 and 22, and `fail-fast: false` added so legs report
  independently rather than being cancelled.

### Changed

- Bump `@types/node` from 25.9.3 to 26.1.2
- Bump `@typescript-eslint/eslint-plugin` from 8.61.0 to 8.65.0
- Bump `@typescript-eslint/parser` from 8.61.0 to 8.65.0
- Bump `@vitest/coverage-v8` from 4.1.8 to 4.1.10
- Bump `esbuild` from 0.28.0 to 0.28.1
- Bump `eslint` from 10.5.0 to 10.8.0
- Bump `lint-staged` from 16.4.0 to 17.3.0 — raises the floor for the pre-commit hook to Node >= 22.22.1
  (developer machines only; never runs in CI)
- Bump `prettier` from 3.8.4 to 3.9.6 (no formatting drift — `format:check` passes unchanged)
- Bump `vitest` from 4.1.8 to 4.1.10
- Pin `@types/vscode` from `^1.120.0` down to `~1.85.0`, and add a Dependabot ignore rule so it is only raised
  deliberately alongside `engines.vscode`
- Held `typescript` at 6.0.3 — TypeScript 7 is the native Go port and ships no JavaScript compiler API, which
  `@typescript-eslint` 8.65.0 rejects at both install (`ERESOLVE`, peer range `>=4.8.4 <6.1.0`) and lint time

## [0.2.7] - 2026-04-04

### Added

- **Style*: fix style issue


## [0.2.6] - 2026-04-04

### Added

- **Lifetime stats**: total tokens, favorite model, active days, longest streak, current streak, and most active day in the dashboard
- Derived stats computed from existing `dailyActivity` and `modelUsage` data — no new data sources needed

## [0.2.5] - 2026-04-04

### Changed

- Bump `vitest` from 1.6.1 to 4.1.2
- Bump `@vitest/coverage-v8` from 1.6.1 to 4.1.2
- Bump `typescript` from 5.9.3 to 6.0.2
- Bump `esbuild` from 0.27.4 to 0.28.0
- Bump `eslint` from 10.1.0 to 10.2.0
- Bump `@typescript-eslint/parser` from 8.57.2 to 8.58.0
- Bump `@typescript-eslint/eslint-plugin` from 8.57.2 to 8.58.0
- Bump `@types/node` from 25.5.0 to 25.5.2

## [0.2.4] - 2026-04-04

### Added

- **Collapsible dashboard sections** — dashboard reorganized into Usage, Sessions, Tokens, and Activity sections with click-to-toggle expand/collapse
- **Date-aware reset times** — weekly reset times now show the full date (e.g., `at Sun Apr 6 22:00`) instead of just the time
- **Usage status subtitle** — dashboard header now shows "Live data", "Cached data", or "Cached data (API rate limited)" based on actual fetch status
- `npm run audit:security` script for local dependency vulnerability checks
- `currency` field support in Extra Usage for correct currency symbol display

### Fixed

- **Extra Usage showing `$0.00 / $1000.00`** — values are now correctly converted from cents to the main currency unit (e.g., `£0.00 / £10.00`)
- Extra Usage now shows "Not enabled" when `is_enabled` is false, and hides entirely when the monthly limit is zero
- Currency symbol now matches account currency (GBP → £, EUR → €, etc.) instead of hardcoded `$`
- Working directory in session cards now wraps properly — label stays on one line, path wraps up to 3 lines with ellipsis, full path on hover

### Changed

- Added `@vscode/vsce` as a dev dependency for local packaging and publishing

## [0.2.3] - 2026-04-04

### Changed

- Added `@vscode/vsce` as a dev dependency for local packaging and publishing

## [0.2.2] - 2026-04-04

### Added

- **Security audit workflow** — `npm audit` runs on every PR and weekly (Monday 3 AM UTC), checking production deps, all deps, and package signatures
- **Dependabot** — automated weekly dependency update PRs with `dependencies` and `security` labels
- **Pre-push hook** — blocks `git push` when production dependencies have critical vulnerabilities
- `npm run audit:security` script for local security checks
- `PUBLISHING.md` — step-by-step guide for VS Code Marketplace publishing

### Changed

- Status bar now displays the 5-hour window utilization percentage, with color coding based on the max window utilization
- Reset timer matches the displayed window instead of always using the 5-hour window directly
- Usage data refresh now supports force refresh and shows errors/warnings automatically
- Consolidated duplicate refresh-and-notify calls into `refreshUsageData(showFeedback, forceRefresh)`

### Fixed

- `.gitignore` now excludes `claude-pulse-monitor-*` packaged extension files

## [0.2.1] - 2026-03-30

### Changed

- Updated README with screenshots for VS Code Marketplace listing
- Updated status bar description to reflect five-tier color coding

## [0.2.0] - 2026-03-30

### Added

- **Task completion notifications** — detects when Claude finishes a task and sends both VS Code and OS-level system notifications
- Multi-session task monitoring — watches all active sessions independently with per-session idle timers and cooldowns
- New settings: `notifications.onTaskComplete` and `taskCompletionIdleSeconds`
- System Notifications setup guide for macOS in README

### Fixed

- System notifications now work correctly (`node-notifier` marked as external in esbuild, included in VSIX package)
- Removed stale local file usage fallback — status bar shows loading state until real API data arrives
- No more flash of incorrect usage percentage on startup

## [0.1.9] - 2026-03-30

### Fixed

- Fix crash when `extra_usage` fields are null (Cannot read properties of null reading 'toFixed')
- Status bar reset timer now always shows the 5-hour session window instead of whichever window has highest utilization
- API data no longer overwritten by stale local file data on file watcher refresh

## [0.1.6] - 2026-03-29

### Added

- Multi-session support in dashboard — shows all active Claude sessions with individual cards
- Five-tier usage color coding: very low (blue), low (green), medium (amber), high (orange), critical (red)
- 24-hour clock time in status bar reset display: `80% 1h 32m (14:45)`

### Changed

- New marketplace icon — dark navy background with cyan pulse line (256x256, crisp quality)
- Status bar warning threshold lowered from 75% to 70% for earlier visual feedback
- Dashboard usage bars now use five-tier colors instead of two
- Reset times in dashboard use 24-hour format

## [0.1.5] - 2026-03-29

### Changed

- ESLint migrated to flat config (`eslint.config.mjs`) for ESLint v10 compatibility
- Downgraded Vitest to v1 for Node 18 compatibility in CI

## [0.1.4] - 2026-03-29

### Added

- `npm run release` command — single command to lint, test, build, package, and publish
- Marketplace icon (`"icon"` field in package.json)
- Auto-assign author workflow for pull requests
- GitHub pull request template

### Changed

- API refresh interval default changed from 60s to 1 hour (3600s)
- Differentiated notifications: "API data refreshed" vs "Local data refreshed" for manual refreshes
- Background API refreshes are now silent (no notification popups)
- Renamed extension to "Claude Pulse Monitor" (`claude-pulse-monitor`)

## [0.1.3] - 2026-03-29

### Added

- Prettier code formatting with `.prettierrc` config
- Enhanced ESLint rules (`eqeqeq`, `no-throw-literal`, Prettier integration)
- Husky pre-commit hooks with lint-staged for automatic linting and formatting
- Vitest test suite with 66 unit tests covering dataAggregator, statsReader, sessionReader, configManager, and formatting utilities
- VS Code mock for testing (`test/__mocks__/vscode.ts`)
- CI workflow (`.github/workflows/ci.yml`) — lint, format check, build, and test on PRs (Node 18 & 20)
- Release workflow (`.github/workflows/release.yml`) — automated Marketplace publishing on version tags
- `PUBLISHING.md` — comprehensive guide for VS Code Marketplace publishing with regulatory and policy requirements
- `CHANGELOG.md` — changelog following Keep a Changelog format

### Changed

- Extracted magic numbers into named constants (`src/constants.ts`)
- Deduplicated `formatDuration`, `formatNumber` into shared `src/utils/formatting.ts`
- Deduplicated `getCurrentWeekBounds`, `formatDate` into shared `src/utils/dateUtils.ts`
- Updated all source files to import from shared utilities and constants
- Added logging to previously empty catch blocks in usageApi, fileWatcher, notificationManager, and extension entry point
- Formatted all source files with Prettier

## [0.1.0] - 2025-03-28

### Added

- Status bar with usage percentage, reset timer, message count, and session count
- Interactive dashboard webview with usage bars, session info, weekly stats, model breakdown, and hourly activity chart
- Real-time file watching for Claude Code stats and sessions (`~/.claude/`)
- OAuth-based usage API integration with retry logic and caching (macOS keychain + file-based credentials)
- Session start/end detection via PID liveness monitoring
- VS Code in-app and OS-level system notifications (via node-notifier)
- Configurable settings: polling intervals, notification preferences, session reset interval, custom Claude home path
- Commands: Show Dashboard, Refresh Data, Reset Timer, Toggle Notifications
