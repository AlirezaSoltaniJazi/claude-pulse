import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { DashboardPanel } from '../src/ui/webviewPanel';
import { AgentGraph, AgentNode, ClaudePulseData, SessionNode } from '../src/types';

const makeAgent = (): AgentNode => ({
  id: 'agent-a',
  description: 'do a thing',
  agentType: 'general-purpose',
  spawnDepth: 1,
  parentAgentId: null,
  tokens: 1000,
  durationMs: 2000,
  turns: 4,
  model: 'claude-sonnet-5',
  status: 'completed',
  lastActivityAt: 0,
  children: [],
  subtreeTokens: 1000,
});

const makeSession = (sessionId: string): SessionNode => ({
  sessionId,
  pid: 4242,
  cwd: '/Users/dev/project',
  label: sessionId,
  startedAt: Date.now() - 60_000,
  isAlive: true,
  entrypoint: 'claude-vscode',
  isPrimary: false,
  model: null,
  agents: [makeAgent()],
  agentCount: 1,
  totalTokens: 1000,
  lastActivityAt: 0,
  truncated: false,
});

const makeData = (sessions: SessionNode[]): ClaudePulseData => ({
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
  agentGraph: { sessions, generatedAt: Date.now(), truncated: false } satisfies AgentGraph,
});

type MessageHandler = (message: unknown) => void;

function mountPanel(): {
  panel: DashboardPanel;
  send: MessageHandler;
  html: () => string;
} {
  const handlers: MessageHandler[] = [];
  const stub = {
    webview: {
      html: '',
      onDidReceiveMessage: (cb: MessageHandler) => {
        handlers.push(cb);
      },
    },
    reveal: vi.fn(),
    dispose: vi.fn(),
    onDidDispose: vi.fn(),
  };
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(stub as never);

  return {
    panel: new DashboardPanel(),
    send: (message) => handlers.forEach((cb) => cb(message)),
    html: () => stub.webview.html,
  };
}

describe('DashboardPanel — remembered session expansion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps a session open across the re-render the next poll causes', () => {
    const { panel, send, html } = mountPanel();
    const data = makeData([makeSession('s1')]);

    panel.show(data, 300);
    expect(html()).toContain('<div class="tree is-collapsed" data-session-tree="s1"');

    send({ command: 'setSessionExpanded', sessionIds: ['s1'], expanded: true });
    panel.update(data, 300);
    expect(html()).toContain('<div class="tree" data-session-tree="s1"');
  });

  it('folds a session again when the collapse message names it', () => {
    const { panel, send, html } = mountPanel();
    const data = makeData([makeSession('s1'), makeSession('s2')]);

    panel.show(data, 300);
    send({ command: 'setSessionExpanded', sessionIds: ['s1', 's2'], expanded: true });
    send({ command: 'setSessionExpanded', sessionIds: ['s1'], expanded: false });
    panel.update(data, 300);

    expect(html()).toContain('<div class="tree is-collapsed" data-session-tree="s1"');
    expect(html()).toContain('<div class="tree" data-session-tree="s2"');
  });

  it('does not let a session id outlive the session it names', () => {
    const { panel, send, html } = mountPanel();

    panel.show(makeData([makeSession('s1')]), 300);
    send({ command: 'setSessionExpanded', sessionIds: ['s1'], expanded: true });

    // s1 ends and drops out of the graph…
    panel.update(makeData([makeSession('s2')]), 300);
    // …and a session reusing that id later comes back folded, not silently open.
    panel.update(makeData([makeSession('s1')]), 300);
    expect(html()).toContain('<div class="tree is-collapsed" data-session-tree="s1"');
  });

  it('ignores a malformed expansion message rather than storing junk', () => {
    const { panel, send, html } = mountPanel();
    const data = makeData([makeSession('s1')]);

    panel.show(data, 300);
    send({ command: 'setSessionExpanded', sessionIds: 's1', expanded: true });
    send({ command: 'setSessionExpanded', sessionIds: [42, null, ''], expanded: true });
    send({ command: 'setSessionExpanded', expanded: true });
    panel.update(data, 300);

    expect(html()).toContain('<div class="tree is-collapsed" data-session-tree="s1"');
  });
});
