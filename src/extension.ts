import * as vscode from 'vscode';
import { ConfigManager } from './config/configManager';
import { readStats, readUsageFromCache } from './data/statsReader';
import { readSessions, getActiveSessions, getMostRecentSession } from './data/sessionReader';
import { getTodayActivity } from './data/dataAggregator';
import { scanWeeklyUsage, clearScanCache } from './data/jsonlScanner';
import { fetchUsage, clearUsageCache, FetchUsageResult } from './data/usageApi';
import { FileWatcher } from './data/fileWatcher';
import { StatusBar } from './ui/statusBar';
import { DashboardPanel } from './ui/webviewPanel';
import { SessionMonitor } from './notifications/sessionMonitor';
import { NotificationManager } from './notifications/notificationManager';
import { ClaudePulseData } from './types';

let configManager: ConfigManager;
let fileWatcher: FileWatcher;
let statusBar: StatusBar;
let dashboardPanel: DashboardPanel;
let sessionMonitor: SessionMonitor;
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
  notificationManager = new NotificationManager(config, sessionMonitor);

  // Initial data load (file-based first, then API in background)
  refreshData(false);
  refreshUsageData(true);

  // Periodic usage API refresh (with feedback)
  startUsageRefreshInterval(config.usageRefreshIntervalSeconds);

  // Wire file watcher events — stats changes include usage data from cache file
  fileWatcher.onStatsChanged(() => refreshData(false));
  fileWatcher.onSessionsChanged(() => refreshData(false));

  // Wire config changes
  configManager.onConfigChanged((newConfig) => {
    fileWatcher.updatePollingInterval(newConfig.pollingIntervalSeconds * 1000);
    startUsageRefreshInterval(newConfig.usageRefreshIntervalSeconds);
    notificationManager.updateConfig(newConfig);
    updateUI();
  });

  // Wire dashboard events
  dashboardPanel.onResetTimer(() => {
    statusBar.resetTimer();
  });
  dashboardPanel.onRefreshData(async () => {
    clearScanCache();
    clearUsageCache();
    await Promise.all([refreshData(false), refreshUsageData(true)]);
  });

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('claudePulse.showDashboard', async () => {
      const config = configManager.getConfig();
      // Show immediately with cached data, then refresh
      dashboardPanel.show(cachedData, config.sessionResetIntervalMinutes);
      // Fetch fresh data in background and update
      clearUsageCache();
      await refreshUsageData();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudePulse.refreshData', async () => {
      clearScanCache();
      clearUsageCache();
      await Promise.all([refreshData(false), refreshUsageData(true)]);
    })
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
    notificationManager,
    { dispose: () => { if (usageRefreshInterval) clearInterval(usageRefreshInterval); } }
  );
}

function startUsageRefreshInterval(intervalSeconds: number): void {
  if (usageRefreshInterval) {
    clearInterval(usageRefreshInterval);
  }
  const intervalMs = Math.max(intervalSeconds, 60) * 1000;
  usageRefreshInterval = setInterval(() => refreshUsageData(true), intervalMs);
}

async function refreshData(alsoRefreshUsage: boolean = false): Promise<void> {
  const config = configManager.getConfig();

  const [stats, sessions] = await Promise.all([
    readStats(config.claudeHomePath),
    readSessions(config.claudeHomePath),
  ]);

  const activeSessions = getActiveSessions(sessions);
  const mostRecentSession = getMostRecentSession(activeSessions.length > 0 ? activeSessions : sessions);

  // Read usage from stats-cache file (written by Claude Code itself)
  const fileUsage = await readUsageFromCache(config.claudeHomePath);

  cachedData = {
    ...cachedData,
    stats,
    sessions,
    activeSessions,
    mostRecentSession,
    weeklyUsage: await scanWeeklyUsage(config.claudeHomePath),
    todayActivity: stats ? getTodayActivity(stats) : null,
    usage: fileUsage ?? cachedData.usage,
  };

  // Update session monitor
  sessionMonitor.updateSessions(sessions);

  // Check reset timer for notifications
  notificationManager.checkResetTimer(
    mostRecentSession,
    mostRecentSession?.startedAt ?? null
  );

  updateUI();

  if (alsoRefreshUsage) {
    await refreshUsageData();
  }
}

async function refreshUsageData(showFeedback: boolean = false): Promise<FetchUsageResult | null> {
  try {
    const result = await fetchUsage();
    if (result.data) {
      cachedData = { ...cachedData, usage: result.data };
      updateUI();
    }
    if (showFeedback) {
      showRefreshFeedback(result);
    }
    return result;
  } catch {
    return null;
  }
}

function showRefreshFeedback(result: FetchUsageResult): void {
  switch (result.status) {
    case 'success':
      vscode.window.showInformationMessage('Claude Pulse: Data refreshed successfully');
      break;
    case 'rate_limited':
      vscode.window.showWarningMessage('Claude Pulse: API rate limited — showing cached data. Will retry automatically.');
      break;
    case 'auth_error':
      vscode.window.showErrorMessage('Claude Pulse: OAuth token expired or invalid. Try reopening your terminal.');
      break;
    case 'no_credentials':
      vscode.window.showErrorMessage('Claude Pulse: No OAuth credentials found. Make sure Claude Code is logged in.');
      break;
    case 'error':
      vscode.window.showWarningMessage(`Claude Pulse: ${result.message}`);
      break;
    case 'cached':
      vscode.window.showInformationMessage('Claude Pulse: Data refreshed (from cache)');
      break;
  }
}

function updateUI(): void {
  const config = configManager.getConfig();

  const activeSession = cachedData.activeSessions.length > 0
    ? cachedData.activeSessions[0]
    : cachedData.mostRecentSession;

  statusBar.update(
    config,
    activeSession,
    cachedData.todayActivity,
    cachedData.usage
  );

  if (dashboardPanel.isVisible) {
    dashboardPanel.update(cachedData, config.sessionResetIntervalMinutes);
  }
}

export function deactivate(): void {
  // Cleanup handled by disposables
}
