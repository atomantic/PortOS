import { matchingRetirementReceipts } from '../lib/reconcileRetirementEvidence.js';
import { readRetirementCheckoutIdentity } from '../lib/retirementCheckoutObservation.js';
import { WORKSPACE_TEST_CACHE_ROOTS } from '../lib/workspaceTestCacheRoots.js';
import { VITEST_CACHE_TAG, VITEST_MODULE_CACHE_ROOTS, moduleCacheName, moduleCacheMetadata } from '../lib/testCacheRetirementProof.js';
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
 * A merged, clean checkout is removed in place. Explicit preserved-supersession
 * review also admits a released published or private prototype after durable
 * bounded source and small-evidence preservation. Dirty, otherwise unmerged, protected, and live-owner checkouts stay. Retirement does not copy the
 * checkout, its ignored files, or its commit history.
 */

import { findGoneInventoryRows } from './branchReconcileInventoryPrune.js';
import { realpathSync, constants } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { lstat, stat, realpath, readlink, readdir, opendir, readFile, chmod, open, mkdtemp, unlink, symlink } from 'node:fs/promises';
import { tmpdir, devNull } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve, relative, sep } from 'node:path';
import { sameRetirementCheckout, unresolvedRetirements } from '../lib/reconcileRetirementEvidence.js';
import { atomicWrite, createWriteStreamGuarded, ensureDir, PATHS, rmGuarded, writeFileGuarded } from '../lib/fileUtils.js';
import { execGit } from '../lib/execGit.js';
import { PROTECTED_BRANCHES } from '../lib/gitArgs.js';
import { claimCheckoutOwnerReason } from '../lib/claimContinuation.js';
import { kebabCase } from '../lib/textUtils.js';
import { listWorktrees, forceRemoveWorktreeDir, deleteCompletedLocalBranch, classifyWorktreeDirt } from './worktreeManager.js';
import { getDefaultBranch, getStatusPorcelain, hasBranchMergeEvidence } from './git.js';
import { withClaimOwnershipLock, readClaimOwnershipAgents, retireWithUnlockedArchive } from './cosClaimOwnership.js';

/**
 * Branch name to a filesystem-safe, collision-free directory name. The hash
 * suffix is not decoration: `kebabCase` maps `feature/foo-bar` and
 * `feature/foo/bar` to the same slug.
 */
const backupSlug = (branch) => {
  const name = String(branch || '');
  return `${kebabCase(name) || 'branch'}-${createHash('sha256').update(name).digest('hex').slice(0, 8)}`;
};

export const heldCheckoutArchiveRoot = (cosDir = PATHS.cos) => join(cosDir, 'held-checkout-archives');

const evidenceHash = value => createHash('sha256').update(value).digest('hex');
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

function checkArchiveBudget(content, administration, allowDisposableCache = false) {
  // Historical creation/recovery share one byte budget across both snapshots.
  // Only current no-archive review can exempt independently recognized caches.
  let total = 0;
  for (const snapshot of [content, administration]) for (const file of snapshot.files) {
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error('archive-file-proof-invalid');
    if (allowDisposableCache && file.disposableCache === true) continue;
    checkArchiveSize('combined', file.bytes, total += file.bytes);
  }
  checkArchiveSize('combined', 0, total);
}
// Metadata is retained for exact fingerprints and final rechecks. Bound its
// encoded bytes as it is collected, including zero-byte files and links.
const ARCHIVE_WORK_MS = 10 * 60 * 1000;
function archiveWork(signal, started = performance.now()) {
  const usage = { metadata: 0, directory: 0 };
  const check = () => {
    if (signal?.aborted) throw new Error('retirement-archive-cancelled');
    const elapsed = Math.ceil(performance.now() - started);
    if (elapsed > ARCHIVE_WORK_MS) throw Object.assign(new Error('retirement-archive-work-limit-exceeded'), {
      archiveLimit: { scope: 'verification', kind: 'time', limitMs: ARCHIVE_WORK_MS, observedMs: elapsed },
    });
  };
  return { check, renew: () => archiveWork(signal), metadataScope: () => archiveWork(signal, started),
    add(value, scope = 'metadata') {
    check();
    usage[scope] += Buffer.byteLength(JSON.stringify(value));
    if (usage[scope] > MAX_MANIFEST_BYTES) throw Object.assign(new Error('archive-manifest-budget-exceeded'), {
      archiveLimit: { scope, kind: 'total', limitBytes: MAX_MANIFEST_BYTES, observedBytes: usage[scope] },
    });
  } };
}

async function archiveSource(path) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('archive-file-invalid');
    return { stream: handle.createReadStream({ highWaterMark: 64 * 1024 }), mode: info.mode & 0o7777 };
  } catch (error) { await handle.close(); throw error; }
}

async function archiveHash(path, work, limitBytes = MAX_FILE_BYTES) {
  work.check();
  let bytes = 0;
  const hash = createHash('sha256');
  const { stream } = await archiveSource(path);
  for await (const chunk of stream) {
    work.check();
    bytes += chunk.length;
    if (bytes > limitBytes) throw Object.assign(new Error('retirement-archive-limit-exceeded'), {
      archiveLimit: { scope: 'file-read', kind: 'file', limitBytes, observedBytes: bytes },
    });
    hash.update(chunk);
  }
  work.check();
  return hash.digest('hex');
}

async function archiveCopy(source, destination, expectedBytes, work) {
  let bytes = 0;
  const { stream: input, mode } = await archiveSource(source);
  let output;
  try { output = await createWriteStreamGuarded(destination, { flags: 'wx', mode: 0o600 }); }
  catch (error) { input.destroy(); throw error; }
  await pipeline(
    input,
    async function* (chunks) {
      for await (const chunk of chunks) {
        work.check();
        checkArchiveSize('file-copy', bytes += chunk.length, 0);
        if (bytes > expectedBytes) throw new Error('checkout-content-changed');
        yield chunk;
      }
      if (bytes !== expectedBytes) throw new Error('checkout-content-changed');
    },
    output,
  );
  await chmod(destination, mode);
}

function validateArchiveEntries(snapshot, work, accountMetadata = true) {
  const paths = new Set();
  for (const entries of [snapshot.files, snapshot.symlinks, snapshot.gitlinks || []]) for (const entry of entries) {
    if (accountMetadata) work.add(entry);
    else work.check();
    if (typeof entry.path !== 'string' || !entry.path || (sep === '\\' && entry.path.includes('\\')) || isAbsolute(entry.path)
      || entry.path.split('/').some(part => !part || part === '.' || part === '..') || paths.has(entry.path)) {
      throw new Error('archive-file-proof-invalid');
    }
    paths.add(entry.path);
  }
}

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

async function archiveBytes(path, work, limitBytes, reason = 'retirement-archive-limit-exceeded') {
  const chunks = [];
  let size = 0;
  const { stream } = await archiveSource(path);
  for await (const chunk of stream) {
    work.check();
    work.read?.(chunk.length);
    if ((size += chunk.length) > limitBytes) throw Object.assign(new Error(reason), {
      archiveLimit: { scope: 'metadata-read', kind: 'file', limitBytes, observedBytes: size },
    });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function archiveManifest(dir, work = archiveWork()) {
  const path = await archiveFile(dir, join(dir, 'manifest.json'));
  const bytes = await archiveBytes(path, work, MAX_MANIFEST_BYTES, 'archive-manifest-budget-exceeded');
  return { manifest: JSON.parse(bytes), digest: evidenceHash(bytes) };
}

/** Reuses recorded byte hashes and independently reconstructs the private index.
 * Older dirty archives without patch hashes cannot prove completeness later.
 */
async function verifyHeldArchive(repoPath, dir, release, work = archiveWork()) {
  work.check();
  const { manifest: saved, digest } = await archiveManifest(dir, work);
  if (saved.repoPath !== repoPath || !sameRetirementCheckout(saved, release)
    || (saved.release ? !sameRelease(saved.release, release) : release.locked !== false || release.lockReason !== null)) throw new Error('archive-identity-mismatch');
  if (!(Date.parse(saved.archivedAt) >= Date.parse(release.createdAt)) || Date.parse(saved.archivedAt) > Date.now()) throw new Error('archive-generation-mismatch');
  if (saved.resourceContract !== undefined && saved.resourceContract !== 1) throw new Error('archive-contract-unsupported');
  const captured = saved.captured;
  if (captured?.commitBundle !== true || captured.missingCheckout || !Array.isArray(captured.files)
    || !Array.isArray(captured.symlinks) || !Array.isArray(captured.gitlinks)
    || !Array.isArray(saved.administration?.files) || !Array.isArray(saved.administration?.symlinks)
    || !saved.administration.files.some(file => file.path === 'gitdir/HEAD')
    || !saved.administration.files.some(file => file.path === 'git-indirection')) throw new Error('archive-preservation-incomplete');
  validateArchiveEntries(captured, work);
  validateArchiveEntries(saved.administration, work);
  checkArchiveBudget(captured, saved.administration);
  const stamps = [];
  const stamp = async path => {
    const info = await lstat(path, { bigint: true });
    if (!info.isFile()) throw new Error('archive-file-invalid');
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String).join(':');
  };
  const remember = async path => { stamps.push([path, await stamp(path)]); };
  await remember(join(dir, 'manifest.json'));
  work.check();
  let total = 0;
  for (const [prefix, files] of [['files', captured.files], ['administration', saved.administration.files]]) {
    for (const file of files) {
      work.check();
      if (typeof file.path !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256 || '')) throw new Error('archive-file-proof-invalid');
      const path = await archiveFile(dir, join(dir, prefix, file.path));
      await remember(path);
      const info = await lstat(path);
      if (info.size !== file.bytes || info.size > MAX_FILE_BYTES || (total += info.size) > MAX_TOTAL_BYTES
        || await archiveHash(path, work) !== file.sha256) throw new Error('archive-file-changed');
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
    if (await archiveHash(path, work, MAX_PATCH_BYTES) !== expected) throw new Error('archive-patch-changed');
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
  work.check();
  await git(['bundle', 'verify', bundle], repoPath);
  work.check();
  const heads = new Set((await git(['bundle', 'list-heads', bundle], repoPath)).trim().split('\n').map(line => line.split(' ')[0]));
  if (!Array.isArray(captured.recoveryHeads) || !captured.recoveryHeads.includes(release.head)
    || captured.recoveryHeads.some(head => !heads.has(head))) throw new Error('archive-bundle-head-mismatch');
  const bundleHash = await archiveHash(bundle, work, Infinity);
  if (saved.bundleSha256 && bundleHash !== saved.bundleSha256) throw new Error('archive-bundle-changed');
  // Bundle verify/list-heads validate headers, not packed object integrity. Prove
  // the complete closure without borrowing any object from the live repository.
  const scratch = await mkdtemp(join(tmpdir(), 'portos-retirement-proof-'));
  // Git's null path also works on Windows; Node's device-namespace spelling
  // (\\.\nul) is not the Git configuration-file contract.
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' };
  const prove = (args, index = null) => {
    work.check();
    return execGit(['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], scratch,
      { env: { ...env, ...(index && { GIT_INDEX_FILE: join(scratch, index) }) }, maxBuffer: GIT_OUTPUT_BYTES });
  };
  try {
    try {
      await prove(['init', '--bare', `--object-format=${release.head.length === 64 ? 'sha256' : 'sha1'}`, '.']);
      await prove(['bundle', 'unbundle', bundle]);
      await prove(['fsck', '--full', '--strict', '--no-reflogs', '--no-dangling', ...captured.recoveryHeads]);
    } catch (error) {
      if (archiveLimitRefusal(error)) throw error;
      throw new Error('archive-bundle-object-proof-failed');
    }
    try {
      // Copy only validated index bytes into our own Git directory. Never run
      // Git against archived config, commondir, gitdir pointers or object stores.
      if (!saved.administration.files.some(file => file.path === 'gitdir/index')) throw new Error('missing archived index');
      for (const file of saved.administration.files.filter(file => file.path === 'gitdir/index'
        || /^gitdir\/sharedindex\.[a-f0-9]+$/.test(file.path))) {
        await archiveCopy(await archiveFile(dir, join(dir, 'administration', file.path)),
          join(scratch, file.path === 'gitdir/index' ? 'archived-index' : basename(file.path)), file.bytes, work);
      }
      // Quoted paths make this comparison ASCII and lossless even for opaque
      // filename bytes. --stage includes modes, object IDs and conflict stages.
      const entries = ['-c', 'core.quotePath=true', 'ls-files', '--stage'];
      const expected = await prove(entries, 'archived-index');
      await prove(['read-tree', release.head]);
      if (captured.indexDiff) await prove(['apply', '--cached', '--binary', join(dir, 'index.diff')]);
      const restored = await prove(entries);
      if (restored.stdout !== expected.stdout) throw new Error('index entries differ');
    } catch (error) {
      if (archiveLimitRefusal(error)) throw error;
      throw new Error('archive-index-reconstruction-failed');
    }
  } finally { await rmGuarded(scratch, { recursive: true, force: true }); }
  work.check();
  if ((await archiveManifest(dir, work)).digest !== digest) throw new Error('archive-manifest-changed');

  const recheck = async () => {
    const recheckWork = work.renew();
    for (const [path, original] of stamps) {
      recheckWork.check();
      if (await stamp(await archiveFile(dir, path)) !== original) return false;
    }
    return true;
  };
  if (!await recheck()) throw new Error('archive-changed-during-verification');
  return { repoPath, archiveDir: dir, archivedAt: saved.archivedAt, evidenceDigest: evidenceHash(digest + bundleHash), kind: 'held', recheck };
}

/** Inspect an existing service archive without creating or modifying one. The
 * retirement receipt supplies its generation and location; neither a path nor
 * an archive manifest alone grants ownership. */
export async function inspectLegacyReleaseArchive(repoPath, release, archiveDir, { cosDir, requireCurrent = false } = {}) {
  const root = resolve(heldCheckoutArchiveRoot(cosDir));
  const dir = resolve(archiveDir || '');
  const relativeDir = relative(root, dir);
  if (!relativeDir || isAbsolute(relativeDir) || relativeDir.includes(sep) || relativeDir === '..') throw new Error('legacy-archive-location-invalid');
  const proof = await verifyHeldArchive(repoPath, dir, release);
  const lifecyclePath = await archiveFile(dir, join(dir, 'administration/gitdir/portos-local-review-lifecycle')).catch(error => {
    if (error.code === 'ENOENT') throw Object.assign(new Error('legacy-review-lifecycle-unverified'), { code: 'legacy-review-lifecycle-unverified' });
    throw error;
  });
  const lifecycle = JSON.parse((await archiveBytes(lifecyclePath, archiveWork(), 64 * 1024)).toString('utf8'));
  const { manifest } = await archiveManifest(dir);
  const recheckCurrent = async () => {
    if (!await proof.recheck()) throw new Error('legacy-archive-changed');
    const [content, administration] = await archiveSnapshots({ path: release.path, branch: `refs/heads/${release.branch}`, head: release.head }, repoPath, null);
    if (administration.fingerprint !== manifest.administration.fingerprint
      || evidenceHash(content.indexDiff) !== manifest.patchHashes?.index || evidenceHash(content.worktreeDiff) !== manifest.patchHashes?.worktree
      || JSON.stringify(content.files) !== JSON.stringify(manifest.captured.files)
      || JSON.stringify(content.symlinks) !== JSON.stringify(manifest.captured.symlinks)
      || JSON.stringify(content.gitlinks) !== JSON.stringify(manifest.captured.gitlinks)) throw new Error('legacy-archive-content-changed');
    if (!await proof.recheck()) throw new Error('legacy-archive-changed');
    return true;
  };
  if (requireCurrent) await recheckCurrent();
  if (!await proof.recheck()) throw new Error('legacy-archive-changed');
  return { archiveDir: dir, archivedAt: proof.archivedAt, evidenceDigest: proof.evidenceDigest, lifecycle, recheck: proof.recheck, recheckCurrent };
}

async function historicalCheckoutAbsent(release, trees) {
  const present = await lstat(release.path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  return !present && trees.length > 0 && !trees.some(tree => tree.path === release.path || (release.branch && shortBranch(tree.branch) === release.branch));
}

/** Read existing no-archive service receipts, scoped to the original repository
 * and physical checkout generation. Never infer removal from absence alone. */
async function completedServiceRetirement(repoPath, release) {
  if (!/^[a-f0-9]{64}$/.test(release.checkoutIdentity || '')) return null;
  const [{ loadSchedule }, { getAppById }] = await Promise.all([
    import('./taskScheduleStore.js'), import('./apps.js'),
  ]);
  const schedule = await loadSchedule();
  const root = await realpath(repoPath).catch(() => null);
  if (!root) return null;
  const found = new Map();
  for (const [appId, record] of Object.entries(schedule.executions?.['task:branch-reconcile']?.perApp || {})) {
    const receipts = matchingRetirementReceipts(record.branchReconcileOutcome, release).filter(row => row.archiveDir == null
      && row.checkoutIdentity === release.checkoutIdentity && Date.parse(row.retiredAt) >= Date.parse(release.createdAt));
    if (!receipts.length) continue;
    const app = await getAppById(appId);
    if (!app?.repoPath || await realpath(app.repoPath).catch(() => null) !== root) continue;
    for (const row of receipts) {
      const key = JSON.stringify([row.branch, row.path, row.head, row.checkoutIdentity, row.retiredAt, row.branchDeleted]);
      found.set(key, row);
    }
  }
  if (found.size !== 1) return null;
  const [key, receipt] = [...found][0];
  return { kind: 'service-retirement-receipt', archiveDir: null, receipt,
    evidenceDigest: createHash('sha256').update(key).digest('hex') };
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
  const receipt = await completedServiceRetirement(repoPath, release).catch(() => null);
  if (receipt) return { ...receipt, recheck: async () => {
    if (!await absent()) return false;
    const fresh = await completedServiceRetirement(repoPath, release).catch(() => null);
    return fresh?.evidenceDigest === receipt.evidenceDigest;
  } };
  const root = heldCheckoutArchiveRoot(opts.cosDir);
  const info = await lstat(root).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info?.isDirectory()) return null;
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.length > 1000) return null;
  let selected = null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const proof = await verifyHeldArchive(repoPath, join(root, entry.name), release, archiveWork(opts.signal)).catch(() => null);
    if (!proof) continue;
    // Multiple valid snapshots cannot identify the original private contents.
    if (selected) return null;
    selected = proof;
  }
  if (!selected) return null;
  const proof = selected;
  return { ...proof, recheck: async () => await absent() && await proof.recheck() };
}

const RECOVERY_DETAIL_LIMIT = 20;
const DISCOVERY_BYTE_LIMIT = 64 * 1024 * 1024;
const archiveIdentityKey = row => row && [row.repoPath, row.path, row.head].every(value => typeof value === 'string')
  && (typeof row.branch === 'string' || row.branch === null)
  ? JSON.stringify([row.repoPath, row.branch, row.path, row.head]) : null;

/** Metadata only selects work; every selected archive is independently verified. */
async function discoverRecoveryArchives(cosDir, signal) {
  const roots = [heldCheckoutArchiveRoot(cosDir)];
  const index = new Map();
  const byDirectory = new Map();
  const coverage = { entriesRead: 0, candidates: 0, indexed: 0, metadataBytes: 0, missingRoots: 0,
    errors: 0, details: [], detailsOmitted: 0, complete: true, truncated: false };
  const diagnose = (archiveDir, error) => {
    coverage.complete = false;
    coverage.errors++;
    const refusal = archiveLimitRefusal(error);
    const detail = { archiveDir, ...(refusal || { reason: /^[a-z][a-z-]+$/.test(error.message) ? error.message : 'archive-discovery-unavailable' }) };
    if (coverage.details.length < RECOVERY_DETAIL_LIMIT) coverage.details.push(detail);
    else coverage.detailsOmitted++;
  };
  const work = { ...archiveWork(signal), read: bytes => {
    // Account before parsing, including partial, malformed and oversized reads.
    coverage.metadataBytes += bytes;
    if (coverage.metadataBytes > DISCOVERY_BYTE_LIMIT) throw new Error('archive-discovery-budget-exceeded');
  } };
  for (const root of roots) {
    try {
      const info = await lstat(root).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!info) { coverage.missingRoots++; continue; }
      if (!info.isDirectory()) throw new Error('archive-directory-invalid');
      const directory = await opendir(root);
      for await (const entry of directory) {
        if (coverage.entriesRead >= 1000 || coverage.metadataBytes >= DISCOVERY_BYTE_LIMIT) {
          coverage.truncated = true;
          diagnose(root, new Error('archive-discovery-budget-exceeded'));
          break;
        }
        coverage.entriesRead++;
        if (!entry.isDirectory()) continue;
        const candidate = { dir: join(root, entry.name), kind: root === roots[0] ? 'held' : 'initialized' };
        coverage.candidates++;
        byDirectory.set(candidate.dir, candidate);
        try {
          const { manifest } = await archiveManifest(candidate.dir, work);
          const identity = candidate.kind === 'held' ? manifest : { repoPath: manifest.facts?.repoPath, ...manifest.facts?.release };
          const key = archiveIdentityKey(identity);
          if (!key) throw new Error('archive-identity-unreadable');
          if (!index.has(key)) index.set(key, []);
          index.get(key).push(candidate);
          coverage.indexed++;
        } catch (error) {
          diagnose(candidate.dir, error);
        }
      }
    } catch (error) { diagnose(root, error); }
  }
  return { index, byDirectory, coverage };
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
  const { index, byDirectory, coverage } = await discoverRecoveryArchives(opts.cosDir, opts.signal);
  const observations = [];
  const evidenceFences = [];
  let details = 0;
  const addEvidence = (row, detail) => {
    if (details < RECOVERY_DETAIL_LIMIT) { row.evidence.push(detail); details++; }
    else row.coverage.detailsOmitted++;
  };
  try {
    for (const release of obligations) {
      if (!await historicalCheckoutAbsent(release, trees).catch(() => false)) continue;
      let proof = null;
      let verified = 0;
      const matching = index.get(archiveIdentityKey({ ...release, repoPath })) || [];
      const scopedCandidates = Object.hasOwn(release, 'preservationReceipt')
        ? [byDirectory.get(release.preservationReceipt?.archiveDir)].filter(candidate => candidate && release.preservationReceipt?.status === 'preserved'
          && JSON.stringify(release.preservationReceipt.incarnation) === JSON.stringify(release.checkoutIncarnation)
          && candidate.dir === release.preservationReceipt.archiveDir) : matching;
      const row = { release, proof: null, evidence: [], coverage: { matching: scopedCandidates.length,
        unrelated: coverage.indexed - matching.length, attempted: 0, detailsOmitted: 0 },
        reason: !coverage.complete ? 'archive-discovery-incomplete' : coverage.candidates ? 'archive-evidence-unverified' : 'archive-evidence-missing', nextAction: historicalNextAction };
      for (const candidate of scopedCandidates) {
        row.coverage.attempted++;
        try {
          const verifiedProof = await verifyHeldArchive(repoPath, candidate.dir, release, archiveWork(opts.signal));
          if (verifiedProof.releaseFence) evidenceFences.push(verifiedProof.releaseFence);
          verified++;
          proof = verifiedProof;
          addEvidence(row, { archiveDir: candidate.dir, reason: 'preservation-verified' });
        } catch (error) {
          const refusal = archiveLimitRefusal(error);
          addEvidence(row, { archiveDir: candidate.dir, ...(refusal ? { reason: refusal.reason,
            ...(refusal.archiveLimit && { archiveLimit: refusal.archiveLimit }), nextAction: refusal.nextAction,
          } : { reason: /^[a-z][a-z-]+$/.test(error.message) ? error.message : 'archive-unverifiable' }) });
        }
      }
      row.proof = verified === 1 && (coverage.complete || Object.hasOwn(release, 'preservationReceipt')) ? proof : null;
      if (verified > 1) row.reason = 'archive-preservation-ambiguous';
      observations.push(row);
    }
    if (!observations.length) return outcome;
    const { recordRecoveredCheckoutPreservations } = await import('./branchReconcileOutcome.js');
    return await withClaimOwnershipLock(() => recordRecoveredCheckoutPreservations(appId, expected, observations, async () => {
      const { getAppById } = await import('./apps.js');
      if ((await getAppById(appId))?.repoPath !== repoPath) return false;
      const currentTrees = await listWorktrees(repoPath);
      for (const row of observations) {
        if (!await historicalCheckoutAbsent(row.release, currentTrees)) return false;
        if (row.proof?.recheck && !await row.proof.recheck().catch(() => false)) {
          addEvidence(row, { archiveDir: row.proof.archiveDir, reason: 'archive-changed-during-verification' });
          row.proof = null;
          row.reason = 'archive-changed-during-verification';
        }
      }
      return true;
    }, coverage));
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
// execGit bounds JS string length. Three UTF-8 bytes per code unit is its
// maximum encoded size; retain admission for older multibyte patches too.
const MAX_PATCH_BYTES = 3 * GIT_OUTPUT_BYTES;

function checkArchiveSize(scope, fileBytes, totalBytes) {
  if (fileBytes <= MAX_FILE_BYTES && totalBytes <= MAX_TOTAL_BYTES) return;
  const kind = fileBytes > MAX_FILE_BYTES ? 'file' : 'total';
  throw Object.assign(new Error('retirement-archive-limit-exceeded'), { archiveLimit: {
    scope, kind, limitBytes: kind === 'file' ? MAX_FILE_BYTES : MAX_TOTAL_BYTES,
    observedBytes: Math.min(kind === 'file' ? fileBytes : totalBytes, Number.MAX_SAFE_INTEGER),
  } });
}

const archiveRecoveryAction = 'Keep the checkout and ref; free resources or preserve large outputs separately, then retry this exact checkout with fresh evidence.';
const archiveLimitRefusal = error => {
  const gitLimit = error.code === 'GIT_OUTPUT_LIMIT'
    ? { scope: 'git-output', kind: 'output', limitCodeUnits: error.limitCodeUnits, observedCodeUnits: error.observedCodeUnits }
    : error.code === 'GIT_TIMEOUT'
      ? { scope: 'git-command', kind: 'time', limitMs: error.limitMs, observedMs: error.observedMs } : null;
  const reason = error.code === 'GIT_TIMEOUT' ? 'retirement-archive-work-limit-exceeded'
    : error.code === 'GIT_OUTPUT_LIMIT' ? 'retirement-archive-limit-exceeded'
    : error.message === 'archive-manifest-budget-exceeded' ? 'retirement-archive-manifest-limit-exceeded'
    : ['retirement-archive-cancelled', 'retirement-archive-work-limit-exceeded', 'retirement-archive-limit-exceeded'].includes(error.message)
      ? error.message : null;
  return reason ? { ok: false, reason, ...((gitLimit || error.archiveLimit) && { archiveLimit: gitLimit || error.archiveLimit }), nextAction: archiveRecoveryAction } : null;
};

const shortBranch = (ref) => (ref ? String(ref).replace(/^refs\/heads\//, '') : null);
const zLines = (stdout) => (stdout || '').split('\0').filter(Boolean);
const archiveText = bytes => {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('archive metadata is not lossless UTF-8');
  return text;
};
const git = (args, cwd, raw = false) => execGit(args, cwd, { maxBuffer: GIT_OUTPUT_BYTES, bufferOutput: true })
  .then(r => raw ? r.stdout : archiveText(r.stdout));

/** Preserve worktree-private Git evidence, never follow its links into the
 * common repository. The lock is archived but matched separately by release.
 */
async function snapshotAdministration(path, missingRoot = null, work = archiveWork()) {
  const root = missingRoot || (await git(['rev-parse', '--absolute-git-dir'], path)).trim();
  const files = [];
  const symlinks = [];
  let bytes = 0;
  const visit = async (source, rel) => {
    work.check();
    const info = await lstat(source);
    if (info.isSymbolicLink()) {
      const link = { path: rel, target: archiveText(await readlink(source, { encoding: 'buffer' })) };
      work.add(link);
      symlinks.push(link);
      return;
    }
    if (info.isDirectory()) {
      const names = [];
      for await (const entry of await opendir(source, { encoding: 'buffer' })) {
        const name = archiveText(entry.name);
        work.add(name, 'directory');
        names.push(name);
      }
      for (const name of names.sort()) await visit(join(source, name), rel ? `${rel}/${name}` : name);
      return;
    }
    if (!info.isFile()) throw new Error('administration cannot be archived');
    bytes += info.size;
    checkArchiveSize('administration', info.size, bytes);
    const file = { path: rel, bytes: info.size, sha256: await archiveHash(source, work) };
    work.add(file);
    files.push({ ...file, source });
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
  // A detached copy does not inherit another physical checkout's unfinished
  // obligation. Bind that distinction to captured generations and fresh delivery,
  // without changing those owners' outcomes or retiring their originals.
  const forge = reviewIdentity.retirementForge;
  if (reviewIdentity.detachedCheckoutIdentity && forge?.prUrl === reviewIdentity.prUrl
    && forge.scopeProof === 'represented-detached-head' && forge.detachedRepresentation?.sourceHead === reviewIdentity.tip
    && forge.detachedRepresentation.deliveredHead === forge.prHead
    && Array.isArray(policies)) {
    const { completedCheckoutReceiptValid } = await import('./completedCheckoutEvidence.js');
    const candidates = policies.flatMap(agent => (agent.status === 'completed' && Array.isArray(agent.metadata?.completedCheckouts) ? agent.metadata.completedCheckouts : [])
      .filter(row => row?.branch === branch && completedCheckoutReceiptValid(agent, row))
      .map(row => ({ agent, row })));
    const siblings = [];
    const repository = await realpath(repoPath).catch(() => null);
    const canonical = path => process.platform === 'win32' ? path?.toLowerCase() : path;
    if (candidates.length <= 25) for (const { agent, row } of candidates) {
      const capturedRepository = await realpath(row.repoPath).catch(() => null);
      if (!repository || !capturedRepository || canonical(repository) !== canonical(capturedRepository)) continue;
      // Delivery is established for the released detached head, not this
      // other generation. Its rewritten or unfinished work remains untouched.
      // The policy below still requires the exact valid capture and a distinct
      // physical generation, and never grants deletion of its named branch.
      siblings.push({ agentId: agent.id, capturedHead: row.head, capturedAt: row.capturedAt,
        path: row.path, incarnation: row.incarnation, detachedCheckoutIdentity: reviewIdentity.detachedCheckoutIdentity });
    }
    reviewIdentity = { ...reviewIdentity, detachedSiblingCaptures: siblings };
  }
  const checkoutIdentities = {};
  if (reviewIdentity.verifiedPrHead === reviewIdentity.tip && reviewIdentity.tip && Array.isArray(policies)) {
    const paths = new Set([reviewIdentity.checkoutPath, repoPath]);
    for (const agent of policies) {
      const meta = agent?.metadata || {};
      const scopes = [meta.worktreeBranch, meta.jiraBranch, meta.claimBranch, meta.branchCompletionPolicy?.branch,
        ...(Array.isArray(meta.claimBranches) ? meta.claimBranches : []),
        ...(Array.isArray(meta.claimReleasedBranches) ? meta.claimReleasedBranches : [])];
      if (scopes.includes(branch)) {
        if (isAbsolute(meta.workspacePath || '')) paths.add(meta.workspacePath);
        // Receipt capture canonicalizes filesystem names. Windows short names
        // and other existing aliases need the same server-observed identity
        // comparison as the current checkout, never textual guessing.
        for (const row of Array.isArray(meta.completedCheckouts) ? meta.completedCheckouts : []) {
          if (row?.version !== 2 || row.branch !== branch) continue;
          for (const path of [row.repoPath, row.path]) if (isAbsolute(path || '')) paths.add(path);
        }
      }
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
  const initial = reviewedRetirementPolicy({ repoPath, branch, agents: policies, ...reviewIdentity, checkoutIdentities });
  if (initial.reason !== 'retirement-policy-not-legacy-completed' || !reviewIdentity.retirementForge) return initial;
  let identity = reviewIdentity;
  if (!identity.checkoutIncarnation) {
    const { readCompletedCheckoutIdentity } = await import('./completedCheckoutEvidence.js');
    // The caller has already checked the released lock and registration. This
    // fact-read grants no unlock authority; ordinary matching policies avoid it.
    const generation = await readCompletedCheckoutIdentity({ repoPath, branch, path: identity.checkoutPath,
      head: identity.tip, allowLocked: true }).catch(() => null);
    if (!generation) return initial;
    identity = { ...identity, checkoutIncarnation: generation.incarnation };
  }
  // The explicitly released named copy may predate a separate review checkout.
  // Retain that original's obligation; prove its captured commits are contained
  // in this exact merged source instead of treating its old verdict as this copy's owner.
  if (!identity.detachedCheckoutIdentity && identity.retirementForge?.scopeProof === 'exact-delivered-head') {
    const { completedCheckoutReceiptValid } = await import('./completedCheckoutEvidence.js');
    const siblings = Array.isArray(policies) ? policies.flatMap(agent => agent.status === 'completed' && Array.isArray(agent.metadata?.completedCheckouts)
      ? agent.metadata.completedCheckouts.filter(row => completedCheckoutReceiptValid(agent, row)
        && row.branch === branch && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(row.head || ''))
        .map(row => ({ agent, row })) : []) : [];
    const repository = await realpath(repoPath).catch(() => null);
    const namedSiblingCaptures = [];
    if (repository && siblings.length <= 25) for (const { agent, row } of siblings) {
      if (await realpath(row.repoPath).catch(() => null) !== repository) continue;
      const included = await execGit(['--no-replace-objects', '-c', 'core.commitGraph=false', 'merge-base', '--is-ancestor', row.head, identity.tip], repoPath,
        { ignoreExitCode: true, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_GRAFT_FILE: devNull } });
      if (included.exitCode === 0) namedSiblingCaptures.push({ agentId: agent.id, capturedHead: row.head, capturedAt: row.capturedAt,
        path: row.path, incarnation: row.incarnation, checkoutIncarnation: identity.checkoutIncarnation });
    }
    identity = { ...identity, namedSiblingCaptures };
  }
  const resumed = reviewedRetirementPolicy({ repoPath, branch, agents: policies, ...identity, checkoutIdentities });
  if (!resumed.reason) return resumed;
  const { readCheckoutDeliveryContinuations } = await import('./checkoutDeliveryContinuation.js');
  const deliveryContinuations = await readCheckoutDeliveryContinuations({ repoPath, branch, ...identity }, policies, opts);
  const continued = reviewedRetirementPolicy({ repoPath, branch, agents: policies, ...identity, checkoutIdentities, deliveryContinuations });
  if (!continued.reason) return continued;
  const { readResumedCheckoutDeliveries } = await import('./resumedCheckoutDelivery.js');
  const resumedDeliveries = await readResumedCheckoutDeliveries({ repoPath, branch, ...identity }, policies,
    { retainMissingSource: opts.retainMissingSource === true });
  return reviewedRetirementPolicy({ repoPath, branch, agents: policies, ...identity, checkoutIdentities, deliveryContinuations, resumedDeliveries });
}

const policyReviewIdentity = (release, prUrl, forge) => ({
  checkoutPath: release.path, tip: release.head, prUrl,
  verifiedPrHead: forge?.prUrl === prUrl ? forge.prHead : null,
});

async function integratedPolicyReviewIdentity(repoPath, release, prUrl, forge, archivedIncarnation = null) {
  const targetHead = forge?.targetHead ?? forge?.defaultHead;
  if (!forge || !await execGit(['cat-file', '-e', `${targetHead}^{commit}`], repoPath).then(() => true, () => false)) return null;
  // Only the post-removal caller supplies a generation already bound into the
  // verified archive/review. A recreated path is never an absent original.
  const absent = archivedIncarnation && await lstat(release.path).then(() => false, error => error.code === 'ENOENT');
  const checkoutIncarnation = absent ? archivedIncarnation : null;
  return { ...policyReviewIdentity(release, prUrl, forge), retirementForge: forge,
    ...(checkoutIncarnation && { checkoutIncarnation }),
    // Older pinned claims missed completion capture. Fresh inclusion of every
    // commit settles cleanup-only outcomes without manufacturing receipts.
    integratedCleanupHead: forge?.prHead === release.head && await isAncestor(repoPath, release.head, targetHead)
      ? targetHead : null };
}

const reviewForgeOptions = (release, kind, opts) => ({ forgeAccount: opts.forgeAccount,
  ...(!kind && { exactDeliveredHead: release.head }),
  ...(!release.branch && { exactAliasHead: release.head, detachedSourceHead: release.head }),
  ...(kind && { sourceSupersessionHead: release.head }),
  ...(kind === 'preserved-supersession' && { requirePublishedSupersession: true, allowPrivateSupersession: true }) });

async function matchReviewTarget({ repoPath, release, kind, unlocked = false }, opts) {
  if (kind && !['source-supersession', 'preserved-supersession'].includes(kind)) return { ok: false, reason: 'retirement-review-kind-unavailable' };
  if (kind && !release.branch) return { ok: false, reason: 'retirement-source-branch-required' };
  if (PROTECTED_BRANCHES.includes(release.branch)) return { ok: false, reason: 'protected-branch' };
  const matched = await matchRelease(repoPath, unlocked ? { ...release, locked: false, lockReason: null } : release);
  if (!matched.tree) return { ok: false, reason: matched.reason };
  const owner = await ownerReason({ repoPath, tree: matched.tree, branch: release.branch,
    readAgents: opts.readAgents || readClaimOwnershipAgents, reviewed: true });
  if (owner) return { ok: false, reason: owner };
  return { ok: true, tree: matched.tree };
}

async function readCheckoutReviewPrerequisites(input, opts) {
  const { repoPath, release, prUrl, kind } = input;
  const matched = await matchReviewTarget(input, opts);
  if (!matched.ok) return matched;
  const { readRetirementForgeEvidence } = await import('./heldCheckoutReview.js');
  const forge = await (opts.readForge || readRetirementForgeEvidence)(repoPath, release.branch, prUrl, reviewForgeOptions(release, kind, opts))
    .catch(error => ({ error }));
  if (forge?.error) return { ok: false, reason: /^retirement-[a-z-]+$/.test(forge.error.message) ? forge.error.message : 'retirement-forge-unavailable' };
  if (kind && forge?.sourceSupersessionHead !== release.head) return { ok: false, reason: 'retirement-source-head-unverified' };
  if (!release.branch && ((forge?.prHead !== release.head && forge?.detachedRepresentation?.sourceHead !== release.head) || !forge.publishedBranch)) return { ok: false, reason: 'retirement-detached-head-unverified' };
  const policyBranch = release.branch || forge.publishedBranch;
  const namedOwner = !release.branch && await ownerReason({ repoPath, tree: matched.tree, branch: policyBranch,
    readAgents: opts.readAgents || readClaimOwnershipAgents, reviewed: true });
  if (namedOwner) return { ok: false, reason: namedOwner };
  const identity = await integratedPolicyReviewIdentity(repoPath, release, prUrl, forge);
  if (!identity) return { ok: false, reason: 'retirement-local-objects-missing', proofForge: forge };
  if (!release.branch) {
    const observed = await observeReviewCheckoutIdentity(release.path);
    if (!observed) return { ok: false, reason: 'checkout-identity-changed' };
    identity.detachedCheckoutIdentity = observed.pointer;
    identity.detachedCheckoutGitdir = observed.gitdir;
  }
  const policy = await retirementPolicy(repoPath, policyBranch, opts, identity);
  if (policy.reason) return { ok: false, reason: policy.reason };
  return { ok: true, tree: matched.tree, forge, policy };
}

/** A superseded prototype is not merged. Keep exact published/private source plus a
 * small, bounded copy of checkout-only evidence in the durable schedule record.
 * This never creates a repository archive or treats arbitrary ignored data as
 * cache. Oversized/unknown recovery objects retain the original checkout. */
async function preservePublishedSourceReview(repoPath, tree, forge, content, administration, signal, retainMissingSource = false) {
  const source = forge.sourcePreservation;
  const privateSource = source?.kind === 'private-retained-source';
  if (!source || source.head !== tree.head || source.remoteRef !== tree.branch
    || (privateSource ? forge.remoteHead !== null : forge.remoteHead !== `${tree.head}\t${tree.branch}`)) throw new Error('retirement-source-not-published');
  let privateProof, retainPrivateRoot;
  const privateRecoveryProofs = [];
  const privateDeadline = performance.now() + 10000;
  if (privateSource) {
    if ((await git(['show-ref', '--verify', '--hash', tree.branch], repoPath)).trim() !== tree.head) throw new Error('retirement-local-source-head-changed');
    const target = forge.targetHead ?? forge.defaultHead;
    await git(['merge-base', '--is-ancestor', forge.mergeCommit, target], repoPath);
    const { retainCheckoutSourceObjects } = await import('./resumedCheckoutDelivery.js');
    retainPrivateRoot = head => retainCheckoutSourceObjects({ repoPath,
      sourceHead: head, targetHead: target, retainMissingSource,
      deadline: privateDeadline }).catch(() => null);
    privateProof = await retainPrivateRoot(tree.head);
    if (!privateProof) throw new Error('retirement-source-preservation-unavailable');
  }
  if (content.indexDiff.length || content.worktreeDiff.length) throw new Error('retirement-source-dirty');
  // A clean index can still retain resolve-undo conflict stages that cannot be
  // reconstructed from HEAD. Do not omit that private recovery evidence.
  if ((await git(['ls-files', '--resolve-undo', '-z'], tree.path)).length) throw new Error('retirement-source-index-recovery-unpublished');
  const work = archiveWork(signal);
  const roots = await recoveryObjectHeads(administration, { repoPath, tree }, work);
  // Saved private refs/reflogs may name work beyond the published tip. Do not
  // discard it merely because its metadata fits in the small evidence budget.
  for (const head of [...roots].sort()) {
    work.check();
    if (privateSource) {
      // The retained tip already keeps its commit ancestors reachable; reflog
      // checkpoints in that history need no additional retention refs.
      if (head !== tree.head) {
        const read = args => {
          const remaining = Math.floor(privateDeadline - performance.now());
          if (remaining <= 0) throw new Error('retirement-source-private-work-unpublished');
          return execGit(['--no-replace-objects', '-c', 'core.commitGraph=false', ...args], repoPath,
            { ignoreExitCode: true, timeout: Math.min(remaining, 2000), maxBuffer: 16384,
              env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_GRAFT_FILE: devNull } });
        };
        const type = await read(['cat-file', '-t', head]);
        const ancestor = type.exitCode === 0 && type.stdout.trim() === 'commit'
          && (await read(['merge-base', '--is-ancestor', head, tree.head])).exitCode === 0;
        if (ancestor) {
          privateRecoveryProofs.push({ sourceHead: head, sourceReachableFrom: tree.head,
            retainedRef: privateProof.retainedRef, retainedHead: privateProof.retainedHead, deltaBytes: 0 });
          continue;
        }
      }
      const proof = head === tree.head ? privateProof : await retainPrivateRoot(head);
      if (!proof) throw new Error('retirement-source-private-work-unpublished');
      privateRecoveryProofs.push(proof);
      continue;
    }
    if (!await execGit(['merge-base', '--is-ancestor', head, tree.head], repoPath,
      { ignoreExitCode: true, timeout: 2000, maxBuffer: 16384,
        env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' } }).then(result => result.exitCode === 0)) throw new Error('retirement-source-private-work-unpublished');
  }
  let bytes = 0;
  const files = [];
  for (const [scope, rows] of [['content', content.files], ['administration', administration.files]]) {
    for (const file of rows) {
      if (file.disposableCache || (scope === 'administration'
        && ['gitdir/index', 'gitdir/gitdir', 'gitdir/commondir', 'gitdir/locked', 'git-indirection'].includes(file.path))) continue;
      bytes += file.bytes;
      if (bytes > 64 * 1024) throw new Error('retirement-source-evidence-too-large');
      const sourcePath = scope === 'content' ? join(tree.path, file.path) : file.source;
      const data = await archiveBytes(sourcePath, work, 64 * 1024);
      if (data.length !== file.bytes || evidenceHash(data) !== file.sha256) throw new Error('retirement-review-changed');
      files.push({ scope, path: file.path, sha256: file.sha256, data: data.toString('base64') });
    }
  }
  return { ...source, ...(privateProof && { privateProof, privateRecoveryProofs }), files, symlinks: { content: content.symlinks, administration: administration.symlinks },
    recoveryHeads: [...roots].sort(), omitted: 'clean-index-and-checkout-pointers-reconstructible; recognized-module-cache-disposable' };
}

async function buildCurrentCheckoutReview({ repoPath, release, prUrl, kind }, { tree, forge, policy }, opts, captureContent) {
  const { buildCheckoutRetirementReview } = await import('./heldCheckoutReview.js');
  const work = archiveWork(opts.signal);
  return archiveSnapshots(tree, repoPath, null, work, true, !kind)
    .then(async ([content, administration]) => {
      const preservedSource = kind === 'preserved-supersession'
        ? await preservePublishedSourceReview(repoPath, tree, forge, content, administration, opts.signal, opts.retainMissingSource === true) : null;
      // Validation lives on the forge: the merged PR's required CI gated its head.
      const review = await buildCheckoutRetirementReview({ repoPath, release, prUrl, kind, preservedSource,
        contentFingerprint: content.fingerprint, administrationFingerprint: administration.fingerprint, policy }, { ...opts, readForge: async () => forge });
      captureContent?.(content);
      return review;
    })
    .then(review => ({ ok: true, review }), error => archiveLimitRefusal(error) || { ok: false,
      reason: /^retirement-[a-z-]+$/.test(error.message) ? error.message : 'retirement-local-evidence-unavailable' });
}

async function reviewCurrentCheckout(input, opts = {}, captureContent) {
  const prerequisites = await readCheckoutReviewPrerequisites(input, opts);
  return prerequisites.ok ? buildCurrentCheckoutReview(input, prerequisites, opts, captureContent) : prerequisites;
}

async function observeReviewCheckoutIdentity(path) {
  const pointer = await readRetirementCheckoutIdentity(path);
  if (!pointer) return null;
  const gitdir = await realpath((await execGit(['rev-parse', '--absolute-git-dir'], path)).stdout.trim());
  const info = await lstat(gitdir, { bigint: true });
  if (!info.isDirectory() || await readRetirementCheckoutIdentity(path) !== pointer) return null;
  return { pointer, gitdir: { path: gitdir, dev: String(info.dev), ino: String(info.ino), birthtimeNs: String(info.birthtimeNs) } };
}

async function previewCheckoutIdentity(path) {
  const observed = await observeReviewCheckoutIdentity(path);
  return observed ? JSON.stringify([observed.pointer, observed.gitdir.path,
    observed.gitdir.dev, observed.gitdir.ino, observed.gitdir.birthtimeNs]) : null;
}

/** Preview is evidence, never a retirement reservation or mutation grant. Keep
 * forge calls, hashing and diff construction outside the process-wide queue. */
async function previewCurrentCheckout(input, opts) {
  const matched = await withClaimOwnershipLock(() => matchReviewTarget(input, opts));
  if (!matched.ok) return matched;
  const { repoPath, release, prUrl, kind } = input;
  const { readRetirementForgeEvidence } = await import('./heldCheckoutReview.js');
  const forge = await (opts.readForge || readRetirementForgeEvidence)(repoPath, release.branch, prUrl,
    reviewForgeOptions(release, kind, opts)).catch(error => ({ error }));
  const localOptions = { ...opts, readForge: async () => forge };
  const captured = await withClaimOwnershipLock(async () => {
    const prerequisites = await readCheckoutReviewPrerequisites(input, localOptions);
    if (!prerequisites.ok) return prerequisites;
    const identity = await previewCheckoutIdentity(release.path).catch(() => null);
    return identity && (!release.checkoutIdentity || await readRetirementCheckoutIdentity(release.path) === release.checkoutIdentity)
      ? { ...prerequisites, identity }
      : { ok: false, reason: 'checkout-identity-changed' };
  });
  if (!captured.ok) return captured;
  const prepared = await buildCurrentCheckoutReview(input, captured, localOptions);
  if (!prepared.ok) return prepared;
  return withClaimOwnershipLock(async () => {
    // Bind even legacy inventory rows to the generation captured before hashing.
    const current = await readCheckoutReviewPrerequisites(input, localOptions);
    if (!current.ok) return current;
    if (await previewCheckoutIdentity(release.path).catch(() => null) !== captured.identity) {
      return { ok: false, reason: 'checkout-identity-changed' };
    }
    if (JSON.stringify(current.policy) !== JSON.stringify(captured.policy)) {
      return { ok: false, reason: 'retirement-review-changed' };
    }
    return prepared;
  });
}

/** Host-control-gated preview of one inventory row; may fetch missing proof objects. */
export async function prepareInventoriedCheckoutRetirement({ appId, release, prUrl, kind }, opts = {}) {
  const [{ getAppById }, { getBranchReconcileOutcome }] = await Promise.all([import('./apps.js'), import('./branchReconcileOutcome.js')]);
  const app = await getAppById(appId);
  if (!app?.repoPath) return { ok: false, reason: 'app-not-found' };
  const outcome = await getBranchReconcileOutcome(appId);
  const retired = bindRemovedCheckoutRelease(outcome, release);
  if (retired) return prepareRemovedCheckoutBranch({ appId, release: retired, prUrl, kind }, opts);
  release = bindInventoriedRelease(outcome, release);
  if (!release) return { ok: false, reason: 'release-not-in-inventory' };
  const reviewOptions = { ...opts, forgeAccount: app.forgeAccount ?? null, retainMissingSource: true };
  const review = () => previewCurrentCheckout({ repoPath: app.repoPath, release, prUrl, kind }, reviewOptions);
  let prepared = await review();
  if (prepared.reason === 'retirement-local-objects-missing') {
    // Fetch the object set that this attempt actually needs. Independently
    // rereading a moving default here and in the retry can chase three different
    // snapshots and leave an otherwise completed job waiting indefinitely.
    const proofForge = prepared.proofForge;
    const proofOptions = proofForge
      ? { ...reviewOptions, readForge: async () => proofForge }
      : reviewOptions;
    const fetched = await fetchRetirementProofObjects(app.repoPath, release, prUrl, null, { ...proofOptions, ...reviewForgeOptions(release, kind, proofOptions) });
    if (!fetched.ok) return fetched;
    prepared = await previewCurrentCheckout({ repoPath: app.repoPath, release, prUrl, kind }, proofOptions);
  }
  if (!kind && release.branch && prepared.reason === 'retirement-policy-not-legacy-completed') {
    // Recover only a previously registered physical generation after fresh
    // merged exact-head proof. Never promote an orphan's execution to success.
    const { readRetirementForgeEvidence } = await import('./heldCheckoutReview.js');
    const forge = await (opts.readForge || readRetirementForgeEvidence)(app.repoPath, release.branch, prUrl,
      reviewForgeOptions(release, kind, { ...opts, forgeAccount: app.forgeAccount ?? null })).catch(() => null);
    if (forge?.prUrl === prUrl && forge.prHead === release.head) {
      const [repoPath, checkoutPath] = await Promise.all([
        realpath(app.repoPath).catch(() => null), realpath(release.path).catch(() => null),
      ]);
      if (!repoPath || !checkoutPath) return prepared;
      const { readBranchCompletionPolicies } = await import('./branchCompletionPolicy.js');
      const policies = await (opts.readPolicies || (() => readBranchCompletionPolicies({ repairIndex: false })))().catch(() => null);
      const retry = opts.recoverCheckoutCapture || (await import('./cosAgentLifecycle.js')).retryCompletionCheckoutCapture;
      let recovered = false;
      for (const agent of Array.isArray(policies) ? policies : []) {
        const meta = agent.metadata || {};
        const knownPr = meta.branchCompletionPolicy?.prUrl || meta.reviewLoopMergeTarget?.url;
        const seededOrphan = agent.result?.orphaned === true && meta.checkoutCapture?.status === 'captured';
        const pendingExecution = agent.result?.executionSuccess === true && meta.checkoutCapture?.status === 'pending';
        if (agent.status !== 'completed' || (!seededOrphan && !pendingExecution) || agent.result.validationPassed === false
          || knownPr !== prUrl || meta.completedCheckouts?.length !== 0
          || !meta.checkoutSeeds?.some(seed => seed.repoPath === repoPath && seed.branch === release.branch && seed.path === checkoutPath)) continue;
        recovered = await retry(agent.id || agent.agentId, { retirement: { ...release, repoPath, path: checkoutPath,
          ...(pendingExecution && { prUrl, verifiedMergedHead: forge.prHead }) } }).catch(() => false) || recovered;
      }
      if (recovered) prepared = await review();
    }
  }
  return prepared;
}

/** Git's object id for raw bytes, with no clean filter or line-ending conversion. */
async function rawBlobId(source, size, format, work) {
  const hash = createHash(format).update(`blob ${size}\0`);
  let bytes = 0;
  const { stream } = await archiveSource(source);
  for await (const chunk of stream) {
    work.check();
    // Clean tracked files are not raw archive inputs; a growing read still
    // cannot consume unbounded work before the next metadata check.
    if ((bytes += chunk.length) > size) throw new Error('checkout-content-changed');
    hash.update(chunk);
  }
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
// Running Vitest through the client's declared Vite config uses its cacheDir.
// Keep that producer root compatible without accepting arbitrary ignored roots.
const VITEST_STATE_CACHE_ROOTS = [
  ...Object.values(WORKSPACE_TEST_CACHE_ROOTS).map(cache => `${cache.workspace}/${cache.cacheDir}/vitest`),
  'client/.cache/vite/vitest',
];
const cacheInspectionFailure = error => {
  if (['retirement-archive-cancelled', 'retirement-archive-work-limit-exceeded', 'archive-manifest-budget-exceeded'].includes(error.message)) throw error;
  return false;
};

const cacheRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const cacheFields = (value, fields) => cacheRecord(value) && Object.keys(value).every(key => fields.includes(key));
const cacheMap = (value, check) => cacheRecord(value) && Object.values(value).every(check);
const cacheNumber = value => Number.isFinite(value) && value >= 0;

// Vitest 5 ResultsCache/DependenciesCache write version 1 in the SHA-1 project
// directory returned by resolveTestCacheDir. Never follow referenced paths.
function testStateCacheSchema(value, filename) {
  if (!cacheFields(value, ['version', 'projects']) || value.version !== 1 || !cacheRecord(value.projects)) return false;
  if (filename === 'results.json') return cacheMap(value.projects, project => cacheFields(project, ['files', 'typecheck'])
    && Object.values(project).every(files => cacheMap(files, result => cacheFields(result, ['failed', 'duration', 'lastRun'])
      && typeof result.failed === 'boolean' && cacheNumber(result.duration)
      && (result.lastRun === undefined || cacheNumber(result.lastRun)))));
  return cacheMap(value.projects, project => cacheFields(project, ['modules', 'globalSetup', 'files'])
    && Array.isArray(project.modules) && project.modules.every(file => typeof file === 'string' && !file.includes('\0'))
    && (project.globalSetup === undefined || Array.isArray(project.globalSetup)) && cacheRecord(project.files)
    && [...(project.globalSetup === undefined ? [] : [project.globalSetup]), ...Object.values(project.files)].every(indices => Array.isArray(indices)
      && indices.every(index => Number.isSafeInteger(index) && index >= 0 && index < project.modules.length)));
}

async function disposableStateCache(path, rel, ignored, verified, work) {
  const root = VITEST_STATE_CACHE_ROOTS.find(cache => rel.startsWith(`${cache}/`) && /^(?:CACHEDIR\.TAG|[a-f0-9]{40}\/(?:(?:results|dependencies)\.json|\.tmp-\d{13}-[a-z0-9]+))$/.test(rel.slice(cache.length + 1)));
  if (!root || !ignored.has(`${root}/CACHEDIR.TAG`)) return false;
  if (!verified.has(root)) verified.set(root, archiveBytes(await archiveFile(path, join(path, root, 'CACHEDIR.TAG')), work, 2048)
    .then(tag => tag.toString('utf8') === `${VITEST_CACHE_TAG}\n# For information about cache directory tags see https://bford.info/cachedir/\n`)
    .catch(cacheInspectionFailure));
  if (!await verified.get(root)) return false;
  if (rel === `${root}/CACHEDIR.TAG`) return true;
  // Vitest's atomicWriteFile creates .tmp-<Date.now>-<base36 random> beside
  // state files. An interrupted empty file holds no payload; nonempty partial
  // writes stay protected rather than being discarded by filename alone.
  if (basename(rel).startsWith('.tmp-')) return (await archiveBytes(await archiveFile(path, join(path, rel)), work, 0)).length === 0;
  const value = JSON.parse((await archiveBytes(await archiveFile(path, join(path, rel)), work, MAX_MANIFEST_BYTES)).toString('utf8'));
  return testStateCacheSchema(value, basename(rel));
}

/** Recognize only ignored, tagged producer-shaped test caches, never arbitrary ignored files. */
async function disposableTestCache(path, rel, ignored, verified, work) {
  if (!ignored.has(rel)) return false;
  if (await disposableStateCache(path, rel, ignored, verified, work).catch(cacheInspectionFailure)) return true;
  const root = VITEST_MODULE_CACHE_ROOTS.find(cache => rel.startsWith(`${cache}/`)
    && moduleCacheName(rel.slice(cache.length + 1)));
  if (!root || !ignored.has(`${root}/CACHEDIR.TAG`) || !ignored.has(`${root}/_metadata.json`)) return false;
  if (!verified.has(root)) verified.set(root, (async () => {
    const tag = await archiveBytes(await archiveFile(path, join(path, root, 'CACHEDIR.TAG')), work, 2048);
    const metadata = JSON.parse((await archiveBytes(await archiveFile(path, join(path, root, '_metadata.json')), work, 4096)).toString('utf8'));
    // Vitest's getLockfileHash writes the first eight hex characters of a
    // SHA-256 digest. Keep previously accepted long hashes compatible too.
    return tag.toString('utf8').startsWith(VITEST_CACHE_TAG) && moduleCacheMetadata(metadata);
  })().catch(cacheInspectionFailure));
  if (!await verified.get(root)) return false;
  // Check every directory component; a cache-shaped symlink is not cache evidence.
  return archiveFile(path, join(path, rel)).then(() => true, cacheInspectionFailure);
}

// Git for Windows can enumerate junction descendants. Inspect components in
// order so Node's lstat sees the link before hashing any target bytes.
async function listedContentEntry(path, listed, work) {
  const parts = listed.replace(/\/$/, '').split('/');
  for (let i = 0; i < parts.length; i++) {
    work.check();
    const rel = parts.slice(0, i + 1).join('/');
    const info = await lstat(join(path, rel));
    if (info.isSymbolicLink() || i === parts.length - 1) return { rel, info };
    if (!info.isDirectory()) throw new Error(`${rel} is not a directory`);
  }
}

// Exact-delivery review excludes ignored files from its digest; the removal
// boundary independently checks them before any checkout is deleted.
async function snapshotContent(path, work = archiveWork(), allowDisposableCache = false, excludeIgnored = false) {
  work.check();
  // These reads are independent and each Git spawn is mostly launch latency, so
  // they run together; every destructive boundary re-reads this snapshot anyway.
  const [unmerged, stageOut, tagged, indexDiff, worktreeDiff, objectFormat, others, ignoredFiles] = await Promise.all([
    git(['ls-files', '-u', '-z'], path),
    git(['ls-files', '--stage', '-z'], path),
    git(['ls-files', '-v', '-z'], path),
    // A textconv or external diff driver can drop bytes from a patch. Disable
    // diff's stat-cache refresh too: an otherwise read-only diff can rewrite
    // the index and race the concurrent administration snapshot. Git's
    // --no-optional-locks alone does not disable diff.autoRefreshIndex.
    git(['-c', 'diff.autoRefreshIndex=false', 'diff', '--cached', '--binary', '--no-textconv', '--no-ext-diff'], path, true),
    git(['-c', 'diff.autoRefreshIndex=false', 'diff', '--binary', '--no-textconv', '--no-ext-diff'], path, true),
    git(['rev-parse', '--show-object-format'], path),
    git(['ls-files', '--others', ...(excludeIgnored ? ['--exclude-standard'] : []), '-z'], path),
    allowDisposableCache && !excludeIgnored ? git(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], path) : '',
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
    const link = { path: rel, commit: header.split(' ')[1], state: info ? 'empty' : 'missing' };
    work.add(link);
    gitlinks.push(link);
  }
  // Assume-unchanged (lowercase tag) and skip-worktree (S) entries hide edits from diff.
  const hidden = zLines(tagged).find(line => /^[a-zS]/.test(line));
  if (hidden) throw new Error(`${hidden.slice(2)} hides working-tree changes from Git`);

  const files = [];
  const ignored = new Set(zLines(ignoredFiles));
  const verifiedCaches = new Map();
  let total = 0;
  const addFile = async (rel, info, extra = {}) => {
    if (!extra.disposableCache) {
      total += info.size;
      checkArchiveSize('content', info.size, total);
    }
    // Current no-archive review still hashes every byte with bounded streaming,
    // metadata and elapsed-work budgets. Historical archive limits stay intact.
    const file = { path: rel, bytes: info.size,
      sha256: await archiveHash(join(path, rel), work, extra.disposableCache ? Infinity : MAX_FILE_BYTES), ...extra };
    work.add(file);
    files.push(file);
  };
  const format = objectFormat.trim() || 'sha1';
  for (const line of stage) {
    work.check();
    const tab = line.indexOf('\t');
    const [mode, blob] = line.slice(0, tab).split(' ');
    const rel = line.slice(tab + 1);
    // Symlink blobs are not filtered; deletions and type changes are in the diff.
    if (mode !== '100644' && mode !== '100755') continue;
    const info = await lstat(join(path, rel)).catch(err => (err.code === 'ENOENT' ? null : Promise.reject(err)));
    if (!info?.isFile()) continue;
    if (await rawBlobId(join(path, rel), info.size, format, work) !== blob) await addFile(rel, info, { tracked: true });
  }
  const symlinks = [];
  const links = new Set();
  for (const listed of zLines(others).sort()) {
    const { rel, info } = await listedContentEntry(path, listed, work);
    if (links.has(rel)) continue;
    // `ls-files --others` names a nested repository as `dir/` without its files.
    // A junction may also have a trailing slash; classify the link first.
    if (!info.isSymbolicLink() && listed.endsWith('/')) throw new Error(`nested repository at ${rel} cannot be archived`);
    if (info.isSymbolicLink()) {
      const link = { path: rel, target: archiveText(await readlink(join(path, rel), { encoding: 'buffer' })) };
      work.add(link);
      symlinks.push(link);
      links.add(rel);
    }
    else if (info.isFile()) {
      const disposableCache = allowDisposableCache && await disposableTestCache(path, rel, ignored, verifiedCaches, work);
      await addFile(rel, info, disposableCache ? { disposableCache: true } : {});
    }
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

async function archiveSnapshots(tree, repoPath, missingRoot, work = archiveWork(), allowDisposableCache = false, excludeIgnored = false) {
  if (!allowDisposableCache) work = work.metadataScope();
  if (!missingRoot) {
    const snapshots = await Promise.all([snapshotContent(tree.path, work, allowDisposableCache, excludeIgnored), snapshotAdministration(tree.path, null, work)]);
    work.check();
    // Capture already charged metadata; apply the reader's layout checks too.
    for (const snapshot of snapshots) validateArchiveEntries(snapshot, work, false);
    checkArchiveBudget(...snapshots, allowDisposableCache);
    return snapshots;
  }
  const present = await lstat(tree.path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (present) throw new Error('missing-checkout-reappeared');
  const prefix = ['--git-dir', missingRoot, '--work-tree', tree.path];
  if ((await git([...prefix, 'ls-files', '-u', '-z'], repoPath)).length) throw new Error('unmerged index entries cannot be archived');
  const indexDiff = await git([...prefix, 'diff', '--cached', '--binary', '--no-textconv', '--no-ext-diff'], repoPath, true);
  const content = { indexDiff, worktreeDiff: Buffer.alloc(0), files: [], symlinks: [], gitlinks: [], missingCheckout: true,
    fingerprint: createHash('sha256').update('missing-checkout\0').update(indexDiff).digest('hex') };
  const administration = await snapshotAdministration(tree.path, missingRoot, work);
  validateArchiveEntries(administration, work, false);
  checkArchiveBudget(content, administration);
  return [content, administration];
}

/** Preserve ignored content and recovery evidence before a clean merged tree
 * is removed. The caller owns the live ownership fence and merge proof; this
 * guard verifies that every preserved byte still matches immediately at removal.
 */
export async function preserveMergedCheckout(repoPath, tree, defaultBranch, { cosDir, signal } = {}) {
  if (!tree?.head || (!tree.branch && tree.detached !== true) || tree.locked) throw new Error('checkout-identity-unavailable');
  const checkoutIdentity = await readRetirementCheckoutIdentity(tree.path);
  const branch = shortBranch(tree.branch);
  const missingRoot = await missingCheckoutAdministration(repoPath, tree.path);
  const archive = await archiveCheckout({ repoPath, tree, branch, defaultBranch, cosDir, missingRoot, work: archiveWork(signal) });
  return {
    archiveDir: archive.dir,
    checkoutIdentity,
    async verify(holder) {
      if (!holder || holder.head !== tree.head || holder.branch !== tree.branch || Boolean(holder.detached) !== Boolean(tree.detached)) return 'worktree-holder-changed';
      // Missing-root recovery archives Git administration without a live pointer.
      if (checkoutIdentity && await readRetirementCheckoutIdentity(tree.path) !== checkoutIdentity) return 'checkout-identity-changed';
      const [content, administration] = await archiveSnapshots(tree, repoPath, missingRoot, archiveWork(signal));
      return content.fingerprint === archive.fingerprint && administration.fingerprint === archive.administrationFingerprint
        ? null : 'checkout-content-changed';
    },
  };
}

// All administration bytes are preserved separately. Only Git's reference
// formats establish object dependencies; messages and application JSON do not.
function recoveryReferenceKind(path) {
  const relative = path.replace(/^gitdir\//, '');
  if (/^(rebase-merge|rebase-apply|sequencer|reftable)(\/|$)/.test(relative)
    || /\.lock$/.test(relative) || (/^BISECT_/.test(relative) && relative !== 'BISECT_HEAD')) return 'unsafe';
  if (/^logs(?:\/|$)/.test(relative)) return 'reflog';
  if (/^refs(?:\/|$)/.test(relative)) return 'ref';
  if (relative === 'packed-refs') return 'packed';
  if (relative === 'FETCH_HEAD') return 'fetch';
  // HEAD resolves to tree.head, which is already a recovery root; skipping it
  // saves two Git spawns per retirement (#13154 spawn ceiling).
  if (relative === 'HEAD') return null;
  if (relative === 'MERGE_HEAD' || relative === 'shallow') return 'objects';
  if (['COMMIT_EDITMSG', 'MERGE_MSG', 'MERGE_MODE', 'MERGE_RR', 'SQUASH_MSG', 'TAG_EDITMSG', 'NOTES_EDITMSG'].includes(relative)) return null;
  // Worktree-private root refs use uppercase names. Unknown operation formats
  // must hold rather than silently omit recovery objects introduced by Git.
  return /^[A-Z][A-Z0-9_]*$/.test(relative) ? 'ref' : null;
}

async function recoveryObjectHeads(administration, { repoPath, tree, missingRoot }, work) {
  const heads = new Set([tree.head]);
  const oid = new RegExp(`^[a-f0-9]{${tree.head.length}}$`, 'i');
  const invalid = () => { throw new Error('unrecognized private recovery reference'); };
  const add = (value, allowZero = false) => {
    work.check();
    if (!oid.test(value)) invalid();
    if (/^0+$/.test(value)) { if (allowZero) return; invalid(); }
    heads.add(value.toLowerCase());
    if (heads.size > 1024) throw new Error('too many private recovery objects');
  };
  for (const link of administration.symlinks) {
    if (recoveryReferenceKind(link.path)) throw new Error('unsupported linked recovery reference');
  }
  for (const file of administration.files) {
    work.check();
    const kind = recoveryReferenceKind(file.path);
    if (!kind) continue;
    if (kind === 'unsafe') throw new Error('retirement-operation-active');
    const contents = (await archiveBytes(file.source, work, MAX_FILE_BYTES)).toString('utf8');
    const lines = contents.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    if (kind === 'ref') {
      if (lines.length !== 1) invalid();
      const symbolic = /^ref: (\S+)$/.exec(lines[0]);
      if (symbolic) {
        const prefix = missingRoot ? ['--git-dir', missingRoot, '--work-tree', tree.path] : [];
        work.check();
        await git([...prefix, 'check-ref-format', '--allow-onelevel', symbolic[1]], missingRoot ? repoPath : tree.path);
        work.check();
        add((await git([...prefix, 'rev-parse', '--verify', '--end-of-options', symbolic[1]], missingRoot ? repoPath : tree.path)).trim());
      } else add(lines[0]);
      continue;
    }
    if (kind === 'objects' && !lines.length) invalid();
    for (const line of lines) {
      work.check();
      if (kind === 'reflog') {
        const fields = /^([a-f0-9]+) ([a-f0-9]+) [^\t]+(?:\t.*)?$/i.exec(line);
        if (!fields) invalid();
        add(fields[1], true);
        add(fields[2], true);
      } else if (kind === 'fetch') {
        const fields = /^([a-f0-9]+)\t(?:not-for-merge)?\t.*$/i.exec(line);
        if (!fields) invalid();
        add(fields[1]);
      } else if (kind === 'packed') {
        if (line.startsWith('#')) continue;
        const fields = /^(?:([a-f0-9]+) refs\/\S+|\^([a-f0-9]+))$/i.exec(line);
        if (!fields) invalid();
        add(fields[1] || fields[2]);
      } else add(line);
    }
  }
  return heads;
}

/** Shared app-scoped preservation for merged and superseded checkouts.
 * Persist the original generation before archiving, then its exact preservation
 * receipt before the caller can remove anything under the retirement fence.
 */
export async function preserveSupersededCheckout({ appId, repoPath, tree, defaultBranch, cosDir }) {
  const [{ getAppById }, outcomes] = await Promise.all([import('./apps.js'), import('./branchReconcileOutcome.js')]);
  const app = appId && await getAppById(appId);
  if (!app?.repoPath || resolve(app.repoPath) !== resolve(repoPath)) throw new Error('retirement-receipt-scope-unavailable');
  if (!tree?.path || !tree.branch || tree.locked) throw new Error('retirement-checkout-unavailable');
  const release = { path: tree.path, branch: shortBranch(tree.branch), head: tree.head, locked: false, lockReason: null };
  const { readCompletedCheckoutIdentity } = await import('./completedCheckoutEvidence.js');
  const target = { repoPath, branch: release.branch, path: release.path, head: release.head };
  const identity = await readCompletedCheckoutIdentity(target);
  if (!identity) throw new Error('checkout-incarnation-unavailable');
  const checkoutIdentity = await readRetirementCheckoutIdentity(tree.path);
  if (!checkoutIdentity) throw new Error('checkout-incarnation-unavailable');
  const previous = await outcomes.getBranchReconcileOutcome(appId);
  if (unresolvedRetirements(previous).some(row => sameRelease(row, release)
    && JSON.stringify(row.checkoutIncarnation) !== JSON.stringify(identity.incarnation))) {
    throw new Error('retirement-checkout-generation-unverified');
  }
  const identityCurrent = async () => JSON.stringify(await readCompletedCheckoutIdentity(target)) === JSON.stringify(identity);
  const pending = await outcomes.recordBranchReconcileOutcome(appId, {
    status: 'incomplete', reason: 'retirement-receipt-unverified',
    retirementObligations: [{ ...release, checkoutIdentity, checkoutIncarnation: identity.incarnation, reason: 'retirement-review-pending' }],
    nextAction: 'Require complete preservation and an exact retirement receipt for the checkout.',
  });
  const obligation = pending?.retirementObligations?.find(row => sameRelease(row, release));
  if (!Number.isFinite(Date.parse(obligation?.createdAt))) throw new Error('retirement-obligation-unavailable');
  if (JSON.stringify(obligation.checkoutIncarnation) !== JSON.stringify(identity.incarnation)) throw new Error('retirement-checkout-generation-unverified');
  // Invalidate any earlier attempt's prepared receipt without dropping its
  // obligation. A crash must never let an older snapshot stand in for this one.
  await outcomes.recordHeldCheckoutPreservation(appId, { ...release, createdAt: obligation.createdAt, archiveDir: null, incarnation: identity.incarnation });
  const archive = await preserveMergedCheckout(repoPath, tree, defaultBranch, { cosDir });
  if (!await identityCurrent()) throw new Error('checkout-incarnation-changed');
  await outcomes.recordHeldCheckoutPreservation(appId, { ...release, createdAt: obligation.createdAt, archiveDir: archive.archiveDir, incarnation: identity.incarnation });
  const receiptCurrent = async () => {
    const currentApp = await getAppById(appId);
    if (!currentApp?.repoPath || resolve(currentApp.repoPath) !== resolve(repoPath)) return false;
    const current = await outcomes.getBranchReconcileOutcome(appId);
    return current?.retirementObligations?.some(row => sameRelease(row, release)
      && row.createdAt === obligation.createdAt && row.preservationReceipt?.status === 'preserved'
      && row.preservationReceipt.archiveDir === archive.archiveDir
      && JSON.stringify(row.preservationReceipt.incarnation) === JSON.stringify(identity.incarnation)
      && JSON.stringify(row.checkoutIncarnation) === JSON.stringify(identity.incarnation)) === true;
  };
  if (!await receiptCurrent()) throw new Error('retirement-preservation-receipt-unverified');
  return {
    archiveDir: archive.archiveDir,
    verify: async holder => !await receiptCurrent() ? 'retirement-preservation-receipt-changed'
      : !await identityCurrent() ? 'checkout-incarnation-changed' : archive.verify(holder),
    async recordRetirement() {
      if (!await receiptCurrent()) throw new Error('retirement-preservation-receipt-changed');
      const ref = await execGit(['rev-parse', '--verify', '--quiet', `refs/heads/${release.branch}`], repoPath, { ignoreExitCode: true });
      if (ref.exitCode !== 1 || !await historicalCheckoutAbsent(release, await listWorktrees(repoPath))) throw new Error('retirement-checkout-recreated');
      const outcome = await outcomes.recordHeldCheckoutRetirement(appId, { ...release, checkoutIdentity, branchDeleted: true, archiveDir: archive.archiveDir });
      if (!outcome?.retired?.some(row => sameRelease(row, release) && row.branchDeleted === true
        && row.archiveDir === archive.archiveDir && Date.parse(row.retiredAt) >= Date.parse(obligation.createdAt))) {
        throw new Error('retirement-receipt-unverified');
      }
    },
  };
}

async function writeArchive(dir, { repoPath, tree, branch, defaultBranch, release, review, missingRoot = null, work = archiveWork() }) {
  work.check();
  const [snapshot, administration] = await archiveSnapshots(tree, repoPath, missingRoot, work);
  const recoveryHeads = await recoveryObjectHeads(administration, { repoPath, tree, missingRoot }, work);
  await ensureDir(dir);
  await chmod(dir, 0o700);

  // A bundle keeps the original commit objects, merges included, which a
  // squash-merged branch would otherwise lose to garbage collection.
  const bundle = join(dir, 'commits.bundle');
  // Private refs and operation files can name any Git object: ort's AUTO_MERGE
  // names a tree containing conflict-resolution evidence, not a commit.
  // Named bundle roots preserve their reachable objects too. Unknown/missing
  // recovery objects still hold the checkout.
  const recoveryRefs = [];
  const namespace = `refs/portos/archive/${randomUUID()}`;
  try {
    for (const head of recoveryHeads) {
      work.check();
      const type = (await git(['cat-file', '-t', head], repoPath)).trim();
      if (!['commit', 'tree', 'blob', 'tag'].includes(type)) throw new Error('private recovery object has an unsupported type');
      work.check();
      const ref = `${namespace}/${head}`;
      await git(['update-ref', ref, head, ''], repoPath);
      recoveryRefs.push({ ref, head });
    }
    work.check();
    await git([...(missingRoot ? ['--git-dir', missingRoot, '--work-tree', tree.path] : []), 'bundle', 'create', bundle, 'HEAD', ...recoveryRefs.map(entry => entry.ref)], missingRoot ? repoPath : tree.path);
    work.check();
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
    work.check();
    const destination = join(dir, 'administration', file.path);
    await ensureDir(dirname(destination));
    await archiveCopy(file.source, destination, file.bytes, work);
    await chmod(destination, 0o600);
    if (await archiveHash(destination, work) !== file.sha256) throw new Error('administration archive mismatch');
  }
  if (snapshot.indexDiff.length) await writeFileGuarded(join(dir, 'index.diff'), snapshot.indexDiff);
  if (snapshot.worktreeDiff.length) await writeFileGuarded(join(dir, 'worktree.diff'), snapshot.worktreeDiff);

  const { files, symlinks } = snapshot;
  for (const file of files) {
    work.check();
    const destination = join(dir, 'files', file.path);
    await ensureDir(dirname(destination));
    await archiveCopy(join(tree.path, file.path), destination, file.bytes, work);
    if (await archiveHash(destination, work) !== file.sha256) throw new Error(`archived copy of ${file.path} does not match`);
  }
  // Re-read after every copy so the check covers the whole archive window.
  const [after, administrationAfter] = await archiveSnapshots(tree, repoPath, missingRoot, work);
  if (administrationAfter.fingerprint !== administration.fingerprint) throw new Error('administration changed while archiving');
  if (after.fingerprint !== snapshot.fingerprint) throw new Error('checkout content changed while archiving');

  const manifest = {
    resourceContract: 1,
    repoPath, defaultBranch, path: tree.path, head: tree.head, branch,
    release, review, administration: { ...administration, files: administration.files.map(({ source: _source, ...file }) => file) }, archivedAt: new Date().toISOString(),
    bundleSha256: await archiveHash(bundle, work, Infinity),
    patchHashes: { index: evidenceHash(snapshot.indexDiff), worktree: evidenceHash(snapshot.worktreeDiff) },
    captured: { commitBundle: true, recoveryHeads: [...recoveryHeads], ...(snapshot.missingCheckout ? { missingCheckout: true } : {}), gitlinks: snapshot.gitlinks, indexDiff: Boolean(snapshot.indexDiff.length), worktreeDiff: Boolean(snapshot.worktreeDiff.length), files, symlinks },
    restore: [
      'git -C <repo> fetch commits.bundle HEAD:refs/heads/<restored-branch>',
      'git -C <repo> fetch commits.bundle "+refs/portos/archive/*:refs/portos/recovered/*"',
      `git -C <repo> worktree add <checkout> ${tree.head}`,
      snapshot.indexDiff.length ? 'git -C <checkout> apply --index index.diff' : null,
      snapshot.worktreeDiff.length ? 'git -C <checkout> apply worktree.diff' : null,
      // Last, so raw tracked bytes replace the filtered form the diffs restore.
      files.length ? 'cp -R files/. <checkout>/' : null,
      symlinks.length ? 'recreate manifest.captured.symlinks with ln -s' : null,
    ].filter(Boolean),
  };
  // Check the exact payload atomicWrite receives: escaped review text can make
  // the manifest larger than its individually bounded Git diff inputs.
  const serialized = JSON.stringify(manifest, null, 2);
  const manifestBytes = Buffer.byteLength(serialized);
  if (manifestBytes > MAX_MANIFEST_BYTES) throw Object.assign(new Error('archive-manifest-budget-exceeded'), {
    archiveLimit: { scope: 'manifest', kind: 'total', limitBytes: MAX_MANIFEST_BYTES, observedBytes: manifestBytes },
  });
  work.check();
  await atomicWrite(join(dir, 'manifest.json'), serialized);
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

/** Optional server inventory identity binds private administration as well as
 * the pointer file. Callers have already checked the exact released lock under
 * the retirement fence; allowing a fact-read does not authorize unlocking it. */
async function matchesObservedCheckoutIncarnation(repoPath, release, worktrees = null) {
  if (!release.checkoutIncarnation) return true;
  const { readCompletedCheckoutIdentity } = await import('./completedCheckoutEvidence.js');
  const current = await readCompletedCheckoutIdentity({ repoPath, ...release, worktrees,
    allowLocked: release.locked === true }).catch(() => null);
  return current && JSON.stringify(current.incarnation) === JSON.stringify(release.checkoutIncarnation);
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
  if (!await matchesObservedCheckoutIncarnation(repoPath, release, trees)) return { reason: 'checkout-identity-changed' };
  // Carry the persisted release spelling through archive/receipt publication.
  // Native lexical resolution above proves it names this registration; fresh
  // head, lock and incarnation checks still bind the filesystem generation.
  return { tree: { ...tree, path: release.path } };
}

/** Shared live policy/owner check for the explicit whole-checkout transaction.
 * It does not archive, unlock or infer integration.
 */
export async function inspectCheckoutRetirementOwnership({ repoPath, release, registration = true, reviewIdentity = {}, forgeAccount = null }, opts = {}) {
  if (!release.branch || PROTECTED_BRANCHES.includes(release.branch)) return { ok: false, reason: 'protected-branch' };
  const matched = registration ? await matchRelease(repoPath, release) : { tree: release };
  if (!matched.tree) return { ok: false, reason: matched.reason };
  const reason = await ownerReason({ repoPath, tree: matched.tree, branch: release.branch,
    readAgents: opts.readAgents || readClaimOwnershipAgents, reviewed: true });
  if (reason) return { ok: false, reason };
  const policy = await retirementPolicy(repoPath, release.branch, { ...opts, forgeAccount: opts.forgeAccount ?? forgeAccount }, reviewIdentity);
  return policy.reason ? { ok: false, reason: policy.reason } : { ok: true, tree: matched.tree, policy };
}

/**
 * Remove one held checkout under an operator's scoped release. Nothing is copied.
 *
 * @param {{ repoPath: string, release: { path: string, head: string, branch: string|null, locked: boolean, lockReason: string|null } }} input
 * @param {{ cosDir?: string, readAgents?: () => Promise<object[]|null> }} [opts]
 * @returns {Promise<{ ok: true, branchDeleted: boolean, checkoutIdentity?: string, branchRetainedReason?: string } | { ok: false, reason: string, detail?: string }>}
 */
async function retireHeldCheckout({ repoPath, release, review }, opts = {}) {
  // A destructive recheck can verify existing preservation, never recreate it.
  opts = { ...opts, retainMissingSource: false };
  const { readAgents = readClaimOwnershipAgents } = opts;
  // Only the unattended merged-retirement caller sets this, and only without a review.
  const mergedObligationSettled = !review && opts.settleMergedReviewObligation === true;
  const branch = release.branch ?? null;
  if (branch && PROTECTED_BRANCHES.includes(branch)) return { ok: false, reason: 'protected-branch' };
  const defaultBranch = await getDefaultBranch(repoPath, { allowRemote: false, strict: true }).catch(() => null);
  if (!defaultBranch) return { ok: false, reason: 'default-branch-unavailable' };
  if (branch === defaultBranch) return { ok: false, reason: 'protected-branch' };

  const { retainReleaseSynchronizationReview, prepareLegacyReleaseRetirement } = await import('./releaseSynchronization.js');
  const scopedRelease = { ...release, repoPath, checkoutIdentity: release.checkoutIdentity || await readRetirementCheckoutIdentity(release.path) };
  const retainedReview = await retainReleaseSynchronizationReview(scopedRelease).catch(() => false);
  if (!retainedReview) return { ok: false, reason: 'release-sync-local-review-unretained' };
  const legacyProofs = await prepareLegacyReleaseRetirement(scopedRelease).catch(() => null);
  if (!legacyProofs) return { ok: false, reason: 'legacy-release-recovery-changed' };
  opts = { ...opts, legacyProofs };

  // Every ownership check queues behind the claim-ownership lock with a short
  // budget, so the archive runs between two critical sections (#12682).
  const refuse = (reason, archiveLimit, nextAction) => ({ result: { ok: false, reason, ...(archiveLimit && { archiveLimit }), ...(nextAction && { nextAction }) } });
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
      // A reviewed checkout can be integrated on the forge while local main still
      // lags (squash, or a reset default). Local ancestry remains the proof when
      // no review was supplied. Supersession acceptance never covers that lag.
      const locallyMerged = branch
        ? await hasBranchMergeEvidence(repoPath, branch, defaultBranch).catch(() => false)
        : await isAncestor(repoPath, tree.head, defaultBranch);
      if (!locallyMerged && !review) return refuse('not-merged-on-recheck');
      // Status must not refresh the private index bound into the review digest.
      const porcelain = await getStatusPorcelain(tree.path).catch(() => null);
      if (porcelain === null) return refuse('worktree-status-unavailable');
      if (!classifyWorktreeDirt(porcelain).clean) return refuse('worktree-dirty');
      const reviewed = review ? await reviewCurrentCheckout({ repoPath, release, prUrl: review.prUrl, kind: review.kind }, opts) : null;
      if (reviewed && (!reviewed.ok || reviewed.review.digest !== review.digest)) return refuse(reviewed.reason || 'retirement-review-changed', reviewed.archiveLimit, reviewed.nextAction);
      const disposition = reviewed?.review.comparison.disposition;
      if (disposition === 'review-supersession' && !acceptedPreservedSupersession(review, reviewed?.review)
        && (!locallyMerged || review.acceptSuperseded !== true)) return refuse('retirement-supersession-not-accepted');
      if (!locallyMerged && disposition !== 'integrated' && !acceptedPreservedSupersession(review, reviewed?.review)) return refuse('not-merged-on-recheck');
      const owner = await ownerReason({ repoPath, tree, branch, readAgents, reviewed: Boolean(review), mergedObligationSettled });
      if (owner) return refuse(owner);
      return { fence: { repoPath, path: tree.path, branch }, tree, reviewed, checkoutIdentity };
    },
    archive: async ({ tree, reviewed }) => {
      try {
        const preservedSupersession = acceptedPreservedSupersession(review, reviewed?.review);
        if (preservedSupersession) {
          if (!await opts.preserveSupersession?.(reviewed.review)) throw new Error('retirement-source-preservation-unavailable');
        }
        if (opts.signal?.aborted) throw new Error('retirement-archive-cancelled');
        const status = await getStatusPorcelain(tree.path).catch(() => null);
        if (status === null) throw new Error('worktree-status-unavailable');
        if (!classifyWorktreeDirt(status).clean) throw new Error('worktree-dirty');
        const mergedNow = branch
          ? await hasBranchMergeEvidence(repoPath, branch, defaultBranch).catch(() => false)
          : await isAncestor(repoPath, tree.head, defaultBranch);
        // Finish re-reads the review. A forge-integrated detached or lagging
        // checkout is not an ancestor of local main yet.
        if (!mergedNow && !review) throw new Error('not-merged-on-recheck');
        return { archive: { disposable: true } };
      } catch (error) {
        const reason = ['worktree-dirty', 'not-merged-on-recheck', 'worktree-status-unavailable', 'retirement-archive-cancelled'].includes(error.message)
          ? error.message : 'checkout-not-disposable';
        return { result: { ok: false, reason, ...(reason === 'checkout-not-disposable' && { detail: error.message }) } };
      }
    },
    finish: async ({ tree, reviewed, checkoutIdentity }) => {
      const result = await finishHeldCheckoutRetirement({ repoPath, release, review, reviewed, tree, branch, defaultBranch, checkoutIdentity, mergedObligationSettled }, opts);
      const validationEvidence = forgeValidationEvidence(reviewed?.review);
      return result.ok ? { ...result, checkoutIdentity, ...(validationEvidence && { validationEvidence }) } : result;
    },
  });
}

/** The merged PR's required CI is the validation record for its exact head. */
export const forgeValidationEvidence = review => (review && !review.kind && review.comparison?.disposition === 'integrated'
  && review.release?.head === review.forge?.prHead
  ? { source: 'forge-pr', prUrl: review.forge.prUrl, prHead: review.forge.prHead, mergeCommit: review.forge.mergeCommit } : null);

const acceptedPreservedSupersession = (review, prepared) => review?.kind === 'preserved-supersession'
  && review.acceptSuperseded === true && prepared?.comparison?.disposition === 'review-supersession'
  && prepared.preservedSource?.head === prepared.release.head;

/** The second critical section: re-prove the release, ownership and a clean tree, then remove. */
async function finishHeldCheckoutRetirement({ repoPath, release, review, reviewed, tree, branch, defaultBranch, checkoutIdentity, mergedObligationSettled = false }, opts) {
  const { readAgents = readClaimOwnershipAgents } = opts;
  if (opts.signal?.aborted) return { ok: false, reason: 'retirement-archive-cancelled' };
  const second = await matchRelease(repoPath, release);
  if (!second.tree) return { ok: false, reason: second.reason };
  if (await readRetirementCheckoutIdentity(tree.path) !== checkoutIdentity) return { ok: false, reason: 'checkout-identity-changed' };
  const { validateLegacyReleaseRetirement } = await import('./releaseSynchronization.js');
  const legacyCurrent = unlocked => validateLegacyReleaseRetirement({ ...release, repoPath, checkoutIdentity }, { unlocked, archiveProofs: opts.legacyProofs }).catch(() => false);
  if (!await legacyCurrent(false)) return { ok: false, reason: 'legacy-release-recovery-changed' };
  await opts.beforeMutation?.();
  if (release.locked) {
    const unlocked = await execGit(['worktree', 'unlock', tree.path], repoPath).then(() => true, () => false);
    if (!unlocked) return { ok: false, reason: 'worktree-unlock-failed' };
  }
  let capacityRefusal;
  let reviewedLinks = [];
  const removedLinks = [];
  let linksPrepared = false;
  const verifyRemoval = async (holder) => {
    if (opts.signal?.aborted) return 'retirement-archive-cancelled';
    if (!holder || holder.head !== tree.head || shortBranch(holder.branch) !== branch) return 'worktree-holder-changed';
    if (!await matchesObservedCheckoutIncarnation(repoPath, release)) return 'checkout-identity-changed';
    if (await readRetirementCheckoutIdentity(tree.path) !== checkoutIdentity) return 'checkout-identity-changed';
    if (!await legacyCurrent(release.locked)) return 'legacy-release-recovery-changed';
    if (opts.inventoryCurrent && !await opts.inventoryCurrent()) return 'release-not-in-inventory';
    const [reason, fresh, porcelain] = await Promise.all([
      ownerReason({ repoPath, tree, branch, readAgents, reviewed: Boolean(review), mergedObligationSettled }),
      review ? reviewCurrentCheckout({ repoPath, release, prUrl: review.prUrl, kind: review.kind, unlocked: release.locked }, opts,
        content => { reviewedLinks = content.symlinks; }) : null,
      getStatusPorcelain(tree.path).catch(() => null),
    ]);
    if (fresh && !fresh.ok) { capacityRefusal = fresh; return fresh.reason; }
    if (fresh && fresh.review.digest !== review.digest) return 'retirement-review-changed';
    if (acceptedPreservedSupersession(review, fresh?.review)
      && !await opts.preserveSupersession?.(fresh.review)) return 'retirement-source-preservation-unavailable';
    if (porcelain === null || !classifyWorktreeDirt(porcelain).clean) return 'worktree-dirty';
    const locallyMerged = branch
      ? await hasBranchMergeEvidence(repoPath, branch, defaultBranch).catch(() => false)
      : await isAncestor(repoPath, tree.head, defaultBranch);
    const disposition = fresh?.review?.comparison?.disposition;
    if (disposition === 'review-supersession' && !acceptedPreservedSupersession(review, fresh?.review)
      && (!locallyMerged || review.acceptSuperseded !== true)) return 'retirement-supersession-not-accepted';
    if (!locallyMerged && disposition !== 'integrated' && !acceptedPreservedSupersession(review, fresh?.review)) return 'not-merged-on-recheck';
    if (reason) return reason;
    if (opts.signal?.aborted) return 'retirement-archive-cancelled';
    return null;
  };
  const removal = await forceRemoveWorktreeDir(repoPath, tree.path, {
    label: '🧹 held-checkout recovery: remove checkout', log: 'all', verifyRemoval,
    beforeMutation: async () => {
      await opts.beforeMutation?.();
      // The removal helper also calls this hook before pruning registration.
      if (linksPrepared) return;
      linksPrepared = true;
      // Git for Windows leaves junctions behind (git-for-windows/git#6151).
      // Unlink only freshly reviewed links after the final removal gate, never
      // recursively delete their targets or use a fallback checkout remover.
      const work = archiveWork(opts.signal);
      for (const link of reviewedLinks) {
        const { rel, info } = await listedContentEntry(tree.path, link.path, work);
        if (rel !== link.path || !info.isSymbolicLink()
          || archiveText(await readlink(join(tree.path, rel), { encoding: 'buffer' })) !== link.target) throw new Error('retirement-review-changed');
        // Ordinary file links are already handled by Git. Only directory links
        // need this preparation; inspect target metadata without reading bytes.
        const target = await stat(join(tree.path, rel)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (!target?.isDirectory()) continue;
        await unlink(join(tree.path, rel));
        removedLinks.push(link);
      }
    },
  });
  if (!removal.removed) {
    let linkRestoreFailed = false;
    // A refused Git removal may leave the original generation intact. Restore
    // its links without overwriting anything a concurrent writer created.
    if (removedLinks.length && await readRetirementCheckoutIdentity(tree.path) === checkoutIdentity) {
      for (const link of removedLinks) {
        const parent = link.path.split('/').slice(0, -1).join('/');
        const parentSafe = !parent || await listedContentEntry(tree.path, parent, archiveWork())
          .then(entry => entry.rel === parent && entry.info.isDirectory(), () => false);
        const restored = parentSafe && await symlink(link.target, join(tree.path, link.path), process.platform === 'win32' ? 'junction' : 'dir')
          .then(() => true, () => false);
        if (!restored) linkRestoreFailed = true;
      }
    }
    // Hand the lock back exactly as released. A lock someone took in the
    // meantime makes this fail, which is the outcome we want anyway.
    if (release.locked) {
      const args = ['worktree', 'lock', ...(release.lockReason != null ? ['--reason', release.lockReason] : []), tree.path];
      await execGit(args, repoPath).catch(err => console.warn(`⚠️ held-checkout recovery: could not restore lock on ${tree.path}: ${err.message}`));
    }
    if (linkRestoreFailed) return { ok: false, reason: 'retirement-link-restore-failed' };
    return capacityRefusal || { ok: false, reason: removal.reason || 'worktree-remove-failed' };
  }
  console.log(`🧹 held-checkout recovery: retired ${tree.path}`);
  if (!branch) return { ok: true, branchDeleted: false };

  const hold = await ownerReason({ repoPath, tree: { ...tree, path: null }, branch, readAgents, reviewed: Boolean(review), mergedObligationSettled });
  if (hold) return { ok: true, branchDeleted: false, branchRetainedReason: hold };
  if (review) {
    const { readRetirementForgeEvidence } = await import('./heldCheckoutReview.js');
    const forge = await (opts.readForge || readRetirementForgeEvidence)(repoPath, branch, review.prUrl, reviewForgeOptions(release, review.kind, opts)).catch(() => null);
    const policies = reviewed.review.policy?.policies || [];
    const captured = policies.find(row => row.continuedDelivery)?.continuedDelivery.checkoutIncarnation
      || policies.find(row => row.resumedCleanup)?.resumedCleanup.checkoutIncarnation
      || policies.find(row => row.retainedSiblingObligation?.releasedCopyIncarnation)?.retainedSiblingObligation.releasedCopyIncarnation;
    const identity = await integratedPolicyReviewIdentity(repoPath, release, review.prUrl, forge, captured);
    const policy = identity ? await retirementPolicy(repoPath, branch, opts, identity) : null;
    if (JSON.stringify(policy) !== JSON.stringify(reviewed.review.policy) || JSON.stringify(forge) !== JSON.stringify(reviewed.review.forge)) {
      return { ok: true, branchDeleted: false, branchRetainedReason: 'retirement-evidence-changed' };
    }
  }
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

/** Tuple-only clients remain compatible; only persisted observation identity
 * enters the review digest. Scan times are not incarnation identity.
 */
function bindInventoriedRelease(outcome, release) {
  const entry = outcome?.remaining?.find(row => sameRelease(row, release));
  if (!entry) return null;
  return { path: release.path, head: release.head, branch: release.branch ?? null,
    locked: release.locked, lockReason: release.lockReason ?? null,
    ...(entry.checkoutIdentity && { checkoutIdentity: entry.checkoutIdentity }),
    ...(entry.checkoutIncarnation && { checkoutIncarnation: entry.checkoutIncarnation }) };
}

// Preview and receipt paths may acquire exact server-verified proof commits
// into the object store, never a branch, index or implicit approval.
export async function fetchRetirementProofObjects(repoPath, release, prUrl, expectedHeadSha, opts) {
  const [{ readRetirementForgeEvidence }, { getOriginInfo }, { resolveForgeExecOptions }] = await Promise.all([
    import('./heldCheckoutReview.js'), import('../lib/gitRemote.js'), import('./forgeExecOptions.js'),
  ]);
  const forge = await (opts.readForge || readRetirementForgeEvidence)(repoPath, release.branch, prUrl, { ...opts, ...(!opts.sourceSupersessionHead && { exactDeliveredHead: release.head }) }).catch(() => null);
  const origin = await getOriginInfo(repoPath).catch(() => null);
  if (!origin || !forge || forge.repository !== `${origin.host}/${origin.fullName}` || forge.prUrl !== prUrl) {
    return { ok: false, reason: 'retirement-pr-repository-mismatch' };
  }
  if (expectedHeadSha !== null && forge.prHead !== expectedHeadSha) return { ok: false, reason: 'receipt-pr-head-changed' };
  const exactDelivery = !opts.sourceSupersessionHead && ((forge.scopeProof === 'exact-delivered-head' && forge.prHead === release.head)
    || (forge.scopeProof === 'ancestor-of-delivered-head' && Boolean(release.branch) && forge.deliveredAncestorHead === release.head));
  const representedDetached = !release.branch && !opts.sourceSupersessionHead
    && forge.scopeProof === 'represented-detached-head' && forge.exactAliasHead === release.head
    && forge.detachedRepresentation?.sourceHead === release.head
    && forge.detachedRepresentation.deliveredHead === forge.prHead;
  const heads = [...new Set([forge.prHead, forge.mergeCommit, forge.targetHead ?? forge.defaultHead,
    ...(exactDelivery || representedDetached ? [forge.defaultHead] : [forge.changeBase, forge.firstCommit]),
    ...(representedDetached ? [forge.detachedRepresentation.sourceHead, forge.detachedRepresentation.base] : [])])];
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
  const result = await retireHeldCheckout({ repoPath, release,
    review: { prUrl, digest: prepared.review.digest, acceptSuperseded: false },
  }, receiptOptions);
  if (result.ok) {
    const { recordWorkspaceCheckoutRetirement } = await import('./branchReconcileOutcome.js');
    await recordWorkspaceCheckoutRetirement(repoPath, {
      path: release.path, branch: release.branch ?? null, head: release.head,
      branchDeleted: result.branchDeleted, ...(result.archiveDir && { archiveDir: result.archiveDir }), checkoutIdentity: result.checkoutIdentity,
      ...(result.validationEvidence && { validationEvidence: result.validationEvidence }),
    });
  }
  return result;
}

/**
 * The Schedule view's entry point: the release must name a row of the app's
 * last persisted inventory exactly, so it binds to evidence the operator saw.
 */
export async function retireInventoriedCheckout({ appId, release, review }, opts) {
  const [{ getAppById }, outcomes] = await Promise.all([import('./apps.js'), import('./branchReconcileOutcome.js')]);
  const app = await getAppById(appId);
  if (!app?.repoPath) return { ok: false, reason: 'app-not-found' };
  const outcome = await outcomes.getBranchReconcileOutcome(appId);
  const retired = bindRemovedCheckoutRelease(outcome, release);
  if (retired) return finalizeRemovedCheckoutBranch({ appId, release: retired, review }, opts);
  release = bindInventoriedRelease(outcome, release);
  if (!release) return { ok: false, reason: 'release-not-in-inventory' };
  const inventoryCurrent = async () => (await outcomes.getBranchReconcileOutcome(appId))?.remaining?.some(entry => sameRelease(entry, release)) === true;
  const result = await retireHeldCheckout({ repoPath: app.repoPath, release, review }, { ...opts, inventoryCurrent, forgeAccount: app.forgeAccount ?? null,
    preserveSupersession: async prepared => outcomes.recordSupersededCheckoutPreservation(appId, release, prepared),
  });
  // A missing original cannot be archived retroactively. Retain its exact
  // identity for provenance recovery rather than equating absence with success.
  if (!result.ok && result.reason === 'checkout-not-found') {
    const gone = await findGoneInventoryRows(app.repoPath, [release]).catch(() => []);
    if (gone.length) {
      await outcomes.recordMissingInventoryRows(appId, gone);
      return { ok: false, reason: 'retirement-provenance-unverified' };
    }
  }
  if (result.ok) {
    await outcomes.recordHeldCheckoutRetirement(appId, {
      path: release.path, branch: release.branch ?? null, head: release.head, branchDeleted: result.branchDeleted,
      ...(result.validationEvidence && { validationEvidence: result.validationEvidence }),
      ...(!release.branch && { checkoutOnly: true }),
      ...(result.archiveDir && { archiveDir: result.archiveDir }), checkoutIdentity: result.checkoutIdentity,
      ...(review?.kind === 'preserved-supersession' && { supersessionDigest: review.digest }),
    });
  }
  return result;
}

/** Canonical physical removal, not missing inventory, selects ref finalization.
 * Ambiguous generations stay unresolved; callers cannot invent a receipt. */
function removedCheckoutReceipts(outcome) {
  const rows = [...(outcome?.retired || []), ...Object.values(outcome?.retirementReceiptEvidence || {})];
  const unique = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.path, row.branch, row.head, row.checkoutIdentity, row.retiredAt]);
    if (!unique.has(key) || (row.branchDeleted === true && row.branchFinalizedAt)) unique.set(key, row);
  }
  return [...unique.values()];
}

function bindRemovedCheckoutRelease(outcome, release) {
  const matches = removedCheckoutReceipts(outcome).filter(row => row.path === release.path && row.branch === release.branch
    && row.head === release.head && release.branch && row.checkoutIdentity && Number.isFinite(Date.parse(row.retiredAt))
    && (row.branchDeleted === false || (row.branchDeleted === true && row.branchFinalizedAt))
    && (!release.checkoutIdentity || row.checkoutIdentity === release.checkoutIdentity)
    && (!release.retiredAt || row.retiredAt === release.retiredAt));
  const unique = new Map(matches.map(row => [JSON.stringify([row.checkoutIdentity, row.retiredAt]), row]));
  if (unique.size !== 1) return null;
  const receipt = [...unique.values()][0];
  return { ...release, checkoutIdentity: receipt.checkoutIdentity, retiredAt: receipt.retiredAt };
}

async function reviewRemovedCheckoutBranch({ appId, release, prUrl, kind }, opts = {}) {
  if (kind) return { ok: false, reason: 'retirement-exact-delivery-required' };
  const [{ getAppById }, { getBranchReconcileOutcome }, { buildCheckoutRetirementReview, readRetirementForgeEvidence }] = await Promise.all([
    import('./apps.js'), import('./branchReconcileOutcome.js'), import('./heldCheckoutReview.js'),
  ]);
  const app = await getAppById(appId);
  if (!app?.repoPath) return { ok: false, reason: 'app-not-found' };
  const outcome = await getBranchReconcileOutcome(appId);
  if (!bindRemovedCheckoutRelease(outcome, release)) return { ok: false, reason: 'retirement-removal-receipt-changed' };
  const receipt = removedCheckoutReceipts(outcome).find(row => row.path === release.path && row.branch === release.branch
    && row.head === release.head && row.checkoutIdentity === release.checkoutIdentity && row.retiredAt === release.retiredAt);
  if (PROTECTED_BRANCHES.includes(release.branch)) return { ok: false, reason: 'protected-branch' };
  const absent = await lstat(release.path).then(() => false, error => error.code === 'ENOENT');
  if (!absent) return { ok: false, reason: 'checkout-path-recreated' };
  const holders = await listWorktrees(app.repoPath).catch(() => null);
  if (!holders || holders.some(row => shortBranch(row.branch) === release.branch)) return { ok: false, reason: 'branch-has-new-holder' };
  const ref = `refs/heads/${release.branch}`;
  // show-ref exit 1 also covers broken symbolic and malformed loose refs, so
  // only the bounded files-backend inspection can establish actual absence.
  const { readLocalBranchPresence } = await import('./repoCleanupObservation.js');
  const presence = await readLocalBranchPresence(app.repoPath, release.branch);
  if (presence === null) return { ok: false, reason: 'branch-ref-presence-unverified' };
  // Never treat a symbolic ref as the reviewed direct branch, even if its
  // target currently resolves to the same commit.
  if (presence) {
    const symbolic = await execGit(['symbolic-ref', '--quiet', ref], app.repoPath,
      { ignoreExitCode: true }).catch(() => null);
    if (symbolic?.exitCode !== 1) return { ok: false, reason: 'branch-ref-presence-unverified' };
  }
  const missing = presence === false;
  const tip = missing ? null : await execGit(['rev-parse', '--verify', ref], app.repoPath).then(row => row.stdout.trim(), () => null);
  if ((!missing && tip !== release.head) || (receipt.branchDeleted === true && !missing)) {
    return { ok: false, reason: 'branch-ref-changed-or-recreated' };
  }
  const owner = await ownerReason({ repoPath: app.repoPath, tree: { path: release.path }, branch: release.branch,
    readAgents: opts.readAgents || readClaimOwnershipAgents, reviewed: true });
  if (owner) return { ok: false, reason: owner };
  const options = { ...opts, forgeAccount: app.forgeAccount ?? null };
  const forge = await (opts.readForge || readRetirementForgeEvidence)(app.repoPath, release.branch, prUrl,
    reviewForgeOptions(release, null, options)).catch(() => null);
  if (forge?.prUrl !== prUrl || forge.prHead !== release.head || forge.scopeProof !== 'exact-delivered-head') {
    return { ok: false, reason: 'retirement-exact-delivery-unverified' };
  }
  const identity = await integratedPolicyReviewIdentity(app.repoPath, release, prUrl, forge);
  if (!identity) return { ok: false, reason: 'retirement-local-objects-missing' };
  const policy = await retirementPolicy(app.repoPath, release.branch, options, identity);
  if (policy.reason) return { ok: false, reason: policy.reason };
  // A retry after ref CAS/persistence failure reviews the same physical removal.
  // Actual ref absence changes the action, never the original receipt or grant.
  const { branchFinalizedAt: _finalizedAt, branchFinalization: _finalization,
    settledObservations: _settledObservations, ...removalReceipt } = receipt;
  const review = await buildCheckoutRetirementReview({ repoPath: app.repoPath,
    release: { ...release, appId, receipt: { ...removalReceipt, branchDeleted: false } }, prUrl,
    contentFingerprint: null, administrationFingerprint: null, policy }, { readForge: async () => forge })
    .catch(error => ({ reason: /^retirement-[a-z-]+$/.test(error.message) ? error.message : 'retirement-review-unavailable' }));
  return review.reason ? { ok: false, reason: review.reason } : { ok: true, review, missing };
}

async function prepareRemovedCheckoutBranch(input, opts) {
  const prepared = await withClaimOwnershipLock(() => reviewRemovedCheckoutBranch(input, opts));
  return prepared.ok ? { ok: true, review: prepared.review } : prepared;
}

async function finalizeRemovedCheckoutBranch({ appId, release, review }, opts = {}) {
  if (!review || review.kind || review.acceptSuperseded) return { ok: false, reason: 'retirement-exact-delivery-required' };
  return withClaimOwnershipLock(async () => {
    const input = { appId, release, prUrl: review.prUrl };
    const current = await reviewRemovedCheckoutBranch(input, opts);
    if (!current.ok) return current;
    if (current.review.digest !== review.digest) return { ok: false, reason: 'retirement-review-changed' };
    const recheck = async () => {
      await opts.beforeMutation?.();
      const fresh = await reviewRemovedCheckoutBranch(input, opts);
      if (!fresh.ok || fresh.review.digest !== review.digest) throw new Error(fresh.reason || 'retirement-review-changed');
      return fresh;
    };
    const record = async kind => {
      const { recordRetiredCheckoutBranchFinalization } = await import('./branchReconcileOutcome.js');
      await recordRetiredCheckoutBranchFinalization(appId, release, kind);
    };
    let branchDeleted = false;
    const result = await (async () => {
      if (current.missing) {
        const fresh = await recheck();
        if (!fresh.missing) return false;
        branchDeleted = true;
        await record('observed-absent');
        return true;
      }
      return deleteCompletedLocalBranch(current.review.repoPath, release.branch, release.head, {
        beforeMutation: recheck,
        onRetired: async () => { branchDeleted = true; await record('deleted'); },
      });
    })().catch(error => ({ reason: error.message }));
    return result === true ? { ok: true, branchDeleted: true } : { ok: false, ...(branchDeleted && { branchDeleted: true }),
      reason: result?.reason || 'branch-ref-changed-or-delete-failed' };
  });
}
