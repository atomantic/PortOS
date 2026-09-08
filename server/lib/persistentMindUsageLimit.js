/**
 * Hard provider usage-limit detection for Persistent Mind wakes.
 *
 * Persistent Mind pins one provider/model with no automatic fallback pool
 * (see persistentMindAdapter / persistentMindProfile). When that provider
 * returns a hard quota / usage-limit / billing exhaustion, retrying only
 * burns wakes and climbs failureCount. Soft rate-limits and network blips
 * must keep the existing interrupted + backoff path.
 *
 * After an autopause, the supervisor periodically probes whether the pinned
 * provider is usable again and auto-resumes only for this pause reason.
 * If a future adapter ever exposes alternate usage options, call sites should
 * attempt those first and only autopause when none remain.
 */

import { analyzeError, ERROR_CATEGORIES } from './aiToolkit/errorDetection.js';

/** Clear pauseReason so the Mind UI / Helm watch stay quiet and actionable. */
export const PROVIDER_USAGE_LIMIT_PAUSE_REASON =
  'Provider usage limit — paused to avoid retries';

/**
 * Probe cadence after a usage-limit autopause.
 * First check is short so a brief quota window can clear without a human;
 * later probes back off so we do not spam readiness checks.
 */
export const USAGE_LIMIT_PROBE_BASE_MS = 60_000;
export const USAGE_LIMIT_PROBE_MAX_MS = 30 * 60_000;

const HARD_USAGE_LIMIT_CATEGORIES = new Set([
  ERROR_CATEGORIES.USAGE_LIMIT,
  ERROR_CATEGORIES.QUOTA_EXCEEDED,
]);

/**
 * Short CLI / SDK quota idioms the shared analyzer can miss on terse errors
 * (OpenAI `insufficient_quota`, bare "quota exhausted", Cursor Pro upsell).
 * Kept tighter than a generic "quota" sweep so ordinary prose and rate-limit
 * copy do not autopause.
 */
const HARD_USAGE_LIMIT_EXTRA = new RegExp([
  'exceeded your current quota',
  'insufficient[_ ]quota',
  'quota[_ ]exhausted',
  'out of quota',
  'usage[_ ]quota[_ ]exceeded',
  'Get Cursor Pro',
  'quota exceeded',
].join('|'), 'i');

function attachedCategory(errorOrMessage) {
  if (!errorOrMessage || typeof errorOrMessage !== 'object') return null;
  const value = errorOrMessage.category || errorOrMessage.errorCategory || null;
  return typeof value === 'string' && value ? value : null;
}

function errorText(errorOrMessage) {
  if (typeof errorOrMessage === 'string') return errorOrMessage;
  return String(errorOrMessage?.message || errorOrMessage || '');
}

/**
 * Classify a provider error for Persistent Mind wake policy.
 *
 * @param {unknown} errorOrMessage — Error, rejection value, or message string
 * @returns {{ hardUsageLimit: boolean, category: string|null, analysis: object|null }}
 */
export function classifyPersistentMindProviderError(errorOrMessage) {
  if (errorOrMessage == null || errorOrMessage === '') {
    return { hardUsageLimit: false, category: null, analysis: null };
  }

  const attached = attachedCategory(errorOrMessage);
  if (attached && HARD_USAGE_LIMIT_CATEGORIES.has(attached)) {
    return { hardUsageLimit: true, category: attached, analysis: null };
  }
  // Trust an attached soft category (rate-limit / network / timeout) so a
  // transient 429 never autopauses even if the message also mentions "limit".
  if (attached === ERROR_CATEGORIES.RATE_LIMIT
    || attached === ERROR_CATEGORIES.NETWORK_ERROR
    || attached === ERROR_CATEGORIES.TIMEOUT) {
    return { hardUsageLimit: false, category: attached, analysis: null };
  }

  const text = errorText(errorOrMessage);
  if (!text.trim()) {
    return { hardUsageLimit: false, category: attached, analysis: null };
  }

  const analysis = analyzeError(text);
  if (analysis.hasError && HARD_USAGE_LIMIT_CATEGORIES.has(analysis.category)) {
    return { hardUsageLimit: true, category: analysis.category, analysis };
  }

  if (HARD_USAGE_LIMIT_EXTRA.test(text)) {
    return {
      hardUsageLimit: true,
      category: ERROR_CATEGORIES.USAGE_LIMIT,
      analysis: analysis.hasError ? analysis : null,
    };
  }

  return {
    hardUsageLimit: false,
    category: analysis.hasError ? analysis.category : attached,
    analysis: analysis.hasError ? analysis : null,
  };
}

export function isHardProviderUsageLimitError(errorOrMessage) {
  return classifyPersistentMindProviderError(errorOrMessage).hardUsageLimit === true;
}

/** True only for the dedicated usage-limit autopause string — never other pauses. */
export function isUsageLimitPauseReason(reason) {
  return reason === PROVIDER_USAGE_LIMIT_PAUSE_REASON;
}

/**
 * Delay until the next readiness probe after a usage-limit autopause.
 * @param {number} attempt — zero-based probe attempt count
 */
export function usageLimitProbeDelayMs(attempt = 0) {
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const delay = USAGE_LIMIT_PROBE_BASE_MS * (2 ** Math.min(n, 8));
  return Math.min(USAGE_LIMIT_PROBE_MAX_MS, delay);
}
