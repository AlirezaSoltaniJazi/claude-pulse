import * as vscode from 'vscode';
import { ConfigManager } from './config/configManager';
import { readStats } from './data/statsReader';
import {
  readSessions,
  getActiveSessions,
  getMostRecentSession,
  findSessionForWorkspace,
} from './data/sessionReader';
import { getTodayActivity } from './data/dataAggregator';
import { scanWeeklyUsage, clearScanCache } from './data/jsonlScanner';
import { readModelInfo, clearModelCache, resolveTranscriptPath } from './data/modelReader';
import { readSessionAgents, readAgentGraph, clearAgentCache } from './data/agentReader';
import {
  buildKillConfirmation,
  killSession,
  resolveKillTarget,
  KillResult,
} from './data/processControl';
import { fetchUsage, clearUsageCache, FetchUsageResult } from './data/usageApi';
import { FileWatcher } from './data/fileWatcher';
import { StatusBar } from './ui/statusBar';
import { DashboardPanel, KillRequest } from './ui/webviewPanel';
import { SessionMonitor } from './notifications/sessionMonitor';
import { NotificationManager } from './notifications/notificationManager';
import { TaskCompletionDetector } from './data/taskCompletionDetector';
import { AgentNode, ClaudePulseData, ModelInfo, PromptCacheInfo, SessionFile } from './types';
import {
  MIN_USAGE_REFRESH_INTERVAL_SEC,
  USAGE_OPPORTUNISTIC_MIN_INTERVAL_MS,
  USAGE_RATE_LIMIT_COOLOFF_MS,
} from './constants';

let configManager: ConfigManager;
let fileWatcher: FileWatcher;
let statusBar: StatusBar;
let dashboardPanel: DashboardPanel;
let sessionMonitor: SessionMonitor;
let taskCompletionDetector: TaskCompletionDetector;
let notificationManager: NotificationManager;
let usageRefreshInterval: ReturnType<typeof setInterval> | null = null;

let cachedData: ClaudePulseData = {
  stats: null,
  sessions: [],
  activeSessions: [],
  mostRecentSession: null,
  weeklyUsage: null,
  todayActivity: null,
  usage: null,
  modelInfo: null,
  promptCache: null,
  agents: null,
  agentGraph: null,
};

export function activate(context: vscode.ExtensionContext): void {
  configManager = new ConfigManager();
  const config = configManager.getConfig();

  // Data watchers
  fileWatcher = new FileWatcher(config.claudeHomePath, config.pollingIntervalSeconds * 1000);
  fileWatcher.start();

  // UI
  statusBar = new StatusBar();
  dashboardPanel = new DashboardPanel();

  // Notifications
  sessionMonitor = new SessionMonitor();
  taskCompletionDetector = new TaskCompletionDetector(config.taskCompletionIdleSeconds);
  notificationManager = new NotificationManager(config, sessionMonitor, taskCompletionDetector);

  // Initial data load (file-based first, then API in background)
  refreshData(false);
  refreshUsageData(true);

  // Periodic usage API refresh (silent — no notifications for background refreshes)
  startUsageRefreshInterval(config.usageRefreshIntervalSeconds);

  // Wire file watcher events — stats changes include usage data from cache file
  fileWatcher.onStatsChanged(() => refreshData(false));
  fileWatcher.onSessionsChanged(() => refreshData(false));
  // Model/effort ride a targeted path, NOT refreshData(). See refreshModelInfo().
  fileWatcher.onModelSettingsChanged(() => void refreshModelInfo());
  fileWatcher.onTranscriptChanged(() => void refreshModelInfo());

  // Usage is a network call, so it rides task completion — never a model switch, which
  // spends no tokens and would only add rate-limit risk.
  taskCompletionDetector.onTaskCompleted(() => void refreshUsageOpportunistically());

  // pickPrimarySession() reads the workspace folders; nothing else notices them moving.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => void refreshData(false))
  );

  // Wire config changes
  let watchedHomePath = config.claudeHomePath;
  configManager.onConfigChanged((newConfig) => {
    fileWatcher.updatePollingInterval(newConfig.pollingIntervalSeconds * 1000);
    startUsageRefreshInterval(newConfig.usageRefreshIntervalSeconds);
    taskCompletionDetector.updateIdleThreshold(newConfig.taskCompletionIdleSeconds);
    notificationManager.updateConfig(newConfig);

    // Every cache and watcher is keyed to the old root, so a path change invalidates all of
    // them. Without this the extension reads the new location but only reacts to events from
    // the old one, and keeps serving the old root's cached model and weekly scan.
    if (newConfig.claudeHomePath !== watchedHomePath) {
      watchedHomePath = newConfig.claudeHomePath;
      fileWatcher.updateClaudeHomePath(newConfig.claudeHomePath);
      clearScanCache();
      clearModelCache();
      clearAgentCache();
      void refreshData(false);
      return;
    }

    updateUI();
  });

  // Wire dashboard events
  dashboardPanel.onResetTimer(() => {
    statusBar.resetTimer();
  });
  dashboardPanel.onKillRequested((request) => void handleKillRequest(request));
  dashboardPanel.onRefreshData(async () => {
    clearScanCache();
    clearUsageCache();
    clearModelCache();
    clearAgentCache();
    await refreshData(false);
    await refreshUsageData(true, true);
  });

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('claudePulse.showDashboard', async () => {
      const config = configManager.getConfig();
      // Show immediately with cached data, then refresh
      dashboardPanel.show(cachedData, config.sessionResetIntervalMinutes);
      // Fetch fresh data in background and update. refreshData() is what populates the agent
      // map: until the panel existed it was skipped, so the first open needs a full pass.
      clearUsageCache();
      await refreshData(false);
      await refreshUsageData(false, true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudePulse.refreshData', async () => {
      clearScanCache();
      clearUsageCache();
      clearModelCache();
      clearAgentCache();
      await refreshData(false);
      await refreshUsageData(true, true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudePulse.killSession', () => void pickAndKillSession())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudePulse.resetTimer', () => {
      statusBar.resetTimer();
      vscode.window.showInformationMessage('Claude Pulse: Session timer reset');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudePulse.toggleNotifications', () => {
      const config = configManager.getConfig();
      const currentValue = config.notifications.enabled;
      vscode.workspace
        .getConfiguration('claudePulse')
        .update('notifications.enabled', !currentValue, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(
        `Claude Pulse: Notifications ${!currentValue ? 'enabled' : 'disabled'}`
      );
    })
  );

  // Register disposables
  context.subscriptions.push(
    configManager,
    fileWatcher,
    statusBar,
    dashboardPanel,
    sessionMonitor,
    taskCompletionDetector,
    notificationManager,
    {
      dispose: () => {
        if (usageRefreshInterval) clearInterval(usageRefreshInterval);
      },
    }
  );
}

function startUsageRefreshInterval(intervalSeconds: number): void {
  if (usageRefreshInterval) {
    clearInterval(usageRefreshInterval);
  }
  const intervalMs = Math.max(intervalSeconds, MIN_USAGE_REFRESH_INTERVAL_SEC) * 1000;
  usageRefreshInterval = setInterval(() => refreshUsageData(false), intervalMs);
}

/**
 * The single session the status bar describes. Shared by refreshData() and updateUI()
 * so the model never belongs to a different session than the reset timer.
 *
 * The session for THIS window's workspace wins. Without that, a user running Claude in
 * several projects at once sees whichever session happened to be read first — which for
 * the model is plainly wrong, since the model is chosen per session.
 */
function pickPrimarySession(
  activeSessions: SessionFile[],
  mostRecentSession: SessionFile | null
): SessionFile | null {
  const workspacePaths = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);

  // Fall back to the most recently started session, not the first one off disk: with no
  // workspace match (a folderless window, or Claude started outside the project) readdir
  // order is arbitrary, and the newest session is the one the user most likely just used.
  return (
    findSessionForWorkspace(activeSessions, workspacePaths) ??
    getMostRecentSession(activeSessions) ??
    mostRecentSession
  );
}

/**
 * Guards `cachedData.modelInfo` against lost updates.
 *
 * Two independent async writers race for this one field: `refreshData()`, which resolves it
 * alongside a full weekly scan, and `refreshModelInfo()`, which rides transcript appends and
 * finishes in milliseconds. Whoever claims the newest token wins; a slower writer that started
 * earlier discards its own result rather than overwriting fresher data with stale data.
 */
let modelInfoSeq = 0;

async function refreshData(alsoRefreshUsage: boolean = false): Promise<void> {
  const config = configManager.getConfig();

  const [stats, sessions] = await Promise.all([
    readStats(config.claudeHomePath),
    readSessions(config.claudeHomePath),
  ]);

  const activeSessions = getActiveSessions(sessions);
  const mostRecentSession = getMostRecentSession(
    activeSessions.length > 0 ? activeSessions : sessions
  );
  const primarySession = pickPrimarySession(activeSessions, mostRecentSession);

  // Reads that depend on the resolved session, run in parallel with the weekly scan.
  const modelToken = ++modelInfoSeq;
  const [weeklyUsage, freshModelInfo] = await Promise.all([
    scanWeeklyUsage(config.claudeHomePath),
    readModelInfo(config.claudeHomePath, primarySession, activeSessions.length > 0),
  ]);
  // The weekly scan can take seconds; a transcript append landing inside that window produces
  // a newer read than this one, so keep it rather than reverting the status bar.
  const modelInfo = modelToken === modelInfoSeq ? freshModelInfo : cachedData.modelInfo;

  // Only use API data for usage — local file data is stale and unreliable.
  const usage = cachedData.usage;

  // Scanning subagents means reading their transcripts, which dwarf everything else in
  // ~/.claude. Doing that on every poll for a dashboard nobody is looking at would make the
  // extension the most expensive thing on the machine, so it is gated on the panel being open.
  const agents =
    config.showAgentMap && dashboardPanel.isVisible
      ? await readSessionAgents(config.claudeHomePath, primarySession)
      : null;

  // The graph is gated on the panel for the same reason as the table, but on its own setting:
  // the two answer different questions and either is worth having without the other.
  //
  // Sequential rather than beside the table read on purpose. Both walk the same subagent
  // transcripts for the primary session, and transcriptStatsCache is populated on completion,
  // so running them concurrently would have both miss the cache and read those files twice.
  const agentGraph =
    config.showAgentGraph && dashboardPanel.isVisible
      ? await readAgentGraph(
          config.claudeHomePath,
          sessions,
          primarySession?.sessionId ?? null,
          modelInfo?.model ?? null
        )
      : null;

  cachedData = {
    ...cachedData,
    stats,
    sessions,
    activeSessions,
    mostRecentSession,
    weeklyUsage,
    todayActivity: stats ? getTodayActivity(stats) : null,
    usage,
    modelInfo,
    promptCache: buildPromptCacheInfo(modelInfo, config.promptCacheTtlMinutes),
    agents,
    agentGraph,
  };

  // Covers session death/restart, a new session appearing, and the fallback pick changing.
  await retargetTranscriptWatch(config.claudeHomePath, primarySession);

  // Update session monitor and task completion detector
  sessionMonitor.updateSessions(sessions);
  taskCompletionDetector.updateSessions(activeSessions, config.claudeHomePath);

  // Check reset timer for notifications
  notificationManager.checkResetTimer(mostRecentSession, mostRecentSession?.startedAt ?? null);

  updateUI();

  if (alsoRefreshUsage) {
    await refreshUsageData();
  }
}

/**
 * Targeted refresh for model/effort only.
 *
 * Deliberately NOT refreshData(): that calls scanWeeklyUsage(), which walks every directory
 * under <claudeHome>/projects and reads every .jsonl modified this week. Transcripts are
 * appended many times per turn, so routing those appends through refreshData() would run that
 * walk tens of times per minute. This path does one stat, one 64KB tail read and one settings
 * stat, all of which are cached.
 *
 * It reuses the session list from the last refreshData(): session membership changes arrive on
 * onSessionsChanged, which still runs the full refresh.
 */
async function refreshModelInfo(): Promise<void> {
  const config = configManager.getConfig();
  const primarySession = pickPrimarySession(
    cachedData.activeSessions,
    cachedData.mostRecentSession
  );

  const modelToken = ++modelInfoSeq;
  const modelInfo = await readModelInfo(
    config.claudeHomePath,
    primarySession,
    cachedData.activeSessions.length > 0
  );

  // Superseded while this read was in flight — the newer writer owns the field now. Still
  // re-target the watch: it is idempotent, and the primary session may have moved.
  if (modelToken === modelInfoSeq) {
    cachedData = { ...cachedData, modelInfo };
  }
  await retargetTranscriptWatch(config.claudeHomePath, primarySession);
  updateUI();
}

/** Keeps the transcript watch pointed at whatever pickPrimarySession() currently returns. */
async function retargetTranscriptWatch(
  claudeHomePath: string,
  session: SessionFile | null
): Promise<void> {
  const transcriptPath = session ? await resolveTranscriptPath(claudeHomePath, session) : null;
  fileWatcher.watchTranscript(transcriptPath);
}

/**
 * Usage is a percentage against an opaque server-side limit, so it can only ever be as fresh as
 * the last API call. This nudges that call to happen after a task completes — when the number
 * has actually moved — rather than waiting out the hour-long scheduled interval.
 *
 * The floor is global and module-level on purpose: TaskCompletionDetector's own cooldown is per
 * session, which offers no protection at all when several sessions finish work at once.
 */
let nextOpportunisticUsageRefreshAt = 0;

async function refreshUsageOpportunistically(): Promise<void> {
  const now = Date.now();
  if (now < nextOpportunisticUsageRefreshAt) return;
  // Advanced BEFORE the await so concurrent completions cannot slip past the gate.
  nextOpportunisticUsageRefreshAt = now + USAGE_OPPORTUNISTIC_MIN_INTERVAL_MS;

  // forceRefresh false, so USAGE_CACHE_TTL_MS acts as a second floor. Errors stay silent:
  // at one call per turn a toast on every failure would be spam.
  const result = await refreshUsageData(false, false, false);
  if (result?.status === 'rate_limited') {
    nextOpportunisticUsageRefreshAt = Date.now() + USAGE_RATE_LIMIT_COOLOFF_MS;
  }
}

async function refreshUsageData(
  showFeedback: boolean = false,
  forceRefresh: boolean = false,
  reportErrors: boolean = true
): Promise<FetchUsageResult | null> {
  try {
    const result = await fetchUsage(forceRefresh);
    if (result.data) {
      cachedData = { ...cachedData, usage: result.data, usageStatus: result.status };
      updateUI();
    } else {
      cachedData = { ...cachedData, usageStatus: result.status };
    }
    // Always show errors/warnings; only show success on manual refresh
    const isError = ['rate_limited', 'auth_error', 'no_credentials', 'error'].includes(
      result.status
    );
    if (showFeedback || (isError && reportErrors)) {
      showRefreshFeedback(result);
    }
    return result;
  } catch (e) {
    console.warn(
      `Claude Pulse: Usage refresh failed: ${e instanceof Error ? e.message : String(e)}`
    );
    return null;
  }
}

function showRefreshFeedback(result: FetchUsageResult): void {
  const showRefreshConfirmation = configManager.getConfig().notifications.onApiRefresh;
  switch (result.status) {
    case 'success':
      if (showRefreshConfirmation) {
        vscode.window.showInformationMessage('Claude Pulse: API data refreshed successfully');
      }
      break;
    case 'rate_limited':
      vscode.window.showWarningMessage(
        'Claude Pulse: API rate limited — showing cached data. Will retry automatically.'
      );
      break;
    case 'auth_error':
      vscode.window.showErrorMessage(
        'Claude Pulse: OAuth token expired or invalid. Try reopening your terminal.'
      );
      break;
    case 'no_credentials':
      vscode.window.showErrorMessage(
        'Claude Pulse: No OAuth credentials found. Make sure Claude Code is logged in.'
      );
      break;
    case 'error':
      vscode.window.showWarningMessage(`Claude Pulse: ${result.message}`);
      break;
    case 'cached':
      if (showRefreshConfirmation) {
        vscode.window.showInformationMessage('Claude Pulse: Using cached API data');
      }
      break;
  }
}

/**
 * Turns the session's last request into a prompt-cache countdown.
 *
 * Returns null when nothing has been proven about the session's activity — a countdown from
 * an unknown start would be worse than no countdown at all.
 */
function buildPromptCacheInfo(
  modelInfo: ModelInfo | null,
  ttlMinutes: number
): PromptCacheInfo | null {
  const lastActivityAt = modelInfo?.lastActivityAt ?? 0;
  if (lastActivityAt <= 0) return null;

  const ttlMs = ttlMinutes * 60 * 1000;
  return { lastActivityAt, warmUntil: lastActivityAt + ttlMs, ttlMs };
}

/**
 * Confirms and carries out a termination request from the dashboard.
 *
 * The confirmation is modal and lives here rather than in the webview for two reasons: the
 * panel rewrites its own HTML on every poll, so an in-page dialog can be swept away
 * mid-decision, and a webview cannot be trusted as the record of what the user agreed to.
 */
async function handleKillRequest(request: KillRequest): Promise<void> {
  // Re-validated against the CURRENT session list, not the one the panel was rendered from.
  // A button can sit on screen for a whole poll interval, which is long enough for the
  // session to exit and the OS to hand its PID to something else.
  if (!resolveKillTarget(request.pid, request.sessionId, cachedData.sessions)) {
    vscode.window.showWarningMessage(
      `Claude Pulse: session ${request.label} (PID ${request.pid}) is no longer running — nothing was signalled.`
    );
    await refreshAfterKill();
    return;
  }

  const confirmation = buildKillConfirmation({
    label: request.label,
    pid: request.pid,
    agentDescription: request.agentDescription,
    runningAgents: countRunningAgents(request.sessionId),
  });

  const choice = await vscode.window.showWarningMessage(
    confirmation.message,
    { modal: true, detail: confirmation.detail },
    confirmation.confirmLabel
  );
  if (choice !== confirmation.confirmLabel) return;

  const result = await killSession(request.pid, request.sessionId, cachedData.sessions);
  await reportKillResult(result, request);
  await refreshAfterKill();
}

/**
 * Reports the outcome, offering SIGKILL only once SIGTERM has demonstrably been ignored.
 *
 * Force is never the first offer: a session that is mid-request takes a moment to unwind,
 * and a SIGKILL skips the transcript flush and leaves the session file behind for the
 * extension to keep listing.
 */
async function reportKillResult(result: KillResult, request: KillRequest): Promise<void> {
  if (result.outcome === 'terminated') {
    vscode.window.showInformationMessage(`Claude Pulse: ${result.message}`);
    return;
  }

  if (result.outcome === 'signalled') {
    const force = await vscode.window.showWarningMessage(
      result.message,
      {
        modal: true,
        detail: 'Force kill skips the transcript flush. Use it only if the session is wedged.',
      },
      'Force Kill'
    );
    if (force !== 'Force Kill') return;

    const forced = await killSession(request.pid, request.sessionId, cachedData.sessions, {
      force: true,
    });
    vscode.window.showInformationMessage(`Claude Pulse: ${forced.message}`);
    return;
  }

  vscode.window.showWarningMessage(`Claude Pulse: ${result.message}`);
}

/** Every cache keyed to the session list is stale the moment a session dies. */
async function refreshAfterKill(): Promise<void> {
  clearAgentCache();
  clearModelCache();
  await refreshData(false);
}

/** Running agents in one session, counted off the graph the panel is currently showing. */
function countRunningAgents(sessionId: string): number {
  const session = cachedData.agentGraph?.sessions.find((s) => s.sessionId === sessionId);
  if (!session) return 0;

  const count = (agents: AgentNode[]): number =>
    agents.reduce(
      (sum, agent) => sum + (agent.status === 'running' ? 1 : 0) + count(agent.children),
      0
    );
  return count(session.agents);
}

/**
 * Command-palette route to the same termination path.
 *
 * Worth having separately from the graph: the dashboard has to be open for the graph to be
 * populated at all, and a wedged session is exactly the situation where the user wants to
 * reach for a command rather than wait for a panel to scan the filesystem.
 */
async function pickAndKillSession(): Promise<void> {
  const live = cachedData.activeSessions;
  if (live.length === 0) {
    vscode.window.showInformationMessage('Claude Pulse: no running Claude sessions found.');
    return;
  }

  const items = live
    .slice()
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((session) => ({
      label: session.name ?? session.cwd ?? session.sessionId.slice(0, 8),
      description: `PID ${session.pid}`,
      detail: session.cwd,
      session,
    }));

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Terminate a Claude session',
    placeHolder: 'Select the session to terminate',
  });
  if (!picked) return;

  await handleKillRequest({
    pid: picked.session.pid,
    sessionId: picked.session.sessionId,
    label: picked.label,
  });
}

function updateUI(): void {
  const config = configManager.getConfig();

  const activeSession = pickPrimarySession(cachedData.activeSessions, cachedData.mostRecentSession);

  statusBar.update(
    config,
    activeSession,
    cachedData.todayActivity,
    cachedData.usage,
    cachedData.modelInfo,
    cachedData.promptCache
  );

  if (dashboardPanel.isVisible) {
    dashboardPanel.update(cachedData, config.sessionResetIntervalMinutes);
  }
}

export function deactivate(): void {
  // Cleanup handled by disposables
}
