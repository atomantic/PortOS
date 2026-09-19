/**
 * The jev rung of the untrusted-content ladder.
 *
 *     screenUntrustedContent()      ← phase 1, Prompt Guard. UNCHANGED.
 *       ↓ safe
 *     runJevDecision()              ← HERE. Null-ish on abstain/unavailable/off.
 *       ↓ no answer
 *     runUntrustedContentAnalysis() ← phase 2's chat completion, unchanged.
 *
 * This module owns three things and nothing else: whether jev may be consulted
 * for a given policy, what one consultation returns, and the counters the
 * install needs to decide whether the answers are trustworthy. It never
 * screens (the ladder above it does), never persists a premise, and never
 * decides what a caller does with an abstention.
 */

import { join } from 'path';
import { createCachedStore, PATHS } from '../lib/fileUtils.js';
import { getJevDecision, jevHypotheses, jevMinMarginFor, jevValueForHypothesis } from '../lib/jevDecisions.js';

const SHADOW_SCHEMA_VERSION = 1;
const emptyShadow = () => ({ schemaVersion: SHADOW_SCHEMA_VERSION, decisions: {}, updatedAt: null });

/**
 * Serialized read-modify-write over the counters file.
 *
 * `mutate` rather than load+save, and a store rather than a bare
 * `readJSONFile` + `atomicWrite` pair: the email-triage schedule and the
 * issue-watcher schedule both fold observations into THIS file, and two
 * interleaved runs would otherwise each read the same counts and write back
 * their own increments — silently discarding one side. These counters are the
 * only evidence an operator has before flipping a source to `prefer`, so
 * losing increments would quietly argue against a feature that was working.
 *
 * Built on first use, not at module load: `PATHS.data` is re-rooted by suites,
 * and a module-scope `join()` would capture whatever it was at first import.
 */
let store = null;
const shadowStore = () => (store ??= createCachedStore(
  join(PATHS.data, 'local-llm', 'jev-shadow.json'),
  emptyShadow(),
  { context: 'jev decision agreement counters' },
));

/** Test seam, mirroring `resetModelManifestCache` on the sibling store. */
export const resetJevShadowCache = () => store?.invalidateCache();

const emptyCounters = () => ({
  observed: 0, decided: 0, abstained: 0, unavailable: 0, compared: 0, agreed: 0,
});

/**
 * Whether this install runs the scorer at all.
 *
 * Checked BEFORE any settings read on the batch path: the feature ships off, so
 * the overwhelmingly common answer costs one cached feature lookup rather than
 * a policy resolution the caller would then throw away.
 *
 * Deferred import: `instanceFeatures.js` reaches the Eidoverse, settings and
 * user-action graph, and this module sits on the request path of three services
 * (`server/lib/importScoping.test.js`).
 */
export async function isJevFeatureEnabled() {
  const { isInstanceFeatureEnabled } = await import('./instanceFeatures.js');
  return isInstanceFeatureEnabled('jev').catch(() => false);
}

/**
 * Whether jev may answer for this policy, and how an abstention is handled.
 *
 * Two independent gates, both of which must be open: the per-install feature
 * toggle (an operator saying this machine runs the scorer at all) and the
 * per-source `jevMode` (an operator saying this CHANNEL may be answered
 * locally). `shadow` is not a mode an operator sets — it is what `off` means on
 * a machine where the feature is on, and it changes no behavior at all.
 */
export async function resolveJevMode(policy) {
  const configured = policy?.jevMode === 'prefer' || policy?.jevMode === 'only' ? policy.jevMode : 'off';
  if (!await isJevFeatureEnabled()) return 'disabled';
  return configured === 'off' ? 'shadow' : configured;
}

/**
 * Ask the scorer to resolve one closed-set decision.
 *
 * Returns exactly one of:
 *   { ok: true,  kind: 'decided',     value, margin, confidence }
 *   { ok: true,  kind: 'abstained',   abstained: true, margin }
 *   { ok: false, kind: 'unavailable', code }
 *
 * A caller MUST NOT treat `abstained` or `ok: false` as permission to take the
 * leading option. Both mean "ask the chat model, or do nothing". `kind` is the
 * counter bucket the observation belongs in, carried here so no caller has to
 * re-derive it from the other two fields.
 */
export async function runJevDecision({ decisionId, premise, policyMinMargin = null } = {}) {
  const decision = getJevDecision(decisionId);
  if (!decision) return unavailable('jev-request-invalid');
  if (typeof premise !== 'string' || !premise.trim()) return unavailable('jev-request-invalid');
  // Deferred so an install that never opts in keeps the sidecar lifecycle, the
  // `PORTS` table, and the model contract out of its static import closure.
  const { decide } = await import('./jev.js');
  // An adopted project-specific head's slug, or null on every install that has
  // not trained one — which is every install by default. Null means the stock
  // zero-shot classifier answers, exactly as it did before heads existed. The
  // slug is resolved inside the heads directory by the sidecar, never treated
  // as a path.
  const { getAdoptedJevHeadSlug } = await import('./jevHeads.js');
  const scored = await decide({
    premise,
    options: jevHypotheses(decisionId),
    head: await getAdoptedJevHeadSlug(decisionId),
    // The base floor gates the forward pass; a per-option floor is applied
    // below, once there is a winner to look up.
    minMargin: jevMinMarginFor(decisionId, { policyMinMargin }),
  });
  if (!scored.ok) return unavailable(scored.code);
  if (scored.abstained) return { ok: true, kind: 'abstained', abstained: true, margin: scored.margin };
  const value = jevValueForHypothesis(decisionId, scored.choice);
  // A winning hypothesis that is not one of ours means the reply described a
  // different option list than the one we asked about. `normalizeJevScores`
  // already rejects that, so reaching here is a contract break, not a verdict.
  if (value === null) return unavailable('jev-response-invalid');
  // The asymmetric floor: `delete` and `inspect-trusted-change` have to clear a
  // far wider separation than the options they sit beside, because they are the
  // ones that throw something away or release a task.
  if (scored.margin < jevMinMarginFor(decisionId, { optionValue: value, policyMinMargin })) {
    return { ok: true, kind: 'abstained', abstained: true, margin: scored.margin };
  }
  return { ok: true, kind: 'decided', value, margin: scored.margin, confidence: scored.confidence };
}

const unavailable = (code) => ({ ok: false, kind: 'unavailable', code });

/**
 * Fold observations into the install's per-decision counters.
 *
 * COUNTS ONLY. A record carries the decision id, which bucket it landed in, and
 * whether it matched the chat model — never the premise, a message body, a
 * comment, a diff, or a margin tied to any of them. That is the whole reason
 * shadow mode is safe to leave on: the file it writes could be published
 * without disclosing anything about what was analyzed.
 *
 * Never rejects. Measurement must not be able to fail an analysis that already
 * succeeded, so every caller can fire this without a guard of its own.
 */
export async function recordJevObservations(observations) {
  const rows = (Array.isArray(observations) ? observations : [observations])
    .filter((row) => row && getJevDecision(row.decisionId));
  if (!rows.length) return null;
  return shadowStore().mutate((current) => {
    // A file from a newer or unreadable schema restarts the counters rather
    // than folding counts into a shape this build cannot read. They are
    // regenerable telemetry; the next decision re-measures.
    const base = current?.schemaVersion === SHADOW_SCHEMA_VERSION && current.decisions ? current : emptyShadow();
    const decisions = { ...base.decisions };
    for (const row of rows) {
      const counters = { ...emptyCounters(), ...decisions[row.decisionId] };
      counters.observed += 1;
      if (row.kind === 'decided' || row.kind === 'abstained' || row.kind === 'unavailable') counters[row.kind] += 1;
      // `agreed` is only meaningful when BOTH answered the same question. A
      // `prefer`-mode run that jev resolved never woke the chat model, so it
      // has a choice but nothing to compare it against.
      if (typeof row.agreed === 'boolean') {
        counters.compared += 1;
        if (row.agreed) counters.agreed += 1;
      }
      decisions[row.decisionId] = counters;
    }
    return { schemaVersion: SHADOW_SCHEMA_VERSION, decisions, updatedAt: new Date().toISOString() };
  }).catch((error) => {
    console.error(`❌ jev: could not record decision agreement counters: ${error.message}`);
    return null;
  });
}

/**
 * Per-decision agreement and abstention rates for the jev panel.
 *
 * `null` for a rate the install has no evidence for — an install that has never
 * run a decision must read as "no data", not as "0% agreement", which would
 * argue against a feature nobody has measured yet.
 */
export async function readJevDecisionStats() {
  const stored = await shadowStore().load().catch(() => null);
  const decisions = stored?.schemaVersion === SHADOW_SCHEMA_VERSION ? stored.decisions || {} : {};
  const rate = (numerator, denominator) => (denominator > 0 ? numerator / denominator : null);
  return {
    updatedAt: stored?.updatedAt || null,
    decisions: Object.entries(decisions).filter(([id]) => getJevDecision(id)).map(([id, raw]) => {
      const counters = { ...emptyCounters(), ...raw };
      return {
        decisionId: id,
        label: getJevDecision(id).label,
        ...counters,
        agreementRate: rate(counters.agreed, counters.compared),
        abstentionRate: rate(counters.abstained, counters.observed),
      };
    }),
  };
}
