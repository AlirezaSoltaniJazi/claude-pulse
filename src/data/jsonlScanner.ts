import * as fs from 'fs';
import * as path from 'path';
import { ModelTokenBreakdown, WeeklyUsageSummary } from '../types';
import { getCurrentWeekBounds } from '../utils/dateUtils';
import { forEachLine } from '../utils/jsonlLines';
import { SCAN_CACHE_TTL_MS, SYNTHETIC_MODEL_ID } from '../constants';

interface ScanCache {
  data: WeeklyUsageSummary;
  timestamp: number;
}

/** One transcript's contribution to the week, and how far into the file it has been read. */
interface FileCacheEntry {
  mtimeMs: number;
  size: number;
  /** Byte offset just past the last complete line read. The next read resumes here. */
  consumedUpTo: number;
  /** The week this result counts. A new week invalidates it — older events no longer count. */
  weekStartMs: number;
  result: FileScanResult;
}

let scanCache: ScanCache | null = null;
/**
 * Per-transcript results, keyed by path.
 *
 * This is what keeps the scan cheap. Transcripts are append-only, so an unchanged
 * (mtime, size) proves nothing new happened and a larger size means only the tail is new.
 * Without it every scan re-read and re-parsed every transcript of the week — ~300 MB on a
 * working machine, taking the extension host to ~650 MB at peak, once a minute. Pruned to
 * the files the latest scan saw, so it never outgrows one week of transcripts.
 */
const fileCache = new Map<string, FileCacheEntry>();
/**
 * The scan in progress, shared by every caller that arrives while it runs. Session-file
 * events come in bursts, and each one used to start its own full scan in parallel.
 */
let inFlightScan: Promise<WeeklyUsageSummary | null> | null = null;

/**
 * Scans JSONL session files to compute accurate weekly usage stats.
 * Only scans files modified since the start of the current week.
 */
export async function scanWeeklyUsage(
  claudeHomePath: string,
  forceRefresh: boolean = false
): Promise<WeeklyUsageSummary | null> {
  if (!forceRefresh && scanCache && Date.now() - scanCache.timestamp < SCAN_CACHE_TTL_MS) {
    return scanCache.data;
  }
  // A scan already running is at most a moment old — as fresh as a forced one would be.
  if (inFlightScan) return inFlightScan;

  inFlightScan = runScan(claudeHomePath).finally(() => {
    inFlightScan = null;
  });
  return inFlightScan;
}

async function runScan(claudeHomePath: string): Promise<WeeklyUsageSummary | null> {
  try {
    const { weekStart, weekEnd, weekStartDate } = getCurrentWeekBounds();
    const projectsDir = path.join(claudeHomePath, 'projects');

    if (!fs.existsSync(projectsDir)) {
      return null;
    }

    // Find all project directories
    const projectDirs = await fs.promises.readdir(projectsDir, { withFileTypes: true });

    let totalMessages = 0;
    let totalToolCalls = 0;
    let totalTokens = 0;
    let sonnetTokens = 0;
    const tokensByModel: Record<string, number> = {};
    const modelBreakdown: Record<string, ModelTokenBreakdown> = {};
    const hourCounts: Record<string, number> = {};
    const sessionIds = new Set<string>();

    const weekStartMs = weekStartDate.getTime();
    const seen = new Set<string>();

    for (const dir of projectDirs) {
      if (!dir.isDirectory()) continue;

      const dirPath = path.join(projectsDir, dir.name);
      let files: fs.Dirent[];
      try {
        files = await fs.promises.readdir(dirPath, { withFileTypes: true });
      } catch (_e) {
        continue;
      }

      const jsonlFiles = files.filter((f) => f.name.endsWith('.jsonl'));

      for (const file of jsonlFiles) {
        const filePath = path.join(dirPath, file.name);

        // Quick check: skip files not modified since week start
        let stat: fs.Stats;
        try {
          stat = await fs.promises.stat(filePath);
          if (stat.mtimeMs < weekStartMs) continue;
        } catch (_e) {
          continue;
        }
        seen.add(filePath);

        const sessionId = file.name.replace('.jsonl', '');
        try {
          const result = await scanFileCached(filePath, stat, weekStartDate);
          if (result.messageCount > 0) {
            sessionIds.add(sessionId);
            totalMessages += result.messageCount;
            totalToolCalls += result.toolCallCount;

            for (const [model, breakdown] of Object.entries(result.modelBreakdown)) {
              addBreakdown(modelBreakdown, model, breakdown);
              tokensByModel[model] = (tokensByModel[model] ?? 0) + breakdown.totalTokens;
              totalTokens += breakdown.totalTokens;
              if (model.toLowerCase().includes('sonnet')) {
                sonnetTokens += breakdown.totalTokens;
              }
            }

            for (const [hour, count] of Object.entries(result.hourCounts)) {
              hourCounts[hour] = (hourCounts[hour] ?? 0) + count;
            }
          }
        } catch (_e) {
          // Skip problematic files
        }
      }
    }

    for (const cachedPath of fileCache.keys()) {
      if (!seen.has(cachedPath)) fileCache.delete(cachedPath);
    }

    const data: WeeklyUsageSummary = {
      weekStart,
      weekEnd,
      totalMessages,
      totalSessions: sessionIds.size,
      totalToolCalls,
      tokensByModel,
      modelBreakdown,
      hourCounts,
      totalTokens,
      sonnetTokens,
    };

    scanCache = { data, timestamp: Date.now() };
    return data;
  } catch (_e) {
    return scanCache?.data ?? null;
  }
}

/**
 * Drops the weekly summary so the next call re-scans. The per-file cache is kept on purpose:
 * it is keyed on each file's own (mtime, size), so it cannot serve stale data, and dropping it
 * would turn every press of Refresh back into a full read of the week's transcripts.
 */
export function clearScanCache(): void {
  scanCache = null;
}

/** Also drops the per-file cache. For tests, and for a change of Claude home directory. */
export function clearAllScanCaches(): void {
  scanCache = null;
  fileCache.clear();
}

interface FileScanResult {
  messageCount: number;
  toolCallCount: number;
  modelBreakdown: Record<string, ModelTokenBreakdown>;
  hourCounts: Record<string, number>;
}

const EMPTY_BREAKDOWN: ModelTokenBreakdown = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  totalTokens: 0,
};

/** Folds one model's counts into an accumulator, creating the entry on first sight. */
function addBreakdown(
  target: Record<string, ModelTokenBreakdown>,
  model: string,
  add: ModelTokenBreakdown
): void {
  const current = target[model] ?? { ...EMPTY_BREAKDOWN };
  target[model] = {
    inputTokens: current.inputTokens + add.inputTokens,
    outputTokens: current.outputTokens + add.outputTokens,
    cacheReadInputTokens: current.cacheReadInputTokens + add.cacheReadInputTokens,
    cacheCreationInputTokens: current.cacheCreationInputTokens + add.cacheCreationInputTokens,
    totalTokens: current.totalTokens + add.totalTokens,
  };
}

/**
 * One file's result, read as little of the file as its (mtime, size) allows.
 *
 *  - unchanged      → the cached result, no read at all;
 *  - grown          → the cached result plus only the appended bytes;
 *  - anything else  → a full streamed read (first sight, a rewrite, or a new week).
 */
async function scanFileCached(
  filePath: string,
  stat: fs.Stats,
  weekStartDate: Date
): Promise<FileScanResult> {
  const weekStartMs = weekStartDate.getTime();
  const cached = fileCache.get(filePath);
  const sameWeek = cached !== undefined && cached.weekStartMs === weekStartMs;

  if (sameWeek && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.result;
  }

  const isAppend = sameWeek && stat.size > cached.size;
  const result = isAppend ? cloneResult(cached.result) : emptyResult();
  const consumedUpTo = await scanLines(
    filePath,
    isAppend ? cached.consumedUpTo : 0,
    weekStartDate,
    result
  );

  fileCache.set(filePath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    consumedUpTo,
    weekStartMs,
    result,
  });
  return result;
}

function emptyResult(): FileScanResult {
  return { messageCount: 0, toolCallCount: 0, modelBreakdown: {}, hourCounts: {} };
}

/** Deep enough that adding to the copy never mutates a result another scan returned. */
function cloneResult(result: FileScanResult): FileScanResult {
  const modelBreakdown: Record<string, ModelTokenBreakdown> = {};
  for (const [model, breakdown] of Object.entries(result.modelBreakdown)) {
    modelBreakdown[model] = { ...breakdown };
  }
  return {
    messageCount: result.messageCount,
    toolCallCount: result.toolCallCount,
    modelBreakdown,
    hourCounts: { ...result.hourCounts },
  };
}

/** Streams lines from `start`, adding this week's events into `into`. Returns the resume offset. */
async function scanLines(
  filePath: string,
  start: number,
  weekStartDate: Date,
  into: FileScanResult
): Promise<number> {
  const { modelBreakdown, hourCounts } = into;

  return forEachLine(filePath, start, (line) => {
    try {
      const event = JSON.parse(line);

      // Check timestamp is within current week
      let eventDate: Date | null = null;
      if (event.timestamp) {
        eventDate = new Date(event.timestamp);
        if (eventDate < weekStartDate) return;
        if (Number.isNaN(eventDate.getTime())) eventDate = null;
      }

      if (event.type === 'assistant' && event.message) {
        const msg = event.message;
        into.messageCount++;

        // Local hour, not UTC: the histogram answers 'when do I work', a question about the
        // wall clock in front of the user.
        if (eventDate) {
          const hour = eventDate.getHours().toString();
          hourCounts[hour] = (hourCounts[hour] ?? 0) + 1;
        }

        // '<synthetic>' marks injected interrupt/API-error placeholders — it is not a model,
        // and listing it as one in the breakdown table would be noise.
        const model = msg.model ?? 'unknown';
        const usage = model === SYNTHETIC_MODEL_ID ? null : msg.usage;
        if (usage) {
          const inputTokens = usage.input_tokens ?? 0;
          const outputTokens = usage.output_tokens ?? 0;
          const cacheReadInputTokens = usage.cache_read_input_tokens ?? 0;
          const cacheCreationInputTokens = usage.cache_creation_input_tokens ?? 0;
          addBreakdown(modelBreakdown, model, {
            inputTokens,
            outputTokens,
            cacheReadInputTokens,
            cacheCreationInputTokens,
            totalTokens:
              inputTokens + outputTokens + cacheReadInputTokens + cacheCreationInputTokens,
          });
        }

        // Count tool uses in content
        if (msg.content && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'tool_use') {
              into.toolCallCount++;
            }
          }
        }
      }

      if (event.type === 'user') {
        into.messageCount++;
      }
    } catch (_e) {
      // Skip malformed JSONL lines
    }
  });
}
