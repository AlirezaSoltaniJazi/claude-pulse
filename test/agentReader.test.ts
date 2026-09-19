import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readSessionAgents, clearAgentCache } from '../src/data/agentReader';
import { clearModelCache } from '../src/data/modelReader';
import { SessionFile } from '../src/types';

let claudeHome: string;

const CWD = '/Users/dev/proj';
const SESSION_ID = 'sess-1';
/** encodeProjectDirName: '/' and '.' both become '-'. */
const PROJECT_DIR = '-Users-dev-proj';

const makeSession = (overrides: Partial<SessionFile> = {}): SessionFile => ({
  pid: 1,
  sessionId: SESSION_ID,
  cwd: CWD,
  startedAt: 1000,
  ...overrides,
});

function projectPath(): string {
  return path.join(claudeHome, 'projects', PROJECT_DIR);
}

/** The session transcript must exist — it is how the reader locates the project directory. */
function writeTranscript(): void {
  fs.mkdirSync(projectPath(), { recursive: true });
  fs.writeFileSync(path.join(projectPath(), `${SESSION_ID}.jsonl`), '');
}

function agentsDir(): string {
  return path.join(projectPath(), SESSION_ID, 'subagents');
}

const assistantRecord = (model: string, tokens: number, timestamp: string): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp,
    message: {
      model,
      usage: {
        input_tokens: tokens,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  });

/** Writes the .meta.json / .jsonl pair Claude Code produces for one subagent. */
function writeAgent(
  id: string,
  meta: Record<string, unknown>,
  records: string[] | null = []
): void {
  fs.mkdirSync(agentsDir(), { recursive: true });
  fs.writeFileSync(path.join(agentsDir(), `${id}.meta.json`), JSON.stringify(meta));
  if (records !== null) {
    fs.writeFileSync(path.join(agentsDir(), `${id}.jsonl`), records.join('\n'));
  }
}

describe('readSessionAgents', () => {
  beforeEach(() => {
    clearAgentCache();
    clearModelCache();
    claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pulse-agents-'));
  });

  afterEach(() => {
    fs.rmSync(claudeHome, { recursive: true, force: true });
  });

  it('returns null when there is no session', async () => {
    expect(await readSessionAgents(claudeHome, null)).toBeNull();
  });

  it('returns null when the session spawned no subagents', async () => {
    writeTranscript();

    expect(await readSessionAgents(claudeHome, makeSession())).toBeNull();
  });

  it('reads an agent from its meta file and transcript', async () => {
    writeTranscript();
    writeAgent(
      'agent-a',
      { agentType: 'Explore', description: 'Catalog HHD entity data', spawnDepth: 1 },
      [
        assistantRecord('claude-sonnet-5', 100, '2026-09-19T10:00:00Z'),
        assistantRecord('claude-sonnet-5', 50, '2026-09-19T10:00:30Z'),
      ]
    );

    const map = await readSessionAgents(claudeHome, makeSession());

    expect(map?.sessionId).toBe(SESSION_ID);
    expect(map?.totalTokens).toBe(150);
    expect(map?.truncated).toBe(false);
    expect(map?.agents[0]).toEqual({
      id: 'agent-a',
      description: 'Catalog HHD entity data',
      agentType: 'Explore',
      spawnDepth: 1,
      parentAgentId: null,
      tokens: 150,
      durationMs: 30_000,
      turns: 2,
      model: 'claude-sonnet-5',
    });
  });

  it('sums all four token counters, not just input', async () => {
    writeTranscript();
    fs.mkdirSync(agentsDir(), { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir(), 'agent-a.meta.json'),
      JSON.stringify({ description: 'x' })
    );
    fs.writeFileSync(
      path.join(agentsDir(), 'agent-a.jsonl'),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-09-19T10:00:00Z',
        message: {
          model: 'claude-sonnet-5',
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_read_input_tokens: 4,
            cache_creation_input_tokens: 8,
          },
        },
      })
    );

    const map = await readSessionAgents(claudeHome, makeSession());

    expect(map?.agents[0].tokens).toBe(15);
  });

  it('orders agents by cost, because that is the reason to open the view', async () => {
    writeTranscript();
    writeAgent('agent-cheap', { description: 'cheap' }, [
      assistantRecord('claude-sonnet-5', 10, '2026-09-19T10:00:00Z'),
    ]);
    writeAgent('agent-dear', { description: 'dear' }, [
      assistantRecord('claude-sonnet-5', 900, '2026-09-19T10:00:00Z'),
    ]);

    const map = await readSessionAgents(claudeHome, makeSession());

    expect(map?.agents.map((a) => a.description)).toEqual(['dear', 'cheap']);
  });

  it('carries the spawn hierarchy through', async () => {
    writeTranscript();
    writeAgent('agent-child', {
      description: 'child',
      spawnDepth: 2,
      parentAgentId: 'agent-parent',
    });

    const map = await readSessionAgents(claudeHome, makeSession());

    expect(map?.agents[0].spawnDepth).toBe(2);
    expect(map?.agents[0].parentAgentId).toBe('agent-parent');
  });

  it('still lists an agent whose transcript has not been written yet', async () => {
    writeTranscript();
    writeAgent('agent-new', { description: 'just spawned' }, null);

    const map = await readSessionAgents(claudeHome, makeSession());

    expect(map?.agents[0]).toMatchObject({
      description: 'just spawned',
      tokens: 0,
      turns: 0,
      durationMs: null,
      model: null,
    });
  });

  it('skips malformed JSONL lines rather than throwing', async () => {
    writeTranscript();
    writeAgent('agent-a', { description: 'x' }, [
      '{ this is not json',
      assistantRecord('claude-sonnet-5', 7, '2026-09-19T10:00:00Z'),
      '',
    ]);

    const map = await readSessionAgents(claudeHome, makeSession());

    expect(map?.agents[0].tokens).toBe(7);
    expect(map?.agents[0].turns).toBe(1);
  });

  it('skips an agent whose meta file is unreadable', async () => {
    writeTranscript();
    fs.mkdirSync(agentsDir(), { recursive: true });
    fs.writeFileSync(path.join(agentsDir(), 'agent-bad.meta.json'), 'not json');
    writeAgent('agent-good', { description: 'good' });

    const map = await readSessionAgents(claudeHome, makeSession());

    expect(map?.agents.map((a) => a.description)).toEqual(['good']);
  });

  it('falls back to the file stem when the meta file names no description', async () => {
    writeTranscript();
    writeAgent('agent-nameless', { agentType: 'general-purpose' });

    const map = await readSessionAgents(claudeHome, makeSession());

    expect(map?.agents[0].description).toBe('agent-nameless');
    expect(map?.agents[0].spawnDepth).toBe(1);
  });

  it('ignores the <synthetic> placeholder when naming the model', async () => {
    writeTranscript();
    writeAgent('agent-a', { description: 'x' }, [
      assistantRecord('claude-sonnet-5', 5, '2026-09-19T10:00:00Z'),
      assistantRecord('<synthetic>', 0, '2026-09-19T10:00:10Z'),
    ]);

    const map = await readSessionAgents(claudeHome, makeSession());

    expect(map?.agents[0].model).toBe('claude-sonnet-5');
  });

  it('serves a cached map until it is explicitly cleared', async () => {
    writeTranscript();
    writeAgent('agent-a', { description: 'first' });

    expect((await readSessionAgents(claudeHome, makeSession()))?.agents).toHaveLength(1);

    writeAgent('agent-b', { description: 'second' });
    expect((await readSessionAgents(claudeHome, makeSession()))?.agents).toHaveLength(1);

    expect((await readSessionAgents(claudeHome, makeSession(), true))?.agents).toHaveLength(2);
  });
});
