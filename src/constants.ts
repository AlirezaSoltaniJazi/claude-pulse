// API
export const USAGE_API_HOSTNAME = 'api.anthropic.com';
export const USAGE_API_PATH = '/api/oauth/usage';
export const API_TIMEOUT_MS = 15_000;
export const MAX_RETRIES = 3;
export const MAX_BACKOFF_MS = 10_000;
export const MIN_BACKOFF_429_MS = 5_000;
export const USAGE_CACHE_TTL_MS = 30_000;

// Keychain
export const KEYCHAIN_SERVICE = 'Claude Code-credentials';
export const KEYCHAIN_TIMEOUT_MS = 10_000;

// JSONL Scanner
export const SCAN_CACHE_TTL_MS = 60_000;

// Session Monitor
export const LIVENESS_CHECK_INTERVAL_MS = 10_000;

// Status Bar
export const STATUS_BAR_TICK_MS = 1_000;
export const USAGE_WARNING_THRESHOLD = 75;
export const USAGE_CRITICAL_THRESHOLD = 90;

// Config Defaults
export const DEFAULT_POLLING_INTERVAL_SEC = 30;
export const DEFAULT_USAGE_REFRESH_INTERVAL_SEC = 3600;
export const MIN_USAGE_REFRESH_INTERVAL_SEC = 60;
export const DEFAULT_SESSION_RESET_MINUTES = 300;
export const DEFAULT_SESSION_TOKEN_LIMIT = 8_000_000;
