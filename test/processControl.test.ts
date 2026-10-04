import { describe, it, expect, afterEach } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import { buildKillConfirmation, killSession, resolveKillTarget } from '../src/data/processControl';
import { SessionFile } from '../src/types';

const makeSession = (overrides: Partial<SessionFile> = {}): SessionFile => ({
  pid: 4242,
  sessionId: 'sess-1',
  cwd: '/Users/dev/proj',
  startedAt: 1000,
  ...overrides,
});

/** Children spawned by a test, killed in afterEach whatever the assertions did. */
const spawned: ChildProcess[] = [];

/**
 * A real child process, so the signal path is exercised end to end.
 *
 * `trap` decides whether it dies on SIGTERM, which is the difference between the
 * 'terminated' and 'signalled' outcomes and cannot be faked without stubbing process.kill —
 * at which point the test would no longer be testing the thing that matters.
 */
async function spawnVictim(trap: boolean): Promise<number> {
  const script = trap
    ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
    : 'setInterval(() => {}, 1000);';
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  spawned.push(child);

  // spawn() resolves the PID synchronously, but the process is not yet far enough along to
  // have installed its SIGTERM handler; signalling before that would kill a trapping victim.
  await new Promise((resolve) => setTimeout(resolve, 250));
  return child.pid as number;
}

afterEach(() => {
  for (const child of spawned) {
    if (child.pid && !child.killed) {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }
  spawned.length = 0;
});

describe('resolveKillTarget', () => {
  it('matches a session on both pid and sessionId', () => {
    const session = makeSession();
    expect(resolveKillTarget(4242, 'sess-1', [session])).toBe(session);
  });

  it('refuses a pid that is not in the session list', () => {
    expect(resolveKillTarget(9999, 'sess-1', [makeSession()])).toBeNull();
  });

  it('refuses a known pid paired with the wrong session id', () => {
    // This is the recycled-PID case: the number is right, but it now belongs to something
    // that is not the session the user clicked on.
    expect(resolveKillTarget(4242, 'sess-other', [makeSession()])).toBeNull();
  });

  it('refuses pid 0, 1 and negatives', () => {
    const sessions = [makeSession({ pid: 0 }), makeSession({ pid: 1 }), makeSession({ pid: -5 })];
    expect(resolveKillTarget(0, 'sess-1', sessions)).toBeNull();
    expect(resolveKillTarget(1, 'sess-1', sessions)).toBeNull();
    expect(resolveKillTarget(-5, 'sess-1', sessions)).toBeNull();
  });

  it('refuses a non-integer pid', () => {
    expect(resolveKillTarget(42.5, 'sess-1', [makeSession({ pid: 42.5 })])).toBeNull();
  });

  it('refuses an empty session id', () => {
    expect(resolveKillTarget(4242, '', [makeSession({ sessionId: '' })])).toBeNull();
  });

  it('refuses this very process, even if it is listed as a session', () => {
    const sessions = [makeSession({ pid: process.pid, sessionId: 'sess-self' })];
    expect(resolveKillTarget(process.pid, 'sess-self', sessions)).toBeNull();
  });
});

describe('killSession', () => {
  it('refuses a pid that is not a known session without signalling anything', async () => {
    const result = await killSession(9999, 'sess-1', [makeSession()]);

    expect(result.outcome).toBe('not_a_session');
    expect(result.signal).toBeNull();
  });

  it('reports a session whose process is already gone', async () => {
    const pid = await spawnVictim(false);
    process.kill(pid, 'SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 200));

    const result = await killSession(pid, 'sess-1', [makeSession({ pid })]);

    expect(result.outcome).toBe('already_dead');
    expect(result.signal).toBeNull();
  });

  it('terminates a live session with SIGTERM', async () => {
    const pid = await spawnVictim(false);

    const result = await killSession(pid, 'sess-1', [makeSession({ pid })], {
      graceMs: 3000,
      pollMs: 50,
    });

    expect(result.outcome).toBe('terminated');
    expect(result.signal).toBe('SIGTERM');
  });

  it('reports signalled — not terminated — when the process survives SIGTERM', async () => {
    const pid = await spawnVictim(true);

    const result = await killSession(pid, 'sess-1', [makeSession({ pid })], {
      graceMs: 400,
      pollMs: 50,
    });

    expect(result.outcome).toBe('signalled');
    expect(result.signal).toBe('SIGTERM');
  });

  it('kills a process that ignores SIGTERM when forced', async () => {
    const pid = await spawnVictim(true);

    const result = await killSession(pid, 'sess-1', [makeSession({ pid })], {
      force: true,
      graceMs: 3000,
      pollMs: 50,
    });

    expect(result.outcome).toBe('terminated');
    expect(result.signal).toBe('SIGKILL');
  });
});

describe('buildKillConfirmation', () => {
  it('says plainly that stopping a subagent terminates its session', () => {
    const confirmation = buildKillConfirmation({
      label: 'claude-pulse',
      pid: 123,
      agentDescription: 'Crossref review batch 0',
      runningAgents: 1,
    });

    expect(confirmation.message).toContain('Crossref review batch 0');
    expect(confirmation.detail).toContain('no way to stop one on');
    expect(confirmation.detail).toContain('terminates session "claude-pulse" (PID 123)');
    // Only the one agent is running, so there is no collateral clause to warn about.
    expect(confirmation.detail).not.toContain('other agent');
  });

  it('counts the other agents that go down with the session', () => {
    const confirmation = buildKillConfirmation({
      label: 'claude-pulse',
      pid: 123,
      agentDescription: 'one of many',
      runningAgents: 4,
    });

    expect(confirmation.detail).toContain('the 3 other agents running in it');
  });

  it('uses the singular for a single bystander', () => {
    const confirmation = buildKillConfirmation({
      label: 'x',
      pid: 1,
      agentDescription: 'a',
      runningAgents: 2,
    });

    expect(confirmation.detail).toContain('the 1 other agent running in it');
  });

  it('warns about running agents when the session itself is the target', () => {
    const confirmation = buildKillConfirmation({ label: 'proj', pid: 77, runningAgents: 2 });

    expect(confirmation.message).toBe('Terminate session "proj" (PID 77)?');
    expect(confirmation.detail).toContain('2 subagents still running');
  });

  it('omits the agent warning for a session with none running', () => {
    const confirmation = buildKillConfirmation({ label: 'proj', pid: 77, runningAgents: 0 });

    expect(confirmation.detail).not.toContain('subagent');
    expect(confirmation.detail).toContain('SIGTERM');
  });
});
