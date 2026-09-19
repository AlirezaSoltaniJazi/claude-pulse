import { ClaudeUsage, ExtraUsage, UsageLimit, UsageWindow } from '../types';

/**
 * The legacy flat fields, in display order, with the window each one encodes.
 *
 * The API used to publish one field per rate-limit window and has moved to a self-describing
 * `limits` array; the flat fields now come back null. This table exists only so a response
 * that still carries them (an older account, a replayed cache) renders identically.
 */
const LEGACY_WINDOWS: ReadonlyArray<{
  field: 'five_hour' | 'seven_day' | 'seven_day_sonnet' | 'seven_day_opus';
  kind: string;
  group: string;
  modelLabel: string | null;
}> = [
  { field: 'five_hour', kind: 'session', group: 'session', modelLabel: null },
  { field: 'seven_day', kind: 'weekly_all', group: 'weekly', modelLabel: null },
  { field: 'seven_day_sonnet', kind: 'weekly_scoped', group: 'weekly', modelLabel: 'Sonnet' },
  { field: 'seven_day_opus', kind: 'weekly_scoped', group: 'weekly', modelLabel: 'Opus' },
];

/**
 * Reads the API's `limits` array into typed windows. Lenient by design, matching the JSONL
 * convention: an entry that cannot be rendered as a bar is skipped, never thrown on.
 *
 * Deliberately generic — nothing here knows the name of a model. The API labels each scoped
 * window itself, so 'Fable' surfaces today and whatever ships next surfaces unchanged.
 */
export function parseUsageLimits(raw: unknown): UsageLimit[] {
  if (!Array.isArray(raw)) return [];

  const limits: UsageLimit[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as {
      kind?: unknown;
      group?: unknown;
      percent?: unknown;
      resets_at?: unknown;
      scope?: unknown;
    };

    const kind = typeof e.kind === 'string' ? e.kind.trim() : '';
    if (!kind) continue;

    // A window with no usable percentage cannot be drawn, and showing it as 0% would be a lie.
    const percent = toPercent(e.percent);
    if (percent === null) continue;

    limits.push({
      kind,
      group: typeof e.group === 'string' && e.group.trim() ? e.group.trim() : kind,
      percent,
      resets_at: typeof e.resets_at === 'string' && e.resets_at.trim() ? e.resets_at : null,
      modelLabel: readScopeModelLabel(e.scope),
    });
  }
  return limits;
}

/**
 * Every window to display, newest encoding first.
 *
 * `limits` wins whenever the API sent one. The legacy fields are consulted only when it did
 * not, so a response carrying both never renders the same window twice.
 */
export function resolveLimits(usage: ClaudeUsage | null): UsageLimit[] {
  if (!usage) return [];
  if (usage.limits.length > 0) return usage.limits;

  const limits: UsageLimit[] = [];
  for (const w of LEGACY_WINDOWS) {
    const window: UsageWindow | null = usage[w.field];
    if (!window) continue;
    const percent = toPercent(window.utilization);
    if (percent === null) continue;
    limits.push({
      kind: w.kind,
      group: w.group,
      percent,
      resets_at: window.resets_at,
      modelLabel: w.modelLabel,
    });
  }
  return limits;
}

/**
 * Dashboard label, e.g. 'Current Session (5h)', 'This Week (All Models)', 'This Week (Fable)'.
 * Built from the window's own group and scope, so an unrecognised kind still reads sensibly.
 */
export function limitLabel(limit: UsageLimit): string {
  const base =
    limit.group === 'session'
      ? 'Current Session'
      : limit.group === 'weekly'
        ? 'This Week'
        : prettifyKind(limit.kind);

  const qualifier =
    limit.modelLabel ??
    (limit.group === 'session' ? '5h' : limit.group === 'weekly' ? 'All Models' : '');

  return qualifier ? `${base} (${qualifier})` : base;
}

/** Terse label for the status bar tooltip, e.g. '5h', '7d', '7d Fable'. */
export function limitShortLabel(limit: UsageLimit): string {
  const base =
    limit.group === 'session' ? '5h' : limit.group === 'weekly' ? '7d' : prettifyKind(limit.kind);
  return limit.modelLabel ? `${base} ${limit.modelLabel}` : base;
}

/** The window closest to its cap — what the status bar colors itself by. Null when empty. */
export function pickMaxLimit(limits: UsageLimit[]): UsageLimit | null {
  if (limits.length === 0) return null;
  return limits.reduce((max, l) => (l.percent > max.percent ? l : max), limits[0]);
}

/**
 * The window whose number the status bar shows: the session, which is the one that actually
 * interrupts work, falling back to the busiest window when the API reports no session.
 */
export function pickDisplayLimit(limits: UsageLimit[]): UsageLimit | null {
  return limits.find((l) => l.group === 'session') ?? pickMaxLimit(limits);
}

/** 'weekly_scoped' -> 'Weekly Scoped'. Only reached for a kind this code has never seen. */
function prettifyKind(kind: string): string {
  return kind
    .split(/[_-]+/)
    .filter((t) => t.length > 0)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
    .join(' ');
}

/** Clamped to 0-100: a bar wider than its track, or a negative one, renders as a glitch. */
function toPercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

/**
 * Pulls the scoped model's display name out of a limit's `scope`.
 *
 * The API also scopes by `surface`, which has no model name; such a window is treated as
 * unscoped rather than mislabelled with a surface name where a model belongs.
 */
function readScopeModelLabel(scope: unknown): string | null {
  if (!scope || typeof scope !== 'object') return null;
  const model = (scope as { model?: unknown }).model;
  if (!model || typeof model !== 'object') return null;
  const name = (model as { display_name?: unknown }).display_name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

/**
 * Reads a raw usage API response into `ClaudeUsage`.
 *
 * The endpoint returns a wide, changing object: alongside the documented windows it carries
 * codenamed placeholders for unreleased models ('tangelo', 'nimbus_quill', ...) that appear
 * and disappear without notice. Casting the body straight to `ClaudeUsage`, as this module
 * used to, silently accepted whatever shape arrived. Reading only the fields we render — and
 * treating `limits` as the source of truth — means a new window shows up on its own and an
 * unknown one is ignored rather than misread.
 *
 * Returns null only when the body is not an object at all.
 */
export function normalizeUsage(raw: unknown): ClaudeUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  return {
    five_hour: readWindow(r.five_hour),
    seven_day: readWindow(r.seven_day),
    seven_day_sonnet: readWindow(r.seven_day_sonnet),
    seven_day_opus: readWindow(r.seven_day_opus),
    limits: parseUsageLimits(r.limits),
    extra_usage: readExtraUsage(r.extra_usage),
  };
}

function readWindow(raw: unknown): UsageWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { utilization?: unknown; resets_at?: unknown };
  const utilization = toPercent(r.utilization);
  if (utilization === null) return null;
  return {
    utilization,
    resets_at: typeof r.resets_at === 'string' && r.resets_at.trim() ? r.resets_at : null,
  };
}

function readExtraUsage(raw: unknown): ExtraUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return {
    is_enabled: r.is_enabled === true,
    monthly_limit: toFiniteNumber(r.monthly_limit) ?? 0,
    used_credits: toFiniteNumber(r.used_credits) ?? 0,
    utilization: toFiniteNumber(r.utilization),
    currency: typeof r.currency === 'string' && r.currency.trim() ? r.currency.trim() : undefined,
  };
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
