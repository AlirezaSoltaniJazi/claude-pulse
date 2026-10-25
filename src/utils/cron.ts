/**
 * Just enough of 5-field cron to describe a loop and predict its next run.
 *
 * Claude Code's CronCreate takes standard `minute hour day-of-month month day-of-week` in local
 * time. Its result records the FIRST fire time only, so for a recurring job everything after
 * that has to be computed here. Names (`MON`, `JAN`) and the `@hourly` shorthands are not
 * supported: CronCreate is documented with numeric fields, and an expression this cannot
 * parse yields null rather than a wrong answer.
 */

interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** Standard cron: when both day fields are restricted, a match on EITHER fires. */
  isDomRestricted: boolean;
  isDowRestricted: boolean;
}

const MINUTE_MS = 60 * 1000;
/** Far enough to cover a recurring job's seven-day life with a day to spare. */
const DEFAULT_SEARCH_WINDOW_MS = 8 * 24 * 60 * MINUTE_MS;

export function parseCron(expr: string): ParsedCron | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const minutes = parseField(fields[0], 0, 59);
  const hours = parseField(fields[1], 0, 23);
  const daysOfMonth = parseField(fields[2], 1, 31);
  const months = parseField(fields[3], 1, 12);
  const daysOfWeek = parseField(fields[4], 0, 7);
  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) return null;

  // 7 is Sunday too.
  if (daysOfWeek.delete(7)) daysOfWeek.add(0);

  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    isDomRestricted: fields[2] !== '*',
    isDowRestricted: fields[4] !== '*',
  };
}

function parseField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!match) return null;

    const step = match[4] === undefined ? 1 : Number(match[4]);
    let start = min;
    let end = max;
    if (match[1] !== '*') {
      start = Number(match[2]);
      // 'a/n' means 'a-max/n'; a bare 'a' is just a.
      end = match[3] !== undefined ? Number(match[3]) : match[4] !== undefined ? max : start;
    }
    if (step < 1 || start < min || end > max || start > end) return null;

    for (let v = start; v <= end; v += step) values.add(v);
  }
  return values;
}

/**
 * Epoch ms of the first minute strictly after `after` that the expression matches, or null
 * when the expression is invalid or nothing matches inside the search window.
 *
 * Minute-by-minute on purpose: the window is about eleven thousand steps, which is nothing,
 * and a clever field-skipping search is exactly where the day-of-month/day-of-week OR rule
 * gets lost.
 */
export function nextCronRun(
  expr: string,
  after: number,
  windowMs: number = DEFAULT_SEARCH_WINDOW_MS
): number | null {
  const cron = parseCron(expr);
  if (!cron) return null;

  const cursor = new Date(after);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const limit = after + windowMs;
  while (cursor.getTime() <= limit) {
    if (matches(cron, cursor)) return cursor.getTime();
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

function matches(cron: ParsedCron, date: Date): boolean {
  if (!cron.minutes.has(date.getMinutes())) return false;
  if (!cron.hours.has(date.getHours())) return false;
  if (!cron.months.has(date.getMonth() + 1)) return false;

  const domMatch = cron.daysOfMonth.has(date.getDate());
  const dowMatch = cron.daysOfWeek.has(date.getDay());
  if (cron.isDomRestricted && cron.isDowRestricted) return domMatch || dowMatch;
  return domMatch && dowMatch;
}

/**
 * Plain-English schedule for the shapes `/loop` actually produces, or the raw expression.
 *
 * Covers intervals ('every 5 min'), hourly and daily times, and weekdays. Anything rarer is
 * returned verbatim: a cron expression is still more honest than a wrong sentence.
 */
export function describeCron(expr: string): string {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5 || !parseCron(expr)) return expr;
  const [minute, hour, dom, month, dow] = fields;

  const isNum = (v: string): boolean => /^\d+$/.test(v);
  const everyN = (v: string): number | null => {
    const m = /^\*\/(\d+)$/.exec(v);
    return m ? Number(m[1]) : null;
  };
  const time = (h: string, m: string): string => `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
  const isDaily = dom === '*' && month === '*';

  if (isDaily && dow === '*') {
    const minuteStep = everyN(minute);
    if (minuteStep !== null && hour === '*') {
      return minuteStep === 1 ? 'every minute' : `every ${minuteStep} min`;
    }
    if (minute === '*' && hour === '*') return 'every minute';
    if (isNum(minute) && hour === '*') return `hourly at :${minute.padStart(2, '0')}`;

    const hourStep = everyN(hour);
    if (isNum(minute) && hourStep !== null) {
      return hourStep === 1 ? `hourly at :${minute.padStart(2, '0')}` : `every ${hourStep} h`;
    }
    if (isNum(minute) && isNum(hour)) return `daily at ${time(hour, minute)}`;
  }

  if (isDaily && isNum(minute) && isNum(hour) && dow === '1-5') {
    return `weekdays at ${time(hour, minute)}`;
  }

  return expr;
}
