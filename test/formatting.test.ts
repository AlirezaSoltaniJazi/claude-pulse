import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatDuration, formatDurationShort, formatNumber } from '../src/utils/formatting';
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
