/**
 * Editorial readiness settings and severity configuration — the frozen DEFAULT severity weights and per-gate
 * blocking-severity sets, plus pure merge/resolve/sanitize helpers that let a SERIES
 * override either without clobbering defaults when no override is set. Pure; the severity
 * enum is `CHECK_SEVERITIES` so gate, weights and blocking sets cannot drift.
 *
 * ABSENT vs INTENTIONALLY-EMPTY is load-bearing: an absent weight key (or a non-finite /
 * negative value) keeps the default. For blocking sets, an absent gate (or non-array)
 * falls back to the default set, while an explicit `[]` means "nothing blocks this gate"
 * and is honored, so `Array.isArray` MUST be checked before any emptiness check.
 */

import { CHECK_SEVERITIES } from './checkInfra/taxonomy.js';

// The editorial-health readiness gate (#1316) the autopilot loop + UI read as
// "manuscript clean". Returns the raw stored value (or null) — the caller
// resolves an unknown/absent value to the default via `resolveReadinessGate` in
// editorialScore.js (kept there so the gate vocabulary lives with the scorer).
export const readReadinessGate = (settings) => {
  const gate = settings?.pipelineEditorialChecks?.readinessGate;
  return typeof gate === 'string' && gate ? gate : null;
};

// Severity penalty weights (editorialScore.SEVERITY_WEIGHTS re-exports this): a draft
// starts at 100 and loses points per OPEN finding.
export const DEFAULT_SEVERITY_WEIGHTS = Object.freeze({ high: 12, medium: 5, low: 1 });

// Autopilot gates that consume a blocking-severity set: arc + beatContinuity block on
// high + medium; editorial blocks on high only.
export const BLOCKING_GATES = Object.freeze(['arc', 'beatContinuity', 'editorial']);
export const DEFAULT_BLOCKING_SEVERITIES = Object.freeze({
  arc: Object.freeze(['high', 'medium']),
  beatContinuity: Object.freeze(['high', 'medium']),
  editorial: Object.freeze(['high']),
});

const isFiniteNonNegative = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * Merge a per-series weight override over the defaults; a key is replaced ONLY when it
 * is a finite non-negative number. Returns a fresh plain object (never the frozen default).
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
 * Resolve the blocking-severity Set for one gate. An explicit `[]` is distinguished from
 * an absent gate (default set); a present array is filtered to CHECK_SEVERITIES and
 * deduped, even if that leaves it empty.
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
    return new Set(raw.filter((s) => CHECK_SEVERITIES.includes(s)));
  }
  return new Set(DEFAULT_BLOCKING_SEVERITIES[gate] || []);
}

/**
 * Bound a per-series weight override for persistence: only high/medium/low keys with a
 * finite non-negative value survive; `{}` when nothing is valid (so it falls back to the
 * defaults rather than freezing a snapshot).
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
 * Bound a per-series blocking-severity override: only BLOCKING_GATES keys holding an
 * Array survive, filtered to CHECK_SEVERITIES and deduped. An explicit `[]` is PRESERVED.
 *
 * @param {*} raw
 * @returns {object} bounded `{ arc?, beatContinuity?, editorial? }`
 */
export function sanitizeBlockingSeverities(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const gate of BLOCKING_GATES) {
    if (Array.isArray(raw[gate])) {
      // Dedupe + drop junk; keep an explicit empty array.
      out[gate] = [...new Set(raw[gate].filter((s) => CHECK_SEVERITIES.includes(s)))];
    }
  }
  return out;
}
