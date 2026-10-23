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

import { findGoneInventoryRows } from './branchReconcileInventoryPrune.js';
import { createReadStream, realpathSync } from 'node:fs';
import { lstat, stat, readlink, readdir, readFile, chmod, open, mkdtemp } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve, relative, sep } from 'node:path';
import { sameRetirementCheckout, unresolvedRetirements } from '../lib/reconcileRetirementEvidence.js';
import { atomicWrite, copyFileGuarded, ensureDir, PATHS, rmGuarded, sha256File, writeFileGuarded } from '../lib/fileUtils.js';
import { execGit } from '../lib/execGit.js';
import { PROTECTED_BRANCHES } from '../lib/gitArgs.js';
import { claimCheckoutOwnerReason } from '../lib/claimContinuation.js';
import { backupSlug } from './supersededBackup.js';
import { listWorktrees, forceRemoveWorktreeDir, deleteCompletedLocalBranch } from './worktreeManager.js';
import { getDefaultBranch, hasBranchMergeEvidence } from './git.js';
import { withClaimOwnershipLock, readClaimOwnershipAgents, retireWithUnlockedArchive } from './cosClaimOwnership.js';

export const heldCheckoutArchiveRoot = (cosDir = PATHS.cos) => join(cosDir, 'held-checkout-archives');

const evidenceHash = value => createHash('sha256').update(value).digest('hex');
const historicalNextAction = 'Locate a complete archive for this exact historical checkout and retry branch reconciliation; if none exists, recover the original data from backup. Checkout or ref absence is not preservation evidence.';

/** Never follow an archive link, including an intermediate directory link. */
async function archiveFile(root, path) {
  const rel = relative(root, path);
  if (!rel || isAbsolute(rel) || rel.split(sep).includes('..')) throw new Error('archive-path-invalid');
  const parts = rel.split(sep);
  let current = root;
  if (!(await lstat(root)).isDirectory()) throw new Error('archive-directory-invalid');
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) throw new Error('archive-file-invalid');
  }
  return path;
}

async function archiveManifest(dir) {
  const path = await archiveFile(dir, join(dir, 'manifest.json'));
  if ((await lstat(path)).size > 16 * 1024 * 1024) throw new Error('archive-manifest-budget-exceeded');
  const bytes = await readFile(path);
  return { manifest: JSON.parse(bytes), digest: evidenceHash(bytes) };
}

/** Reuses the archive's recorded byte hashes and administration fingerprint.
 * Older dirty archives lack patch hashes and cannot prove completeness later.
 */
async function verifyHeldArchive(repoPath, dir, release) {
  const { manifest: saved, digest } = await archiveManifest(dir);
  if (saved.repoPath !== repoPath || !sameRetirementCheckout(saved, release)
    || (saved.release ? !sameRelease(saved.release, release) : release.locked !== false || release.lockReason !== null)) throw new Error('archive-identity-mismatch');
  if (!(Date.parse(saved.archivedAt) >= Date.parse(release.createdAt)) || Date.parse(saved.archivedAt) > Date.now()) throw new Error('archive-generation-mismatch');
  const captured = saved.captured;
  if (captured?.commitBundle !== true || captured.missingCheckout || !Array.isArray(captured.files)
    || !Array.isArray(captured.symlinks) || !Array.isArray(captured.gitlinks)
    || !Array.isArray(saved.administration?.files) || !Array.isArray(saved.administration?.symlinks)
    || !saved.administration.files.some(file => file.path === 'gitdir/HEAD')
    || !saved.administration.files.some(file => file.path === 'git-indirection')) throw new Error('archive-preservation-incomplete');
  if (captured.files.length + saved.administration.files.length > 1000) throw new Error('archive-file-budget-exceeded');
  const stamps = [];
  const stamp = async path => {
    const info = await lstat(path, { bigint: true });
    if (!info.isFile()) throw new Error('archive-file-invalid');
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String).join(':');
  };
  const remember = async path => { stamps.push([path, await stamp(path)]); };
  await remember(join(dir, 'manifest.json'));
  let total = 0;
  for (const [prefix, files] of [['files', captured.files], ['administration', saved.administration.files]]) {
    for (const file of files) {
      if (typeof file.path !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256 || '')) throw new Error('archive-file-proof-invalid');
      const path = await archiveFile(dir, join(dir, prefix, file.path));
      await remember(path);
      const info = await lstat(path);
      if (info.size !== file.bytes || info.size > MAX_FILE_BYTES || (total += info.size) > MAX_TOTAL_BYTES
        || await sha256File(path) !== file.sha256) throw new Error('archive-file-changed');
    }
  }
  const administrationFingerprint = evidenceHash(JSON.stringify({
    files: saved.administration.files.filter(file => file.path !== 'gitdir/locked'), symlinks: saved.administration.symlinks,
  }));
  if (administrationFingerprint !== saved.administration.fingerprint) throw new Error('archive-administration-changed');
  for (const name of ['index', 'worktree']) {
    if (typeof captured[`${name}Diff`] !== 'boolean') throw new Error('archive-patch-proof-invalid');
    if (!captured[`${name}Diff`]) continue;
    const expected = saved.patchHashes?.[name];
    if (!/^[a-f0-9]{64}$/.test(expected || '')) throw new Error('archive-patch-proof-unavailable');
    const path = await archiveFile(dir, join(dir, `${name}.diff`));
    await remember(path);
    if (await sha256File(path) !== expected) throw new Error('archive-patch-changed');
  }
  const bundle = await archiveFile(dir, join(dir, 'commits.bundle'));
  await remember(bundle);
  // A thin bundle verifies against the current repository but is not a complete
  // restore point. Inspect only its bounded textual header, never fetch it.
  const handle = await open(bundle, 'r');
  let header;
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    header = buffer.subarray(0, bytesRead).toString('latin1').split('\n\n')[0];
    if (!buffer.subarray(0, bytesRead).includes(Buffer.from('\n\n')) || /^-/m.test(header)) throw new Error('archive-bundle-incomplete');
  } finally { await handle.close(); }
  await git(['bundle', 'verify', bundle], repoPath);
  const heads = new Set((await git(['bundle', 'list-heads', bundle], repoPath)).trim().split('\n').map(line => line.split(' ')[0]));
  if (!Array.isArray(captured.recoveryHeads) || !captured.recoveryHeads.includes(release.head)
    || captured.recoveryHeads.some(head => !heads.has(head))) throw new Error('archive-bundle-head-mismatch');
  const bundleHash = await sha256File(bundle);
  if (saved.bundleSha256 && bundleHash !== saved.bundleSha256) throw new Error('archive-bundle-changed');
  // Bundle verify/list-heads validate headers, not packed object integrity. Prove
  // the complete closure without borrowing any object from the live repository.
  const scratch = await mkdtemp(join(tmpdir(), 'portos-retirement-proof-'));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' };
  const prove = args => execGit(['--no-optional-locks', '-c', `core.hooksPath=${devNull}`, '-c', 'core.fsmonitor=false', ...args], scratch,
    { env, maxBuffer: GIT_OUTPUT_BYTES });
  try {
    await prove(['init', '--bare', `--object-format=${release.head.length === 64 ? 'sha256' : 'sha1'}`, '.']);
    await prove(['bundle', 'unbundle', bundle]);
    await prove(['fsck', '--full', '--strict', '--no-reflogs', '--no-dangling', ...captured.recoveryHeads]);
  } catch { throw new Error('archive-bundle-object-proof-failed'); }
  finally { await rmGuarded(scratch, { recursive: true, force: true }); }
  if ((await archiveManifest(dir)).digest !== digest) throw new Error('archive-manifest-changed');
  const recheck = async () => {
    for (const [path, original] of stamps) {
      if (await stamp(await archiveFile(dir, path)) !== original) return false;
    }
    return true;
  };
  if (!await recheck()) throw new Error('archive-changed-during-verification');
  return { repoPath, archiveDir: dir, archivedAt: saved.archivedAt, evidenceDigest: evidenceHash(digest + bundleHash), kind: 'held', recheck };
}

async function historicalCheckoutAbsent(release, trees) {
  const present = await lstat(release.path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  return !present && trees.length > 0 && !trees.some(tree => tree.path === release.path || (release.branch && shortBranch(tree.branch) === release.branch));
}

/** Completion audits have a server-captured checkout generation, but may never
 * have entered the scheduled retirement queue. Reuse its archive verifier
 * without creating an obligation or inventing a branch-deletion receipt.
 */
export async function findMissingCheckoutPreservation({ repoPath, release }, opts = {}) {
  if (!Number.isFinite(Date.parse(release?.createdAt)) || Date.parse(release.createdAt) > Date.now()
    || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(release?.head || '')) return null;
  const absent = async () => {
    const trees = await listWorktrees(repoPath);
    const ref = await execGit(['rev-parse', '--verify', '--quiet', `refs/heads/${release.branch}`], repoPath, { ignoreExitCode: true });
    return ref.exitCode === 1 && await historicalCheckoutAbsent(release, trees);
  };
  if (!await absent()) return null;
  const root = heldCheckoutArchiveRoot(opts.cosDir);
  const info = await lstat(root).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info?.isDirectory()) return null;
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.length > 1000) return null;
  let selected = null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const proof = await verifyHeldArchive(repoPath, join(root, entry.name), release).catch(() => null);
    if (!proof) continue;
    // Multiple valid snapshots cannot identify the original private contents.
    if (selected) return null;
    selected = proof;
  }
  if (!selected) return null;
  const proof = selected;
  return { ...proof, recheck: async () => await absent() && await proof.recheck() };
}

/** Read existing archives only. Verification stays outside both writer locks;
 * the final ownership/absence recheck and schedule compare-and-set are fenced.
 */
export async function recoverMissingCheckoutPreservations({ appId, repoPath, outcome }, opts = {}) {
  const expected = structuredClone(outcome);
  const obligations = unresolvedRetirements(expected);
  if (!obligations.length) return outcome;
  const trees = await listWorktrees(repoPath).catch(() => null);
  if (!trees?.length) return outcome;
  const roots = [heldCheckoutArchiveRoot(opts.cosDir), join(opts.cosDir || PATHS.cos, 'initialized-checkout-retirements')];
  const candidates = [];
  let discoveryReason = null;
  for (const root of roots) {
    try {
      const info = await lstat(root).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!info) continue;
      if (!info.isDirectory()) throw new Error('archive-directory-invalid');
      const names = await readdir(root, { withFileTypes: true });
      if (names.length + candidates.length > 1000) throw new Error('archive-discovery-budget-exceeded');
      for (const name of names) if (name.isDirectory()) candidates.push({ dir: join(root, name.name), kind: root === roots[0] ? 'held' : 'initialized' });
    } catch { discoveryReason = 'archive-discovery-unavailable'; }
  }
  const observations = [];
  const evidenceFences = [];
  try {
    for (const release of obligations) {
      if (!await historicalCheckoutAbsent(release, trees).catch(() => false)) continue;
      const evidence = [];
      let proof = null;
      for (const candidate of candidates) {
        try {
          proof = candidate.kind === 'held' ? await verifyHeldArchive(repoPath, candidate.dir, release)
            : await (await import('./initializedCheckoutRecovery.js')).verifyMissingInitializedCheckoutPreservation({ appId, repoPath, release, archiveDir: candidate.dir });
          if (proof.releaseFence) evidenceFences.push(proof.releaseFence);
          evidence.push({ archiveDir: candidate.dir, reason: 'preservation-verified' });
          break;
        } catch (error) {
          evidence.push({ archiveDir: candidate.dir, reason: /^[a-z][a-z-]+$/.test(error.message) ? error.message : 'archive-unverifiable' });
        }
      }
      observations.push({ release, proof, evidence, reason: discoveryReason || (candidates.length ? 'archive-evidence-unverified' : 'archive-evidence-missing'), nextAction: historicalNextAction });
    }
    if (!observations.length) return outcome;
    const { recordRecoveredCheckoutPreservations } = await import('./taskSchedule.js');
    return await withClaimOwnershipLock(() => recordRecoveredCheckoutPreservations(appId, expected, observations, async () => {
      const { getAppById } = await import('./apps.js');
      if ((await getAppById(appId))?.repoPath !== repoPath) return false;
      const currentTrees = await listWorktrees(repoPath);
      for (const row of observations) {
        if (!await historicalCheckoutAbsent(row.release, currentTrees)) return false;
        if (row.proof?.recheck && !await row.proof.recheck().catch(() => false)) {
          row.evidence.push({ archiveDir: row.proof.archiveDir, reason: 'archive-changed-during-verification' });
          row.proof = null;
          row.reason = 'archive-changed-during-verification';
        }
      }
      return true;
    }));
  } finally {
    for (const releaseFence of evidenceFences) await releaseFence();
  }
}

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
async function snapshotAdministration(path, missingRoot = null) {
  const root = missingRoot || (await git(['rev-parse', '--absolute-git-dir'], path)).trim();
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
  if (!missingRoot) {
    if (!(await lstat(pointer)).isFile()) throw new Error('checkout git indirection is not a file');
    await visit(pointer, 'git-indirection');
  }
  const fingerprint = createHash('sha256').update(JSON.stringify({
    files: files.filter(file => file.path !== 'gitdir/locked').map(({ source: _source, ...file }) => file), symlinks,
  })).digest('hex');
  return { files, symlinks, fingerprint };
}

async function retirementPolicy(repoPath, branch, opts, reviewIdentity = {}) {
  const { readBranchCompletionPolicies, reviewedRetirementPolicy, mergedReceiptRetirementPolicy } = await import('./branchCompletionPolicy.js');
  const policies = await (opts.readPolicies || (() => readBranchCompletionPolicies({ repairIndex: false })))().catch(() => null);
  if (opts.mergedReceipt) return mergedReceiptRetirementPolicy({ repoPath, branch, agents: policies,
    tip: opts.mergedReceipt.expectedHeadSha });
  const checkoutIdentities = {};
  if (reviewIdentity.verifiedPrHead === reviewIdentity.tip && reviewIdentity.tip && Array.isArray(policies)) {
    const paths = new Set([reviewIdentity.checkoutPath, repoPath]);
    for (const agent of policies) {
      const meta = agent?.metadata || {};
      const scopes = [meta.worktreeBranch, meta.jiraBranch, meta.claimBranch, meta.branchCompletionPolicy?.branch,
        ...(Array.isArray(meta.claimBranches) ? meta.claimBranches : []),
        ...(Array.isArray(meta.claimReleasedBranches) ? meta.claimReleasedBranches : [])];
      if (scopes.includes(branch) && isAbsolute(meta.workspacePath || '')) paths.add(meta.workspacePath);
    }
    // A failed identity read or excessive history cannot prove distinctness.
    // Missing paths resolve through their existing canonical ancestor, the same
    // identity rule used to locate missing checkout administration below.
    if (paths.size <= 1000) {
      const entries = [...paths];
      for (let offset = 0; offset < entries.length; offset += 25) {
        await Promise.all(entries.slice(offset, offset + 25).map(async path => {
          const facts = await missingPathIdentity(path).catch(() => null);
          if (facts) checkoutIdentities[path] = JSON.stringify({ dev: facts.dev, ino: facts.ino, tail: facts.tail });
        }));
      }
    }
  }
  return reviewedRetirementPolicy({ repoPath, branch, agents: policies, ...reviewIdentity, checkoutIdentities });
}

const policyReviewIdentity = (release, prUrl, forge) => ({
  checkoutPath: release.path, tip: release.head, prUrl,
  verifiedPrHead: forge?.prUrl === prUrl ? forge.prHead : null,
});

async function reviewCurrentCheckout({ repoPath, release, prUrl, unlocked = false }, opts = {}) {
  if (!release.branch || PROTECTED_BRANCHES.includes(release.branch)) return { ok: false, reason: 'protected-branch' };
  const matched = await matchRelease(repoPath, unlocked ? { ...release, locked: false, lockReason: null } : release);
  if (!matched.tree) return { ok: false, reason: matched.reason };
  const owner = await ownerReason({ repoPath, tree: matched.tree, branch: release.branch,
    readAgents: opts.readAgents || readClaimOwnershipAgents, reviewed: true });
  if (owner) return { ok: false, reason: owner };
  const { buildCheckoutRetirementReview, readRetirementForgeEvidence } = await import('./heldCheckoutReview.js');
  const forge = await (opts.readForge || readRetirementForgeEvidence)(repoPath, release.branch, prUrl, { forgeAccount: opts.forgeAccount })
    .catch(error => ({ error }));
  if (forge?.error) return { ok: false, reason: /^retirement-[a-z-]+$/.test(forge.error.message) ? forge.error.message : 'retirement-forge-unavailable' };
  const policy = await retirementPolicy(repoPath, release.branch, opts, policyReviewIdentity(release, prUrl, forge));
  if (policy.reason) return { ok: false, reason: policy.reason };
  return Promise.all([snapshotContent(release.path), snapshotAdministration(release.path)])
    .then(([content, administration]) => buildCheckoutRetirementReview({ repoPath, release, prUrl,
      contentFingerprint: content.fingerprint, administrationFingerprint: administration.fingerprint, policy }, { ...opts, readForge: async () => forge }))
    .then(review => ({ ok: true, review }), error => ({ ok: false,
      reason: /^retirement-[a-z-]+$/.test(error.message) ? error.message : 'retirement-local-evidence-unavailable' }));
}

/** Host-control-gated preview of one inventory row; may fetch missing proof objects. */
export async function prepareInventoriedCheckoutRetirement({ appId, release, prUrl }, opts = {}) {
  const [{ getAppById }, { getBranchReconcileOutcome }] = await Promise.all([import('./apps.js'), import('./taskSchedule.js')]);
  const app = await getAppById(appId);
  if (!app?.repoPath) return { ok: false, reason: 'app-not-found' };
  const outcome = await getBranchReconcileOutcome(appId);
  if (!outcome?.remaining?.some(entry => sameRelease(entry, release))) return { ok: false, reason: 'release-not-in-inventory' };
  const reviewOptions = { ...opts, forgeAccount: app.forgeAccount ?? null };
  const review = () => withClaimOwnershipLock(() => reviewCurrentCheckout({ repoPath: app.repoPath, release, prUrl }, reviewOptions));
  let prepared = await review();
  if (prepared.reason === 'retirement-local-objects-missing') {
    // A remote default may advance while local refs stay put. Acquire only its
    // validated proof objects; then repeat every owner/policy/content check.
    const fetched = await fetchRetirementProofObjects(app.repoPath, release, prUrl, null, reviewOptions);
    if (!fetched.ok) return fetched;
    prepared = await review();
  }
  return prepared;
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
    // A textconv or external diff driver can drop bytes from a patch. Disable
    // diff's stat-cache refresh too: an otherwise read-only diff can rewrite
    // the index and race the concurrent administration snapshot. Git's
    // --no-optional-locks alone does not disable diff.autoRefreshIndex.
    git(['-c', 'diff.autoRefreshIndex=false', 'diff', '--cached', '--binary', '--no-textconv', '--no-ext-diff'], path),
    git(['-c', 'diff.autoRefreshIndex=false', 'diff', '--binary', '--no-textconv', '--no-ext-diff'], path),
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
  const dir = join(heldCheckoutArchiveRoot(input.cosDir), `${backupSlug(input.branch || `detached-${input.tree.head}`)}-${stamp}-${randomUUID()}`);
  // An incomplete archive must not read as a restore point.
  return writeArchive(dir, input).catch(async (error) => {
    await rmGuarded(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  });
}

// A missing tail has no filesystem identity yet. Match its exact spelling under
// the deepest existing directory's identity, so Git's expanded Windows 8.3
// names and directory aliases agree without case-folding nonexistent names.
async function missingPathIdentity(path) {
  let ancestor = resolve(path);
  const tail = [];
  for (;;) {
    const info = await lstat(ancestor).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info) {
      // Native realpath expands Windows short names; JavaScript realpath may
      // retain them. Existing dangling links/errors must hold, never walk past.
      const canonical = realpathSync.native(ancestor);
      const identity = await stat(canonical, { bigint: true });
      if ((!identity.isDirectory() && tail.length) || identity.ino === 0n) throw new Error('missing-checkout-ancestor-unverified');
      return { ancestor: canonical, dev: String(identity.dev), ino: String(identity.ino), tail };
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error('missing-checkout-ancestor-unverified');
    tail.unshift(basename(ancestor));
    ancestor = parent;
  }
}

// A vanished checkout can still own a staged index and private recovery files.
// Locate its exact registration without recreating the missing working tree.
async function missingCheckoutAdministration(repoPath, path) {
  const present = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (present) return null;
  const common = resolve(repoPath, (await git(['rev-parse', '--git-common-dir'], repoPath)).trim());
  const roots = [];
  const target = await missingPathIdentity(join(path, '.git'));
  const mismatches = [];
  for (const name of await readdir(join(common, 'worktrees'))) {
    const root = join(common, 'worktrees', name);
    if (!(await lstat(root)).isDirectory()) continue;
    const pointer = await readFile(join(root, 'gitdir'), 'utf8').catch(() => null);
    if (!pointer?.trim()) continue;
    const candidate = await missingPathIdentity(resolve(root, pointer.trim()));
    if (candidate.dev === target.dev && candidate.ino === target.ino && JSON.stringify(candidate.tail) === JSON.stringify(target.tail)) roots.push(root);
    else if (mismatches.length < 4) mismatches.push({ registration: name, pointer: pointer.trim().slice(0, 1024), identity: candidate });
  }
  if (roots.length !== 1) throw new Error(`missing-checkout-administration-unverified: ${JSON.stringify({ target, matches: roots.length, mismatches })}`);
  return roots[0];
}

async function archiveSnapshots(tree, repoPath, missingRoot) {
  if (!missingRoot) return Promise.all([snapshotContent(tree.path), snapshotAdministration(tree.path)]);
  const present = await lstat(tree.path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (present) throw new Error('missing-checkout-reappeared');
  const prefix = ['--git-dir', missingRoot, '--work-tree', tree.path];
  if ((await git([...prefix, 'ls-files', '-u', '-z'], repoPath)).length) throw new Error('unmerged index entries cannot be archived');
  const indexDiff = await git([...prefix, 'diff', '--cached', '--binary', '--no-textconv', '--no-ext-diff'], repoPath);
  const content = { indexDiff, worktreeDiff: '', files: [], symlinks: [], gitlinks: [], missingCheckout: true,
    fingerprint: createHash('sha256').update('missing-checkout\0').update(indexDiff).digest('hex') };
  return [content, await snapshotAdministration(tree.path, missingRoot)];
}

/** Preserve ignored content and recovery evidence before a clean merged tree
 * is removed. The caller owns the live ownership fence and merge proof; this
 * guard verifies that every preserved byte still matches immediately at removal.
 */
export async function preserveMergedCheckout(repoPath, tree, defaultBranch, { cosDir } = {}) {
  if (!tree?.head || (!tree.branch && tree.detached !== true) || tree.locked) throw new Error('checkout-identity-unavailable');
  const branch = shortBranch(tree.branch);
  const missingRoot = await missingCheckoutAdministration(repoPath, tree.path);
  const archive = await archiveCheckout({ repoPath, tree, branch, defaultBranch, cosDir, missingRoot });
  return {
    archiveDir: archive.dir,
    async verify(holder) {
      if (!holder || holder.head !== tree.head || holder.branch !== tree.branch || Boolean(holder.detached) !== Boolean(tree.detached)) return 'worktree-holder-changed';
      const [content, administration] = await archiveSnapshots(tree, repoPath, missingRoot);
      return content.fingerprint === archive.fingerprint && administration.fingerprint === archive.administrationFingerprint
        ? null : 'checkout-content-changed';
    },
  };
}

async function writeArchive(dir, { repoPath, tree, branch, defaultBranch, release, review, missingRoot = null }) {
  const [snapshot, administration] = await archiveSnapshots(tree, repoPath, missingRoot);
  // Sequencer state can contain abbreviated or external object references.
  // Keep that checkout for recovery instead of claiming a complete bundle.
  if (administration.files.some(file => /^gitdir\/(rebase-merge|rebase-apply|sequencer)\//.test(file.path))) {
    throw new Error('retirement-operation-active');
  }
  await ensureDir(dir);
  await chmod(dir, 0o700);

  // A bundle keeps the original commit objects, merges included, which a
  // squash-merged branch would otherwise lose to garbage collection.
  const bundle = join(dir, 'commits.bundle');
  // Private refs and operation files can name any Git object: ort's AUTO_MERGE
  // names a tree containing conflict-resolution evidence, not a commit.
  // Named bundle roots preserve their reachable objects too. Unknown/missing
  // recovery objects still hold the checkout.
  const recoveryHeads = new Set([tree.head]);
  for (const file of administration.files) {
    if (file.path === 'git-indirection' || /\/(index|gitdir|commondir|locked)$/.test(file.path)) continue;
    const contents = await readFile(file.source, 'utf8');
    for (const match of contents.matchAll(/(?<![a-f0-9])[a-f0-9]{40}(?:[a-f0-9]{24})?(?![a-f0-9])/gi)) {
      if (!/^0+$/.test(match[0])) recoveryHeads.add(match[0].toLowerCase());
    }
  }
  if (recoveryHeads.size > 1024) throw new Error('too many private recovery objects');
  const recoveryRefs = [];
  const namespace = `refs/portos/archive/${randomUUID()}`;
  try {
    for (const head of recoveryHeads) {
      const type = (await git(['cat-file', '-t', head], repoPath)).trim();
      if (!['commit', 'tree', 'blob', 'tag'].includes(type)) throw new Error('private recovery object has an unsupported type');
      const ref = `${namespace}/${head}`;
      await git(['update-ref', ref, head, ''], repoPath);
      recoveryRefs.push({ ref, head });
    }
    await git([...(missingRoot ? ['--git-dir', missingRoot, '--work-tree', tree.path] : []), 'bundle', 'create', bundle, 'HEAD', ...recoveryRefs.map(entry => entry.ref)], missingRoot ? repoPath : tree.path);
    const [, heads] = await Promise.all([git(['bundle', 'verify', bundle], repoPath), git(['bundle', 'list-heads', bundle], repoPath)]);
    const bundled = new Set(heads.trim().split('\n').map(line => line.split(' ')[0]));
    if ([...recoveryHeads].some(head => !bundled.has(head))) throw new Error('bundle recovery head mismatch');
  } finally {
    // These are private temporary refs, never branch refs. The checkout and its
    // original reflog remain intact unless the entire archive later verifies.
    for (const { ref, head } of recoveryRefs) await git(['update-ref', '-d', ref, head], repoPath);
  }
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
  const [after, administrationAfter] = await archiveSnapshots(tree, repoPath, missingRoot);
  if (administrationAfter.fingerprint !== administration.fingerprint) throw new Error('administration changed while archiving');
  if (after.fingerprint !== snapshot.fingerprint) throw new Error('checkout content changed while archiving');

  await atomicWrite(join(dir, 'manifest.json'), {
    repoPath, defaultBranch, path: tree.path, head: tree.head, branch,
    release, review, administration: { ...administration, files: administration.files.map(({ source: _source, ...file }) => file) }, archivedAt: new Date().toISOString(),
    bundleSha256: await sha256File(bundle),
    patchHashes: { index: evidenceHash(snapshot.indexDiff), worktree: evidenceHash(snapshot.worktreeDiff) },
    captured: { commitBundle: true, recoveryHeads: [...recoveryHeads], ...(snapshot.missingCheckout ? { missingCheckout: true } : {}), gitlinks: snapshot.gitlinks, indexDiff: Boolean(snapshot.indexDiff), worktreeDiff: Boolean(snapshot.worktreeDiff), files, symlinks },
    restore: [
      'git -C <repo> fetch commits.bundle HEAD:refs/heads/<restored-branch>',
      'git -C <repo> fetch commits.bundle "+refs/portos/archive/*:refs/portos/recovered/*"',
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

async function ownerReason({ repoPath, tree, branch, readAgents, reviewed = false, mergedObligationSettled = false }) {
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
  if (!branch || reviewed) return null;
  const { readBranchCompletionHold } = await import('./branchCompletionPolicy.js');
  const hold = await readBranchCompletionHold({ repoPath, branch, retirement: true }).catch(() => 'pr-completion-policy-unavailable');
  // A review obligation is moot once every commit is already on the default
  // branch (re-proven under the fence). Human handoffs and unreadable policy stay held.
  return mergedObligationSettled && hold === 'pr-completion-review-required' ? null : hold;
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

/** Shared live policy/owner check for the explicit whole-checkout transaction.
 * It does not archive, unlock or infer integration.
 */
export async function inspectCheckoutRetirementOwnership({ repoPath, release, registration = true }, opts = {}) {
  if (!release.branch || PROTECTED_BRANCHES.includes(release.branch)) return { ok: false, reason: 'protected-branch' };
  const matched = registration ? await matchRelease(repoPath, release) : { tree: release };
  if (!matched.tree) return { ok: false, reason: matched.reason };
  const reason = await ownerReason({ repoPath, tree: matched.tree, branch: release.branch,
    readAgents: opts.readAgents || readClaimOwnershipAgents, reviewed: true });
  if (reason) return { ok: false, reason };
  const policy = await retirementPolicy(repoPath, release.branch, opts);
  return policy.reason ? { ok: false, reason: policy.reason } : { ok: true, tree: matched.tree, policy };
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
  // Only the unattended merged-retirement caller sets this, and only without a review.
  const mergedObligationSettled = !review && opts.settleMergedReviewObligation === true;
  const branch = release.branch ?? null;
  if (branch && PROTECTED_BRANCHES.includes(branch)) return { ok: false, reason: 'protected-branch' };
  const defaultBranch = await getDefaultBranch(repoPath, { allowRemote: false, strict: true }).catch(() => null);
  if (!defaultBranch) return { ok: false, reason: 'default-branch-unavailable' };
  if (branch === defaultBranch) return { ok: false, reason: 'protected-branch' };

  // Every ownership check queues behind the claim-ownership lock with a short
  // budget, so the archive runs between two critical sections (#12682).
  const refuse = reason => ({ result: { ok: false, reason } });
  return retireWithUnlockedArchive({
    busy: () => ({ ok: false, reason: 'checkout-retirement-reserved' }),
    admit: async () => {
      if (opts.inventoryCurrent && !await opts.inventoryCurrent()) return refuse('release-not-in-inventory');
      await opts.beforeMutation?.();
      const first = await matchRelease(repoPath, release);
      if (!first.tree) return refuse(first.reason);
      const { tree } = first;
      const merged = branch
        ? await hasBranchMergeEvidence(repoPath, branch, defaultBranch).catch(() => false)
        : await isAncestor(repoPath, tree.head, defaultBranch);
      if (!merged && !review) return refuse('not-merged-on-recheck');
      const reviewed = review ? await reviewCurrentCheckout({ repoPath, release, prUrl: review.prUrl }, opts) : null;
      if (reviewed && (!reviewed.ok || reviewed.review.digest !== review.digest)) return refuse(reviewed.reason || 'retirement-review-changed');
      if (reviewed?.review.comparison.disposition === 'review-supersession' && review.acceptSuperseded !== true) return refuse('retirement-supersession-not-accepted');
      const owner = await ownerReason({ repoPath, tree, branch, readAgents, reviewed: Boolean(review), mergedObligationSettled });
      if (owner) return refuse(owner);
      return { fence: { repoPath, path: tree.path, branch }, tree, reviewed };
    },
    archive: async ({ tree, reviewed }) => {
      const archive = await archiveCheckout({ repoPath, tree, branch, defaultBranch, release, cosDir, review: reviewed?.review })
        .catch(error => ({ error }));
      if (!archive.error) return { archive };
      console.error(`❌ held-checkout recovery: archive failed for ${tree.path}, checkout kept: ${archive.error.message}`);
      return { result: { ok: false, reason: 'archive-failed', detail: archive.error.message } };
    },
    finish: ({ tree, reviewed }, archive) => finishHeldCheckoutRetirement({ repoPath, release, review, reviewed, tree, branch, archive, mergedObligationSettled }, opts),
  });
}

/** The second critical section: re-prove the release, ownership and archived bytes, then remove. */
async function finishHeldCheckoutRetirement({ repoPath, release, review, reviewed, tree, branch, archive, mergedObligationSettled = false }, opts) {
  const { readAgents = readClaimOwnershipAgents } = opts;
  // Archiving takes time; never unlock a lock that changed hands meanwhile.
  const second = await matchRelease(repoPath, release);
  if (!second.tree) return { ok: false, reason: second.reason, archiveDir: archive.dir };
  await opts.beforeMutation?.();
  if (release.locked) {
    const unlocked = await execGit(['worktree', 'unlock', tree.path], repoPath).then(() => true, () => false);
    if (!unlocked) return { ok: false, reason: 'worktree-unlock-failed', archiveDir: archive.dir };
  }
  const verifyRemoval = async (holder) => {
    if (!holder || holder.head !== tree.head || shortBranch(holder.branch) !== branch) return 'worktree-holder-changed';
    if (opts.inventoryCurrent && !await opts.inventoryCurrent()) return 'release-not-in-inventory';
    const [reason, fresh] = await Promise.all([
      ownerReason({ repoPath, tree, branch, readAgents, reviewed: Boolean(review), mergedObligationSettled }),
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
    label: '🧹 held-checkout recovery: remove checkout', log: 'all', verifyRemoval, beforeMutation: opts.beforeMutation,
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

  const hold = await ownerReason({ repoPath, tree: { ...tree, path: null }, branch, readAgents, reviewed: Boolean(review), mergedObligationSettled });
  if (hold) return { ok: true, archiveDir: archive.dir, branchDeleted: false, branchRetainedReason: hold };
  if (review) {
    const { readRetirementForgeEvidence } = await import('./heldCheckoutReview.js');
    const forge = await (opts.readForge || readRetirementForgeEvidence)(repoPath, branch, review.prUrl, { forgeAccount: opts.forgeAccount }).catch(() => null);
    const policy = await retirementPolicy(repoPath, branch, opts, policyReviewIdentity(release, review.prUrl, forge));
    if (JSON.stringify(policy) !== JSON.stringify(reviewed.review.policy) || JSON.stringify(forge) !== JSON.stringify(reviewed.review.forge)) {
      return { ok: true, archiveDir: archive.dir, branchDeleted: false, branchRetainedReason: 'retirement-evidence-changed' };
    }
  }
  // A new checkout/commit cannot be deleted by a stale name-only operation.
  const holders = await listWorktrees(repoPath).catch(() => null);
  if (!holders || holders.some(holder => shortBranch(holder.branch) === branch)) return { ok: true, archiveDir: archive.dir, branchDeleted: false, branchRetainedReason: 'branch-has-new-holder' };
  const deleted = await deleteCompletedLocalBranch(repoPath, branch, release.head, { beforeMutation: opts.beforeMutation });
  if (!deleted) return { ok: true, archiveDir: archive.dir, branchDeleted: false, branchRetainedReason: 'branch-ref-changed-or-delete-failed' };
  return { ok: true, archiveDir: archive.dir, branchDeleted: true };
}

const sameRelease = (entry, release) => entry.path === release.path && entry.head === release.head
  && (entry.branch ?? null) === (release.branch ?? null) && Boolean(entry.locked) === release.locked
  && (entry.lockReason ?? null) === (release.lockReason ?? null);

// Preview and receipt paths may acquire exact server-verified proof commits
// into the object store, never a branch, index or implicit approval.
export async function fetchRetirementProofObjects(repoPath, release, prUrl, expectedHeadSha, opts) {
  const [{ readRetirementForgeEvidence }, { getOriginInfo }, { resolveForgeExecOptions }] = await Promise.all([
    import('./heldCheckoutReview.js'), import('../lib/gitRemote.js'), import('./forgeExecOptions.js'),
  ]);
  const forge = await (opts.readForge || readRetirementForgeEvidence)(repoPath, release.branch, prUrl, opts).catch(() => null);
  const origin = await getOriginInfo(repoPath).catch(() => null);
  if (!origin || !forge || forge.repository !== `${origin.host}/${origin.fullName}` || forge.prUrl !== prUrl) {
    return { ok: false, reason: 'retirement-pr-repository-mismatch' };
  }
  if (expectedHeadSha !== null && forge.prHead !== expectedHeadSha) return { ok: false, reason: 'receipt-pr-head-changed' };
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
    const fetched = await fetchRetirementProofObjects(repoPath, release, prUrl, expectedHeadSha, receiptOptions);
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
  // A missing original cannot be archived retroactively. Retain its exact
  // identity for provenance recovery rather than equating absence with success.
  if (!result.ok && result.reason === 'checkout-not-found') {
    const gone = await findGoneInventoryRows(app.repoPath, [release]).catch(() => []);
    if (gone.length) {
      await taskSchedule.recordMissingInventoryRows(appId, gone);
      return { ok: false, reason: 'retirement-provenance-unverified' };
    }
  }
  if (result.ok) {
    await taskSchedule.recordHeldCheckoutRetirement(appId, {
      path: release.path, branch: release.branch ?? null, head: release.head, branchDeleted: result.branchDeleted, archiveDir: result.archiveDir,
    });
  }
  return result;
}
