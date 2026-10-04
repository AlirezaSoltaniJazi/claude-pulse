import {
  AgentGraph,
  AgentMap,
  AgentNode,
  AgentStatus,
  AgentTypeGroup,
  ClaudePulseData,
  ClaudeUsage,
  DailyActivity,
  ModelUsage,
  PromptCacheInfo,
  SessionFile,
  SessionNode,
  WeeklyUsageSummary,
} from '../types';
import { formatDurationShort, formatModelName, formatNumber } from '../utils/formatting';
import { limitLabel, resolveLimits } from '../utils/usageLimits';
import { groupAgentsByType } from '../utils/agentGrouping';
import {
  AGENT_GRAPH_CHIP_TYPES,
  AGENT_GRAPH_MAX_NODES_PER_LEVEL,
  AGENT_GRAPH_NODES_PER_LEVEL,
  USAGE_TIER_LOW,
  USAGE_TIER_MEDIUM,
  USAGE_TIER_HIGH,
  USAGE_TIER_CRITICAL,
} from '../constants';

/**
 * Escapes text interpolated into the dashboard's HTML.
 *
 * Model ids come from transcript files and window labels come from the API, so neither is
 * ours to trust: '<synthetic>' alone is enough to swallow the rest of a row as a bogus tag.
 *
 * This is the ONLY escaper, which is why the graph's buttons carry their payload in data-*
 * attributes and dispatch through one delegated listener. An `onclick="f('${...}')"` would
 * put the value in two nested contexts at once — the HTML parser decodes `&#39;` back to a
 * quote before the JS is ever compiled, so entity-escaping is exactly the wrong defence
 * there, and an agent description is model-authored text that reaches this file verbatim.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Key of the session-first tab. Not a valid agent type, so it can never collide with one:
 * agent types come from meta files and are non-empty, and this starts with a character a
 * type identifier does not use.
 */
const SESSIONS_TAB_KEY = '@sessions';

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

function getCurrencySymbol(currency?: string): string {
  const symbols: Record<string, string> = {
    usd: '$',
    gbp: '£',
    eur: '€',
    jpy: '¥',
    cad: 'CA$',
    aud: 'A$',
  };
  return currency ? (symbols[currency.toLowerCase()] ?? currency.toUpperCase() + ' ') : '$';
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

/**
 * View state the panel owns rather than the data layer.
 *
 * It lives outside ClaudePulseData because it is not something read off the disk: it is what
 * the user last clicked. The panel rewrites its entire HTML on every poll, so any selection
 * held only in the DOM is thrown away every few seconds — this is what carries it across.
 */
export interface DashboardViewState {
  /** Agent tab the user last selected, by its stable key. Null means "whatever is first". */
  activeAgentTab: string | null;
  /**
   * Sessions whose subagents are open, by session id. Everything else draws collapsed.
   *
   * Opt-in rather than opt-out: the graph's first job is "what is running on this machine",
   * which is a question about sessions, and a machine with a few hundred finished subagents
   * answers it with a wall of boxes unless the subagents stay folded until asked for.
   */
  expandedSessions: string[];
}

const EMPTY_VIEW_STATE: DashboardViewState = { activeAgentTab: null, expandedSessions: [] };

export function generateDashboardHtml(
  data: ClaudePulseData,
  resetIntervalMinutes: number,
  viewState: DashboardViewState = EMPTY_VIEW_STATE
): string {
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
      /*
       * The graph's two node colours. Fixed rather than theme-derived: the whole point of the
       * picture is that a session and a subagent are different KINDS of thing, and a palette
       * borrowed from the active theme would make that distinction the first casualty of a
       * theme change. Tints are alpha over the theme's own background, so they stay legible
       * on light and dark alike.
       */
      --node-session-border: #7c6cf0;
      --node-session-bg: rgba(124, 108, 240, 0.14);
      --node-agent-border: #2aa88b;
      --node-agent-bg: rgba(42, 168, 139, 0.12);
      /*
       * Connector lines get their own token rather than reusing --border. The panel border
       * is #2b2b2b against a #1f1f1f editor background in Dark Modern — fine as the edge of
       * a filled card, invisible as a 1px line in open space, which drew the entire graph
       * as floating boxes with nothing joining them. The indent guide is the closest thing
       * VS Code themes expose to "a line you are meant to be able to follow".
       */
      --connector: var(--vscode-editorIndentGuide-activeBackground1, #707070);
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

    .stat-label { color: var(--muted); white-space: nowrap; }
    .stat-value { font-weight: 600; font-variant-numeric: tabular-nums; }

    .cwd-value {
      word-break: break-all;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 70%;
      text-align: right;
    }

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
    /*
     * Connector lines, drawn with borders on pseudo-elements rather than SVG.
     *
     * Every node is a different height and width (a task description is as long as it is), so
     * an SVG overlay would have to measure the laid-out boxes and redraw on every resize.
     * Borders on pseudo-elements cost nothing and cannot drift out of alignment with the
     * boxes they join.
     *
     * Children run DOWN the page, not across it, with the spine to their left. A fan-out —
     * parent centred above a row of children, which is the shape this started as — cannot
     * survive real data: sessions with 59 and 98 subagents both exist on the machine this was
     * built on, and even after capping the row at a dozen the parent ends up centred over a
     * box wider than the panel, scrolled out of sight of the children it points at. Vertical
     * growth is free, so nothing overflows and the session node is always on screen.
     */
    .tree { padding-top: 4px; }

    .tree + .tree {
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
    }

    .tree-children { padding-left: 2px; }

    .tree-branch {
      position: relative;
      padding-left: 30px;
      padding-top: 8px;
    }

    /*
     * The spine. It runs the full height of every child except the last, which stops it at
     * its own elbow — that is what makes the line end at the last sibling instead of
     * trailing off past the bottom of the group.
     */
    .tree-branch::before {
      content: '';
      position: absolute;
      left: 10px;
      top: 0;
      bottom: 0;
      border-left: 1px solid var(--connector);
    }

    .tree-branch:last-child::before {
      bottom: auto;
      height: 22px;
    }

    /* The elbow into the node, level with the node's title line. */
    .tree-branch::after {
      content: '';
      position: absolute;
      left: 10px;
      top: 22px;
      width: 13px;
      border-top: 1px solid var(--connector);
    }

    .tree-branch > .tree-root::before {
      content: '';
      position: absolute;
      left: -7px;
      top: 18px;
      border: 4px solid transparent;
      border-left-color: var(--connector);
    }

    .tree-root { position: relative; }

    .node {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--card-bg);
      padding: 8px 10px;
      min-width: 190px;
      max-width: 560px;
      text-align: left;
    }

    .node-session {
      border-color: var(--node-session-border);
      background: var(--node-session-bg);
      min-width: 250px;
      max-width: 620px;
    }

    .node-agent {
      border-color: var(--node-agent-border);
      background: var(--node-agent-bg);
    }

    .node-dead { opacity: 0.55; }

    .node-more {
      border-style: dashed;
      min-width: 150px;
      color: var(--muted);
    }
    .node-primary { box-shadow: 0 0 0 2px var(--node-session-bg); }

    .node-head {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .node-title {
      font-weight: 600;
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .node-tag {
      font-size: 0.7em;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 0 4px;
      white-space: nowrap;
    }

    .node-meta,
    .node-foot,
    .node-model,
    .node-path {
      font-size: 0.82em;
      color: var(--muted);
      margin-top: 3px;
    }

    .node-path,
    .node-title {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .dot-sep {
      margin: 0 5px;
      opacity: 0.6;
      font-style: normal;
    }

    .node-status {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex: none;
      background: var(--muted);
    }

    .node-running { border-color: var(--success); }
    .node-running .node-status {
      background: var(--success);
      animation: node-pulse 1.6s ease-in-out infinite;
    }
    .node-completed .node-status { background: var(--muted); }
    .node-stopped .node-status { background: var(--warning); }
    .node-orphaned .node-status { background: var(--error); }

    @keyframes node-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }

    @media (prefers-reduced-motion: reduce) {
      .node-running .node-status { animation: none; }
    }

    .node-btn {
      background: transparent;
      color: var(--muted);
      border: 1px solid var(--border);
      border-radius: 5px;
      padding: 1px 7px;
      font-size: 0.78em;
      font-family: inherit;
      cursor: pointer;
      flex: none;
    }

    .node-btn:hover { color: var(--fg); border-color: var(--fg); }
    .node-btn-danger:hover { color: var(--error); border-color: var(--error); }
    .node-btn:disabled { opacity: 0.5; cursor: default; }

    .tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin: 10px 0 14px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 0;
    }

    .tab {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: transparent;
      color: var(--muted);
      border: 1px solid transparent;
      border-bottom: none;
      border-radius: 6px 6px 0 0;
      padding: 5px 11px;
      font-size: 0.9em;
      font-family: inherit;
      cursor: pointer;
      /* Sits on the container's bottom border so the active tab can erase its own slice. */
      margin-bottom: -1px;
    }

    .tab:hover { color: var(--fg); }

    .tab-active {
      color: var(--fg);
      border-color: var(--border);
      background: var(--card-bg);
      font-weight: 600;
    }

    .tab-count {
      font-size: 0.8em;
      color: var(--muted);
      background: var(--node-session-bg);
      border-radius: 8px;
      padding: 0 6px;
      font-variant-numeric: tabular-nums;
    }

    .tab-live {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--success);
      flex: none;
      animation: node-pulse 1.6s ease-in-out infinite;
    }

    @media (prefers-reduced-motion: reduce) {
      .tab-live { animation: none; }
    }

    .tab-panel.is-hidden { display: none; }

    .graph-controls {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 10px 0 2px;
    }

    .graph-controls-hint {
      font-size: 0.82em;
      color: var(--muted);
      flex: 1;
    }

    /* Folded: the children are still in the DOM, so opening one is instant and needs no
       round trip to the extension host. */
    .tree.is-collapsed > .tree-children { display: none; }

    .node-expandable { cursor: pointer; }

    .node-expandable:hover {
      border-color: var(--fg);
    }

    .node-caret {
      flex: none;
      width: 16px;
      height: 16px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: none;
      border: none;
      color: var(--muted);
      font-size: 0.85em;
      line-height: 1;
      cursor: pointer;
      transition: transform 0.15s ease;
    }

    .tree.is-collapsed .node-caret { transform: rotate(-90deg); }

    .node-caret:hover { color: var(--fg); }
    .node-caret-empty { visibility: hidden; }

    @media (prefers-reduced-motion: reduce) {
      .node-caret { transition: none; }
    }

    .node-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 6px;
    }

    .node-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 0.78em;
      color: var(--muted);
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1px 7px;
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .node-chip-count {
      font-style: normal;
      font-variant-numeric: tabular-nums;
      color: var(--fg);
      opacity: 0.8;
    }

    .node-chip-more { border-style: dashed; }

    .panel-summary {
      font-size: 0.85em;
      color: var(--muted);
      margin-bottom: 4px;
    }

    .panel-running { color: var(--success); }

    .graph-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      font-size: 0.82em;
      color: var(--muted);
      margin: 8px 0 2px;
    }

    .swatch {
      width: 10px;
      height: 10px;
      border-radius: 3px;
      display: inline-block;
      margin-right: 6px;
      vertical-align: -1px;
      border: 1px solid var(--border);
    }

    .swatch-session {
      background: var(--node-session-bg);
      border-color: var(--node-session-border);
    }

    .swatch-agent {
      background: var(--node-agent-bg);
      border-color: var(--node-agent-border);
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
    /*
     * One delegated listener for every kill button in the graph.
     *
     * The buttons carry their payload in data-* attributes rather than an onclick, because an
     * agent description is model-authored text and inlining it into a JS string inside an HTML
     * attribute would need escaping for both contexts at once. See escapeHtml().
     *
     * The button is disabled on click: the panel re-renders on a poll, not on the click, so
     * without this a slow SIGTERM invites a second press that lands as a second confirmation.
     */
    document.addEventListener('click', function (event) {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      const btn = target.closest('button[data-action], button[data-tab]');

      /*
       * Disclosure, handled before anything else claims the click.
       *
       * Checked only when the click did NOT land on a kill/tab button, because the Kill
       * button sits inside the very node that toggles — without that guard, killing a
       * session would also fold it, and the confirmation dialog would come back to a
       * different-looking row than the one the user aimed at.
       *
       * Like the tabs, this flips the DOM here and ALSO tells the host, which rewrites this
       * HTML from scratch on every poll and would otherwise re-fold everything mid-read.
       */
      if (!btn) {
        const bulk = target.closest('button[data-bulk]');
        if (bulk) {
          const card = bulk.closest('.card');
          const panel = card && card.querySelector('.tab-panel:not(.is-hidden)');
          if (!panel) return;
          const open = bulk.dataset.bulk === 'expand';
          const ids = [];
          panel.querySelectorAll('[data-session-tree]').forEach(function (tree) {
            setTreeOpen(tree, open);
            ids.push(tree.dataset.sessionTree);
          });
          if (ids.length) {
            vscode.postMessage({ command: 'setSessionExpanded', sessionIds: ids, expanded: open });
          }
          return;
        }

        const tree = target.closest('[data-session-tree]');
        if (tree) {
          // A click that ended a drag over the cwd path is someone copying it, not asking
          // for the node to fold under their cursor.
          const selection = window.getSelection();
          if (selection && selection.toString().length > 0) return;

          const open = tree.classList.contains('is-collapsed');
          setTreeOpen(tree, open);
          vscode.postMessage({
            command: 'setSessionExpanded',
            sessionIds: [tree.dataset.sessionTree],
            expanded: open,
          });
          return;
        }
      }

      if (!btn || btn.disabled) return;

      /*
       * Tabs switch here and now, and the choice is ALSO posted to the host.
       *
       * Locally because a round trip would mean waiting on a full HTML regeneration to see a
       * tab change; to the host because that regeneration happens anyway on the next poll and
       * would otherwise snap the user back to the first tab every few seconds.
       */
      if (btn.dataset.tab) {
        const group = btn.closest('.card');
        if (!group) return;
        group.querySelectorAll('.tab').forEach(function (tab) {
          tab.classList.toggle('tab-active', tab === btn);
        });
        group.querySelectorAll('.tab-panel').forEach(function (panel) {
          panel.classList.toggle('is-hidden', panel.id !== 'panel-' + btn.dataset.tab);
        });
        vscode.postMessage({ command: 'selectAgentTab', key: btn.dataset.tabKey || '' });
        return;
      }

      const payload = {
        pid: Number(btn.dataset.pid),
        sessionId: btn.dataset.session || '',
        label: btn.dataset.label || '',
      };

      if (btn.dataset.action === 'kill-session') {
        vscode.postMessage(Object.assign({ command: 'killSession' }, payload));
      } else if (btn.dataset.action === 'kill-agent') {
        vscode.postMessage(
          Object.assign({ command: 'killAgent', agentDescription: btn.dataset.agent || '' }, payload)
        );
      } else {
        return;
      }

      btn.disabled = true;
      btn.textContent = '...';
    });

    /* One session's fold state, in the DOM. The caret's label follows it so a screen reader
     * is told what the button will do next, not what it just did. */
    function setTreeOpen(tree, open) {
      tree.classList.toggle('is-collapsed', !open);
      const caret = tree.querySelector('.node-caret');
      if (caret && caret.tagName === 'BUTTON') {
        caret.setAttribute('aria-expanded', String(open));
        const label = caret.getAttribute('aria-label') || '';
        caret.setAttribute(
          'aria-label',
          (open ? 'Hide' : 'Show') + label.replace(/^(Show|Hide)/, '')
        );
      }
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
        ${renderPromptCacheCard(data.promptCache)}
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
        ${renderModelBreakdownCard(data.weeklyUsage)}
      </div>
    </div>
  </div>

  ${renderAgentGraphSection(data.agentGraph, viewState)}

  ${renderAgentsSection(data.agents)}

  <div class="section">
    <div class="section-header" onclick="toggleSection('activity')">
      <span class="section-toggle" id="toggle-activity">&#9660;</span>
      <h2>Activity</h2>
    </div>
    <div class="section-content" id="content-activity">
      <div class="grid">
        ${renderHourlyCard(data.weeklyUsage)}
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

  // Whatever windows the API reported, labelled by the API. A model-scoped limit such as
  // 'This Week (Fable)' appears here on its own, and so will the next one.
  const bars = resolveLimits(usage)
    .map((limit) => {
      const pct = Math.round(limit.percent);
      const color = usageColor(pct);
      const resetStr = limit.resets_at ? formatResetTime(limit.resets_at) : '';
      return `<div class="usage-bar">
        <div class="usage-bar-header">
          <span class="stat-label">${escapeHtml(limitLabel(limit))}</span>
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
      const currencySymbol = getCurrencySymbol(extra.currency);
      const spent = (extra.used_credits / 100).toFixed(2);
      const limit = (extra.monthly_limit / 100).toFixed(2);
      extraUsage = `<div class="usage-bar" style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border);">
        <div class="usage-bar-header">
          <span class="stat-label">Extra Usage</span>
          <span class="stat-value">${currencySymbol}${spent} / ${currencySymbol}${limit}</span>
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
        <span class="stat-value cwd-value" title="${session.cwd}">${session.cwd}</span>
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

function getFavoriteModel(modelUsage: Record<string, ModelUsage>): string {
  const entries = Object.entries(modelUsage);
  if (entries.length === 0) return 'N/A';
  const [model] = entries.reduce((best, curr) => {
    const bestTotal = best[1].inputTokens + best[1].outputTokens;
    const currTotal = curr[1].inputTokens + curr[1].outputTokens;
    return currTotal > bestTotal ? curr : best;
  });
  return model.replace('claude-', '').replace(/-\d{8}$/, '');
}

function getTotalTokens(modelUsage: Record<string, ModelUsage>): number {
  return Object.values(modelUsage).reduce((sum, m) => sum + m.inputTokens + m.outputTokens, 0);
}

function computeStreaks(dailyActivity: DailyActivity[]): {
  activeDays: number;
  totalDays: number;
  longestStreak: number;
  currentStreak: number;
  mostActiveDay: string;
  mostActiveDayCount: number;
} {
  if (dailyActivity.length === 0) {
    return {
      activeDays: 0,
      totalDays: 0,
      longestStreak: 0,
      currentStreak: 0,
      mostActiveDay: 'N/A',
      mostActiveDayCount: 0,
    };
  }

  // Sort by date ascending
  const sorted = [...dailyActivity]
    .filter((d) => d.messageCount > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const activeDays = sorted.length;

  // Total days from first activity to today
  const firstDate = new Date(sorted[0]?.date ?? Date.now());
  const totalDays = Math.max(
    1,
    Math.ceil((Date.now() - firstDate.getTime()) / (1000 * 60 * 60 * 24))
  );

  // Most active day
  const most = sorted.reduce((best, curr) => (curr.messageCount > best.messageCount ? curr : best));
  const mostActiveDate = new Date(most.date);
  const mostActiveDay = `${formatShortDate(mostActiveDate)}`;
  const mostActiveDayCount = most.messageCount;

  // Build set of active dates for streak calculation
  const activeDates = new Set(sorted.map((d) => d.date));

  // Longest streak
  let longestStreak = 0;
  let streak = 0;
  let prevDate: Date | null = null;
  for (const d of sorted) {
    const curr = new Date(d.date);
    if (prevDate) {
      const diffDays = Math.round((curr.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24));
      streak = diffDays === 1 ? streak + 1 : 1;
    } else {
      streak = 1;
    }
    longestStreak = Math.max(longestStreak, streak);
    prevDate = curr;
  }

  // Current streak (count backwards from today)
  let currentStreak = 0;
  const today = new Date();
  for (let i = 0; i <= totalDays; i++) {
    const checkDate = new Date(today);
    checkDate.setDate(today.getDate() - i);
    const dateStr = checkDate.toISOString().split('T')[0];
    if (activeDates.has(dateStr)) {
      currentStreak++;
    } else if (i === 0) {
      // Today might not have activity yet, skip
      continue;
    } else {
      break;
    }
  }

  return {
    activeDays,
    totalDays,
    longestStreak,
    currentStreak,
    mostActiveDay,
    mostActiveDayCount,
  };
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
  const favoriteModel = getFavoriteModel(s.modelUsage);
  const totalTokens = getTotalTokens(s.modelUsage);
  const streaks = computeStreaks(s.dailyActivity);

  return `<div class="card">
    <h2>Lifetime Stats</h2>
    <div class="stat-row">
      <span class="stat-label">Total Tokens</span>
      <span class="stat-value">${formatNumber(totalTokens)}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Favorite Model</span>
      <span class="stat-value">${favoriteModel}</span>
    </div>
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
    <div class="stat-row">
      <span class="stat-label">Active Days</span>
      <span class="stat-value">${streaks.activeDays}/${streaks.totalDays}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Longest Streak</span>
      <span class="stat-value">${streaks.longestStreak} day${streaks.longestStreak !== 1 ? 's' : ''}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Current Streak</span>
      <span class="stat-value">${streaks.currentStreak} day${streaks.currentStreak !== 1 ? 's' : ''}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Most Active Day</span>
      <span class="stat-value">${streaks.mostActiveDay} (${streaks.mostActiveDayCount} msgs)</span>
    </div>
  </div>`;
}

/**
 * Per-model token table for the current week.
 *
 * Reads the JSONL scan, not `stats-cache.json`: Claude Code stopped writing the `modelUsage`
 * the old implementation depended on, which left this card permanently empty. The transcripts
 * are the only source that still reports per-model tokens, and they report every model —
 * so a model with a handful of turns shows up instead of vanishing into the total.
 */
function renderModelBreakdownCard(weekly: WeeklyUsageSummary | null): string {
  const models = weekly ? Object.entries(weekly.modelBreakdown) : [];
  if (!weekly || models.length === 0) {
    return `<div class="card full-width">
      <h2>Token Breakdown by Model</h2>
      <p class="no-data">No model usage data</p>
    </div>`;
  }

  const total = weekly.totalTokens;
  const rows = models
    .sort((a, b) => b[1].totalTokens - a[1].totalTokens)
    .map(([model, usage]) => {
      // formatModelName falls back to the raw id, so an id it cannot parse still names itself.
      const label = formatModelName(model) || model;
      const share = total > 0 ? ((usage.totalTokens / total) * 100).toFixed(1) : '0.0';
      return `<tr>
        <td>${escapeHtml(label)}</td>
        <td>${formatNumber(usage.inputTokens)}</td>
        <td>${formatNumber(usage.outputTokens)}</td>
        <td>${formatNumber(usage.cacheReadInputTokens)}</td>
        <td>${formatNumber(usage.cacheCreationInputTokens)}</td>
        <td>${formatNumber(usage.totalTokens)}</td>
        <td>${share}%</td>
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
          <th>Total</th>
          <th>% of Week</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

/**
 * How long the prompt cache is expected to stay warm.
 *
 * Every number here is prefixed '~' and the card says so in words: the transcript records
 * when a request happened, never how the server cached it, so this is an inference from the
 * last request plus an assumed TTL. Presenting it as fact would be the one way to get it wrong.
 */
function renderPromptCacheCard(cache: PromptCacheInfo | null): string {
  if (!cache) {
    return `<div class="card">
      <h2>Prompt Cache</h2>
      <p class="no-data">No session activity to measure from</p>
    </div>`;
  }

  const remaining = cache.warmUntil - Date.now();
  const ttlMinutes = Math.round(cache.ttlMs / 60_000);

  if (remaining <= 0) {
    return `<div class="card">
      <h2>Prompt Cache</h2>
      <span class="stat-highlight" style="color: var(--muted)">Cold</span>
      <div class="stat-row">
        <span class="stat-label">Last request</span>
        <span class="stat-value">${formatDurationShort(Date.now() - cache.lastActivityAt)} ago</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Next message</span>
        <span class="stat-value">Reprocesses full context</span>
      </div>
    </div>`;
  }

  const pct = Math.round((remaining / cache.ttlMs) * 100);

  return `<div class="card">
    <h2>Prompt Cache</h2>
    <span class="stat-highlight">~${formatDurationShort(remaining)} left</span>
    <div class="usage-bar-track">
      <div class="usage-bar-fill" style="background: var(--accent); width: ${pct}%;"></div>
    </div>
    <div class="stat-row">
      <span class="stat-label">Last request</span>
      <span class="stat-value">${formatDurationShort(Date.now() - cache.lastActivityAt)} ago</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Assumed TTL</span>
      <span class="stat-value">${ttlMinutes}m</span>
    </div>
    <div class="usage-bar-info">Estimated from the last request, not reported by Claude Code.</div>
  </div>`;
}

/**
 * The spawn graph: every session on the machine, with the subagents hanging off it.
 *
 * Laid out top-down — session above, its agents in a row beneath, elbow connectors between —
 * because the point of the picture is the direction of the arrow. An agent belongs to exactly
 * one session and cannot outlive it, and that is the fact the layout has to make obvious,
 * since it is also the reason the kill buttons work the way they do.
 *
 * The children row does NOT wrap. A session with 95 subagents (which exists in the wild)
 * would turn a wrapping row into a block of boxes with connector lines running through the
 * middle of it; scrolling one row sideways stays readable at any count.
 */
function renderAgentGraphSection(graph: AgentGraph | null, viewState: DashboardViewState): string {
  if (!graph || graph.sessions.length === 0) return '';

  const activeTab = viewState.activeAgentTab;
  const expanded = new Set(viewState.expandedSessions);

  const live = graph.sessions.filter((s) => s.isAlive).length;
  const running = graph.sessions.reduce((sum, s) => sum + countByStatus(s.agents, 'running'), 0);
  const totalAgents = graph.sessions.reduce((sum, s) => sum + s.agentCount, 0);

  const groups = groupAgentsByType(graph);

  // The session tab comes first and is not an agent type. It is what keeps a session with no
  // subagents reachable at all — it belongs to no type, and on a normal machine most sessions
  // are in exactly that state — so without it the Kill button for an idle session would have
  // nowhere to live.
  const tabs: RenderedTab[] = [
    {
      key: SESSIONS_TAB_KEY,
      label: 'Sessions',
      count: graph.sessions.length,
      active: live,
      activeLabel: `${live} live`,
      body: graph.sessions.map((session) => renderSessionTree(session, expanded)).join(''),
    },
    ...groups.map((group) => ({
      key: group.agentType,
      label: group.agentType,
      count: group.count,
      active: group.runningCount,
      activeLabel: `${group.runningCount} running`,
      body: renderTypePanel(group, expanded),
    })),
  ];

  // An unknown or stale key (a type whose last run aged out of the graph) falls back to the
  // first tab rather than rendering a panel-less tab bar.
  const selected = tabs.some((t) => t.key === activeTab) ? activeTab : tabs[0].key;

  const tabBar = tabs
    .map((tab, index) => {
      const isActive = tab.key === selected;
      const dot =
        tab.active > 0 ? `<i class="tab-live" title="${escapeHtml(tab.activeLabel)}"></i>` : '';
      return `<button class="tab${isActive ? ' tab-active' : ''}"
        data-tab="t${index}"
        data-tab-key="${escapeHtml(tab.key)}">${escapeHtml(tab.label)}${dot}<span class="tab-count">${tab.count}</span></button>`;
    })
    .join('');

  const panels = tabs
    .map(
      (tab, index) =>
        `<div class="tab-panel${tab.key === selected ? '' : ' is-hidden'}" id="panel-t${index}">${tab.body}</div>`
    )
    .join('');

  const truncated = graph.truncated
    ? `<div class="usage-bar-info">Showing the ${graph.sessions.length} most recent sessions only.</div>`
    : '';

  return `<div class="section">
    <div class="section-header" onclick="toggleSection('graph')">
      <span class="section-toggle" id="toggle-graph">&#9660;</span>
      <h2>Agent Graph</h2>
    </div>
    <div class="section-content" id="content-graph">
      <div class="grid">
        <div class="card full-width">
          <h2>Agents &amp; Sessions</h2>
          <span class="stat-highlight">${live} live &middot; ${running} agents running</span>
          <div class="stat-row">
            <span class="stat-label">Sessions</span>
            <span class="stat-value">${graph.sessions.length}</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Subagents</span>
            <span class="stat-value">${totalAgents}</span>
          </div>
          <div class="graph-legend">
            <span><i class="swatch swatch-session"></i>Session &mdash; one OS process, killable</span>
            <span><i class="swatch swatch-agent"></i>Subagent &mdash; runs inside its session</span>
          </div>
          <div class="tabs" role="tablist">${tabBar}</div>
          <div class="graph-controls">
            <span class="graph-controls-hint">Click a session to show its subagents</span>
            <button class="node-btn" data-bulk="expand">Expand all</button>
            <button class="node-btn" data-bulk="collapse">Collapse all</button>
          </div>
          ${panels}
          ${truncated}
        </div>
      </div>
    </div>
  </div>`;
}

/** One tab, already rendered. `key` is what the host remembers across a re-render. */
interface RenderedTab {
  key: string;
  label: string;
  count: number;
  /** Drives the pulsing dot. Zero means no dot. */
  active: number;
  /** What the dot means on THIS tab — live sessions on one, running agents on the rest. */
  activeLabel: string;
  body: string;
}

/**
 * One agent type: the sessions that ran it, each with its runs of that type beneath it.
 *
 * The arrow still points from the session to the agent, because that is still the direction
 * the process relationship runs — this tab only changes which of the two you started from.
 * The Kill button therefore stays on the session node here too, and means the same thing.
 */
function renderTypePanel(group: AgentTypeGroup, expanded: ReadonlySet<string>): string {
  const summary = `<div class="panel-summary">
    <span>${group.count} run${group.count === 1 ? '' : 's'}</span>
    <i class="dot-sep">&middot;</i>
    <span>${group.sessions.length} session${group.sessions.length === 1 ? '' : 's'}</span>
    <i class="dot-sep">&middot;</i>
    <span>${formatNumber(group.totalTokens)} tokens</span>
    ${group.runningCount > 0 ? `<i class="dot-sep">&middot;</i><span class="panel-running">${group.runningCount} running</span>` : ''}
  </div>`;

  const trees = group.sessions
    .map((entry) => {
      const { visible, hidden } = selectVisible(
        entry.instances,
        (instance) => instance.agent.status === 'running'
      );

      const branches = visible
        .map(
          (instance) => `<div class="tree-branch">
            <div class="tree-root">${renderAgentNode(instance.agent, entry.session, instance.parentDescription)}</div>
          </div>`
        )
        .join('');

      const summarised = renderHiddenSummary(
        hidden.map((instance) => instance.agent),
        hidden.reduce((sum, instance) => sum + instance.agent.tokens, 0)
      );

      const footer = `${entry.instances.length} run${entry.instances.length === 1 ? '' : 's'} of this type &middot; ${formatNumber(entry.totalTokens)} tokens`;
      const isOpen = expanded.has(entry.session.sessionId);

      return `<div class="tree${isOpen ? '' : ' is-collapsed'}" data-session-tree="${escapeHtml(entry.session.sessionId)}">
        <div class="tree-root">${renderSessionNode(entry.session, footer, { expandable: true, expanded: isOpen })}</div>
        <div class="tree-children">${branches}${summarised}</div>
      </div>`;
    })
    .join('');

  return summary + trees;
}

/**
 * One session and its agent tree, folded shut until the user opens it.
 *
 * A session with no subagents is not a disclosure at all: it gets no caret, no pointer
 * cursor and no toggle attribute, because a control that opens an empty drawer teaches the
 * user that the caret means nothing.
 */
function renderSessionTree(session: SessionNode, expanded: ReadonlySet<string>): string {
  const running = countByStatus(session.agents, 'running');
  const totals = session.agentCount
    ? [
        `${session.agentCount} agent${session.agentCount === 1 ? '' : 's'}`,
        running > 0 ? `<span class="panel-running">${running} running</span>` : null,
        `${formatNumber(session.totalTokens)} tokens`,
      ]
        .filter((part): part is string => Boolean(part))
        .join(' &middot; ')
    : 'no subagents';

  if (session.agents.length === 0) {
    return `<div class="tree">
      <div class="tree-root">${renderSessionNode(session, totals, { expandable: false, expanded: false })}</div>
    </div>`;
  }

  const isOpen = expanded.has(session.sessionId);
  const branches = renderBranches(session.agents, session);

  const truncated = session.truncated
    ? `<div class="usage-bar-info">This session's agent list was truncated.</div>`
    : '';

  return `<div class="tree${isOpen ? '' : ' is-collapsed'}" data-session-tree="${escapeHtml(session.sessionId)}">
    <div class="tree-root">${renderSessionNode(session, totals, { expandable: true, expanded: isOpen, agents: session.agents })}</div>
    <div class="tree-children">${branches}
    ${truncated}</div>
  </div>`;
}

/**
 * What is inside a folded session, without opening it.
 *
 * Counts by agent type rather than listing descriptions: the descriptions are the reason the
 * expanded view is long, and "4 general-purpose, 1 Explore" is what someone scanning nine
 * sessions for the interesting one actually reads.
 */
export function summariseAgentTypes(agents: AgentNode[]): Array<{ type: string; count: number }> {
  const counts = new Map<string, number>();

  const walk = (nodes: AgentNode[]): void => {
    for (const node of nodes) {
      counts.set(node.agentType, (counts.get(node.agentType) ?? 0) + 1);
      walk(node.children);
    }
  };
  walk(agents);

  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

function renderTypeChips(agents: AgentNode[]): string {
  const summary = summariseAgentTypes(agents);
  if (summary.length === 0) return '';

  const shown = summary.slice(0, AGENT_GRAPH_CHIP_TYPES);
  const rest = summary.slice(AGENT_GRAPH_CHIP_TYPES);
  const chips = shown
    .map(
      (entry) =>
        `<span class="node-chip">${escapeHtml(entry.type)}<i class="node-chip-count">${entry.count}</i></span>`
    )
    .join('');
  const more = rest.length
    ? `<span class="node-chip node-chip-more">+${rest.length} type${rest.length === 1 ? '' : 's'}</span>`
    : '';

  return `<div class="node-chips">${chips}${more}</div>`;
}

/**
 * The session box, shared by both tabs.
 *
 * Deliberately one function: the Kill button is the most consequential control in the
 * dashboard, and two copies of it — one per tab — would be two places for its PID/session-id
 * pairing to drift apart. `footer` is the only thing that differs, because the session tab
 * counts all of a session's agents while a type tab counts only that type's.
 */
interface SessionNodeOptions {
  /** False for a session with no subagents — nothing to disclose, so no caret. */
  expandable: boolean;
  expanded: boolean;
  /** Only passed where a type breakdown makes sense: the all-agents session tree. */
  agents?: AgentNode[];
}

function renderSessionNode(
  session: SessionNode,
  footer: string,
  options: SessionNodeOptions
): string {
  const uptime = session.startedAt > 0 ? formatDurationShort(Date.now() - session.startedAt) : '—';
  const model = session.model ? formatModelName(session.model) : null;

  const meta = [
    `PID ${session.pid}`,
    session.isAlive ? `up ${uptime}` : 'exited',
    session.entrypoint,
    model,
  ]
    .filter((part): part is string => Boolean(part))
    .map((part) => `<span>${escapeHtml(part)}</span>`)
    .join('<i class="dot-sep">&middot;</i>');

  // A dead session has nothing to signal, so it gets no button rather than a disabled one.
  const kill = session.isAlive
    ? `<button class="node-btn node-btn-danger" title="Send SIGTERM to PID ${session.pid}"
         data-action="kill-session"
         data-pid="${session.pid}"
         data-session="${escapeHtml(session.sessionId)}"
         data-label="${escapeHtml(session.label)}">Kill</button>`
    : '';

  // The caret is a real button so the disclosure is reachable by keyboard and announced as
  // one; the surrounding node is click-to-toggle as well, which is what a pointer expects of
  // a row this size. Both routes end in the same handler.
  const caret = options.expandable
    ? `<button class="node-caret" aria-expanded="${options.expanded}"
         aria-label="${options.expanded ? 'Hide' : 'Show'} subagents of ${escapeHtml(session.label)}">&#9662;</button>`
    : '<span class="node-caret node-caret-empty" aria-hidden="true"></span>';

  const chips = options.expandable && options.agents ? renderTypeChips(options.agents) : '';

  return `<div class="node node-session${session.isAlive ? '' : ' node-dead'}${session.isPrimary ? ' node-primary' : ''}${options.expandable ? ' node-expandable' : ''}">
    <div class="node-head">
      ${caret}
      <span class="node-title">${escapeHtml(session.label)}</span>
      ${session.isPrimary ? '<span class="node-tag">this window</span>' : ''}
      ${kill}
    </div>
    <div class="node-meta">${meta}</div>
    <div class="node-path" title="${escapeHtml(session.cwd)}">${escapeHtml(session.cwd || '—')}</div>
    <div class="node-foot">${footer}</div>
    ${chips}
  </div>`;
}

/** The agent row beneath a node, recursing for agents that spawned agents of their own. */
function renderBranches(agents: AgentNode[], session: SessionNode): string {
  const { visible, hidden } = selectVisible(agents, (a) => a.status === 'running');

  const branches = visible
    .map((agent) => {
      const nested = agent.children.length
        ? `<div class="tree-children">${renderBranches(agent.children, session)}</div>`
        : '';

      return `<div class="tree-branch">
        <div class="tree-root">${renderAgentNode(agent, session)}</div>
        ${nested}
      </div>`;
    })
    .join('');

  return (
    branches +
    renderHiddenSummary(
      hidden,
      hidden.reduce((sum, agent) => sum + agent.subtreeTokens, 0)
    )
  );
}

/**
 * Splits a group into the agents that get a box and the ones that get counted.
 *
 * Running agents come first and are never summarised away — a Stop button the user has to
 * scroll past eleven finished agents to reach is not a Stop button. The remaining slots go
 * to the costliest of the rest, which is what someone auditing spend came here to see.
 *
 * Generic over the item because both views need the identical rule applied to different
 * shapes: the session tree caps AgentNodes, the type tab caps AgentTypeInstances. Two copies
 * of a "which runs are worth drawing" policy is one copy too many.
 */
function selectVisible<T>(
  items: T[],
  isRunning: (item: T) => boolean
): { visible: T[]; hidden: T[] } {
  if (items.length <= AGENT_GRAPH_NODES_PER_LEVEL) return { visible: items, hidden: [] };

  const running = items.filter(isRunning);
  const rest = items.filter((item) => !isRunning(item));

  const visible = running.slice(0, AGENT_GRAPH_MAX_NODES_PER_LEVEL);
  // Running agents can push the group past the baseline, but never past the ceiling.
  const slots = Math.min(
    AGENT_GRAPH_MAX_NODES_PER_LEVEL,
    Math.max(AGENT_GRAPH_NODES_PER_LEVEL, visible.length)
  );
  for (const item of rest) {
    if (visible.length >= slots) break;
    visible.push(item);
  }

  const shown = new Set(visible);
  return { visible, hidden: items.filter((item) => !shown.has(item)) };
}

/**
 * A dashed node standing in for the agents a group did not draw.
 *
 * It carries their count and their combined cost rather than just an ellipsis: the totals on
 * the session node include them, so a group that simply stopped would leave the arithmetic
 * looking wrong. The Agents table below still lists every agent of the current session.
 *
 * `tokens` is the caller's to compute, because "what did the hidden ones cost" has two
 * different answers. In the session tree a hidden agent takes its whole subtree off screen
 * with it, so the subtree total is the honest number. In a type tab the list is flattened and
 * those children are separate entries of their own, so the same sum would count them twice.
 */
function renderHiddenSummary(hidden: AgentNode[], tokens: number): string {
  if (hidden.length === 0) return '';
  const running = hidden.filter((a) => a.status === 'running').length;
  const note = running > 0 ? `${running} still running` : 'none still running';

  return `<div class="tree-branch">
    <div class="tree-root">
      <div class="node node-more">
        <div class="node-head">
          <span class="node-title">+${hidden.length} more agent${hidden.length === 1 ? '' : 's'}</span>
        </div>
        <div class="node-meta">${escapeHtml(note)}</div>
        <div class="node-foot">${formatNumber(tokens)} tokens</div>
      </div>
    </div>
  </div>`;
}

function renderAgentNode(
  agent: AgentNode,
  session: SessionNode,
  parentDescription: string | null = null
): string {
  const meta = [
    agent.agentType,
    `${agent.turns} turn${agent.turns === 1 ? '' : 's'}`,
    agent.durationMs === null ? null : formatDurationShort(agent.durationMs),
  ]
    .filter((part): part is string => Boolean(part))
    .map((part) => `<span>${escapeHtml(part)}</span>`)
    .join('<i class="dot-sep">&middot;</i>');

  const tokens =
    agent.subtreeTokens > agent.tokens
      ? `${formatNumber(agent.tokens)} tokens &middot; ${formatNumber(agent.subtreeTokens)} with children`
      : `${formatNumber(agent.tokens)} tokens`;

  // Offered only for an agent that is actually still going. Stopping one means stopping its
  // session, which the confirmation in extension.ts spells out — never this button.
  const stop =
    agent.status === 'running' && session.isAlive
      ? `<button class="node-btn node-btn-danger" title="Stopping a subagent means terminating its session"
           data-action="kill-agent"
           data-pid="${session.pid}"
           data-session="${escapeHtml(session.sessionId)}"
           data-agent="${escapeHtml(agent.description)}"
           data-label="${escapeHtml(session.label)}">Stop</button>`
      : '';

  // Only set in a type tab, where the nesting that would otherwise show this is flattened
  // away — and where the parent may be an agent of a different type under a different tab.
  const spawnedBy = parentDescription
    ? `<div class="node-model">spawned by ${escapeHtml(parentDescription)}</div>`
    : '';

  return `<div class="node node-agent node-${agent.status}">
    <div class="node-head">
      <span class="node-status" title="${escapeHtml(statusTitle(agent.status))}"></span>
      <span class="node-title">${escapeHtml(agent.description)}</span>
      ${stop}
    </div>
    <div class="node-meta">${meta}</div>
    <div class="node-foot">${tokens}</div>
    <div class="node-model">${escapeHtml(formatModelName(agent.model) || 'model unknown')}</div>
    ${spawnedBy}
  </div>`;
}

function countByStatus(agents: AgentNode[], status: AgentStatus): number {
  return agents.reduce(
    (sum, agent) => sum + (agent.status === status ? 1 : 0) + countByStatus(agent.children, status),
    0
  );
}

function statusTitle(status: AgentStatus): string {
  switch (status) {
    case 'running':
      return 'Running — no completion record yet and its session is alive';
    case 'completed':
      return 'Completed — returned its result';
    case 'stopped':
      return 'Stopped by the user';
    case 'orphaned':
      return 'Never finished — nothing is advancing it any more';
  }
}

/**
 * The subagents the current session spawned, dearest first.
 *
 * Subagents are invisible from the main transcript — one tool call in, no indication that it
 * cost 60k tokens — and they routinely dominate a session's usage. The section is omitted
 * entirely rather than shown empty: most sessions spawn none, and a permanent "no agents"
 * card would be noise on every one of them.
 */
function renderAgentsSection(agents: AgentMap | null): string {
  if (!agents || agents.agents.length === 0) return '';

  const rows = agents.agents
    .map((agent) => {
      const share =
        agents.totalTokens > 0 ? ((agent.tokens / agents.totalTokens) * 100).toFixed(1) : '0.0';
      // Depth 2+ means an agent spawned by another agent; the indent is the only hierarchy
      // this view needs, and it survives the cost-ordered sort that a real tree would not.
      const indent =
        agent.spawnDepth > 1 ? `style="padding-left: ${(agent.spawnDepth - 1) * 16}px"` : '';
      return `<tr>
        <td ${indent}>${escapeHtml(agent.description)}</td>
        <td>${escapeHtml(agent.agentType)}</td>
        <td>${escapeHtml(formatModelName(agent.model) || '—')}</td>
        <td>${agent.turns}</td>
        <td>${agent.durationMs === null ? '—' : formatDurationShort(agent.durationMs)}</td>
        <td>${formatNumber(agent.tokens)}</td>
        <td>${share}%</td>
      </tr>`;
    })
    .join('');

  const truncated = agents.truncated
    ? `<div class="usage-bar-info">Showing the first ${agents.agents.length} agents only.</div>`
    : '';

  return `<div class="section">
    <div class="section-header" onclick="toggleSection('agents')">
      <span class="section-toggle" id="toggle-agents">&#9660;</span>
      <h2>Agents</h2>
    </div>
    <div class="section-content" id="content-agents">
      <div class="grid">
        <div class="card full-width">
          <h2>Subagents This Session</h2>
          <span class="stat-highlight">${formatNumber(agents.totalTokens)} tokens</span>
          <div class="stat-row">
            <span class="stat-label">Agents</span>
            <span class="stat-value">${agents.agents.length}</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Task</th>
                <th>Type</th>
                <th>Model</th>
                <th>Turns</th>
                <th>Duration</th>
                <th>Tokens</th>
                <th>% of Agents</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          ${truncated}
        </div>
      </div>
    </div>
  </div>`;
}

/** Same story as the breakdown card: the hour histogram now comes from the weekly scan. */
function renderHourlyCard(weekly: WeeklyUsageSummary | null): string {
  if (!weekly || Object.keys(weekly.hourCounts).length === 0) {
    return `<div class="card full-width">
      <h2>Activity by Hour</h2>
      <p class="no-data">No hourly data</p>
    </div>`;
  }

  const counts = weekly.hourCounts;
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
