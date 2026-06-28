/**
 * Editorial severity configuration (#1616) — the frozen DEFAULT severity
 * weights + per-gate blocking-severity sets, plus pure merge/resolve/sanitize
 * helpers that let a SERIES override either one without ever clobbering the
 * defaults when no override is set.
 *
 * This module is PURE (no side-effecting imports). The canonical severity enum
 * is `CHECK_SEVERITIES` (`['high','medium','low']`) re-used from
 * `./checkRegistry.js` so the wire gate, the score weights, and the blocking
 * sets can never drift apart.
 *
 * ABSENT vs INTENTIONALLY-EMPTY is the load-bearing distinction here (mirrors
 * the PortOS LLM-merge rule):
 *
 *  - severity weights: an ABSENT key (override omits high/medium/low, or the
 *    value isn't a finite non-negative number) keeps the frozen default. An
 *    empty `{}` override is "nothing overridden" → all defaults. There is no
 *    "intentionally cleared weight" — a weight is always a number.
 *  - blocking sets: an ABSENT gate (override omits the gate, or its value isn't
 *    an array) falls back to the gate's DEFAULT blocking set. An explicit EMPTY
 *    array (`[]`) is a legitimate, distinct choice — "nothing blocks this gate"
 *    — and is honored as-is (NOT treated as absent). So `Array.isArray` MUST be
 *    checked first, before any emptiness check.
 */

import { CHECK_SEVERITIES } from './checkRegistry.js';

// Transparent severity penalty weights (mirrors editorialScore.SEVERITY_WEIGHTS,
// which now re-exports this). A draft starts at 100 and loses points per OPEN
// finding: a `high` costs as much as a dozen `low` nits.
export const DEFAULT_SEVERITY_WEIGHTS = Object.freeze({ high: 12, medium: 5, low: 1 });

// The autopilot gates that consume a blocking-severity set, and their defaults.
// arc + beatContinuity are structural-continuity gates (block on high + medium);
// editorial is the manuscript-review gate (blocks on high only).
export const BLOCKING_GATES = Object.freeze(['arc', 'beatContinuity', 'editorial']);
export const DEFAULT_BLOCKING_SEVERITIES = Object.freeze({
  arc: Object.freeze(['high', 'medium']),
  beatContinuity: Object.freeze(['high', 'medium']),
  editorial: Object.freeze(['high']),
});

const isFiniteNonNegative = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * Merge a per-series severity-weight override over the frozen defaults. Each of
 * high/medium/low is replaced ONLY when `override[key]` is a finite,
 * non-negative number; an absent or invalid key keeps its default. A non-object
 * override (or `{}`) returns the defaults unchanged — absent must NOT clobber.
 *
 * Returns a fresh PLAIN object (never the frozen default) so callers may read it
 * without mutating the shared constant.
 *
 * @param {object} [override] — partial `{ high?, medium?, low? }`
 * @returns {{ high: number, medium: number, low: number }}
 */
export function mergeSeverityWeights(override) {
  const out = { ...DEFAULT_SEVERITY_WEIGHTS };
  if (!override || typeof override !== 'object' || Array.isArray(override)) return out;
  for (const sev of CHECK_SEVERITIES) {
    if (isFiniteNonNegative(override[sev])) out[sev] = override[sev];
  }
  return out;
}

/**
 * Resolve the blocking-severity Set for one autopilot gate from a per-series
 * override. `Array.isArray(override[gate])` is checked FIRST so an explicit
 * empty array (`[]` → "nothing blocks", a legitimate choice) is distinguished
 * from an absent gate (falls back to the gate's default set). When present, the
 * array is filtered to the CHECK_SEVERITIES subset (junk dropped) and deduped —
 * even if that resolves to an empty Set.
 *
 * @param {object} [override] — per-series `{ arc?, beatContinuity?, editorial? }`
 * @param {string} gate — one of BLOCKING_GATES
 * @returns {Set<string>} the severities that block this gate
 */
export function resolveBlockingSet(override, gate) {
  const raw = override && typeof override === 'object' && !Array.isArray(override)
    ? override[gate]
    : undefined;
  if (Array.isArray(raw)) {
    // Explicit (possibly empty) override — filter to known severities + dedupe.
    return new Set(raw.filter((s) => CHECK_SEVERITIES.includes(s)));
  }
  // Absent / not-an-array → the gate's frozen default set.
  return new Set(DEFAULT_BLOCKING_SEVERITIES[gate] || []);
}

/**
 * Wire-shape bounder for a per-series severity-weight override (persisted on the
 * series record). Returns a plain object containing ONLY the high/medium/low
 * keys whose value is a finite non-negative number (everything else dropped);
 * returns `{}` when nothing is valid. An empty override therefore persists as
 * `{}` and `mergeSeverityWeights` falls back to the defaults — so "tunes
 * nothing" round-trips as the frozen defaults rather than a frozen snapshot.
 *
 * @param {*} raw
 * @returns {object} bounded `{ high?, medium?, low? }`
 */
export function sanitizeSeverityWeights(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const sev of CHECK_SEVERITIES) {
    if (isFiniteNonNegative(raw[sev])) out[sev] = raw[sev];
  }
  return out;
}

/**
 * Wire-shape bounder for a per-series blocking-severity override (persisted on
 * the series record). Returns a plain object containing ONLY the keys in
 * BLOCKING_GATES whose value is an Array, each filtered to the CHECK_SEVERITIES
 * subset and deduped. An explicit empty array is PRESERVED as `[]` (the distinct
 * "nothing blocks" choice); a non-array gate value is dropped. Returns `{}` when
 * nothing is valid.
 *
 * @param {*} raw
 * @returns {object} bounded `{ arc?, beatContinuity?, editorial? }`
 */
export function sanitizeBlockingSeverities(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const gate of BLOCKING_GATES) {
    if (Array.isArray(raw[gate])) {
      // Dedupe + drop junk, preserving an explicit empty array as [].
      out[gate] = [...new Set(raw[gate].filter((s) => CHECK_SEVERITIES.includes(s)))];
    }
  }
  return out;
}
