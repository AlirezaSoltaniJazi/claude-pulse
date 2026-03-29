import { StatsCache, WeeklyUsageSummary, DailyActivity } from '../types';
import { getCurrentWeekBounds } from '../utils/dateUtils';

export function getWeeklyUsage(stats: StatsCache): WeeklyUsageSummary {
  const { weekStart, weekEnd } = getCurrentWeekBounds();

  const weekActivity = stats.dailyActivity.filter((d) => d.date >= weekStart && d.date <= weekEnd);

  const weekTokens = stats.dailyModelTokens.filter((d) => d.date >= weekStart && d.date <= weekEnd);

  const tokensByModel: Record<string, number> = {};
  let totalTokens = 0;
  let sonnetTokens = 0;

  for (const day of weekTokens) {
    for (const [model, tokens] of Object.entries(day.tokensByModel)) {
      tokensByModel[model] = (tokensByModel[model] ?? 0) + tokens;
      totalTokens += tokens;
      if (model.toLowerCase().includes('sonnet')) {
        sonnetTokens += tokens;
      }
    }
  }

  return {
    weekStart,
    weekEnd,
    totalMessages: weekActivity.reduce((sum, d) => sum + d.messageCount, 0),
    totalSessions: weekActivity.reduce((sum, d) => sum + d.sessionCount, 0),
    totalToolCalls: weekActivity.reduce((sum, d) => sum + d.toolCallCount, 0),
    tokensByModel,
    totalTokens,
    sonnetTokens,
  };
}

export function getSonnetWeeklyTokens(stats: StatsCache): number {
  const { weekStart, weekEnd } = getCurrentWeekBounds();

  let sonnetTokens = 0;
  for (const day of stats.dailyModelTokens) {
    if (day.date >= weekStart && day.date <= weekEnd) {
      for (const [model, tokens] of Object.entries(day.tokensByModel)) {
        if (model.toLowerCase().includes('sonnet')) {
          sonnetTokens += tokens;
        }
      }
    }
  }
  return sonnetTokens;
}

export function getTodayActivity(stats: StatsCache): DailyActivity | null {
  const today = new Date().toISOString().split('T')[0];
  return stats.dailyActivity.find((d) => d.date === today) ?? null;
}

export function getModelBreakdown(stats: StatsCache): Record<
  string,
  {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    total: number;
  }
> {
  const result: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      total: number;
    }
  > = {};

  for (const [model, usage] of Object.entries(stats.modelUsage)) {
    result[model] = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      total:
        usage.inputTokens +
        usage.outputTokens +
        usage.cacheReadInputTokens +
        usage.cacheCreationInputTokens,
    };
  }

  return result;
}
