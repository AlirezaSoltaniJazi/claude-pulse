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

export interface WeeklyUsageSummary {
  weekStart: string;
  weekEnd: string;
  totalMessages: number;
  totalSessions: number;
  totalToolCalls: number;
  tokensByModel: Record<string, number>;
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
  utilization: number;
  currency?: string;
}

export interface ClaudeUsage {
  five_hour: UsageWindow | null;
  seven_day: UsageWindow | null;
  seven_day_sonnet: UsageWindow | null;
  seven_day_opus: UsageWindow | null;
  extra_usage: ExtraUsage | null;
}

/** Where the effort value was resolved from — 'settings' means a global default, not session truth. */
export type EffortSource = 'transcript' | 'settings';

export interface ModelInfo {
  /** Raw model id exactly as it appeared in the transcript, e.g. 'claude-opus-5'. */
  model: string | null;
  /** Raw effort value, e.g. 'xhigh'. Null when neither transcript nor settings.json had one. */
  effort: string | null;
  /** Null only when effort is null. */
  effortSource: EffortSource | null;
  /** True when the owning session's process is alive. Computed in the data layer, never in the UI. */
  isSessionLive: boolean;
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
  usageStatus?: 'success' | 'cached' | 'rate_limited' | 'auth_error' | 'no_credentials' | 'error';
}
