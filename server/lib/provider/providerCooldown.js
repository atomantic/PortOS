/**
 * Provider bench policy: "this run failed.
 *
 * should the provider be benched, and for how long?" `resolveProviderBench(analysis)` → `null` (don't bench) / a `usage-limit` marker / an `unavailable` marker with the per-category cooldown from `COOLDOWN_MS_BY_CATEGORY`. Declines request/response-specific categories (`isRequestSpecificCategory` / `isSchemaTypeCategory`) so one bad model id or off-shape response can't take a healthy provider offline. One answer shared by `services/promptRunner.js` (prompt cascade) and `services/agent/agentFinalization.js` (finished CoS agent run): the agent path once benched only usage limits, so an `agy` TUI blocked on account verification stayed "healthy" and was re-picked and died the same way. Pure: no I/O or provider-status handle; callers own the marking.
 */

import { ERROR_CATEGORIES } from '../aiToolkit/errorDetection.js';

// Cooldown per error category: how long a failed provider is marked unavailable so later calls skip it and use the fallback. USAGE_LIMIT is absent because `markUsageLimit` parses the wait from the error body.
// Values target how soon the cause can plausibly recover:
//   RATE_LIMIT 5m (counter clears in minutes); AUTH_ERROR 15m (config, needs a human); MODEL_NOT_FOUND 30m (config; retry unlikely); QUOTA_EXCEEDED 60m (billing; sooner is futile);
//   NETWORK_ERROR 2m (transient); RESOURCE_EXHAUSTED 2m (a local GPU that just OOM'd must drain in-flight work; the endpoint is healthy, so a short bench);
//   TIMEOUT/UNKNOWN 1m (long enough to skip while the workload retries via fallback). For TIMEOUT that is only the FLOOR (see benchMsForTimeout): a run that burned its whole budget
//   benches at least that long, or the next caller repeats the same full-length stall.
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
// Categories only the CoS agent analysis (services/agent/agentErrorAnalysis.js) emits, mapped to the toolkit category with the same meaning so the bench window matches. The returned `category` is unchanged.
const COOLDOWN_CATEGORY_ALIASES = {
  forbidden: ERROR_CATEGORIES.AUTH_ERROR,
};
export const DEFAULT_COOLDOWN_MS = 60 * 1000;
// A usage limit with no parsed reset window; matches QUOTA_EXCEEDED's hour (both mean "the plan is spent").
export const DEFAULT_USAGE_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;
// The longest a bench may last: a provider-reported reset is trusted over the table, but a weekly window or a value that merely parses (bare epoch seconds read as a year) would take a provider offline for days.
export const MAX_BENCH_MS = 24 * 60 * 60 * 1000;

// Categories the tiered cascade classifies as schema/type (mirrors autoFixer.CATEGORY_TO_TIER's SCHEMA_TYPE entries; kept out of the CoS stack to keep promptRunner decoupled, see loadAutoFixer).
// promptRunner tags its synthetic response-schema failure 'parse-error' so it lands in this tier.
const SCHEMA_TYPE_CATEGORIES = new Set([
  'parse-error', 'bad-request', 'context-length', 'ollama-context-window', 'output-length',
  'build-error', 'lint-error',
]);
export const isSchemaTypeCategory = (category) => SCHEMA_TYPE_CATEGORIES.has(category);

// Every runner prints the blown budget as "CLI run timed out after 600000ms"; captured so `benchMsForTimeout` can bench for at least that.
const TIMEOUT_BUDGET_RE = /timed out after +([0-9]+) *ms/i;

/**
 * True when a failure is specific to the REQUEST or RESPONSE rather than the provider, so benching would take a healthy service offline for every other caller. A content/safety refusal is prompt-specific.
 * A model-not-found is request-specific: the (reachable) endpoint lacks that model id, and benching would take its OTHER models offline (one bad `codex-configured-default` vision call benching Ollama
 * so a correct `qwen2.5vl` call swaps to a non-vision fallback); a genuine outage surfaces as NETWORK_ERROR and is still benched. A schema/type failure (#2350) is response-specific (HTTP 200,
 * content off this caller's schema). The failing call still falls back via its caller's retry path.
 */
export function isRequestSpecificCategory(category) {
  return category === ERROR_CATEGORIES.CONTENT_REFUSAL
    || category === ERROR_CATEGORIES.MODEL_NOT_FOUND
    || category === ERROR_CATEGORIES.IMAGE_UNSUPPORTED
    || isSchemaTypeCategory(category);
}

/**
 * How long to bench a run that died on its own wall-clock timeout. Its cost is stated in its message: the run consumed the provider's whole configured budget, so benching for less is self-defeating
 * (the next caller pays the same stall; seen on a pinned local backend: ten consecutive 600s timeouts, each followed by a 60s bench). Take the larger of the category floor and the named timeout, clamped to
 * {@link MAX_BENCH_MS}. Every runner spells the budget "… timed out after 600000ms" (services/runner.js, aiToolkit/runner.js, lib/cliProviderRun.js); a message with no parsable budget (TUI retry-exhaustion) keeps the floor.
 *
 * @param {string|null} message — the failure message
 * @param {number} floorMs — the category’s table value
 * @returns {number} milliseconds
 */
function benchMsForTimeout(message, floorMs) {
  const match = typeof message === 'string' ? message.match(TIMEOUT_BUDGET_RE) : null;
  const budgetMs = match ? Number(match[1]) : NaN;
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) return floorMs;
  return Math.min(Math.max(floorMs, budgetMs), MAX_BENCH_MS);
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
  if (category === ERROR_CATEGORIES.RUNTIME_BUDGET_EXHAUSTED || isRequestSpecificCategory(category)) return null;

  const message = analysis?.message || null;
  if (category === ERROR_CATEGORIES.USAGE_LIMIT) {
    return { marker: 'usage-limit', category, message, waitTime: analysis?.waitTime ?? null };
  }
  const floorMs = COOLDOWN_MS_BY_CATEGORY[COOLDOWN_CATEGORY_ALIASES[category] ?? category] ?? DEFAULT_COOLDOWN_MS;
  return {
    marker: 'unavailable',
    category,
    message,
    waitTimeMs: category === ERROR_CATEGORIES.TIMEOUT ? benchMsForTimeout(message, floorMs) : floorMs,
  };
}

/**
 * How long a bench should actually last, in milliseconds. `resolveProviderBench` returns the `usage-limit` marker WITHOUT a duration (`providerStatus.markUsageLimit` parses its own window), so a caller
 * benching something other than a provider record (the ChatGPT-subscription text transport) needs this number. `resetsAt` (e.g. Codex's rate-limit window) is the provider's own recovery time and wins over
 * the table, but only as a real future timestamp: a past or unparseable value would "unbench immediately", the failure a bench exists to prevent. It is also clamped to {@link MAX_BENCH_MS}.
 *
 * @param {ReturnType<typeof resolveProviderBench>} bench
 * @param {{ resetsAt?: string|number|Date|null, now?: number }} [options]
 * @returns {number} milliseconds; `0` when `bench` is null (don't bench)
 */
export function resolveBenchWaitMs(bench, { resetsAt = null, now = Date.now() } = {}) {
  if (!bench) return 0;
  const resetMs = resetsAt == null ? NaN : new Date(resetsAt).getTime();
  if (Number.isFinite(resetMs) && resetMs > now) return Math.min(resetMs - now, MAX_BENCH_MS);
  if (bench.marker === 'usage-limit') return DEFAULT_USAGE_LIMIT_COOLDOWN_MS;
  return bench.waitTimeMs ?? DEFAULT_COOLDOWN_MS;
}
