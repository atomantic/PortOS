import { createHash } from 'node:crypto';

/** Migration 443 only. Frozen upgrade observations distinguish archive-era bookkeeping from new incidents. */
const legacyRetirementKey = row => createHash('sha256').update(JSON.stringify([
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
