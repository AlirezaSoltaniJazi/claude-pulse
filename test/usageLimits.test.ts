import { describe, it, expect } from 'vitest';
import {
  limitLabel,
  limitShortLabel,
  normalizeUsage,
  parseUsageLimits,
  pickDisplayLimit,
  pickMaxLimit,
  resolveLimits,
} from '../src/utils/usageLimits';
import { ClaudeUsage, UsageLimit } from '../src/types';

/** Trimmed from a real /api/oauth/usage response, keeping the shape verbatim. */
const LIVE_RESPONSE = {
  five_hour: { utilization: 3.0, resets_at: '2026-09-19T08:20:00Z', limit_dollars: null },
  seven_day: { utilization: 37.0, resets_at: '2026-09-23T10:00:00Z' },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: null,
  // Codenamed placeholders for unreleased models really do appear here.
  nimbus_quill: { utilization: 0.0, resets_at: null },
  tangelo: null,
  limits: [
    {
      kind: 'session',
      group: 'session',
      percent: 3,
      severity: 'normal',
      resets_at: '2026-09-19T08:20:00Z',
      scope: null,
      is_active: false,
    },
    {
      kind: 'weekly_all',
      group: 'weekly',
      percent: 37,
      severity: 'normal',
      resets_at: '2026-09-23T10:00:00Z',
      scope: null,
      is_active: true,
    },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 2,
      severity: 'normal',
      resets_at: '2026-09-23T09:59:59Z',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      is_active: false,
    },
  ],
  extra_usage: { is_enabled: true, monthly_limit: 0, used_credits: 0.0, utilization: null },
};

function limit(over: Partial<UsageLimit> = {}): UsageLimit {
  return {
    kind: 'weekly_all',
    group: 'weekly',
    percent: 10,
    resets_at: null,
    modelLabel: null,
    ...over,
  };
}

function usage(over: Partial<ClaudeUsage> = {}): ClaudeUsage {
  return {
    five_hour: null,
    seven_day: null,
    seven_day_sonnet: null,
    seven_day_opus: null,
    limits: [],
    extra_usage: null,
    ...over,
  };
}

describe('parseUsageLimits', () => {
  it('reads every window from a live response, including the model-scoped one', () => {
    const limits = parseUsageLimits(LIVE_RESPONSE.limits);

    expect(limits).toEqual([
      {
        kind: 'session',
        group: 'session',
        percent: 3,
        resets_at: '2026-09-19T08:20:00Z',
        modelLabel: null,
      },
      {
        kind: 'weekly_all',
        group: 'weekly',
        percent: 37,
        resets_at: '2026-09-23T10:00:00Z',
        modelLabel: null,
      },
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: 2,
        resets_at: '2026-09-23T09:59:59Z',
        modelLabel: 'Fable',
      },
    ]);
  });

  it('surfaces a model the code has never heard of', () => {
    const limits = parseUsageLimits([
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: 5,
        scope: { model: { display_name: 'Nimbus' } },
      },
    ]);

    expect(limits[0].modelLabel).toBe('Nimbus');
  });

  it('skips entries that cannot be rendered', () => {
    const limits = parseUsageLimits([
      { kind: '', group: 'weekly', percent: 5 }, // no id
      { kind: 'weekly_all', group: 'weekly', percent: null }, // no percentage
      { kind: 'weekly_all', group: 'weekly' }, // percentage absent
      null,
      'nonsense',
    ]);

    expect(limits).toEqual([]);
  });

  it('returns nothing when the field is absent or not an array', () => {
    expect(parseUsageLimits(undefined)).toEqual([]);
    expect(parseUsageLimits({ kind: 'session' })).toEqual([]);
  });

  it('clamps a percentage into 0-100 so the bar cannot overflow its track', () => {
    const limits = parseUsageLimits([
      { kind: 'a', group: 'weekly', percent: 140 },
      { kind: 'b', group: 'weekly', percent: -5 },
    ]);

    expect(limits.map((l) => l.percent)).toEqual([100, 0]);
  });

  it('treats a surface-only scope as unscoped rather than labelling it with a surface', () => {
    const limits = parseUsageLimits([
      { kind: 'weekly_scoped', group: 'weekly', percent: 5, scope: { surface: 'code' } },
    ]);

    expect(limits[0].modelLabel).toBeNull();
  });

  it('falls back to kind when group is missing', () => {
    expect(parseUsageLimits([{ kind: 'session', percent: 1 }])[0].group).toBe('session');
  });
});

describe('resolveLimits', () => {
  it('prefers the limits array over the legacy flat fields', () => {
    const resolved = resolveLimits(
      usage({
        limits: [limit({ kind: 'weekly_scoped', percent: 2, modelLabel: 'Fable' })],
        five_hour: { utilization: 99, resets_at: null },
      })
    );

    expect(resolved).toHaveLength(1);
    expect(resolved[0].modelLabel).toBe('Fable');
  });

  it('synthesizes windows from the legacy fields when no limits array was sent', () => {
    const resolved = resolveLimits(
      usage({
        five_hour: { utilization: 50, resets_at: 'x' },
        seven_day_opus: { utilization: 12, resets_at: null },
      })
    );

    expect(resolved.map((l) => [limitShortLabel(l), l.percent])).toEqual([
      ['5h', 50],
      ['7d Opus', 12],
    ]);
  });

  it('returns nothing for a response with no windows at all', () => {
    expect(resolveLimits(usage())).toEqual([]);
    expect(resolveLimits(null)).toEqual([]);
  });
});

describe('labels', () => {
  it('names the windows a live response contains', () => {
    const [session, weekly, scoped] = parseUsageLimits(LIVE_RESPONSE.limits);

    expect(limitLabel(session)).toBe('Current Session (5h)');
    expect(limitLabel(weekly)).toBe('This Week (All Models)');
    expect(limitLabel(scoped)).toBe('This Week (Fable)');

    expect(limitShortLabel(session)).toBe('5h');
    expect(limitShortLabel(weekly)).toBe('7d');
    expect(limitShortLabel(scoped)).toBe('7d Fable');
  });

  it('reads sensibly for a group it has never seen', () => {
    const odd = limit({ kind: 'monthly_spend', group: 'monthly', modelLabel: null });

    expect(limitLabel(odd)).toBe('Monthly Spend');
    expect(limitShortLabel(odd)).toBe('Monthly Spend');
  });
});

describe('pickDisplayLimit / pickMaxLimit', () => {
  it('shows the session window even when a weekly window is busier', () => {
    const limits = [
      limit({ kind: 'weekly_all', percent: 90 }),
      limit({ kind: 'session', group: 'session', percent: 3 }),
    ];

    expect(pickDisplayLimit(limits)?.percent).toBe(3);
    expect(pickMaxLimit(limits)?.percent).toBe(90);
  });

  it('falls back to the busiest window when there is no session window', () => {
    const limits = [limit({ percent: 10 }), limit({ percent: 42 })];

    expect(pickDisplayLimit(limits)?.percent).toBe(42);
  });

  it('returns null for an empty list', () => {
    expect(pickDisplayLimit([])).toBeNull();
    expect(pickMaxLimit([])).toBeNull();
  });
});

describe('normalizeUsage', () => {
  it('reads a live response into the shape the UI consumes', () => {
    const result = normalizeUsage(LIVE_RESPONSE);

    expect(result?.five_hour).toEqual({ utilization: 3, resets_at: '2026-09-19T08:20:00Z' });
    expect(result?.seven_day_opus).toBeNull();
    expect(result?.limits).toHaveLength(3);
    expect(result?.limits[2].modelLabel).toBe('Fable');
  });

  it('keeps a null extra-usage utilization null instead of inventing a zero', () => {
    expect(normalizeUsage(LIVE_RESPONSE)?.extra_usage?.utilization).toBeNull();
  });

  it('ignores the codenamed placeholder windows entirely', () => {
    const result = normalizeUsage(LIVE_RESPONSE) as unknown as Record<string, unknown>;

    expect(result.nimbus_quill).toBeUndefined();
    expect(result.tangelo).toBeUndefined();
  });

  it('returns null only when the body is not an object', () => {
    expect(normalizeUsage(null)).toBeNull();
    expect(normalizeUsage('boom')).toBeNull();
    expect(normalizeUsage({})).not.toBeNull();
  });
});
