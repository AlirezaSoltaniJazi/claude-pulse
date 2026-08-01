import * as fs from 'fs';
import * as path from 'path';
import { EffortSource, ModelInfo, SessionFile } from '../types';
import {
  MODEL_INFO_CACHE_TTL_MS,
  SETTINGS_CACHE_TTL_MS,
  SYNTHETIC_MODEL_ID,
  TRANSCRIPT_TAIL_BYTES,
  TRANSCRIPT_TAIL_MAX_BYTES,
} from '../constants';

/** Model + effort as resolved from disk, before session liveness is applied. */
interface ResolvedModel {
  model: string | null;
  effort: string | null;
  effortSource: EffortSource | null;
}

interface ModelInfoCache {
  sessionId: string;
  transcriptPath: string;
  mtimeMs: number;
  size: number;
  data: ResolvedModel | null;
  timestamp: number;
}

interface TranscriptPathCache {
  sessionId: string;
  /** Null is cached too — it stops the directory scan repeating on every poll. */
  transcriptPath: string | null;
  timestamp: number;
}

interface SettingsCache {
  effortLevel: string | null;
  timestamp: number;
}

let modelInfoCache: ModelInfoCache | null = null;
let transcriptPathCache: TranscriptPathCache | null = null;
let settingsCache: SettingsCache | null = null;

/**
 * Resolves the model and reasoning effort level currently in use by the given session.
 *
 * Reads the tail of `<claudeHome>/projects/<encoded-cwd>/<sessionId>.jsonl` and walks
 * backwards to the last real assistant record. Effort falls back to the global
 * `effortLevel` in `<claudeHome>/settings.json` when the record predates the field.
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
    if (!transcriptPath) return null;

    const stat = await fs.promises.stat(transcriptPath);

    // Transcripts are append-only, so an unchanged (mtime, size) pair proves no new
    // records. The TTL is only an upper bound on how long that assumption is trusted.
    const cached = modelInfoCache;
    if (
      cached &&
      cached.sessionId === session.sessionId &&
      cached.transcriptPath === transcriptPath &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size &&
      Date.now() - cached.timestamp < MODEL_INFO_CACHE_TTL_MS
    ) {
      return toModelInfo(cached.data, isSessionLive);
    }

    let record = await findLastAssistantRecord(transcriptPath, stat.size, TRANSCRIPT_TAIL_BYTES);
    if (!record && stat.size > TRANSCRIPT_TAIL_BYTES) {
      record = await findLastAssistantRecord(transcriptPath, stat.size, TRANSCRIPT_TAIL_MAX_BYTES);
    }

    let effort = record?.effort ?? null;
    let effortSource: EffortSource | null = effort ? 'transcript' : null;
    if (!effort) {
      const globalEffort = await readGlobalEffortLevel(claudeHomePath);
      if (globalEffort) {
        effort = globalEffort;
        effortSource = 'settings';
      }
    }

    const model = record?.model ?? null;
    const data: ResolvedModel | null =
      model === null && effort === null ? null : { model, effort, effortSource };

    modelInfoCache = {
      sessionId: session.sessionId,
      transcriptPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      data,
      timestamp: Date.now(),
    };

    return toModelInfo(data, isSessionLive);
  } catch (e) {
    console.warn(
      `Claude Pulse: Failed to read model info: ${e instanceof Error ? e.message : String(e)}`
    );
    return null;
  }
}

export function clearModelCache(): void {
  modelInfoCache = null;
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

function toModelInfo(data: ResolvedModel | null, isSessionLive: boolean): ModelInfo | null {
  if (!data) return null;
  return { ...data, isSessionLive };
}

/** Hybrid lookup: cheap encoded-path probe first, one directory scan as fallback. */
async function resolveTranscriptPath(
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

async function isReadableFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile();
  } catch (_e) {
    return false;
  }
}

/**
 * Reads the last `windowBytes` of the transcript and walks backwards to the first
 * record that represents a real assistant turn. Malformed lines are skipped.
 */
async function findLastAssistantRecord(
  filePath: string,
  size: number,
  windowBytes: number
): Promise<{ model: string; effort: string | null } | null> {
  const offset = Math.max(0, size - windowBytes);
  const length = size - offset;
  if (length <= 0) return null;

  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, offset);
    const lines = buffer.toString('utf-8').split('\n');

    // A non-zero offset almost certainly slices the first line mid-record. When the
    // offset is 0 every line is whole, so dropping one would lose a single-line file.
    if (offset > 0) lines.shift();

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;

      try {
        const record = JSON.parse(line) as {
          type?: unknown;
          effort?: unknown;
          isSidechain?: unknown;
          message?: { model?: unknown };
        };

        if (record.type !== 'assistant') continue;
        if (record.isSidechain === true) continue;

        const model = record.message?.model;
        if (typeof model !== 'string') continue;
        const trimmedModel = model.trim();
        // '<synthetic>' marks injected interrupt/API-error placeholders, not a real model.
        if (!trimmedModel || trimmedModel === SYNTHETIC_MODEL_ID) continue;

        const effort = typeof record.effort === 'string' ? record.effort.trim() : '';
        return { model: trimmedModel, effort: effort || null };
      } catch (_e) {
        // Skip malformed JSONL lines (the file may be mid-append)
      }
    }

    return null;
  } finally {
    await handle.close();
  }
}

/** Global effort default from `<claudeHome>/settings.json`. Parsed as JSON, never regexed. */
async function readGlobalEffortLevel(claudeHomePath: string): Promise<string | null> {
  if (settingsCache && Date.now() - settingsCache.timestamp < SETTINGS_CACHE_TTL_MS) {
    return settingsCache.effortLevel;
  }

  let effortLevel: string | null = null;
  try {
    const content = await fs.promises.readFile(path.join(claudeHomePath, 'settings.json'), 'utf-8');
    const parsed = JSON.parse(content) as { effortLevel?: unknown };
    if (typeof parsed.effortLevel === 'string' && parsed.effortLevel.trim()) {
      effortLevel = parsed.effortLevel.trim();
    }
  } catch (_e) {
    // Missing or malformed settings.json — no global default available
  }

  settingsCache = { effortLevel, timestamp: Date.now() };
  return effortLevel;
}
