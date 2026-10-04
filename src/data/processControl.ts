import { SessionFile } from '../types';
import { isProcessAlive } from './sessionReader';
import { KILL_GRACE_PERIOD_MS, KILL_POLL_INTERVAL_MS } from '../constants';

/**
 * What a termination attempt did.
 *
 *  - 'terminated'    — the process is gone.
 *  - 'signalled'     — the signal was delivered but the process outlived the grace period.
 *  - 'already_dead'  — nothing to do; the session file is just stale.
 *  - 'not_a_session' — the PID does not belong to a known Claude session. Refused.
 *  - 'not_permitted' — the OS refused the signal (EPERM).
 *  - 'error'         — anything else, with the reason in `message`.
 */
export type KillOutcome =
  'terminated' | 'signalled' | 'already_dead' | 'not_a_session' | 'not_permitted' | 'error';

export interface KillResult {
  outcome: KillOutcome;
  pid: number;
  /** The signal actually delivered, or null when nothing was sent. */
  signal: NodeJS.Signals | null;
  /** Human-readable, safe to put straight into a VS Code message. */
  message: string;
}

export interface KillOptions {
  /** SIGKILL instead of SIGTERM. Skips the graceful path entirely. */
  force?: boolean;
  /** Overridable so tests do not wait out the real grace period. */
  graceMs?: number;
  pollMs?: number;
}

/**
 * Confirms a PID belongs to a session we actually know about.
 *
 * This is the whole safety story for process control, so it is a pure function with its own
 * tests. The PID arrives from the webview — a surface that re-renders on every poll and
 * whose buttons therefore carry PIDs that were correct when the HTML was generated. Matching
 * on BOTH pid and sessionId is what makes a stale button harmless: PIDs are recycled by the
 * OS, and a recycled one paired with the session id that used to own it will not match, so
 * the click is refused rather than aimed at whatever now holds that number.
 */
export function resolveKillTarget(
  pid: number,
  sessionId: string,
  sessions: SessionFile[]
): SessionFile | null {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  if (!sessionId) return null;
  // Refusing our own process is not a realistic scenario — the extension host is not a
  // Claude session — but the cost of the check is nothing and the cost of being wrong is
  // the user's editor.
  if (pid === process.pid) return null;

  return sessions.find((s) => s.pid === pid && s.sessionId === sessionId) ?? null;
}

/**
 * Terminates one Claude Code session process.
 *
 * SIGTERM first, always: Claude Code flushes its transcript and removes its session file on
 * a polite signal, and a SIGKILL leaves that file behind — after which the extension keeps
 * listing a session that no longer exists until something reaps it. `force` exists for the
 * second click, once the user has seen that the first one was ignored.
 *
 * Subagents are deliberately not addressable here. They share this PID, so there is no
 * signal that reaches one without reaching all of them; the UI says so rather than
 * pretending otherwise.
 *
 * Never throws — every failure comes back as an outcome.
 */
export async function killSession(
  pid: number,
  sessionId: string,
  sessions: SessionFile[],
  options: KillOptions = {}
): Promise<KillResult> {
  const target = resolveKillTarget(pid, sessionId, sessions);
  if (!target) {
    return {
      outcome: 'not_a_session',
      pid,
      signal: null,
      message: `PID ${pid} is not a known Claude session — refusing to signal it.`,
    };
  }

  if (!isProcessAlive(pid)) {
    return {
      outcome: 'already_dead',
      pid,
      signal: null,
      message: `Session ${shortId(sessionId)} (PID ${pid}) has already exited.`,
    };
  }

  const signal: NodeJS.Signals = options.force ? 'SIGKILL' : 'SIGTERM';
  try {
    process.kill(pid, signal);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'EPERM') {
      return {
        outcome: 'not_permitted',
        pid,
        signal: null,
        message: `Not permitted to signal PID ${pid}. It belongs to another user.`,
      };
    }
    if (code === 'ESRCH') {
      return {
        outcome: 'already_dead',
        pid,
        signal: null,
        message: `Session ${shortId(sessionId)} (PID ${pid}) exited before the signal landed.`,
      };
    }
    return {
      outcome: 'error',
      pid,
      signal: null,
      message: `Failed to signal PID ${pid}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const exited = await waitForExit(
    pid,
    options.graceMs ?? KILL_GRACE_PERIOD_MS,
    options.pollMs ?? KILL_POLL_INTERVAL_MS
  );

  if (exited) {
    return {
      outcome: 'terminated',
      pid,
      signal,
      message: `Session ${shortId(sessionId)} (PID ${pid}) terminated.`,
    };
  }

  return {
    outcome: 'signalled',
    pid,
    signal,
    message: `Sent ${signal} to PID ${pid}, but it is still running.`,
  };
}

/** Polls liveness until the process is gone or the grace period runs out. */
async function waitForExit(pid: number, graceMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, graceMs);
  // Liveness is checked before every sleep, so a process that dies instantly costs no delay
  // and a grace period of zero degrades to a single check.
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(Math.max(1, Math.min(pollMs, deadline - Date.now())));
  }
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

/** The text of a termination confirmation, ready for showWarningMessage's modal form. */
export interface KillConfirmation {
  message: string;
  detail: string;
  confirmLabel: string;
}

/**
 * Builds the confirmation for a termination request.
 *
 * Pure and separately tested because the honesty of the agent variant is the whole point.
 * A subagent has no process of its own, so "stop this agent" can only ever mean "terminate
 * the session it runs in, and every other agent in there with it" — and a user who clicks
 * Stop on one row of a graph has no reason to know that unless this text says it.
 */
export function buildKillConfirmation(input: {
  label: string;
  pid: number;
  agentDescription?: string;
  /** Agents currently running in the target session, including the one being aimed at. */
  runningAgents: number;
}): KillConfirmation {
  const session = `"${input.label}" (PID ${input.pid})`;

  if (input.agentDescription) {
    const others = Math.max(0, input.runningAgents - 1);
    const collateral =
      others > 0 ? ` and the ${others} other agent${others === 1 ? '' : 's'} running in it` : '';
    return {
      message: `Stop the subagent "${input.agentDescription}"?`,
      detail:
        `Subagents run inside their session's process, so there is no way to stop one on ` +
        `its own. This terminates session ${session}${collateral}.\n\n` +
        `The session is sent SIGTERM, so it flushes its transcript on the way out — but ` +
        `nothing it had in flight is resumed.`,
      confirmLabel: 'Terminate Session',
    };
  }

  const agents =
    input.runningAgents > 0
      ? `${input.runningAgents} subagent${input.runningAgents === 1 ? '' : 's'} still running in ` +
        `this session will be terminated with it.\n\n`
      : '';

  return {
    message: `Terminate session ${session}?`,
    detail:
      `${agents}The session is sent SIGTERM, so it flushes its transcript on the way out — ` +
      `but nothing it had in flight is resumed.`,
    confirmLabel: 'Terminate Session',
  };
}
