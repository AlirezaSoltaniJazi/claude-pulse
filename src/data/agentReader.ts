import * as fs from 'fs';
import * as path from 'path';
import {
  AgentGraph,
  AgentInfo,
  AgentMap,
  AgentNode,
  AgentStatus,
  SessionFile,
  SessionNode,
} from '../types';
import { resolveTranscriptPath } from './modelReader';
import { isProcessAlive } from './sessionReader';
import {
  AGENT_GRAPH_CACHE_TTL_MS,
  AGENT_GRAPH_MAX_SESSIONS,
  AGENT_META_SUFFIX,
  AGENT_RUNNING_STALE_MS,
  AGENT_SCAN_CACHE_TTL_MS,
  AGENT_SCAN_MAX_AGENTS,
  AGENT_SUBDIR,
  AGENT_TERMINAL_STOP_REASONS,
  SYNTHETIC_MODEL_ID,
} from '../constants';

/** What one subagent transcript yields, cached on the file's own (mtime, size). */
interface TranscriptStats {
  tokens: number;
  turns: number;
  durationMs: number | null;
  model: string | null;
  /**
   * stop_reason of the LAST assistant record, or null when it carried none.
   *
   * This is the one authoritative completion signal an agent transcript offers: a subagent
   * that returned its result ends on a terminal reason, one killed mid-tool-call does not.
   * Measured across 300 local agent transcripts: 280 'end_turn', 5 'tool_use', 3
   * 'stop_sequence', 12 absent.
   */
  lastStopReason: string | null;
  /** Epoch ms of the newest record, or 0 when the transcript carried no usable timestamps. */
  lastActivityAt: number;
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

interface AgentGraphCache {
  /** Identity of the inputs the graph was built from. A change rebuilds regardless of TTL. */
  signature: string;
  graph: AgentGraph;
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
let agentGraphCache: AgentGraphCache | null = null;

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

    const isAlive = isProcessAlive(session.pid);
    const agents = (await Promise.all(capped.map((f) => readAgent(agentsDir, f, isAlive)))).filter(
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
  agentGraphCache = null;
  transcriptStatsCache.clear();
}

/**
 * Reads every session on disk together with the subagent tree hanging off each one.
 *
 * This is the data behind the graph view, and it is a different shape of question from
 * readSessionAgents(): that one answers "what did THIS session spend", so it sorts by cost
 * and flattens the hierarchy. This one answers "what is running on this machine, and what
 * can I stop", so it keeps the parent/child links and includes sessions that spawned no
 * agents at all — a live session with an empty context is exactly what someone scanning for
 * a stray process is looking for.
 *
 * Cost is the same order as readSessionAgents() times the session count, which the sessions
 * directory bounds to a dozen or so; AGENT_GRAPH_MAX_SESSIONS caps a directory that never
 * got pruned. Individual agent transcripts still come from transcriptStatsCache, so a
 * finished agent is read once no matter how many refreshes see it.
 *
 * Returns null only when there are no sessions at all. Never throws.
 */
export async function readAgentGraph(
  claudeHomePath: string,
  sessions: SessionFile[],
  primarySessionId: string | null,
  primaryModel: string | null,
  forceRefresh: boolean = false
): Promise<AgentGraph | null> {
  if (sessions.length === 0) return null;

  // Newest first, so truncation drops the sessions least likely to still matter.
  const ordered = [...sessions].sort((a, b) => b.startedAt - a.startedAt);
  const truncated = ordered.length > AGENT_GRAPH_MAX_SESSIONS;
  const capped = truncated ? ordered.slice(0, AGENT_GRAPH_MAX_SESSIONS) : ordered;

  const signature = buildGraphSignature(capped, primarySessionId, primaryModel);
  if (
    !forceRefresh &&
    agentGraphCache &&
    agentGraphCache.signature === signature &&
    Date.now() - agentGraphCache.timestamp < AGENT_GRAPH_CACHE_TTL_MS
  ) {
    return agentGraphCache.graph;
  }

  try {
    const nodes = await Promise.all(
      capped.map((session) =>
        readSessionNode(claudeHomePath, session, {
          isPrimary: session.sessionId === primarySessionId,
          model: session.sessionId === primarySessionId ? primaryModel : null,
        })
      )
    );

    // Live sessions first — they are the only ones with anything to stop — then newest.
    nodes.sort((a, b) => {
      if (a.isAlive !== b.isAlive) return a.isAlive ? -1 : 1;
      return b.startedAt - a.startedAt;
    });

    const graph: AgentGraph = { sessions: nodes, generatedAt: Date.now(), truncated };
    agentGraphCache = { signature, graph, timestamp: Date.now() };
    return graph;
  } catch (e) {
    console.warn(
      `Claude Pulse: Failed to read agent graph: ${e instanceof Error ? e.message : String(e)}`
    );
    return null;
  }
}

/**
 * Identity of the inputs, so a change rebuilds the graph without waiting out the TTL.
 *
 * Includes the primary session and its model because both are rendered on the node, and
 * `startedAt` because a recycled PID with a new session is a different session.
 */
function buildGraphSignature(
  sessions: SessionFile[],
  primarySessionId: string | null,
  primaryModel: string | null
): string {
  const ids = sessions.map((s) => `${s.sessionId}:${s.pid}:${s.startedAt}`).join(',');
  return `${ids}|${primarySessionId ?? ''}|${primaryModel ?? ''}`;
}

async function readSessionNode(
  claudeHomePath: string,
  session: SessionFile,
  context: { isPrimary: boolean; model: string | null }
): Promise<SessionNode> {
  const isAlive = isProcessAlive(session.pid);
  const agents = await readSessionAgentList(claudeHomePath, session, isAlive);

  const roots = buildAgentTree(agents.list);

  return {
    sessionId: session.sessionId,
    pid: session.pid,
    cwd: session.cwd ?? '',
    label: sessionLabel(session),
    startedAt: session.startedAt,
    isAlive,
    entrypoint: asString(session.entrypoint),
    isPrimary: context.isPrimary,
    model: context.model,
    agents: roots,
    agentCount: agents.list.length,
    totalTokens: agents.list.reduce((sum, a) => sum + a.tokens, 0),
    lastActivityAt: agents.list.reduce((max, a) => Math.max(max, a.lastActivityAt), 0),
    truncated: agents.truncated,
  };
}

/** The session's own name when Claude Code derived one, else the basename of its cwd. */
function sessionLabel(session: SessionFile): string {
  const name = asString(session.name);
  if (name) return name;
  const cwd = asString(session.cwd);
  return cwd ? path.basename(cwd) : session.sessionId.slice(0, 8);
}

/**
 * The flat agent list for one session, with no cost ordering applied.
 *
 * Separate from readSessionAgents() rather than sharing its cache: that cache holds one
 * session at a time and is keyed to the cost-sorted AgentMap the table renders. Reusing it
 * here would mean the two views evicting each other on every refresh.
 */
async function readSessionAgentList(
  claudeHomePath: string,
  session: SessionFile,
  isAlive: boolean
): Promise<{ list: AgentInfo[]; truncated: boolean }> {
  const empty = { list: [] as AgentInfo[], truncated: false };

  try {
    const agentsDir = await resolveAgentsDir(claudeHomePath, session);
    if (!agentsDir) return empty;

    const entries = await fs.promises.readdir(agentsDir);
    const metaFiles = entries.filter((f) => f.endsWith(AGENT_META_SUFFIX)).sort();
    if (metaFiles.length === 0) return empty;

    const truncated = metaFiles.length > AGENT_SCAN_MAX_AGENTS;
    const capped = truncated ? metaFiles.slice(0, AGENT_SCAN_MAX_AGENTS) : metaFiles;

    const list = (await Promise.all(capped.map((f) => readAgent(agentsDir, f, isAlive)))).filter(
      (a): a is AgentInfo => a !== null
    );
    return { list, truncated };
  } catch (_e) {
    // A session whose subagent directory we cannot read still belongs in the graph — it has
    // a PID, and that is the half of this view that matters.
    return empty;
  }
}

/**
 * Links a flat agent list into the spawn tree, by parentAgentId.
 *
 * Pure and exported: the interesting cases are all malformed input, and none of them are
 * worth a temporary directory to reproduce. A parentAgentId naming an agent that is not in
 * the list — truncated away, or its meta file unreadable — promotes the child to a root
 * rather than dropping it, because an agent that burned 200k tokens must appear somewhere
 * even when its parent did not survive the scan.
 *
 * Cycles cannot arise from Claude Code, but a cycle here would hang the renderer, so the
 * reachability pass below promotes anything the roots cannot reach instead of trusting it.
 */
export function buildAgentTree(agents: AgentInfo[]): AgentNode[] {
  const nodes = new Map<string, AgentNode>();
  for (const agent of agents) {
    nodes.set(agent.id, { ...agent, children: [], subtreeTokens: agent.tokens });
  }

  const roots: AgentNode[] = [];
  for (const agent of agents) {
    const node = nodes.get(agent.id);
    if (!node) continue;
    const parent = resolveParent(node, nodes);
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  for (const root of roots) computeSubtreeTokens(root);

  // Costliest subtree first, at every level.
  const sortDeep = (list: AgentNode[]): void => {
    list.sort((a, b) => b.subtreeTokens - a.subtreeTokens);
    for (const node of list) sortDeep(node.children);
  };
  sortDeep(roots);

  return roots;
}

/**
 * The node an agent should hang off, or null when it belongs at the root.
 *
 * Walks the whole parent chain rather than just checking the immediate link, so a cycle
 * resolves to null and the agent becomes a root. Without that walk a cycle would produce a
 * tree with no root containing it, and the token sums and the renderer would both silently
 * lose those agents.
 */
function resolveParent(node: AgentNode, nodes: Map<string, AgentNode>): AgentNode | null {
  if (!node.parentAgentId) return null;

  const parent = nodes.get(node.parentAgentId);
  // Unknown parent — truncated away, or its meta file was unreadable. The child is still
  // worth showing, so it is promoted rather than dropped.
  if (!parent || parent.id === node.id) return null;

  const seen = new Set<string>([node.id]);
  let cursor: AgentNode | undefined = parent;
  while (cursor) {
    if (seen.has(cursor.id)) return null;
    seen.add(cursor.id);
    cursor = cursor.parentAgentId ? nodes.get(cursor.parentAgentId) : undefined;
  }
  return parent;
}

/** Post-order sum. Iterative so a pathological depth cannot blow the stack. */
function computeSubtreeTokens(root: AgentNode): number {
  const order: AgentNode[] = [];
  const stack: AgentNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as AgentNode;
    order.push(node);
    stack.push(...node.children);
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const node = order[i];
    node.subtreeTokens = node.tokens + node.children.reduce((sum, c) => sum + c.subtreeTokens, 0);
  }
  return root.subtreeTokens;
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

async function readAgent(
  agentsDir: string,
  metaFile: string,
  isSessionAlive: boolean
): Promise<AgentInfo | null> {
  const id = metaFile.slice(0, -AGENT_META_SUFFIX.length);

  let meta: {
    agentType?: unknown;
    description?: unknown;
    spawnDepth?: unknown;
    parentAgentId?: unknown;
    stoppedByUser?: unknown;
    model?: unknown;
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
    // The transcript's own id wins: the meta file records the model that was *requested*,
    // which an alias or a routing mode would leave unresolved.
    model: stats.model ?? asString(meta.model),
    status: deriveAgentStatus({
      stoppedByUser: meta.stoppedByUser === true,
      lastStopReason: stats.lastStopReason,
      lastActivityAt: stats.lastActivityAt,
      isSessionAlive,
    }),
    lastActivityAt: stats.lastActivityAt,
  };
}

/**
 * Decides an agent's lifecycle state from the two things on disk that can prove one.
 *
 * Pure, and exported, because every branch here is an inference about a process we cannot
 * see: subagents share their session's PID, so there is no liveness check to fall back on
 * and this ordering IS the definition. Tested directly rather than through the filesystem.
 *
 * The order matters. `stoppedByUser` is Claude Code's own record of a cancellation and
 * outranks everything. A terminal stop_reason proves the agent returned, and stays true
 * after its session exits — a completed agent is not retroactively orphaned. Only then does
 * session liveness get a say, and only then the staleness window, which exists purely to
 * stop an abandoned agent reading as 'running' for the rest of the session's life.
 */
export function deriveAgentStatus(input: {
  stoppedByUser: boolean;
  lastStopReason: string | null;
  lastActivityAt: number;
  isSessionAlive: boolean;
  /** Injectable for tests. Defaults to now. */
  now?: number;
}): AgentStatus {
  if (input.stoppedByUser) return 'stopped';
  if (input.lastStopReason && AGENT_TERMINAL_STOP_REASONS.has(input.lastStopReason)) {
    return 'completed';
  }
  if (!input.isSessionAlive) return 'orphaned';

  const now = input.now ?? Date.now();
  // lastActivityAt of 0 means the agent has spawned but written nothing yet, which is the
  // first second of a normal run — not a reason to call it abandoned.
  if (input.lastActivityAt > 0 && now - input.lastActivityAt > AGENT_RUNNING_STALE_MS) {
    return 'orphaned';
  }
  return 'running';
}

const NO_STATS: TranscriptStats = {
  tokens: 0,
  turns: 0,
  durationMs: null,
  model: null,
  lastStopReason: null,
  lastActivityAt: 0,
};

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
  let lastStopReason: string | null = null;

  for (const line of content.split('\n')) {
    if (!line) continue;
    try {
      const record = JSON.parse(line) as {
        type?: unknown;
        timestamp?: unknown;
        message?: { model?: unknown; stop_reason?: unknown; usage?: Record<string, unknown> };
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

      // Overwritten by every assistant record, so what survives the loop is the last one's —
      // which is the only one that says anything about whether the agent is still going.
      lastStopReason = asString(record.message.stop_reason);

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
    lastStopReason,
    lastActivityAt: lastAt,
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
