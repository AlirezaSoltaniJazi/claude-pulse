import {
  ClaudePulseData,
  ClaudeUsage,
  ModelUsage,
  SessionFile,
  WeeklyUsageSummary,
} from '../types';
import { formatDurationShort, formatNumber } from '../utils/formatting';
import {
  USAGE_TIER_LOW,
  USAGE_TIER_MEDIUM,
  USAGE_TIER_HIGH,
  USAGE_TIER_CRITICAL,
} from '../constants';

function usageColor(pct: number): string {
  if (pct >= USAGE_TIER_CRITICAL) return 'var(--error)';
  if (pct >= USAGE_TIER_HIGH) return 'var(--warning)';
  if (pct >= USAGE_TIER_MEDIUM) return 'var(--amber)';
  if (pct >= USAGE_TIER_LOW) return 'var(--success)';
  return 'var(--accent)';
}

function format24hTime(date: Date): string {
  const hh = date.getHours().toString().padStart(2, '0');
  const mm = date.getMinutes().toString().padStart(2, '0');
  return `${hh}:${mm}`;
}

function formatShortDate(date: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${days[date.getDay()]} ${months[date.getMonth()]} ${date.getDate()}`;
}

function getSubtitleText(data: ClaudePulseData): string {
  if (data.usage) {
    switch (data.usageStatus) {
      case 'success':
        return 'Live data from Anthropic API';
      case 'cached':
        return 'Cached data from Anthropic API';
      case 'rate_limited':
        return 'Cached data (API rate limited)';
      default:
        return 'API data';
    }
  }
  if (data.stats) {
    return `Stats cached from ${data.stats.lastComputedDate}`;
  }
  return 'No data available';
}

export function generateDashboardHtml(data: ClaudePulseData, resetIntervalMinutes: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude Pulse Dashboard</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --border: var(--vscode-panel-border, #333);
      --card-bg: var(--vscode-editorWidget-background, #1e1e1e);
      --accent: var(--vscode-textLink-foreground, #4fc1ff);
      --muted: var(--vscode-descriptionForeground, #888);
      --success: var(--vscode-testing-iconPassed, #4caf50);
      --warning: var(--vscode-editorWarning-foreground, #ff9800);
      --error: var(--vscode-editorError-foreground, #f44336);
      --amber: #ffb300;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      background: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
      font-size: var(--vscode-font-size, 13px);
      padding: 20px;
      line-height: 1.5;
    }

    .dashboard-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 24px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
    }

    .dashboard-header h1 {
      font-size: 1.4em;
      font-weight: 600;
    }

    .dashboard-header .subtitle {
      color: var(--muted);
      font-size: 0.9em;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 16px;
      margin-bottom: 16px;
    }

    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 16px;
    }

    .card h2 {
      font-size: 1em;
      font-weight: 600;
      margin-bottom: 12px;
      color: var(--accent);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .stat-row {
      display: flex;
      justify-content: space-between;
      padding: 4px 0;
    }

    .stat-label { color: var(--muted); }
    .stat-value { font-weight: 600; font-variant-numeric: tabular-nums; }

    .stat-highlight {
      font-size: 1.8em;
      font-weight: 700;
      color: var(--accent);
      display: block;
      margin: 4px 0 8px;
    }

    .usage-bar {
      margin: 8px 0;
    }

    .usage-bar-header {
      display: flex;
      justify-content: space-between;
      margin-bottom: 4px;
    }

    .usage-bar-track {
      background: var(--border);
      border-radius: 4px;
      height: 8px;
      overflow: hidden;
    }

    .usage-bar-fill {
      height: 100%;
      border-radius: 4px;
      transition: width 0.3s;
    }

    .usage-bar-info {
      color: var(--muted);
      font-size: 0.85em;
      margin-top: 4px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 8px;
    }

    th, td {
      text-align: left;
      padding: 6px 8px;
      border-bottom: 1px solid var(--border);
      font-variant-numeric: tabular-nums;
    }

    th {
      color: var(--muted);
      font-weight: 500;
      font-size: 0.9em;
    }

    td:not(:first-child), th:not(:first-child) {
      text-align: right;
    }

    .bar-container {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 3px 0;
    }

    .bar-label {
      min-width: 30px;
      text-align: right;
      color: var(--muted);
      font-size: 0.85em;
    }

    .bar {
      height: 14px;
      background: var(--accent);
      border-radius: 3px;
      opacity: 0.7;
      transition: width 0.3s;
    }

    .bar-value {
      font-size: 0.85em;
      color: var(--muted);
      min-width: 30px;
    }

    .status-active { color: var(--success); }
    .status-inactive { color: var(--muted); }

    .full-width { grid-column: 1 / -1; }

    .no-data {
      color: var(--muted);
      font-style: italic;
      padding: 12px 0;
    }

    .session-count-badge {
      background: var(--accent);
      color: var(--bg);
      border-radius: 10px;
      padding: 1px 8px;
      font-size: 0.8em;
      font-weight: 600;
    }

    .refresh-btn {
      margin-left: auto;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--fg);
      padding: 4px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.85em;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .refresh-btn:hover {
      background: var(--border);
    }

    .section {
      margin-bottom: 20px;
    }

    .section-header {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      padding: 8px 0;
      user-select: none;
      border-bottom: 1px solid var(--border);
      margin-bottom: 12px;
    }

    .section-header:hover {
      opacity: 0.8;
    }

    .section-header h2 {
      font-size: 1.1em;
      font-weight: 600;
      color: var(--fg);
      margin: 0;
    }

    .section-toggle {
      font-size: 0.8em;
      color: var(--muted);
      transition: transform 0.2s;
      display: inline-block;
    }

    .section-toggle.collapsed {
      transform: rotate(-90deg);
    }

    .section-content {
      overflow: hidden;
      transition: max-height 0.3s ease;
    }

    .section-content.collapsed {
      max-height: 0 !important;
    }
  </style>
</head>
<body>
  <div class="dashboard-header">
    <h1>Claude Pulse</h1>
    <span class="subtitle">${getSubtitleText(data)}</span>
    <button class="refresh-btn" onclick="refreshData()">Refresh</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    function refreshData() {
      vscode.postMessage({ command: 'refreshData' });
    }
    function toggleSection(name) {
      const content = document.getElementById('content-' + name);
      const toggle = document.getElementById('toggle-' + name);
      if (content.classList.contains('collapsed')) {
        content.style.maxHeight = content.scrollHeight + 'px';
        content.classList.remove('collapsed');
        toggle.classList.remove('collapsed');
        setTimeout(function() { content.style.maxHeight = 'none'; }, 300);
      } else {
        content.style.maxHeight = content.scrollHeight + 'px';
        content.offsetHeight;
        content.style.maxHeight = '0';
        content.classList.add('collapsed');
        toggle.classList.add('collapsed');
      }
    }
  </script>

  <div class="section">
    <div class="section-header" onclick="toggleSection('usage')">
      <span class="section-toggle" id="toggle-usage">&#9660;</span>
      <h2>Usage</h2>
    </div>
    <div class="section-content" id="content-usage">
      <div class="grid">
        ${renderUsageCard(data.usage)}
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-header" onclick="toggleSection('sessions')">
      <span class="section-toggle" id="toggle-sessions">&#9660;</span>
      <h2>Sessions</h2>
    </div>
    <div class="section-content" id="content-sessions">
      <div class="grid">
        ${renderSessionCards(data, resetIntervalMinutes)}
        ${renderLifetimeCard(data)}
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-header" onclick="toggleSection('tokens')">
      <span class="section-toggle" id="toggle-tokens">&#9660;</span>
      <h2>Tokens</h2>
    </div>
    <div class="section-content" id="content-tokens">
      <div class="grid">
        ${renderWeeklyCard(data.weeklyUsage)}
        ${renderSonnetCard(data.weeklyUsage)}
        ${renderModelBreakdownCard(data)}
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-header" onclick="toggleSection('activity')">
      <span class="section-toggle" id="toggle-activity">&#9660;</span>
      <h2>Activity</h2>
    </div>
    <div class="section-content" id="content-activity">
      <div class="grid">
        ${renderHourlyCard(data)}
      </div>
    </div>
  </div>
</body>
</html>`;
}

function renderUsageCard(usage: ClaudeUsage | null): string {
  if (!usage) {
    return `<div class="card">
      <h2>Usage</h2>
      <p class="no-data">No usage data (click Refresh to fetch)</p>
    </div>`;
  }

  const windows = [
    { label: 'Current Session (5h)', data: usage.five_hour },
    { label: 'This Week (All Models)', data: usage.seven_day },
    { label: 'This Week (Sonnet)', data: usage.seven_day_sonnet },
    { label: 'This Week (Opus)', data: usage.seven_day_opus },
  ];

  const bars = windows
    .filter((w) => w.data !== null)
    .map((w) => {
      const pct = Math.round(w.data!.utilization);
      const color = usageColor(pct);
      const resetStr = w.data!.resets_at ? formatResetTime(w.data!.resets_at) : '';
      return `<div class="usage-bar">
        <div class="usage-bar-header">
          <span class="stat-label">${w.label}</span>
          <span class="stat-value">${pct}%</span>
        </div>
        <div class="usage-bar-track">
          <div class="usage-bar-fill" style="background: ${color}; width: ${pct}%;"></div>
        </div>
        ${resetStr ? `<div class="usage-bar-info">Resets ${resetStr}</div>` : ''}
      </div>`;
    })
    .join('');

  const extra = usage.extra_usage;
  let extraUsage = '';
  if (extra) {
    if (!extra.is_enabled) {
      extraUsage = `<div class="usage-bar" style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border);">
        <div class="usage-bar-header">
          <span class="stat-label">Extra Usage</span>
          <span class="stat-value" style="color: var(--muted)">Not enabled</span>
        </div>
      </div>`;
    } else if (extra.monthly_limit > 0) {
      extraUsage = `<div class="usage-bar" style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border);">
        <div class="usage-bar-header">
          <span class="stat-label">Extra Usage</span>
          <span class="stat-value">$${extra.used_credits.toFixed(2)} / $${extra.monthly_limit.toFixed(2)}</span>
        </div>
        <div class="usage-bar-track">
          <div class="usage-bar-fill" style="background: ${(extra.utilization ?? 0) >= 100 ? 'var(--error)' : 'var(--accent)'}; width: ${Math.min(100, extra.utilization ?? 0)}%;"></div>
        </div>
      </div>`;
    }
  }

  return `<div class="card">
    <h2>Usage</h2>
    ${bars}
    ${extraUsage}
  </div>`;
}

function renderSessionCards(data: ClaudePulseData, resetIntervalMinutes: number): string {
  const sessions: SessionFile[] =
    data.activeSessions.length > 0
      ? data.activeSessions
      : data.mostRecentSession
        ? [data.mostRecentSession]
        : [];

  if (sessions.length === 0) {
    return `<div class="card">
      <h2>Sessions</h2>
      <p class="no-data">No Claude session detected</p>
    </div>`;
  }

  const activePids = new Set(data.activeSessions.map((s) => s.pid));

  // Compute reset display once (it's account-wide, not per-session)
  let resetDisplay: string;
  if (data.usage?.five_hour?.resets_at) {
    const resetsAtMs = new Date(data.usage.five_hour.resets_at).getTime();
    const remaining = resetsAtMs - Date.now();
    resetDisplay =
      remaining > 0
        ? `${formatDurationShort(remaining)} (${format24hTime(new Date(resetsAtMs))})`
        : 'Ready';
  } else {
    const elapsed = Date.now() - sessions[0].startedAt;
    const resetMs = resetIntervalMinutes * 60 * 1000;
    const remaining = resetMs - elapsed;
    resetDisplay =
      remaining > 0
        ? `~${formatDurationShort(remaining)} (${format24hTime(new Date(Date.now() + remaining))})`
        : 'Ready';
  }

  return sessions
    .map((session, index) => {
      const isActive = activePids.has(session.pid);
      const startedAt = new Date(session.startedAt);
      const elapsed = Date.now() - session.startedAt;
      const title =
        sessions.length > 1
          ? `Session ${index + 1} of ${sessions.length} <span class="session-count-badge">${sessions.length}</span>`
          : 'Current Session';

      return `<div class="card">
      <h2>${title}</h2>
      <div class="stat-row">
        <span class="stat-label">Status</span>
        <span class="stat-value ${isActive ? 'status-active' : 'status-inactive'}">${isActive ? 'Active' : 'Inactive'}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">PID</span>
        <span class="stat-value">${session.pid}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Session ID</span>
        <span class="stat-value">${session.sessionId.substring(0, 8)}...</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Working Dir</span>
        <span class="stat-value" title="${session.cwd}">${session.cwd}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Started</span>
        <span class="stat-value">${startedAt.toLocaleString()}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Duration</span>
        <span class="stat-value">${formatDurationShort(elapsed)}</span>
      </div>
      ${
        index === 0
          ? `<div class="stat-row">
        <span class="stat-label">Resets</span>
        <span class="stat-value">${resetDisplay}</span>
      </div>`
          : ''
      }
    </div>`;
    })
    .join('');
}

function renderWeeklyCard(weekly: WeeklyUsageSummary | null): string {
  if (!weekly) {
    return `<div class="card">
      <h2>This Week (All Models)</h2>
      <p class="no-data">No data for this week</p>
    </div>`;
  }

  return `<div class="card">
    <h2>This Week (All Models)</h2>
    <span class="stat-highlight">${formatNumber(weekly.totalTokens)} tokens</span>
    <div class="stat-row">
      <span class="stat-label">Messages</span>
      <span class="stat-value">${formatNumber(weekly.totalMessages)}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Sessions</span>
      <span class="stat-value">${weekly.totalSessions}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Tool Calls</span>
      <span class="stat-value">${formatNumber(weekly.totalToolCalls)}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Period</span>
      <span class="stat-value">${weekly.weekStart} to ${weekly.weekEnd}</span>
    </div>
  </div>`;
}

function renderSonnetCard(weekly: WeeklyUsageSummary | null): string {
  if (!weekly) {
    return `<div class="card">
      <h2>This Week (Sonnet Only)</h2>
      <p class="no-data">No data for this week</p>
    </div>`;
  }

  const percentage =
    weekly.totalTokens > 0 ? ((weekly.sonnetTokens / weekly.totalTokens) * 100).toFixed(1) : '0';

  return `<div class="card">
    <h2>This Week (Sonnet Only)</h2>
    <span class="stat-highlight">${formatNumber(weekly.sonnetTokens)} tokens</span>
    <div class="stat-row">
      <span class="stat-label">% of Total</span>
      <span class="stat-value">${percentage}%</span>
    </div>
  </div>`;
}

function renderLifetimeCard(data: ClaudePulseData): string {
  if (!data.stats) {
    return `<div class="card">
      <h2>Lifetime Stats</h2>
      <p class="no-data">No stats available</p>
    </div>`;
  }

  const s = data.stats;
  const firstDate = s.firstSessionDate ? new Date(s.firstSessionDate).toLocaleDateString() : 'N/A';

  return `<div class="card">
    <h2>Lifetime Stats</h2>
    <div class="stat-row">
      <span class="stat-label">Total Sessions</span>
      <span class="stat-value">${s.totalSessions}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Total Messages</span>
      <span class="stat-value">${formatNumber(s.totalMessages)}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">First Session</span>
      <span class="stat-value">${firstDate}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Longest Session</span>
      <span class="stat-value">${formatDurationShort(s.longestSession.duration)} (${formatNumber(s.longestSession.messageCount)} msgs)</span>
    </div>
  </div>`;
}

function renderModelBreakdownCard(data: ClaudePulseData): string {
  if (!data.stats || Object.keys(data.stats.modelUsage).length === 0) {
    return `<div class="card full-width">
      <h2>Token Breakdown by Model</h2>
      <p class="no-data">No model usage data</p>
    </div>`;
  }

  const rows = Object.entries(data.stats.modelUsage)
    .map(([model, usage]: [string, ModelUsage]) => {
      const shortName = model.replace('claude-', '').replace(/-\d{8}$/, '');
      return `<tr>
        <td>${shortName}</td>
        <td>${formatNumber(usage.inputTokens)}</td>
        <td>${formatNumber(usage.outputTokens)}</td>
        <td>${formatNumber(usage.cacheReadInputTokens)}</td>
        <td>${formatNumber(usage.cacheCreationInputTokens)}</td>
      </tr>`;
    })
    .join('');

  return `<div class="card full-width">
    <h2>Token Breakdown by Model</h2>
    <table>
      <thead>
        <tr>
          <th>Model</th>
          <th>Input</th>
          <th>Output</th>
          <th>Cache Read</th>
          <th>Cache Create</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderHourlyCard(data: ClaudePulseData): string {
  if (!data.stats || Object.keys(data.stats.hourCounts).length === 0) {
    return `<div class="card full-width">
      <h2>Activity by Hour</h2>
      <p class="no-data">No hourly data</p>
    </div>`;
  }

  const counts = data.stats.hourCounts;
  const maxCount = Math.max(...Object.values(counts).map(Number));

  const bars = Array.from({ length: 24 }, (_, h) => {
    const count = Number(counts[h.toString()] ?? 0);
    const width = maxCount > 0 ? (count / maxCount) * 100 : 0;
    if (count === 0) return '';
    return `<div class="bar-container">
      <span class="bar-label">${h.toString().padStart(2, '0')}h</span>
      <div class="bar" style="width: ${width}%"></div>
      <span class="bar-value">${count}</span>
    </div>`;
  })
    .filter(Boolean)
    .join('');

  return `<div class="card full-width">
    <h2>Activity by Hour</h2>
    ${bars}
  </div>`;
}

function formatResetTime(isoString: string): string {
  const resetDate = new Date(isoString);
  const remaining = resetDate.getTime() - Date.now();

  if (remaining <= 0) return 'soon';

  const now = new Date();
  const isSameDay =
    resetDate.getFullYear() === now.getFullYear() &&
    resetDate.getMonth() === now.getMonth() &&
    resetDate.getDate() === now.getDate();

  const timeStr = isSameDay
    ? `at ${format24hTime(resetDate)}`
    : `at ${formatShortDate(resetDate)} ${format24hTime(resetDate)}`;

  return `in ${formatDurationShort(remaining)} (${timeStr})`;
}
