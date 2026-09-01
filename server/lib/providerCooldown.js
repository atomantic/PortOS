/**
 * Provider cooldown policy — "this run failed; should the provider be benched,
 * and for how long?"
 *
 * One answer, shared by both paths that can observe a provider failing:
 *   - `promptRunner.js` (a one-shot prompt cascade), and
 *   - `agentFinalization.js` (a finished CoS agent run).
 *
 * They used to disagree: the prompt path had this table, and the agent path
 * benched only usage/rate limits — so an `agy` TUI agent blocked on account
 * verification left the provider marked healthy and the next dequeued task
 * picked it again and died the same way. Keeping the policy here means a
 * category benches for the same duration no matter which path noticed.
 *
 * Pure — no I/O, no provider-status handle. Callers own the actual marking.
 */

import { ERROR_CATEGORIES } from './aiToolkit/errorDetection.js';

// Cooldown per error category — how long the failed provider is marked
// unavailable so subsequent calls skip it and proactively use the fallback.
// USAGE_LIMIT is absent because `markUsageLimit` parses the wait time
// from the error body (e.g. "resets 5pm"). Values target the timescale
// the user can plausibly recover the underlying cause:
//   RATE_LIMIT      — 5m: provider-side counter typically clears in minutes
//   AUTH_ERROR      — 15m: usually a config issue that needs human action
//   MODEL_NOT_FOUND — 30m: also config; longer because retry is unlikely
//   QUOTA_EXCEEDED  — 60m: billing/credits; retry sooner is futile
//   NETWORK_ERROR   — 2m: usually a transient hiccup
//   RESOURCE_EXHAUSTED — 2m: a local GPU that just OOM'd needs the in-flight
//                     work to drain before it can serve the same context again;
//                     the endpoint itself is healthy, so this is a short bench
//   TIMEOUT/UNKNOWN — 1m: short enough to retry, long enough to skip
//                     while the immediate workload retries via fallback
export const COOLDOWN_MS_BY_CATEGORY = {
  [ERROR_CATEGORIES.RATE_LIMIT]: 5 * 60 * 1000,
  [ERROR_CATEGORIES.AUTH_ERROR]: 15 * 60 * 1000,
  [ERROR_CATEGORIES.MODEL_NOT_FOUND]: 30 * 60 * 1000,
  [ERROR_CATEGORIES.QUOTA_EXCEEDED]: 60 * 60 * 1000,
  [ERROR_CATEGORIES.NETWORK_ERROR]: 2 * 60 * 1000,
  [ERROR_CATEGORIES.RESOURCE_EXHAUSTED]: 2 * 60 * 1000,
  [ERROR_CATEGORIES.TIMEOUT]: 60 * 1000,
  [ERROR_CATEGORIES.UNKNOWN]: 60 * 1000,
};
export const DEFAULT_COOLDOWN_MS = 60 * 1000;
// A usage limit with no parsed reset window. Matches QUOTA_EXCEEDED's hour:
// both mean "the plan is spent", and retrying inside the hour is futile.
export const DEFAULT_USAGE_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;

// Categories the tiered cascade classifies as schema/type (mirrors
// autoFixer.CATEGORY_TO_TIER's SCHEMA_TYPE entries; kept out of the CoS stack so
// promptRunner stays decoupled from it — see loadAutoFixer). promptRunner tags
// its synthetic response-schema failure 'parse-error' so it lands in this tier
// when it re-enters the cascade.
const SCHEMA_TYPE_CATEGORIES = new Set([
  'parse-error', 'bad-request', 'context-length', 'ollama-context-window', 'output-length',
  'build-error', 'lint-error',
]);
export const isSchemaTypeCategory = (category) => SCHEMA_TYPE_CATEGORIES.has(category);

/**
 * True when a failure is specific to the REQUEST or RESPONSE rather than the
 * provider, so benching the provider would take a healthy service offline for
 * every other caller.
 *
 * A content/safety refusal is prompt-specific — the provider is healthy and
 * other prompts still work. A model-not-found is likewise request-specific: the
 * request named a model id the (reachable) endpoint doesn't have, so benching
 * would take its OTHER valid models offline for the full cooldown (e.g. one bad
 * `codex-configured-default` vision call benching Ollama so a correct
 * `qwen2.5vl` call then proactively swaps to a non-vision fallback). A genuine
 * endpoint outage surfaces as NETWORK_ERROR, not MODEL_NOT_FOUND, so it is still
 * benched. A schema/type failure (#2350) is response-specific: the provider
 * returned HTTP 200 with content that just didn't match this caller's declared
 * schema. In every case the single failing call still falls back via its
 * caller's retry path.
 */
export function isRequestSpecificCategory(category) {
  return category === ERROR_CATEGORIES.CONTENT_REFUSAL
    || category === ERROR_CATEGORIES.MODEL_NOT_FOUND
    || isSchemaTypeCategory(category);
}

/**
 * Decide how a failed provider should be benched.
 *
 * @param {object|null} analysis — an errorDetection / agentErrorAnalysis payload
 * @returns {null
 *   | { marker: 'usage-limit', category: string, message: string|null, waitTime: string|null }
 *   | { marker: 'unavailable', category: string, message: string|null, waitTimeMs: number }}
 *   `null` means "don't bench". The `usage-limit` marker is distinct because
 *   `markUsageLimit` parses its own wait window out of the provider's message.
 */
export function resolveProviderBench(analysis) {
  const category = analysis?.category || ERROR_CATEGORIES.UNKNOWN;
  if (isRequestSpecificCategory(category)) return null;

  const message = analysis?.message || null;
  if (category === ERROR_CATEGORIES.USAGE_LIMIT) {
    return { marker: 'usage-limit', category, message, waitTime: analysis?.waitTime ?? null };
  }
  return {
    marker: 'unavailable',
    category,
    message,
    waitTimeMs: COOLDOWN_MS_BY_CATEGORY[category] ?? DEFAULT_COOLDOWN_MS,
  };
}

/**
 * How long a bench should actually last, in milliseconds.
 *
 * `resolveProviderBench` deliberately returns the `usage-limit` marker WITHOUT a
 * duration, because `providerStatus.markUsageLimit` parses its own window out of
 * the provider's error text. A caller that benches something other than a whole
 * provider record — the ChatGPT-subscription text transport, say — has no such
 * parser, and needs a number.
 *
 * `resetsAt` is the provider's own stated recovery time when one is known (Codex
 * reports it on the rate-limit window). It wins over the category table because
 * it is the truth rather than an estimate, but only when it is a real future
 * timestamp: a past or unparseable value would otherwise resolve to "unbench
 * immediately", which is exactly the failure a bench exists to prevent.
 *
 * @param {ReturnType<typeof resolveProviderBench>} bench
 * @param {{ resetsAt?: string|number|Date|null, now?: number }} [options]
 * @returns {number} milliseconds; `0` when `bench` is null (don't bench)
 */
export function resolveBenchWaitMs(bench, { resetsAt = null, now = Date.now() } = {}) {
  if (!bench) return 0;
  const resetMs = resetsAt == null ? NaN : new Date(resetsAt).getTime();
  if (Number.isFinite(resetMs) && resetMs > now) return resetMs - now;
  if (bench.marker === 'usage-limit') return DEFAULT_USAGE_LIMIT_COOLDOWN_MS;
  return bench.waitTimeMs ?? DEFAULT_COOLDOWN_MS;
}
