import * as vscode from 'vscode';
import { ConfigManager } from './config/configManager';
import { readStats } from './data/statsReader';
import { readSessions, getActiveSessions, getMostRecentSession } from './data/sessionReader';
import { getWeeklyUsage, getTodayActivity } from './data/dataAggregator';
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

let cachedData: ClaudePulseData = {
  stats: null,
  sessions: [],
  activeSessions: [],
  mostRecentSession: null,
  weeklyUsage: null,
  todayActivity: null,
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

  // Initial data load
  refreshData();

  // Wire file watcher events
  fileWatcher.onStatsChanged(() => refreshData());
  fileWatcher.onSessionsChanged(() => refreshData());

  // Wire config changes
  configManager.onConfigChanged((newConfig) => {
    fileWatcher.updatePollingInterval(newConfig.pollingIntervalSeconds * 1000);
    notificationManager.updateConfig(newConfig);
    updateUI();
  });

  // Wire dashboard reset timer
  dashboardPanel.onResetTimer(() => {
    statusBar.resetTimer();
  });

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('claudePulse.showDashboard', () => {
      const config = configManager.getConfig();
      dashboardPanel.show(cachedData, config.sessionResetIntervalMinutes);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudePulse.refreshData', () => {
      refreshData();
      vscode.window.showInformationMessage('Claude Pulse: Data refreshed');
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
    notificationManager
  );
}

async function refreshData(): Promise<void> {
  const config = configManager.getConfig();

  const [stats, sessions] = await Promise.all([
    readStats(config.claudeHomePath),
    readSessions(config.claudeHomePath),
  ]);

  const activeSessions = getActiveSessions(sessions);
  const mostRecentSession = getMostRecentSession(activeSessions.length > 0 ? activeSessions : sessions);

  cachedData = {
    stats,
    sessions,
    activeSessions,
    mostRecentSession,
    weeklyUsage: stats ? getWeeklyUsage(stats) : null,
    todayActivity: stats ? getTodayActivity(stats) : null,
  };

  // Update session monitor
  sessionMonitor.updateSessions(sessions);

  // Check reset timer for notifications
  notificationManager.checkResetTimer(
    mostRecentSession,
    mostRecentSession?.startedAt ?? null
  );

  updateUI();
}

function updateUI(): void {
  const config = configManager.getConfig();

  statusBar.update(
    config,
    cachedData.activeSessions.length > 0 ? cachedData.activeSessions[0] : cachedData.mostRecentSession,
    cachedData.todayActivity
  );

  if (dashboardPanel.isVisible) {
    dashboardPanel.update(cachedData, config.sessionResetIntervalMinutes);
  }
}

export function deactivate(): void {
  // Cleanup handled by disposables
}
