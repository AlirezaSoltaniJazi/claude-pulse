import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  formatDuration,
  formatDurationShort,
  formatEffortLevel,
  formatModelName,
  formatNumber,
  parseModelId,
} from '../src/utils/formatting';
import { getCurrentWeekBounds, formatDate } from '../src/utils/dateUtils';

describe('formatDuration', () => {
  it('returns 0m 00s for 0ms', () => {
    expect(formatDuration(0)).toBe('0m 00s');
  });

  it('formats 30 seconds', () => {
    expect(formatDuration(30_000)).toBe('0m 30s');
  });

  it('formats 5 minutes exactly', () => {
    expect(formatDuration(300_000)).toBe('5m 00s');
  });

  it('formats 1 hour 30 minutes', () => {
    expect(formatDuration(5_400_000)).toBe('1h 30m');
  });

  it('uses absolute value for negative durations', () => {
    expect(formatDuration(-30_000)).toBe('0m 30s');
    expect(formatDuration(-5_400_000)).toBe('1h 30m');
  });
});

describe('formatDurationShort', () => {
  it('returns 0m for 0ms', () => {
    expect(formatDurationShort(0)).toBe('0m');
  });

  it('drops seconds (30s becomes 0m)', () => {
    expect(formatDurationShort(30_000)).toBe('0m');
  });

  it('formats 5 minutes', () => {
    expect(formatDurationShort(300_000)).toBe('5m');
  });

  it('formats 1 hour 30 minutes', () => {
    expect(formatDurationShort(5_400_000)).toBe('1h 30m');
  });

  it('uses absolute value for negative durations', () => {
    expect(formatDurationShort(-300_000)).toBe('5m');
    expect(formatDurationShort(-5_400_000)).toBe('1h 30m');
  });
});

describe('formatNumber', () => {
  it('returns plain string for 0', () => {
    expect(formatNumber(0)).toBe('0');
  });

  it('returns plain string for numbers under 1000', () => {
    expect(formatNumber(999)).toBe('999');
  });

  it('formats thousands with K suffix', () => {
    expect(formatNumber(1_500)).toBe('1.5K');
  });

  it('formats millions with M suffix', () => {
    expect(formatNumber(1_500_000)).toBe('1.5M');
  });

  it('formats billions with B suffix', () => {
    expect(formatNumber(2_000_000_000)).toBe('2.0B');
  });
});

describe('formatModelName', () => {
  it('formats the current model id', () => {
    expect(formatModelName('claude-opus-5')).toBe('Opus 5');
  });

  it('formats other real ids found on disk', () => {
    expect(formatModelName('claude-opus-4-8')).toBe('Opus 4.8');
    expect(formatModelName('claude-opus-4-7')).toBe('Opus 4.7');
    expect(formatModelName('claude-fable-5')).toBe('Fable 5');
  });

  it('strips a trailing date stamp', () => {
    expect(formatModelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
  });

  it('handles legacy version-first ids', () => {
    expect(formatModelName('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5');
  });

  it('handles Bedrock-style ids', () => {
    expect(formatModelName('us.anthropic.claude-opus-4-5-20251101-v1:0')).toBe('Opus 4.5');
  });

  it('handles Vertex-style ids', () => {
    expect(formatModelName('claude-opus-4-5@20251101')).toBe('Opus 4.5');
  });

  it('strips a trailing variant tag', () => {
    expect(formatModelName('claude-opus-5[1m]')).toBe('Opus 5');
  });

  it('formats a model id it has never seen', () => {
    expect(formatModelName('claude-quasar-6-2-20270815')).toBe('Quasar 6.2');
  });

  it('returns the raw id when there is nothing to parse', () => {
    expect(formatModelName('2024-01')).toBe('2024-01');
  });

  it('returns an empty string for the synthetic placeholder', () => {
    expect(formatModelName('<synthetic>')).toBe('');
  });

  it('returns an empty string for null, undefined and blank input', () => {
    expect(formatModelName(null)).toBe('');
    expect(formatModelName(undefined)).toBe('');
    expect(formatModelName('   ')).toBe('');
  });

  it('formats a bare family alias as written in settings.json', () => {
    expect(formatModelName('opus[1m]')).toBe('Opus');
    expect(formatModelName('sonnet')).toBe('Sonnet');
    expect(formatModelName('haiku')).toBe('Haiku');
    expect(formatModelName('fable')).toBe('Fable');
  });

  it('formats a full id carrying a variant tag', () => {
    expect(formatModelName('claude-fable-5[1m]')).toBe('Fable 5');
  });

  it('returns an empty string for selectors that do not name a model', () => {
    expect(formatModelName('default')).toBe('');
    expect(formatModelName('opusplan')).toBe('');
  });

  it('matches selectors case-insensitively', () => {
    expect(formatModelName('Default')).toBe('');
    expect(formatModelName('OPUSPLAN')).toBe('');
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(formatModelName('  opus[1m]  ')).toBe('Opus');
  });
});

describe('parseModelId', () => {
  it('splits a full id into family and version', () => {
    expect(parseModelId('claude-opus-5')).toEqual({ family: 'opus', version: '5' });
    expect(parseModelId('claude-haiku-4-5-20251001')).toEqual({ family: 'haiku', version: '4.5' });
    expect(parseModelId('claude-fable-5[1m]')).toEqual({ family: 'fable', version: '5' });
    expect(parseModelId('us.anthropic.claude-opus-4-5-20251101-v1:0')).toEqual({
      family: 'opus',
      version: '4.5',
    });
  });

  it('reads the family out of a legacy version-first id', () => {
    expect(parseModelId('claude-3-5-sonnet-20241022')).toEqual({
      family: 'sonnet',
      version: '3.5',
    });
  });

  it('leaves the version empty for a bare alias', () => {
    expect(parseModelId('opus[1m]')).toEqual({ family: 'opus', version: '' });
    expect(parseModelId('sonnet')).toEqual({ family: 'sonnet', version: '' });
  });

  it('gives two ids of the same family the same family string', () => {
    expect(parseModelId('claude-opus-4-8')?.family).toBe(parseModelId('opus[1m]')?.family);
  });

  it('returns null for input that does not name a model', () => {
    expect(parseModelId(null)).toBeNull();
    expect(parseModelId(undefined)).toBeNull();
    expect(parseModelId('')).toBeNull();
    expect(parseModelId('   ')).toBeNull();
    expect(parseModelId('<synthetic>')).toBeNull();
    expect(parseModelId('default')).toBeNull();
    expect(parseModelId('opusplan')).toBeNull();
    expect(parseModelId('2024-01')).toBeNull();
  });
});

describe('formatEffortLevel', () => {
  it('passes known levels through lowercased', () => {
    expect(formatEffortLevel('xhigh')).toBe('xhigh');
    expect(formatEffortLevel('high')).toBe('high');
    expect(formatEffortLevel('low')).toBe('low');
    expect(formatEffortLevel('XHIGH')).toBe('xhigh');
  });

  it('abbreviates medium', () => {
    expect(formatEffortLevel('medium')).toBe('med');
  });

  it('truncates unknown future levels', () => {
    expect(formatEffortLevel('ultra-extreme')).toBe('ultra-ex');
  });

  it('returns an empty string for null, undefined and blank input', () => {
    expect(formatEffortLevel(null)).toBe('');
    expect(formatEffortLevel(undefined)).toBe('');
    expect(formatEffortLevel('  ')).toBe('');
  });
});

describe('getCurrentWeekBounds', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns Monday-Sunday range when called on a Wednesday', () => {
    vi.useFakeTimers();
    // Use a date in local time to avoid timezone issues
    const wed = new Date(2025, 6, 16, 12, 0, 0); // July 16, 2025 = Wednesday (local)
    vi.setSystemTime(wed);

    const { weekStart, weekEnd, weekStartDate } = getCurrentWeekBounds();
    const expectedMonday = new Date(2025, 6, 14, 0, 0, 0);
    const expectedSunday = new Date(2025, 6, 20, 0, 0, 0);

    expect(weekStart).toBe(formatDate(expectedMonday));
    expect(weekEnd).toBe(formatDate(expectedSunday));
    expect(weekStartDate.getDay()).toBe(1); // Monday
  });

  it('returns correct range when called on a Monday', () => {
    vi.useFakeTimers();
    const mon = new Date(2025, 6, 14, 12, 0, 0); // July 14, 2025 = Monday (local)
    vi.setSystemTime(mon);

    const { weekStart, weekEnd } = getCurrentWeekBounds();
    const expectedMonday = new Date(2025, 6, 14, 0, 0, 0);
    const expectedSunday = new Date(2025, 6, 20, 0, 0, 0);

    expect(weekStart).toBe(formatDate(expectedMonday));
    expect(weekEnd).toBe(formatDate(expectedSunday));
  });

  it('returns correct range when called on a Sunday', () => {
    vi.useFakeTimers();
    const sun = new Date(2025, 6, 20, 12, 0, 0); // July 20, 2025 = Sunday (local)
    vi.setSystemTime(sun);

    const { weekStart, weekEnd } = getCurrentWeekBounds();
    const expectedMonday = new Date(2025, 6, 14, 0, 0, 0);
    const expectedSunday = new Date(2025, 6, 20, 0, 0, 0);

    expect(weekStart).toBe(formatDate(expectedMonday));
    expect(weekEnd).toBe(formatDate(expectedSunday));
  });

  it('weekStartDate is a Date object set to midnight Monday', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2025, 6, 16, 12, 0, 0));

    const { weekStartDate } = getCurrentWeekBounds();

    expect(weekStartDate).toBeInstanceOf(Date);
    expect(weekStartDate.getHours()).toBe(0);
    expect(weekStartDate.getMinutes()).toBe(0);
    expect(weekStartDate.getSeconds()).toBe(0);
  });
});

describe('formatDate', () => {
  it('returns YYYY-MM-DD format', () => {
    const date = new Date('2025-07-16T12:00:00Z');
    expect(formatDate(date)).toBe('2025-07-16');
  });

  it('pads single-digit month and day', () => {
    const date = new Date('2025-01-05T12:00:00Z');
    expect(formatDate(date)).toBe('2025-01-05');
  });
});
