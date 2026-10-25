import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { generateDashboardHtml } from '../src/ui/webviewContent';
import { DashboardPanel } from '../src/ui/webviewPanel';
import { ClaudePulseData, LoopInfo, LoopScan } from '../src/types';

const makeLoop = (overrides: Partial<LoopInfo> = {}): LoopInfo => ({
  id: 'abc12345',
  kind: 'cron',
  prompt: 'check CI',
  cron: '*/5 * * * *',
  recurring: true,
  delaySeconds: null,
  reason: null,
  createdAt: Date.now() - 60 * 60_000,
  runCount: 3,
  lastRunAt: Date.now() - 5 * 60_000,
  nextRunAt: Date.now() + 4 * 60_000,
  expiresAt: Date.now() + 6 * 24 * 60 * 60_000,
  status: 'active',
  ...overrides,
});

const makeScan = (loops: LoopInfo[]): LoopScan => ({
  sessions: [
    {
      sessionId: 'sess-1234567890',
      pid: 4242,
      cwd: '/Users/dev/project',
      label: 'project',
      isAlive: true,
      loops,
    },
  ],
  activeCount: loops.filter((l) => l.status === 'active').length,
  totalCount: loops.length,
  generatedAt: Date.now(),
});

const makeData = (loops: LoopScan | null): ClaudePulseData => ({
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
  loops,
});

describe('Loops section', () => {
  it('sits right after Usage and offers only a button before the first scan', () => {
    const html = generateDashboardHtml(makeData(null), 300);

    const usage = html.indexOf('data-section="usage"');
    const loops = html.indexOf('data-section="loops"');
    const sessions = html.indexOf('data-section="sessions"');
    expect(usage).toBeLessThan(loops);
    expect(loops).toBeLessThan(sessions);

    expect(html).toContain('<button class="refresh-btn" data-scan-loops>Show loops</button>');
    expect(html).not.toContain('<table class="loop-table">');
  });

  it('lists each loop under its session once scanned', () => {
    const html = generateDashboardHtml(makeData(makeScan([makeLoop()])), 300);

    expect(html).toContain('data-scan-loops>Refresh loops</button>');
    expect(html).toContain('1 active of 1');
    expect(html).toContain('project');
    expect(html).toContain('PID 4242');
    expect(html).toContain('every 5 min');
    expect(html).toContain('id abc12345');
    expect(html).toContain('loop-status-active');
  });

  it('says so when the scan found nothing', () => {
    const html = generateDashboardHtml(makeData(makeScan([])), 300);
    expect(html).toContain('No session has scheduled a loop');
  });

  it('escapes model-authored prompts and reasons', () => {
    const html = generateDashboardHtml(
      makeData(
        makeScan([
          makeLoop({
            kind: 'dynamic',
            cron: null,
            prompt: '<img src=x onerror=alert(1)>',
            reason: '"><script>x</script>',
            delaySeconds: 600,
          }),
        ])
      ),
      300
    );
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('self-paced, last 10m');
  });
});

describe('DashboardPanel — loop scan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fires onScanLoops when the button posts scanLoops', () => {
    let handler: ((message: unknown) => void) | null = null;
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue({
      webview: {
        html: '',
        onDidReceiveMessage: (cb: (message: unknown) => void) => {
          handler = cb;
        },
      },
      reveal: vi.fn(),
      dispose: vi.fn(),
      onDidDispose: vi.fn(),
    } as never);

    const panel = new DashboardPanel();
    const onScan = vi.fn();
    panel.onScanLoops(onScan);
    panel.show(makeData(null), 300);

    (handler as unknown as (message: unknown) => void)({ command: 'scanLoops' });
    expect(onScan).toHaveBeenCalledTimes(1);
  });
});
