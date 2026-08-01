import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { ConfigManager } from '../src/config/configManager';
import { setMockConfig, clearMockConfig } from './__mocks__/vscode';

describe('ConfigManager', () => {
  let configManager: ConfigManager;

  beforeEach(() => {
    clearMockConfig();
    configManager = new ConfigManager();
  });

  afterEach(() => {
    configManager.dispose();
  });

  it('should return default config values when no custom values are set', () => {
    const config = configManager.getConfig();

    expect(config.statusBar.showResetTimer).toBe(true);
    expect(config.statusBar.showTokenCount).toBe(false);
    expect(config.statusBar.showSessionCount).toBe(false);
    expect(config.statusBar.showModel).toBe(true);
    expect(config.statusBar.showEffort).toBe(true);
    expect(config.sessionResetIntervalMinutes).toBe(300);
    expect(config.sessionTokenLimit).toBe(8_000_000);
    expect(config.pollingIntervalSeconds).toBe(30);
    expect(config.usageRefreshIntervalSeconds).toBe(3600);
    expect(config.notifications.enabled).toBe(false);
    expect(config.notifications.useSystemNotifications).toBe(false);
    expect(config.notifications.onNewSession).toBe(true);
    expect(config.notifications.onSessionEnd).toBe(true);
    expect(config.notifications.onResetTimerComplete).toBe(true);
    expect(config.notifications.onTaskComplete).toBe(true);
    expect(config.notifications.onApiRefresh).toBe(true);
    expect(config.claudeHomePath).toBe(path.join(os.homedir(), '.claude'));
  });

  it('should respect notifications.onApiRefresh when disabled', () => {
    setMockConfig({ 'notifications.onApiRefresh': false });

    const config = configManager.getConfig();

    expect(config.notifications.onApiRefresh).toBe(false);
  });

  it('should return custom values when overrides are set', () => {
    setMockConfig({
      'statusBar.showResetTimer': false,
      'statusBar.showTokenCount': true,
      'statusBar.showSessionCount': true,
      'statusBar.showModel': false,
      'statusBar.showEffort': false,
      sessionResetIntervalMinutes: 600,
      sessionTokenLimit: 4_000_000,
      pollingIntervalSeconds: 15,
      usageRefreshIntervalSeconds: 120,
    });

    const config = configManager.getConfig();

    expect(config.statusBar.showResetTimer).toBe(false);
    expect(config.statusBar.showTokenCount).toBe(true);
    expect(config.statusBar.showSessionCount).toBe(true);
    expect(config.statusBar.showModel).toBe(false);
    expect(config.statusBar.showEffort).toBe(false);
    expect(config.sessionResetIntervalMinutes).toBe(600);
    expect(config.sessionTokenLimit).toBe(4_000_000);
    expect(config.pollingIntervalSeconds).toBe(15);
    expect(config.usageRefreshIntervalSeconds).toBe(120);
  });

  it('should clamp usageRefreshIntervalSeconds to a minimum of 60', () => {
    setMockConfig({ usageRefreshIntervalSeconds: 10 });

    const config = configManager.getConfig();

    expect(config.usageRefreshIntervalSeconds).toBe(60);
  });

  it('should default claudeHomePath to ~/.claude when set to empty string', () => {
    setMockConfig({ claudeHomePath: '' });

    const config = configManager.getConfig();

    expect(config.claudeHomePath).toBe(path.join(os.homedir(), '.claude'));
  });

  it('should use custom claudeHomePath when provided', () => {
    setMockConfig({ claudeHomePath: '/custom/claude/path' });

    const config = configManager.getConfig();

    expect(config.claudeHomePath).toBe('/custom/claude/path');
  });

  it('should dispose without error', () => {
    expect(() => configManager.dispose()).not.toThrow();
  });
});
