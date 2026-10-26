import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildLoops, clearLoopCache, parseLoopEvents, readLoops } from '../src/data/loopReader';
import { clearModelCache } from '../src/data/modelReader';
import { SessionFile } from '../src/types';
import { LOOP_FIRE_GRACE_MS, LOOP_RECURRING_EXPIRY_MS } from '../src/constants';

const T0 = Date.parse('2026-10-25T10:00:00.000Z');
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();
const MIN = 60_000;

/** The assistant record Claude Code writes for one tool call. */
const toolUse = (id: string, name: string, input: Record<string, unknown>, offsetMs: number) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: iso(offsetMs),
    message: { content: [{ type: 'tool_use', id, name, input }] },
  });

/** The user record answering it, with the structured result beside the text one. */
const toolResult = (
  toolUseId: string,
  text: string,
  structured: Record<string, unknown> | undefined,
  offsetMs: number,
  isError = false
) =>
  JSON.stringify({
    type: 'user',
    timestamp: iso(offsetMs),
    message: {
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: isError }],
    },
    ...(structured ? { toolUseResult: structured } : {}),
  });

const userPrompt = (text: string, offsetMs: number) =>
  JSON.stringify({ type: 'user', timestamp: iso(offsetMs), message: { content: text } });

const cronCreate = (
  toolId: string,
  jobId: string,
  cron: string,
  prompt: string,
  offsetMs: number,
  recurring = true,
  nextFireAt: number | null = null
): string[] => [
  toolUse(toolId, 'CronCreate', { cron, prompt, recurring }, offsetMs),
  toolResult(
    toolId,
    `Scheduled recurring job ${jobId} (${cron}).`,
    { id: jobId, humanSchedule: cron, recurring, durable: false, nextFireAt },
    offsetMs + 100
  ),
];

describe('parseLoopEvents', () => {
  it('links a CronCreate to the job id in its result', () => {
    const events = parseLoopEvents(
      cronCreate('t1', 'abc12345', '*/5 * * * *', 'check CI', 0, true, T0 + 5 * MIN).join('\n')
    );
    expect(events.creates).toEqual([
      {
        jobId: 'abc12345',
        cron: '*/5 * * * *',
        prompt: 'check CI',
        recurring: true,
        createdAt: T0,
        firstFireAt: T0 + 5 * MIN,
      },
    ]);
  });

  it('falls back to the result text when there is no structured result', () => {
    const lines = [
      toolUse('t1', 'CronCreate', { cron: '7 * * * *', prompt: 'x' }, 0),
      toolResult('t1', 'Scheduled one-shot task d90aeba3 (7 * * * *).', undefined, 100),
    ];
    expect(parseLoopEvents(lines.join('\n')).creates[0].jobId).toBe('d90aeba3');
  });

  it('defaults to recurring, as CronCreate does', () => {
    const lines = [
      toolUse('t1', 'CronCreate', { cron: '7 * * * *', prompt: 'x' }, 0),
      toolResult('t1', 'ok', { id: 'j1' }, 100),
    ];
    expect(parseLoopEvents(lines.join('\n')).creates[0].recurring).toBe(true);
  });

  it('drops a CronCreate that failed', () => {
    const lines = [
      toolUse('t1', 'CronCreate', { cron: 'bad', prompt: 'x' }, 0),
      toolResult('t1', 'Invalid cron expression', undefined, 100, true),
    ];
    expect(parseLoopEvents(lines.join('\n')).creates).toEqual([]);
  });

  it('ignores api-request-blob copies and sidechain records', () => {
    const blob = JSON.stringify({
      type: 'api-request-blob',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'w1',
            name: 'ScheduleWakeup',
            input: { prompt: 'p', delaySeconds: 60 },
          },
        ],
      },
    });
    const sidechain = JSON.stringify({
      type: 'assistant',
      isSidechain: true,
      timestamp: iso(0),
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'w2',
            name: 'ScheduleWakeup',
            input: { prompt: 'p', delaySeconds: 60 },
          },
        ],
      },
    });
    const events = parseLoopEvents([blob, sidechain].join('\n'));
    expect(events.wakeups).toEqual([]);
  });

  it('counts a repeated tool_use id once', () => {
    const line = toolUse('w1', 'ScheduleWakeup', { prompt: 'p', delaySeconds: 60 }, 0);
    expect(parseLoopEvents([line, line].join('\n')).wakeups).toHaveLength(1);
  });

  it('skips malformed lines', () => {
    const events = parseLoopEvents(
      ['{"type":"user", broken', ...cronCreate('t1', 'j1', '* * * * *', 'p', 0)].join('\n')
    );
    expect(events.creates).toHaveLength(1);
  });

  it('records CronDelete by job id', () => {
    const events = parseLoopEvents(toolUse('t2', 'CronDelete', { id: 'j1' }, 5 * MIN));
    expect(events.deletes.get('j1')).toBe(T0 + 5 * MIN);
  });

  it('keeps only typed prompts that could be a run of one of its loops', () => {
    const events = parseLoopEvents(
      [
        ...cronCreate('t1', 'j1', '*/5 * * * *', 'check CI', 0),
        userPrompt('check CI', MIN),
        userPrompt('unrelated chat', 2 * MIN),
        toolResult('tx', 'check CI', undefined, 3 * MIN),
      ].join('\n')
    );
    expect(events.userPrompts).toEqual([{ text: 'check CI', at: T0 + MIN }]);
  });

  it('keeps no prompts at all for a transcript without loops', () => {
    const events = parseLoopEvents([userPrompt('hello', 0), userPrompt('again', MIN)].join('\n'));
    expect(events.userPrompts).toEqual([]);
  });
});

describe('buildLoops — cron jobs', () => {
  const live = { isAlive: true, now: T0 + 12 * MIN };

  it('reports an active recurring job with its runs and next run', () => {
    const events = parseLoopEvents(
      [
        ...cronCreate('t1', 'j1', '*/5 * * * *', 'check CI', 0, true, T0 + 5 * MIN),
        userPrompt('check CI', 5 * MIN),
        userPrompt('something else', 7 * MIN),
        userPrompt('check CI', 10 * MIN),
      ].join('\n')
    );
    const [loop] = buildLoops(events, live);

    expect(loop).toMatchObject({
      id: 'j1',
      kind: 'cron',
      status: 'active',
      runCount: 2,
      lastRunAt: T0 + 10 * MIN,
      expiresAt: T0 + LOOP_RECURRING_EXPIRY_MS,
    });
    // Computed from the cron, not the stale first-fire time in the result.
    expect(loop.nextRunAt).toBeGreaterThan(live.now);
  });

  it('counts a slash-command prompt by its command record', () => {
    const events = parseLoopEvents(
      [
        ...cronCreate('t1', 'j1', '*/5 * * * *', '/babysit-prs', 0),
        userPrompt('<command-name>/babysit-prs</command-name>', 5 * MIN),
      ].join('\n')
    );
    expect(buildLoops(events, live)[0].runCount).toBe(1);
  });

  it('marks a deleted job cancelled, even after its session exits', () => {
    const events = parseLoopEvents(
      [
        ...cronCreate('t1', 'j1', '*/5 * * * *', 'p', 0),
        toolUse('t2', 'CronDelete', { id: 'j1' }, MIN),
      ].join('\n')
    );
    const [loop] = buildLoops(events, { isAlive: false, now: live.now });
    expect(loop.status).toBe('cancelled');
    expect(loop.nextRunAt).toBeNull();
  });

  it('marks every job ended once its session is gone', () => {
    const events = parseLoopEvents(cronCreate('t1', 'j1', '*/5 * * * *', 'p', 0).join('\n'));
    expect(buildLoops(events, { isAlive: false, now: live.now })[0].status).toBe('ended');
  });

  it('expires a recurring job after seven days', () => {
    const events = parseLoopEvents(cronCreate('t1', 'j1', '*/5 * * * *', 'p', 0).join('\n'));
    const [loop] = buildLoops(events, { isAlive: true, now: T0 + LOOP_RECURRING_EXPIRY_MS + MIN });
    expect(loop.status).toBe('expired');
  });

  it('completes a one-shot once it has fired', () => {
    const events = parseLoopEvents(
      [
        ...cronCreate('t1', 'j1', '30 10 25 10 *', 'remind me', 0, false, T0 + 30 * MIN),
        userPrompt('remind me', 30 * MIN),
      ].join('\n')
    );
    expect(buildLoops(events, { isAlive: true, now: T0 + 31 * MIN })[0].status).toBe('completed');
  });

  it('keeps a one-shot active until its time, with no expiry', () => {
    const events = parseLoopEvents(
      cronCreate('t1', 'j1', '30 10 25 10 *', 'remind me', 0, false, T0 + 30 * MIN).join('\n')
    );
    const [loop] = buildLoops(events, live);
    expect(loop).toMatchObject({ status: 'active', nextRunAt: T0 + 30 * MIN, expiresAt: null });
  });
});

describe('buildLoops — dynamic loops', () => {
  const wake = (id: string, input: Record<string, unknown>, offsetMs: number) =>
    toolUse(id, 'ScheduleWakeup', input, offsetMs);

  it('chains wake-ups with the same prompt into one loop', () => {
    const events = parseLoopEvents(
      [
        wake('w1', { prompt: 'watch deploy', delaySeconds: 300, reason: 'first look' }, 0),
        wake('w2', { prompt: 'watch deploy', delaySeconds: 600, reason: 'still rolling' }, 5 * MIN),
      ].join('\n')
    );
    const loops = buildLoops(events, { isAlive: true, now: T0 + 6 * MIN });

    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatchObject({
      id: 'w1',
      kind: 'dynamic',
      status: 'active',
      runCount: 2,
      delaySeconds: 600,
      reason: 'still rolling',
      nextRunAt: T0 + 15 * MIN,
    });
  });

  it('closes the open loop on a stop that omits the prompt', () => {
    const events = parseLoopEvents(
      [wake('w1', { prompt: 'p', delaySeconds: 60 }, 0), wake('w2', { stop: true }, MIN)].join('\n')
    );
    expect(buildLoops(events, { isAlive: true, now: T0 + 2 * MIN })[0].status).toBe('cancelled');
  });

  it('starts a new loop when the same prompt is scheduled after a stop', () => {
    const events = parseLoopEvents(
      [
        wake('w1', { prompt: 'p', delaySeconds: 60 }, 0),
        wake('w2', { prompt: 'p', stop: true }, MIN),
        wake('w3', { prompt: 'p', delaySeconds: 60 }, 2 * MIN),
      ].join('\n')
    );
    const loops = buildLoops(events, { isAlive: true, now: T0 + 2 * MIN + 1000 });
    expect(loops.map((l) => [l.id, l.status])).toEqual([
      ['w3', 'active'],
      ['w1', 'cancelled'],
    ]);
  });

  it('completes a loop whose wake-up passed without another being scheduled', () => {
    const events = parseLoopEvents(wake('w1', { prompt: 'p', delaySeconds: 60 }, 0));
    const [loop] = buildLoops(events, { isAlive: true, now: T0 + MIN + LOOP_FIRE_GRACE_MS + 1 });
    expect(loop.status).toBe('completed');
    expect(loop.nextRunAt).toBeNull();
  });
});

describe('readLoops', () => {
  let claudeHome: string;
  const CWD = '/Users/dev/proj';
  const PROJECT_DIR = '-Users-dev-proj';

  const makeSession = (sessionId: string, pid: number): SessionFile => ({
    pid,
    sessionId,
    cwd: CWD,
    startedAt: T0,
  });

  const writeTranscript = (sessionId: string, lines: string[]): void => {
    const dir = path.join(claudeHome, 'projects', PROJECT_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.join('\n'));
  };

  beforeEach(() => {
    claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pulse-loops-'));
    clearLoopCache();
    clearModelCache();
  });

  afterEach(() => {
    fs.rmSync(claudeHome, { recursive: true, force: true });
  });

  it('groups loops by session, live sessions first, and leaves out sessions without loops', async () => {
    writeTranscript('live', cronCreate('t1', 'j1', '*/5 * * * *', 'check CI', 0));
    writeTranscript('dead', cronCreate('t2', 'j2', '*/5 * * * *', 'old', MIN));
    writeTranscript('quiet', [userPrompt('hello', 0)]);

    const scan = await readLoops(
      claudeHome,
      [
        makeSession('dead', 2_147_483_000),
        makeSession('quiet', process.pid),
        makeSession('live', process.pid),
      ],
      T0 + 2 * MIN
    );

    expect(scan.sessions.map((s) => [s.sessionId, s.isAlive])).toEqual([
      ['live', true],
      ['dead', false],
    ]);
    expect(scan.activeCount).toBe(1);
    expect(scan.totalCount).toBe(2);
    expect(scan.sessions[0].label).toBe('proj');
  });

  it('returns an empty scan when no transcript can be found', async () => {
    const scan = await readLoops(claudeHome, [makeSession('missing', process.pid)], T0);
    expect(scan).toMatchObject({ sessions: [], activeCount: 0, totalCount: 0 });
  });
});
