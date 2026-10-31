/** Exact checkout obligations survive scans until fresh service preservation evidence. */
// A detached checkout has no branch: absent, null and undefined are the same observation.
export const sameRetirementCheckout = (left, right) => (left.branch ?? null) === (right.branch ?? null) && left.path === right.path && left.head === right.head;

export const sameRetirementObservation = (left, right) => sameRetirementCheckout(left, right)
  && (left.checkoutIdentity || null) === (right.checkoutIdentity || null);

export const isRetirementObligation = row => ['retirement-review-pending', 'retirement-receipt-unverified',
  'retirement-provenance-unverified'].includes(row?.reason);

// A receipt's archive is recorded when it was removed in place (null) or moved to a named directory.
export const retirementArchiveRecorded = row => row?.archiveDir == null
  || (typeof row.archiveDir === 'string' && row.archiveDir.length > 0);

/** A receipt settles a checkout by deleting its branch, or — for a detached
 * checkout, which has no branch to delete — by an explicit checkout-only removal.
 * Checkout-only never settles a branch-bearing row and never claims a deletion.
 */
export const retirementReceiptSettles = row => row?.branchDeleted === true
  || (row?.checkoutOnly === true && row.branchDeleted === false && !row.branch);

export const matchingRetirementReceipts = (outcome, release) => [...(outcome?.retired || []), ...Object.values(outcome?.retirementReceiptEvidence || {})].filter(row =>
  sameRetirementCheckout(row, release) && retirementReceiptSettles(row)
  && retirementArchiveRecorded(row)
  && Number.isFinite(Date.parse(row.retiredAt)));

export const hasRetirementReceipt = (outcome, release) => {
  const observed = Date.parse(release.createdAt || release.observedAt);
  const receiptHit = matchingRetirementReceipts(outcome, release).some(row => {
    // Identity distinguishes a recreated checkout from the one a receipt already settled.
    if (release.checkoutIdentity) return row.checkoutIdentity === release.checkoutIdentity;
    return Number.isFinite(observed) && Date.parse(row.retiredAt) >= observed;
  });
  if (receiptHit) return true;
  // Recovered archives are not branch-deleted receipts. They settle the obligation
  // they were verified for, and only that createdAt.
  return outcome?.recoveredPreservations?.some(row => sameRetirementCheckout(row, release)
    && row.obligationCreatedAt === release.createdAt && row.verified === true
    && typeof row.archiveDir === 'string' && row.archiveDir.length > 0
    && /^[a-f0-9]{64}$/.test(row.evidenceDigest || '')
    && Number.isFinite(Date.parse(release.createdAt))
    && Date.parse(row.archivedAt) >= Date.parse(release.createdAt)
    && Date.parse(row.verifiedAt) >= Date.parse(row.archivedAt)) === true;
};

export function unresolvedRetirements(outcome, additional = []) {
  const rows = [...(outcome?.retirementObligations || []), ...(outcome?.remaining || []), ...additional];
  const obligations = [];
  for (const row of rows) {
    if (!isRetirementObligation(row) || hasRetirementReceipt(outcome, row)) continue;
    const previous = obligations.find(entry => sameRetirementObservation(entry, row));
    if (previous) {
      if (row.reason === 'retirement-provenance-unverified') previous.reason = row.reason;
      continue;
    }
    obligations.push({
      ...row,
      reason: row.reason === 'retirement-provenance-unverified' ? row.reason : 'retirement-receipt-unverified',
    });
  }
  return obligations;
}

/** New incarnations are admitted by the serialized writer after a live check.
 * Never replace a producer's observation time with its delayed write time.
 * A recreated exact path/head starts after every older matching receipt.
 */
export function retainRetirementObligations(outcome, additional, now) {
  const existing = unresolvedRetirements(outcome);
  const pending = unresolvedRetirements({ ...outcome, retirementObligations: existing }, additional);
  return pending.map(row => {
    const previous = existing.find(entry => sameRetirementObservation(entry, row));
    if (Number.isFinite(Date.parse(previous?.createdAt))) return { ...row, createdAt: previous.createdAt };
    if (Number.isFinite(Date.parse(row.createdAt))) return row;
    const earlier = [
      ...matchingRetirementReceipts(outcome, row).map(entry => Date.parse(entry.retiredAt)),
      ...(outcome?.recoveredPreservations || [])
        .filter(entry => sameRetirementCheckout(entry, row))
        .map(entry => Date.parse(entry.verifiedAt || entry.archivedAt)),
    ].filter(Number.isFinite);
    const fallbackObserved = row.reason === 'retirement-provenance-unverified' && Number.isFinite(Date.parse(outcome?.observedAt))
      ? Date.parse(outcome.observedAt) : Date.parse(now);
    const observed = Number.isFinite(Date.parse(row.observedAt)) ? Date.parse(row.observedAt) : fallbackObserved;
    return { ...row, createdAt: new Date(Math.max(observed, ...earlier.map(time => time + 1))).toISOString() };
  });
}
