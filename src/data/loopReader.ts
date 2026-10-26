import * as fs from 'fs';
import { LoopInfo, LoopScan, LoopStatus, SessionFile, SessionLoops } from '../types';
import { resolveTranscriptPath } from './modelReader';
import { isProcessAlive } from './sessionReader';
import { sessionLabel } from './agentReader';
import { nextCronRun } from '../utils/cron';
import { LOOP_FIRE_GRACE_MS, LOOP_RECURRING_EXPIRY_MS } from '../constants';

/** A CronCreate call whose result named a job id. Calls that failed never get one. */
export interface CronCreateEvent {
  jobId: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  createdAt: number;
  /** First fire time, from the tool result. Null when the result did not carry one. */
  firstFireAt: number | null;
}

export interface WakeupEvent {
  toolUseId: string;
  /** Null on a `stop` call, which may omit it. */
  prompt: string | null;
  delaySeconds: number | null;
  reason: string | null;
  isStop: boolean;
  at: number;
}

/**
 * Everything one transcript says about loops, in transcript order. Status is NOT computed
 * here: it depends on the clock and on the session's liveness, neither of which belongs in a
 * cache keyed to the file.
 */
export interface TranscriptLoopEvents {
  creates: CronCreateEvent[];
  /** Job id → epoch ms of the CronDelete that cancelled it. */
  deletes: Map<string, number>;
  wakeups: WakeupEvent[];
  /** Main-thread user prompts, for counting cron fires. Tool results are excluded. */
  userPrompts: { text: string; at: number }[];
}

interface LoopEventsCache {
  mtimeMs: number;
  size: number;
  events: TranscriptLoopEvents;
}

/** Keyed by transcript path. A transcript only grows, so (mtime, size) is a safe identity. */
const loopEventsCache = new Map<string, LoopEventsCache>();

/** Longer user turns are never a scheduled prompt being replayed; skip storing them. */
const MAX_PROMPT_COMPARE_LENGTH = 4000;

/**
 * Line prefilter. Only these lines can carry a loop event or a fired prompt; everything else
 * — assistant prose, progress records, API blobs — is skipped without a JSON.parse.
 */
const RELEVANT_LINE = /"type":"user"|"CronCreate"|"CronDelete"|"ScheduleWakeup"/;

/**
 * Every loop scheduled by the given sessions.
 *
 * Loops live in the Claude process's memory and nowhere else — CronCreate says so in its own
 * result — so the transcript is the only record there is. That makes this a full read of each
 * session's main transcript, which is why it runs only when the user asks for it from the
 * dashboard and never on the poll. Unchanged transcripts are served from cache.
 *
 * Never throws; a session whose transcript cannot be read is left out.
 */
export async function readLoops(
  claudeHomePath: string,
  sessions: SessionFile[],
  now: number = Date.now()
): Promise<LoopScan> {
  const scannedPaths = new Set<string>();
  const results = await Promise.all(
    sessions.map(async (session): Promise<SessionLoops | null> => {
      try {
        const transcriptPath = await resolveTranscriptPath(claudeHomePath, session);
        if (!transcriptPath) return null;
        scannedPaths.add(transcriptPath);

        const events = await readTranscriptLoopEvents(transcriptPath);
        if (!events) return null;

        const isAlive = isProcessAlive(session.pid);
        const loops = buildLoops(events, { isAlive, now });
        if (loops.length === 0) return null;

        return {
          sessionId: session.sessionId,
          pid: session.pid,
          cwd: session.cwd ?? '',
          label: sessionLabel(session),
          isAlive,
          loops,
        };
      } catch (e) {
        console.warn(
          `Claude Pulse: Failed to read loops: ${e instanceof Error ? e.message : String(e)}`
        );
        return null;
      }
    })
  );

  // Sessions come and go; an entry for one that is no longer listed would never be read again.
  for (const cachedPath of loopEventsCache.keys()) {
    if (!scannedPaths.has(cachedPath)) loopEventsCache.delete(cachedPath);
  }

  const withLoops = results.filter((s): s is SessionLoops => s !== null);
  withLoops.sort((a, b) => {
    if (a.isAlive !== b.isAlive) return a.isAlive ? -1 : 1;
    return newestLoopAt(b) - newestLoopAt(a);
  });

  const all = withLoops.flatMap((s) => s.loops);
  return {
    sessions: withLoops,
    activeCount: all.filter((l) => l.status === 'active').length,
    totalCount: all.length,
    generatedAt: now,
  };
}

export function clearLoopCache(): void {
  loopEventsCache.clear();
}

function newestLoopAt(session: SessionLoops): number {
  return session.loops.reduce((max, l) => Math.max(max, l.createdAt, l.lastRunAt), 0);
}

async function readTranscriptLoopEvents(filePath: string): Promise<TranscriptLoopEvents | null> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (_e) {
    return null;
  }

  const cached = loopEventsCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.events;
  }

  let content: string;
  try {
    content = await fs.promises.readFile(filePath, 'utf-8');
  } catch (_e) {
    return null;
  }

  const events = parseLoopEvents(content);
  loopEventsCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, events });
  return events;
}

interface TranscriptRecord {
  type?: unknown;
  timestamp?: unknown;
  isSidechain?: unknown;
  toolUseResult?: unknown;
  message?: { content?: unknown };
}

interface ContentBlock {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  text?: unknown;
  tool_use_id?: unknown;
  is_error?: unknown;
  content?: unknown;
}

/**
 * Pulls loop events out of a transcript's raw text.
 *
 * Exported and pure so the record shapes can be tested without a filesystem. The shapes are
 * the ones Claude Code writes today:
 *
 *  - assistant `tool_use` CronCreate `{cron, prompt, recurring}`, answered by a user
 *    `tool_result` whose record-level `toolUseResult` is `{id, nextFireAt, ...}`;
 *  - assistant `tool_use` CronDelete `{id}`;
 *  - assistant `tool_use` ScheduleWakeup `{delaySeconds, prompt, reason, stop}`.
 *
 * Only 'user' and 'assistant' records on the main thread count: Claude Code also writes
 * `api-request-blob` records that repeat the same tool_use blocks, and counting those would
 * double every loop. Malformed lines are skipped.
 */
export function parseLoopEvents(content: string): TranscriptLoopEvents {
  const events: TranscriptLoopEvents = {
    creates: [],
    deletes: new Map(),
    wakeups: [],
    userPrompts: [],
  };
  const pendingCreates = new Map<
    string,
    { cron: string; prompt: string; recurring: boolean; at: number }
  >();
  const seenToolUses = new Set<string>();

  for (const line of content.split('\n')) {
    if (!line || !RELEVANT_LINE.test(line)) continue;

    let record: TranscriptRecord;
    try {
      record = JSON.parse(line) as TranscriptRecord;
    } catch (_e) {
      continue;
    }
    if (record.isSidechain === true) continue;
    if (record.type !== 'user' && record.type !== 'assistant') continue;

    const at = parseTimestamp(record.timestamp);
    const body = record.message?.content;

    if (record.type === 'user') {
      const text = userPromptText(body);
      if (text !== null && text.length <= MAX_PROMPT_COMPARE_LENGTH) {
        events.userPrompts.push({ text, at });
      }
      if (!Array.isArray(body)) continue;

      for (const block of body as ContentBlock[]) {
        if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const pending = pendingCreates.get(block.tool_use_id);
        if (!pending) continue;
        pendingCreates.delete(block.tool_use_id);
        if (block.is_error === true) continue;

        const result = asObject(record.toolUseResult);
        const jobId = asString(result?.id) ?? jobIdFromText(block.content);
        if (!jobId) continue;

        events.creates.push({
          jobId,
          cron: pending.cron,
          prompt: pending.prompt,
          recurring: pending.recurring,
          createdAt: pending.at,
          firstFireAt: typeof result?.nextFireAt === 'number' ? result.nextFireAt : null,
        });
      }
      continue;
    }

    if (!Array.isArray(body)) continue;
    for (const block of body as ContentBlock[]) {
      if (block?.type !== 'tool_use' || typeof block.id !== 'string') continue;
      if (seenToolUses.has(block.id)) continue;
      seenToolUses.add(block.id);

      const input = asObject(block.input) ?? {};
      if (block.name === 'CronCreate') {
        const cron = asString(input.cron);
        const prompt = asString(input.prompt);
        if (!cron || !prompt) continue;
        pendingCreates.set(block.id, {
          cron,
          prompt,
          // CronCreate defaults to recurring; only an explicit false makes a one-shot.
          recurring: input.recurring !== false,
          at,
        });
      } else if (block.name === 'CronDelete') {
        const jobId = asString(input.id);
        if (jobId) events.deletes.set(jobId, at);
      } else if (block.name === 'ScheduleWakeup') {
        events.wakeups.push({
          toolUseId: block.id,
          prompt: asString(input.prompt),
          delaySeconds:
            typeof input.delaySeconds === 'number' && Number.isFinite(input.delaySeconds)
              ? input.delaySeconds
              : null,
          reason: asString(input.reason),
          isStop: input.stop === true,
          at,
        });
      }
    }
  }

  // Only a prompt that could be a run of one of this transcript's own jobs is kept. The rest —
  // every message the user ever typed in the session — would otherwise sit in the cache for as
  // long as the window lives, and a transcript with no loops would keep all of them for nothing.
  events.userPrompts = events.userPrompts.filter((p) =>
    events.creates.some((create) => isRunOf(p.text, create.prompt))
  );

  return events;
}

/**
 * Turns parsed events into loops with a status, as of `now`.
 *
 * Pure and exported because every status here is an inference about memory we cannot see,
 * so the ordering below IS the definition, and it is tested directly. A cancellation is
 * Claude Code's own record and outranks everything; then the session dying, which takes
 * every job with it; then the clock.
 */
export function buildLoops(
  events: TranscriptLoopEvents,
  context: { isAlive: boolean; now: number }
): LoopInfo[] {
  const loops = [
    ...events.creates.map((create) => buildCronLoop(create, events, context)),
    ...buildDynamicLoops(events.wakeups, context),
  ];

  loops.sort((a, b) => {
    const aActive = a.status === 'active';
    if (aActive !== (b.status === 'active')) return aActive ? -1 : 1;
    return b.createdAt - a.createdAt;
  });
  return loops;
}

function buildCronLoop(
  create: CronCreateEvent,
  events: TranscriptLoopEvents,
  context: { isAlive: boolean; now: number }
): LoopInfo {
  const { now, isAlive } = context;
  const cancelledAt = events.deletes.get(create.jobId) ?? null;
  const expiresAt = create.recurring ? create.createdAt + LOOP_RECURRING_EXPIRY_MS : null;

  // A run is the scheduled prompt arriving as a user turn while the job existed.
  const runEnd = cancelledAt ?? expiresAt ?? Number.POSITIVE_INFINITY;
  const runs = events.userPrompts.filter(
    (p) =>
      p.at > create.createdAt &&
      p.at <= runEnd + LOOP_FIRE_GRACE_MS &&
      isRunOf(p.text, create.prompt)
  );

  let status: LoopStatus;
  if (cancelledAt !== null) {
    status = 'cancelled';
  } else if (!isAlive) {
    status = 'ended';
  } else if (!create.recurring) {
    const due = create.firstFireAt ?? nextCronRun(create.cron, create.createdAt);
    status =
      runs.length > 0 || (due !== null && now > due + LOOP_FIRE_GRACE_MS) ? 'completed' : 'active';
  } else if (expiresAt !== null && now >= expiresAt) {
    status = 'expired';
  } else {
    status = 'active';
  }

  let nextRunAt: number | null = null;
  if (status === 'active') {
    if (create.firstFireAt !== null && create.firstFireAt > now) {
      nextRunAt = create.firstFireAt;
    } else if (create.recurring) {
      nextRunAt = nextCronRun(create.cron, now);
    } else {
      // A one-shot past its time but inside the grace window: it fires as soon as the
      // session goes idle, which is "now" as far as anyone can say.
      nextRunAt = create.firstFireAt;
    }
    if (nextRunAt !== null && expiresAt !== null && nextRunAt > expiresAt) nextRunAt = null;
  }

  return {
    id: create.jobId,
    kind: 'cron',
    prompt: create.prompt,
    cron: create.cron,
    recurring: create.recurring,
    delaySeconds: null,
    reason: null,
    createdAt: create.createdAt,
    runCount: runs.length,
    lastRunAt: runs.length > 0 ? runs[runs.length - 1].at : 0,
    nextRunAt,
    expiresAt,
    status,
  };
}

/**
 * Groups ScheduleWakeup calls into loops.
 *
 * A dynamic loop has no id of its own: it is a chain of wake-ups that keep passing the same
 * prompt forward. So calls are grouped by prompt, and a `stop` closes the chain — it may omit
 * the prompt, in which case it closes the most recent open one. The same prompt scheduled
 * again after a stop is a new loop.
 */
function buildDynamicLoops(
  wakeups: WakeupEvent[],
  context: { isAlive: boolean; now: number }
): LoopInfo[] {
  interface Chain {
    id: string;
    prompt: string;
    createdAt: number;
    runCount: number;
    lastRunAt: number;
    delaySeconds: number | null;
    reason: string | null;
    stoppedAt: number | null;
  }

  const chains: Chain[] = [];
  const open = new Map<string, Chain>();

  for (const wakeup of wakeups) {
    if (wakeup.isStop) {
      const target = wakeup.prompt
        ? open.get(wakeup.prompt)
        : [...open.values()].sort((a, b) => b.lastRunAt - a.lastRunAt)[0];
      if (target) {
        target.stoppedAt = wakeup.at;
        open.delete(target.prompt);
      }
      continue;
    }
    if (!wakeup.prompt) continue;

    let chain = open.get(wakeup.prompt);
    if (!chain) {
      chain = {
        id: wakeup.toolUseId,
        prompt: wakeup.prompt,
        createdAt: wakeup.at,
        runCount: 0,
        lastRunAt: 0,
        delaySeconds: null,
        reason: null,
        stoppedAt: null,
      };
      chains.push(chain);
      open.set(wakeup.prompt, chain);
    }
    chain.runCount++;
    chain.lastRunAt = wakeup.at;
    chain.delaySeconds = wakeup.delaySeconds;
    chain.reason = wakeup.reason ?? chain.reason;
  }

  return chains.map((chain) => {
    const scheduledFor =
      chain.delaySeconds !== null && chain.lastRunAt > 0
        ? chain.lastRunAt + chain.delaySeconds * 1000
        : null;

    let status: LoopStatus;
    if (chain.stoppedAt !== null) {
      status = 'cancelled';
    } else if (!context.isAlive) {
      status = 'ended';
    } else if (scheduledFor !== null && context.now > scheduledFor + LOOP_FIRE_GRACE_MS) {
      // The wake-up came and went without the loop scheduling another.
      status = 'completed';
    } else {
      status = 'active';
    }

    return {
      id: chain.id,
      kind: 'dynamic' as const,
      prompt: chain.prompt,
      cron: null,
      recurring: true,
      delaySeconds: chain.delaySeconds,
      reason: chain.reason,
      createdAt: chain.createdAt,
      runCount: chain.runCount,
      lastRunAt: chain.lastRunAt,
      nextRunAt: status === 'active' ? scheduledFor : null,
      expiresAt: null,
      status,
    };
  });
}

/**
 * Whether a user turn is a fire of the given scheduled prompt.
 *
 * Either the prompt verbatim, or — for a prompt that is a slash command — the command record
 * Claude Code writes when it expands one.
 */
function isRunOf(text: string, prompt: string): boolean {
  const target = prompt.trim();
  if (text === target) return true;
  if (!target.startsWith('/')) return false;
  const command = target.split(/\s+/)[0];
  return text.includes(`<command-name>${command}</command-name>`);
}

/** The text of a user turn the user (or the scheduler) typed. Null for tool results. */
function userPromptText(body: unknown): string | null {
  if (typeof body === 'string') return body.trim() || null;
  if (!Array.isArray(body)) return null;

  const parts: string[] = [];
  for (const block of body as ContentBlock[]) {
    if (block?.type === 'tool_result') return null;
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  const text = parts.join('\n').trim();
  return text || null;
}

/** Fallback for a result without `toolUseResult`: 'Scheduled recurring job d90aeba3 (...)'. */
function jobIdFromText(content: unknown): string | null {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? (content as ContentBlock[])
            .map((b) => (typeof b?.text === 'string' ? b.text : ''))
            .join(' ')
        : '';
  const match = /\b(?:task|job)\s+([0-9a-f]{6,})\b/i.exec(text);
  return match ? match[1] : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}
