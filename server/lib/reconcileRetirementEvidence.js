/** Exact checkout obligations survive scans until fresh service preservation evidence. */
export const sameRetirementCheckout = (left, right) => left.branch === right.branch && left.path === right.path && left.head === right.head;

export const hasRetirementReceipt = (outcome, release) => Number.isFinite(Date.parse(release.createdAt))
  && outcome?.retired?.some(row => sameRetirementCheckout(row, release) && row.branchDeleted === true
    && typeof row.archiveDir === 'string' && row.archiveDir.length > 0
    && Date.parse(row.retiredAt) >= Date.parse(release.createdAt)) === true;

export function unresolvedRetirements(outcome, additional = []) {
  const rows = [...(outcome?.retirementObligations || []), ...(outcome?.remaining || []), ...additional];
  const obligations = [];
  for (const row of rows) {
    if (!['retirement-review-pending', 'retirement-receipt-unverified'].includes(row.reason)
      || hasRetirementReceipt(outcome, row) || obligations.some(previous => sameRetirementCheckout(previous, row))) continue;
    obligations.push({ ...row, reason: 'retirement-receipt-unverified' });
  }
  return obligations;
}

/** Only the serialized schedule writer allocates timestamps. A recreated exact
 * path/head starts after every older matching receipt, even within one clock tick.
 */
export function retainRetirementObligations(outcome, additional, now) {
  const existing = unresolvedRetirements(outcome);
  const pending = unresolvedRetirements({ retirementObligations: existing }, additional);
  return pending.map(row => {
    const previous = existing.find(entry => sameRetirementCheckout(entry, row));
    if (Number.isFinite(Date.parse(previous?.createdAt))) return { ...row, createdAt: previous.createdAt };
    const earlier = (outcome?.retired || []).filter(entry => sameRetirementCheckout(entry, row))
      .map(entry => Date.parse(entry.retiredAt)).filter(Number.isFinite);
    return { ...row, createdAt: new Date(Math.max(Date.parse(now), ...earlier.map(time => time + 1))).toISOString() };
  });
}
