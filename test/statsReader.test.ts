import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readStats, readUsageFromCache } from '../src/data/statsReader';

vi.mock('fs', () => ({
  promises: {
    readFile: vi.fn(),
  },
}));

import * as fs from 'fs';

const mockReadFile = fs.promises.readFile as ReturnType<typeof vi.fn>;

const FAKE_HOME = '/tmp/fake-claude-home';

beforeEach(() => {
  mockReadFile.mockReset();
});

describe('readStats', () => {
  it('returns StatsCache when JSON has version and dailyActivity', async () => {
    const statsCache = {
      version: 1,
      lastComputedDate: '2026-03-28',
      dailyActivity: [{ date: '2026-03-28', sessions: 2, messages: 10 }],
      dailyModelTokens: [],
      modelUsage: {},
      totalSessions: 5,
      totalMessages: 50,
      longestSession: { sessionId: 'abc', messageCount: 20 },
      firstSessionDate: '2026-01-01',
      hourCounts: {},
      totalSpeculationTimeSavedMs: 0,
    };
    mockReadFile.mockResolvedValue(JSON.stringify(statsCache));

    const result = await readStats(FAKE_HOME);

    expect(result).toEqual(statsCache);
    expect(mockReadFile).toHaveBeenCalledWith(`${FAKE_HOME}/stats-cache.json`, 'utf-8');
  });

  it('returns null when JSON is invalid', async () => {
    mockReadFile.mockResolvedValue('not valid json {{{');

    const result = await readStats(FAKE_HOME);

    expect(result).toBeNull();
  });

  it('returns null when the file does not exist', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT: no such file'));

    const result = await readStats(FAKE_HOME);

    expect(result).toBeNull();
  });

  it('returns null when JSON lacks version field', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ dailyActivity: [] }));

    const result = await readStats(FAKE_HOME);

    expect(result).toBeNull();
  });
});

describe('readUsageFromCache', () => {
  it('returns ClaudeUsage when JSON has a usage field', async () => {
    const usage = {
      five_hour: { percent_used: 50, reset_time: '2026-03-28T12:00:00Z' },
      seven_day: null,
      seven_day_sonnet: null,
      seven_day_opus: null,
      extra_usage: null,
    };
    mockReadFile.mockResolvedValue(JSON.stringify({ usage }));

    const result = await readUsageFromCache(FAKE_HOME);

    expect(result).toEqual(usage);
    expect(mockReadFile).toHaveBeenCalledWith(`${FAKE_HOME}/stats-cache.json`, 'utf-8');
  });

  it('returns null when JSON has no usage field', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ version: 1 }));

    const result = await readUsageFromCache(FAKE_HOME);

    expect(result).toBeNull();
  });

  it('returns null when file is not found', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT: no such file'));

    const result = await readUsageFromCache(FAKE_HOME);

    expect(result).toBeNull();
  });
});
