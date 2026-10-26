import { describe, it, expect } from 'vitest';
import {
  buildLoopInstruction,
  findAncestorPid,
  findLoop,
  sanitizeForTerminal,
} from '../src/data/loopControl';
import { parseLoopActionRequest } from '../src/ui/webviewPanel';
import { LoopInfo, LoopScan } from '../src/types';
import { LOOP_AUTONOMOUS_SENTINEL } from '../src/constants';

const makeLoop = (overrides: Partial<LoopInfo> = {}): LoopInfo => ({
  id: 'abc12345',
  kind: 'cron',
  prompt: 'check CI',
  cron: '*/5 * * * *',
  recurring: true,
  delaySeconds: null,
  reason: null,
  createdAt: 0,
  runCount: 0,
  lastRunAt: 0,
  nextRunAt: null,
  expiresAt: null,
  status: 'active',
  ...overrides,
});

describe('buildLoopInstruction', () => {
  it('runs a loop by sending its own prompt', () => {
    expect(buildLoopInstruction('run', makeLoop({ prompt: '/babysit-prs' }))).toBe('/babysit-prs');
  });

  it('never types the autonomous sentinel', () => {
    const text = buildLoopInstruction('run', makeLoop({ prompt: LOOP_AUTONOMOUS_SENTINEL }));
    expect(text).not.toContain(LOOP_AUTONOMOUS_SENTINEL);
    expect(text).toContain('autonomous loop');
  });

  it('cancels a cron job by naming its id for CronDelete', () => {
    const text = buildLoopInstruction('cancel', makeLoop());
    expect(text).toContain('abc12345');
    expect(text).toContain('CronDelete');
  });

  it('stops a self-paced loop through ScheduleWakeup', () => {
    const text = buildLoopInstruction(
      'cancel',
      makeLoop({ kind: 'dynamic', cron: null, prompt: 'watch the deploy' })
    );
    expect(text).toContain('ScheduleWakeup with stop: true');
    expect(text).toContain('watch the deploy');
  });
});

describe('sanitizeForTerminal', () => {
  it('folds newlines so a multi-line prompt is submitted once', () => {
    expect(sanitizeForTerminal('line one\nline two\r\n\tthree')).toBe('line one line two three');
  });

  it('drops escape and other control characters', () => {
    expect(sanitizeForTerminal('a\u001b[2Jb\u0007c\u007fd')).toBe('a[2Jbcd');
  });
});

describe('findLoop', () => {
  const scan: LoopScan = {
    sessions: [
      { sessionId: 's1', pid: 10, cwd: '/p', label: 'p', isAlive: true, loops: [makeLoop()] },
    ],
    activeCount: 1,
    totalCount: 1,
    generatedAt: 0,
  };

  it('finds a loop by session and id', () => {
    expect(findLoop(scan, 's1', 'abc12345')?.loop.id).toBe('abc12345');
  });

  it('refuses an id from a different session, or with no scan', () => {
    expect(findLoop(scan, 's2', 'abc12345')).toBeNull();
    expect(findLoop(null, 's1', 'abc12345')).toBeNull();
  });
});

describe('findAncestorPid', () => {
  // 500 (claude) → 400 (zsh, the terminal's shell) → 300 → 1
  const parents: Record<number, number> = { 500: 400, 400: 300, 300: 1 };
  const getParent = async (pid: number): Promise<number | null> => parents[pid] ?? null;

  it('walks up to the terminal shell', async () => {
    expect(await findAncestorPid(500, new Set([400, 999]), getParent)).toBe(400);
  });

  it('matches the process itself', async () => {
    expect(await findAncestorPid(500, new Set([500]), getParent)).toBe(500);
  });

  it('returns null when no terminal owns the session', async () => {
    expect(await findAncestorPid(500, new Set([999]), getParent)).toBeNull();
  });

  it('stops on a parent chain that loops back on itself', async () => {
    const cyclic = async (pid: number): Promise<number | null> => (pid === 500 ? 600 : 500);
    expect(await findAncestorPid(500, new Set([999]), cyclic)).toBeNull();
  });
});

describe('parseLoopActionRequest', () => {
  const valid = { action: 'run', pid: 4242, sessionId: 's1', loopId: 'abc', label: 'proj' };

  it('accepts a well-formed request', () => {
    expect(parseLoopActionRequest(valid)).toEqual(valid);
  });

  it('rejects anything malformed', () => {
    expect(parseLoopActionRequest({ ...valid, action: 'delete' })).toBeNull();
    expect(parseLoopActionRequest({ ...valid, pid: 1 })).toBeNull();
    expect(parseLoopActionRequest({ ...valid, pid: '4242' })).toBeNull();
    expect(parseLoopActionRequest({ ...valid, sessionId: '' })).toBeNull();
    expect(parseLoopActionRequest({ ...valid, loopId: 7 })).toBeNull();
    expect(parseLoopActionRequest(null)).toBeNull();
  });
});
