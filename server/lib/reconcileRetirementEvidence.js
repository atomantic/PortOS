/** Exact checkout obligations survive scans until fresh service preservation evidence. */
export const sameRetirementCheckout = (left, right) => left.branch === right.branch && left.path === right.path && left.head === right.head;

export const sameRetirementObservation = (left, right) => sameRetirementCheckout(left, right)
  && (left.checkoutIdentity || null) === (right.checkoutIdentity || null);

export const matchingRetirementReceipts = (outcome, release) => [...(outcome?.retired || []), ...Object.values(outcome?.retirementReceiptEvidence || {})].filter(row =>
  sameRetirementCheckout(row, release) && row.branchDeleted === true
  && typeof row.archiveDir === 'string' && row.archiveDir.length > 0
  && Number.isFinite(Date.parse(row.retiredAt)));

export const hasRetirementReceipt = (outcome, release) => matchingRetirementReceipts(outcome, release).some(row => {
  if (release.checkoutIdentity) return row.checkoutIdentity === release.checkoutIdentity;
  const observed = Date.parse(release.createdAt || release.observedAt);
  return Number.isFinite(observed) && Date.parse(row.retiredAt) >= observed;
});

export function unresolvedRetirements(outcome, additional = []) {
  const rows = [...(outcome?.retirementObligations || []), ...(outcome?.remaining || []), ...additional];
  const obligations = [];
  for (const row of rows) {
    if (!['retirement-review-pending', 'retirement-receipt-unverified'].includes(row.reason)
      || hasRetirementReceipt(outcome, row) || obligations.some(previous => sameRetirementObservation(previous, row))) continue;
    obligations.push({ ...row, reason: 'retirement-receipt-unverified' });
  }
  return obligations;
}

/** New incarnations are admitted by the serialized writer after a live check.
 * Never replace a producer's observation time with its delayed write time.
 */
export function retainRetirementObligations(outcome, additional, now) {
  const existing = unresolvedRetirements(outcome);
  const pending = unresolvedRetirements({ ...outcome, retirementObligations: existing }, additional);
  return pending.map(row => {
    const previous = existing.find(entry => sameRetirementObservation(entry, row));
    if (Number.isFinite(Date.parse(previous?.createdAt))) return { ...row, createdAt: previous.createdAt };
    if (Number.isFinite(Date.parse(row.createdAt))) return row;
    const earlier = matchingRetirementReceipts(outcome, row).map(entry => Date.parse(entry.retiredAt));
    const observed = Number.isFinite(Date.parse(row.observedAt)) ? Date.parse(row.observedAt) : Date.parse(now);
    return { ...row, createdAt: new Date(Math.max(observed, ...earlier.map(time => time + 1))).toISOString() };
  });
}
