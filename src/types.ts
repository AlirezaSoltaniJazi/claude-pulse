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

export interface RateLimitInfo {
  status: string;
  resetsAt: number;
  rateLimitType: string;
  overageStatus: string;
  overageResetsAt: number;
  isUsingOverage: boolean;
}

export interface CliSessionData {
  rateLimitInfo: RateLimitInfo | null;
  totalCostUsd: number;
  modelUsage: Record<string, ModelUsage>;
  sessionId: string;
}

export interface ClaudePulseData {
  stats: StatsCache | null;
  sessions: SessionFile[];
  activeSessions: SessionFile[];
  mostRecentSession: SessionFile | null;
  weeklyUsage: WeeklyUsageSummary | null;
  todayActivity: DailyActivity | null;
  cliData: CliSessionData | null;
}
