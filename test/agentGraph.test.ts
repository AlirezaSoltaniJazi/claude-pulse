import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildAgentTree,
  deriveAgentStatus,
  readAgentGraph,
  clearAgentCache,
} from '../src/data/agentReader';
import { clearModelCache } from '../src/data/modelReader';
import { AgentInfo, SessionFile } from '../src/types';
import { AGENT_RUNNING_STALE_MS } from '../src/constants';

const makeAgent = (overrides: Partial<AgentInfo> = {}): AgentInfo => ({
  id: 'agent-a',
  description: 'do a thing',
  agentType: 'general-purpose',
  spawnDepth: 1,
  parentAgentId: null,
  tokens: 0,
  durationMs: null,
  turns: 0,
  model: 'claude-sonnet-5',
  status: 'completed',
  lastActivityAt: 0,
  ...overrides,
});

describe('deriveAgentStatus', () => {
  const base = {
    stoppedByUser: false,
    lastStopReason: null as string | null,
    lastActivityAt: 0,
    isSessionAlive: true,
    now: 1_000_000,
  };

  it('reports a user cancellation ahead of everything else', () => {
    // stoppedByUser wins even though the transcript also shows a completed turn.
    expect(deriveAgentStatus({ ...base, stoppedByUser: true, lastStopReason: 'end_turn' })).toBe(
      'stopped'
    );
  });

  it('treats a terminal stop_reason as completed', () => {
    expect(deriveAgentStatus({ ...base, lastStopReason: 'end_turn' })).toBe('completed');
    expect(deriveAgentStatus({ ...base, lastStopReason: 'stop_sequence' })).toBe('completed');
    expect(deriveAgentStatus({ ...base, lastStopReason: 'max_tokens' })).toBe('completed');
  });

  it('does not treat a mid-work stop_reason as completed', () => {
    expect(deriveAgentStatus({ ...base, lastStopReason: 'tool_use' })).toBe('running');
  });

  it('keeps a completed agent completed after its session exits', () => {
    // The alternative — demoting it to orphaned — would rewrite history every time a
    // session closed, and every finished agent on the machine would look abandoned.
    expect(deriveAgentStatus({ ...base, lastStopReason: 'end_turn', isSessionAlive: false })).toBe(
      'completed'
    );
  });

  it('orphans an unfinished agent whose session is gone', () => {
    expect(deriveAgentStatus({ ...base, isSessionAlive: false, lastActivityAt: 999_000 })).toBe(
      'orphaned'
    );
  });

  it('calls a freshly-active agent in a live session running', () => {
    expect(deriveAgentStatus({ ...base, lastActivityAt: base.now - 1000 })).toBe('running');
  });

  it('orphans an agent that has gone quiet past the staleness window', () => {
    expect(
      deriveAgentStatus({ ...base, lastActivityAt: base.now - AGENT_RUNNING_STALE_MS - 1 })
    ).toBe('orphaned');
  });

  it('calls an agent that has written nothing yet running, not stale', () => {
    // lastActivityAt of 0 is the first second of a normal run — the staleness window must
    // not read it as an infinitely old timestamp.
    expect(deriveAgentStatus({ ...base, lastActivityAt: 0 })).toBe('running');
  });
});

describe('buildAgentTree', () => {
  it('returns a flat list as roots when nothing has a parent', () => {
    const roots = buildAgentTree([
      makeAgent({ id: 'a', tokens: 10 }),
      makeAgent({ id: 'b', tokens: 20 }),
    ]);

    expect(roots.map((r) => r.id)).toEqual(['b', 'a']);
    expect(roots.every((r) => r.children.length === 0)).toBe(true);
  });

  it('nests a child under its parent', () => {
    const roots = buildAgentTree([
      makeAgent({ id: 'parent', tokens: 5 }),
      makeAgent({ id: 'child', parentAgentId: 'parent', spawnDepth: 2, tokens: 7 }),
    ]);

    expect(roots).toHaveLength(1);
    expect(roots[0].id).toBe('parent');
    expect(roots[0].children.map((c) => c.id)).toEqual(['child']);
  });

  it('sums a subtree onto the parent while leaving its own tokens alone', () => {
    const roots = buildAgentTree([
      makeAgent({ id: 'parent', tokens: 5 }),
      makeAgent({ id: 'child', parentAgentId: 'parent', tokens: 7 }),
      makeAgent({ id: 'grandchild', parentAgentId: 'child', tokens: 3 }),
    ]);

    expect(roots[0].tokens).toBe(5);
    expect(roots[0].subtreeTokens).toBe(15);
    expect(roots[0].children[0].subtreeTokens).toBe(10);
  });

  it('sorts every level by subtree tokens, not own tokens', () => {
    // 'cheap' spent almost nothing itself but its child spent a fortune, so it outranks
    // 'dear' — which is the ordering someone hunting for spend actually wants.
    const roots = buildAgentTree([
      makeAgent({ id: 'cheap', tokens: 1 }),
      makeAgent({ id: 'expensive-child', parentAgentId: 'cheap', tokens: 500 }),
      makeAgent({ id: 'dear', tokens: 100 }),
    ]);

    expect(roots.map((r) => r.id)).toEqual(['cheap', 'dear']);
  });

  it('promotes a child whose parent is not in the list', () => {
    const roots = buildAgentTree([
      makeAgent({ id: 'orphan', parentAgentId: 'truncated-away', tokens: 9 }),
    ]);

    expect(roots.map((r) => r.id)).toEqual(['orphan']);
    expect(roots[0].subtreeTokens).toBe(9);
  });

  it('promotes an agent that claims itself as its parent', () => {
    const roots = buildAgentTree([makeAgent({ id: 'a', parentAgentId: 'a' })]);

    expect(roots.map((r) => r.id)).toEqual(['a']);
  });

  it('keeps every agent reachable when the parent links form a cycle', () => {
    const roots = buildAgentTree([
      makeAgent({ id: 'a', parentAgentId: 'b', tokens: 1 }),
      makeAgent({ id: 'b', parentAgentId: 'a', tokens: 2 }),
    ]);

    const seen: string[] = [];
    const walk = (nodes: typeof roots): void => {
      for (const node of nodes) {
        seen.push(node.id);
        walk(node.children);
      }
    };
    walk(roots);

    expect(seen.sort()).toEqual(['a', 'b']);
  });

  it('returns nothing for an empty list', () => {
    expect(buildAgentTree([])).toEqual([]);
  });
});

// --- readAgentGraph, against a real directory tree ---

let claudeHome: string;

const assistantRecord = (opts: {
  tokens: number;
  timestamp: string;
  stopReason?: string | null;
}): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp: opts.timestamp,
    message: {
      model: 'claude-sonnet-5',
      stop_reason: opts.stopReason ?? null,
      usage: {
        input_tokens: opts.tokens,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  });

function encode(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

/** Writes the session transcript, which is how the reader locates the project directory. */
function writeSession(session: SessionFile): void {
  const dir = path.join(claudeHome, 'projects', encode(session.cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${session.sessionId}.jsonl`), '');
}

function writeAgent(
  session: SessionFile,
  id: string,
  meta: Record<string, unknown>,
  records: string[]
): void {
  const dir = path.join(
    claudeHome,
    'projects',
    encode(session.cwd),
    session.sessionId,
    'subagents'
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.meta.json`), JSON.stringify(meta));
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), records.join('\n'));
}

const session = (overrides: Partial<SessionFile> = {}): SessionFile => ({
  // pid 1 is launchd: present but not signallable by this process, so isProcessAlive()
  // reports false and the sessions in these tests read as exited.
  pid: 1,
  sessionId: 'sess-1',
  cwd: '/Users/dev/proj',
  startedAt: 1000,
  ...overrides,
});

describe('readAgentGraph', () => {
  beforeEach(() => {
    clearAgentCache();
    clearModelCache();
    claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pulse-graph-'));
  });

  afterEach(() => {
    fs.rmSync(claudeHome, { recursive: true, force: true });
  });

  it('returns null when there are no sessions', async () => {
    expect(await readAgentGraph(claudeHome, [], null, null)).toBeNull();
  });

  it('includes a session that spawned no subagents', async () => {
    // The whole point of the graph is finding stray processes, and a session with an empty
    // context is one — so it must not be filtered out for having no children.
    const s = session();
    writeSession(s);

    const graph = await readAgentGraph(claudeHome, [s], null, null);

    expect(graph?.sessions).toHaveLength(1);
    expect(graph?.sessions[0].agentCount).toBe(0);
    expect(graph?.sessions[0].agents).toEqual([]);
  });

  it('includes a session with no transcript on disk at all', async () => {
    // It still has a PID, which is the half of this view that matters.
    const graph = await readAgentGraph(claudeHome, [session()], null, null);

    expect(graph?.sessions).toHaveLength(1);
    expect(graph?.sessions[0].pid).toBe(1);
  });

  it('builds the agent tree beneath a session with its totals', async () => {
    const s = session();
    writeSession(s);
    writeAgent(s, 'agent-a', { agentType: 'Explore', description: 'look around' }, [
      assistantRecord({ tokens: 100, timestamp: '2026-09-19T10:00:00Z', stopReason: 'end_turn' }),
    ]);
    writeAgent(
      s,
      'agent-b',
      {
        agentType: 'general-purpose',
        description: 'nested',
        parentAgentId: 'agent-a',
        spawnDepth: 2,
      },
      [assistantRecord({ tokens: 40, timestamp: '2026-09-19T10:01:00Z', stopReason: 'end_turn' })]
    );

    const graph = await readAgentGraph(claudeHome, [s], null, null);
    const node = graph?.sessions[0];

    expect(node?.agentCount).toBe(2);
    expect(node?.totalTokens).toBe(140);
    expect(node?.agents).toHaveLength(1);
    expect(node?.agents[0].id).toBe('agent-a');
    expect(node?.agents[0].children.map((c) => c.id)).toEqual(['agent-b']);
    expect(node?.agents[0].subtreeTokens).toBe(140);
    expect(node?.lastActivityAt).toBe(Date.parse('2026-09-19T10:01:00Z'));
  });

  it('marks the primary session and attaches its model to that node only', async () => {
    const a = session({ sessionId: 'sess-a', cwd: '/Users/dev/a' });
    const b = session({ sessionId: 'sess-b', cwd: '/Users/dev/b', startedAt: 2000 });
    writeSession(a);
    writeSession(b);

    const graph = await readAgentGraph(claudeHome, [a, b], 'sess-a', 'claude-opus-5');

    const primary = graph?.sessions.find((s) => s.sessionId === 'sess-a');
    const other = graph?.sessions.find((s) => s.sessionId === 'sess-b');
    expect(primary?.isPrimary).toBe(true);
    expect(primary?.model).toBe('claude-opus-5');
    // The other session's model is never read — showing the primary's there would be a lie,
    // since the model is chosen per session.
    expect(other?.isPrimary).toBe(false);
    expect(other?.model).toBeNull();
  });

  it('records a user-stopped agent as stopped', async () => {
    const s = session();
    writeSession(s);
    writeAgent(s, 'agent-a', { description: 'cancelled', stoppedByUser: true }, [
      assistantRecord({ tokens: 10, timestamp: '2026-09-19T10:00:00Z', stopReason: 'tool_use' }),
    ]);

    const graph = await readAgentGraph(claudeHome, [s], null, null);

    expect(graph?.sessions[0].agents[0].status).toBe('stopped');
  });

  it('labels a session by its name, falling back to the basename of its cwd', async () => {
    const named = session({ sessionId: 'sess-a', cwd: '/Users/dev/a', name: 'my-session' });
    const unnamed = session({ sessionId: 'sess-b', cwd: '/Users/dev/some-project' });
    writeSession(named);
    writeSession(unnamed);

    const graph = await readAgentGraph(claudeHome, [named, unnamed], null, null);

    expect(graph?.sessions.find((s) => s.sessionId === 'sess-a')?.label).toBe('my-session');
    expect(graph?.sessions.find((s) => s.sessionId === 'sess-b')?.label).toBe('some-project');
  });

  it('orders sessions newest first when none are alive', async () => {
    const old = session({ sessionId: 'sess-old', cwd: '/Users/dev/a', startedAt: 1000 });
    const recent = session({ sessionId: 'sess-new', cwd: '/Users/dev/b', startedAt: 5000 });
    writeSession(old);
    writeSession(recent);

    const graph = await readAgentGraph(claudeHome, [old, recent], null, null);

    expect(graph?.sessions.map((s) => s.sessionId)).toEqual(['sess-new', 'sess-old']);
  });

  it('rebuilds when the session list changes rather than serving the cached graph', async () => {
    const a = session({ sessionId: 'sess-a', cwd: '/Users/dev/a' });
    const b = session({ sessionId: 'sess-b', cwd: '/Users/dev/b' });
    writeSession(a);
    writeSession(b);

    const first = await readAgentGraph(claudeHome, [a], null, null);
    expect(first?.sessions).toHaveLength(1);

    // Well inside AGENT_GRAPH_CACHE_TTL_MS: only the signature check can catch this.
    const second = await readAgentGraph(claudeHome, [a, b], null, null);
    expect(second?.sessions).toHaveLength(2);
  });

  it('serves the cached graph for an unchanged session list', async () => {
    const s = session();
    writeSession(s);

    const first = await readAgentGraph(claudeHome, [s], null, null);
    const second = await readAgentGraph(claudeHome, [s], null, null);

    expect(second).toBe(first);
  });
});
