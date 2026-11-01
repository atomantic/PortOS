/** Retire only the exact delivered checkouts of an inline release. The normal
 * retirement service rechecks ownership, review, inventory and daemon authority;
 * this bounded sweep supplies no new deletion authority of its own. */
import { isInlineReleaseSynchronization, publisherCandidateTarget, RELEASE_SYNC_OBLIGATIONS, releaseSynchronizationReset } from '../lib/releaseSynchronization.js';
import { readRetirementCheckoutIdentity } from '../lib/retirementCheckoutObservation.js';

const deliveryReady = entry => entry?.registeredAt && isInlineReleaseSynchronization(entry)
  && !releaseSynchronizationReset(entry)
  && entry.synchronization && (!entry.synchronization.blocker || entry.synchronization.blocker.startsWith('retirement:'))
  && RELEASE_SYNC_OBLIGATIONS.filter(name => name !== 'retirement').every(name => entry.obligations[name]?.status === 'verified');
const sameCheckout = (a, b) => a && b && ['repoPath', 'path', 'branch', 'head', 'checkoutIdentity'].every(key => a[key] === b[key]);

export async function settleInlineReleaseCheckouts(entry, deps = {}) {
  if (!deliveryReady(entry)) return { attempted: false };
  const target = publisherCandidateTarget(entry);
  const synchronization = entry.obligations.synchronizationPr.evidence;
  const checkouts = entry.obligations.retirement.evidence?.checkouts;
  if (!target || !synchronization?.prUrl || !Array.isArray(checkouts) || !checkouts.length) return { attempted: false };
  const [{ getAppById }, { listWorktrees }, outcomes, retirement, guard, synchronizationService] = await Promise.all([
    import('./apps.js'), import('./worktreeManager.js'), import('./branchReconcileOutcome.js'),
    import('./heldCheckoutRecovery.js'), import('./branchReconcileRetirement.js'), import('./releaseSynchronization.js'),
  ]);
  const readApp = deps.getApp || getAppById;
  const list = deps.listWorktrees || listWorktrees;
  const readIdentity = deps.readIdentity || readRetirementCheckoutIdentity;
  const getOutcome = deps.getOutcome || outcomes.getBranchReconcileOutcome;
  const record = deps.record || outcomes.recordBranchReconcileOutcome;
  const prepare = deps.prepare || retirement.prepareInventoriedCheckoutRetirement;
  const retire = deps.retire || retirement.retireInventoriedCheckout;
  const allowed = deps.allowed || guard.assertAutomaticRetirementAllowed;
  const retainReview = deps.retainReview || synchronizationService.retainReleaseSynchronizationReview;
  const validateLocked = deps.validateLocked || synchronizationService.validateLockedPublisherRetirement;
  const app = await readApp(entry.task.metadata.app);
  if (!app?.repoPath || checkouts.some(row => row.repoPath !== app.repoPath)) return { attempted: false };
  const trees = await list(app.repoPath);
  if (!Array.isArray(trees) || !trees.length) return { attempted: false };
  const retired = [], held = [];
  for (const row of checkouts) {
    const publisher = sameCheckout(row, target);
    const prUrl = publisher ? `https://github.com/${entry.publication.repository}/pull/${entry.publication.promotionPrNumber}`
      : row.branch === synchronization.branch && row.head === synchronization.headSha ? synchronization.prUrl : null;
    if (!prUrl) { held.push({ branch: row.branch, reason: 'release-checkout-delivery-unverified' }); continue; }
    const matches = trees.filter(tree => tree.path === row.path && tree.branch?.replace(/^refs\/heads\//, '') === row.branch && tree.head === row.head);
    const tree = matches.length === 1 ? matches[0] : null;
    let release;
    if (!tree) {
      // A previous retirement may have removed the checkout but retained its
      // ref. Only its durable physical-removal receipt can resume that step.
      const outcome = await getOutcome(app.id).catch(() => null);
      const receipts = [...(outcome?.retired || []), ...Object.values(outcome?.retirementReceiptEvidence || {})]
        .filter(receipt => receipt.path === row.path && receipt.branch === row.branch && receipt.head === row.head
          && receipt.checkoutIdentity === row.checkoutIdentity && receipt.branchDeleted === false && receipt.archiveDir == null
          && Number.isFinite(Date.parse(receipt.retiredAt)) && Date.parse(receipt.retiredAt) >= Date.parse(row.createdAt));
      const unique = [...new Map(receipts.map(receipt => [receipt.retiredAt, receipt])).values()];
      if (unique.length !== 1) { held.push({ branch: row.branch, reason: 'release-checkout-generation-changed' }); continue; }
      release = { path: row.path, branch: row.branch, head: row.head, checkoutIdentity: row.checkoutIdentity, retiredAt: unique[0].retiredAt };
    } else if (await readIdentity(row.path) !== row.checkoutIdentity) {
      held.push({ branch: row.branch, reason: 'release-checkout-generation-changed' }); continue;
    }
    // A lock belongs to its holder unless it is the exact release-candidate
    // lock whose private review and settled owner the service can revalidate.
    if (tree?.locked && (!publisher || tree.lockReason !== `Active release candidate ${row.branch}`)) {
      held.push({ branch: row.branch, reason: 'release-checkout-locked' }); continue;
    }
    if (tree) release = { path: row.path, branch: row.branch, head: row.head, checkoutIdentity: row.checkoutIdentity,
      observedAt: new Date().toISOString(), locked: tree.locked === true, lockReason: tree.lockReason ?? null };
    try {
      await allowed();
      if (tree) await record(app.id, { status: 'incomplete', reason: 'retirement-review-pending',
        retirementObligations: [{ ...release, reason: 'retirement-review-pending' }],
        nextAction: 'Retain the exact checkout until its reviewed retirement receipt is verified.' });
      const prepared = await prepare({ appId: app.id, release, prUrl });
      if (!prepared.ok) { held.push({ branch: row.branch, reason: prepared.reason }); continue; }
      const review = prepared.review;
      if (review?.forge?.prHead !== row.head || review.comparison?.disposition !== 'integrated'
        || review.comparison.difference !== '' || typeof review.digest !== 'string') {
        held.push({ branch: row.branch, reason: 'release-retirement-review-unverified' }); continue;
      }
      if (tree?.locked && (!await retainReview({ ...release, repoPath: app.repoPath })
        || !await validateLocked({ ...release, repoPath: app.repoPath }))) {
        held.push({ branch: row.branch, reason: 'release-locked-owner-unverified' }); continue;
      }
      const result = await retire({ appId: app.id, release, review: { prUrl, digest: review.digest, acceptSuperseded: false } },
        { beforeMutation: allowed });
      if (result.ok && result.branchDeleted === true && result.archiveDir == null) retired.push(row.branch);
      else held.push({ branch: row.branch, reason: result.reason || result.branchRetainedReason || 'retirement-receipt-unverified' });
    } catch (error) {
      held.push({ branch: row.branch, reason: ['daemon-stopped', 'automatic-retirement-disabled'].includes(error.message)
        ? error.message : 'retirement-outcome-unverified' });
    }
  }
  return { attempted: true, retired, held };
}
