/**
 * Layered Intelligence — hard pre-filing exclusion gate (#2824)
 * (#2842 split of layeredIntelligence.js).
 */

import { PORTOS_ONLY_SCOPES, LI_HARD_GATE_EXECUTION_THRESHOLD } from './constants.js';
import { computeLiExecutionHealth } from './outcomes.js';
import { computeExecutionByDomain, isAvoidDomain, formatDominantFailureCause, clampScopeLabel } from './awareness.js';

// The proposal scopes treated as LI "self-improve" work by the hard exclusion gate
// (#2824): the PortOS-only meta/self scopes. These are the proposals that improve LI /
// PortOS itself and execute under self-improve:* task types — the exact execution class
// whose chronic failure motivated the gate. Reuses PORTOS_ONLY_SCOPES as the single
// definition so "self-improve scope" can never drift from "the PortOS-only scopes".
export const SELF_IMPROVE_SCOPES = PORTOS_ONLY_SCOPES;

/**
 * Deterministic HARD PRE-FILING EXCLUSION gate (#2824). Given a validated proposal,
 * LI's own execution-health stats, and the app's outcome records, decides whether the
 * proposal must be SUPPRESSED before it is ever filed — because LI's own execution is
 * degraded and the proposal maps to work LI cannot see through. This is the SYSTEM-side
 * enforcement of the exclusion the reasoner is merely WARNED about in the prompt notice
 * (computeHardExclusionNotice): even when the reasoner "wants" to file, this gate drops
 * the proposal to null.
 *
 * Pure + side-effect-free like the sibling compute* gates. Two independent exclusion
 * rules, both ARMED only when LI's execution health is CONFIDENTLY below
 * LI_HARD_GATE_EXECUTION_THRESHOLD (75%) — unknown or below-sample-floor health leaves
 * the gate DISARMED, so a cold loop with no track record is never locked out:
 *   1. Self-improve scope — any proposal in a SELF_IMPROVE_SCOPES scope (loop-meta /
 *      portos-self) is excluded regardless of domain. A degraded loop cannot repair
 *      itself; that work is deferred to a human.
 *   2. Chronically-failing domain — a proposal whose OWN scope's hand-offs chronically
 *      fail (the SAME isAvoidDomain classifier the hand-off gate + reasoner avoid list
 *      use, so all three agree on which domains qualify) is excluded from FILING, not
 *      just from auto-hand-off.
 *
 * @param {object} args
 * @param {object} args.proposal - the validated proposal ({ scope, ... }).
 * @param {{ read: boolean, metrics: Object|null }|null} [args.liTaskStats] - readLiTaskMetrics output.
 * @param {Array} [args.outcomes] - the app's li-outcomes records (for rule 2's domain lookup).
 * @param {number} [args.now] - clock seam for the effective-rate window.
 * @returns {{ excluded: boolean, reason: string|null, rule?: 'self-improve-scope'|'failing-domain' }}
 */
export function computeHardExclusionGate({ proposal, liTaskStats = null, outcomes = [], now = Date.now() } = {}) {
  if (!proposal || typeof proposal !== 'object') return { excluded: false, reason: null };

  // The gate is ARMED only on a confident read of degraded execution health. Unknown
  // health (store unreadable / no runs) or a below-floor sample disarms it — the same
  // 0-of-1-vs-0-of-N reasoning as LI_DEGRADED_MIN_SAMPLE. A healthy loop (>= 75%) files
  // exactly as before this gate existed.
  const health = computeLiExecutionHealth(liTaskStats, { now });
  if (!health.confident || health.rate >= LI_HARD_GATE_EXECUTION_THRESHOLD) {
    return { excluded: false, reason: null };
  }

  const scope = typeof proposal.scope === 'string' && proposal.scope.trim() ? proposal.scope.trim() : null;
  const healthClause = `LI execution health ${health.rate}% (< ${LI_HARD_GATE_EXECUTION_THRESHOLD}%)`;

  // Rule 1: self-improve scope — excluded wholesale while armed.
  if (scope && SELF_IMPROVE_SCOPES.includes(scope)) {
    return {
      excluded: true,
      rule: 'self-improve-scope',
      reason: `${healthClause} — self-improve-scoped proposals (${scope}) are excluded while the loop's own runs are failing; a degraded loop cannot repair itself, so this is deferred to a human`
    };
  }

  // Rule 2: chronically-failing execution domain — same isAvoidDomain classifier the
  // hand-off routing gate uses, so a domain on the reasoner's avoid list is the same
  // set the gate blocks. Only reached for non-self-improve scopes with a scope present.
  if (scope) {
    const bucket = computeExecutionByDomain(outcomes)[scope];
    if (isAvoidDomain(bucket)) {
      const cause = formatDominantFailureCause(bucket.failureSummary);
      return {
        excluded: true,
        rule: 'failing-domain',
        reason: `${healthClause} and ${scope} hand-offs succeed only ${bucket.successRate}% over ${bucket.completed} executed — excluded from filing${cause ? ` (${cause})` : ''}`
      };
    }
  }

  return { excluded: false, reason: null };
}

/**
 * Render the reasoner-facing HARD EXCLUSION notice block (#2824). Computed from the
 * SAME health + outcome inputs the enforcement gate (computeHardExclusionGate) reads,
 * so the prompt's stated exclusions and what the gate actually suppresses can never
 * disagree. Returns '' when the gate is DISARMED (health unknown, below sample floor,
 * or at/above the threshold), so buildPrompt omits the block entirely on a healthy loop.
 * Names both the self-improve scopes and any currently chronically-failing domain, and
 * carries the explicit GATE CHECK step the reasoner must run before committing.
 */
export function computeHardExclusionNotice({ liTaskStats = null, outcomes = [], now = Date.now() } = {}) {
  const health = computeLiExecutionHealth(liTaskStats, { now });
  if (!health.confident || health.rate >= LI_HARD_GATE_EXECUTION_THRESHOLD) return '';

  const lines = [
    `HARD EXCLUSION GATE ARMED — your execution health is ${health.rate}% (below ${LI_HARD_GATE_EXECUTION_THRESHOLD}%). The following work is EXCLUDED this run and will be dropped BEFORE filing even if your reasoning leads you to it:`,
    `- Any self-improve-scoped proposal (${SELF_IMPROVE_SCOPES.join(', ')}). A degraded loop cannot repair itself — that work is deferred to a human.`
  ];

  // Surface each currently chronically-failing domain by name so the reasoner can route
  // around it explicitly — the same isAvoidDomain set rule 2 of the gate enforces. Skip
  // any self-improve scope already named in the bullet above (gate rule 1 short-circuits
  // rule 2 for those) so the notice never lists the same scope twice.
  const byDomain = computeExecutionByDomain(outcomes);
  const failing = Object.entries(byDomain)
    .filter(([scope, bucket]) => isAvoidDomain(bucket) && !SELF_IMPROVE_SCOPES.includes(scope))
    .map(([scope, bucket]) => `${clampScopeLabel(scope)} (${bucket.successRate}% over ${bucket.completed})`);
  if (failing.length) {
    lines.push(`- Any proposal in a chronically-failing execution domain: ${failing.join('; ')}.`);
  }

  lines.push('', 'GATE CHECK: If your proposal maps to an excluded scope or domain above → return proposal: null. Do not reason past this gate.');
  return lines.join('\n');
}
