/**
 * Shared constants for the in-tree AI toolkit (formerly portos-ai-toolkit npm).
 */

export const PROVIDER_TYPES = Object.freeze({
  CLI: 'cli',
  TUI: 'tui',
  API: 'api'
});

export const MODEL_TIERS = {
  LIGHT: 'light',
  MEDIUM: 'medium',
  HEAVY: 'heavy'
};

export const RUN_TYPES = {
  AI: 'ai',
  COMMAND: 'command'
};

export const DEFAULT_TIMEOUT = 300000;
export const MAX_TIMEOUT = 1800000;
export const MIN_TIMEOUT = 1000;

export const DEFAULT_TEMPERATURE = 0.1;
export const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

export const ERROR_CATEGORIES = {
  RATE_LIMIT: 'rate-limit',
  USAGE_LIMIT: 'usage-limit',
  AUTH_ERROR: 'auth-error',
  MODEL_NOT_FOUND: 'model-not-found',
  NETWORK_ERROR: 'network-error',
  TIMEOUT: 'timeout',
  QUOTA_EXCEEDED: 'quota-exceeded',
  UNKNOWN: 'unknown'
};

export const PROVIDER_STATUS_REASONS = {
  OK: 'ok',
  USAGE_LIMIT: 'usage-limit',
  RATE_LIMIT: 'rate-limit',
  AUTH_ERROR: 'auth-error',
  NETWORK_ERROR: 'network-error'
};

export const DEFAULT_USAGE_LIMIT_WAIT = 24 * 60 * 60 * 1000;
export const DEFAULT_RATE_LIMIT_WAIT = 5 * 60 * 1000;
