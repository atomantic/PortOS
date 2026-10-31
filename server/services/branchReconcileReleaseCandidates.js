/**
 * docs/VERSIONING.md locks each release-candidate checkout with
 * `Active release candidate <branch>` and nothing unlocks it afterwards. Once the
 * candidate's release PR is merged at the checkout's exact head, that lock has
 * served its purpose: route the checkout through the inventoried review/retire
 * path, which archives it and releases the reviewed lock itself.
 */

const LOCK_PREFIX = 'Active release candidate ';

/** Inventory rows whose lock names exactly their own branch. Any other lock prose stays held. */
export function releaseCandidateTrees(result) {
  return (result.worktreeInventory || []).filter(tree => tree?.locked === true && typeof tree.branch === 'string'
    && tree.lockReason === `${LOCK_PREFIX}${tree.branch.replace(/^refs\/heads\//, '')}`);
}

/** Only an exact-head merged PR with a fully integrated, difference-free review retires. */
export async function retireMergedReleaseCandidates(app, result, deps = {}) {
  const retired = [];
  const held = [];
  const trees = releaseCandidateTrees(result);
  if (!trees.length) return { retired, held };
  const readPr = deps.readPr || (async (a, name, tip) => (await (await import('./heldCheckoutReview.js'))
    .findMergedPullRequest(a.repoPath, name, tip, { forgeAccount: a.forgeAccount ?? null })).url);
  const prepare = deps.prepare || (await import('./heldCheckoutRecovery.js')).prepareInventoriedCheckoutRetirement;
  const retire = deps.retire || (await import('./heldCheckoutRecovery.js')).retireInventoriedCheckout;
  const guard = deps.beforeMutation || (await import('./branchReconcileRetirement.js')).assertAutomaticRetirementAllowed;
  for (const tree of trees) {
    const release = { ...(tree.observedAt && { observedAt: tree.observedAt }), ...(tree.checkoutIdentity && { checkoutIdentity: tree.checkoutIdentity }),
      branch: tree.branch, path: tree.path, head: tree.head, locked: true, lockReason: tree.lockReason };
    // An open, closed-unmerged or unreadable PR is the normal "still active" case: leave the lock alone.
    const prUrl = await readPr(app, tree.branch.replace(/^refs\/heads\//, ''), tree.head).catch(() => null);
    if (!prUrl) continue;
    const prepared = await prepare({ appId: app.id, release, prUrl }).catch(() => null);
    const review = prepared?.ok ? prepared.review : null;
    if (review?.forge?.prHead !== release.head || review.comparison?.disposition !== 'integrated' || review.comparison.difference !== '') continue;
    const outcome = await retire({ appId: app.id, release, review: { prUrl, digest: review.digest, acceptSuperseded: false } }, { beforeMutation: guard })
      .catch(error => ({ ok: false, reason: ['daemon-stopped', 'automatic-retirement-disabled'].includes(error.message) ? error.message : 'retirement-receipt-unverified' }));
    if (outcome.ok && outcome.branchDeleted === true) retired.push(release);
    else held.push({ ...release, reason: outcome.reason || 'retirement-receipt-unverified', ...(outcome.archiveLimit && { archiveLimit: outcome.archiveLimit }) });
  }
  return { retired, held };
}
