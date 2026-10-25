import { execFile } from 'child_process';
import { LoopInfo, LoopScan, SessionLoops } from '../types';
import { LOOP_AUTONOMOUS_SENTINEL, LOOP_MAX_PROCESS_ANCESTRY } from '../constants';

/**
 * What the dashboard can ask of a loop.
 *
 *  - 'run'    — run the loop's prompt now, ahead of its schedule. The schedule is unchanged.
 *  - 'cancel' — ask the session to cancel the loop.
 */
export type LoopAction = 'run' | 'cancel';

/**
 * Loop control works by typing into the session, because there is no other way in.
 *
 * A loop job lives in the Claude process's memory, and CronDelete / ScheduleWakeup are tools
 * only the model inside that process can call. So both actions become text the session
 * receives as its next user turn: the loop's own prompt for 'run', and an instruction naming
 * the job for 'cancel'. Claude Code queues typed input while a turn is in flight, so this is
 * safe to send at any time.
 */
export function buildLoopInstruction(action: LoopAction, loop: LoopInfo): string {
  if (action === 'run') {
    // The sentinel only means something to the scheduler; typed in, it is just noise.
    return loop.prompt === LOOP_AUTONOMOUS_SENTINEL
      ? 'Run the next iteration of the autonomous loop now.'
      : sanitizeForTerminal(loop.prompt);
  }

  if (loop.kind === 'cron') {
    return sanitizeForTerminal(
      `Cancel the scheduled loop job ${loop.id} now with CronDelete, and do not reschedule it.`
    );
  }
  const subject =
    loop.prompt === LOOP_AUTONOMOUS_SENTINEL
      ? 'the autonomous /loop'
      : `the self-paced /loop for "${truncate(loop.prompt, 120)}"`;
  return sanitizeForTerminal(
    `Stop ${subject}: call ScheduleWakeup with stop: true and do not schedule another wake-up.`
  );
}

/**
 * Makes text safe to type into a terminal running Claude Code's TUI.
 *
 * Every C0 control character and DEL is dropped, not escaped: an ESC in a model-authored
 * prompt would otherwise reach the terminal as the start of a control sequence. Newlines
 * become spaces, because each one would submit the prompt early.
 */
export function sanitizeForTerminal(text: string): string {
  return (
    text
      .replace(/[\r\n\t]+/g, ' ')
      // Matching control characters is the whole point of this pattern.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/ {2,}/g, ' ')
      .trim()
  );
}

/** The loop a button names, looked up in the last scan rather than trusted from the webview. */
export function findLoop(
  scan: LoopScan | null,
  sessionId: string,
  loopId: string
): { session: SessionLoops; loop: LoopInfo } | null {
  const session = scan?.sessions.find((s) => s.sessionId === sessionId);
  const loop = session?.loops.find((l) => l.id === loopId);
  return session && loop ? { session, loop } : null;
}

/**
 * The first of `candidates` found walking up from `pid`, including `pid` itself.
 *
 * A Claude session started in a VS Code terminal is a child of that terminal's shell, so the
 * terminal is found by walking the session's parent chain until a terminal's shell PID turns
 * up. Bounded, because a chain that never reaches a candidate ends at launchd/init anyway.
 */
export async function findAncestorPid(
  pid: number,
  candidates: Set<number>,
  getParent: (pid: number) => Promise<number | null> = getParentPid
): Promise<number | null> {
  let cursor: number | null = pid;
  for (let depth = 0; cursor !== null && depth <= LOOP_MAX_PROCESS_ANCESTRY; depth++) {
    if (candidates.has(cursor)) return cursor;
    if (cursor <= 1) return null;
    cursor = await getParent(cursor);
  }
  return null;
}

/**
 * Parent PID via `ps`, or null. No shell: the PID is passed as an argument.
 *
 * Null on Windows, where there is no `ps` — the caller falls back to the clipboard.
 */
export function getParentPid(pid: number): Promise<number | null> {
  if (process.platform === 'win32' || !Number.isInteger(pid) || pid <= 1) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'ppid=', '-p', String(pid)], { timeout: 2000 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const parent = Number.parseInt(String(stdout).trim(), 10);
      resolve(Number.isInteger(parent) && parent > 0 ? parent : null);
    });
  });
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
