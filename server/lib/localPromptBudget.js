/**
 * What a large prompt costs to PREFILL on a model server on this machine (#6117).
 *
 * `planLocalPromptBudget` returns `{ promptTokens, prefillMs, expectedDurationMs, longPrefill, ... }`,
 * or `null` for a cloud endpoint / no prompt, which a caller must read as "no estimate", never a small one.
 * It never refuses a dispatch or trims the prompt (the reviewer must see the complete envelope); it only raises the run's duration estimate so a ~100K-token
 * envelope reads as a long silent prefill rather than a wedged run. Pure.
 */

import { estimateTokens } from './contextBudget.js';

// Assumed prefill throughput (tokens/s), deliberately below the observed ~185 tok/s on a 27B model: over-estimating only widens the window a healthy run gets.
export const LOCAL_PREFILL_TOKENS_PER_SECOND = 120;

// Prefill at or above which a run is silent long enough to read as wedged; below one minute the card's "initializing" state covers it.
export const LONG_PREFILL_MS = 60_000;

const positiveNumber = (value) => (Number.isFinite(value) && value > 0 ? value : null);

// Null, not 0, for a non-positive/garbled token count, so "no estimate" is never "instant".
export function estimateLocalPrefillMs(promptTokens, tokensPerSecond = LOCAL_PREFILL_TOKENS_PER_SECOND) {
  const tokens = positiveNumber(Number(promptTokens));
  const rate = positiveNumber(Number(tokensPerSecond)) ?? LOCAL_PREFILL_TOKENS_PER_SECOND;
  if (tokens === null) return null;
  return Math.ceil((tokens / rate) * 1000);
}

/**
 * @param {object} args
 * @param {string} args.prompt - the FULLY assembled prompt (envelope included)
 * @param {string|null} args.endpoint - the local endpoint this run occupies, or null/'' for a cloud provider
 * @param {number|null} [args.baseDurationMs] - learned estimate before prefill; null means nothing learned, NOT zero
 * @param {number} [args.tokensPerSecond]
 * @returns {null | { endpoint: string, promptChars: number, promptTokens: number, tokensPerSecond: number, prefillMs: number,
 *   baseDurationMs: number|null, expectedDurationMs: number|null, longPrefill: boolean }} null when the question does not apply
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
    // Raised estimate = base + prefill; stays null when nothing was learned (bare prefill would understate the run).
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
