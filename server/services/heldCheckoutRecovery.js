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
 * `data/cos/held-checkout-archives/`: a bundle of commits not on the default
 * branch, the staged and unstaged diffs, raw bytes of tracked files that differ
 * from their index blob, and verbatim copies of untracked AND ignored files
 * (symlinks as recorded targets). The archive is verified by hash against the
 * checkout, and the checkout's content hashes must not move between archive and
 * removal. A live owner, manual completion handoff, unreadable state or archive
 * failure leaves the checkout, its lock and its branch exactly as found.
 */

import { createReadStream } from 'node:fs';
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

/** Git's object id for raw bytes, with no clean filter or line-ending conversion. */
async function rawBlobId(source, size, format) {
  const hash = createHash(format).update(`blob ${size}\0`);
  for await (const chunk of createReadStream(source)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * Everything the archive must preserve, read in one pass: the staged and
 * unstaged diffs (separately, so a staged blob whose working copy is gone
 * survives), raw copies of tracked files whose bytes differ from their index
 * blob (a clean filter or line-ending conversion hides those from diff), and
 * every untracked or ignored file by content hash, symlinks by target. Throws
 * on anything that cannot be archived faithfully, before any copy is made.
 * The fingerprint is compared again immediately before removal.
 */
async function snapshotContent(path) {
  if ((await git(['ls-files', '-u', '-z'], path)).length) throw new Error('unmerged index entries cannot be archived');
  const stage = zLines(await git(['ls-files', '--stage', '-z'], path));
  // A submodule's files and commits live in its own repository; its gitlink is not its content.
  if (stage.some(line => line.startsWith('160000 '))) throw new Error('submodules cannot be archived');
  // Assume-unchanged (lowercase tag) and skip-worktree (S) entries hide edits from diff.
  const hidden = zLines(await git(['ls-files', '-v', '-z'], path)).find(line => /^[a-zS]/.test(line));
  if (hidden) throw new Error(`${hidden.slice(2)} hides working-tree changes from Git`);
  // A textconv or external diff driver can drop bytes from a patch.
  const indexDiff = await git(['diff', '--cached', '--binary', '--no-textconv', '--no-ext-diff'], path);
  const worktreeDiff = await git(['diff', '--binary', '--no-textconv', '--no-ext-diff'], path);

  const files = [];
  let total = 0;
  const addFile = async (rel, info, extra = {}) => {
    total += info.size;
    if (info.size > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) throw new Error(`${rel} exceeds the archive size limit`);
    files.push({ path: rel, bytes: info.size, sha256: await sha256File(join(path, rel)), ...extra });
  };
  const format = (await git(['rev-parse', '--show-object-format'], path)).trim() || 'sha1';
  for (const line of stage) {
    const tab = line.indexOf('\t');
    const [mode, blob] = line.slice(0, tab).split(' ');
    const rel = line.slice(tab + 1);
    // Symlink blobs are not filtered; deletions and type changes are in the diff.
    if (mode !== '100644' && mode !== '100755') continue;
    const info = await lstat(join(path, rel)).catch(err => (err.code === 'ENOENT' ? null : Promise.reject(err)));
    if (!info?.isFile()) continue;
    if (await rawBlobId(join(path, rel), info.size, format) !== blob) await addFile(rel, info, { tracked: true });
  }
  const symlinks = [];
  for (const rel of zLines(await git(['ls-files', '--others', '-z'], path))) {
    // `ls-files --others` names a nested repository as `dir/` without its files.
    if (rel.endsWith('/')) throw new Error(`nested repository at ${rel} cannot be archived`);
    const info = await lstat(join(path, rel));
    if (info.isSymbolicLink()) symlinks.push({ path: rel, target: await readlink(join(path, rel)) });
    else if (info.isFile()) await addFile(rel, info);
    else throw new Error(`${rel} is not a regular file`);
  }
  const fingerprint = createHash('sha256').update(indexDiff).update('\0').update(worktreeDiff).update('\0')
    .update(JSON.stringify({ files, symlinks })).digest('hex');
  return { indexDiff, worktreeDiff, files, symlinks, fingerprint };
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
  const snapshot = await snapshotContent(tree.path);
  await ensureDir(dir);

  // A bundle keeps the original commit objects, merges included, which a
  // squash-merged branch would otherwise lose to garbage collection.
  const unique = Number((await git(['rev-list', '--count', `${defaultBranch}..${tree.head}`], repoPath)).trim());
  if (!Number.isInteger(unique)) throw new Error('could not count commits outside the default branch');
  const bundle = join(dir, 'commits.bundle');
  if (unique > 0) {
    await git(['bundle', 'create', bundle, 'HEAD', `^${defaultBranch}`], tree.path);
    await git(['bundle', 'verify', bundle], repoPath);
    const heads = await git(['bundle', 'list-heads', bundle], repoPath);
    if (!heads.startsWith(`${tree.head} `)) throw new Error('commit bundle does not hold the checkout HEAD');
  }
  if (snapshot.indexDiff) await writeFileGuarded(join(dir, 'index.diff'), snapshot.indexDiff);
  if (snapshot.worktreeDiff) await writeFileGuarded(join(dir, 'worktree.diff'), snapshot.worktreeDiff);

  const { files, symlinks } = snapshot;
  for (const file of files) {
    const destination = join(dir, 'files', file.path);
    await ensureDir(dirname(destination));
    await copyFileGuarded(join(tree.path, file.path), destination);
    if (await sha256File(destination) !== file.sha256) throw new Error(`archived copy of ${file.path} does not match`);
  }
  if ((await snapshotContent(tree.path)).fingerprint !== snapshot.fingerprint) throw new Error('checkout content changed while archiving');

  await atomicWrite(join(dir, 'manifest.json'), {
    repoPath, defaultBranch, path: tree.path, head: tree.head, branch,
    release, archivedAt: new Date().toISOString(),
    captured: { commitBundle: unique > 0, indexDiff: Boolean(snapshot.indexDiff), worktreeDiff: Boolean(snapshot.worktreeDiff), files, symlinks },
    restore: [
      unique > 0 ? 'git -C <repo> fetch commits.bundle HEAD:refs/heads/<restored-branch>' : null,
      `git -C <repo> worktree add <checkout> ${tree.head}`,
      snapshot.indexDiff ? 'git -C <checkout> apply --index index.diff' : null,
      snapshot.worktreeDiff ? 'git -C <checkout> apply worktree.diff' : null,
      // Last, so raw tracked bytes replace the filtered form the diffs restore.
      files.length ? 'cp -R files/. <checkout>/' : null,
      symlinks.length ? 'recreate manifest.captured.symlinks with ln -s' : null,
    ].filter(Boolean),
  });
  return { dir, fingerprint: snapshot.fingerprint };
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
      const current = await snapshotContent(tree.path).catch(() => null);
      return current?.fingerprint === archive.fingerprint ? null : 'checkout-content-changed';
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
