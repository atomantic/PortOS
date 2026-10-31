import { createHash } from 'node:crypto';

/** Frozen upgrade observations distinguish archive-era bookkeeping from new incidents. */
export const legacyRetirementKey = row => createHash('sha256').update(JSON.stringify([
  row.branch ?? null, row.path ?? null, row.head ?? null, row.checkoutIdentity ?? null, row.createdAt ?? null,
])).digest('hex');

export function markLegacyRetirements(outcome) {
  if (!outcome || outcome.legacyRetirementTransition) return false;
  const rows = [...(outcome.retirementObligations || []), ...(outcome.remaining || [])]
    .filter(row => ['retirement-review-pending', 'retirement-receipt-unverified', 'retirement-provenance-unverified'].includes(row.reason));
  outcome.legacyRetirementTransition = { version: 1, observations: [...new Set(rows.map(legacyRetirementKey))], resolutions: [] };
  if (outcome.reason === 'historical-preservation-unresolved') {
    outcome.reason = 'legacy-retirement-records-pending';
    outcome.nextAction = 'Reconcile historical delivery and retirement evidence. Checkout archives are no longer required.';
  }
  return true;
}

/** Retain the original diagnosis and actual proof; never manufacture a deletion receipt. */
export function applyLegacyRetirementResolutions(outcome, resolutions, now) {
  const transition = outcome?.legacyRetirementTransition;
  if (transition?.version !== 1) return outcome;
  const current = new Set([...(outcome.retirementObligations || []), ...(outcome.remaining || [])].map(legacyRetirementKey));
  const accepted = resolutions.filter(row => current.has(row.key) && (transition.observations.includes(row.key)
    || (row.disposition === 'local-cleanup-not-required' && row.observation.reason === 'retirement-provenance-unverified')
    || (row.disposition === 'absent-head-preserved' && ['retirement-receipt-unverified', 'retirement-provenance-unverified'].includes(row.observation.reason))));
  if (!accepted.length) return outcome;
  const keys = new Set(accepted.map(row => row.key));
  const history = [...transition.resolutions];
  for (const row of accepted) if (!history.some(entry => entry.key === row.key)) history.push({ ...row, resolvedAt: now });
  const remaining = (outcome.remaining || []).filter(row => !keys.has(legacyRetirementKey(row)));
  const retirementObligations = (outcome.retirementObligations || []).filter(row => !keys.has(legacyRetirementKey(row)));
  return { ...outcome, remaining, retirementObligations, updatedAt: now,
    legacyRetirementTransition: { ...transition, resolutions: history },
    // A new sweep, rather than historical delivery, establishes repository convergence.
    reason: remaining.length ? 'remaining-holds' : 'legacy-retirement-records-reconciled',
    status: 'incomplete', nextAction: 'Run branch reconciliation to verify the current local repository state.' };
}
