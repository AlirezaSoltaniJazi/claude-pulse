export interface DailyActivity {
  date: string;
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
}

export interface DailyModelTokens {
  date: string;
  tokensByModel: Record<string, number>;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;
  maxOutputTokens: number;
}

export interface LongestSession {
  sessionId: string;
  duration: number;
  messageCount: number;
  timestamp: string;
}

export interface StatsCache {
  version: number;
  lastComputedDate: string;
  dailyActivity: DailyActivity[];
  dailyModelTokens: DailyModelTokens[];
  modelUsage: Record<string, ModelUsage>;
  totalSessions: number;
  totalMessages: number;
  longestSession: LongestSession;
  firstSessionDate: string;
  hourCounts: Record<string, number>;
  totalSpeculationTimeSavedMs: number;
}

export interface SessionFile {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
}

/** Per-model token counts, split the same four ways the transcripts report them. */
export interface ModelTokenBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalTokens: number;
}

export interface WeeklyUsageSummary {
  weekStart: string;
  weekEnd: string;
  totalMessages: number;
  totalSessions: number;
  totalToolCalls: number;
  tokensByModel: Record<string, number>;
  /** Same models as tokensByModel, keeping the four sub-counts the UI table renders. */
  modelBreakdown: Record<string, ModelTokenBreakdown>;
  /** Assistant turns per local hour-of-day, keyed '0'-'23'. Sparse: silent hours are absent. */
  hourCounts: Record<string, number>;
  totalTokens: number;
  sonnetTokens: number;
}

export interface UsageWindow {
  utilization: number;
  resets_at: string | null;
}

export interface ExtraUsage {
  is_enabled: boolean;
  monthly_limit: number;
  used_credits: number;
  /** Null when the account has no spend cap set — callers must default it, never render it raw. */
  utilization: number | null;
  currency?: string;
}

/**
 * One rate-limit window, as the API's `limits` array describes it.
 *
 * This is the forward-compatible shape: the API names each window and attaches the model it
 * is scoped to, so a model-specific limit (Fable today, something else next quarter) surfaces
 * with no code change. The flat `seven_day_*` fields below are the legacy encoding of the same
 * thing and are now returned as null; see resolveLimits().
 */
export interface UsageLimit {
  /** API window id, e.g. 'session', 'weekly_all', 'weekly_scoped'. */
  kind: string;
  /** Coarse grouping, e.g. 'session', 'weekly'. */
  group: string;
  /** Utilization percentage, 0-100. */
  percent: number;
  resets_at: string | null;
  /**
   * Display name of the model this window is scoped to, e.g. 'Fable'. Null for windows that
   * cover every model. Comes from the API verbatim — never derived from a local model table.
   */
  modelLabel: string | null;
}

export interface ClaudeUsage {
  five_hour: UsageWindow | null;
  seven_day: UsageWindow | null;
  seven_day_sonnet: UsageWindow | null;
  seven_day_opus: UsageWindow | null;
  /** Every window the API reported. Empty when it sent none and no legacy field was set. */
  limits: UsageLimit[];
  extra_usage: ExtraUsage | null;
}

/** Where the effort value was resolved from — 'settings' means a global default, not session truth. */
export type EffortSource = 'transcript' | 'settings';

/**
 * Where the displayed model id came from.
 *
 *  - 'transcript' — the last assistant turn of this session. Authoritative.
 *  - 'command'    — this session's own `/model` record. Authoritative, and fresher.
 *  - 'settings'   — the last *global* `/model` selection, which this session has not yet
 *                   confirmed by running a turn. Optimistic; the UI marks it.
 */
export type ModelSource = 'transcript' | 'command' | 'settings';

export interface ModelInfo {
  /** Raw model id, e.g. 'claude-opus-5'. May be a bare alias ('opus[1m]') when modelSource is 'settings'. */
  model: string | null;
  /** Null only when model is null. */
  modelSource: ModelSource | null;
  /** Raw effort value, e.g. 'xhigh'. Null when neither transcript nor settings.json had one. */
  effort: string | null;
  /** Null only when effort is null. */
  effortSource: EffortSource | null;
  /** True when the owning session's process is alive. Computed in the data layer, never in the UI. */
  isSessionLive: boolean;
  /**
   * Epoch ms of the newest record this session's transcript tail proved, or 0 when none.
   * Lives here because it falls out of the same transcript read the model does — deriving it
   * separately would mean a second pass over the same bytes on every refresh.
   */
  lastActivityAt: number;
}

/**
 * How much of the prompt-cache window is left.
 *
 * Inferred, not reported: the transcript records when a request happened, never how the server
 * cached it. So this is last-activity plus an assumed TTL, and every surface that shows it
 * marks it approximate with the same '~' the estimated reset timer uses.
 */
export interface PromptCacheInfo {
  /** Epoch ms of the last request this session made. */
  lastActivityAt: number;
  /** Epoch ms at which the cache is assumed to lapse. */
  warmUntil: number;
  /** The assumed TTL, so the UI can explain the number rather than just print it. */
  ttlMs: number;
}

/** One subagent spawned by a session, as its `.meta.json` and transcript describe it. */
export interface AgentInfo {
  /** File stem, e.g. 'agent-ae5b00c51f07fc683'. Unique within a session. */
  id: string;
  /** The task it was given, e.g. 'Crossref review batch 0'. */
  description: string;
  /** e.g. 'general-purpose', 'Explore'. */
  agentType: string;
  /** 1 for an agent spawned by the main thread, 2 for one spawned by another agent. */
  spawnDepth: number;
  /** Id of the spawning agent, or null when the main thread spawned it. */
  parentAgentId: string | null;
  /** Every token the agent's own requests consumed, input + output + both cache counters. */
  tokens: number;
  /** Last record minus first, or null when the transcript carried no usable timestamps. */
  durationMs: number | null;
  /** Assistant turns the agent took. */
  turns: number;
  /** Raw model id of its last assistant record, e.g. 'claude-sonnet-5'. */
  model: string | null;
}

/** Every subagent one session spawned, plus what they cost in total. */
export interface AgentMap {
  sessionId: string;
  agents: AgentInfo[];
  totalTokens: number;
  /** True when the scan stopped at AGENT_SCAN_MAX_AGENTS, so the UI can say so. */
  truncated: boolean;
}

export interface ClaudePulseData {
  stats: StatsCache | null;
  sessions: SessionFile[];
  activeSessions: SessionFile[];
  mostRecentSession: SessionFile | null;
  weeklyUsage: WeeklyUsageSummary | null;
  todayActivity: DailyActivity | null;
  usage: ClaudeUsage | null;
  modelInfo: ModelInfo | null;
  /** Null until a session with a readable transcript is found. */
  promptCache: PromptCacheInfo | null;
  /** Null when the dashboard is closed — the scan is too costly to run unobserved. */
  agents: AgentMap | null;
  usageStatus?: 'success' | 'cached' | 'rate_limited' | 'auth_error' | 'no_credentials' | 'error';
}
