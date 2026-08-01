import { SYNTHETIC_MODEL_ID } from '../constants';

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(Math.abs(ms) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
  }
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

export function formatDurationShort(ms: number): string {
  const totalSeconds = Math.floor(Math.abs(ms) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

/**
 * Turns a raw model id into a terse status bar label. Parses rather than looking up,
 * so model ids that do not exist yet still render sensibly without a code change.
 *
 *   'claude-opus-5'                              -> 'Opus 5'
 *   'claude-haiku-4-5-20251001'                  -> 'Haiku 4.5'
 *   'claude-3-5-sonnet-20241022'                 -> 'Sonnet 3.5'
 *   'us.anthropic.claude-opus-4-5-20251101-v1:0' -> 'Opus 4.5'
 *   'claude-opus-5[1m]'                          -> 'Opus 5'
 *
 * Returns '' when there is nothing sensible to show — callers must omit the segment
 * rather than render a placeholder. An id the parser cannot decompose passes through
 * verbatim, so a real model is never reduced to an empty string.
 */
export function formatModelName(modelId: string | null | undefined): string {
  if (typeof modelId !== 'string') return '';
  const raw = modelId.trim();
  if (raw.length === 0 || raw === SYNTHETIC_MODEL_ID) return '';

  const id = raw
    .toLowerCase()
    .replace(/^(?:us|eu|apac|global)\./, '') // Bedrock region prefix
    .replace(/^anthropic[./]/, '') // Bedrock / Vertex vendor prefix
    .replace(/-v\d+(?::\d+)?$/, '') // Bedrock '-v1:0' suffix
    .replace(/@\d+$/, '') // Vertex '@20250101' suffix
    .replace(/\[[^\]]*\]$/, '') // variant tag, e.g. '[1m]'
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '') // trailing YYYYMMDD stamp
    .replace(/-latest$/, '');

  const tokens = id.split('-').filter((t) => t.length > 0);
  const digits = tokens.filter((t) => /^\d+$/.test(t));
  const words = tokens.filter((t) => !/^\d+$/.test(t));
  if (words.length === 0) return raw;

  const family = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return digits.length > 0 ? `${family} ${digits.join('.')}` : family;
}

/** Only 'medium' is abbreviated; everything else passes through, capped at 8 chars. */
const EFFORT_LABELS: Record<string, string> = {
  medium: 'med',
};

/**
 * Formats a reasoning effort level for the status bar. Lowercase by design — the
 * contrast with the Title Case model label is what separates the two visually.
 * Returns '' for empty input so the caller omits the segment.
 */
export function formatEffortLevel(effort: string | null | undefined): string {
  if (typeof effort !== 'string') return '';
  const raw = effort.trim().toLowerCase();
  if (raw.length === 0) return '';
  return EFFORT_LABELS[raw] ?? raw.slice(0, 8);
}
