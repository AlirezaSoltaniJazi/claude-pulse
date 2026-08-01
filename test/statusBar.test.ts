import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { StatusBar } from '../src/ui/statusBar';
import { ClaudePulseConfig } from '../src/config/configManager';
import { ModelInfo } from '../src/types';

const makeConfig = (
  statusBar: Partial<ClaudePulseConfig['statusBar']> = {}
): ClaudePulseConfig => ({
  statusBar: {
    showResetTimer: false,
    showTokenCount: false,
    showSessionCount: false,
    showModel: true,
    showEffort: true,
    ...statusBar,
  },
  sessionResetIntervalMinutes: 300,
  sessionTokenLimit: 8_000_000,
  pollingIntervalSeconds: 30,
  usageRefreshIntervalSeconds: 3600,
  notifications: {
    enabled: false,
    useSystemNotifications: false,
    onNewSession: true,
    onSessionEnd: true,
    onResetTimerComplete: true,
    onTaskComplete: true,
    onApiRefresh: true,
  },
  taskCompletionIdleSeconds: 10,
  claudeHomePath: '/fake/.claude',
});

const makeModelInfo = (overrides: Partial<ModelInfo> = {}): ModelInfo => ({
  model: 'claude-opus-5',
  modelSource: 'transcript',
  effort: 'xhigh',
  effortSource: 'transcript',
  isSessionLive: true,
  ...overrides,
});

describe('StatusBar model and effort segment', () => {
  let statusBar: StatusBar;

  /** The mock returns a fresh copy per call, so read the item the class actually holds. */
  const item = (): { text: string; tooltip: string } =>
    vi.mocked(vscode.window.createStatusBarItem).mock.results[0].value;

  beforeEach(() => {
    vi.mocked(vscode.window.createStatusBarItem).mockClear();
    statusBar = new StatusBar();
  });

  afterEach(() => {
    // The constructor starts a 1s interval — leaving it running hangs the test run.
    statusBar.dispose();
  });

  it('renders model and effort as one combined segment', () => {
    statusBar.update(makeConfig(), null, null, null, makeModelInfo());

    expect(item().text).toBe('$(pulse) $(sparkle) Opus 5 · xhigh');
  });

  it('puts the raw model id and effort in the tooltip', () => {
    statusBar.update(makeConfig(), null, null, null, makeModelInfo());

    expect(item().tooltip).toBe('Model: claude-opus-5 | Effort: xhigh');
  });

  it('marks a settings-sourced effort as the global setting in the tooltip', () => {
    statusBar.update(
      makeConfig(),
      null,
      null,
      null,
      makeModelInfo({ effort: 'high', effortSource: 'settings' })
    );

    expect(item().tooltip).toBe('Model: claude-opus-5 | Effort: high (global setting)');
  });

  it('does not mark a settings-sourced effort with ~ on a live session', () => {
    // effortSource 'settings' is the norm for any record predating the per-turn field —
    // marking it would change the bar for users who never switched anything.
    statusBar.update(
      makeConfig(),
      null,
      null,
      null,
      makeModelInfo({ effort: 'high', effortSource: 'settings' })
    );

    expect(item().text).toBe('$(pulse) $(sparkle) Opus 5 · high');
  });

  it('omits the model half when showModel is false', () => {
    statusBar.update(makeConfig({ showModel: false }), null, null, null, makeModelInfo());

    expect(item().text).toBe('$(pulse) $(sparkle) xhigh');
    expect(item().tooltip).toBe('Effort: xhigh');
  });

  it('omits the effort half when showEffort is false', () => {
    statusBar.update(makeConfig({ showEffort: false }), null, null, null, makeModelInfo());

    expect(item().text).toBe('$(pulse) $(sparkle) Opus 5');
  });

  it('renders nothing extra when both toggles are off', () => {
    statusBar.update(
      makeConfig({ showModel: false, showEffort: false }),
      null,
      null,
      null,
      makeModelInfo()
    );

    expect(item().text).toBe('$(pulse)');
  });

  it('renders nothing extra when modelInfo is null', () => {
    statusBar.update(makeConfig(), null, null, null, null);

    expect(item().text).toBe('$(pulse)');
  });

  it('renders effort alone when the model is unknown', () => {
    statusBar.update(makeConfig(), null, null, null, makeModelInfo({ model: null }));

    expect(item().text).toBe('$(pulse) $(sparkle) xhigh');
  });

  it('renders the model alone when the effort is unknown', () => {
    statusBar.update(
      makeConfig(),
      null,
      null,
      null,
      makeModelInfo({ effort: null, effortSource: null })
    );

    expect(item().text).toBe('$(pulse) $(sparkle) Opus 5');
  });

  it('prefixes ~ when the session is no longer live', () => {
    statusBar.update(makeConfig(), null, null, null, makeModelInfo({ isSessionLive: false }));

    expect(item().text).toBe('$(pulse) $(sparkle) ~Opus 5 · xhigh');
  });

  it('prefixes ~ for an unconfirmed global model selection', () => {
    statusBar.update(
      makeConfig(),
      null,
      null,
      null,
      makeModelInfo({ model: 'claude-fable-5[1m]', modelSource: 'settings' })
    );

    expect(item().text).toBe('$(pulse) $(sparkle) ~Fable 5 · xhigh');
    expect(item().tooltip).toContain('(latest /model selection, unconfirmed)');
  });

  it('renders a bare alias selection without losing the segment', () => {
    statusBar.update(
      makeConfig(),
      null,
      null,
      null,
      makeModelInfo({ model: 'opus[1m]', modelSource: 'settings' })
    );

    expect(item().text).toBe('$(pulse) $(sparkle) ~Opus · xhigh');
  });

  it('leaves transcript- and command-sourced models unmarked', () => {
    for (const modelSource of ['transcript', 'command'] as const) {
      statusBar.update(makeConfig(), null, null, null, makeModelInfo({ modelSource }));

      expect(item().text).toBe('$(pulse) $(sparkle) Opus 5 · xhigh');
      expect(item().tooltip).toBe('Model: claude-opus-5 | Effort: xhigh');
    }
  });

  it('omits the ~ entirely when showModel hides an unconfirmed selection', () => {
    // No model on screen means nothing to qualify — a stray ~ on the effort would be noise.
    statusBar.update(
      makeConfig({ showModel: false }),
      null,
      null,
      null,
      makeModelInfo({ model: 'claude-fable-5[1m]', modelSource: 'settings' })
    );

    expect(item().text).toBe('$(pulse) $(sparkle) xhigh');
  });

  it('clears a previously rendered segment when modelInfo becomes null', () => {
    statusBar.update(makeConfig(), null, null, null, makeModelInfo());
    statusBar.update(makeConfig(), null, null, null, null);

    expect(item().text).toBe('$(pulse)');
  });

  it('never produces a double space in the rendered text', () => {
    for (const info of [
      null,
      makeModelInfo({ model: null }),
      makeModelInfo({ effort: null, effortSource: null }),
      makeModelInfo({ model: null, effort: null, effortSource: null }),
      makeModelInfo(),
    ]) {
      statusBar.update(makeConfig(), null, null, null, info);
      expect(item().text).not.toMatch(/ {2}/);
    }
  });
});
