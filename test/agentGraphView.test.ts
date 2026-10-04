import { describe, it, expect } from 'vitest';
import { generateDashboardHtml, summariseAgentTypes } from '../src/ui/webviewContent';
import { AgentGraph, AgentNode, ClaudePulseData, SessionNode } from '../src/types';

const makeAgent = (overrides: Partial<AgentNode> = {}): AgentNode => ({
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
  ...overrides,
});

const makeSession = (overrides: Partial<SessionNode> = {}): SessionNode => {
  const agents = overrides.agents ?? [];
  return {
    sessionId: 'sess-1',
    pid: 4242,
    cwd: '/Users/dev/project',
    label: 'project-1',
    startedAt: Date.now() - 60_000,
    isAlive: true,
    entrypoint: 'claude-vscode',
    isPrimary: false,
    model: null,
    agentCount: agents.length,
    totalTokens: agents.reduce((sum, a) => sum + a.subtreeTokens, 0),
    lastActivityAt: 0,
    truncated: false,
    ...overrides,
    agents,
  };
};

const makeData = (graph: AgentGraph): ClaudePulseData => ({
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
  agentGraph: graph,
});

const makeGraph = (sessions: SessionNode[]): AgentGraph => ({
  sessions,
  generatedAt: Date.now(),
  truncated: false,
});

function render(sessions: SessionNode[], expandedSessions: string[] = []): string {
  return generateDashboardHtml(makeData(makeGraph(sessions)), 300, {
    activeAgentTab: null,
    expandedSessions,
  });
}

describe('summariseAgentTypes', () => {
  it('counts every agent in the tree, including nested ones', () => {
    const summary = summariseAgentTypes([
      makeAgent({ agentType: 'general-purpose', children: [makeAgent({ agentType: 'Explore' })] }),
      makeAgent({ agentType: 'general-purpose' }),
    ]);
    expect(summary).toEqual([
      { type: 'general-purpose', count: 2 },
      { type: 'Explore', count: 1 },
    ]);
  });

  it('orders by count, then by name for a tie', () => {
    const summary = summariseAgentTypes([
      makeAgent({ agentType: 'zebra' }),
      makeAgent({ agentType: 'alpha' }),
      makeAgent({ agentType: 'many' }),
      makeAgent({ agentType: 'many' }),
    ]);
    expect(summary.map((s) => s.type)).toEqual(['many', 'alpha', 'zebra']);
  });

  it('returns nothing for a session that spawned nothing', () => {
    expect(summariseAgentTypes([])).toEqual([]);
  });
});

describe('agent graph disclosure', () => {
  it('folds a session with subagents by default', () => {
    const html = render([makeSession({ agents: [makeAgent()] })]);
    expect(html).toContain('data-session-tree="sess-1"');
    expect(html).toContain('class="tree is-collapsed"');
    expect(html).toContain('aria-expanded="false"');
    // The subagent is still in the DOM, just hidden — that is what makes opening instant.
    expect(html).toContain('do a thing');
  });

  it('opens exactly the sessions named in the view state', () => {
    const html = render(
      [
        makeSession({ sessionId: 'sess-1', agents: [makeAgent()] }),
        makeSession({ sessionId: 'sess-2', label: 'other', agents: [makeAgent()] }),
      ],
      ['sess-2']
    );
    expect(html).toContain('<div class="tree is-collapsed" data-session-tree="sess-1"');
    expect(html).toContain('<div class="tree" data-session-tree="sess-2"');
    expect(html).toContain('aria-expanded="true"');
  });

  it('gives a childless session no disclosure at all', () => {
    const html = render([makeSession({ sessionId: 'empty', agents: [] })]);
    expect(html).not.toContain('data-session-tree="empty"');
    expect(html).toContain('no subagents');
    expect(html).toContain('node-caret-empty');
  });

  it('summarises what is inside a folded session', () => {
    const html = render([
      makeSession({
        agents: [
          makeAgent({ agentType: 'general-purpose', status: 'running' }),
          makeAgent({ agentType: 'general-purpose' }),
          makeAgent({ agentType: 'Explore' }),
        ],
      }),
    ]);
    expect(html).toContain('3 agents');
    expect(html).toContain('1 running');
    expect(html).toContain('node-chip');
    expect(html).toContain('general-purpose<i class="node-chip-count">2</i>');
  });

  it('caps the type chips and counts the rest', () => {
    const html = render([
      makeSession({
        agents: ['a', 'b', 'c', 'd', 'e'].map((t) => makeAgent({ agentType: t })),
      }),
    ]);
    expect(html).toContain('+2 types');
  });

  it('offers bulk controls and escapes a session id into the toggle attribute', () => {
    const html = render([makeSession({ sessionId: 'a"b&c', agents: [makeAgent()] })]);
    expect(html).toContain('data-bulk="expand"');
    expect(html).toContain('data-bulk="collapse"');
    expect(html).toContain('data-session-tree="a&quot;b&amp;c"');
  });
});
