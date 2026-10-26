import { describe, it, expect } from 'vitest';
import { describeCron, nextCronRun, parseCron } from '../src/utils/cron';

/** Local time, because CronCreate schedules in the user's local timezone. */
const at = (day: number, hour: number, minute: number): number =>
  new Date(2026, 9, day, hour, minute).getTime();

describe('parseCron', () => {
  it('accepts the shapes /loop produces', () => {
    expect(parseCron('*/5 * * * *')).not.toBeNull();
    expect(parseCron('7 * * * *')).not.toBeNull();
    expect(parseCron('57 8 * * 1-5')).not.toBeNull();
    expect(parseCron('13 4 31 12 *')).not.toBeNull();
  });

  it('rejects what it cannot evaluate rather than guessing', () => {
    expect(parseCron('')).toBeNull();
    expect(parseCron('* * * *')).toBeNull();
    expect(parseCron('60 * * * *')).toBeNull();
    expect(parseCron('0 9 * * MON')).toBeNull();
    expect(parseCron('*/0 * * * *')).toBeNull();
    expect(parseCron('5-1 * * * *')).toBeNull();
  });
});

describe('nextCronRun', () => {
  it('finds the next step of an interval, strictly after now', () => {
    expect(nextCronRun('*/5 * * * *', at(25, 10, 2))).toBe(at(25, 10, 5));
    expect(nextCronRun('*/5 * * * *', at(25, 10, 5))).toBe(at(25, 10, 10));
  });

  it('rolls an hourly job into the next hour', () => {
    expect(nextCronRun('7 * * * *', at(25, 10, 30))).toBe(at(25, 11, 7));
  });

  it('skips the weekend for a weekday schedule', () => {
    // 2026-10-24 is a Saturday.
    expect(nextCronRun('57 8 * * 1-5', at(24, 12, 0))).toBe(at(26, 8, 57));
  });

  it('treats day-of-week 7 as Sunday', () => {
    expect(nextCronRun('0 9 * * 7', at(24, 12, 0))).toBe(at(25, 9, 0));
  });

  it('fires on either day field when both are restricted', () => {
    // The 1st of November, or any Monday — Monday the 26th comes first.
    expect(nextCronRun('0 9 1 * 1', at(25, 12, 0))).toBe(at(26, 9, 0));
  });

  it('returns null when nothing matches inside the window', () => {
    expect(nextCronRun('0 9 30 2 *', at(25, 12, 0))).toBeNull();
    expect(nextCronRun('not a cron', at(25, 12, 0))).toBeNull();
  });
});

describe('describeCron', () => {
  it('names the common /loop intervals', () => {
    expect(describeCron('*/5 * * * *')).toBe('every 5 min');
    expect(describeCron('* * * * *')).toBe('every minute');
    expect(describeCron('7 * * * *')).toBe('hourly at :07');
    expect(describeCron('3 */2 * * *')).toBe('every 2 h');
    expect(describeCron('57 8 * * *')).toBe('daily at 08:57');
    expect(describeCron('57 8 * * 1-5')).toBe('weekdays at 08:57');
  });

  it('falls back to the raw expression for anything rarer', () => {
    expect(describeCron('13 4 31 12 *')).toBe('13 4 31 12 *');
    expect(describeCron('garbage')).toBe('garbage');
  });
});
