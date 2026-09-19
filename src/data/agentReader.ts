import * as fs from 'fs';
import * as path from 'path';
import { AgentInfo, AgentMap, SessionFile } from '../types';
import { resolveTranscriptPath } from './modelReader';
import {
  AGENT_META_SUFFIX,
  AGENT_SCAN_CACHE_TTL_MS,
  AGENT_SCAN_MAX_AGENTS,
  AGENT_SUBDIR,
  SYNTHETIC_MODEL_ID,
} from '../constants';

/** What one subagent transcript yields, cached on the file's own (mtime, size). */
interface TranscriptStats {
  tokens: number;
  turns: number;
  durationMs: number | null;
  model: string | null;
}

interface TranscriptStatsCache {
  mtimeMs: number;
  size: number;
  stats: TranscriptStats;
}

interface AgentMapCache {
  sessionId: string;
  map: AgentMap;
  timestamp: number;
}

/**
 * Keyed by absolute transcript path. A finished agent's transcript never changes, so it is
 * read exactly once no matter how often the dashboard refreshes — which is what makes a
 * 64 MB session affordable at all. Unbounded on purpose: one entry is a handful of numbers,
 * and the alternative is re-reading megabytes to save bytes.
 */
const transcriptStatsCache = new Map<string, TranscriptStatsCache>();
let agentMapCache: AgentMapCache | null = null;

/**
 * Reads every subagent a session spawned, with what each one cost.
 *
 * Deliberately scoped to ONE session. Subagent transcripts are the largest thing in
 * `~/.claude` by a wide margin — 715 MB across 5,389 files on a working machine — so the
 * weekly scan leaves them alone and this runs only while the dashboard is open.
 *
 * Returns null when the session has no subagent directory, which is the normal case.
 * Never throws.
 */
export async function readSessionAgents(
  claudeHomePath: string,
  session: SessionFile | null,
  forceRefresh: boolean = false
): Promise<AgentMap | null> {
  if (!session?.sessionId) return null;

  if (
    !forceRefresh &&
    agentMapCache &&
    agentMapCache.sessionId === session.sessionId &&
    Date.now() - agentMapCache.timestamp < AGENT_SCAN_CACHE_TTL_MS
  ) {
    return agentMapCache.map;
  }

  try {
    const agentsDir = await resolveAgentsDir(claudeHomePath, session);
    if (!agentsDir) return null;

    const entries = await fs.promises.readdir(agentsDir);
    const metaFiles = entries.filter((f) => f.endsWith(AGENT_META_SUFFIX)).sort();
    if (metaFiles.length === 0) return null;

    const truncated = metaFiles.length > AGENT_SCAN_MAX_AGENTS;
    const capped = truncated ? metaFiles.slice(0, AGENT_SCAN_MAX_AGENTS) : metaFiles;

    const agents = (await Promise.all(capped.map((f) => readAgent(agentsDir, f)))).filter(
      (a): a is AgentInfo => a !== null
    );

    // Costliest first: the reason to open this view is to find what ran away with the budget.
    agents.sort((a, b) => b.tokens - a.tokens);

    const map: AgentMap = {
      sessionId: session.sessionId,
      agents,
      totalTokens: agents.reduce((sum, a) => sum + a.tokens, 0),
      truncated,
    };

    agentMapCache = { sessionId: session.sessionId, map, timestamp: Date.now() };
    return map;
  } catch (e) {
    console.warn(
      `Claude Pulse: Failed to read agent map: ${e instanceof Error ? e.message : String(e)}`
    );
    return null;
  }
}

export function clearAgentCache(): void {
  agentMapCache = null;
  transcriptStatsCache.clear();
}

/**
 * `<project>/<sessionId>/subagents`, derived from the transcript path rather than rebuilt.
 *
 * resolveTranscriptPath already owns the encoded-path-then-scan fallback for locating a
 * session's project directory; duplicating that logic here would mean two things to fix the
 * next time the encoding surprises us.
 */
async function resolveAgentsDir(
  claudeHomePath: string,
  session: SessionFile
): Promise<string | null> {
  const transcriptPath = await resolveTranscriptPath(claudeHomePath, session);
  if (!transcriptPath) return null;

  const agentsDir = path.join(path.dirname(transcriptPath), session.sessionId, AGENT_SUBDIR);
  try {
    const stat = await fs.promises.stat(agentsDir);
    return stat.isDirectory() ? agentsDir : null;
  } catch (_e) {
    // No subagents directory — the session simply never spawned one.
    return null;
  }
}

async function readAgent(agentsDir: string, metaFile: string): Promise<AgentInfo | null> {
  const id = metaFile.slice(0, -AGENT_META_SUFFIX.length);

  let meta: {
    agentType?: unknown;
    description?: unknown;
    spawnDepth?: unknown;
    parentAgentId?: unknown;
  };
  try {
    const raw = await fs.promises.readFile(path.join(agentsDir, metaFile), 'utf-8');
    meta = JSON.parse(raw);
  } catch (_e) {
    // A meta file we cannot read describes an agent we cannot name — skip it rather than
    // listing an anonymous row.
    return null;
  }

  const stats = await readTranscriptStats(path.join(agentsDir, `${id}.jsonl`));

  return {
    id,
    description: asString(meta.description) ?? id,
    agentType: asString(meta.agentType) ?? 'unknown',
    spawnDepth: typeof meta.spawnDepth === 'number' && meta.spawnDepth > 0 ? meta.spawnDepth : 1,
    parentAgentId: asString(meta.parentAgentId),
    tokens: stats.tokens,
    durationMs: stats.durationMs,
    turns: stats.turns,
    model: stats.model,
  };
}

const NO_STATS: TranscriptStats = { tokens: 0, turns: 0, durationMs: null, model: null };

/**
 * Totals one subagent transcript. Lenient in the same way the weekly scan is: a malformed
 * line is skipped, and a missing transcript yields zeros rather than dropping the agent —
 * an agent that has spawned but not yet written is still worth showing.
 */
async function readTranscriptStats(filePath: string): Promise<TranscriptStats> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (_e) {
    return NO_STATS;
  }

  const cached = transcriptStatsCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.stats;
  }

  let content: string;
  try {
    content = await fs.promises.readFile(filePath, 'utf-8');
  } catch (_e) {
    return NO_STATS;
  }

  let tokens = 0;
  let turns = 0;
  let model: string | null = null;
  let firstAt = 0;
  let lastAt = 0;

  for (const line of content.split('\n')) {
    if (!line) continue;
    try {
      const record = JSON.parse(line) as {
        type?: unknown;
        timestamp?: unknown;
        message?: { model?: unknown; usage?: Record<string, unknown> };
      };

      const at = parseTimestamp(record.timestamp);
      if (at > 0) {
        if (firstAt === 0 || at < firstAt) firstAt = at;
        if (at > lastAt) lastAt = at;
      }

      if (record.type !== 'assistant' || !record.message) continue;
      turns++;

      const rawModel = record.message.model;
      if (typeof rawModel === 'string' && rawModel.trim() && rawModel !== SYNTHETIC_MODEL_ID) {
        model = rawModel.trim();
      }

      const usage = record.message.usage;
      if (usage) {
        tokens +=
          toCount(usage.input_tokens) +
          toCount(usage.output_tokens) +
          toCount(usage.cache_read_input_tokens) +
          toCount(usage.cache_creation_input_tokens);
      }
    } catch (_e) {
      // Skip malformed JSONL lines (the agent may be mid-append)
    }
  }

  const stats: TranscriptStats = {
    tokens,
    turns,
    durationMs: firstAt > 0 && lastAt > firstAt ? lastAt - firstAt : null,
    model,
  };
  transcriptStatsCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, stats });
  return stats;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}
