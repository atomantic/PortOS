/**
 * Canonical usage-ledger counter field lists and pure bucket helpers.
 *
 * Shared across recording, reconciliation, native history overlay, peer digests,
 * and cost reporting as a zero-dependency leaf source of truth.
 */

export const BASE_TOKEN_FIELDS = Object.freeze([
  'tokensIn', 'tokensOut', 'cacheReadTokens', 'cacheWriteTokens',
]);

export const TOKEN_FIELDS = Object.freeze([
  'messages', ...BASE_TOKEN_FIELDS,
]);

export const LONG_USAGE_FIELDS = Object.freeze([
  'longTokensIn', 'longTokensOut', 'longCacheReadTokens', 'longCacheWriteTokens',
]);

export const FAST_LEDGER_FIELDS = Object.freeze([
  'fastTokensIn', 'fastTokensOut', 'fastCacheReadTokens', 'fastCacheWriteTokens',
]);

export const ULTRAFAST_LEDGER_FIELDS = Object.freeze([
  'ultrafastTokensIn', 'ultrafastTokensOut', 'ultrafastCacheReadTokens', 'ultrafastCacheWriteTokens',
]);

/** Ledger names for the Fast and Ultrafast subsets. Absent means zero. */
export const SPEED_LEDGER_FIELDS = Object.freeze([
  ...FAST_LEDGER_FIELDS,
  ...ULTRAFAST_LEDGER_FIELDS,
]);

export const SPEED_CLASS_FIELDS = Object.freeze([
  FAST_LEDGER_FIELDS,
  ULTRAFAST_LEDGER_FIELDS,
]);

/** All token-tier fields (base + long-context + speed subsets), excluding messages/media. */
export const TOKEN_TIER_FIELDS = Object.freeze([
  ...BASE_TOKEN_FIELDS,
  ...LONG_USAGE_FIELDS,
  ...SPEED_LEDGER_FIELDS,
]);

/** Messages plus every token-tier field. */
export const ALL_TOKEN_FIELDS = Object.freeze([
  'messages',
  ...TOKEN_TIER_FIELDS,
]);

/** Imagine / non-token media unit counters. */
export const MEDIA_USAGE_FIELDS = Object.freeze([
  'images', 'videoSeconds', 'inputImages',
]);

/** Full set of per-bucket usage counters priced or summed in reports and corrections. */
export const USAGE_COUNT_FIELDS = Object.freeze([
  ...ALL_TOKEN_FIELDS,
  ...MEDIA_USAGE_FIELDS,
]);

const positiveNum = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

/** Merge two Codex high-water boundary snapshots by per-field maximum. */
export function mergeCodexBoundary(existing, value) {
  const merged = {};
  for (const field of TOKEN_FIELDS) {
    merged[field] = Math.max(existing?.[field] || 0, value?.[field] || 0);
  }
  for (const field of SPEED_LEDGER_FIELDS) {
    const amount = Math.max(existing?.[field] || 0, value?.[field] || 0);
    if (amount) merged[field] = amount;
  }
  return merged;
}

/** Recompute a day bucket's top-level totals from its `byProvider` entries. */
export function rebuildDayTotals(day) {
  const providers = Object.values(day.byProvider || {});
  day.sessions = providers.reduce((sum, provider) => sum + positiveNum(provider?.sessions), 0);
  day.messages = providers.reduce((sum, provider) => sum + positiveNum(provider?.messages), 0);
  day.tokensIn = providers.reduce((sum, provider) => sum + positiveNum(provider?.tokensIn), 0);
  day.tokensOut = providers.reduce((sum, provider) => sum + positiveNum(provider?.tokensOut), 0);
  day.tokens = day.tokensOut;
}
