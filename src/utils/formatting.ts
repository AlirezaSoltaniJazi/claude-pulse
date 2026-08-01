import { NON_MODEL_SELECTORS, SYNTHETIC_MODEL_ID } from '../constants';

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

export interface ParsedModelId {
  /** Lowercase word tokens joined by spaces, e.g. 'opus', 'sonnet'. Never empty. */
  family: string;
  /** Digit tokens joined by '.', e.g. '5', '4.5'. Empty when the id carries no version. */
  version: string;
}

/** Strips every vendor prefix, region prefix, variant tag and date stamp we have seen. */
function normalizeModelId(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^(?:us|eu|apac|global)\./, '') // Bedrock region prefix
    .replace(/^anthropic[./]/, '') // Bedrock / Vertex vendor prefix
    .replace(/-v\d+(?::\d+)?$/, '') // Bedrock '-v1:0' suffix
    .replace(/@\d+$/, '') // Vertex '@20250101' suffix
    .replace(/\[[^\]]*\]$/, '') // variant tag, e.g. '[1m]'
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '') // trailing YYYYMMDD stamp
    .replace(/-latest$/, '');
}

/**
 * Splits a model id into its family and version parts.
 *
 *   'claude-opus-5'  -> { family: 'opus',   version: '5'   }
 *   'opus[1m]'       -> { family: 'opus',   version: ''    }  (a bare alias)
 *   'claude-3-5-sonnet-20241022' -> { family: 'sonnet', version: '3.5' }
 *
 * Returns null when the input is not a model id at all: blank, the synthetic placeholder,
 * a non-model `/model` selector ('default', 'opusplan'), or something with no word tokens
 * to name a family with. Callers use the family to compare two ids without their versions.
 */
export function parseModelId(modelId: string | null | undefined): ParsedModelId | null {
  if (typeof modelId !== 'string') return null;
  const raw = modelId.trim();
  if (raw.length === 0 || raw === SYNTHETIC_MODEL_ID) return null;

  const id = normalizeModelId(raw);
  if (id.length === 0 || NON_MODEL_SELECTORS.has(id)) return null;

  const tokens = id.split('-').filter((t) => t.length > 0);
  const digits = tokens.filter((t) => /^\d+$/.test(t));
  const words = tokens.filter((t) => !/^\d+$/.test(t));
  if (words.length === 0) return null;

  return { family: words.join(' '), version: digits.join('.') };
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
 *   'opus[1m]'                                   -> 'Opus'    (a bare alias)
 *
 * Returns '' when there is nothing sensible to show — callers must omit the segment
 * rather than render a placeholder. An id the parser cannot decompose passes through
 * verbatim, so a real model is never reduced to an empty string.
 */
export function formatModelName(modelId: string | null | undefined): string {
  if (typeof modelId !== 'string') return '';
  const raw = modelId.trim();
  if (raw.length === 0 || raw === SYNTHETIC_MODEL_ID) return '';
  // 'Default' / 'Opusplan' would be worse than showing nothing: neither names a model.
  if (NON_MODEL_SELECTORS.has(normalizeModelId(raw))) return '';

  const parsed = parseModelId(raw);
  if (!parsed) return raw;

  const family = parsed.family
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return parsed.version.length > 0 ? `${family} ${parsed.version}` : family;
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
