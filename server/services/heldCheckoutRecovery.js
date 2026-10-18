/**
 * Operator-scoped retirement of a merged checkout that branch reconciliation
 * reported but cannot retire on its own (#12002): one outside the managed
 * worktree roots, or one behind a `git worktree lock`.
 *
 * Authority is a scoped release, never an inference. The operator names the
 * exact inventory row they saw — checkout path, HEAD, branch and lock state —
 * and that release only applies while a fresh read of the repository still
 * matches it. A lock's age, an absent process or its prose never establish
 * release: a changed lock, HEAD or branch is an ownership change and refuses.
 *
 * Before any mutation every unique byte is archived under
 * `data/cos/held-checkout-archives/`: commits not on the default branch, the
 * tracked diff, and verbatim copies of untracked AND ignored files (symlinks as
 * recorded targets). The archive is verified by hash against the checkout, and
 * the checkout's content fingerprint must not move between archive and
 * removal. A live owner, manual completion handoff, unreadable state or archive
 * failure leaves the checkout, its lock and its branch exactly as found.
 */

import { lstat, readlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { atomicWrite, copyFileGuarded, ensureDir, PATHS, rmGuarded, sha256File, writeFileGuarded } from '../lib/fileUtils.js';
import { execGit } from '../lib/execGit.js';
import { PROTECTED_BRANCHES } from '../lib/gitArgs.js';
import { claimCheckoutOwnerReason } from '../lib/claimContinuation.js';
import { backupSlug } from './supersededBackup.js';
import { listWorktrees, forceRemoveWorktreeDir } from './worktreeManager.js';
import { getDefaultBranch, hasBranchMergeEvidence, deleteBranch } from './git.js';
import { withClaimOwnershipLock, readClaimOwnershipAgents } from './cosClaimOwnership.js';

export const heldCheckoutArchiveRoot = (cosDir = PATHS.cos) => join(cosDir, 'held-checkout-archives');

// Refuse rather than archive a subset: a partial archive followed by removal
// would delete the rest. Larger than the superseded reap's caps because this is
// an explicit operator action, but still bounded so a build tree cannot fill
// the disk.
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 250 * 1024 * 1024;
const GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

const shortBranch = (ref) => (ref ? String(ref).replace(/^refs\/heads\//, '') : null);
const zLines = (stdout) => (stdout || '').split('\0').filter(Boolean);
const git = (args, cwd) => execGit(args, cwd, { maxBuffer: GIT_OUTPUT_BYTES }).then(r => r.stdout || '');

/** Untracked and ignored paths, excluding nothing but Git's own metadata. */
const otherPaths = async (path) => zLines(await git(['ls-files', '--others', '-z'], path));

/**
 * One hash over everything the archive preserves, so a write that lands after
 * the archive (or during it) is detected before removal.
 */
async function contentFingerprint(path) {
  const hash = createHash('sha256');
  hash.update(await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none'], path));
  hash.update('\0diff\0');
  hash.update(await git(['diff', 'HEAD', '--binary'], path));
  for (const rel of await otherPaths(path)) {
    const info = await lstat(join(path, rel));
    hash.update(`\0${rel}\0${info.size}\0${info.mtimeMs}\0${info.isSymbolicLink()}`);
  }
  return hash.digest('hex');
}

/**
 * Write and verify the archive. Throws on anything that would leave it
 * incomplete; the caller then retires nothing.
 */
async function archiveCheckout(input) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(heldCheckoutArchiveRoot(input.cosDir), `${backupSlug(input.branch || `detached-${input.tree.head}`)}-${stamp}`);
  // An incomplete archive must not read as a restore point.
  return writeArchive(dir, input).catch(async (error) => {
    await rmGuarded(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  });
}

async function writeArchive(dir, { repoPath, tree, branch, defaultBranch, release }) {
  const fingerprint = await contentFingerprint(tree.path);
  await ensureDir(dir);

  const commits = await git(['format-patch', `${defaultBranch}..${tree.head}`, '--stdout', '--binary'], repoPath);
  if (commits.trim()) await writeFileGuarded(join(dir, 'commits.patch'), commits);
  const diff = await git(['diff', 'HEAD', '--binary'], tree.path);
  if (diff.trim()) await writeFileGuarded(join(dir, 'worktree.diff'), diff);

  const files = [];
  const symlinks = [];
  let total = 0;
  for (const rel of await otherPaths(tree.path)) {
    // `ls-files --others` names a nested repository as `dir/` without its files.
    if (rel.endsWith('/')) throw new Error(`nested repository at ${rel} cannot be archived`);
    const source = join(tree.path, rel);
    const info = await lstat(source);
    if (info.isSymbolicLink()) {
      symlinks.push({ path: rel, target: await readlink(source) });
      continue;
    }
    if (!info.isFile()) throw new Error(`${rel} is not a regular file`);
    total += info.size;
    if (info.size > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) throw new Error(`${rel} exceeds the archive size limit`);
    const destination = join(dir, 'files', rel);
    await ensureDir(dirname(destination));
    await copyFileGuarded(source, destination);
    const [expected, actual] = await Promise.all([sha256File(source), sha256File(destination)]);
    if (expected !== actual) throw new Error(`archived copy of ${rel} does not match`);
    files.push({ path: rel, bytes: info.size, sha256: actual });
  }
  if (await contentFingerprint(tree.path) !== fingerprint) throw new Error('checkout content changed while archiving');

  await atomicWrite(join(dir, 'manifest.json'), {
    repoPath, defaultBranch, path: tree.path, head: tree.head, branch,
    release, archivedAt: new Date().toISOString(),
    captured: { commitsPatch: Boolean(commits.trim()), worktreeDiff: Boolean(diff.trim()), files, symlinks },
    restore: [
      `git -C <repo> worktree add <checkout> ${tree.head}`,
      diff.trim() ? 'git -C <checkout> apply worktree.diff' : null,
      files.length ? 'cp -R files/. <checkout>/' : null,
      symlinks.length ? 'recreate manifest.captured.symlinks with ln -s' : null,
    ].filter(Boolean),
  });
  return { dir, fingerprint };
}

const isAncestor = (repoPath, sha, ref) => execGit(['merge-base', '--is-ancestor', sha, ref], repoPath, { ignoreExitCode: true })
  .then(r => r.exitCode === 0, () => false);

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
  const live = resolveLiveOwnerReason({ branch, path: tree.path, locked: false, activeAgentIds: buildActiveOwnerIds(getActiveAgentIds(), agents) });
  if (live) return live;
  if (!branch) return null;
  const { readBranchCompletionHold } = await import('./branchCompletionPolicy.js');
  return readBranchCompletionHold({ repoPath, branch, retirement: true }).catch(() => 'pr-completion-policy-unavailable');
}

/** Fresh registration that still matches the release, or the reason it does not. */
async function matchRelease(repoPath, release) {
  const trees = await listWorktrees(repoPath).catch(() => null);
  if (!trees?.length) return { reason: 'worktree-ownership-unreadable' };
  const index = trees.findIndex(tree => tree.path === release.path);
  if (index === -1) return { reason: 'checkout-not-found' };
  const tree = trees[index];
  if (index === 0 || tree.bare) return { reason: 'checkout-primary' };
  if (tree.prunable) return { reason: 'worktree-prunable' };
  if (tree.head !== release.head) return { reason: 'checkout-head-changed' };
  if (shortBranch(tree.branch) !== (release.branch ?? null)) return { reason: 'checkout-branch-changed' };
  if (Boolean(tree.locked) !== release.locked || (tree.lockReason ?? null) !== (release.lockReason ?? null)) {
    return { reason: 'checkout-lock-changed' };
  }
  return { tree };
}

/**
 * Archive and retire one held checkout under an operator's scoped release.
 *
 * @param {{ repoPath: string, release: { path: string, head: string, branch: string|null, locked: boolean, lockReason: string|null } }} input
 * @param {{ cosDir?: string, readAgents?: () => Promise<object[]|null> }} [opts]
 * @returns {Promise<{ ok: true, archiveDir: string, branchDeleted: boolean, branchRetainedReason?: string } | { ok: false, reason: string, detail?: string, archiveDir?: string }>}
 */
async function retireHeldCheckout({ repoPath, release }, { cosDir = PATHS.cos, readAgents = readClaimOwnershipAgents } = {}) {
  const branch = release.branch ?? null;
  if (branch && PROTECTED_BRANCHES.includes(branch)) return { ok: false, reason: 'protected-branch' };
  const defaultBranch = await getDefaultBranch(repoPath, { allowRemote: false, strict: true }).catch(() => null);
  if (!defaultBranch) return { ok: false, reason: 'default-branch-unavailable' };
  if (branch === defaultBranch) return { ok: false, reason: 'protected-branch' };

  return withClaimOwnershipLock(async () => {
    const first = await matchRelease(repoPath, release);
    if (!first.tree) return { ok: false, reason: first.reason };
    const { tree } = first;
    const merged = branch
      ? await hasBranchMergeEvidence(repoPath, branch, defaultBranch).catch(() => false)
      : await isAncestor(repoPath, tree.head, defaultBranch);
    if (!merged) return { ok: false, reason: 'not-merged-on-recheck' };
    const owner = await ownerReason({ repoPath, tree, branch, readAgents });
    if (owner) return { ok: false, reason: owner };

    const archive = await archiveCheckout({ repoPath, tree, branch, defaultBranch, release, cosDir })
      .catch(error => ({ error }));
    if (archive.error) {
      console.error(`❌ held-checkout recovery: archive failed for ${tree.path}, checkout kept: ${archive.error.message}`);
      return { ok: false, reason: 'archive-failed', detail: archive.error.message };
    }

    // Archiving takes time; never unlock a lock that changed hands meanwhile.
    const second = await matchRelease(repoPath, release);
    if (!second.tree) return { ok: false, reason: second.reason, archiveDir: archive.dir };
    if (release.locked) {
      const unlocked = await execGit(['worktree', 'unlock', tree.path], repoPath).then(() => true, () => false);
      if (!unlocked) return { ok: false, reason: 'worktree-unlock-failed', archiveDir: archive.dir };
    }
    const verifyRemoval = async (holder) => {
      if (!holder || holder.head !== tree.head || shortBranch(holder.branch) !== branch) return 'worktree-holder-changed';
      const reason = await ownerReason({ repoPath, tree, branch, readAgents });
      if (reason) return reason;
      return await contentFingerprint(tree.path).catch(() => null) === archive.fingerprint ? null : 'checkout-content-changed';
    };
    const removal = await forceRemoveWorktreeDir(repoPath, tree.path, {
      label: '🧹 held-checkout recovery: remove checkout', log: 'all', verifyRemoval,
    });
    if (!removal.removed) {
      // Hand the lock back exactly as released. A lock someone took in the
      // meantime makes this fail, which is the outcome we want anyway.
      if (release.locked) {
        const args = ['worktree', 'lock', ...(release.lockReason != null ? ['--reason', release.lockReason] : []), tree.path];
        await execGit(args, repoPath).catch(err => console.warn(`⚠️ held-checkout recovery: could not restore lock on ${tree.path}: ${err.message}`));
      }
      return { ok: false, reason: removal.reason || 'worktree-remove-failed', archiveDir: archive.dir };
    }
    console.log(`🧹 held-checkout recovery: retired ${tree.path} (archive: ${archive.dir})`);
    if (!branch) return { ok: true, archiveDir: archive.dir, branchDeleted: false };

    const hold = await ownerReason({ repoPath, tree: { ...tree, path: null }, branch, readAgents });
    if (hold) return { ok: true, archiveDir: archive.dir, branchDeleted: false, branchRetainedReason: hold };
    const deleted = await deleteBranch(repoPath, branch, { local: true }).catch(err => ({ error: err.message }));
    const failure = deleted?.error || (deleted?.results?.local?.startsWith?.('failed') ? deleted.results.local : null);
    if (failure) return { ok: true, archiveDir: archive.dir, branchDeleted: false, branchRetainedReason: `delete-failed: ${failure}` };
    return { ok: true, archiveDir: archive.dir, branchDeleted: true };
  });
}

const sameRelease = (entry, release) => entry.path === release.path && entry.head === release.head
  && (entry.branch ?? null) === (release.branch ?? null) && Boolean(entry.locked) === release.locked
  && (entry.lockReason ?? null) === (release.lockReason ?? null);

/**
 * The Schedule view's entry point: the release must name a row of the app's
 * last persisted inventory exactly, so it binds to evidence the operator saw.
 */
export async function retireInventoriedCheckout({ appId, release }, opts) {
  const [{ getAppById }, taskSchedule] = await Promise.all([import('./apps.js'), import('./taskSchedule.js')]);
  const app = await getAppById(appId);
  if (!app?.repoPath) return { ok: false, reason: 'app-not-found' };
  const outcome = await taskSchedule.getBranchReconcileOutcome(appId);
  if (!outcome?.remaining?.some?.(entry => sameRelease(entry, release))) return { ok: false, reason: 'release-not-in-inventory' };
  const result = await retireHeldCheckout({ repoPath: app.repoPath, release }, opts);
  if (result.ok) {
    await taskSchedule.recordHeldCheckoutRetirement(appId, {
      path: release.path, branch: release.branch ?? null, head: release.head, branchDeleted: result.branchDeleted, archiveDir: result.archiveDir,
    });
  }
  return result;
}
