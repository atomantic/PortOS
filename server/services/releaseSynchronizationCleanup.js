/** Retire only the exact delivered checkouts of an inline release. The normal
 * retirement service rechecks ownership, review, inventory and daemon authority;
 * this bounded sweep supplies no new deletion authority of its own. */
import { realpath } from 'node:fs/promises';
import { inlineSynchronizationLockReason, isInlineReleaseSynchronization, publisherCandidateTarget, RELEASE_SYNC_OBLIGATIONS, releaseSynchronizationReset } from '../lib/releaseSynchronization.js';
import { readCheckoutPathPresence, readLocalBranchPresence } from './repoCleanupObservation.js';
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
  const pathPresence = deps.pathPresence || readCheckoutPathPresence;
  const branchPresence = deps.branchPresence || readLocalBranchPresence;
  const readIdentity = deps.readIdentity || readRetirementCheckoutIdentity;
  const record = deps.record || outcomes.recordBranchReconcileCheckout;
  const prepare = deps.prepare || retirement.prepareInventoriedCheckoutRetirement;
  const retire = deps.retire || retirement.retireInventoriedCheckout;
  const allowed = deps.allowed || guard.assertAutomaticRetirementAllowed;
  const retainReview = deps.retainReview || synchronizationService.retainReleaseSynchronizationReview;
  const validateLocked = deps.validateLocked || synchronizationService.validateLockedPublisherRetirement;
  const validateLockedSync = deps.validateLockedSync || synchronizationService.validateLockedSynchronizationRetirement;
  const app = await readApp(entry.task.metadata.app);
  // Seeds record the canonical repository path; app configuration may name a
  // symlink to it. An unreadable or different repository still grants nothing.
  const repoPath = app?.repoPath && await (deps.resolveRepoPath || realpath)(app.repoPath).catch(() => null);
  if (!repoPath || checkouts.some(row => row.repoPath !== repoPath)) return { attempted: false };
  const trees = await list(repoPath);
  if (!Array.isArray(trees) || !trees.length) return { attempted: false };
  const retired = [], held = [];
  for (const row of checkouts) {
    const hold = (reason, detail) => held.push({ branch: row.branch, path: row.path, reason, ...detail });
    const publisher = sameCheckout(row, target);
    const prUrl = publisher ? `https://github.com/${entry.publication.repository}/pull/${entry.publication.promotionPrNumber}`
      : row.branch === synchronization.branch && row.head === synchronization.headSha ? synchronization.prUrl : null;
    if (!prUrl) { hold('release-checkout-delivery-unverified'); continue; }
    const matches = trees.filter(tree => tree.path === row.path && tree.branch?.replace(/^refs\/heads\//, '') === row.branch && tree.head === row.head);
    const tree = matches.length === 1 ? matches[0] : null;
    let release;
    if (!tree) {
      const [pathPresent, branchPresent] = await Promise.all([pathPresence(row.path), branchPresence(repoPath, row.branch)]);
      if (pathPresent !== false || branchPresent === null || trees.some(tree => tree.path === row.path
        || tree.branch?.replace(/^refs\/heads\//, '') === row.branch)) {
        hold('release-checkout-generation-changed'); continue;
      }
      if (branchPresent === false) continue;
      release = { branch: row.branch, head: row.head, locked: false, lockReason: null };
    } else if (await readIdentity(row.path) !== row.checkoutIdentity) {
      hold('release-checkout-generation-changed'); continue;
    }
    // A lock belongs to its holder unless it is the exact release-candidate or
    // synchronization lock whose settled owner the service can revalidate.
    const ownLock = publisher ? `Active release candidate ${row.branch}` : inlineSynchronizationLockReason(row.agentId);
    if (tree?.locked && tree.lockReason !== ownLock) {
      hold('release-checkout-locked', { lockReason: tree.lockReason ?? null }); continue;
    }
    if (tree) release = { path: row.path, branch: row.branch, head: row.head, checkoutIdentity: row.checkoutIdentity,
      observedAt: new Date().toISOString(), locked: tree.locked === true, lockReason: tree.lockReason ?? null };
    try {
      await allowed();
      await record(app.id, release);
      if (tree && !await retainReview({ ...release, repoPath })) {
        hold('release-sync-local-review-unretained'); continue;
      }
      const prepared = await prepare({ appId: app.id, release, prUrl });
      if (!prepared.ok) { hold(prepared.reason); continue; }
      const review = prepared.review;
      if (review?.forge?.prHead !== row.head || review.comparison?.disposition !== 'integrated'
        || review.comparison.difference !== '' || typeof review.digest !== 'string') {
        hold('release-retirement-review-unverified'); continue;
      }
      if (tree?.locked && !await (publisher ? validateLocked : validateLockedSync)({ ...release, repoPath })) {
        hold('release-locked-owner-unverified'); continue;
      }
      const result = await retire({ appId: app.id, release, review: { prUrl, digest: review.digest, acceptSuperseded: false } },
        { beforeMutation: allowed });
      if (result.ok && result.branchDeleted === true && result.archiveDir == null) retired.push(row.branch);
      else hold(result.reason || result.branchRetainedReason || 'retirement-receipt-unverified');
    } catch (error) {
      hold(['daemon-stopped', 'automatic-retirement-disabled'].includes(error.message) ? error.message : 'retirement-outcome-unverified');
    }
  }
  return { attempted: true, retired, held };
}
