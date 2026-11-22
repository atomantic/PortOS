/** Orphan cleanup and merged worktree reaping. */

import { existsSync } from 'fs';
import { lstat, readdir } from 'fs/promises';
import { join, resolve } from 'path';
import { claimCheckoutOwnerReason } from '../../lib/claimContinuation.js';
import { execGit } from '../../lib/execGit.js';
import { probeProcessCwdInside } from '../../lib/processCwdProbe.js';
import { worktreeAgentId, worktreeOwnershipReason } from '../../lib/worktreeOwnership.js';
import { MERGED_OWNERSHIP_HOLDS, claimIssueOfBranch, decideExternalWorktreeCleanup, decideExternalWorktreeRemoval, decideMergedWorktreeRemoval, decideMergedWorktreeReap, decideWith } from '../branchRetirementDecision.js';
import { withGitMutationLifetime } from '../../lib/gitMutationLifetime.js';
import { WORKTREES_DIR, pathsEqual } from './paths.js';
import { deleteCompletedLocalBranch, forceRemoveWorktreeDir, resolveMergeTarget, removeWorktreeNow } from './remove.js';
import { classifyWorktreeDirt, readCheckoutPresence, readWorktreeStatus, listWorktrees } from './status.js';

export { listWorktrees } from './status.js';

// Registry the destructive passes re-read under the claim-ownership lock.
// Omitted reads state.json; `{ agents }` / `{ readAgents }` inject owners.
function claimOwnerReader(claimOwners, readClaimOwnershipAgents) {
  return claimOwners === undefined ? readClaimOwnershipAgents
    : async () => claimOwners?.readAgents ? claimOwners.readAgents().catch(() => null) : claimOwners?.agents;
}

// A liveness snapshot ages while the caller's earlier passes run, so the orphan
// passes re-read it per tree (#11858). A bare Set/null is a fixed snapshot.
function activeIdsReader(activeIds) {
  return typeof activeIds === 'function' ? activeIds : () => activeIds;
}

/**
 * Clean up any orphaned worktrees (worktrees whose agent no longer exists)
 *
 * @param {string} sourceWorkspace - The original git repository path
 * @param {(() => Set<string>|null)|Set<string>|null} getActiveIds - live agent ids, re-read
 *   for every worktree. Anything but a Set reads as "liveness unknown" and holds every `agent-*` tree.
 * @param {object} [options]
 * @param {{agents?: object[]|null, readAgents?: () => Promise<object[]|null>}} [options.claimOwners] -
 *   agent registry override (tests); omitted reads state.json
 * @param {Set<string>} [options.retainedPaths] - registered paths held by an earlier cleanup pass
 */
export async function cleanupOrphanedWorktrees(sourceWorkspace, getActiveIds, { claimOwners, retainedPaths = new Set() } = {}) {
  if (!existsSync(WORKTREES_DIR)) return 0;

  const readActiveIds = activeIdsReader(getActiveIds);
  const { readClaimOwnershipAgents } = await import('../cos/cosClaimOwnershipState.js');
  const readOwners = claimOwnerReader(claimOwners, readClaimOwnershipAgents);
  const worktrees = await listWorktrees(sourceWorkspace).catch(() => []);
  let cleaned = 0;

  // Track which agent dirs we handle via git worktree list (PortOS-owned worktrees)
  const handledAgentIds = new Set();

  for (const wt of worktrees) {
    const ownershipReason = () => worktreeOwnershipReason({
      path: wt.path,
      locked: wt.locked,
      activeAgentIds: readActiveIds(),
      roots: [{ path: WORKTREES_DIR, requireAgentId: true }],
      requireKnownLiveness: true,
    });
    const initialReason = ownershipReason();
    if (initialReason === 'worktree-unmanaged-location') continue;
    const agentId = worktreeAgentId(wt.path);
    handledAgentIds.add(agentId);
    if (retainedPaths.has(wt.path)) continue;
    if (initialReason) continue;
    // A detached HEAD has no branch to merge or measure; force-removing it would drop commits only its reflog holds.
    if (wt.detached || !wt.branch) continue;

    const branchName = wt.branch.replace('refs/heads/', '');
    // Attempt merge so committed work from preserved worktrees (e.g., PR/push failures) isn't lost.
    // If merge fails, the branch is preserved for manual recovery. Every critical
    // section re-reads liveness and the registry, so neither an agent dispatched
    // since the check above nor a registered claim owner loses its checkout.
    const result = await withGitMutationLifetime(() => removeWorktreeNow(agentId, sourceWorkspace, branchName, { merge: true }, async () =>
        ownershipReason() || claimCheckoutOwnerReason({ branchName, holderPath: wt.path, sourceWorkspace, agents: await readOwners() })),
    ).catch(err => {
      console.log(`⚠️ Failed to clean orphaned worktree ${agentId}: ${err.message}`);
      return { removed: false };
    });
    if (result?.removed) cleaned++;
  }

  // Scan for external-repo worktrees (directories whose .git points to a different repo).
  // These are invisible to `git worktree list` run against PortOS.
  cleaned += await cleanupExternalRepoWorktrees(readActiveIds, handledAgentIds, readOwners, retainedPaths);

  if (cleaned > 0) {
    console.log(`🌳 Cleaned ${cleaned} orphaned worktree(s)`);
  }

  return cleaned;
}

/**
 * Reap worktrees whose branch is fully merged into the default branch AND whose
 * working tree is clean. This is the SAFE counterpart to cleanupOrphanedWorktrees:
 * it never integrates unmerged work, never deletes anything with pending
 * changes, and honors worktree locks. A worktree is reaped only when BOTH hold:
 *   1. the working tree is completely clean, and
 *   2. every commit on the branch is already in the default branch — detected via
 *      `hasBranchMergeEvidence`, which covers normal AND squash/rebase merges.
 * Outside the CoS root, where no run record owns the tree, the branch must also
 * not be new, published, or still in use (`decideMergedWorktreeReap`, #16625):
 * ancestry alone reads a branch created at main a minute ago as merged.
 *
 * Because of gate (2) this works regardless of merge strategy, but a true merge
 * commit (see the `--merge`-preferring agent prompts) makes detection bulletproof.
 *
 * Covers both PortOS-managed CoS worktrees (`data/cos/worktrees/`) and the
 * `.claude/worktrees/` trees created by `/work`, `/claim`, and the superpowers
 * git-worktree skill (these share the PortOS repo, so they appear in
 * `git worktree list`). Active CoS agents and locked worktrees are never touched.
 *
 * Human `/claim` worktrees (`claim-*`) are ALWAYS skipped here, and deliberately
 * so — this reaper passes neither `allowStaleClaim` nor an age, which is not an
 * oversight to be fixed by handing it the same discriminator branch-reconcile
 * uses. Reclaiming a claim tree turns on how long it has been idle and on
 * whether its branch was provably SHIPPED (its upstream ref gone from origin),
 * and `branchReconcile` is the module that computes both, per branch, with the
 * remote-head listing to back it. This reaper knows only "merged + clean", which
 * is also true of a claim a human paused ten minutes ago. So the claim window
 * stays in ONE place: branchReconcile's merged-branch retirement reaps a shipped
 * or abandoned claim (on a branch-reconcile run, and daily through
 * `agent-data-cleanup` via `retireMergedCheckouts`), and the claim flow's
 * Phase 7 self-cleans the ordinary case. (Under
 * `WORKTREES_DIR` the skip is doubly enforced: that root sets
 * `requireAgentId: true`, so a `claim-*` basename is refused as
 * `worktree-missing-agent-id` before the claim test is even reached.)
 *
 * @param {string} sourceWorkspace - repo root
 * @param {object} [options]
 * @param {Set<string>|(() => Set<string>)} [options.activeAgentIds] - CoS agents currently running
 *   (never reaped), or a getter re-read per tree and again before removal. Anything but a
 *   Set reads as "liveness unknown" and holds every `agent-*` tree.
 * @param {boolean} [options.includeClaudeTrees=true] - also reap `.claude/worktrees/`
 * @param {{agents?: object[]|null, readAgents?: () => Promise<object[]|null>}} [options.claimOwners] -
 *   trusted agent registry reader or snapshot; omitted reads state.json
 * @returns {Promise<{reaped: Array<{path,branch,locked,branchDeleted}>, skipped: Array<{path,branch,reason,warning?}>, defaultBranch: string, target: string}>}
 */
export async function reapMergedWorktrees(sourceWorkspace, {
  activeAgentIds = new Set(),
  claimOwners,
  includeClaudeTrees = true,
  appId = null
} = {}) {
  const { getDefaultBranch, hasBranchMergeEvidence, readBranchLineage, readBranchPublished } = await import('../git.js');
  const { readClaimOwnershipAgents, withClaimOwnershipLock } = await import('../cos/cosClaimOwnershipState.js');
  const { readBranchCompletionHold } = await import('../branchCompletionPolicy.js');
  // Every entry point (scheduled or reconcile) needs a trusted
  // registry. loadState/getAgents may default a corrupt file to empty state.
  const readOwners = claimOwnerReader(claimOwners, readClaimOwnershipAgents);
  const readActiveIds = activeIdsReader(activeAgentIds);

  const defaultBranch = await getDefaultBranch(sourceWorkspace).catch(() => null) || 'main';
  const target = await resolveMergeTarget(sourceWorkspace, defaultBranch);

  const claudeTreesRoot = join(sourceWorkspace, '.claude', 'worktrees');
  const roots = { worktreesDir: WORKTREES_DIR, claudeTreesRoot };

  // An unreadable inventory is not an empty successful sweep: callers must
  // retain work rather than falling through to receipt-free orphan cleanup.
  const { readRepoBranchSnapshot } = await import('../repoBranchSnapshot.js');
  const { branches, worktrees, tips } = await readRepoBranchSnapshot(sourceWorkspace);
  const currentBranch = branches.find(branch => branch.current)?.name;
  const reaped = [];
  const skipped = [];

  for (const wt of worktrees) {
    // Never touch the primary worktree (the main repo checkout).
    if (pathsEqual(wt.path, sourceWorkspace)) continue;
    // Branch-keyed reads run only after the decision has proven the entry names a branch.
    const scannedBranch = wt.branch?.replace(/^refs\/heads\//, '');
    const contentReaders = {
      dirty: () => readWorktreeStatus(wt.path).then(status => status === null ? null : !classifyWorktreeDirt(status).clean),
      mergeEvidence: () => hasBranchMergeEvidence(sourceWorkspace, scannedBranch, target).catch(() => false),
    };
    const activeAgentIds = readActiveIds();
    const scan = await decideWith(facts => decideMergedWorktreeReap({
      tree: wt, defaultBranch, currentBranch, includeClaudeTrees, activeAgentIds, ...roots, facts,
    }), {
      dirty: contentReaders.dirty,
      mergeEvidence: () => hasBranchMergeEvidence(sourceWorkspace, scannedBranch, target, tips).catch(() => false),
      // A merged PR at this exact head makes uncommitted and untracked files
      // disposable, and proves a new or still-used branch shipped (#16625).
      mergedPrAtHead: async () => (await import('../prProbe.js')).isMergedPrHead(sourceWorkspace, scannedBranch, wt.head),
      lineage: () => readBranchLineage(sourceWorkspace, scannedBranch, wt.head, target),
      published: () => readBranchPublished(sourceWorkspace, scannedBranch),
      claimReserved: async () => (await import('../claimIssueReservation.js')).readRepoClaimIssueReservation(sourceWorkspace, claimIssueOfBranch(scannedBranch)),
      checkoutPresent: () => readCheckoutPresence(wt.path),
      checkoutProcess: () => probeProcessCwdInside(wt.path),
      idleMs: async () => (await import('../branchReconcile.js')).checkoutIdleMs(wt.path),
    });
    if (scan.hold) {
      if (MERGED_OWNERSHIP_HOLDS.has(scan.hold.reason)) console.log(`⏭️ Kept merged worktree ${wt.path} (branch ${scan.branch}): ${scan.hold.reason}`);
      // Named so a caller can say WHICH branch a hold kept, not just which path.
      skipped.push({ path: wt.path, ...(scan.branch && { branch: scan.branch }), reason: scan.hold.reason });
      continue;
    }
    const { branch: branchName, disposable } = scan.admit;
    const hold = (reason) => skipped.push({ path: wt.path, branch: branchName, reason });

    // The early reconcile pass must see the SAME registered owners and branch
    // reservations as later retirement. Binding stays excluded until removal and
    // branch deletion settle: both run in one ownership section.
    const verifyRemoval = async (holder) => (await decideWith(facts => decideMergedWorktreeRemoval({
      tree: wt, holder, sourceWorkspace, disposable, ...roots, facts,
    }), {
      agents: () => readOwners(),
      policyHold: () => readBranchCompletionHold({ repoPath: sourceWorkspace, branch: branchName, tip: wt.head, retirement: true }),
      activeAgentIds: () => readActiveIds(),
      ...contentReaders,
    })).hold?.reason ?? null;
    await withClaimOwnershipLock(async () => {
      const initialHold = await verifyRemoval(wt);
      if (initialHold) { hold(initialHold); return; }
      const removal = await forceRemoveWorktreeDir(sourceWorkspace, wt.path, {
        label: `worktree remove failed for ${wt.path}`, verifyRemoval,
      });
      if (!removal.removed) {
        skipped.push({ path: wt.path, branch: branchName, reason: removal.reason || 'remove-failed', warning: removal.warning });
        return;
      }
      const holders = removal.entries || await listWorktrees(sourceWorkspace).catch(() => null);
      const branchDeleted = holders && !holders.some(holder => holder.branch === wt.branch)
        && await deleteCompletedLocalBranch(sourceWorkspace, branchName, wt.head);
      if (branchDeleted && appId) {
        const { recordHeldCheckoutRetirement } = await import('../branchReconcileOutcome.js');
        await recordHeldCheckoutRetirement(appId, {
          path: wt.path, branch: branchName, head: wt.head, branchDeleted: true,
        }).catch(error => console.error(`❌ Retirement history not recorded for ${branchName}: ${error.message}`));
      }
      reaped.push({ path: wt.path, branch: branchName, locked: !!wt.locked, branchDeleted: Boolean(branchDeleted) });
      if (!branchDeleted) hold('branch-ref-changed-or-new-holder');
    });
  }

  if (reaped.length > 0) {
    console.log(`🌳 Reaped ${reaped.length} merged worktree(s): ${reaped.map(r => r.branch).join(', ')}`);
  }

  return { reaped, skipped, defaultBranch, target };
}

/**
 * Clean up worktree directories that belong to external repos (managed apps).
 * These are created when agents work on apps outside PortOS but use the shared
 * worktrees directory. They're invisible to PortOS's `git worktree list`.
 */
async function cleanupExternalRepoWorktrees(readActiveIds, alreadyHandled, readOwners, retainedPaths) {
  const { getDefaultBranch, hasBranchMergeEvidence } = await import('../git.js');
  const { withClaimOwnershipLock } = await import('../cos/cosClaimOwnershipState.js');
  const { readBranchCompletionHold } = await import('../branchCompletionPolicy.js');
  const entries = await readdir(WORKTREES_DIR, { withFileTypes: true }).catch(() => []);
  let cleaned = 0;

  // Git's own answer, never one inferred from the spelling of a .git file:
  // relative pointers, separate git directories and Windows separators are all valid.
  const readCommonDir = cwd => execGit(['rev-parse', '--git-common-dir'], cwd)
    .then(r => r.stdout.trim() ? resolve(cwd, r.stdout.trim()) : null).catch(() => null);

  for (const entry of entries) {
    if (!entry.isDirectory() || alreadyHandled.has(entry.name)) continue;
    const worktreePath = join(WORKTREES_DIR, entry.name);
    const readStatus = () => execGit(['status', '--porcelain'], worktreePath).then(r => r.stdout, () => null);
    let target;
    // One liveness snapshot for the scan: an agent dispatched while it inspects
    // the tree is for the ownership section's fresh read to catch (#11858).
    const activeAgentIds = readActiveIds();
    const scan = await decideWith(facts => decideExternalWorktreeCleanup({
      path: worktreePath, worktreesDir: WORKTREES_DIR, activeAgentIds, retainedPaths, samePath: pathsEqual, facts,
    }), {
      gitFile: async () => (await lstat(join(worktreePath, '.git')).catch(() => null))?.isFile() === true,
      commonDir: () => readCommonDir(worktreePath),
      // Git expands Windows short (8.3) aliases even where Node's realpath
      // keeps them. Compare Git's own spelling with its registration output.
      topLevel: () => execGit(['rev-parse', '--show-toplevel'], worktreePath).then(r => r.stdout.trim(), () => null),
      registrations: () => listWorktrees(worktreePath).catch(() => null),
      parentCommonDir: (_facts, { repo }) => readCommonDir(repo),
      defaultBranch: (_facts, { repo }) => getDefaultBranch(repo, { strict: true }).catch(() => null),
      dirty: () => readStatus().then(status => status === null ? null : !classifyWorktreeDirt(status).clean),
      disposableHead: async (_facts, { repo, branch, head }) => (await import('../prProbe.js')).isMergedPrHead(repo, branch, head),
      mergeEvidence: async (facts, { repo, branch }) => {
        target = await resolveMergeTarget(repo, facts.defaultBranch);
        return hasBranchMergeEvidence(repo, branch, target).catch(() => false);
      },
    });
    if (scan.hold) continue;
    const { tree: wt, repoPath: parentRepo, branch: branchName, disposable: externalDisposable } = scan.admit;

    // Non-force removal is a final Git guard against newly dirty or locked
    // trees. A refusal must never fall through to recursive filesystem removal.
    // One ownership section re-reads liveness and the registry before removing.
    const removed = await withGitMutationLifetime(() => withClaimOwnershipLock(async () => {
      const latest = (await listWorktrees(parentRepo)).find(holder => pathsEqual(holder.path, worktreePath)) ?? null;
      const recheck = await decideWith(facts => decideExternalWorktreeRemoval({
        tree: wt, path: worktreePath, holder: latest, repoPath: parentRepo, disposable: externalDisposable, worktreesDir: WORKTREES_DIR, facts,
      }), {
        agents: () => readOwners(),
        policyHold: () => readBranchCompletionHold({ repoPath: parentRepo, branch: branchName, retirement: true }),
        activeAgentIds: () => readActiveIds(),
        dirty: () => readStatus().then(status => status === null ? null : !classifyWorktreeDirt(status).clean),
        mergeEvidence: () => hasBranchMergeEvidence(parentRepo, wt.head, target).catch(() => false),
      });
      if (recheck.hold) return false;
      const ok = await execGit(['worktree', 'remove', ...(externalDisposable ? ['--force'] : []), worktreePath], parentRepo).then(() => true).catch(err => {
        console.warn(`⚠️ Preserved external worktree ${entry.name}: ${err.message}`);
        return false;
      });
      const deleted = ok && await deleteCompletedLocalBranch(parentRepo, branchName, wt.head);
      if (ok && !deleted) {
        console.warn(`⚠️ External branch ${branchName} retained: head changed, new holder, or deletion refused`);
      }
      if (ok) {
        // One line per removal so a vanished checkout is attributable to this sweep (#16618).
        const evidence = externalDisposable ? 'PR merged at exactly this head' : `branch head contained in ${target}`;
        console.log(`🌳 Removed external worktree ${worktreePath} (branch ${branchName} @ ${String(wt.head).slice(0, 12)}, repo ${parentRepo}): ${evidence}`);
        const { recordWorkspaceCheckoutRetirement } = await import('../branchReconcileOutcome.js');
        await recordWorkspaceCheckoutRetirement(parentRepo, {
          path: wt.path, branch: branchName, head: wt.head, branchDeleted: Boolean(deleted),
        }).catch(error => { console.warn(`⚠️ External retirement receipt not recorded for ${entry.name}: ${error.message}`); });
      }
      return ok;
    })).catch(err => {
      console.warn(`⚠️ Preserved external worktree ${entry.name}: ${err.message}`);
      return false;
    });
    if (removed) cleaned++;
  }

  return cleaned;
}
