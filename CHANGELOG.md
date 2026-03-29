# Changelog

All notable changes to the Claude Pulse extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

## [0.1.1] - 2026-03-29

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
