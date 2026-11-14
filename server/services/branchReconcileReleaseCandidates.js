/**
 * Older releases locked each release-candidate checkout with
 * `Active release candidate <branch>` and nothing unlocks it afterwards. Once the
 * candidate's release PR is merged at the checkout's exact head, that lock has
 * served its purpose: route the checkout through the inventoried review/retire
 * path, which archives it and releases the reviewed lock itself.
 */
import { withGitMutationLifetime } from '../lib/gitMutationLifetime.js';

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
    if (!prUrl) {
      // Release only the old candidate-specific lock. Normal branch reconcile
      // then applies its ordinary dirty/unique-content and ownership rules.
      const unlocked = await (deps.unlockAbandoned || unlockAbandonedCandidate)(app, tree, deps).catch(() => false);
      if (unlocked) held.push({ ...release, locked: false, lockReason: null, reason: 'candidate-unlocked-for-reconciliation' });
      continue;
    }
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


/** Abandoned candidates do not need a manual retirement API. Unlocking never
 * deletes a checkout, branch, commit, private review file or uncommitted work. */
async function unlockAbandonedCandidate(app, tree, deps = {}) {
  const branch = tree.branch.replace(/^refs\/heads\//, '');
  if (!/^codex\/release-agent-[a-z0-9-]+$/.test(branch)) return false;
  const { execGh } = await import('./github.js');
  const { resolveForgeExecOptions } = await import('./forgeExecOptions.js');
  const options = await resolveForgeExecOptions(app.repoPath, { forgeAccount: app.forgeAccount ?? null });
  const open = JSON.parse(await execGh(['pr', 'list', '--state', 'open', '--head', branch, '--json', 'number', '--limit', '1'], undefined, options));
  if (!Array.isArray(open) || open.length) return false;
  const { withClaimOwnershipLock, readClaimOwnershipAgents, checkoutRetirementFenceReason } = await import('./cosClaimOwnershipState.js');
  const { claimCheckoutOwnerReason } = await import('../lib/claimContinuation.js');
  const { listWorktrees } = await import('./worktreeManager.js');
  const { execGit } = await import('../lib/execGit.js');
  return withClaimOwnershipLock(() => withGitMutationLifetime(async () => {
    await (deps.beforeMutation || (await import('./branchReconcileRetirement.js')).assertAutomaticRetirementAllowed)();
    const agents = await readClaimOwnershipAgents();
    const { getActiveAgentIds } = await import('./agentState.js');
    const active = new Set(getActiveAgentIds());
    if (!agents || [...active].some(id => !agents.some(agent => agent.id === id))) return false;
    const owners = agents.map(agent => active.has(agent.id) ? { ...agent, status: 'running' } : agent);
    if (checkoutRetirementFenceReason({ repoPath: app.repoPath, path: tree.path, branch })
      || claimCheckoutOwnerReason({ branchName: branch, holderPath: tree.path, sourceWorkspace: app.repoPath, agents: owners })) return false;
    const current = (await listWorktrees(app.repoPath)).find(row => row.path === tree.path);
    if (!current || current.head !== tree.head || current.branch?.replace(/^refs\/heads\//, '') !== branch
      || current.locked !== true || current.lockReason !== LOCK_PREFIX + branch) return false;
    await execGit(['worktree', 'unlock', tree.path], app.repoPath);
    return true;
  }));
}
