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
  HEAVY: 'heavy',
  ULTRA: 'ultra'
};

export const RUN_TYPES = {
  AI: 'ai',
  COMMAND: 'command'
};

export const DEFAULT_TIMEOUT = 300000;
// Explicit per-call safety ceiling. High-effort creative planning and repair
// stages can legitimately reason for well over 30 minutes; the old cap killed
// active TUI work and then repeated the same expensive prompt on a fallback.
// Match the long-running TUI-agent ceiling so a user can grant a quality-first
// run enough wall time while every individual provider still keeps its own,
// normally much smaller, configured timeout.
export const MAX_TIMEOUT = 43_200_000;
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

/** Resolve a capability request against one provider, preserving legacy defaults. */
export function resolveProviderModelTier(provider, tier) {
  if (!Object.values(MODEL_TIERS).includes(tier)) return null;
  return provider[`${tier}Model`]
    || (tier === 'ultra' ? provider.heavyModel : null)
    || provider.defaultModel
    || null;
}
