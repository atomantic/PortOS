/**
 * What a large prompt costs on a LOCAL inference endpoint (#6117).
 *
 * A public-review Stage 3 dispatch inlines the whole screened
 * `<cleared-public-review-input>` envelope, which routinely runs to ~100K
 * tokens. A hosted provider prefills that in seconds; a model server on this
 * box does not — the observed run sat silent for ~9 minutes before the child
 * emitted its first line, against a run the queue expected to take ~13 minutes
 * end to end. Nothing compared the assembled prompt against the throughput of
 * the endpoint it was about to be dispatched to, so the run either finished
 * with no margin or looked wedged the whole time it was healthy.
 *
 * This module answers that one question, and only for an endpoint on this
 * machine: how long is this prompt's prefill, and what does the run's duration
 * estimate become once that is added to it. It deliberately does NOT refuse a
 * dispatch — the user chose the local provider, and refusing would make a
 * legitimately-configured endpoint unusable for the stage. Refusal stays the
 * answer only when the prompt exceeds the model's advertised context window,
 * which is a separate, already-fatal condition the provider itself reports.
 *
 * Trimming the envelope is explicitly not an option here: the reviewer must see
 * the complete screened material, and a truncated one produces a review of a
 * partial patch.
 *
 * Pure / side-effect-free — unit-tested in localPromptBudget.test.js.
 */

import { estimateTokens } from './contextBudget.js';

/**
 * Prefill throughput assumed for a model server on this machine, in tokens per
 * second. Deliberately BELOW what the observed run measured (~100K tokens in
 * ~9 minutes ≈ 185 tok/s on a 27B local model): the number exists to keep an
 * estimate from undershooting, and an over-estimate merely widens the window a
 * healthy run is allowed, while an under-estimate re-creates the bug.
 *
 * It is a single conservative constant on purpose. A per-model measured rate
 * would be more accurate and is not needed to answer "is this prompt going to
 * cost minutes?" — the question this budget exists for.
 */
export const LOCAL_PREFILL_TOKENS_PER_SECOND = 120;

/**
 * Prefill at or above which a run is expected to be SILENT for long enough that
 * a viewer would otherwise read it as wedged. One minute: below that the card's
 * ordinary "initializing" state already covers the gap.
 */
export const LONG_PREFILL_MS = 60_000;

const positiveNumber = (value) => (Number.isFinite(value) && value > 0 ? value : null);

/**
 * Milliseconds of prefill `promptTokens` costs at `tokensPerSecond`.
 *
 * `null` — not `0` — for a non-positive/garbled token count, so "no estimate"
 * can never be mistaken for "estimated to be instant".
 */
export function estimateLocalPrefillMs(promptTokens, tokensPerSecond = LOCAL_PREFILL_TOKENS_PER_SECOND) {
  const tokens = positiveNumber(Number(promptTokens));
  const rate = positiveNumber(Number(tokensPerSecond)) ?? LOCAL_PREFILL_TOKENS_PER_SECOND;
  if (tokens === null) return null;
  return Math.ceil((tokens / rate) * 1000);
}

/**
 * What a run's duration estimate should be, given the prompt it is about to be
 * dispatched with and the endpoint that prompt lands on.
 *
 * @param {object} args
 * @param {string} args.prompt - the FULLY assembled prompt (the envelope included).
 * @param {string|null} args.endpoint - the local endpoint this run's inference
 *   occupies (`localEndpointOfProvider`), or null/'' for a cloud provider.
 * @param {number|null} [args.baseDurationMs] - the run's duration estimate
 *   before prefill (the learned per-task-type average). `null` = nothing
 *   learned yet, which is NOT the same as "estimated at zero".
 * @param {number} [args.tokensPerSecond]
 * @returns {null | {
 *   endpoint: string, promptChars: number, promptTokens: number,
 *   tokensPerSecond: number, prefillMs: number,
 *   baseDurationMs: number|null, expectedDurationMs: number|null,
 *   longPrefill: boolean
 * }}
 *   `null` when the question does not apply — a cloud endpoint, or no prompt to
 *   measure. A caller must treat that as "no estimate", never as a small one.
 */
export function planLocalPromptBudget({
  prompt,
  endpoint,
  baseDurationMs = null,
  tokensPerSecond = LOCAL_PREFILL_TOKENS_PER_SECOND,
} = {}) {
  const target = typeof endpoint === 'string' ? endpoint.trim() : '';
  if (!target) return null;
  const text = typeof prompt === 'string' ? prompt : '';
  if (!text) return null;

  const rate = positiveNumber(Number(tokensPerSecond)) ?? LOCAL_PREFILL_TOKENS_PER_SECOND;
  const promptTokens = estimateTokens(text);
  const prefillMs = estimateLocalPrefillMs(promptTokens, rate);
  if (prefillMs === null) return null;

  const base = positiveNumber(Number(baseDurationMs));
  return {
    endpoint: target,
    promptChars: text.length,
    promptTokens,
    tokensPerSecond: rate,
    prefillMs,
    baseDurationMs: base === null ? null : Math.round(base),
    // The RAISED estimate: whatever the run was expected to take, plus the
    // prefill this prompt costs before the model can emit its first token.
    // Stays `null` when nothing was learned — reporting the bare prefill as the
    // whole run's estimate would understate it just as badly as the bug did.
    expectedDurationMs: base === null ? null : Math.round(base) + prefillMs,
    longPrefill: prefillMs >= LONG_PREFILL_MS,
  };
}

/** One-line, human-readable summary of a plan for a log line or a UI title. */
export function describeLocalPromptBudget(plan) {
  if (!plan) return null;
  const minutes = (ms) => `${(ms / 60000).toFixed(1)}m`;
  const expected = plan.expectedDurationMs === null
    ? 'no learned run estimate to raise'
    : `run estimate raised to ~${minutes(plan.expectedDurationMs)}`;
  return `~${plan.promptTokens} prompt tokens at ${plan.endpoint} — expect ~${minutes(plan.prefillMs)} of silent prefill before the first line (${expected})`;
}
