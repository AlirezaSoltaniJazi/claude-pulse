# Claude Pulse

Monitor Claude Code usage, sessions, and token consumption directly from your VS Code status bar.

Claude Pulse gives you real-time visibility into your Claude Code activity — usage percentages across rate-limit windows, session reset countdowns, token breakdowns by model, and weekly usage trends — all without leaving your editor.

## Features

### Status Bar

- Live usage percentage (max across 5-hour and 7-day windows)
- Session reset countdown timer (from API or estimated)
- Optional message count and session count display
- Color-coded warnings at 75% and 90% thresholds

### Interactive Dashboard

Open with the **Claude Pulse: Show Dashboard** command to see:

- **Usage bars** — Current session (5h), weekly (all models), weekly (Sonnet), weekly (Opus), and extra usage
- **Session info** — Active session PID, working directory, duration, and reset time
- **Weekly summary** — Total tokens, messages, sessions, and tool calls for the current week
- **Sonnet breakdown** — Sonnet token usage and percentage of total
- **Lifetime stats** — Total sessions, messages, first session date, longest session
- **Model breakdown** — Token usage table by model (input, output, cache read, cache create)
- **Hourly activity chart** — Visual bar chart of activity distribution by hour

### Real-Time Monitoring

- File watching on `~/.claude/` for stats and session changes
- PID liveness detection for active session tracking
- Notifications on session start, session end, and reset timer completion
- Optional OS-level system notifications (via node-notifier)

### Usage API Integration

- Fetches live usage data from the Anthropic API using your existing OAuth credentials
- Reads credentials from macOS Keychain or `~/.claude/.credentials.json`
- Retry logic with exponential backoff and rate-limit handling
- Configurable refresh interval (minimum 60 seconds)

## Installation

1. Open VS Code
2. Go to Extensions (`Ctrl+Shift+X` / `Cmd+Shift+X`)
3. Search for **Claude Pulse**
4. Click **Install**

Or install from the command line:

```bash
code --install-extension AlirezaSoltaniJazi.claude-pulse
```

## Requirements

- **VS Code** 1.85.0 or later
- **Claude Code CLI** installed and logged in (for stats data in `~/.claude/`)
- **OAuth login** via Claude Code CLI (for live API usage data — optional but recommended)

## Configuration

All settings are under `claudePulse.*` in VS Code Settings.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `statusBar.showResetTimer` | boolean | `true` | Show session reset countdown in status bar |
| `statusBar.showTokenCount` | boolean | `false` | Show today's message count in status bar |
| `statusBar.showSessionCount` | boolean | `false` | Show today's session count in status bar |
| `sessionResetIntervalMinutes` | number | `300` | Session reset interval in minutes (300 = 5h for Pro plan) |
| `sessionTokenLimit` | number | `8000000` | Estimated token limit per session window (for usage % calculation) |
| `pollingIntervalSeconds` | number | `30` | How often to check Claude files for changes (min: 5) |
| `usageRefreshIntervalSeconds` | number | `60` | How often to refresh from the Anthropic API (min: 60) |
| `notifications.enabled` | boolean | `false` | Enable notifications for Claude events |
| `notifications.useSystemNotifications` | boolean | `false` | Use OS-level desktop notifications |
| `notifications.onNewSession` | boolean | `true` | Notify when a new Claude session starts |
| `notifications.onSessionEnd` | boolean | `true` | Notify when a Claude session ends |
| `notifications.onResetTimerComplete` | boolean | `true` | Notify when the session reset timer reaches zero |
| `claudeHomePath` | string | `""` | Custom path to .claude directory (leave empty for `~/.claude`) |

## Commands

| Command | Description |
|---------|-------------|
| `Claude Pulse: Show Dashboard` | Open the interactive dashboard panel |
| `Claude Pulse: Refresh Data` | Force refresh all data (files + API) |
| `Claude Pulse: Reset Session Timer` | Reset the session timer |
| `Claude Pulse: Toggle Notifications` | Enable or disable notifications |

## How It Works

Claude Pulse reads data from two sources:

1. **Local files** (`~/.claude/`) — Claude Code writes session files, stats cache, and JSONL session logs to this directory. Claude Pulse watches these files for changes and aggregates weekly usage from JSONL logs.

2. **Anthropic API** (`api.anthropic.com/api/oauth/usage`) — When OAuth credentials are available, Claude Pulse fetches live usage percentages and reset times. Credentials are read from the macOS Keychain or `~/.claude/.credentials.json` — the extension never stores credentials itself.

## Privacy & Security

- **No telemetry**: Claude Pulse does not collect, store, or transmit any analytics or telemetry data
- **Local data only**: Stats and session data are read from your local `~/.claude/` directory (read-only)
- **Secure credentials**: OAuth tokens are read from the OS Keychain (macOS) or a local file — never stored by the extension
- **HTTPS only**: All API communication uses HTTPS
- **No eval**: The dashboard webview runs only first-party JavaScript — no `eval()` or dynamic code execution
- **Open source**: Full source code available at [github.com/AlirezaSoltaniJazi/claude-pulse](https://github.com/AlirezaSoltaniJazi/claude-pulse)

## System Notifications Setup (macOS)

Claude Pulse can send OS-level desktop notifications (e.g., when Claude finishes a task). To enable:

1. In VS Code Settings, enable:
   - `Claude Pulse > Notifications: Enabled` → checked
   - `Claude Pulse > Notifications: Use System Notifications` → checked
2. The first notification will prompt macOS to register **terminal-notifier**
3. Go to **System Settings → Notifications → terminal-notifier** and make sure:
   - **Allow Notifications** is turned on
   - **Alert style** is set to **Banners** or **Alerts** (not "None")
4. Make sure **Focus / Do Not Disturb** mode is off, or allow terminal-notifier through Focus settings

After setup, you'll receive macOS notification banners for:
- Task completion (Claude finished and is waiting for input)
- Session start/end
- Session reset timer complete

## Known Limitations

- OAuth credential reading is currently supported on macOS (Keychain) and Linux (file-based). Windows support is not yet implemented.
- The extension reads stats written by Claude Code CLI — if the CLI changes its file format, stats parsing may need updates.
- Usage API data depends on having a valid OAuth session with Claude Code.

## Contributing

Contributions are welcome! Please see the [repository](https://github.com/AlirezaSoltaniJazi/claude-pulse) for details.

```bash
# Clone and install
git clone https://github.com/AlirezaSoltaniJazi/claude-pulse.git
cd claude-pulse
npm install

# Development
npm run watch    # Build in watch mode
# Press F5 in VS Code to launch Extension Development Host

# Quality checks
npm run lint     # ESLint
npm run format:check  # Prettier
npm test         # Vitest (66 tests)
npm run build    # Production build
```

## License

[MIT](LICENSE)

---

> Claude Pulse is an independent, community-built extension. It is not officially affiliated with, endorsed by, or sponsored by Anthropic, PBC. "Claude" is a trademark of Anthropic.
