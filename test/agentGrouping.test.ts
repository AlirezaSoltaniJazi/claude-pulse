import { describe, it, expect } from 'vitest';
import { flattenAgents, groupAgentsByType } from '../src/utils/agentGrouping';
import { AgentGraph, AgentNode, AgentStatus, SessionNode } from '../src/types';

const node = (o: Partial<AgentNode> = {}): AgentNode => ({
  id: 'a',
  description: 'task',
  agentType: 'general-purpose',
  spawnDepth: 1,
  parentAgentId: null,
  tokens: 0,
  durationMs: null,
  turns: 1,
  model: 'claude-sonnet-5',
  status: 'completed' as AgentStatus,
  lastActivityAt: 0,
  children: [],
  subtreeTokens: 0,
  ...o,
});

const session = (o: Partial<SessionNode> = {}): SessionNode => ({
  sessionId: 'sess-a',
  pid: 100,
  cwd: '/Users/dev/a',
  label: 'a',
  startedAt: 1000,
  isAlive: true,
  entrypoint: 'cli',
  isPrimary: false,
  model: null,
  agents: [],
  agentCount: 0,
  totalTokens: 0,
  lastActivityAt: 0,
  truncated: false,
  ...o,
});

const graph = (sessions: SessionNode[]): AgentGraph => ({
  sessions,
  generatedAt: 0,
  truncated: false,
});

describe('flattenAgents', () => {
  it('returns parents before children, depth first', () => {
    const tree = [
      node({ id: 'p', children: [node({ id: 'c', children: [node({ id: 'g' })] })] }),
      node({ id: 'q' }),
    ];

    expect(flattenAgents(tree).map((a) => a.id)).toEqual(['p', 'c', 'g', 'q']);
  });

  it('returns nothing for an empty tree', () => {
    expect(flattenAgents([])).toEqual([]);
  });
});

describe('groupAgentsByType', () => {
  it('returns nothing for a null graph', () => {
    expect(groupAgentsByType(null)).toEqual([]);
  });

  it('skips sessions that ran no agents', () => {
    // They belong to no agent type. The session-first tab is what keeps them reachable.
    expect(groupAgentsByType(graph([session()]))).toEqual([]);
  });

  it('groups one type across several sessions', () => {
    const a = session({
      sessionId: 'sess-a',
      agents: [node({ id: 'a1', tokens: 10 }), node({ id: 'a2', tokens: 5 })],
    });
    const b = session({ sessionId: 'sess-b', agents: [node({ id: 'b1', tokens: 20 })] });

    const groups = groupAgentsByType(graph([a, b]));

    expect(groups).toHaveLength(1);
    expect(groups[0].agentType).toBe('general-purpose');
    expect(groups[0].count).toBe(3);
    expect(groups[0].totalTokens).toBe(35);
    expect(groups[0].sessions).toHaveLength(2);
  });

  it('splits the same session across the types it ran', () => {
    const s = session({
      agents: [
        node({ id: 'a', agentType: 'Explore', tokens: 10 }),
        node({ id: 'b', agentType: 'general-purpose', tokens: 20 }),
      ],
    });

    const groups = groupAgentsByType(graph([s]));

    expect(groups.map((g) => g.agentType).sort()).toEqual(['Explore', 'general-purpose']);
    expect(groups.every((g) => g.count === 1)).toBe(true);
  });

  it('flattens nested agents into their own type, not their parent’s', () => {
    // A general-purpose agent that spawned an Explore agent: the child belongs under
    // Explore, which is a different tab, and must not be swallowed by the parent's group.
    const s = session({
      agents: [
        node({
          id: 'parent',
          agentType: 'general-purpose',
          tokens: 100,
          children: [
            node({ id: 'child', agentType: 'Explore', parentAgentId: 'parent', tokens: 40 }),
          ],
        }),
      ],
    });

    const groups = groupAgentsByType(graph([s]));
    const explore = groups.find((g) => g.agentType === 'Explore');
    const general = groups.find((g) => g.agentType === 'general-purpose');

    expect(explore?.count).toBe(1);
    expect(general?.count).toBe(1);
    expect(explore?.totalTokens).toBe(40);
  });

  it('names the spawning agent even when it sits under another type', () => {
    const s = session({
      agents: [
        node({
          id: 'parent',
          description: 'Orchestrate the review',
          children: [node({ id: 'child', agentType: 'Explore', parentAgentId: 'parent' })],
        }),
      ],
    });

    const explore = groupAgentsByType(graph([s])).find((g) => g.agentType === 'Explore');

    expect(explore?.sessions[0].instances[0].parentDescription).toBe('Orchestrate the review');
  });

  it('leaves parentDescription null for an agent the main thread spawned', () => {
    const s = session({ agents: [node({ id: 'a' })] });

    expect(groupAgentsByType(graph([s]))[0].sessions[0].instances[0].parentDescription).toBeNull();
  });

  it('leaves parentDescription null when the parent is not in the scan', () => {
    const s = session({ agents: [node({ id: 'a', parentAgentId: 'truncated-away' })] });

    expect(groupAgentsByType(graph([s]))[0].sessions[0].instances[0].parentDescription).toBeNull();
  });

  it('counts running agents per session and per type', () => {
    const a = session({
      sessionId: 'sess-a',
      agents: [node({ id: 'a1', status: 'running' }), node({ id: 'a2', status: 'completed' })],
    });
    const b = session({ sessionId: 'sess-b', agents: [node({ id: 'b1', status: 'running' })] });

    const group = groupAgentsByType(graph([a, b]))[0];

    expect(group.runningCount).toBe(2);
    expect(group.sessions.reduce((sum, s) => sum + s.runningCount, 0)).toBe(2);
  });

  it('puts running agents before costlier finished ones', () => {
    // The Stop button must not sit below a screenful of completed runs.
    const s = session({
      agents: [
        node({ id: 'done', tokens: 500, status: 'completed' }),
        node({ id: 'live', tokens: 1, status: 'running' }),
      ],
    });

    const instances = groupAgentsByType(graph([s]))[0].sessions[0].instances;

    expect(instances.map((i) => i.agent.id)).toEqual(['live', 'done']);
  });

  it('orders types with something running ahead of costlier idle ones', () => {
    const s = session({
      agents: [
        node({ id: 'a', agentType: 'expensive-idle', tokens: 1_000_000 }),
        node({ id: 'b', agentType: 'cheap-live', tokens: 1, status: 'running' }),
      ],
    });

    expect(groupAgentsByType(graph([s])).map((g) => g.agentType)).toEqual([
      'cheap-live',
      'expensive-idle',
    ]);
  });

  it('orders live sessions ahead of exited ones within a type', () => {
    const dead = session({ sessionId: 'dead', isAlive: false, agents: [node({ tokens: 999 })] });
    const live = session({ sessionId: 'live', isAlive: true, agents: [node({ tokens: 1 })] });

    const group = groupAgentsByType(graph([dead, live]))[0];

    expect(group.sessions.map((s) => s.session.sessionId)).toEqual(['live', 'dead']);
  });
});
