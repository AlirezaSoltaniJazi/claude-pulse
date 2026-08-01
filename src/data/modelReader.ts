import * as fs from 'fs';
import * as path from 'path';
import { EffortSource, ModelInfo, ModelSource, SessionFile } from '../types';
import { formatModelName, parseModelId } from '../utils/formatting';
import {
  MODEL_COMMAND_STDOUT_PATTERN,
  MODEL_INFO_CACHE_TTL_MS,
  SYNTHETIC_MODEL_ID,
  TRANSCRIPT_TAIL_BYTES,
  TRANSCRIPT_TAIL_MAX_BYTES,
} from '../constants';

/** The last assistant turn of a session. Authoritative, but only lands once a turn completes. */
interface AssistantEvidence {
  model: string;
  effort: string | null;
  /** Record timestamp in epoch ms. 0 when the record carried no parsable timestamp. */
  at: number;
}

/** This session's own `/model` invocation. Authoritative, and lands at the next prompt submit. */
interface CommandEvidence {
  model: string;
  at: number;
}

/** Everything the transcript tail has to say about the model. Cached per (path, mtime, size). */
export interface TranscriptEvidence {
  assistant: AssistantEvidence | null;
  command: CommandEvidence | null;
}

/** The global `/model` and `/effort` selections, with the mtime that dates them. */
export interface SettingsEvidence {
  model: string | null;
  effortLevel: string | null;
  /** settings.json mtime in epoch ms. 0 when the file is absent. */
  at: number;
}

/** A settings.json "model" value, interpreted. */
export type ModelSelection =
  { kind: 'alias'; family: string; raw: string } | { kind: 'full'; raw: string };

export interface ResolvedModelSelection {
  model: string | null;
  source: ModelSource | null;
}

interface TranscriptEvidenceCache {
  sessionId: string;
  transcriptPath: string;
  mtimeMs: number;
  size: number;
  evidence: TranscriptEvidence;
  timestamp: number;
}

interface TranscriptPathCache {
  sessionId: string;
  /** Null is cached too — it stops the directory scan repeating on every poll. */
  transcriptPath: string | null;
  timestamp: number;
}

interface SettingsCache {
  settingsPath: string;
  evidence: SettingsEvidence;
}

let transcriptEvidenceCache: TranscriptEvidenceCache | null = null;
let transcriptPathCache: TranscriptPathCache | null = null;
let settingsCache: SettingsCache | null = null;

/**
 * Resolves the model and reasoning effort level currently in use by the given session.
 *
 * Three sources of evidence, ranked, each carrying a timestamp:
 *
 *   1. this session's `/model` stdout record — per-session, resolved to a full id
 *   2. this session's last assistant record  — per-session, resolved to a full id
 *   3. `<claudeHome>/settings.json`          — GLOBAL and last-write-wins across every
 *                                              concurrent session, so it is consulted only
 *                                              when it is newer than everything (1) and (2)
 *                                              have to say. See resolveModelSelection().
 *
 * Returns null when there is no session, no transcript, or nothing to show. Never throws.
 */
export async function readModelInfo(
  claudeHomePath: string,
  session: SessionFile | null,
  isSessionLive: boolean
): Promise<ModelInfo | null> {
  if (!session?.sessionId) return null;

  try {
    const transcriptPath = await resolveTranscriptPath(claudeHomePath, session);

    const [transcript, settings] = await Promise.all([
      readTranscriptEvidenceIfAny(session.sessionId, transcriptPath),
      readSettingsEvidence(claudeHomePath),
    ]);

    return buildModelInfo(transcript, settings, isSessionLive);
  } catch (e) {
    console.warn(
      `Claude Pulse: Failed to read model info: ${e instanceof Error ? e.message : String(e)}`
    );
    return null;
  }
}

export function clearModelCache(): void {
  transcriptEvidenceCache = null;
  transcriptPathCache = null;
  settingsCache = null;
}

/**
 * Encodes a working directory into its `~/.claude/projects/` directory name.
 * Verified against real directories: '/' and '.' both become '-'.
 *
 * The encoding of other characters (underscore, space, unicode) is unverified, which is
 * exactly why resolveTranscriptPath falls back to scanning. Do NOT delete that fallback
 * on the assumption that this function is always right.
 */
export function encodeProjectDirName(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

/**
 * Interprets a settings.json "model" value.
 *
 * Returns null when the value does not name a model — absent, blank, 'default' (resolved
 * server-side) or 'opusplan' (a routing mode). An alias like 'opus[1m]' names a family but
 * carries no version; there is no local alias table, and measurement shows the mapping moves
 * ('opus[1m]' resolved to claude-opus-4-8 in July and 'default' to claude-opus-5 in August),
 * so a static one would be wrong within weeks.
 */
export function classifySelection(raw: string | null | undefined): ModelSelection | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length === 0) return null;

  const parsed = parseModelId(value);
  if (!parsed) return null;

  return parsed.version.length > 0
    ? { kind: 'full', raw: value }
    : { kind: 'alias', family: parsed.family, raw: value };
}

/**
 * Decides which model to display, given what this session's transcript proves and what the
 * global settings.json claims.
 *
 * The rule: **settings.json is consulted only when it is strictly newer than every piece of
 * model evidence this session has produced** — i.e. only when this session is incapable of
 * contradicting it. And when it is consulted and the two agree on the family, the transcript's
 * id is displayed anyway, so the version number is never lost to a bare alias.
 *
 * That second clause is what keeps the common case honest: an optimistic value is only ever
 * *visible* when the last global selection is a different family from what this session last
 * ran. Pure and side-effect free so it can be tested without touching the filesystem.
 */
export function resolveModelSelection(
  transcript: { model: string | null; at: number; source: ModelSource | null },
  settings: { model: string | null; at: number }
): ResolvedModelSelection {
  const fromTranscript: ResolvedModelSelection = {
    model: transcript.model,
    source: transcript.model ? transcript.source : null,
  };

  const selection = classifySelection(settings.model);
  // No usable global selection, or this session has spoken since it was made.
  if (!selection) return fromTranscript;
  if (settings.at <= transcript.at) return fromTranscript;

  if (selection.kind === 'alias') {
    // Families agree: keep the transcript id, which carries a version the alias does not.
    const parsed = parseModelId(transcript.model);
    if (parsed && parsed.family === selection.family) return fromTranscript;
    return { model: selection.raw, source: 'settings' };
  }

  // A full id that renders identically to what the session last ran is the same choice.
  if (transcript.model && formatModelName(transcript.model) === formatModelName(selection.raw)) {
    return fromTranscript;
  }
  return { model: selection.raw, source: 'settings' };
}

/**
 * Effort has the same shape as the model but no tier-1 evidence: no `/effort` command writes
 * a transcript record. So the transcript value wins unless settings.json is newer, and the
 * long-standing "record predates the effort field" fallback is preserved untouched.
 *
 * `isSessionLive` gates the override only — a dead session cannot have made a new selection,
 * but it can still be missing the field entirely.
 */
export function resolveEffort(
  transcript: { effort: string | null; at: number },
  settings: { effortLevel: string | null; at: number },
  isSessionLive: boolean
): { effort: string | null; effortSource: EffortSource | null } {
  if (!transcript.effort) {
    return settings.effortLevel
      ? { effort: settings.effortLevel, effortSource: 'settings' }
      : { effort: null, effortSource: null };
  }

  if (isSessionLive && settings.effortLevel && settings.at > transcript.at) {
    return { effort: settings.effortLevel, effortSource: 'settings' };
  }

  return { effort: transcript.effort, effortSource: 'transcript' };
}

/**
 * Hybrid lookup: cheap encoded-path probe first, one directory scan as fallback.
 *
 * Exported so the extension can point a file watcher at the same transcript readModelInfo
 * reads. Back-to-back calls hit `transcriptPathCache`, so re-targeting the watch is free.
 */
export async function resolveTranscriptPath(
  claudeHomePath: string,
  session: SessionFile
): Promise<string | null> {
  const cached = transcriptPathCache;
  if (
    cached &&
    cached.sessionId === session.sessionId &&
    Date.now() - cached.timestamp < MODEL_INFO_CACHE_TTL_MS
  ) {
    return cached.transcriptPath;
  }

  const projectsDir = path.join(claudeHomePath, 'projects');
  let resolved: string | null = null;

  if (session.cwd) {
    const candidate = path.join(
      projectsDir,
      encodeProjectDirName(session.cwd),
      `${session.sessionId}.jsonl`
    );
    if (await isReadableFile(candidate)) {
      resolved = candidate;
    }
  }

  if (!resolved) {
    try {
      // Non-recursive on purpose: subagent transcripts live in <sessionId>/subagents/**
      // and use different models, so a recursive walk would surface the wrong one.
      const dirs = await fs.promises.readdir(projectsDir, { withFileTypes: true });
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const candidate = path.join(projectsDir, dir.name, `${session.sessionId}.jsonl`);
        if (await isReadableFile(candidate)) {
          resolved = candidate;
          break;
        }
      }
    } catch (_e) {
      // projects directory missing or unreadable
    }
  }

  transcriptPathCache = {
    sessionId: session.sessionId,
    transcriptPath: resolved,
    timestamp: Date.now(),
  };
  return resolved;
}

/** Applies both resolution rules and folds the result into the shape the UI consumes. */
/** Transcript evidence, or the empty set when the session has not written one we can read. */
const NO_TRANSCRIPT_EVIDENCE: TranscriptEvidence = { assistant: null, command: null };

/**
 * Reads transcript evidence, tolerating a session that has no readable transcript.
 *
 * A brand-new session writes nothing for the first ~100 seconds, and a transcript can also
 * vanish between being resolved and being stat'd. Returning empty evidence rather than
 * bailing lets the caller still surface the global selection from settings.json — showing
 * nothing at all reads as the feature being broken.
 */
async function readTranscriptEvidenceIfAny(
  sessionId: string,
  transcriptPath: string | null
): Promise<TranscriptEvidence> {
  // No path resolved is the normal brand-new-session case, not a failure — stay quiet.
  if (!transcriptPath) return NO_TRANSCRIPT_EVIDENCE;

  try {
    const stat = await fs.promises.stat(transcriptPath);
    return await readTranscriptEvidence(sessionId, transcriptPath, stat);
  } catch (e) {
    // An unreadable transcript IS worth reporting — the caller degrades to the global
    // selection, so this would otherwise fail completely silently.
    console.warn(
      `Claude Pulse: Failed to read transcript: ${e instanceof Error ? e.message : String(e)}`
    );
    return NO_TRANSCRIPT_EVIDENCE;
  }
}

function buildModelInfo(
  transcript: TranscriptEvidence,
  settings: SettingsEvidence,
  isSessionLive: boolean
): ModelInfo | null {
  const transcriptModel = pickTranscriptModel(transcript);

  // A dead session cannot have made the latest global selection, so it never inherits it.
  const selection = isSessionLive
    ? resolveModelSelection(transcriptModel, { model: settings.model, at: settings.at })
    : { model: transcriptModel.model, source: transcriptModel.source };

  const { effort, effortSource } = resolveEffort(
    { effort: transcript.assistant?.effort ?? null, at: transcript.assistant?.at ?? 0 },
    { effortLevel: settings.effortLevel, at: settings.at },
    isSessionLive
  );

  if (selection.model === null && effort === null) return null;

  return {
    model: selection.model,
    modelSource: selection.model ? selection.source : null,
    effort,
    effortSource,
    isSessionLive,
  };
}

/** Later evidence wins: a `/model` after the last turn supersedes it, a turn after it confirms it. */
function pickTranscriptModel(evidence: TranscriptEvidence): {
  model: string | null;
  at: number;
  source: ModelSource | null;
} {
  const { assistant, command } = evidence;

  if (command && (!assistant || command.at >= assistant.at)) {
    return { model: command.model, at: command.at, source: 'command' };
  }
  if (assistant) {
    return { model: assistant.model, at: assistant.at, source: 'transcript' };
  }
  return { model: null, at: 0, source: null };
}

async function isReadableFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile();
  } catch (_e) {
    return false;
  }
}

/**
 * Transcripts are append-only, so an unchanged (mtime, size) pair proves no new records.
 * The TTL is only an upper bound on how long that assumption is trusted.
 *
 * settings.json is deliberately NOT part of this key: it is cached separately on its own
 * mtime, so a `/model` in another window never costs a re-read of this transcript's tail.
 */
async function readTranscriptEvidence(
  sessionId: string,
  transcriptPath: string,
  stat: fs.Stats
): Promise<TranscriptEvidence> {
  const cached = transcriptEvidenceCache;
  if (
    cached &&
    cached.sessionId === sessionId &&
    cached.transcriptPath === transcriptPath &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size &&
    Date.now() - cached.timestamp < MODEL_INFO_CACHE_TTL_MS
  ) {
    return cached.evidence;
  }

  let evidence = await scanTranscriptTail(transcriptPath, stat.size, TRANSCRIPT_TAIL_BYTES);
  // Widen only for a missing assistant record: it is the sole source of effort, and the
  // command record alone cannot replace it.
  if (!evidence.assistant && stat.size > TRANSCRIPT_TAIL_BYTES) {
    evidence = await scanTranscriptTail(transcriptPath, stat.size, TRANSCRIPT_TAIL_MAX_BYTES);
  }

  transcriptEvidenceCache = {
    sessionId,
    transcriptPath,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    evidence,
    timestamp: Date.now(),
  };
  return evidence;
}

/**
 * Reads the last `windowBytes` of the transcript and walks backwards, taking the first
 * assistant record and the first `/model` record it meets. Malformed lines are skipped.
 */
async function scanTranscriptTail(
  filePath: string,
  size: number,
  windowBytes: number
): Promise<TranscriptEvidence> {
  const empty: TranscriptEvidence = { assistant: null, command: null };

  const offset = Math.max(0, size - windowBytes);
  const length = size - offset;
  if (length <= 0) return empty;

  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    // `size` came from a stat that may already be stale: a rewrite or compaction can shrink
    // the file before this read lands, leaving the tail of the buffer as NUL padding. Decoding
    // that padding produces lines that silently fail JSON.parse, which reads as "no evidence"
    // at exactly the moment the fallback matters most. Trust bytesRead, not the stat.
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead <= 0) return empty;
    const lines = buffer.subarray(0, bytesRead).toString('utf-8').split('\n');

    // A non-zero offset almost certainly slices the first line mid-record. When the
    // offset is 0 every line is whole, so dropping one would lose a single-line file.
    if (offset > 0) lines.shift();

    let assistant: AssistantEvidence | null = null;
    let command: CommandEvidence | null = null;

    for (let i = lines.length - 1; i >= 0; i--) {
      if (assistant && command) break;

      const line = lines[i].trim();
      if (!line) continue;

      try {
        const record = JSON.parse(line) as {
          type?: unknown;
          effort?: unknown;
          isSidechain?: unknown;
          timestamp?: unknown;
          message?: { model?: unknown; content?: unknown };
        };

        if (record.isSidechain === true) continue;
        const at = parseTimestamp(record.timestamp);

        if (!assistant && record.type === 'assistant') {
          const model = record.message?.model;
          if (typeof model !== 'string') continue;
          const trimmedModel = model.trim();
          // '<synthetic>' marks injected interrupt/API-error placeholders, not a real model.
          if (!trimmedModel || trimmedModel === SYNTHETIC_MODEL_ID) continue;

          const effort = typeof record.effort === 'string' ? record.effort.trim() : '';
          assistant = { model: trimmedModel, effort: effort || null, at };
          continue;
        }

        if (!command && record.type === 'user') {
          const model = extractCommandModel(record.message?.content);
          if (model) command = { model, at };
        }
      } catch (_e) {
        // Skip malformed JSONL lines (the file may be mid-append)
      }
    }

    return { assistant, command };
  } finally {
    await handle.close();
  }
}

/**
 * Pulls the resolved model id out of a `/model` stdout record. `content` is a plain string on
 * these records; tool results carry an array instead, which is skipped rather than crashed on.
 */
function extractCommandModel(content: unknown): string | null {
  if (typeof content !== 'string') return null;
  const match = MODEL_COMMAND_STDOUT_PATTERN.exec(content);
  if (!match) return null;

  const value = match[1].trim();
  // Defensive: every observed record carries a resolved id, but a selector is not a model.
  if (!value || !classifySelection(value)) return null;
  return value;
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Global `/model` and `/effort` selections from `<claudeHome>/settings.json`, parsed as JSON,
 * never regexed.
 *
 * Keyed on mtime rather than a TTL: the resolution rules compare this file's age against
 * transcript timestamps, so serving a value whose recorded `at` no longer matches the file on
 * disk would make the comparison lie. A TTL cannot give that guarantee; an mtime key can.
 */
async function readSettingsEvidence(claudeHomePath: string): Promise<SettingsEvidence> {
  const settingsPath = path.join(claudeHomePath, 'settings.json');

  let mtimeMs = 0;
  try {
    mtimeMs = (await fs.promises.stat(settingsPath)).mtimeMs;
  } catch (_e) {
    // Missing settings.json — mtime 0 means "no global selection", and never wins a comparison
  }

  const cached = settingsCache;
  if (cached && cached.settingsPath === settingsPath && cached.evidence.at === mtimeMs) {
    return cached.evidence;
  }

  const evidence: SettingsEvidence = { model: null, effortLevel: null, at: mtimeMs };
  if (mtimeMs > 0) {
    try {
      const content = await fs.promises.readFile(settingsPath, 'utf-8');
      const parsed = JSON.parse(content) as { model?: unknown; effortLevel?: unknown };
      if (typeof parsed.effortLevel === 'string' && parsed.effortLevel.trim()) {
        evidence.effortLevel = parsed.effortLevel.trim();
      }
      if (typeof parsed.model === 'string' && parsed.model.trim()) {
        evidence.model = parsed.model.trim();
      }
    } catch (_e) {
      // Missing or malformed settings.json — no global selection available
    }
  }

  settingsCache = { settingsPath, evidence };
  return evidence;
}
