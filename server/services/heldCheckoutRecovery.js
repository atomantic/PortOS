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
 * `data/cos/held-checkout-archives/`: a standalone bundle of the original commit history, the staged and unstaged diffs, raw bytes of tracked files that differ
 * from their index blob, and verbatim copies of untracked AND ignored files
 * (symlinks as recorded targets). The archive is verified by hash against the
 * checkout, and the checkout's content hashes must not move between archive and
 * removal. A live owner, manual completion handoff, unreadable state or archive
 * failure leaves the checkout, its lock and its branch exactly as found.
 */

import { createReadStream } from 'node:fs';
import { lstat, readlink, readdir, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { atomicWrite, copyFileGuarded, ensureDir, PATHS, rmGuarded, sha256File, writeFileGuarded } from '../lib/fileUtils.js';
import { execGit } from '../lib/execGit.js';
import { PROTECTED_BRANCHES } from '../lib/gitArgs.js';
import { claimCheckoutOwnerReason } from '../lib/claimContinuation.js';
import { backupSlug } from './supersededBackup.js';
import { listWorktrees, forceRemoveWorktreeDir } from './worktreeManager.js';
import { getDefaultBranch, hasBranchMergeEvidence } from './git.js';
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

/** Preserve worktree-private Git evidence, never follow its links into the
 * common repository. The lock is archived but matched separately by release.
 */
async function snapshotAdministration(path) {
  const root = (await git(['rev-parse', '--absolute-git-dir'], path)).trim();
  const files = [];
  const symlinks = [];
  let bytes = 0;
  const visit = async (source, rel) => {
    const info = await lstat(source);
    if (info.isSymbolicLink()) { symlinks.push({ path: rel, target: await readlink(source) }); return; }
    if (info.isDirectory()) {
      for (const name of (await readdir(source)).sort()) await visit(join(source, name), rel ? `${rel}/${name}` : name);
      return;
    }
    if (!info.isFile() || info.size > MAX_FILE_BYTES || (bytes += info.size) > MAX_TOTAL_BYTES) throw new Error('administration cannot be archived');
    files.push({ path: rel, source, bytes: info.size, sha256: await sha256File(source) });
  };
  await visit(root, 'gitdir');
  const pointer = join(path, '.git');
  if (!(await lstat(pointer)).isFile()) throw new Error('checkout git indirection is not a file');
  await visit(pointer, 'git-indirection');
  const fingerprint = createHash('sha256').update(JSON.stringify({
    files: files.filter(file => file.path !== 'gitdir/locked').map(({ source: _source, ...file }) => file), symlinks,
  })).digest('hex');
  return { files, symlinks, fingerprint };
}

async function retirementPolicy(repoPath, branch, opts) {
  const { readBranchCompletionPolicies, reviewedRetirementPolicy, mergedReceiptRetirementPolicy } = await import('./branchCompletionPolicy.js');
  const policies = await (opts.readPolicies || (() => readBranchCompletionPolicies({ repairIndex: false })))().catch(() => null);
  if (opts.mergedReceipt) return mergedReceiptRetirementPolicy({ repoPath, branch, agents: policies,
    tip: opts.mergedReceipt.expectedHeadSha });
  return reviewedRetirementPolicy({ repoPath, branch, agents: policies });
}

async function reviewCurrentCheckout({ repoPath, release, prUrl, unlocked = false }, opts = {}) {
  if (!release.branch || PROTECTED_BRANCHES.includes(release.branch)) return { ok: false, reason: 'protected-branch' };
  const matched = await matchRelease(repoPath, unlocked ? { ...release, locked: false, lockReason: null } : release);
  if (!matched.tree) return { ok: false, reason: matched.reason };
  const owner = await ownerReason({ repoPath, tree: matched.tree, branch: release.branch,
    readAgents: opts.readAgents || readClaimOwnershipAgents, reviewed: true });
  if (owner) return { ok: false, reason: owner };
  const policy = await retirementPolicy(repoPath, release.branch, opts);
  if (policy.reason) return { ok: false, reason: policy.reason };
  const { buildCheckoutRetirementReview } = await import('./heldCheckoutReview.js');
  return Promise.all([snapshotContent(release.path), snapshotAdministration(release.path)])
    .then(([content, administration]) => buildCheckoutRetirementReview({ repoPath, release, prUrl,
      contentFingerprint: content.fingerprint, administrationFingerprint: administration.fingerprint, policy }, opts))
    .then(review => ({ ok: true, review }), error => ({ ok: false,
      reason: /^retirement-[a-z-]+$/.test(error.message) ? error.message : 'retirement-local-evidence-unavailable' }));
}

/** Read-only, host-control-gated review of exactly one current inventory row. */
export async function prepareInventoriedCheckoutRetirement({ appId, release, prUrl }, opts = {}) {
  const [{ getAppById }, { getBranchReconcileOutcome }] = await Promise.all([import('./apps.js'), import('./taskSchedule.js')]);
  const app = await getAppById(appId);
  if (!app?.repoPath) return { ok: false, reason: 'app-not-found' };
  const outcome = await getBranchReconcileOutcome(appId);
  if (!outcome?.remaining?.some(entry => sameRelease(entry, release))) return { ok: false, reason: 'release-not-in-inventory' };
  return withClaimOwnershipLock(() => reviewCurrentCheckout({ repoPath: app.repoPath, release, prUrl }, { ...opts, forgeAccount: app.forgeAccount ?? null }));
}

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
  // These reads are independent and each Git spawn is mostly launch latency, so
  // they run together; every destructive boundary re-reads this snapshot anyway.
  const [unmerged, stageOut, tagged, indexDiff, worktreeDiff, objectFormat, others] = await Promise.all([
    git(['ls-files', '-u', '-z'], path),
    git(['ls-files', '--stage', '-z'], path),
    git(['ls-files', '-v', '-z'], path),
    // A textconv or external diff driver can drop bytes from a patch.
    git(['diff', '--cached', '--binary', '--no-textconv', '--no-ext-diff'], path),
    git(['diff', '--binary', '--no-textconv', '--no-ext-diff'], path),
    git(['rev-parse', '--show-object-format'], path),
    git(['ls-files', '--others', '-z'], path),
  ]);
  if (unmerged.length) throw new Error('unmerged index entries cannot be archived');
  const stage = zLines(stageOut);
  const gitlinks = [];
  for (const line of stage.filter(row => row.startsWith('160000 '))) {
    const tab = line.indexOf('\t');
    const header = line.slice(0, tab);
    const rel = line.slice(tab + 1);
    const info = await lstat(join(path, rel)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info && (!info.isDirectory() || (await readdir(join(path, rel))).length)) throw new Error('retirement-submodule-not-uninitialized');
    gitlinks.push({ path: rel, commit: header.split(' ')[1], state: info ? 'empty' : 'missing' });
  }
  // Assume-unchanged (lowercase tag) and skip-worktree (S) entries hide edits from diff.
  const hidden = zLines(tagged).find(line => /^[a-zS]/.test(line));
  if (hidden) throw new Error(`${hidden.slice(2)} hides working-tree changes from Git`);

  const files = [];
  let total = 0;
  const addFile = async (rel, info, extra = {}) => {
    total += info.size;
    if (info.size > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) throw new Error(`${rel} exceeds the archive size limit`);
    files.push({ path: rel, bytes: info.size, sha256: await sha256File(join(path, rel)), ...extra });
  };
  const format = objectFormat.trim() || 'sha1';
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
  for (const rel of zLines(others)) {
    // `ls-files --others` names a nested repository as `dir/` without its files.
    if (rel.endsWith('/')) throw new Error(`nested repository at ${rel} cannot be archived`);
    const info = await lstat(join(path, rel));
    if (info.isSymbolicLink()) symlinks.push({ path: rel, target: await readlink(join(path, rel)) });
    else if (info.isFile()) await addFile(rel, info);
    else throw new Error(`${rel} is not a regular file`);
  }
  const fingerprint = createHash('sha256').update(indexDiff).update('\0').update(worktreeDiff).update('\0')
    .update(JSON.stringify({ files, symlinks, gitlinks })).digest('hex');
  return { indexDiff, worktreeDiff, files, symlinks, gitlinks, fingerprint };
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

async function writeArchive(dir, { repoPath, tree, branch, defaultBranch, release, review }) {
  const [snapshot, administration] = await Promise.all([snapshotContent(tree.path), snapshotAdministration(tree.path)]);
  await ensureDir(dir);
  await chmod(dir, 0o700);

  // A bundle keeps the original commit objects, merges included, which a
  // squash-merged branch would otherwise lose to garbage collection.
  const bundle = join(dir, 'commits.bundle');
  await git(['bundle', 'create', bundle, 'HEAD'], tree.path);
  const [, heads] = await Promise.all([git(['bundle', 'verify', bundle], repoPath), git(['bundle', 'list-heads', bundle], repoPath)]);
  if (!heads.startsWith(`${tree.head} `)) throw new Error('bundle head mismatch');
  await chmod(bundle, 0o600);
  for (const file of administration.files) {
    const destination = join(dir, 'administration', file.path);
    await ensureDir(dirname(destination));
    await copyFileGuarded(file.source, destination);
    await chmod(destination, 0o600);
    if (await sha256File(destination) !== file.sha256) throw new Error('administration archive mismatch');
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
  // Re-read after every copy so the check covers the whole archive window.
  const [after, administrationAfter] = await Promise.all([snapshotContent(tree.path), snapshotAdministration(tree.path)]);
  if (administrationAfter.fingerprint !== administration.fingerprint) throw new Error('administration changed while archiving');
  if (after.fingerprint !== snapshot.fingerprint) throw new Error('checkout content changed while archiving');

  await atomicWrite(join(dir, 'manifest.json'), {
    repoPath, defaultBranch, path: tree.path, head: tree.head, branch,
    release, review, administration: { ...administration, files: administration.files.map(({ source: _source, ...file }) => file) }, archivedAt: new Date().toISOString(),
    captured: { commitBundle: true, gitlinks: snapshot.gitlinks, indexDiff: Boolean(snapshot.indexDiff), worktreeDiff: Boolean(snapshot.worktreeDiff), files, symlinks },
    restore: [
      'git -C <repo> fetch commits.bundle HEAD:refs/heads/<restored-branch>',
      `git -C <repo> worktree add <checkout> ${tree.head}`,
      snapshot.indexDiff ? 'git -C <checkout> apply --index index.diff' : null,
      snapshot.worktreeDiff ? 'git -C <checkout> apply worktree.diff' : null,
      // Last, so raw tracked bytes replace the filtered form the diffs restore.
      files.length ? 'cp -R files/. <checkout>/' : null,
      symlinks.length ? 'recreate manifest.captured.symlinks with ln -s' : null,
    ].filter(Boolean),
  });
  await chmod(join(dir, 'manifest.json'), 0o600);
  return { dir, fingerprint: snapshot.fingerprint, administrationFingerprint: administration.fingerprint };
}

const isAncestor = (repoPath, sha, ref) => execGit(['merge-base', '--is-ancestor', sha, ref], repoPath, { ignoreExitCode: true })
  .then(r => r.exitCode === 0, () => false);

async function ownerReason({ repoPath, tree, branch, readAgents, reviewed = false }) {
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
  if (!branch || reviewed) return null;
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
async function retireHeldCheckout({ repoPath, release, review }, opts = {}) {
  const { cosDir = PATHS.cos, readAgents = readClaimOwnershipAgents } = opts;
  const branch = release.branch ?? null;
  if (branch && PROTECTED_BRANCHES.includes(branch)) return { ok: false, reason: 'protected-branch' };
  const defaultBranch = await getDefaultBranch(repoPath, { allowRemote: false, strict: true }).catch(() => null);
  if (!defaultBranch) return { ok: false, reason: 'default-branch-unavailable' };
  if (branch === defaultBranch) return { ok: false, reason: 'protected-branch' };

  return withClaimOwnershipLock(async () => {
    if (opts.inventoryCurrent && !await opts.inventoryCurrent()) return { ok: false, reason: 'release-not-in-inventory' };
    const first = await matchRelease(repoPath, release);
    if (!first.tree) return { ok: false, reason: first.reason };
    const { tree } = first;
    const merged = branch
      ? await hasBranchMergeEvidence(repoPath, branch, defaultBranch).catch(() => false)
      : await isAncestor(repoPath, tree.head, defaultBranch);
    if (!merged && !review) return { ok: false, reason: 'not-merged-on-recheck' };
    const reviewed = review ? await reviewCurrentCheckout({ repoPath, release, prUrl: review.prUrl }, opts) : null;
    if (reviewed && (!reviewed.ok || reviewed.review.digest !== review.digest)) return { ok: false, reason: reviewed.reason || 'retirement-review-changed' };
    if (reviewed?.review.comparison.disposition === 'review-supersession' && review.acceptSuperseded !== true) return { ok: false, reason: 'retirement-supersession-not-accepted' };
    const owner = await ownerReason({ repoPath, tree, branch, readAgents, reviewed: Boolean(review) });
    if (owner) return { ok: false, reason: owner };

    const archive = await archiveCheckout({ repoPath, tree, branch, defaultBranch, release, cosDir, review: reviewed?.review })
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
      if (opts.inventoryCurrent && !await opts.inventoryCurrent()) return 'release-not-in-inventory';
      const [reason, fresh] = await Promise.all([
        ownerReason({ repoPath, tree, branch, readAgents, reviewed: Boolean(review) }),
        review ? reviewCurrentCheckout({ repoPath, release, prUrl: review.prUrl, unlocked: release.locked }, opts) : null,
      ]);
      if (fresh && (!fresh.ok || fresh.review.digest !== review.digest)) return fresh.reason || 'retirement-review-changed';
      // The byte comparisons stay last so nothing else ages between them and removal.
      const [administration, current] = await Promise.all([snapshotAdministration(tree.path), snapshotContent(tree.path).catch(() => null)]);
      if (administration.fingerprint !== archive.administrationFingerprint) return 'checkout-administration-changed';
      if (reason) return reason;
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

    const hold = await ownerReason({ repoPath, tree: { ...tree, path: null }, branch, readAgents, reviewed: Boolean(review) });
    if (hold) return { ok: true, archiveDir: archive.dir, branchDeleted: false, branchRetainedReason: hold };
    if (review) {
      const { readRetirementForgeEvidence } = await import('./heldCheckoutReview.js');
      const policy = await retirementPolicy(repoPath, branch, opts);
      const forge = await (opts.readForge || readRetirementForgeEvidence)(repoPath, branch, review.prUrl, { forgeAccount: opts.forgeAccount }).catch(() => null);
      if (JSON.stringify(policy) !== JSON.stringify(reviewed.review.policy) || JSON.stringify(forge) !== JSON.stringify(reviewed.review.forge)) {
        return { ok: true, archiveDir: archive.dir, branchDeleted: false, branchRetainedReason: 'retirement-evidence-changed' };
      }
    }
    // A new checkout/commit cannot be deleted by a stale name-only operation.
    const holders = await listWorktrees(repoPath).catch(() => null);
    if (!holders || holders.some(holder => shortBranch(holder.branch) === branch)) return { ok: true, archiveDir: archive.dir, branchDeleted: false, branchRetainedReason: 'branch-has-new-holder' };
    const deleted = await execGit(['update-ref', '-d', `refs/heads/${branch}`, release.head], repoPath, { ignoreExitCode: true }).catch(() => null);
    if (!deleted || deleted.exitCode !== 0) return { ok: true, archiveDir: archive.dir, branchDeleted: false, branchRetainedReason: 'branch-ref-changed-or-delete-failed' };
    return { ok: true, archiveDir: archive.dir, branchDeleted: true };
  });
}

const sameRelease = (entry, release) => entry.path === release.path && entry.head === release.head
  && (entry.branch ?? null) === (release.branch ?? null) && Boolean(entry.locked) === release.locked
  && (entry.lockReason ?? null) === (release.lockReason ?? null);

// Only the automatic receipt path may acquire missing proof objects. Fetch
// exact server-verified commits into the object store, never a branch or index.
async function fetchReceiptProofObjects(repoPath, release, prUrl, expectedHeadSha, opts) {
  const [{ readRetirementForgeEvidence }, { getOriginInfo }, { resolveForgeExecOptions }] = await Promise.all([
    import('./heldCheckoutReview.js'), import('../lib/gitRemote.js'), import('./forgeExecOptions.js'),
  ]);
  const forge = await (opts.readForge || readRetirementForgeEvidence)(repoPath, release.branch, prUrl, opts).catch(() => null);
  const origin = await getOriginInfo(repoPath).catch(() => null);
  if (!origin || !forge || forge.repository !== `${origin.host}/${origin.fullName}` || forge.prUrl !== prUrl) {
    return { ok: false, reason: 'retirement-pr-repository-mismatch' };
  }
  if (forge.prHead !== expectedHeadSha) return { ok: false, reason: 'receipt-pr-head-changed' };
  const heads = [...new Set([forge.prHead, forge.mergeCommit, forge.defaultHead, forge.changeBase, forge.firstCommit])];
  if (heads.some(head => typeof head !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head))) {
    return { ok: false, reason: 'retirement-forge-unreadable' };
  }
  const missing = [];
  for (const head of heads) {
    if (!await execGit(['cat-file', '-e', `${head}^{commit}`], repoPath).then(() => true, () => false)) missing.push(head);
  }
  if (!missing.length) return { ok: true };
  const { env } = await resolveForgeExecOptions(repoPath, { forgeAccount: opts.forgeAccount });
  const fetched = await execGit(['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
    '-c', 'core.askPass=', 'fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules',
    '--no-auto-maintenance', '--refmap=', '--', `https://${origin.host}/${origin.fullName}.git`, ...missing], repoPath, {
    timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GH_PROMPT_DISABLED: '1' },
  }).then(() => true, () => false);
  return fetched ? { ok: true } : { ok: false, reason: 'retirement-proof-fetch-failed' };
}

/** Finish only the checkout named by a trusted pending-merge receipt. Unlike an
 * operator release, this never unlocks a checkout or accepts supersession. Fresh
 * forge evidence must independently prove the exact handed-off head merged and
 * remains integrated. Initialized submodules stay held for explicit recovery.
 */
export async function retirePendingMergeCheckout({ repoPath, release, prUrl, expectedHeadSha }, opts = {}) {
  if (!release || release.locked !== false || release.lockReason !== null) return { ok: false, reason: 'receipt-checkout-locked' };
  if (!release.path || !release.branch || typeof expectedHeadSha !== 'string'
    || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(expectedHeadSha) || release.head !== expectedHeadSha) {
    return { ok: false, reason: 'receipt-checkout-head-unverified' };
  }
  const receiptOptions = { ...opts, mergedReceipt: { expectedHeadSha } };
  let prepared = await reviewCurrentCheckout({ repoPath, release, prUrl }, receiptOptions);
  // The read-only preview has already passed identity, ownership, manual policy
  // and archival feasibility gates. Missing remote merge objects are recoverable
  // here without requiring an unrelated repo-sync to advance local branches.
  if (prepared.reason === 'retirement-local-objects-missing') {
    const fetched = await fetchReceiptProofObjects(repoPath, release, prUrl, expectedHeadSha, receiptOptions);
    if (!fetched.ok) return fetched;
    prepared = await reviewCurrentCheckout({ repoPath, release, prUrl }, receiptOptions);
  }
  if (!prepared.ok) return prepared;
  if (prepared.review.forge.prHead !== expectedHeadSha) return { ok: false, reason: 'receipt-pr-head-changed' };
  if (prepared.review.comparison.disposition !== 'integrated') return { ok: false, reason: 'retirement-supersession-not-accepted' };
  return retireHeldCheckout({ repoPath, release,
    review: { prUrl, digest: prepared.review.digest, acceptSuperseded: false },
  }, receiptOptions);
}

/**
 * The Schedule view's entry point: the release must name a row of the app's
 * last persisted inventory exactly, so it binds to evidence the operator saw.
 */
export async function retireInventoriedCheckout({ appId, release, review }, opts) {
  const [{ getAppById }, taskSchedule] = await Promise.all([import('./apps.js'), import('./taskSchedule.js')]);
  const app = await getAppById(appId);
  if (!app?.repoPath) return { ok: false, reason: 'app-not-found' };
  const outcome = await taskSchedule.getBranchReconcileOutcome(appId);
  if (!outcome?.remaining?.some?.(entry => sameRelease(entry, release))) return { ok: false, reason: 'release-not-in-inventory' };
  const inventoryCurrent = async () => (await taskSchedule.getBranchReconcileOutcome(appId))?.remaining?.some(entry => sameRelease(entry, release)) === true;
  const result = await retireHeldCheckout({ repoPath: app.repoPath, release, review }, { ...opts, inventoryCurrent, forgeAccount: app.forgeAccount ?? null });
  if (result.ok) {
    await taskSchedule.recordHeldCheckoutRetirement(appId, {
      path: release.path, branch: release.branch ?? null, head: release.head, branchDeleted: result.branchDeleted, archiveDir: result.archiveDir,
    });
  }
  return result;
}
