import { readRetirementCheckoutIdentity } from '../lib/retirementCheckoutObservation.js';
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

import { readCheckoutPathPresence, readLocalBranchPresence } from './repoCleanupObservation.js';
import { realpathSync } from 'node:fs';
import { lstat, readlink, stat, symlink, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { execGit } from '../lib/execGit.js';
import { PROTECTED_BRANCHES } from '../lib/gitArgs.js';
import { claimCheckoutOwnerReason } from '../lib/claimContinuation.js';
import { listWorktrees, forceRemoveWorktreeDir, deleteCompletedLocalBranch, classifyWorktreeDirt } from './worktreeManager.js';
import { getDefaultBranch, getStatusPorcelain, hasBranchMergeEvidence, resolveForgeForRepo } from './git.js';
import { withClaimOwnershipLock, readClaimOwnershipAgents, retireWithUnlockedArchive } from './cosClaimOwnership.js';

const FULL_OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const shortBranch = (ref) => (ref ? String(ref).replace(/^refs\/heads\//, '') : null);
// Refusals the automatic daemon gate raises on purpose; any other throw is uncertain.
const AUTOMATIC_GATE_REASONS = new Set(['daemon-stopped', 'automatic-retirement-disabled']);

async function historicalCheckoutAbsent(release, trees) {
  const present = await lstat(release.path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  return !present && trees.length > 0 && !trees.some(tree => tree.path === release.path || (release.branch && shortBranch(tree.branch) === release.branch));
}

/** Physical cleanup is current absence, independently of execution success.
 * This observation cannot authorize deletion or manufacture a terminal head. */
export async function inspectAbsentCheckout({ repoPath, release }) {
  if (!release?.path || !release.branch) return null;
  const absent = async () => {
    const trees = await listWorktrees(repoPath);
    return await readCheckoutPathPresence(release.path) === false
      && await readLocalBranchPresence(repoPath, release.branch) === false
      && await historicalCheckoutAbsent(release, trees);
  };
  if (!await absent()) return null;
  return { kind: 'current-inventory', evidenceDigest: createHash('sha256')
    .update(JSON.stringify([repoPath, release.path, release.branch, release.head ?? null])).digest('hex'), recheck: absent };
}

/** Re-read daemon authority at each automatic mutation boundary. Manual API
 * callers keep their existing operator-authorized contract.
 */
export async function assertAutomaticRetirementAllowed() {
  const [{ isDaemonRunning, loadState }, { getDomainMode }] = await Promise.all([
    import('./cosState.js'), import('../lib/domainAutonomy.js'),
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
  if (ancestry && clean) return true;
  const delivery = await readForgeDelivery(repoPath, branch, head);
  if (delivery === 'exact') return true;
  if (delivery === null) return null;
  if (!ancestry && delivery === 'none') return false;
  // Merged work, but uncommitted files are only disposable at the exact head.
  return clean;
}

/** Why someone still owns this checkout or branch, or null. Callers reach this
 * only after proving the head merged, so a review-then-merge obligation is moot;
 * a human handoff and unreadable policy records still hold. */
async function ownerReason({ repoPath, tree, branch, readAgents }) {
  const agents = await readAgents().catch(() => null);
  if (!Array.isArray(agents)) return 'claim-ownership-unreadable';
  const claim = claimCheckoutOwnerReason({ branchName: branch || 'HEAD', holderPath: tree.path, sourceWorkspace: repoPath, agents });
  if (claim) return claim;
  const [{ buildActiveOwnerIds, resolveLiveOwnerReason }, { getActiveAgentIds }] = await Promise.all([
    import('./branchReconcile.js'), import('./agentState.js'),
  ]);
  // The released lock is excluded here on purpose: it was matched against the
  // release above, and a NEW lock is caught by the registration recheck.
  const live = resolveLiveOwnerReason({ branch, path: tree.path, locked: false, activeAgentIds: buildActiveOwnerIds(new Set(getActiveAgentIds()), agents) });
  if (live) return live;
  if (!branch) return null;
  const { readBranchCompletionHold } = await import('./branchCompletionPolicy.js');
  const hold = await readBranchCompletionHold({ repoPath, branch, retirement: true }).catch(() => 'pr-completion-policy-unavailable');
  return hold === 'pr-completion-review-required' ? null : hold;
}

/** Fresh registration that still matches the release, or the reason it does not. */
async function matchRelease(repoPath, release) {
  const trees = await listWorktrees(repoPath).catch(() => null);
  if (!trees?.length) return { reason: 'worktree-ownership-unreadable' };
  const index = trees.findIndex(tree => resolve(tree.path) === resolve(release.path));
  if (index === -1) return { reason: 'checkout-not-found' };
  const tree = trees[index];
  // Lexical equality alone can collapse '..' across a symlink. Different
  // spellings must also resolve to the same existing filesystem checkout.
  if (tree.path !== release.path) {
    try { if (realpathSync.native(tree.path) !== realpathSync.native(release.path)) return { reason: 'checkout-identity-changed' }; }
    catch { return { reason: 'checkout-identity-changed' }; }
  }
  if (index === 0 || tree.bare) return { reason: 'checkout-primary' };
  if (tree.prunable) return { reason: 'worktree-prunable' };
  if (tree.head !== release.head) return { reason: 'checkout-head-changed' };
  if (shortBranch(tree.branch) !== (release.branch ?? null)) return { reason: 'checkout-branch-changed' };
  if (Boolean(tree.locked) !== release.locked || (tree.lockReason ?? null) !== (release.lockReason ?? null)) {
    return { reason: 'checkout-lock-changed' };
  }
  // Carry the persisted release spelling through removal and its record.
  return { tree: { ...tree, path: release.path } };
}

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
 * @param {{ repoPath: string, release: { path: string, head: string, branch: string|null, locked: boolean, lockReason: string|null, checkoutIdentity?: string } }} input
 * @param {{ readAgents?: () => Promise<object[]|null>, beforeMutation?: () => Promise<void>, inventoryCurrent?: () => Promise<boolean>, delivery?: 'exact'|'contained' }} [opts]
 *   `delivery` is the readForgeDelivery answer the caller already read for `release.head`.
 * @returns {Promise<{ ok: true, branchDeleted: boolean, checkoutIdentity?: string, branchRetainedReason?: string } | { ok: false, reason: string }>}
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
  const refuse = reason => ({ result: { ok: false, reason } });
  // Every ownership check queues behind the claim-ownership lock with a short
  // budget, so removal runs in its own critical section (#12682).
  return retireWithUnlockedArchive({
    busy: () => ({ ok: false, reason: 'checkout-retirement-reserved' }),
    admit: async () => {
      if (opts.inventoryCurrent && !await opts.inventoryCurrent()) return refuse('release-not-in-inventory');
      await opts.beforeMutation?.();
      const first = await matchRelease(repoPath, release);
      if (!first.tree) return refuse(first.reason);
      const { tree } = first;
      const checkoutIdentity = await readRetirementCheckoutIdentity(tree.path);
      if (!checkoutIdentity || (release.checkoutIdentity && release.checkoutIdentity !== checkoutIdentity)) return refuse('checkout-identity-changed');
      if (!await isMergedHead(repoPath, tree.head, defaultBranch, deliveredHead)) return refuse('not-merged-on-recheck');
      const porcelain = await getStatusPorcelain(tree.path).catch(() => null);
      if (porcelain === null) return refuse('worktree-status-unavailable');
      if (!isDisposable(tree.head, porcelain, disposableHead)) return refuse('worktree-dirty');
      const owner = await ownerReason({ repoPath, tree, branch, readAgents });
      if (owner) return refuse(owner);
      return { fence: { repoPath, path: tree.path, branch }, tree, checkoutIdentity };
    },
    archive: async () => ({ archive: null }),
    finish: async ({ tree, checkoutIdentity }) => {
      const result = await finishHeldCheckoutRetirement({ repoPath, release, tree, branch, defaultBranch, checkoutIdentity, deliveredHead, disposableHead }, opts);
      return result.ok ? { ...result, checkoutIdentity } : result;
    },
  });
}

/** The second critical section: re-prove the release, ownership and content, then remove. */
async function finishHeldCheckoutRetirement({ repoPath, release, tree, branch, defaultBranch, checkoutIdentity, deliveredHead, disposableHead }, opts) {
  const { readAgents = readClaimOwnershipAgents } = opts;
  const second = await matchRelease(repoPath, release);
  if (!second.tree) return { ok: false, reason: second.reason };
  if (await readRetirementCheckoutIdentity(tree.path) !== checkoutIdentity) return { ok: false, reason: 'checkout-identity-changed' };
  await opts.beforeMutation?.();
  if (release.locked) {
    const unlocked = await execGit(['worktree', 'unlock', tree.path], repoPath).then(() => true, () => false);
    if (!unlocked) return { ok: false, reason: 'worktree-unlock-failed' };
  }
  const verifyRemoval = async (holder) => {
    if (!holder || holder.head !== tree.head || shortBranch(holder.branch) !== branch) return 'worktree-holder-changed';
    if (await readRetirementCheckoutIdentity(tree.path) !== checkoutIdentity) return 'checkout-identity-changed';
    if (opts.inventoryCurrent && !await opts.inventoryCurrent()) return 'release-not-in-inventory';
    const [porcelain, merged] = await Promise.all([
      getStatusPorcelain(tree.path).catch(() => null), isMergedHead(repoPath, tree.head, defaultBranch, deliveredHead),
    ]);
    if (porcelain === null || !isDisposable(tree.head, porcelain, disposableHead)) return 'worktree-dirty';
    if (!merged) return 'not-merged-on-recheck';
    return ownerReason({ repoPath, tree, branch, readAgents });
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
    // A refused removal may leave the original generation intact. Restore its
    // links without overwriting anything a concurrent writer created.
    const linkRestoreFailed = removedLinks.length > 0 && await readRetirementCheckoutIdentity(tree.path) === checkoutIdentity
      && !await restoreDirectoryLinks(tree.path, removedLinks);
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
  const hold = await ownerReason({ repoPath, tree: { ...tree, path: null }, branch, readAgents });
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
  && (entry.lockReason ?? null) === (release.lockReason ?? null)
  && (!release.checkoutIdentity || entry.checkoutIdentity === release.checkoutIdentity);

/** Tuple-only clients remain compatible; the persisted observation identity binds the checkout. */
function bindInventoriedRelease(outcome, release) {
  const entry = outcome?.remaining?.find(row => sameRelease(row, release));
  if (!entry) return null;
  return { path: release.path, head: release.head, branch: release.branch ?? null,
    locked: release.locked, lockReason: release.lockReason ?? null,
    ...(entry.checkoutIdentity && { checkoutIdentity: entry.checkoutIdentity }) };
}

/** Finish only the checkout named by a trusted pending-merge receipt. Unlike an
 * operator release, this never unlocks a checkout. Fresh forge evidence must
 * prove the receipt's own PR merged at exactly the handed-off head.
 */
export async function retirePendingMergeCheckout({ repoPath, release, prUrl, expectedHeadSha }, opts = {}) {
  if (!release || release.locked !== false || release.lockReason !== null) return { ok: false, reason: 'receipt-checkout-locked' };
  if (!release.path || !release.branch || typeof expectedHeadSha !== 'string'
    || !FULL_OBJECT_ID.test(expectedHeadSha) || release.head !== expectedHeadSha) {
    return { ok: false, reason: 'receipt-checkout-head-unverified' };
  }
  const { readMergedPrDelivery } = await import('./mergedPrEvidence.js');
  const forge = await readMergedPrDelivery(repoPath, release.branch, prUrl, { forgeAccount: opts.forgeAccount ?? null, exactDeliveredHead: expectedHeadSha })
    .catch(error => ({ error }));
  if (forge.error) return { ok: false, reason: /^merged-pr-[a-z-]+$/.test(forge.error.message) ? forge.error.message : 'receipt-pr-merge-unverified' };
  if (forge.prHead !== expectedHeadSha) return { ok: false, reason: 'receipt-pr-head-changed' };
  const result = await retireHeldCheckout({ repoPath, release }, { ...opts, delivery: 'exact' });
  if (result.ok) {
    const { recordWorkspaceCheckoutRetirement } = await import('./branchReconcileOutcome.js');
    await recordWorkspaceCheckoutRetirement(repoPath, {
      path: release.path, branch: release.branch, head: release.head,
      branchDeleted: result.branchDeleted, checkoutIdentity: result.checkoutIdentity,
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
      ...(!release.branch && { checkoutOnly: true }), checkoutIdentity: result.checkoutIdentity,
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
  // Every check re-reads live state; a failure throws its reason and keeps the ref.
  const recheck = async () => {
    await opts.beforeMutation?.();
    if (!(await getBranchReconcileOutcome(appId))?.remaining?.some(row => !row.path && row.branch === release.branch && row.head === release.head)) {
      throw new Error('release-not-in-inventory');
    }
    const defaultBranch = await getDefaultBranch(repoPath, { allowRemote: false, strict: true }).catch(() => null);
    if (!defaultBranch) throw new Error('default-branch-unavailable');
    if (release.branch === defaultBranch) throw new Error('protected-branch');
    const holders = await listWorktrees(repoPath).catch(() => null);
    if (!holders || holders.some(row => shortBranch(row.branch) === release.branch)) throw new Error('branch-has-new-holder');
    // show-ref exit 1 also covers broken symbolic and malformed loose refs, so
    // only the bounded files-backend inspection can establish actual absence.
    const presence = await readLocalBranchPresence(repoPath, release.branch);
    if (presence === null) throw new Error('branch-ref-presence-unverified');
    if (presence) {
      // Never treat a symbolic ref as the inventoried direct branch, even if its
      // target currently resolves to the same commit.
      const symbolic = await execGit(['symbolic-ref', '--quiet', ref], repoPath, { ignoreExitCode: true }).catch(() => null);
      if (symbolic?.exitCode !== 1) throw new Error('branch-ref-presence-unverified');
      const tip = await execGit(['rev-parse', '--verify', ref], repoPath).then(row => row.stdout.trim(), () => null);
      if (tip !== release.head) throw new Error('branch-ref-changed-or-recreated');
    }
    // An already-absent ref records retirement only on the forge's merged
    // delivery of that head, so an unexplained disappearance stays visible.
    const merged = delivered || (presence && await hasBranchMergeEvidence(repoPath, release.head, defaultBranch).catch(() => false));
    if (!merged) throw new Error('not-merged-on-recheck');
    const owner = await ownerReason({ repoPath, tree: { path: null }, branch: release.branch, readAgents: opts.readAgents || readClaimOwnershipAgents });
    if (owner) throw new Error(owner);
    return { missing: !presence };
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
    const release = { ...(tree.observedAt && { observedAt: tree.observedAt }), ...(tree.checkoutIdentity && { checkoutIdentity: tree.checkoutIdentity }),
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
