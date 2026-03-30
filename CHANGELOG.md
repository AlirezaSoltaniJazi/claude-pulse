# Changelog

All notable changes to the Claude Pulse extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
