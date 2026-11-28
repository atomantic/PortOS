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
 *
 * Storage: `ephemeral-file` — `data/local-llm/jev-shadow.json` agreement counters,
 * machine-local, never federated, holding only decision ids and integer counters.
 * Written via `createCachedStore`'s serialized `mutate` because two schedules fold
 * into it; absent is the empty state, so no seed or migration.
 */

import { notifyJevChanged } from './jevEvents.js';
import { join } from 'path';
import { createCachedStore, PATHS } from '../lib/fileUtils.js';
import { JEV_DECISIONS, getJevDecision, jevHypotheses, jevMinMarginFor, jevValueForHypothesis } from '../lib/jevDecisions.js';

const SHADOW_SCHEMA_VERSION = 1;
const emptyShadow = () => ({ schemaVersion: SHADOW_SCHEMA_VERSION, decisions: {}, updatedAt: null });

/**
 * Serialized read-modify-write over the counters file: the email-triage and issue-watcher
 * schedules both fold into it, and interleaved load+save would discard increments, the
 * operator's only evidence before flipping a source to `prefer`. Built on first use
 * because `PATHS.data` is re-rooted by suites.
 */
let store = null;
const shadowStore = () => (store ??= createCachedStore(
  join(PATHS.data, 'local-llm', 'jev-shadow.json'),
  emptyShadow(),
  { context: 'jev decision agreement counters' },
));

/** Test seam, mirroring `resetModelManifestCache` on the sibling store. */
export const resetJevShadowCache = () => store?.invalidateCache();
export const withLiveRestore = restore => shadowStore().withLiveRestore(restore);

const emptyCounters = () => ({
  observed: 0, decided: 0, abstained: 0, unavailable: 0, compared: 0, agreed: 0,
});

/**
 * Whether this install runs the scorer at all. Checked before any settings read (the
 * feature ships off). Deferred import: `instanceFeatures.js` reaches the Eidoverse, settings
 * and user-action graph (`server/lib/importScoping.test.js`).
 */
export async function isJevFeatureEnabled() {
  const { isInstanceFeatureEnabled } = await import('./instanceFeatures.js');
  return isInstanceFeatureEnabled('jev').catch(() => false);
}

/**
 * Whether jev may answer for this policy: both the per-install feature toggle and the
 * per-source `jevMode` must be open. `disabled` suppresses even shadow scoring; `shadow`
 * is the UI label for the legacy stored `off` and changes no behavior.
 */
export async function resolveJevMode(policy) {
  if (policy?.jevMode === 'disabled') return 'disabled';
  const configured = policy?.jevMode === 'prefer' || policy?.jevMode === 'only' ? policy.jevMode : 'off';
  if (!await isJevFeatureEnabled()) return 'disabled';
  return configured === 'off' ? 'shadow' : configured;
}

/**
 * Ask the scorer to resolve one closed-set decision. Returns one of:
 *   { ok: true,  kind: 'decided',     value, margin, confidence }
 *   { ok: true,  kind: 'abstained',   abstained: true, margin }
 *   { ok: false, kind: 'unavailable', code }
 * A caller MUST NOT treat `abstained` or `ok: false` as permission to take the leading
 * option: both mean "ask the chat model, or do nothing". `kind` is the counter bucket.
 */
export async function runJevDecision({ decisionId, premise, policyMinMargin = null } = {}) {
  const decision = getJevDecision(decisionId);
  if (!decision) return unavailable('jev-request-invalid');
  if (typeof premise !== 'string' || !premise.trim()) return unavailable('jev-request-invalid');
  // Deferred so an install that never opts in keeps the sidecar lifecycle, the
  // `PORTS` table, and the model contract out of its static import closure.
  const { decide } = await import('./jev.js');
  // An adopted project-specific head's slug, or null (stock zero-shot classifier). The
  // sidecar resolves it inside the heads directory; never treated as a path.
  const { getAdoptedJevHeadSlug } = await import('./jevHeads.js');
  const scored = await decide({
    premise,
    options: jevHypotheses(decisionId),
    head: await getAdoptedJevHeadSlug(decisionId),
    // The base floor gates the forward pass; the per-option floor applies below.
    minMargin: jevMinMarginFor(decisionId, { policyMinMargin }),
  });
  if (!scored.ok) return unavailable(scored.code);
  if (scored.abstained) return { ok: true, kind: 'abstained', abstained: true, margin: scored.margin };
  const value = jevValueForHypothesis(decisionId, scored.choice);
  // A winner outside our option list is a contract break (`normalizeJevScores` rejects it), not a verdict.
  if (value === null) return unavailable('jev-response-invalid');
  // Asymmetric floor: `delete` and `inspect-trusted-change` need a far wider separation
  // since they discard something or release a task.
  if (scored.margin < jevMinMarginFor(decisionId, { optionValue: value, policyMinMargin })) {
    return { ok: true, kind: 'abstained', abstained: true, margin: scored.margin };
  }
  return { ok: true, kind: 'decided', value, margin: scored.margin, confidence: scored.confidence };
}

const unavailable = (code) => ({ ok: false, kind: 'unavailable', code });

/**
 * Fold observations into the per-decision counters. COUNTS ONLY: decision id, bucket and
 * whether it matched the chat model, never a premise, body, comment, diff or margin, so the
 * file is safe to publish. Never rejects: measurement must not fail a succeeded analysis.
 */
export async function recordJevObservations(observations) {
  const rows = (Array.isArray(observations) ? observations : [observations])
    .filter((row) => row && getJevDecision(row.decisionId));
  if (!rows.length) return null;
  return shadowStore().mutate((current) => {
    // An unreadable or newer-schema file restarts the counters (regenerable telemetry).
    const base = current?.schemaVersion === SHADOW_SCHEMA_VERSION && current.decisions ? current : emptyShadow();
    const decisions = { ...base.decisions };
    for (const row of rows) {
      const counters = { ...emptyCounters(), ...decisions[row.decisionId] };
      counters.observed += 1;
      if (row.kind === 'decided' || row.kind === 'abstained' || row.kind === 'unavailable') counters[row.kind] += 1;
      // `agreed` needs BOTH to have answered; a jev-resolved `prefer` run never woke the chat model.
      if (typeof row.agreed === 'boolean') {
        counters.compared += 1;
        if (row.agreed) counters.agreed += 1;
      }
      decisions[row.decisionId] = counters;
    }
    return { schemaVersion: SHADOW_SCHEMA_VERSION, decisions, updatedAt: new Date().toISOString() };
  }).then((result) => {
    notifyJevChanged('stats');
    return result;
  }).catch((error) => {
    console.error(`❌ jev: could not record decision agreement counters: ${error.message}`);
    return null;
  });
}

/** Per-decision agreement and abstention rates; `null` for a rate with no evidence (no data, not "0% agreement"). */
export async function readJevDecisionStats() {
  const stored = await shadowStore().load().catch(() => null);
  const decisions = stored?.schemaVersion === SHADOW_SCHEMA_VERSION ? stored.decisions || {} : {};
  const rate = (numerator, denominator) => (denominator > 0 ? numerator / denominator : null);
  return {
    updatedAt: stored?.updatedAt || null,
    registry: JEV_DECISIONS,
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
