import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getWeeklyUsage,
  getSonnetWeeklyTokens,
  getTodayActivity,
  getModelBreakdown,
} from '../src/data/dataAggregator';
import { StatsCache } from '../src/types';

// Wednesday 2026-03-25 12:00:00 UTC
// Week bounds: Mon 2026-03-23 to Sun 2026-03-29
const FAKE_NOW = new Date('2026-03-25T12:00:00.000Z');

function makeStatsCache(overrides: Partial<StatsCache> = {}): StatsCache {
  return {
    version: 1,
    lastComputedDate: '2026-03-25',
    dailyActivity: [],
    dailyModelTokens: [],
    modelUsage: {},
    totalSessions: 0,
    totalMessages: 0,
    longestSession: {
      sessionId: '',
      duration: 0,
      messageCount: 0,
      timestamp: '',
    },
    firstSessionDate: '2026-01-01',
    hourCounts: {},
    totalSpeculationTimeSavedMs: 0,
    ...overrides,
  };
}

describe('dataAggregator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FAKE_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── getWeeklyUsage ───────────────────────────────────────────────

  describe('getWeeklyUsage', () => {
    it('returns correct week bounds', () => {
      const stats = makeStatsCache();
      const result = getWeeklyUsage(stats);
      expect(result.weekStart).toBe('2026-03-23');
      expect(result.weekEnd).toBe('2026-03-29');
    });

    it('aggregates activity data within the current week', () => {
      const stats = makeStatsCache({
        dailyActivity: [
          { date: '2026-03-23', messageCount: 10, sessionCount: 2, toolCallCount: 5 },
          { date: '2026-03-25', messageCount: 20, sessionCount: 3, toolCallCount: 8 },
          { date: '2026-03-29', messageCount: 5, sessionCount: 1, toolCallCount: 2 },
        ],
      });

      const result = getWeeklyUsage(stats);
      expect(result.totalMessages).toBe(35);
      expect(result.totalSessions).toBe(6);
      expect(result.totalToolCalls).toBe(15);
    });

    it('excludes activity data outside the current week', () => {
      const stats = makeStatsCache({
        dailyActivity: [
          // Before week (Sunday of previous week)
          { date: '2026-03-22', messageCount: 100, sessionCount: 10, toolCallCount: 50 },
          // Inside week
          { date: '2026-03-24', messageCount: 5, sessionCount: 1, toolCallCount: 3 },
          // After week (Monday of next week)
          { date: '2026-03-30', messageCount: 200, sessionCount: 20, toolCallCount: 100 },
        ],
      });

      const result = getWeeklyUsage(stats);
      expect(result.totalMessages).toBe(5);
      expect(result.totalSessions).toBe(1);
      expect(result.totalToolCalls).toBe(3);
    });

    it('aggregates token data by model within the current week', () => {
      const stats = makeStatsCache({
        dailyModelTokens: [
          {
            date: '2026-03-23',
            tokensByModel: { 'claude-sonnet-4': 1000, 'claude-opus-4': 500 },
          },
          {
            date: '2026-03-26',
            tokensByModel: { 'claude-sonnet-4': 2000, 'claude-haiku-3.5': 300 },
          },
        ],
      });

      const result = getWeeklyUsage(stats);
      expect(result.tokensByModel).toEqual({
        'claude-sonnet-4': 3000,
        'claude-opus-4': 500,
        'claude-haiku-3.5': 300,
      });
      expect(result.totalTokens).toBe(3800);
      expect(result.sonnetTokens).toBe(3000);
    });

    it('returns zeros for empty data', () => {
      const stats = makeStatsCache();
      const result = getWeeklyUsage(stats);
      expect(result.totalMessages).toBe(0);
      expect(result.totalSessions).toBe(0);
      expect(result.totalToolCalls).toBe(0);
      expect(result.tokensByModel).toEqual({});
      expect(result.totalTokens).toBe(0);
      expect(result.sonnetTokens).toBe(0);
    });

    it('excludes token data outside the current week', () => {
      const stats = makeStatsCache({
        dailyModelTokens: [
          { date: '2026-03-22', tokensByModel: { 'claude-sonnet-4': 9999 } },
          { date: '2026-03-25', tokensByModel: { 'claude-sonnet-4': 100 } },
          { date: '2026-03-30', tokensByModel: { 'claude-sonnet-4': 8888 } },
        ],
      });

      const result = getWeeklyUsage(stats);
      expect(result.totalTokens).toBe(100);
      expect(result.sonnetTokens).toBe(100);
    });
  });

  // ─── getSonnetWeeklyTokens ────────────────────────────────────────

  describe('getSonnetWeeklyTokens', () => {
    it('counts tokens from models containing "sonnet" (case-insensitive)', () => {
      const stats = makeStatsCache({
        dailyModelTokens: [
          {
            date: '2026-03-24',
            tokensByModel: {
              'claude-sonnet-4': 500,
              'Claude-Sonnet-3.5': 300,
              'SONNET-model': 200,
            },
          },
        ],
      });

      expect(getSonnetWeeklyTokens(stats)).toBe(1000);
    });

    it('excludes tokens from non-sonnet models', () => {
      const stats = makeStatsCache({
        dailyModelTokens: [
          {
            date: '2026-03-25',
            tokensByModel: {
              'claude-opus-4': 5000,
              'claude-haiku-3.5': 3000,
              'claude-sonnet-4': 100,
            },
          },
        ],
      });

      expect(getSonnetWeeklyTokens(stats)).toBe(100);
    });

    it('returns 0 when no sonnet models exist', () => {
      const stats = makeStatsCache({
        dailyModelTokens: [
          {
            date: '2026-03-25',
            tokensByModel: { 'claude-opus-4': 5000, 'claude-haiku-3.5': 3000 },
          },
        ],
      });

      expect(getSonnetWeeklyTokens(stats)).toBe(0);
    });

    it('returns 0 for empty token data', () => {
      const stats = makeStatsCache();
      expect(getSonnetWeeklyTokens(stats)).toBe(0);
    });

    it('excludes sonnet tokens outside the current week', () => {
      const stats = makeStatsCache({
        dailyModelTokens: [
          { date: '2026-03-22', tokensByModel: { 'claude-sonnet-4': 9000 } },
          { date: '2026-03-25', tokensByModel: { 'claude-sonnet-4': 150 } },
          { date: '2026-03-30', tokensByModel: { 'claude-sonnet-4': 8000 } },
        ],
      });

      expect(getSonnetWeeklyTokens(stats)).toBe(150);
    });

    it('sums sonnet tokens across multiple days in the week', () => {
      const stats = makeStatsCache({
        dailyModelTokens: [
          { date: '2026-03-23', tokensByModel: { 'claude-sonnet-4': 100 } },
          { date: '2026-03-25', tokensByModel: { 'claude-sonnet-4': 200 } },
          { date: '2026-03-29', tokensByModel: { 'claude-sonnet-4': 300 } },
        ],
      });

      expect(getSonnetWeeklyTokens(stats)).toBe(600);
    });
  });

  // ─── getTodayActivity ─────────────────────────────────────────────

  describe('getTodayActivity', () => {
    it('returns the activity entry matching today', () => {
      const todayEntry = {
        date: '2026-03-25',
        messageCount: 42,
        sessionCount: 7,
        toolCallCount: 19,
      };

      const stats = makeStatsCache({
        dailyActivity: [
          { date: '2026-03-24', messageCount: 10, sessionCount: 2, toolCallCount: 5 },
          todayEntry,
          { date: '2026-03-26', messageCount: 1, sessionCount: 1, toolCallCount: 0 },
        ],
      });

      expect(getTodayActivity(stats)).toEqual(todayEntry);
    });

    it('returns null when no entry matches today', () => {
      const stats = makeStatsCache({
        dailyActivity: [
          { date: '2026-03-24', messageCount: 10, sessionCount: 2, toolCallCount: 5 },
          { date: '2026-03-26', messageCount: 1, sessionCount: 1, toolCallCount: 0 },
        ],
      });

      expect(getTodayActivity(stats)).toBeNull();
    });

    it('returns null for empty activity data', () => {
      const stats = makeStatsCache();
      expect(getTodayActivity(stats)).toBeNull();
    });
  });

  // ─── getModelBreakdown ────────────────────────────────────────────

  describe('getModelBreakdown', () => {
    it('returns breakdown with totals for each model', () => {
      const stats = makeStatsCache({
        modelUsage: {
          'claude-sonnet-4': {
            inputTokens: 1000,
            outputTokens: 2000,
            cacheReadInputTokens: 500,
            cacheCreationInputTokens: 300,
            webSearchRequests: 0,
            costUSD: 0.05,
            contextWindow: 200000,
            maxOutputTokens: 8192,
          },
          'claude-opus-4': {
            inputTokens: 5000,
            outputTokens: 10000,
            cacheReadInputTokens: 2000,
            cacheCreationInputTokens: 1000,
            webSearchRequests: 3,
            costUSD: 0.5,
            contextWindow: 200000,
            maxOutputTokens: 32000,
          },
        },
      });

      const result = getModelBreakdown(stats);

      expect(result['claude-sonnet-4']).toEqual({
        inputTokens: 1000,
        outputTokens: 2000,
        cacheReadInputTokens: 500,
        cacheCreationInputTokens: 300,
        total: 3800,
      });

      expect(result['claude-opus-4']).toEqual({
        inputTokens: 5000,
        outputTokens: 10000,
        cacheReadInputTokens: 2000,
        cacheCreationInputTokens: 1000,
        total: 18000,
      });
    });

    it('computes total as sum of all four token fields', () => {
      const stats = makeStatsCache({
        modelUsage: {
          'test-model': {
            inputTokens: 100,
            outputTokens: 200,
            cacheReadInputTokens: 300,
            cacheCreationInputTokens: 400,
            webSearchRequests: 0,
            costUSD: 0,
            contextWindow: 0,
            maxOutputTokens: 0,
          },
        },
      });

      const result = getModelBreakdown(stats);
      expect(result['test-model'].total).toBe(1000);
    });

    it('returns empty object when no model usage exists', () => {
      const stats = makeStatsCache();
      const result = getModelBreakdown(stats);
      expect(result).toEqual({});
    });

    it('handles models with zero tokens', () => {
      const stats = makeStatsCache({
        modelUsage: {
          'empty-model': {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0,
            contextWindow: 0,
            maxOutputTokens: 0,
          },
        },
      });

      const result = getModelBreakdown(stats);
      expect(result['empty-model']).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        total: 0,
      });
    });

    it('does not include webSearchRequests, costUSD, or other fields in output', () => {
      const stats = makeStatsCache({
        modelUsage: {
          'some-model': {
            inputTokens: 10,
            outputTokens: 20,
            cacheReadInputTokens: 30,
            cacheCreationInputTokens: 40,
            webSearchRequests: 5,
            costUSD: 1.23,
            contextWindow: 200000,
            maxOutputTokens: 8192,
          },
        },
      });

      const result = getModelBreakdown(stats);
      const keys = Object.keys(result['some-model']);
      expect(keys).toEqual([
        'inputTokens',
        'outputTokens',
        'cacheReadInputTokens',
        'cacheCreationInputTokens',
        'total',
      ]);
    });
  });
});
