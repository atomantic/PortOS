/**
 * Read-only progress summary for historical Deep certification ledgers. The writer, assignment and
 * checkpoint-merge engine was retired (#16910); stored ledgers are evidence only.
 */

export const DEEP_AUDIT_PASSES = Object.freeze(['static', 'trace', 'adversarial', 'challenge']);
const validReceipt = receipt => receipt && receipt.status !== 'blocked';

export function deepAuditProgress(ledger) {
  let satisfied = 0;
  let blocked = 0;
  const statuses = { pending: 0, scanned: 0, traced: 0, validated: 0, reviewed: 0, blocked: 0, inapplicable: 0 };
  for (const unit of ledger.units) {
    const receipts = DEEP_AUDIT_PASSES.map(pass => unit.evidence[pass]);
    const hasBlocker = receipts.some(receipt => receipt?.status === 'blocked');
    const count = receipts.filter(receipt => receipt && receipt.status !== 'blocked').length;
    satisfied += count;
    if (hasBlocker) blocked++;
    const status = hasBlocker ? 'blocked' : count === 4 && receipts.every(receipt => receipt.status === 'inapplicable')
      ? 'inapplicable' : ['pending', 'scanned', 'traced', 'validated', 'reviewed'][count];
    statuses[status]++;
  }
  const unitsById = new Map(ledger.units.map(unit => [unit.id, unit]));
  const reviewedGroupIds = new Set((ledger.groups || []).filter(group => group.unitIds.every(id => {
    const unit = unitsById.get(id);
    return unit && DEEP_AUDIT_PASSES.every(pass => validReceipt(unit.evidence[pass]));
  })).map(group => group.id));
  const pendingCandidates = Object.values(ledger.candidates).filter(candidate => candidate.disposition === 'pending').length;
  const required = ledger.units.length * DEEP_AUDIT_PASSES.length;
  const discoveryComplete = required > 0 && !ledger.scope.files.some(file => file.kind === 'commit') && !ledger.invalidReason && satisfied === required && !blocked && !pendingCandidates;
  const postFixComplete = Boolean(ledger.validationRevision) && ledger.units.length > 0 && ledger.units.every(unit => unit.evidence['post-fix']?.status === 'evidenced'
    && unit.evidence['post-fix'].validationRevision === ledger.validationRevision);
  const deliveryComplete = ledger.delivery === 'file-issues' ? ledger.deliveryVerified === true
    : postFixComplete && ledger.deliveryVerified === true;
  const pendingRemediations = Object.values(ledger.candidates).filter(candidate => ['pending', 'confirmed', 'deferred'].includes(candidate.disposition)
    || (candidate.disposition === 'resolved' && candidate.resolvedRevision !== ledger.validationRevision)).length;
  const remediationComplete = ledger.delivery === 'fix' && deliveryComplete && pendingRemediations === 0;
  return { discoveryComplete, remediationComplete,
    deliveryComplete, pendingRemediations, complete: discoveryComplete && deliveryComplete && (ledger.delivery !== 'fix' || remediationComplete),
    totalGroups: ledger.groups?.length ?? ledger.units.length, reviewedGroups: reviewedGroupIds.size,
    totalUnits: ledger.units.length, reviewedUnits: statuses.reviewed + statuses.inapplicable,
    satisfiedPasses: satisfied, requiredPasses: required, blockedUnits: blocked, pendingCandidates, statuses,
    reason: ledger.invalidReason || ledger.reason, resume: !discoveryComplete || !deliveryComplete || (ledger.delivery === 'fix' && !remediationComplete) };
}
