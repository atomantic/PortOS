/**
 * Retirement of a checkout that branch reconciliation inventoried but could not
 * clean as an ordinary merged branch (#12002, #16016): one held by a completion
 * review obligation, by a `git worktree lock`, or by a pending-merge receipt.
 *
 * A merged delivery's checkout is disposable. Once its PR merged at the exact
 * checkout head, the worktree (including uncommitted, untracked and ignored
 * files) and its branch are removed directly; when every commit is already on
 * the default branch, a clean checkout is removed the same way. An unmerged
 * checkout keeps its work in place. Nothing is copied into an archive.
 *
 * Authority is a scoped release, never an inference. The caller names the exact
 * inventory row — checkout path, HEAD, branch and lock state — and that release
 * only applies while a fresh read of the repository still matches it. A lock's
 * age, an absent process or its prose never establish release: a changed lock,
 * HEAD or branch is an ownership change and refuses. Live owners and manual
 * handoffs always keep the checkout.
 */

import { readLocalBranchPresence } from './repoCleanupObservation.js';
import { realpathSync } from 'node:fs';
import { lstat, readlink, stat, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execGit } from '../lib/execGit.js';
import { PROTECTED_BRANCHES } from '../lib/gitArgs.js';
import { decideHeldCheckoutRetirement, decideInventoriedBranchRetirement, decideMergedCheckoutOwner, decideMergedDelivery, decidePendingMergeReceipt, decideWith } from './branchRetirementDecision.js';
import { listWorktrees, forceRemoveWorktreeDir, deleteCompletedLocalBranch, classifyWorktreeDirt } from './worktreeManager.js';
import { getDefaultBranch, getStatusPorcelain, hasBranchMergeEvidence, resolveForgeForRepo } from './git.js';
import { withClaimOwnershipLock, readClaimOwnershipAgents } from './cos/cosClaimOwnership.js';

const FULL_OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const shortBranch = (ref) => (ref ? String(ref).replace(/^refs\/heads\//, '') : null);
// Refusals the automatic daemon gate raises on purpose; any other throw is uncertain.
const AUTOMATIC_GATE_REASONS = new Set(['daemon-stopped', 'automatic-retirement-disabled']);

/** Re-read daemon authority at each automatic mutation boundary. Manual API
 * callers keep their existing operator-authorized contract.
 */
export async function assertAutomaticRetirementAllowed() {
  const [{ isDaemonRunning, loadState }, { getDomainMode }] = await Promise.all([
    import('./cos/cosState.js'), import('../lib/domainAutonomy.js'),
  ]);
  if (!isDaemonRunning()) throw new Error('daemon-stopped');
  const state = await loadState();
  if (state.paused || getDomainMode(state.config, 'cos') !== 'execute') throw new Error('automatic-retirement-disabled');
}

/**
 * How the forge delivered `branch` at `head`: `exact` when its PR merged at
 * exactly that commit; `contained` when the merged PR's head descends from it
 * (an update or follow-up pushed from elsewhere before the merge); `none` when
 * the forge answered and neither holds; null when it could not be read.
 */
export async function readForgeDelivery(repoPath, branch, head) {
  const observed = String(head || '').toLowerCase();
  if (!branch || !FULL_OBJECT_ID.test(observed)) return null;
  // Awaited without an abandon-on-timeout race: removal follows this answer.
  const forge = await resolveForgeForRepo(repoPath).catch(() => null);
  if (!forge?.cli) return null;
  const { probePrForBranch, isExactMergedPrHead } = await import('./prProbe.js');
  const probe = await probePrForBranch(repoPath, branch, forge).catch(() => null);
  if (probe?.readable !== true) return null;
  if (isExactMergedPrHead(probe, observed)) return 'exact';
  if (probe.prState !== 'MERGED' || probe.cli !== 'gh' || !probe.prUrl) return 'none';
  const { readMergedPrDelivery } = await import('./mergedPrEvidence.js');
  const delivery = await readMergedPrDelivery(repoPath, branch, probe.prUrl, { exactDeliveredHead: observed }).catch(() => null);
  if (!delivery) return null;
  return delivery.scopeProof === 'ancestor-of-delivered-head' ? 'contained' : 'none';
}

const DELIVERED = new Set(['exact', 'contained']);

/** Merge evidence for the observed head: the forge delivered it, or every
 * commit is already on the default branch (ancestry or patch-equivalent). */
const isMergedHead = (repoPath, head, defaultBranch, deliveredHead) => (deliveredHead && String(head).toLowerCase() === deliveredHead)
  || hasBranchMergeEvidence(repoPath, head, defaultBranch).catch(() => false);

/** Only a PR merged at the exact head makes uncommitted and untracked files
 * disposable; work contained in a later merged head must be clean. */
const isDisposable = (head, porcelain, disposableHead) => classifyWorktreeDirt(porcelain).clean
  || Boolean(disposableHead && String(head).toLowerCase() === disposableHead);

/** Whether a checkout is a merged delivery this service retires: its PR merged
 * at exactly `head`, or its work is merged and nothing is uncommitted. Null when
 * the forge or the checkout could not be read. Read-only: retirement re-proves
 * all of it, with ownership, under its fence. */
export async function readMergedDelivery(repoPath, { branch, path, head }) {
  const [defaultBranch, porcelain] = await Promise.all([
    getDefaultBranch(repoPath, { allowRemote: false, strict: true }).catch(() => null),
    getStatusPorcelain(path).catch(() => null),
  ]);
  const clean = porcelain === null ? null : classifyWorktreeDirt(porcelain).clean;
  const ancestry = Boolean(defaultBranch) && await hasBranchMergeEvidence(repoPath, head, defaultBranch).catch(() => false);
  const step = await decideWith(facts => decideMergedDelivery({ clean, ancestry, facts }), {
    delivery: () => readForgeDelivery(repoPath, branch, head),
  });
  return step.merged;
}

/** Readers for `decideMergedCheckoutOwner`'s facts. */
const ownerReaders = ({ repoPath, branch, readAgents }) => ({
  agents: () => readAgents().catch(() => null),
  runtimeAgentIds: async () => new Set((await import('./agent/agentState.js')).getActiveAgentIds()),
  completionHold: async () => (await import('./branchCompletionPolicy.js'))
    .readBranchCompletionHold({ repoPath, branch, retirement: true }).catch(() => 'pr-completion-policy-unavailable'),
});

/** Why someone still owns this checkout or branch, or null (`decideMergedCheckoutOwner`). */
async function ownerReason({ repoPath, path, branch, readAgents }) {
  const step = await decideWith(facts => decideMergedCheckoutOwner({ repoPath, path, branch, facts }), ownerReaders({ repoPath, branch, readAgents }));
  return step.hold?.reason ?? null;
}

const samePhysicalCheckout = (a, b) => {
  try { return realpathSync.native(a) === realpathSync.native(b); } catch { return false; }
};

/** The first link component of a checkout-relative path, never following one.
 * Git for Windows can list a junction's descendants as ordinary files. */
async function firstLinkComponent(root, rel) {
  const parts = rel.replace(/\/$/, '').split('/');
  for (let i = 0; i < parts.length; i++) {
    const prefix = parts.slice(0, i + 1).join('/');
    const info = await lstat(join(root, prefix)).catch(() => null);
    if (!info) return null;
    if (info.isSymbolicLink()) return prefix;
    if (!info.isDirectory()) return null;
  }
  return null;
}

/** Git for Windows leaves directory junctions behind (git-for-windows/git#6151).
 * Just before removal, unlink each untracked or ignored link to a directory,
 * never its target; `removed` collects them so a refused removal can restore. */
async function unlinkDirectoryLinks(root, removed) {
  const listed = (await execGit(['ls-files', '--others', '-z'], root, { maxBuffer: 64 * 1024 * 1024 })).stdout.split('\0').filter(Boolean);
  const seen = new Set();
  for (const entry of listed) {
    const rel = await firstLinkComponent(root, entry);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    // Git handles file links itself; inspect the target's type without reading it.
    if (!(await stat(join(root, rel)).catch(() => null))?.isDirectory()) continue;
    const target = await readlink(join(root, rel));
    await unlink(join(root, rel));
    removed.push({ rel, target });
  }
}

/** Recreate unlinked directory links under unchanged real parent directories only. */
async function restoreDirectoryLinks(root, removed) {
  let restored = true;
  for (const { rel, target } of removed) {
    const parent = rel.split('/').slice(0, -1).join('/');
    const parentSafe = !parent || ((await lstat(join(root, parent)).catch(() => null))?.isDirectory()
      && await firstLinkComponent(root, parent) === null);
    const ok = parentSafe && await symlink(target, join(root, rel), process.platform === 'win32' ? 'junction' : 'dir')
      .then(() => true, () => false);
    if (!ok) restored = false;
  }
  return restored;
}

/**
 * Remove one merged checkout under a scoped release. Nothing is copied.
 *
 * @param {{ repoPath: string, release: { path: string, head: string, branch: string|null, locked: boolean, lockReason: string|null } }} input
 * @param {{ readAgents?: () => Promise<object[]|null>, beforeMutation?: () => Promise<void>, inventoryCurrent?: () => Promise<boolean>, delivery?: 'exact'|'contained' }} [opts]
 *   `delivery` is the readForgeDelivery answer the caller already read for `release.head`.
 * @returns {Promise<{ ok: true, branchDeleted: boolean, branchRetainedReason?: string } | { ok: false, reason: string }>}
 */
async function retireHeldCheckout({ repoPath, release }, opts = {}) {
  const { readAgents = readClaimOwnershipAgents } = opts;
  const branch = release.branch ?? null;
  if (branch && PROTECTED_BRANCHES.includes(branch)) return { ok: false, reason: 'protected-branch' };
  const defaultBranch = await getDefaultBranch(repoPath, { allowRemote: false, strict: true }).catch(() => null);
  if (!defaultBranch) return { ok: false, reason: 'default-branch-unavailable' };
  if (branch === defaultBranch) return { ok: false, reason: 'protected-branch' };
  // A forge call, asked before taking the ownership lock; every gate below binds
  // the answer to the head it observes.
  const delivery = Object.hasOwn(opts, 'delivery') ? opts.delivery : await readForgeDelivery(repoPath, branch, release.head);
  const deliveredHead = DELIVERED.has(delivery) ? String(release.head).toLowerCase() : null;
  const disposableHead = delivery === 'exact' ? deliveredHead : null;
  const refuse = reason => ({ ok: false, reason });
  // One ownership critical section: a bind lands before the owner read or after removal.
  return withClaimOwnershipLock(async () => {
    if (opts.inventoryCurrent && !await opts.inventoryCurrent()) return refuse('release-not-in-inventory');
    await opts.beforeMutation?.();
    const step = await decideWith(facts => decideHeldCheckoutRetirement({ repoPath, release, deliveredHead, disposableHead, facts }), {
      trees: () => listWorktrees(repoPath).catch(() => null),
      samePhysical: (_facts, { path }) => samePhysicalCheckout(path, release.path),
      mergeEvidence: () => hasBranchMergeEvidence(repoPath, release.head, defaultBranch).catch(() => false),
      clean: async () => {
        const porcelain = await getStatusPorcelain(release.path).catch(() => null);
        return porcelain === null ? null : classifyWorktreeDirt(porcelain).clean;
      },
      ...ownerReaders({ repoPath, branch, readAgents }),
    });
    if (step.hold) return refuse(step.hold.reason);
    return removeHeldCheckout({ repoPath, release, tree: step.admit.tree, branch, defaultBranch, deliveredHead, disposableHead }, opts);
  });
}

/**
 * Unlock, remove and delete the branch of a checkout admitted in the same section.
 * Agent registration and checkout content change without the ownership lock, so
 * removal re-checks them at Git's mutation boundary.
 */
async function removeHeldCheckout({ repoPath, release, tree, branch, defaultBranch, deliveredHead, disposableHead }, opts) {
  const { readAgents = readClaimOwnershipAgents } = opts;
  if (release.locked) {
    const unlocked = await execGit(['worktree', 'unlock', tree.path], repoPath).then(() => true, () => false);
    if (!unlocked) return { ok: false, reason: 'worktree-unlock-failed' };
  }
  const verifyRemoval = async (holder) => {
    if (!holder || holder.head !== tree.head || shortBranch(holder.branch) !== branch) return 'worktree-holder-changed';
    if (opts.inventoryCurrent && !await opts.inventoryCurrent()) return 'release-not-in-inventory';
    const [porcelain, merged] = await Promise.all([
      getStatusPorcelain(tree.path).catch(() => null), isMergedHead(repoPath, tree.head, defaultBranch, deliveredHead),
    ]);
    if (porcelain === null || !isDisposable(tree.head, porcelain, disposableHead)) return 'worktree-dirty';
    if (!merged) return 'not-merged-on-recheck';
    return ownerReason({ repoPath, path: tree.path, branch, readAgents });
  };
  const removedLinks = [];
  let linksPrepared = false;
  const removal = await forceRemoveWorktreeDir(repoPath, tree.path, {
    label: '🧹 held-checkout recovery: remove checkout', log: 'all', verifyRemoval,
    beforeMutation: async () => {
      await opts.beforeMutation?.();
      // The removal helper also calls this hook before pruning registration.
      if (linksPrepared) return;
      linksPrepared = true;
      await unlinkDirectoryLinks(tree.path, removedLinks);
    },
  });
  if (!removal.removed) {
    // A refused removal may leave the checkout intact. Restore its links without
    // overwriting anything a concurrent writer created.
    const linkRestoreFailed = removedLinks.length > 0 && !await restoreDirectoryLinks(tree.path, removedLinks);
    // Hand the lock back exactly as released. A lock someone took in the
    // meantime makes this fail, which is the outcome we want anyway.
    if (release.locked) {
      const args = ['worktree', 'lock', ...(release.lockReason != null ? ['--reason', release.lockReason] : []), tree.path];
      await execGit(args, repoPath).catch(err => console.warn(`⚠️ held-checkout recovery: could not restore lock on ${tree.path}: ${err.message}`));
    }
    if (linkRestoreFailed) return { ok: false, reason: 'retirement-link-restore-failed' };
    return { ok: false, reason: removal.reason || 'worktree-remove-failed' };
  }
  console.log(`🧹 held-checkout recovery: retired ${tree.path}`);
  if (!branch) return { ok: true, branchDeleted: false };
  const hold = await ownerReason({ repoPath, path: null, branch, readAgents });
  if (hold) return { ok: true, branchDeleted: false, branchRetainedReason: hold };
  // A new checkout/commit cannot be deleted by a stale name-only operation.
  const holders = await listWorktrees(repoPath).catch(() => null);
  if (!holders || holders.some(holder => shortBranch(holder.branch) === branch)) return { ok: true, branchDeleted: false, branchRetainedReason: 'branch-has-new-holder' };
  const deleted = await deleteCompletedLocalBranch(repoPath, branch, release.head, { beforeMutation: opts.beforeMutation });
  if (!deleted) return { ok: true, branchDeleted: false, branchRetainedReason: 'branch-ref-changed-or-delete-failed' };
  return { ok: true, branchDeleted: true };
}

const sameRelease = (entry, release) => entry.path === release.path && entry.head === release.head
  && (entry.branch ?? null) === (release.branch ?? null) && Boolean(entry.locked) === release.locked
  && (entry.lockReason ?? null) === (release.lockReason ?? null);

/** Binds the release to the persisted row it names. A legacy `checkoutIdentity` on either side is ignored. */
function bindInventoriedRelease(outcome, release) {
  const entry = outcome?.remaining?.find(row => sameRelease(row, release));
  if (!entry) return null;
  return { path: release.path, head: release.head, branch: release.branch ?? null,
    locked: release.locked, lockReason: release.lockReason ?? null };
}

/** Finish only the checkout named by a trusted pending-merge receipt. Unlike an
 * operator release, this never unlocks a checkout. Fresh forge evidence must
 * prove the receipt's own PR merged at the handed-off head or at a descendant of it.
 */
export async function retirePendingMergeCheckout({ repoPath, release, prUrl, expectedHeadSha }, opts = {}) {
  const step = await decideWith(facts => decidePendingMergeReceipt({ release, expectedHeadSha, facts }), {
    forge: async () => (await import('./mergedPrEvidence.js'))
      .readMergedPrDelivery(repoPath, release.branch, prUrl, { forgeAccount: opts.forgeAccount ?? null, exactDeliveredHead: expectedHeadSha })
      .catch(error => ({ error })),
  });
  if (step.hold) return { ok: false, reason: step.hold.reason };
  const result = await retireHeldCheckout({ repoPath, release }, { ...opts, delivery: step.admit.delivery });
  if (result.ok) {
    const { recordWorkspaceCheckoutRetirement } = await import('./branchReconcileOutcome.js');
    await recordWorkspaceCheckoutRetirement(repoPath, {
      path: release.path, branch: release.branch, head: release.head,
      branchDeleted: result.branchDeleted,
    });
  }
  return result;
}

/**
 * Retire one row of the app's last persisted branch-reconcile inventory: the
 * Schedule view's single-step operator action, and the automatic pass below.
 * The release must name that row exactly, so it binds to evidence the operator
 * saw. A merged checkout is removed with its branch; anything else stays.
 */
export async function retireInventoriedCheckout({ appId, release }, opts = {}) {
  const [{ getAppById }, outcomes] = await Promise.all([import('./apps.js'), import('./branchReconcileOutcome.js')]);
  const app = await getAppById(appId);
  if (!app?.repoPath) return { ok: false, reason: 'app-not-found' };
  if (!release.path) return release.branch ? retireInventoriedBranch({ appId, repoPath: app.repoPath, release }, opts) : { ok: false, reason: 'release-not-in-inventory' };
  release = bindInventoriedRelease(await outcomes.getBranchReconcileOutcome(appId), release);
  if (!release) return { ok: false, reason: 'release-not-in-inventory' };
  const inventoryCurrent = async () => (await outcomes.getBranchReconcileOutcome(appId))?.remaining?.some(entry => sameRelease(entry, release)) === true;
  const result = await retireHeldCheckout({ repoPath: app.repoPath, release }, { ...opts, inventoryCurrent });
  if (!result.ok && result.reason === 'checkout-not-found') {
    await outcomes.getBranchReconcileInventory(appId);
    return { ok: false, reason: 'inventory-refresh-required' };
  }
  if (result.ok) {
    await outcomes.recordHeldCheckoutRetirement(appId, {
      path: release.path, branch: release.branch ?? null, head: release.head, branchDeleted: result.branchDeleted,
      ...(!release.branch && { checkoutOnly: true }),
    });
  }
  return result;
}

/** An inventoried merged branch whose checkout is already gone: delete the exact ref. */
async function retireInventoriedBranch({ appId, repoPath, release }, opts = {}) {
  if (PROTECTED_BRANCHES.includes(release.branch)) return { ok: false, reason: 'protected-branch' };
  const { getBranchReconcileOutcome, recordHeldCheckoutRetirement } = await import('./branchReconcileOutcome.js');
  const delivered = DELIVERED.has(await readForgeDelivery(repoPath, release.branch, release.head));
  const ref = `refs/heads/${release.branch}`;
  const readers = {
    inventoryRow: async () => (await getBranchReconcileOutcome(appId))?.remaining?.some(row => !row.path && row.branch === release.branch && row.head === release.head),
    defaultBranch: () => getDefaultBranch(repoPath, { allowRemote: false, strict: true }).catch(() => null),
    holders: () => listWorktrees(repoPath).catch(() => null),
    // show-ref exit 1 also covers broken symbolic and malformed loose refs, so
    // only the bounded files-backend inspection can establish actual absence.
    presence: () => readLocalBranchPresence(repoPath, release.branch),
    symbolicExit: async () => (await execGit(['symbolic-ref', '--quiet', ref], repoPath, { ignoreExitCode: true }).catch(() => null))?.exitCode,
    tip: () => execGit(['rev-parse', '--verify', ref], repoPath).then(row => row.stdout.trim(), () => null),
    mergeEvidence: facts => hasBranchMergeEvidence(repoPath, release.head, facts.defaultBranch).catch(() => false),
    ...ownerReaders({ repoPath, branch: release.branch, readAgents: opts.readAgents || readClaimOwnershipAgents }),
  };
  // Every check re-reads live state; a failure throws its reason and keeps the ref.
  const recheck = async () => {
    await opts.beforeMutation?.();
    const step = await decideWith(facts => decideInventoriedBranchRetirement({ repoPath, branch: release.branch, head: release.head, delivered, facts }), readers);
    if (step.hold) throw new Error(step.hold.reason);
    return step.admit;
  };
  const record = () => recordHeldCheckoutRetirement(appId, { branch: release.branch, head: release.head, branchDeleted: true });
  return withClaimOwnershipLock(async () => {
    let branchDeleted = false;
    const done = await (async () => {
      if ((await recheck()).missing) { branchDeleted = true; await record(); return true; }
      return deleteCompletedLocalBranch(repoPath, release.branch, release.head, {
        beforeMutation: async () => { if ((await recheck()).missing) throw new Error('branch-ref-changed-or-recreated'); },
        onRetired: async () => { branchDeleted = true; await record(); },
      });
    })().catch(error => ({ reason: error.message }));
    return done === true ? { ok: true, branchDeleted: true }
      : { ok: false, ...(branchDeleted && { branchDeleted: true }), reason: done?.reason || 'branch-ref-changed-or-delete-failed' };
  });
}

const isCompletionReviewHold = branch => branch.rule === 'completion-policy'
  && branch.completionPolicyReason === 'pr-completion-review-required';

/** A merged local copy whose open PR head moved on was left behind by the
 * delivery: everything it holds is on the default branch, and the PR's head is
 * not this checkout's. An open PR at this tip is the live delivery itself.
 */
function staleBehindOpenPr(branch) {
  const prHead = branch.openPr?.headRefOid;
  return branch.isMerged === true && !branch.openPr.isDraft
    && typeof prHead === 'string' && FULL_OBJECT_ID.test(prHead) && prHead !== branch.tip;
}

async function isIdleCheckout(path, deps) {
  const { checkoutIdleMs, SHIPPED_CLAIM_IDLE_MS } = await import('./branchReconcile.js');
  const idle = await (deps.checkoutIdleMs || checkoutIdleMs)(path).catch(() => null);
  return Number.isFinite(idle) && idle >= SHIPPED_CLAIM_IDLE_MS;
}

/**
 * Branch reconciliation's automatic pass over completed local work the scan
 * held for a review-then-merge obligation, plus release-candidate locks. The
 * inventory is persisted first, so each release binds to the row it names.
 * A merged checkout is retired directly; unmerged work is left in place and
 * stays reported by the scan.
 * @returns {Promise<{ held: object[], retired: object[] }>}
 */
export async function retireCompletedCheckouts(app, result, deps = {}) {
  const held = [];
  const retired = [];
  const retire = deps.retire || retireInventoriedCheckout;
  const readDelivery = deps.readForgeDelivery || readForgeDelivery;
  for (const branch of result.wip || []) {
    if (!isCompletionReviewHold(branch) || branch.liveOwnerReason || branch.worktreeStatusUnavailable) continue;
    if (branch.openPr && !staleBehindOpenPr(branch)) continue;
    const tree = result.worktreeInventory?.find(row => row.branch === branch.branch && row.path === branch.worktreePath);
    if (!tree || tree.managed !== true || tree.locked !== false || tree.head !== branch.tip) continue;
    // The open PR ships from another checkout; this one has idled behind it, so
    // only local merge evidence applies.
    if (branch.openPr && !(await isIdleCheckout(tree.path, deps))) continue;
    const delivery = branch.openPr ? undefined : await readDelivery(app.repoPath, branch.branch, tree.head);
    const merged = delivery === 'contained' || branch.isMerged === true;
    if (delivery !== 'exact' && !(merged && !branch.worktreeDirty)) continue;
    const release = { ...(tree.observedAt && { observedAt: tree.observedAt }),
      branch: tree.branch, path: tree.path, head: tree.head, locked: false, lockReason: null };
    // The service re-proves merge evidence, content and ownership under its fence.
    const outcome = await retire({ appId: app.id, release }, { beforeMutation: assertAutomaticRetirementAllowed, ...(delivery !== undefined && { delivery }) })
      .catch(error => ({ ok: false, reason: AUTOMATIC_GATE_REASONS.has(error.message) ? error.message : 'retirement-outcome-uncertain' }));
    if (outcome.ok && outcome.branchDeleted === true) retired.push(release);
    else held.push({ ...release, reason: outcome.reason || outcome.branchRetainedReason || 'retirement-outcome-uncertain' });
  }
  // A release candidate's own lock is released once its release PR is merged.
  const releaseCandidates = await (deps.retireReleaseCandidates || (await import('./branchReconcileReleaseCandidates.js')).retireMergedReleaseCandidates)(app, result, deps);
  retired.push(...releaseCandidates.retired);
  held.push(...releaseCandidates.held);
  return { held, retired };
}
