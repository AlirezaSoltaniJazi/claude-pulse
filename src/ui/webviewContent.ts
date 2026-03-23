import { ClaudePulseData, ModelUsage, WeeklyUsageSummary } from '../types';

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
  </style>
</head>
<body>
  <div class="dashboard-header">
    <h1>Claude Pulse</h1>
    <span class="subtitle">${data.stats ? `Data as of ${data.stats.lastComputedDate}` : 'No data available'}</span>
  </div>

  <div class="grid">
    ${renderSessionCard(data, resetIntervalMinutes)}
    ${renderWeeklyCard(data.weeklyUsage)}
    ${renderSonnetCard(data.weeklyUsage)}
    ${renderLifetimeCard(data)}
  </div>

  <div class="grid">
    ${renderModelBreakdownCard(data)}
    ${renderHourlyCard(data)}
  </div>
</body>
</html>`;
}

function renderSessionCard(data: ClaudePulseData, resetIntervalMinutes: number): string {
  const session = data.mostRecentSession;
  const active = data.activeSessions.length > 0;

  if (!session) {
    return `<div class="card">
      <h2>Current Session</h2>
      <p class="no-data">No Claude session detected</p>
    </div>`;
  }

  const startedAt = new Date(session.startedAt);
  const elapsed = Date.now() - session.startedAt;
  const resetMs = resetIntervalMinutes * 60 * 1000;
  const remaining = resetMs - elapsed;

  return `<div class="card">
    <h2>Current Session</h2>
    <div class="stat-row">
      <span class="stat-label">Status</span>
      <span class="stat-value ${active ? 'status-active' : 'status-inactive'}">${active ? 'Active' : 'Inactive'}</span>
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
      <span class="stat-value">${session.cwd}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Started</span>
      <span class="stat-value">${startedAt.toLocaleString()}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Duration</span>
      <span class="stat-value">${formatDuration(elapsed)}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Est. Reset</span>
      <span class="stat-value">${remaining > 0 ? formatDuration(remaining) : 'Ready'}</span>
    </div>
  </div>`;
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

  const percentage = weekly.totalTokens > 0
    ? ((weekly.sonnetTokens / weekly.totalTokens) * 100).toFixed(1)
    : '0';

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
      <span class="stat-value">${formatDuration(s.longestSession.duration)} (${formatNumber(s.longestSession.messageCount)} msgs)</span>
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

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(Math.abs(ms) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}
