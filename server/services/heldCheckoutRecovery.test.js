/**
 * Scoped retirement of held checkouts through real Git (#12002): a release
 * binds to the exact inventory row, every unique byte is archived before any
 * mutation, and an ownership change or archive failure leaves the checkout,
 * its lock and its branch as found.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { cp, mkdtemp, mkdir, rm, rename, writeFile, readFile, readdir, symlink, utimes, truncate } from 'fs/promises';
import { existsSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { execGit } from '../lib/execGit.js';
import { materializeGitRepo, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { PATHS } from '../lib/paths.js';

// Local branch deletion archives the common reflog using PATHS.cos, independently
// of the checkout archive's explicit cosDir option.
vi.mock('../lib/paths.js', async importOriginal => makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-held-branch-archives-') }));
afterAll(cleanupTempDataRoots);

const SYMLINKS = process.platform !== 'win32';
const retirementFaults = vi.hoisted(() => ({ onRemove: null, onBranchDelete: null, scheduleWrites: 0, failScheduleWrite: null }));
const injected = vi.hoisted(() => ({ policies: [], schedule: null, app: null, fetchRemote: null, fetches: [], onBundle: null, onEvidence: null, proofFailures: [] }));

vi.mock('../lib/execGit.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, execGit: async (args, cwd, options) => {
    // Pauses an archive mid-write, after its first snapshot and before its re-read.
    if (injected.onBundle && args.includes('bundle') && args.includes('create')) await injected.onBundle();
    if (injected.onEvidence && args[0] === 'bundle' && args[1] === 'verify') await injected.onEvidence();
    if (retirementFaults.onRemove && args[0] === 'worktree' && args[1] === 'remove') await retirementFaults.onRemove();
    if (retirementFaults.onBranchDelete && args[0] === 'push' && args.some(arg => arg.startsWith(':refs/heads/'))) await retirementFaults.onBranchDelete();
    if (args.includes('credential.helper=!gh auth git-credential') && args.includes('fetch')) {
      injected.fetches.push({ args, options });
      if (injected.fetchRemote) args = args.map(arg => arg === 'https://github.com/example/repo.git' ? injected.fetchRemote : arg);
    }
    try { return await actual.execGit(args, cwd, options); }
    catch (error) {
      const phase = args.includes('unbundle') ? 'unbundle' : args.includes('fsck') ? 'fsck' : args.includes('--bare') ? 'init' : null;
      if (phase && options?.env?.GIT_NO_REPLACE_OBJECTS === '1') {
        // Persisted evidence hides child stderr; retain bounded fixture-only diagnostics.
        let message = String(error.message);
        for (const root of [cwd, tmpdir(), realpathSync(tmpdir())]) {
          message = message.split(root).join('<temp>').split(root.replaceAll('\\', '/')).join('<temp>');
        }
        injected.proofFailures.push({ phase, message: message.replace(/\s+/g, ' ').slice(0, 500) });
      }
      throw error;
    }
  } };
});
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: async () => ({ env: { ...process.env, GH_TOKEN: 'synthetic-account-token' } }) }));

vi.mock('./branchCompletionPolicy.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, readBranchCompletionPolicies: async () => injected.policies, readBranchCompletionHold: input => actual.readBranchCompletionHold(input, {
    readPolicies: async () => injected.policies,
  }) };
});
vi.mock('./taskScheduleStore.js', async (importOriginal) => ({
  ...await importOriginal(),
  loadSchedule: async () => injected.schedule,
  updateSchedule: async mutate => {
    if (++retirementFaults.scheduleWrites === retirementFaults.failScheduleWrite) throw new Error('synthetic receipt persistence failure');
    return (await mutate(injected.schedule)).result;
  },
}));
vi.mock('./apps.js', () => ({ getAppById: async (id) => (injected.app?.id === id ? injected.app : null) }));

const { retireInventoriedCheckout, prepareInventoriedCheckoutRetirement, retirePendingMergeCheckout, heldCheckoutArchiveRoot, preserveMergedCheckout, recoverMissingCheckoutPreservations, findMissingCheckoutPreservation } = await import('./heldCheckoutRecovery.js');
const { sha256File } = await import('../lib/fileUtils.js');
const { recordBranchReconcileOutcome, getBranchReconcileOutcome, recordHeldCheckoutRetirement, parkPerpetual } = await import('./taskSchedule.js');
const { withClaimOwnershipLock, checkReconcileOwnership } = await import('./cosClaimOwnership.js');

describe.skipIf(SKIP_HEAVY_INTEGRATION)('held checkout recovery (real git)', () => {
  let scratch;
  let repo;
  let external;
  let cosDir;
  const noOwners = async () => [];

  beforeEach(async () => {
    Object.assign(retirementFaults, { onRemove: null, onBranchDelete: null, scheduleWrites: 0, failScheduleWrite: null });
    Object.assign(injected, { policies: [], schedule: { tasks: {}, executions: {} }, app: { id: 'app-1', repoPath: null }, fetchRemote: null, fetches: [], onBundle: null, onEvidence: null, proofFailures: [] });
    scratch = realpathSync(await mkdtemp(join(tmpdir(), 'portos-held-checkout-')));
    const safeRepo = join(scratch, 'repo');
    await mkdir(safeRepo);
    await materializeGitRepo(safeRepo, { identity: { email: 'test@example.com', name: 'Test' } });
    repo = (await execGit(['rev-parse', '--show-toplevel'], safeRepo)).stdout.trim() || safeRepo;
    external = join(scratch, 'elsewhere');
    cosDir = join(scratch, 'cos');
    await mkdir(external);
    injected.app.repoPath = repo;
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /** A locked checkout outside the managed roots holding unique uncommitted work. */
  async function heldCheckout(name, { branch = null, lockReason = 'synthetic external owner', beforeLock } = {}) {
    const path = join(external, name);
    await execGit(['worktree', 'add', ...(branch ? ['-b', branch, path] : ['--detach', path]), 'main'], repo);
    await writeFile(join(path, '.gitignore'), 'ignored.txt\nlinked\n');
    await writeFile(join(path, 'initial.txt'), 'tracked edit\n');
    await writeFile(join(path, 'untracked.txt'), 'untracked work\n');
    await writeFile(join(path, 'ignored.txt'), 'ignored work\n');
    // Windows runners may lack symlink privilege; the archive contract is the same.
    if (SYMLINKS) await symlink('../shared-target', join(path, 'linked'));
    if (beforeLock) await beforeLock(path);
    await execGit(['worktree', 'lock', '--reason', lockReason, path], repo);
    const [gitPath, head] = (await Promise.all([
      execGit(['rev-parse', '--show-toplevel'], path), execGit(['rev-parse', 'HEAD'], path),
    ])).map(result => result.stdout.trim());
    // Git also expands Windows short-name aliases; separator normalization alone
    // cannot make the native input match the registered checkout identity.
    return { path: gitPath, release: { path: gitPath, head, branch, locked: true, lockReason } };
  }

  // Git emits forward slashes on Windows even when the fixture uses native paths.
  const registered = async (path) => (await execGit(['worktree', 'list', '--porcelain'], repo)).stdout
    .split(/\r?\n/).includes(`worktree ${path.replaceAll('\\', '/')}`);
  const lockText = async (path) => (await execGit(['worktree', 'list', '--porcelain'], repo)).stdout
    .split(/\r?\n\r?\n/).find(block => block.split(/\r?\n/)[0] === `worktree ${path.replaceAll('\\', '/')}`)?.match(/^locked ?(.*)$/m)?.[1] ?? null;
  /** The operator confirms a row the last sweep persisted. */
  async function retire(release, opts = {}) {
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...release, reason: 'worktree-locked' }] });
    return retireInventoriedCheckout({ appId: 'app-1', release }, { cosDir, readAgents: noOwners, ...opts });
  }
  const archives = async () => (existsSync(heldCheckoutArchiveRoot(cosDir)) ? readdir(heldCheckoutArchiveRoot(cosDir)) : []);

  async function historicalArchive() {
    const path = join(external, 'historical');
    const branch = 'feature/historical';
    await execGit(['worktree', 'add', '-b', branch, path, 'main'], repo);
    await writeFile(join(path, 'initial.txt'), 'staged historical work\n');
    await execGit(['add', 'initial.txt'], path);
    await writeFile(join(path, 'private.txt'), 'synthetic private bytes');
    const release = { path, branch, head: (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim(), locked: false, lockReason: null };
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...release, reason: 'retirement-review-pending' }] });
    const saved = await preserveMergedCheckout(repo, { ...release, branch: `refs/heads/${branch}` }, 'main', { cosDir: PATHS.cos });
    await execGit(['worktree', 'remove', '--force', path], repo);
    return { release, saved };
  }

  async function supersededCheckout() {
    const { release } = await heldCheckout('superseded', { branch: 'feature/superseded' });
    await execGit(['worktree', 'unlock', release.path], repo);
    await execGit(['add', 'initial.txt'], release.path);
    await writeFile(join(release.path, 'initial.txt'), 'unstaged original work\n');
    const gitdir = (await execGit(['rev-parse', '--absolute-git-dir'], release.path)).stdout.trim();
    await writeFile(join(gitdir, 'private-note'), 'private administration');
    const dirtyPaths = (await execGit(['status', '--porcelain'], release.path)).stdout.trimEnd().split('\n').filter(Boolean).map(line => line.slice(3));
    const entry = { branch: release.branch, tip: release.head, worktreePath: release.path, worktreeLocked: false,
      worktreeAgeMs: 365 * 86400000, dirtyPaths,
      verdict: { branch: release.branch, tip: release.head, verdict: 'SUPERSEDED', dirtyPaths } };
    return { entry, release: { ...release, locked: false, lockReason: null } };
  }
  const reapSuperseded = async (entry, readAgents = noOwners) => (await import('./branchReconcile.js')).reapSupersededBranches(repo, 'main', [entry], {
    appId: 'app-1', cosDir, claimOwners: { agents: [], readAgents },
  });

  it('retires a superseded branch without a worktree through its full branch archive without claiming checkout preservation', async () => {
    const branch = 'feature/no-worktree';
    const head = (await execGit(['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'superseded branch-only commit'], repo)).stdout.trim();
    await execGit(['branch', branch, head], repo);
    const missingCheckout = { branch, path: join(external, 'lost-original'), head, locked: false, lockReason: null };
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', retirementObligations: [{ ...missingCheckout, reason: 'retirement-provenance-unverified' }] });
    let archiveDir;
    retirementFaults.onBranchDelete = async () => {
      for (const name of await readdir(join(PATHS.cos, 'branch-retirement-archives'))) {
        const dir = join(PATHS.cos, 'branch-retirement-archives', name);
        const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
        if (manifest.repoPath === repo && manifest.branch === branch && manifest.expectedHead === head) {
          archiveDir = dir;
          expect(manifest.recoveryHeads).toContain(head);
          expect(manifest.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
        }
      }
      expect(archiveDir).toBeTruthy();
      expect((await execGit(['rev-parse', '--verify', `refs/heads/${branch}`], repo)).stdout.trim()).toBe(head);
    };
    const entry = { branch, tip: head, worktreePath: null, dirtyPaths: [], verdict: { branch, tip: head, verdict: 'SUPERSEDED', dirtyPaths: [] } };
    expect(await reapSuperseded(entry)).toMatchObject({ reaped: [branch], skipped: [] });
    expect((await execGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo, { ignoreExitCode: true })).exitCode).toBe(1);
    const restored = join(scratch, 'branch-restore.git');
    await execGit(['init', '--bare', restored], scratch);
    await execGit(['bundle', 'unbundle', join(archiveDir, 'commits.bundle')], restored);
    expect((await execGit(['cat-file', '-e', `${head}^{commit}`], restored)).exitCode).toBe(0);
    const outcome = await getBranchReconcileOutcome('app-1');
    expect(outcome.retired || []).toEqual([]);
    expect(outcome.retirementObligations).toContainEqual(expect.objectContaining(missingCheckout));
    expect(await archives()).toEqual([]);
  });

  it('archives every superseded checkout byte and persists its exact generation before removal, then records retirement', async () => {
    const { entry, release } = await supersededCheckout();
    let prepared;
    retirementFaults.onRemove = async () => {
      const outcome = await getBranchReconcileOutcome('app-1');
      const row = outcome.retirementObligations.find(row => row.branch === release.branch);
      prepared = row.preservationReceipt;
      expect(row).toMatchObject(release);
      expect(outcome.retired || []).toEqual([]);
      expect(await readFile(join(prepared.archiveDir, 'files', 'ignored.txt'), 'utf8')).toBe('ignored work\n');
      expect(await readFile(join(prepared.archiveDir, 'administration', 'gitdir', 'private-note'), 'utf8')).toBe('private administration');
      expect(await readFile(join(prepared.archiveDir, 'index.diff'), 'utf8')).toContain('tracked edit');
      expect(await readFile(join(prepared.archiveDir, 'worktree.diff'), 'utf8')).toContain('unstaged original work');
      expect((await execGit(['bundle', 'verify', join(prepared.archiveDir, 'commits.bundle')], repo)).exitCode).toBe(0);
    };
    expect(await reapSuperseded(entry)).toMatchObject({ reaped: [release.branch], skipped: [] });
    expect(prepared.archiveDir).toBeTruthy();
    const outcome = await getBranchReconcileOutcome('app-1');
    expect(outcome.retired).toContainEqual(expect.objectContaining({ path: release.path, branch: release.branch, head: release.head,
      archiveDir: prepared.archiveDir, branchDeleted: true, retiredAt: expect.any(String) }));
    expect(outcome.retirementObligations).toEqual([]);
    expect(existsSync(release.path)).toBe(false);
    expect((await execGit(['rev-parse', '--verify', '--quiet', `refs/heads/${release.branch}`], repo, { ignoreExitCode: true })).exitCode).toBe(1);
  });

  it.each(['archive failure', 'preservation receipt failure', 'new owner', 'ignored bytes change', 'private administration change', 'checkout identity change', 'app scope change'])('keeps superseded originals on %s', async failure => {
    const { entry, release } = await supersededCheckout();
    let owners = [];
    if (failure === 'preservation receipt failure') retirementFaults.failScheduleWrite = 3;
    else injected.onBundle = async () => {
      injected.onBundle = null;
      if (failure === 'archive failure') throw new Error('synthetic archive failure');
      if (failure === 'new owner') owners = [{ id: 'new-owner', status: 'running', metadata: { sourceWorkspace: repo, claimBranches: [release.branch] } }];
      if (failure === 'ignored bytes change') await writeFile(join(release.path, 'ignored.txt'), 'new ignored bytes');
      if (failure === 'private administration change') {
        const gitdir = (await execGit(['rev-parse', '--absolute-git-dir'], release.path)).stdout.trim();
        await writeFile(join(gitdir, 'private-note'), 'new private administration');
      }
      if (failure === 'app scope change') injected.app = { ...injected.app, repoPath: join(scratch, 'different-app-repository') };
      if (failure === 'checkout identity change') {
        const pointer = join(release.path, '.git');
        const bytes = await readFile(pointer);
        await rename(pointer, join(scratch, 'original-indirection'));
        await writeFile(pointer, bytes);
      }
    };
    const result = await reapSuperseded(entry, async () => owners);
    expect(result.reaped).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(existsSync(release.path)).toBe(true);
    expect(await registered(release.path)).toBe(true);
    expect((await execGit(['rev-parse', release.branch], repo)).stdout.trim()).toBe(release.head);
    expect((await getBranchReconcileOutcome('app-1'))?.retired || []).toEqual([]);
  });

  it('preserves a superseded branch whose exact head no longer matches its verdict', async () => {
    const { entry, release } = await supersededCheckout();
    entry.tip = 'f'.repeat(40);
    entry.verdict.tip = entry.tip;
    expect(await reapSuperseded(entry)).toMatchObject({ reaped: [], skipped: [{ branch: release.branch, reason: 'branch-head-changed' }] });
    expect(existsSync(release.path)).toBe(true);
    expect(await registered(release.path)).toBe(true);
    expect(await archives()).toEqual([]);
  });

  it('never substitutes an older compatible archive when the prepared superseded archive is corrupt', async () => {
    const { entry, release } = await supersededCheckout();
    let owners = [];
    injected.onBundle = async () => {
      injected.onBundle = null;
      owners = [{ id: 'temporary-owner', status: 'running', metadata: { sourceWorkspace: repo, claimBranches: [release.branch] } }];
    };
    expect((await reapSuperseded(entry, async () => owners)).reaped).toEqual([]);
    const first = await getBranchReconcileOutcome('app-1');
    const older = { archiveDir: first.retirementObligations[0].preservationReceipt.archiveDir };
    owners = [];
    await writeFile(join(release.path, 'ignored.txt'), 'new private ignored work');
    retirementFaults.failScheduleWrite = retirementFaults.scheduleWrites + 4;
    expect((await reapSuperseded(entry)).reaped).toEqual([]);
    const outcome = await getBranchReconcileOutcome('app-1');
    const archiveDir = outcome.retirementObligations[0].preservationReceipt.archiveDir;
    expect(archiveDir).not.toBe(older.archiveDir);
    expect(await readFile(join(older.archiveDir, 'files', 'ignored.txt'), 'utf8')).toBe('ignored work\n');
    await writeFile(join(archiveDir, 'files', 'ignored.txt'), 'corrupt the exact prepared archive');
    const recovered = await recoverMissingCheckoutPreservations({ appId: 'app-1', repoPath: repo, outcome }, { cosDir });
    expect(recovered.retirementObligations).toHaveLength(1);
    expect(recovered.recoveredPreservations || []).toEqual([]);
    expect(recovered.retirementObligations[0].preservationReceipt.archiveDir).toBe(archiveDir);
  });

  it('preserves an existing checkout when its historical obligation has no original incarnation proof', async () => {
    const { entry, release } = await supersededCheckout();
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', retirementObligations: [{ ...release, reason: 'retirement-review-pending' }] });
    expect(await reapSuperseded(entry)).toMatchObject({ reaped: [], skipped: [{ branch: release.branch, reason: 'retirement-checkout-generation-unverified' }] });
    expect(existsSync(release.path)).toBe(true);
    expect(await registered(release.path)).toBe(true);
    expect((await getBranchReconcileOutcome('app-1')).retirementObligations).toHaveLength(1);
    expect(await archives()).toEqual([]);
  });

  it('keeps a durable preservation obligation when final retirement receipt persistence fails', async () => {
    const { entry, release } = await supersededCheckout();
    retirementFaults.failScheduleWrite = 4;
    expect(await reapSuperseded(entry)).toMatchObject({ reaped: [], skipped: [{ branch: release.branch, reason: 'retirement-receipt-unverified' }] });
    const outcome = await getBranchReconcileOutcome('app-1');
    expect(outcome.retired || []).toEqual([]);
    expect(outcome.retirementObligations).toContainEqual(expect.objectContaining({ path: release.path, head: release.head,
      preservationReceipt: expect.objectContaining({ archiveDir: expect.any(String), preparedAt: expect.any(String) }) }));
    expect(existsSync(release.path)).toBe(false);
  });

  it('recovers complete preservation through the schedule boundary with only the primary checkout, without claiming branch deletion', async () => {
    const { release, saved } = await historicalArchive();
    const before = (await execGit(['show-ref'], repo)).stdout;
    const outcome = await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [] });
    expect(outcome.retirementObligations, `Standalone archive proof failures: ${JSON.stringify(injected.proofFailures)}`).toEqual([]);
    expect(outcome.remaining).toEqual([]);
    expect(outcome.recoveredPreservations).toEqual([expect.objectContaining({ path: release.path, branch: release.branch, head: release.head,
      archiveDir: saved.archiveDir, verified: true,
      evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })]);
    expect(outcome.retired).toBeUndefined();
    expect(outcome.recoveredPreservations[0]).not.toHaveProperty('branchDeleted');
    expect(existsSync(release.path)).toBe(false);
    expect((await execGit(['show-ref'], repo)).stdout).toBe(before);
    // A new generation with the same branch/path/head cannot reuse the archive.
    const recreated = await recordBranchReconcileOutcome('app-1', { status: 'incomplete', retirementObligations: [{ ...release, reason: 'retirement-review-pending' }] });
    expect(recreated.retirementObligations).toHaveLength(1);
    expect(recreated.retirementObligations[0].preservationEvidence.archives).toContainEqual({ archiveDir: saved.archiveDir, reason: 'archive-generation-mismatch' });
  });

  it('recognizes an absent completion archive without a schedule obligation and rejects changed or older evidence', async () => {
    const { release, saved } = await historicalArchive();
    const outcome = await getBranchReconcileOutcome('app-1');
    const original = { ...release, createdAt: outcome.retirementObligations[0].createdAt };
    injected.schedule = { executions: {} };
    const withoutObligation = await getBranchReconcileOutcome('app-1');
    await execGit(['branch', '-d', release.branch], repo);
    const proof = await findMissingCheckoutPreservation({ repoPath: repo, release: original });
    expect(proof).toMatchObject({ archiveDir: saved.archiveDir, evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(await proof.recheck()).toBe(true);
    await mkdir(release.path);
    expect(await proof.recheck()).toBe(false);
    await rm(release.path, { recursive: true });
    const manifest = JSON.parse(await readFile(join(saved.archiveDir, 'manifest.json'), 'utf8'));
    expect(await findMissingCheckoutPreservation({ repoPath: repo, release: { ...original, createdAt: new Date(Date.parse(manifest.archivedAt) + 1).toISOString() } })).toBeNull();
    await writeFile(join(saved.archiveDir, 'files', 'private.txt'), 'corrupt archived evidence');
    expect(await findMissingCheckoutPreservation({ repoPath: repo, release: original })).toBeNull();
    expect(await getBranchReconcileOutcome('app-1')).toEqual(withoutObligation);
  });

  it.each([false, true])('clears the historical diagnosis after recovery retries, with other holds=%s', async otherHolds => {
    const { saved } = await historicalArchive();
    const unavailable = join(PATHS.cos, 'temporarily-unavailable-archive');
    await rename(saved.archiveDir, unavailable);
    const remaining = otherHolds ? [{ branch: 'feature/other', reason: 'worktree-locked' }] : [];
    const unresolved = await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining });
    expect(unresolved.reason).toBe('historical-preservation-unresolved');
    await rename(unavailable, saved.archiveDir);
    const recovered = await recoverMissingCheckoutPreservations({ appId: 'app-1', repoPath: repo, outcome: unresolved });
    expect(recovered.retirementObligations).toEqual([]);
    expect(recovered.remaining).toEqual(remaining);
    expect(recovered).toMatchObject({ status: 'incomplete', reason: otherHolds ? 'remaining-holds' : 'preservation-recovered' });
    expect(recovered.nextAction).not.toContain('backup');
  });

  it.each(['missing', 'wrong-repository', 'wrong-path', 'wrong-head', 'changed-file', 'changed-patch', 'legacy-dirty', 'legacy-corrupt-bundle', 'partial-original'])(
    'retains an actionable historical obligation for %s preservation evidence', async failure => {
      const { release, saved } = await historicalArchive();
      const manifestPath = join(saved.archiveDir, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (failure === 'missing') await rm(saved.archiveDir, { recursive: true, force: true });
      if (failure === 'wrong-repository') manifest.repoPath = join(scratch, 'other-repo');
      if (failure === 'wrong-path') manifest.path = join(external, 'other-checkout');
      if (failure === 'wrong-head') manifest.head = 'f'.repeat(40);
      if (failure === 'changed-file') await writeFile(join(saved.archiveDir, 'files', 'private.txt'), 'changed archive bytes');
      if (failure === 'changed-patch') await writeFile(join(saved.archiveDir, 'index.diff'), 'changed patch bytes');
      if (failure === 'legacy-corrupt-bundle') {
        delete manifest.bundleSha256;
        const bundlePath = join(saved.archiveDir, 'commits.bundle');
        const bundle = await readFile(bundlePath);
        // Preserve the valid textual header and destroy only the packed objects.
        await truncate(bundlePath, bundle.indexOf('\n\n') + 12);
      }
      if (failure === 'legacy-dirty') delete manifest.patchHashes;
      if (failure === 'partial-original') manifest.captured.missingCheckout = true;
      if (failure !== 'missing') await writeFile(manifestPath, JSON.stringify(manifest));
      const outcome = await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [] });
      expect(outcome.retirementObligations).toEqual([expect.objectContaining({ ...release,
        preservationEvidence: expect.objectContaining({ status: 'unresolved', nextAction: expect.stringContaining('backup') }),
      })]);
      expect(outcome).toMatchObject({ status: 'incomplete', reason: 'historical-preservation-unresolved', recoveredPreservations: [] });
      expect(outcome.remaining).toEqual(outcome.retirementObligations);
      expect(existsSync(release.path)).toBe(false);
    });

  it.each(['recreated-path', 'new-holder', 'inventory-change', 'repository-change'])(
    'does not settle historical evidence after a concurrent %s', async change => {
      const { release } = await historicalArchive();
      const outcome = await getBranchReconcileOutcome('app-1');
      injected.onEvidence = async () => {
        injected.onEvidence = null;
        if (change === 'recreated-path') await mkdir(release.path);
        if (change === 'new-holder') await execGit(['worktree', 'add', join(external, 'new-holder'), release.branch], repo);
        if (change === 'repository-change') injected.app.repoPath = join(scratch, 'changed-repo');
        if (change === 'inventory-change') {
          const current = injected.schedule.executions['task:branch-reconcile'].perApp['app-1'];
          current.branchReconcileOutcome = { ...current.branchReconcileOutcome, observedAt: 'changed-inventory' };
        }
      };
      await recoverMissingCheckoutPreservations({ appId: 'app-1', repoPath: repo, outcome });
      const current = await getBranchReconcileOutcome('app-1');
      expect(current.retirementObligations).toHaveLength(1);
      expect(current.recoveredPreservations).toBeUndefined();
      if (change === 'inventory-change') expect(current.observedAt).toBe('changed-inventory');
    });

  it('preserves ignored evidence before unattended cleanup and refuses later byte or head changes', async () => {
    const path = join(external, 'merged');
    await execGit(['worktree', 'add', '-b', 'feature/done', path, 'main'], repo);
    await writeFile(join(path, 'ignored.txt'), 'recovery evidence');
    await writeFile(join(repo, '.git', 'info', 'exclude'), 'ignored.txt\n');
    expect((await execGit(['status', '--porcelain'], path)).stdout.trim()).toBe('');
    const tree = { path, branch: 'refs/heads/feature/done', head: (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim() };
    const saved = await preserveMergedCheckout(repo, tree, 'main', { cosDir });
    expect(await readFile(join(saved.archiveDir, 'files', 'ignored.txt'), 'utf8')).toBe('recovery evidence');
    await execGit(['bundle', 'verify', join(saved.archiveDir, 'commits.bundle')], repo);
    expect(await saved.verify(tree)).toBe(null);
    expect(await saved.verify({ ...tree, head: 'f'.repeat(40) })).toBe('worktree-holder-changed');
    await writeFile(join(path, 'ignored.txt'), 'new evidence');
    expect(await saved.verify(tree)).toBe('checkout-content-changed');
    expect(existsSync(path)).toBe(true);
  });

  it('bundles reflog-only commits into a standalone recovery repository', async () => {
    const path = join(external, 'reflog');
    await execGit(['worktree', 'add', '-b', 'feature/reflog', path, 'main'], repo);
    await writeFile(join(path, 'lost.txt'), 'recover this private commit');
    await execGit(['add', 'lost.txt'], path);
    await execGit(['commit', '-m', 'private recovery commit'], path);
    const lost = (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim();
    await execGit(['reset', '--hard', 'main'], path);
    const tree = { path, branch: 'refs/heads/feature/reflog', head: (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim() };
    const saved = await preserveMergedCheckout(repo, tree, 'main', { cosDir });
    const manifest = JSON.parse(await readFile(join(saved.archiveDir, 'manifest.json'), 'utf8'));
    expect(manifest.captured.recoveryHeads).toContain(lost);
    const restored = join(scratch, 'restored');
    await execGit(['init', '--bare', restored], scratch);
    await execGit(['fetch', join(saved.archiveDir, 'commits.bundle'), '+refs/portos/archive/*:refs/recovered/*'], restored);
    expect((await execGit(['show', `${lost}:lost.txt`], restored)).stdout).toBe('recover this private commit');
    expect(await saved.verify(tree)).toBe(null);
  });

  it('recovers AUTO_MERGE trees and private blob/tag roots without the original object store', async () => {
    const path = join(external, 'private-objects');
    await execGit(['worktree', 'add', '-b', 'feature/private-objects', path, 'main'], repo);
    await writeFile(join(path, 'conflict.txt'), '<<<<<<< ours\nprivate conflict bytes\n=======\nother side\n>>>>>>> theirs\n');
    await execGit(['add', 'conflict.txt'], path);
    const autoMerge = (await execGit(['write-tree'], path)).stdout.trim();
    const conflictBlob = (await execGit(['rev-parse', ':conflict.txt'], path)).stdout.trim();
    await execGit(['tag', '-a', 'temporary-tree-tag', autoMerge, '-m', 'private tree evidence'], path);
    const tag = (await execGit(['rev-parse', 'refs/tags/temporary-tree-tag'], path)).stdout.trim();
    await execGit(['tag', '-d', 'temporary-tree-tag'], path);
    await execGit(['reset', '--hard', 'main'], path);
    await writeFile(join(path, 'blob-source'), 'private root blob bytes');
    const blob = (await execGit(['hash-object', '-w', 'blob-source'], path)).stdout.trim();
    await rm(join(path, 'blob-source'));
    const admin = (await execGit(['rev-parse', '--absolute-git-dir'], path)).stdout.trim();
    await writeFile(join(admin, 'AUTO_MERGE'), `${autoMerge}\n`);
    await execGit(['update-ref', 'refs/worktree/private-blob', blob], path);
    await execGit(['update-ref', 'refs/worktree/private-tag', tag], path);
    await execGit(['symbolic-ref', 'refs/worktree/symbolic-tag', 'refs/worktree/private-tag'], path);
    await execGit(['symbolic-ref', 'refs/worktree/current', 'HEAD'], path);
    const mergeHead = (await execGit(['commit-tree', autoMerge, '-m', 'private merge recovery'], path)).stdout.trim();
    const otherMergeHead = (await execGit(['commit-tree', autoMerge, '-m', 'other private merge recovery'], path)).stdout.trim();
    await writeFile(join(admin, 'MERGE_HEAD'), `${mergeHead}\n${otherMergeHead}\n`);
    const tree = { path, branch: 'refs/heads/feature/private-objects', head: (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim() };
    const saved = await preserveMergedCheckout(repo, tree, 'main', { cosDir });
    const manifest = JSON.parse(await readFile(join(saved.archiveDir, 'manifest.json'), 'utf8'));
    expect(manifest.captured.recoveryHeads).toEqual(expect.arrayContaining([autoMerge, blob, tag, mergeHead, otherMergeHead]));
    expect(await readFile(join(saved.archiveDir, 'administration', 'gitdir', 'AUTO_MERGE'), 'utf8')).toBe(`${autoMerge}\n`);
    expect(await saved.verify(tree)).toBe(null);
    // The archive must supply the conflict tree's children, not just list roots
    // whose missing bytes happen to be available from the original repository.
    await rename(repo, `${repo}-unavailable`);
    const restored = join(scratch, 'restored-private-objects');
    await execGit(['init', '--bare', restored], scratch);
    await execGit(['fetch', join(saved.archiveDir, 'commits.bundle'), '+refs/portos/archive/*:refs/recovered/*'], restored);
    expect((await execGit(['show', `${autoMerge}:conflict.txt`], restored)).stdout).toContain('private conflict bytes');
    expect((await execGit(['cat-file', 'blob', conflictBlob], restored)).stdout).toContain('>>>>>>> theirs');
    expect((await execGit(['cat-file', 'blob', blob], restored)).stdout).toBe('private root blob bytes');
    expect((await execGit(['rev-parse', `${tag}^{tree}`], restored)).stdout.trim()).toBe(autoMerge);
    expect((await execGit(['rev-parse', `${mergeHead}^{tree}`], restored)).stdout.trim()).toBe(autoMerge);
    expect((await execGit(['rev-parse', `${otherMergeHead}^{tree}`], restored)).stdout.trim()).toBe(autoMerge);
    await execGit(['fsck', '--full', '--strict'], restored);
  });

  it.each(['AUTO_MERGE', 'refs/worktree/missing', 'logs/HEAD:old', 'logs/HEAD:new', 'FETCH_HEAD'])(
    'retains the checkout when a genuine recovery object is missing from %s', async reference => {
    const path = join(external, 'missing-auto-merge');
    await execGit(['worktree', 'add', '-b', 'feature/missing-auto-merge', path, 'main'], repo);
    const admin = (await execGit(['rev-parse', '--absolute-git-dir'], path)).stdout.trim();
    const missing = 'f'.repeat(40);
    const tree = { path, branch: 'refs/heads/feature/missing-auto-merge', head: (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim() };
    const relative = reference.split(':')[0];
    const bytes = reference === 'logs/HEAD:old' ? `${missing} ${tree.head} Test <test@example.com> 1 +0000\tmissing old object\n`
      : reference === 'logs/HEAD:new' ? `${tree.head} ${missing} Test <test@example.com> 1 +0000\tmissing new object\n`
      : reference === 'FETCH_HEAD' ? `${missing}\t\tbranch 'missing' of https://example.invalid/repo\n` : `${missing}\n`;
    await mkdir(dirname(join(admin, relative)), { recursive: true });
    await writeFile(join(admin, relative), bytes);
    await expect(preserveMergedCheckout(repo, tree, 'main', { cosDir })).rejects.toThrow();
    expect(existsSync(path)).toBe(true);
    expect(await readFile(join(admin, relative), 'utf8')).toBe(bytes);
    expect(await archives()).toEqual([]);
    expect((await execGit(['for-each-ref', '--format=%(refname)', 'refs/portos/archive'], repo)).stdout).toBe('');
  });

  it.each(['refs/worktree/unknown', 'logs/HEAD', 'FETCH_HEAD', 'FUTURE_HEAD', 'sequencer/todo', 'index.lock'])(
    'retains unknown or active recovery state in %s', async relative => {
      const nativePath = join(external, 'unknown-recovery');
      await execGit(['worktree', 'add', '-b', 'feature/unknown-recovery', nativePath, 'main'], repo);
      const [path, admin, head] = (await execGit(['rev-parse', '--show-toplevel', '--absolute-git-dir', 'HEAD'], nativePath)).stdout.trim().split(/\r?\n/);
      const tree = { path, branch: 'refs/heads/feature/unknown-recovery', head };
      await mkdir(dirname(join(admin, relative)), { recursive: true });
      const bytes = relative.startsWith('refs/') ? 'ref: HEAD^{tree}\n' : `unrecognized recovery format ${tree.head}\n`;
      await writeFile(join(admin, relative), bytes);
      await expect(preserveMergedCheckout(repo, tree, 'main', { cosDir })).rejects.toThrow();
      expect(existsSync(nativePath)).toBe(true);
      expect(await registered(path)).toBe(true);
      expect(await readFile(join(admin, relative), 'utf8')).toBe(bytes);
      expect(await archives()).toEqual([]);
    });

  it('preserves SHA-256 private refs and packed roots without interpreting metadata as objects', async () => {
    repo = join(scratch, 'sha256-repo');
    await execGit(['init', '--object-format=sha256', '-b', 'main', repo], scratch);
    await execGit(['config', 'user.name', 'Test'], repo);
    await execGit(['config', 'user.email', 'test@example.com'], repo);
    await execGit(['config', 'commit.gpgsign', 'false'], repo);
    await writeFile(join(repo, 'initial.txt'), 'sha256 initial');
    await execGit(['add', 'initial.txt'], repo);
    await execGit(['commit', '-m', 'sha256 initial'], repo);
    const path = join(external, 'sha256');
    await execGit(['worktree', 'add', '-b', 'feature/sha256', path, 'main'], repo);
    const admin = (await execGit(['rev-parse', '--absolute-git-dir'], path)).stdout.trim();
    const tree = { path, branch: 'refs/heads/feature/sha256', head: (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim() };
    await writeFile(join(path, 'private.txt'), 'private sha256 blob');
    const blob = (await execGit(['hash-object', '-w', 'private.txt'], path)).stdout.trim();
    await rm(join(path, 'private.txt'));
    await execGit(['update-ref', 'refs/worktree/private', blob], path);
    await execGit(['tag', '-a', 'temporary', blob, '-m', 'packed sha256 tag'], path);
    const tag = (await execGit(['rev-parse', 'refs/tags/temporary'], path)).stdout.trim();
    await execGit(['tag', '-d', 'temporary'], path);
    await writeFile(join(admin, 'packed-refs'), `# pack-refs with: peeled\n${tag} refs/worktree/packed\n^${blob}\n`);
    await writeFile(join(admin, 'portos-pr-review-outcome.json'), JSON.stringify({ avatar: '1'.repeat(64) }));
    const saved = await preserveMergedCheckout(repo, tree, 'main', { cosDir });
    expect(await saved.verify(tree)).toBe(null);
    await rename(repo, `${repo}-unavailable`);
    const restored = join(scratch, 'sha256-restored');
    await execGit(['init', '--bare', '--object-format=sha256', restored], scratch);
    await execGit(['fetch', join(saved.archiveDir, 'commits.bundle'), '+refs/portos/archive/*:refs/recovered/*'], restored);
    expect((await execGit(['cat-file', 'blob', blob], restored)).stdout).toBe('private sha256 blob');
    expect((await execGit(['rev-parse', `${tag}^{blob}`], restored)).stdout.trim()).toBe(blob);
    await execGit(['fsck', '--full', '--strict'], restored);
  });

  it.each([false, true])('archives a missing checkout private index and staged contents before pruning, parentAlias=%s', async parentAlias => {
    const path = join(external, 'missing');
    await execGit(['worktree', 'add', '-b', 'feature/missing', path, 'main'], repo);
    await writeFile(join(path, 'staged.txt'), 'only in the private index');
    await execGit(['add', 'staged.txt'], path);
    const tree = { path, branch: 'refs/heads/feature/missing', head: (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim() };
    if (parentAlias) {
      const alias = join(scratch, 'external-alias');
      // Directory junctions need no Windows symlink privilege. This reproduces
      // two filesystem spellings of the existing parent of a missing checkout.
      await symlink(external, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const admin = (await execGit(['rev-parse', '--absolute-git-dir'], path)).stdout.trim();
      await writeFile(join(admin, 'gitdir'), `${join(alias, 'missing', '.git')}\n`);
      await execGit(['worktree', 'add', '--detach', join(external, 'unrelated'), 'main'], repo);
    }
    await rm(path, { recursive: true, force: true });
    const saved = await preserveMergedCheckout(repo, tree, 'main', { cosDir });
    expect(await readFile(join(saved.archiveDir, 'index.diff'), 'utf8')).toContain('only in the private index');
    expect(existsSync(join(saved.archiveDir, 'administration', 'gitdir', 'index'))).toBe(true);
    expect(JSON.parse(await readFile(join(saved.archiveDir, 'manifest.json'), 'utf8')).captured.missingCheckout).toBe(true);
    expect(await saved.verify(tree)).toBe(null);
    const restored = join(scratch, 'restored-missing');
    await mkdir(restored);
    await materializeGitRepo(restored);
    await execGit(['fetch', join(saved.archiveDir, 'commits.bundle'), 'HEAD:refs/heads/recovered'], restored);
    await execGit(['checkout', 'recovered'], restored);
    await execGit(['apply', '--index', join(saved.archiveDir, 'index.diff')], restored);
    expect(await readFile(join(restored, 'staged.txt'), 'utf8')).toBe('only in the private index');
    expect((await execGit(['show', ':staged.txt'], restored)).stdout).toBe('only in the private index');
    await mkdir(path);
    await expect(saved.verify(tree)).rejects.toThrow('missing-checkout-reappeared');
  });

  it.each(['different-tail', 'different-parent', 'tail-case'])('refuses a missing checkout whose private registration points elsewhere: %s', async mismatch => {
    const path = join(external, 'missing-mismatched');
    await execGit(['worktree', 'add', '-b', 'feature/mismatched', path, 'main'], repo);
    const admin = (await execGit(['rev-parse', '--absolute-git-dir'], path)).stdout.trim();
    const tree = { path, branch: 'refs/heads/feature/mismatched', head: (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim() };
    await rm(path, { recursive: true, force: true });
    const otherParent = join(scratch, 'other-parent');
    await mkdir(otherParent);
    const pointer = mismatch === 'different-parent' ? join(otherParent, 'missing-mismatched', '.git')
      : join(external, mismatch === 'tail-case' ? 'MISSING-MISMATCHED' : 'another-checkout', '.git');
    await writeFile(join(admin, 'gitdir'), `${pointer}\n`);
    await expect(preserveMergedCheckout(repo, tree, 'main', { cosDir }))
      .rejects.toThrow('missing-checkout-administration-unverified');
    expect(await archives()).toEqual([]);
    expect(existsSync(join(admin, 'index'))).toBe(true);
  });

  it('archives staged, unstaged, untracked, ignored and symlinked content, then retires a locked detached checkout', async () => {
    await writeFile(join(repo, 'eol.txt'), 'one\ntwo\n');
    // No newline: Windows core.autocrlf must not make this stat-only fixture
    // byte-different when the checkout later installs its LF attributes.
    await writeFile(join(repo, 'stat-cache.txt'), 'unchanged');
    await execGit(['add', 'eol.txt', 'stat-cache.txt'], repo);
    await execGit(['commit', '-m', 'chore: synthetic text file'], repo);
    const { path, release } = await heldCheckout('detached-held', { beforeLock: async (tree) => {
      // Normalization hides these CRLF bytes from every diff.
      await writeFile(join(tree, '.gitattributes'), 'eol.txt text eol=lf\n');
      await writeFile(join(tree, 'eol.txt'), 'one\r\ntwo\r\n');
    } });
    // Only the index holds this file once its working copy is gone.
    await writeFile(join(path, 'staged-only.txt'), 'staged work\n');
    await execGit(['add', 'staged-only.txt'], path);
    await rm(join(path, 'staged-only.txt'));

    // Make an unchanged tracked file's stat cache stale. Git diff normally
    // rewrites the index while refreshing it, racing the administration copy.
    await utimes(join(path, 'stat-cache.txt'), new Date('2020-01-01'), new Date('2020-01-01'));
    const indexPath = (await execGit(['rev-parse', '--git-path', 'index'], path)).stdout.trim();
    const originalIndex = await readFile(indexPath);
    const result = await retire(release);

    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, branchDeleted: false });
    expect(existsSync(path)).toBe(false);
    expect(await registered(release.path)).toBe(false);
    const manifest = JSON.parse(await readFile(join(result.archiveDir, 'manifest.json'), 'utf8'));
    expect(manifest.release).toEqual(release);
    expect(await readFile(join(result.archiveDir, 'administration', 'gitdir', 'index'))).toEqual(originalIndex);
    expect(manifest.captured.files.map(file => `${file.path}${file.tracked ? ' (tracked)' : ''}`).sort())
      .toEqual(['.gitattributes', '.gitignore', 'eol.txt (tracked)', 'ignored.txt', 'initial.txt (tracked)', 'untracked.txt']);
    expect(await readFile(join(result.archiveDir, 'files', 'eol.txt'), 'utf8')).toBe('one\r\ntwo\r\n');
    expect(manifest.captured.symlinks).toEqual(SYMLINKS ? [{ path: 'linked', target: '../shared-target' }] : []);
    expect(await readFile(join(result.archiveDir, 'files', 'ignored.txt'), 'utf8')).toBe('ignored work\n');
    expect(await readFile(join(result.archiveDir, 'worktree.diff'), 'utf8')).toContain('+tracked edit');
    expect(await readFile(join(result.archiveDir, 'index.diff'), 'utf8')).toContain('+staged work');
  });

  it('bundles a squash-merged branch, retires it with its branch, and drops it from the persisted inventory', async () => {
    const { path, release } = await heldCheckout('branch-held', { branch: 'feature/held', beforeLock: async (tree) => {
      await writeFile(join(tree, 'feature.txt'), 'feature\n');
      await execGit(['add', 'feature.txt'], tree);
      await execGit(['commit', '-m', 'feat: synthetic feature'], tree);
      await execGit(['merge', '--squash', 'feature/held'], repo);
      await execGit(['commit', '-m', 'feat: synthetic feature (squash)'], repo);
    } });
    await recordBranchReconcileOutcome('app-1', {
      status: 'incomplete', reason: 'holds-remaining', nextAction: 'Recover held checkouts.',
      remaining: [{ ...release, managed: false, reason: 'worktree-locked' }, { branch: 'other', reason: 'actionable' }],
    });

    const branchArchiveRoot = join(PATHS.cos, 'branch-retirement-archives');
    const priorArchives = new Set(await readdir(branchArchiveRoot).catch(() => []));
    const originalReflog = await readFile(join(repo, '.git', 'logs', 'refs', 'heads', 'feature', 'held'));
    const result = await retireInventoriedCheckout({ appId: 'app-1', release }, { cosDir, readAgents: noOwners });

    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, branchDeleted: true });
    const newArchives = (await readdir(branchArchiveRoot)).filter(name => !priorArchives.has(name));
    expect(newArchives).toHaveLength(1);
    const branchArchive = join(branchArchiveRoot, newArchives[0]);
    expect(await readFile(join(branchArchive, 'reflog'))).toEqual(originalReflog);
    const branchManifest = JSON.parse(await readFile(join(branchArchive, 'manifest.json'), 'utf8'));
    expect(branchManifest).toMatchObject({ branch: release.branch, expectedHead: release.head });
    await execGit(['bundle', 'verify', join(branchArchive, 'commits.bundle')], repo);
    expect(existsSync(path)).toBe(false);
    expect((await execGit(['branch', '--list', 'feature/held'], repo)).stdout.trim()).toBe('');
    // The original commit stays recoverable after its branch is gone.
    await execGit(['fetch', join(result.archiveDir, 'commits.bundle'), 'HEAD:refs/heads/restored'], repo);
    expect((await execGit(['rev-parse', 'restored'], repo)).stdout.trim()).toBe(release.head);
    const outcome = await getBranchReconcileOutcome('app-1');
    expect(outcome.status).toBe('incomplete');
    expect(outcome.remaining).toEqual([{ branch: 'other', reason: 'actionable' }]);
    expect(outcome.retired[0]).toMatchObject({ path: release.path, branch: 'feature/held', branchDeleted: true, archiveDir: result.archiveDir });
  });

  it('retains vanished active claim provenance instead of reporting an unarchived checkout retired', async () => {
    const { path, release } = await heldCheckout('already-gone', { branch: 'claim/issue-42' });
    await execGit(['branch', 'other', 'main'], repo);
    const gitDir = (await execGit(['rev-parse', '--absolute-git-dir'], path)).stdout.trim();
    await writeFile(join(gitDir, 'portos-review-status'), 'private synthetic evidence');
    await recordBranchReconcileOutcome('app-1', {
      status: 'incomplete', remaining: [{ ...release, reason: 'retirement-review-pending' }, { branch: 'other', reason: 'actionable' }],
    });
    await execGit(['worktree', 'unlock', path], repo);
    await execGit(['worktree', 'remove', '--force', path], repo);

    const activeOwner = async () => [{ id: 'agent-live', status: 'running', metadata: {
      sourceWorkspace: repo, claimBranches: [release.branch], claimReleasedBranches: [],
    } }];
    expect(await retireInventoriedCheckout({ appId: 'app-1', release }, { cosDir, readAgents: activeOwner }))
      .toEqual({ ok: false, reason: 'retirement-provenance-unverified' });
    const obligation = { ...release, reason: 'retirement-provenance-unverified', createdAt: expect.any(String) };
    expect(await getBranchReconcileOutcome('app-1')).toMatchObject({ status: 'incomplete',
      retirementObligations: [obligation], remaining: [obligation, { branch: 'other', reason: 'actionable' }],
    });
    // Neither ignored bytes nor private Git state can be reconstructed from the merged head.
    expect(await archives()).toEqual([]);
    expect((await execGit(['rev-parse', `refs/heads/${release.branch}`], repo)).stdout.trim()).toBe(release.head);
    await recordBranchReconcileOutcome('app-1', { status: 'running', remaining: [] });
    await parkPerpetual('branch-reconcile', 'app-1', { reason: 'no-in-flight-branches' });
    expect(await getBranchReconcileOutcome('app-1')).toMatchObject({ status: 'incomplete', remaining: [obligation] });
  });

  it('retains a checkout that vanishes between sweeps until its exact preservation receipt arrives', async () => {
    const { path, release } = await heldCheckout('gone-between-scans', { branch: 'feature/missing' });
    const marker = { branch: 'claim/issue-99', issue: 99, reason: 'claim-reservation-owner-unverified' };
    await recordBranchReconcileOutcome('app-1', { status: 'running', remaining: [{ ...release, reason: 'worktree-locked' }, marker] });
    // Model an external directory deletion that leaves Git's registration intact.
    const gitDir = (await execGit(['rev-parse', '--absolute-git-dir'], path)).stdout.trim();
    await writeFile(join(gitDir, 'portos-review-status'), 'recoverable private evidence');
    await rm(path, { recursive: true, force: true });
    expect(await registered(path)).toBe(true);
    await recordBranchReconcileOutcome('app-1', { status: 'drained', remaining: [] });
    const pending = await getBranchReconcileOutcome('app-1');
    expect(pending).toMatchObject({ status: 'incomplete', reason: 'retirement-provenance-unverified',
      retirementObligations: [{ ...release, reason: 'retirement-provenance-unverified' }],
    });
    expect(pending.remaining).toHaveLength(1);
    expect(await readFile(join(gitDir, 'portos-review-status'), 'utf8')).toBe('recoverable private evidence');
    const createdAt = pending.retirementObligations[0].createdAt;
    // A receipt for another head cannot explain the original disappearance.
    await recordHeldCheckoutRetirement('app-1', { ...release, head: 'f'.repeat(40), branchDeleted: true, archiveDir: '/example/other-archive' });
    await recordBranchReconcileOutcome('app-1', { status: 'drained', remaining: [] });
    expect(await getBranchReconcileOutcome('app-1')).toMatchObject({ status: 'incomplete', reason: 'retirement-provenance-unverified',
      retirementObligations: [{ ...release, reason: 'retirement-provenance-unverified', createdAt }],
    });
    // Only the trusted service writer can supply recovered preservation evidence.
    await recordHeldCheckoutRetirement('app-1', { ...release, branchDeleted: true, archiveDir: '/example/recovered-original' });
    expect(await getBranchReconcileOutcome('app-1')).toMatchObject({ retirementObligations: [], remaining: [] });
  });

  it('refuses a release that does not name a row of the last inventory', async () => {
    const { path, release } = await heldCheckout('not-inventoried');
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...release, lockReason: 'older lock text' }] });

    expect(await retireInventoriedCheckout({ appId: 'app-1', release }, { cosDir, readAgents: noOwners }))
      .toEqual({ ok: false, reason: 'release-not-in-inventory' });
    expect(existsSync(path)).toBe(true);
  });

  it.each([
    ['a changed lock', async (path) => {
      await execGit(['worktree', 'unlock', path], repo);
      await execGit(['worktree', 'lock', '--reason', 'new owner took over', path], repo);
    }, 'checkout-lock-changed'],
    ['a moved HEAD', async (path) => {
      await writeFile(join(path, 'next.txt'), 'more\n');
      await execGit(['add', 'next.txt'], path);
      await execGit(['commit', '-m', 'chore: synthetic owner commit'], path);
    }, 'checkout-head-changed'],
  ])('treats %s since the inventory as an ownership change', async (_label, change, reason) => {
    const { path, release } = await heldCheckout('changed-owner');
    await change(path);

    expect(await retire(release)).toEqual({ ok: false, reason });
    expect(existsSync(join(path, 'ignored.txt'))).toBe(true);
    expect(await archives()).toEqual([]);
  });

  it('keeps the checkout, its content and its original lock when an owner appears after the archive', async () => {
    const { path, release } = await heldCheckout('owner-arrives', { lockReason: 'handoff pending' });
    let reads = 0;
    // Clear for the pre-archive check; a live run occupies the checkout by the removal recheck.
    const readAgents = async () => (++reads === 1 ? [] : [{ id: 'agent-live', status: 'running', workspacePath: release.path }]);

    const result = await retire(release, { readAgents });

    expect(result).toMatchObject({ ok: false, reason: 'claim-owner-active' });
    expect(await registered(release.path)).toBe(true);
    expect(await lockText(release.path)).toBe('handoff pending');
    for (const name of ['initial.txt', 'untracked.txt', 'ignored.txt']) expect(existsSync(join(path, name))).toBe(true);
    expect(existsSync(join(result.archiveDir, 'manifest.json'))).toBe(true);
  });

  it('keeps the checkout when its content changes between the archive and removal', async () => {
    const { path, release } = await heldCheckout('rewritten');
    let reads = 0;
    // Same length, so only a content hash can tell the archived copy is stale.
    const readAgents = async () => {
      if (++reads === 2) await writeFile(join(path, 'ignored.txt'), 'IGNORED WORK\n');
      return [];
    };

    expect(await retire(release, { readAgents })).toMatchObject({ ok: false, reason: 'checkout-content-changed' });
    expect(await readFile(join(path, 'ignored.txt'), 'utf8')).toBe('IGNORED WORK\n');
    expect(await lockText(release.path)).toBe('synthetic external owner');
  });

  it('keeps everything and leaves no partial archive when the archive cannot be completed', async () => {
    const { path, release } = await heldCheckout('archive-fails');
    // A nested repository is listed without its files, so it cannot be archived faithfully.
    await mkdir(join(path, 'nested'));
    await execGit(['init', '-q'], join(path, 'nested'));

    const result = await retire(release);

    expect(result).toMatchObject({ ok: false, reason: 'archive-failed' });
    expect(await lockText(release.path)).toBe('synthetic external owner');
    expect(existsSync(join(path, 'nested', '.git'))).toBe(true);
    expect(await archives()).toEqual([]);
  });

  // #12682: archive I/O ran inside the shared ownership lock and starved every
  // claim-ownership check behind its 15 s queue budget for minutes.
  it('archives with the ownership queue free while fencing only the checkout being retired', async () => {
    const { path, release } = await heldCheckout('fenced', { branch: 'feature/fenced' });
    let paused;
    let resume;
    const pausedArchive = new Promise(resolve => { paused = resolve; });
    injected.onBundle = () => new Promise(resolve => { resume = resolve; paused(); });
    const admission = branch => checkReconcileOwnership({ appId: 'app-1', branch },
      { getAgents: async () => [], getActiveAgentIds: () => [], readCompletionHold: async () => null });

    const retiring = retire(release);
    await pausedArchive;
    injected.onBundle = null;
    expect(await withClaimOwnershipLock(() => 'settled')).toBe('settled');
    expect(await admission('feature/fenced')).toEqual({ admitted: false, reason: 'checkout-retirement-reserved' });
    expect(await admission('feature/unrelated')).toEqual({ admitted: true });
    expect(await retireInventoriedCheckout({ appId: 'app-1', release }, { cosDir, readAgents: noOwners }))
      .toEqual({ ok: false, reason: 'checkout-retirement-reserved' });
    expect(existsSync(join(path, 'ignored.txt'))).toBe(true);

    resume();
    expect(await retiring).toMatchObject({ ok: true });
    expect(existsSync(path)).toBe(false);
    expect(await admission('feature/fenced')).toEqual({ admitted: true });
  });

  it.each([
    // A file the archive did not see when it started, so only the final re-read catches it.
    ['content', async (path) => writeFile(join(path, 'late.txt'), 'late work\n'), 'checkout content changed while archiving'],
    ['administration', async (path) => writeFile(join((await execGit(['rev-parse', '--absolute-git-dir'], path)).stdout.trim(), 'MERGE_MSG'), 'synthetic\n'),
      'administration changed while archiving'],
  ])('keeps the checkout when its %s changes while the unlocked archive runs', async (label, change, detail) => {
    const { path, release } = await heldCheckout(`mid-archive-${label}`);
    injected.onBundle = () => change(path);

    expect(await retire(release)).toEqual({ ok: false, reason: 'archive-failed', detail });
    expect(await registered(release.path)).toBe(true);
    expect(await lockText(release.path)).toBe('synthetic external owner');
    expect(await archives()).toEqual([]);
  });

  it('refuses unmerged work and a manual completion handoff before archiving anything', async () => {
    const unmerged = await heldCheckout('unmerged');
    await execGit(['worktree', 'unlock', unmerged.path], repo);
    await execGit(['commit', '--allow-empty', '-m', 'feat: synthetic unmerged work'], unmerged.path);
    const head = (await execGit(['rev-parse', 'HEAD'], unmerged.path)).stdout.trim();
    expect(await retire({ ...unmerged.release, head, locked: false, lockReason: null }))
      .toEqual({ ok: false, reason: 'not-merged-on-recheck' });

    const handoff = await heldCheckout('handoff', { branch: 'feature/handoff' });
    injected.policies = [{ id: 'agent-done', status: 'completed', startedAt: '2026-01-01T00:00:00.000Z',
      metadata: { sourceWorkspace: repo, worktreeBranch: 'feature/handoff', prCompletionPolicy: 'leave-open' } }];
    expect(await retire(handoff.release))
      .toEqual({ ok: false, reason: 'pr-completion-human-handoff' });
    expect(existsSync(handoff.path)).toBe(true);
    expect(await archives()).toEqual([]);
  });
  async function reviewedCheckout(name, { superseded = false, gitlink = false, normalMerge = false, featurePath = 'feature.txt', multipleCommits = false } = {}) {
    let firstCommit;
    let changeBase;
    const { path, release } = await heldCheckout(name, { branch: `feature/${name}`, beforeLock: async tree => {
      await writeFile(join(tree, featurePath), 'original feature\n');
      await execGit(['--literal-pathspecs', 'add', featurePath], tree);
      if (gitlink) {
        const commit = (await execGit(['rev-parse', 'HEAD'], tree)).stdout.trim();
        await execGit(['update-index', '--add', '--cacheinfo', `160000,${commit},vendor`], tree);
        await mkdir(join(tree, 'vendor'));
      }
      changeBase = (await execGit(['rev-parse', 'HEAD'], tree)).stdout.trim();
      await execGit(['commit', '-m', 'original feature'], tree);
      firstCommit = (await execGit(['rev-parse', 'HEAD'], tree)).stdout.trim();
      if (multipleCommits) {
        await writeFile(join(tree, 'second.txt'), 'second original change\n');
        await execGit(['add', 'second.txt'], tree);
        await execGit(['commit', '-m', 'second original change'], tree);
      }
      if (normalMerge) await execGit(['merge', '--ff-only', `feature/${name}`], repo);
      else {
        await execGit(['merge', '--squash', `feature/${name}`], repo);
        await execGit(['commit', '-m', 'shipped feature'], repo);
      }
      if (superseded) {
        await writeFile(join(repo, featurePath), 'strengthened replacement\n');
        await execGit(['commit', '-am', 'strengthen implementation'], repo);
      }
    } });
    const [main, admin] = (await Promise.all([
      execGit(['rev-parse', 'main'], repo), execGit(['rev-parse', '--absolute-git-dir'], path),
    ])).map(result => result.stdout.trim());
    await writeFile(join(admin, 'portos-review-status'), 'private synthetic review marker');
    injected.policies = [{ id: 'agent-legacy', status: 'completed', result: { success: true },
      metadata: { workspacePath: repo, claimBranches: [release.branch], prCompletionPolicy: 'review-then-merge' } }];
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...release, reason: 'pr-completion-review-required' }] });
    const forge = { changedPaths: [featurePath, ...(gitlink ? ['vendor'] : []), ...(multipleCommits ? ['second.txt'] : [])], changeBase, firstCommit, repository: 'github.com/example/repo', prUrl: 'https://github.com/example/repo/pull/42', prHead: release.head,
      mergeCommit: main, defaultBranch: 'main', defaultHead: main, remoteHead: null };
    const opts = { cosDir, readAgents: noOwners, readForge: async () => forge };
    const prepare = () => prepareInventoriedCheckoutRetirement({ appId: 'app-1', release, prUrl: forge.prUrl }, opts);
    const confirm = (review, more = {}) => retireInventoriedCheckout({ appId: 'app-1', release,
      review: { prUrl: forge.prUrl, digest: review.digest, acceptSuperseded: superseded } }, { ...opts, ...more });
    return { path, release, admin, opts, forge, prepare, confirm };
  }

  async function receiptCheckout(name, options) {
    const checkout = await reviewedCheckout(name, options);
    await execGit(['worktree', 'unlock', checkout.path], repo);
    checkout.release = { ...checkout.release, locked: false, lockReason: null };
    // A modern completed owner has a PR policy; no operator inventory grant.
    injected.policies[0].metadata.branchCompletionPolicy = {
      branch: checkout.release.branch, completion: 'review-then-merge',
      prUrl: checkout.forge.prUrl, tip: checkout.release.head,
    };
    injected.schedule.executions = {};
    checkout.retireReceipt = (opts = {}) => retirePendingMergeCheckout({
      repoPath: repo, release: checkout.release, prUrl: checkout.forge.prUrl,
      expectedHeadSha: checkout.release.head,
    }, { ...checkout.opts, ...opts });
    return checkout;
  }

  it('refuses file-count overflow before preview, reviewed retirement or unattended archive publication', async () => {
    const c = await reviewedCheckout('file-count-overflow', { normalMerge: true });
    const prepared = await c.prepare();
    expect(prepared.ok).toBe(true);
    await writeFile(join(c.path, '.gitignore'), 'ignored.txt\nlinked\nprivate-files/\n');
    const directory = join(c.path, 'private-files');
    await mkdir(directory);
    // Content alone stays below 1000; its private Git administration crosses the shared limit.
    const files = Array.from({ length: 995 }, (_, i) => join(directory, `item-${i}`));
    await Promise.all(files.map(file => writeFile(file, 'preserve every tiny file\n')));
    const hashes = await Promise.all(files.map(sha256File));
    const before = await getBranchReconcileOutcome('app-1');
    const refusal = { ok: false, reason: 'retirement-archive-file-limit-exceeded' };
    expect(await c.prepare()).toEqual(refusal);
    expect(await c.confirm(prepared.review)).toEqual(refusal);
    expect(await retireInventoriedCheckout({ appId: 'app-1', release: c.release }, {
      ...c.opts, settleMergedReviewObligation: true,
    })).toEqual(refusal);
    expect(await Promise.all(files.map(sha256File))).toEqual(hashes);
    expect(await registered(c.path)).toBe(true);
    expect(await lockText(c.path)).toBe(c.release.lockReason);
    expect((await execGit(['rev-parse', c.release.branch], repo)).stdout.trim()).toBe(c.release.head);
    expect(await archives()).toEqual([]);
    expect(await getBranchReconcileOutcome('app-1')).toEqual(before);
  });

  it('refuses combined content and administration bytes before preview or teardown while each snapshot fits', async () => {
    const c = await reviewedCheckout('combined-byte-limit', { normalMerge: true });
    const prepared = await c.prepare();
    expect(prepared.ok).toBe(true);
    await writeFile(join(c.path, '.gitignore'), 'ignored.txt\nlinked\nprivate-files/\n');
    const bytes = 22 * 1024 * 1024;
    const files = [];
    for (const root of [c.path, c.admin]) {
      const directory = join(root, 'private-files');
      await mkdir(directory);
      for (let i = 0; i < 6; i++) {
        const file = join(directory, `item-${i}`);
        await writeFile(file, 'retained bytes\n');
        await truncate(file, bytes);
        files.push(file);
      }
    }
    const hashes = await Promise.all(files.map(sha256File));
    const before = await getBranchReconcileOutcome('app-1');
    const refusal = { ok: false, reason: 'retirement-archive-limit-exceeded', archiveLimit: {
      scope: 'combined', kind: 'total', limitBytes: 250 * 1024 * 1024, observedBytes: expect.any(Number),
    } };
    const preview = await c.prepare();
    expect(preview).toEqual(refusal);
    expect(preview.archiveLimit.observedBytes).toBeGreaterThanOrEqual(12 * bytes);
    expect(preview.archiveLimit.observedBytes).toBeLessThan(12 * bytes + 1024 * 1024);
    expect(await c.confirm(prepared.review)).toEqual(refusal);
    expect(await retireInventoriedCheckout({ appId: 'app-1', release: c.release }, {
      ...c.opts, settleMergedReviewObligation: true,
    })).toEqual(refusal);
    expect(await Promise.all(files.map(sha256File))).toEqual(hashes);
    expect(await registered(c.path)).toBe(true);
    expect(await lockText(c.path)).toBe(c.release.lockReason);
    expect((await execGit(['rev-parse', c.release.branch], repo)).stdout.trim()).toBe(c.release.head);
    expect(await archives()).toEqual([]);
    expect(await getBranchReconcileOutcome('app-1')).toEqual(before);
  });

  it('admits a near-boundary file-count archive that the missing-checkout verifier can independently recover', async () => {
    const c = await reviewedCheckout('file-count-admitted', { normalMerge: true });
    await writeFile(join(c.path, '.gitignore'), 'ignored.txt\nlinked\nprivate-files/\n');
    const directory = join(c.path, 'private-files');
    await mkdir(directory);
    await Promise.all(Array.from({ length: 980 }, (_, i) => writeFile(join(directory, `item-${i}`), 'retained ignored bytes\n')));
    const createdAt = new Date().toISOString();
    const prepared = await c.prepare();
    expect(prepared.ok).toBe(true);
    const retired = await c.confirm(prepared.review);
    expect(retired).toMatchObject({ ok: true, branchDeleted: true });
    const manifest = JSON.parse(await readFile(join(retired.archiveDir, 'manifest.json'), 'utf8'));
    const capturedCount = manifest.captured.files.length + manifest.administration.files.length;
    expect(capturedCount).toBeGreaterThanOrEqual(990);
    expect(capturedCount).toBeLessThanOrEqual(1000);
    const before = await getBranchReconcileOutcome('app-1');
    const proof = await findMissingCheckoutPreservation({ repoPath: repo, release: { ...c.release, createdAt } }, { cosDir });
    expect(proof, `Standalone archive proof failures: ${JSON.stringify(injected.proofFailures)}`)
      .toMatchObject({ archiveDir: retired.archiveDir, evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(await proof.recheck()).toBe(true);
    expect(await getBranchReconcileOutcome('app-1')).toEqual(before);
  });

  it.each([
    { scope: 'content', kind: 'file', count: 1, bytes: 25 * 1024 * 1024 + 1 },
    { scope: 'content', kind: 'total', count: 11, bytes: 24 * 1024 * 1024 },
    { scope: 'administration', kind: 'file', count: 1, bytes: 25 * 1024 * 1024 + 1 },
    { scope: 'administration', kind: 'total', count: 11, bytes: 24 * 1024 * 1024 },
  ])('reports $scope $kind capacity at the public preview boundary without changing checkout bytes', async ({ scope, kind, count, bytes }) => {
    const c = await reviewedCheckout('archive-capacity');
    const root = join(scope === 'content' ? c.path : c.admin, 'private-build-output');
    await mkdir(root);
    if (scope === 'content') await writeFile(join(c.path, '.gitignore'), 'ignored.txt\nlinked\nprivate-build-output/\n');
    const files = Array.from({ length: count }, (_, i) => join(root, `private-${i}.bin`));
    for (const file of files) {
      await writeFile(file, 'synthetic preserved bytes');
      await truncate(file, bytes);
    }
    const hashes = await Promise.all(files.map(sha256File));
    const before = await getBranchReconcileOutcome('app-1');
    const result = await c.prepare();
    expect(result).toEqual({ ok: false, reason: 'retirement-archive-limit-exceeded', archiveLimit: {
      scope, kind, limitBytes: (kind === 'file' ? 25 : 250) * 1024 * 1024, observedBytes: expect.any(Number),
    } });
    expect(Number.isSafeInteger(result.archiveLimit.observedBytes)).toBe(true);
    expect(result.archiveLimit.observedBytes).toBeGreaterThan(result.archiveLimit.limitBytes);
    expect(result.archiveLimit.observedBytes).toBeLessThanOrEqual(count * bytes + 1024 * 1024);
    expect(JSON.stringify(result)).not.toContain('private-');
    expect(JSON.stringify(result)).not.toContain(c.path);
    expect(JSON.stringify(result)).not.toContain(c.admin);
    expect(await Promise.all(files.map(sha256File))).toEqual(hashes);
    expect(await registered(c.path)).toBe(true);
    expect(await lockText(c.path)).toBe(c.release.lockReason);
    expect((await execGit(['rev-parse', c.release.branch], repo)).stdout.trim()).toBe(c.release.head);
    expect(await archives()).toEqual([]);
    expect(await getBranchReconcileOutcome('app-1')).toEqual(before);
  });

  it('keeps non-capacity local evidence failures distinct from archive capacity', async () => {
    const c = await reviewedCheckout('unreadable-snapshot');
    await execGit(['update-index', '--skip-worktree', 'initial.txt'], c.path);
    expect(await c.prepare()).toEqual({ ok: false, reason: 'retirement-local-evidence-unavailable' });
    expect(await registered(c.path)).toBe(true);
    expect(await archives()).toEqual([]);
  });

  it.each(['reviewed', 'merged'])('retains archive capacity evidence when %s retirement refuses before archival', async mode => {
    const c = await reviewedCheckout('retire-capacity', { normalMerge: true });
    const prepared = await c.prepare();
    expect(prepared.ok).toBe(true);
    const file = join(c.path, 'ignored.txt');
    const bytes = 25 * 1024 * 1024 + 1;
    await truncate(file, bytes);
    const hash = await sha256File(file);
    const before = await getBranchReconcileOutcome('app-1');
    const result = mode === 'reviewed' ? await c.confirm(prepared.review)
      : await retireInventoriedCheckout({ appId: 'app-1', release: c.release }, { ...c.opts, settleMergedReviewObligation: true });
    expect(result).toEqual({ ok: false, reason: 'retirement-archive-limit-exceeded', archiveLimit: {
      scope: 'content', kind: 'file', limitBytes: bytes - 1, observedBytes: bytes,
    } });
    expect(await sha256File(file)).toBe(hash);
    expect(await registered(c.path)).toBe(true);
    expect(await lockText(c.path)).toBe(c.release.lockReason);
    expect((await execGit(['rev-parse', c.release.branch], repo)).stdout.trim()).toBe(c.release.head);
    expect(await archives()).toEqual([]);
    expect(await getBranchReconcileOutcome('app-1')).toEqual(before);
  });

  it('retires a merged receipt checkout without an inventory grant, preserving ignored bytes and original commits', async () => {
    const c = await receiptCheckout('receipt', { gitlink: true });
    const result = await c.retireReceipt();
    expect(result).toMatchObject({ ok: true, branchDeleted: true });
    expect(await registered(c.release.path)).toBe(false);
    expect(await readFile(join(result.archiveDir, 'files/ignored.txt'), 'utf8')).toBe('ignored work\n');
    const manifest = JSON.parse(await readFile(join(result.archiveDir, 'manifest.json'), 'utf8'));
    expect(manifest.captured.gitlinks).toMatchObject([{ path: 'vendor', state: 'empty' }]);
    expect(manifest.review.policy.receiptHead).toBe(c.release.head);
    await execGit(['fetch', join(result.archiveDir, 'commits.bundle'), 'HEAD:refs/heads/receipt-restored'], repo);
    expect((await execGit(['rev-parse', 'receipt-restored'], repo)).stdout.trim()).toBe(c.release.head);
  });

  it('refreshes missing operator-review proof objects after remote main moves without accepting the old digest or advancing refs', async () => {
    const c = await reviewedCheckout('advanced-default');
    const before = await c.prepare();
    expect(before.ok).toBe(true);
    const oldMain = (await execGit(['rev-parse', 'main'], repo)).stdout.trim();
    const remote = join(scratch, 'remote-proof');
    await execGit(['clone', '--no-hardlinks', repo, remote], scratch);
    await execGit(['config', 'user.email', 'test@example.com'], remote);
    await execGit(['config', 'user.name', 'Test'], remote);
    await execGit(['commit', '--allow-empty', '-m', 'unrelated remote main advance'], remote);
    c.forge.defaultHead = (await execGit(['rev-parse', 'HEAD'], remote)).stdout.trim();
    await execGit(['remote', 'add', 'origin', 'https://github.com/example/repo.git'], repo);
    injected.fetchRemote = remote;
    const prepared = await c.prepare();
    expect(prepared.ok).toBe(true);
    expect(prepared.review.digest).not.toBe(before.review.digest);
    expect(injected.fetches).toHaveLength(1);
    expect(injected.fetches[0].args).toEqual(expect.arrayContaining(['--no-write-fetch-head', '--no-recurse-submodules', '--refmap=', c.forge.defaultHead]));
    expect((await execGit(['rev-parse', 'main'], repo)).stdout.trim()).toBe(oldMain);
    expect((await execGit(['rev-parse', c.release.branch], repo)).stdout.trim()).toBe(c.release.head);
    expect(existsSync(join(repo, '.git', 'FETCH_HEAD'))).toBe(false);
    expect(await c.confirm(before.review)).toMatchObject({ ok: false, reason: 'retirement-review-changed' });
    expect(await lockText(c.release.path)).toBe(c.release.lockReason);
    expect(await archives()).toEqual([]);
    expect(await readFile(join(c.path, 'ignored.txt'), 'utf8')).toBe('ignored work\n');
  });

  it('fetches a remote-only squash commit for receipt proof without advancing any local branch', async () => {
    const base = (await execGit(['rev-parse', 'main'], repo)).stdout.trim();
    const c = await heldCheckout('remote-merge', { branch: 'feature/remote-merge', beforeLock: async tree => {
      await writeFile(join(tree, 'feature.txt'), 'remote feature\n');
      await execGit(['add', 'feature.txt'], tree);
      await execGit(['commit', '-m', 'feature awaiting remote merge'], tree);
    } });
    await execGit(['worktree', 'unlock', c.path], repo);
    const release = { ...c.release, locked: false, lockReason: null };
    const remote = join(scratch, 'remote');
    await execGit(['clone', '--no-hardlinks', repo, remote], scratch);
    await execGit(['config', 'user.email', 'test@example.com'], remote);
    await execGit(['config', 'user.name', 'Test'], remote);
    await execGit(['merge', '--squash', 'origin/feature/remote-merge'], remote);
    await execGit(['commit', '-m', 'remote squash merge'], remote);
    const merged = (await execGit(['rev-parse', 'HEAD'], remote)).stdout.trim();
    expect((await execGit(['cat-file', '-e', `${merged}^{commit}`], repo, { ignoreExitCode: true })).exitCode)
      .not.toBe(0);
    await execGit(['remote', 'add', 'origin', 'https://github.com/example/repo.git'], repo);
    injected.fetchRemote = remote;
    const prUrl = 'https://github.com/example/repo/pull/42';
    const forge = { repository: 'github.com/example/repo', prUrl, prHead: release.head,
      mergeCommit: merged, defaultHead: merged, defaultBranch: 'main', remoteHead: null,
      changedPaths: ['feature.txt'], changeBase: base, firstCommit: release.head };
    const result = await retirePendingMergeCheckout({ repoPath: repo, release, prUrl, expectedHeadSha: release.head }, {
      cosDir, readAgents: noOwners, readForge: async () => forge, forgeAccount: 'synthetic-account',
    });
    expect(result).toMatchObject({ ok: true, branchDeleted: true });
    expect((await execGit(['rev-parse', 'main'], repo)).stdout.trim()).toBe(base);
    expect(existsSync(join(repo, '.git', 'FETCH_HEAD'))).toBe(false);
    expect(injected.fetches).toHaveLength(1);
    expect(injected.fetches[0].args).toEqual(expect.arrayContaining([
      '--no-write-fetch-head', '--no-recurse-submodules', '--refmap=', 'https://github.com/example/repo.git', merged,
    ]));
    expect(injected.fetches[0].options).toMatchObject({ timeout: 30_000,
      env: { GH_TOKEN: 'synthetic-account-token', GIT_TERMINAL_PROMPT: '0' } });
    expect(await readFile(join(result.archiveDir, 'files/ignored.txt'), 'utf8')).toBe('ignored work\n');
  });

  it.each(['head', 'supersession'])('preserves a receipt checkout when merged evidence has changed: %s', async change => {
    const c = await receiptCheckout('receipt-evidence', {
      superseded: change === 'supersession', multipleCommits: change === 'head',
    });
    // A different head with valid original ancestry reaches the receipt's
    // exact-head guard; the squash commit has no such ancestry and fails earlier.
    if (change === 'head') {
      c.forge.prHead = c.forge.firstCommit;
      c.forge.changedPaths = ['feature.txt'];
    }
    expect(await c.retireReceipt()).toMatchObject({ ok: false,
      reason: change === 'head' ? 'receipt-pr-head-changed' : 'retirement-supersession-not-accepted' });
    expect(await registered(c.release.path)).toBe(true);
    expect(await archives()).toEqual([]);
  });

  it('retains manual, locked, unreadable and initialized-submodule receipt checkouts', async () => {
    const c = await receiptCheckout('receipt-holds', { gitlink: true });
    injected.policies[0].metadata.branchCompletionPolicy.completion = 'leave-open';
    expect(await c.retireReceipt()).toMatchObject({ ok: false, reason: 'pr-completion-human-handoff' });
    injected.policies[0].metadata.branchCompletionPolicy.completion = 'review-then-merge';
    expect(await c.retireReceipt({ readAgents: async () => null })).toMatchObject({ ok: false, reason: 'claim-ownership-unreadable' });
    expect(await c.retireReceipt({ readPolicies: async () => null })).toMatchObject({ ok: false, reason: 'pr-completion-policy-unavailable' });
    await execGit(['worktree', 'lock', '--reason', 'new owner', c.path], repo);
    expect(await c.retireReceipt()).toMatchObject({ ok: false, reason: 'checkout-lock-changed' });
    await execGit(['worktree', 'unlock', c.path], repo);
    await writeFile(join(c.path, 'vendor', 'unique.txt'), 'submodule work');
    expect(await c.retireReceipt()).toMatchObject({ ok: false, reason: 'retirement-submodule-not-uninitialized' });
    expect(await readFile(join(c.path, 'vendor', 'unique.txt'), 'utf8')).toBe('submodule work');
    expect(await registered(c.release.path)).toBe(true);
    expect(await archives()).toEqual([]);
  });

  it('preserves a receipt checkout when an owner appears during its archive', async () => {
    const c = await receiptCheckout('receipt-new-owner');
    let reads = 0;
    const result = await c.retireReceipt({ readAgents: async () => (++reads < 4 ? [] : [{
      id: 'agent-live', status: 'running', workspacePath: c.release.path,
    }]) });
    expect(result).toMatchObject({ ok: false, reason: 'claim-owner-active', archiveDir: expect.any(String) });
    expect(await registered(c.release.path)).toBe(true);
    expect(await readFile(join(result.archiveDir, 'files/ignored.txt'), 'utf8')).toBe('ignored work\n');
  });

  it('reviews original changes after an ancestral merged tip is later changed', async () => {
    const c = await reviewedCheckout('ancestral', { normalMerge: true, superseded: true });
    const prepared = await c.prepare();
    expect(prepared.ok).toBe(true);
    expect(prepared.review.comparison.disposition).toBe('review-supersession');
    expect(prepared.review.comparison.localPatch).toContain('+original feature');
    expect(prepared.review.comparison.difference).toContain('+strengthened replacement');
  });

  it('compares pathspec glob filenames literally', async () => {
    const c = await reviewedCheckout('literal', { featurePath: '[literal].txt', superseded: true });
    await writeFile(join(repo, 'l.txt'), 'unrelated glob match\n');
    await execGit(['add', 'l.txt'], repo);
    await execGit(['commit', '-m', 'unrelated default change'], repo);
    c.forge.defaultHead = (await execGit(['rev-parse', 'HEAD'], repo)).stdout.trim();
    const prepared = await c.prepare();
    expect(prepared.ok).toBe(true);
    expect(prepared.review.comparison.disposition).toBe('review-supersession');
    expect(prepared.review.comparison.difference).toContain('+strengthened replacement');
    expect(prepared.review.comparison.difference).not.toContain('unrelated glob match');
  });

  it('retains all original changes in a multi-commit squash review', async () => {
    const c = await reviewedCheckout('multi', { multipleCommits: true });
    const prepared = await c.prepare();
    expect(prepared.ok).toBe(true);
    expect(prepared.review.comparison.localPatch).toContain('+original feature');
    expect(prepared.review.comparison.localPatch).toContain('+second original change');
    expect(prepared.review.comparison.disposition).toBe('integrated');
  });

  it.each([false, true])('requires a new scoped review for completed legacy owners, superseded=%s', async superseded => {
    const c = await reviewedCheckout('legacy', { superseded, gitlink: true });
    if (!superseded) expect(await retireInventoriedCheckout({ appId: 'app-1', release: c.release }, c.opts))
      .toMatchObject({ ok: false, reason: 'pr-completion-review-required' });
    const prepared = await c.prepare();
    expect(prepared.ok).toBe(true);
    expect(prepared.review.comparison.disposition).toBe(superseded ? 'review-supersession' : 'integrated');
    if (superseded) expect(await retireInventoriedCheckout({ appId: 'app-1', release: c.release,
      review: { prUrl: c.forge.prUrl, digest: prepared.review.digest, acceptSuperseded: false } }, c.opts))
      .toMatchObject({ ok: false, reason: 'retirement-supersession-not-accepted' });
    const result = await c.confirm(prepared.review);
    expect(result).toMatchObject({ ok: true, branchDeleted: true });
    const manifest = JSON.parse(await readFile(join(result.archiveDir, 'manifest.json'), 'utf8'));
    expect(manifest.review.digest).toBe(prepared.review.digest);
    expect(manifest.captured.gitlinks).toMatchObject([{ path: 'vendor', state: 'empty' }]);
    expect(await readFile(join(result.archiveDir, 'administration/gitdir/portos-review-status'), 'utf8')).toBe('private synthetic review marker');
    expect(await readFile(join(result.archiveDir, 'files/ignored.txt'), 'utf8')).toBe('ignored work\n');
    await execGit(['fetch', join(result.archiveDir, 'commits.bundle'), 'HEAD:refs/heads/restored-legacy'], repo);
    expect((await execGit(['rev-parse', 'restored-legacy'], repo)).stdout.trim()).toBe(c.release.head);
    expect(injected.policies[0].metadata.branchCompletionPolicy).toBeUndefined();
  });

  it('settles a review obligation for unattended retirement only once every commit is on the default branch', async () => {
    const c = await reviewedCheckout('settled', { normalMerge: true, superseded: true });
    await execGit(['worktree', 'unlock', c.path], repo);
    const release = { ...c.release, locked: false, lockReason: null };
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...release, reason: 'pr-completion-review-required' }] });
    const retire = (more = {}) => retireInventoriedCheckout({ appId: 'app-1', release }, { ...c.opts, ...more });
    // A reused branch: the obligation names an earlier PR, not this head.
    injected.policies[0].metadata.branchCompletionPolicy = {
      branch: release.branch, completion: 'review-then-merge', prUrl: 'https://github.com/example/repo/pull/41', tip: null,
    };
    injected.policies[0].metadata.branchCompletionPolicy.completion = 'leave-open';
    expect(await retire({ settleMergedReviewObligation: true })).toMatchObject({ ok: false, reason: 'pr-completion-human-handoff' });
    injected.policies[0].metadata.branchCompletionPolicy.completion = 'review-then-merge';
    expect(await retire()).toMatchObject({ ok: false, reason: 'pr-completion-review-required' });
    expect(await registered(release.path)).toBe(true);
    const result = await retire({ settleMergedReviewObligation: true });
    expect(result).toMatchObject({ ok: true, branchDeleted: true });
    expect(await registered(release.path)).toBe(false);
    await execGit(['fetch', join(result.archiveDir, 'commits.bundle'), 'HEAD:refs/heads/restored-settled'], repo);
    expect((await execGit(['rev-parse', 'restored-settled'], repo)).stdout.trim()).toBe(release.head);
  });

  function reusedBranchOwners(c) {
    const current = { id: 'current-review-owner', status: 'completed', result: { success: true },
      startedAt: '2026-03-01T00:00:00Z', completedAt: '2026-03-01T01:00:00Z',
      metadata: { sourceWorkspace: repo, workspacePath: c.release.path, worktreeBranch: c.release.branch,
        prCompletionPolicy: 'review-then-merge', reviewLoopMergeTarget: { branch: c.release.branch, url: c.forge.prUrl } } };
    // Reused quality branches retain older records with no explicit policy,
    // including unsuccessful launches. Distinct completed checkout incarnations
    // are history; neither their age nor a success summary grants permission.
    const prior = Array.from({ length: 33 }, (_, index) => ({
      id: `prior-owner-${index}`, status: 'completed', result: { success: index !== 0 },
      startedAt: '2026-02-01T00:00:00Z', completedAt: '2026-02-01T01:00:00Z',
      metadata: { sourceWorkspace: repo, workspacePath: join(external, `prior-${index}`), worktreeBranch: c.release.branch },
    }));
    injected.policies = [current, ...prior, {
      id: 'unscoped-successful-recovery', status: 'completed', result: { success: true },
      metadata: { workspacePath: repo, recoveryOrigin: { subsystem: 'repository-cleanup', parentAgentId: current.id } },
    }];
    return current;
  }

  it('retires reviewed metadata with unrelated hashes while recovering only structural reflog and fetch objects', async () => {
    const c = await reviewedCheckout('metadata-hashes');
    const absent = '1'.repeat(40);
    expect((await execGit(['cat-file', '-e', absent], repo, { ignoreExitCode: true })).exitCode).not.toBe(0);
    const metadata = Buffer.from(`${JSON.stringify({ reviews: [{ user: { avatar_url: `https://example.invalid/avatar/${absent}` } }], note: '2'.repeat(64) }, null, 2)}\n`);
    await writeFile(join(c.admin, 'portos-pr-review-outcome.json'), metadata);
    await writeFile(join(c.admin, 'COMMIT_EDITMSG'), `Unrelated message hash ${absent}\n`);
    const tree = (await execGit(['rev-parse', 'HEAD^{tree}'], c.path)).stdout.trim();
    const old = (await execGit(['commit-tree', tree, '-m', 'only in the old reflog field'], c.path)).stdout.trim();
    const next = (await execGit(['commit-tree', tree, '-m', 'only in the new reflog field'], c.path)).stdout.trim();
    const fetched = (await execGit(['commit-tree', tree, '-m', 'only in FETCH_HEAD'], c.path)).stdout.trim();
    await writeFile(join(c.admin, 'logs/HEAD'), `${old} ${next} Test <test@example.com> 1 +0000\tmessage ${absent}\n`);
    await writeFile(join(c.admin, 'FETCH_HEAD'), `${fetched}\tnot-for-merge\tbranch '${absent}' of https://example.invalid/repo\n`);
    const prepared = await c.prepare();
    expect(prepared.ok).toBe(true);
    const result = await c.confirm(prepared.review);
    expect(result).toMatchObject({ ok: true, branchDeleted: true, archiveDir: expect.any(String) });
    expect(existsSync(c.path)).toBe(false);
    expect(await readFile(join(result.archiveDir, 'administration/gitdir/portos-pr-review-outcome.json'))).toEqual(metadata);
    expect((await getBranchReconcileOutcome('app-1')).retired).toContainEqual(expect.objectContaining({
      path: c.release.path, branch: c.release.branch, head: c.release.head, archiveDir: result.archiveDir, branchDeleted: true,
    }));
    const manifest = JSON.parse(await readFile(join(result.archiveDir, 'manifest.json'), 'utf8'));
    expect(manifest.captured.recoveryHeads).toEqual(expect.arrayContaining([old, next, fetched]));
    expect(manifest.captured.recoveryHeads).not.toContain(absent);
    await rename(repo, `${repo}-unavailable`);
    const restored = join(scratch, 'metadata-restored');
    await execGit(['init', '--bare', restored], scratch);
    await execGit(['fetch', join(result.archiveDir, 'commits.bundle'), '+refs/portos/archive/*:refs/recovered/*'], restored);
    for (const oid of [old, next, fetched]) expect((await execGit(['cat-file', '-t', oid], restored)).stdout.trim()).toBe('commit');
    await execGit(['fsck', '--full', '--strict'], restored);
  });

  it('retires a freshly reviewed reused-branch incarnation with a standalone archive and exact receipt', async () => {
    const c = await reviewedCheckout('quality-reused', { gitlink: true });
    reusedBranchOwners(c);
    const shared = join(scratch, 'shared-dependencies');
    await mkdir(shared);
    await writeFile(join(shared, 'untouched'), 'shared installation\n');
    if (SYMLINKS) {
      await writeFile(join(c.path, '.gitignore'), 'ignored.txt\nlinked\nnode_modules\n');
      for (const relative of ['node_modules', 'server/node_modules', 'client/node_modules', 'autofixer/node_modules']) {
        await mkdir(dirname(join(c.path, relative)), { recursive: true });
        await symlink(shared, join(c.path, relative), 'dir');
      }
    }
    await writeFile(join(c.path, 'staged.txt'), 'unique staged content\n');
    await execGit(['add', 'staged.txt'], c.path);
    const index = await readFile(join(c.admin, 'index'));
    const reflog = await readFile(join(c.admin, 'logs/HEAD'));
    const policiesBefore = structuredClone(injected.policies);
    const prepared = await c.prepare();
    expect(prepared).toMatchObject({ ok: true, review: { policy: {
      policies: [{ id: 'current-review-owner' }], reviewedPr: { tip: c.release.head, prUrl: c.forge.prUrl },
    } } });
    expect(prepared.review.policy.priorCheckouts).toHaveLength(33);
    expect(prepared.review.comparison.localPatch).toContain('original feature');
    const result = await c.confirm(prepared.review);
    expect(result).toMatchObject({ ok: true, branchDeleted: true, archiveDir: expect.any(String) });
    expect(existsSync(c.path)).toBe(false);
    expect(await registered(c.release.path)).toBe(false);
    expect((await execGit(['show-ref', '--verify', '--quiet', `refs/heads/${c.release.branch}`], repo, { ignoreExitCode: true })).exitCode).not.toBe(0);
    expect((await getBranchReconcileOutcome('app-1')).retired).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: c.release.path, branch: c.release.branch, head: c.release.head,
        archiveDir: result.archiveDir, branchDeleted: true }),
    ]));
    expect(injected.policies).toEqual(policiesBefore);
    const manifest = JSON.parse(await readFile(join(result.archiveDir, 'manifest.json'), 'utf8'));
    expect(manifest.captured.gitlinks).toMatchObject([{ path: 'vendor', state: 'empty' }]);
    if (SYMLINKS) {
      expect(manifest.captured.symlinks.filter(link => link.path.endsWith('node_modules'))).toHaveLength(4);
      expect(manifest.captured.files.some(file => file.path.includes('node_modules/'))).toBe(false);
    }
    expect(await readFile(join(shared, 'untouched'), 'utf8')).toBe('shared installation\n');
    expect(await readFile(join(result.archiveDir, 'administration/gitdir/index'))).toEqual(index);
    expect(await readFile(join(result.archiveDir, 'administration/gitdir/logs/HEAD'))).toEqual(reflog);
    expect(await readFile(join(result.archiveDir, 'administration/gitdir/portos-review-status'), 'utf8')).toBe('private synthetic review marker');
    expect(await readFile(join(result.archiveDir, 'files/ignored.txt'), 'utf8')).toBe('ignored work\n');
    expect(await readFile(join(result.archiveDir, 'files/untracked.txt'), 'utf8')).toBe('untracked work\n');
    await rename(repo, `${repo}-unavailable`);
    const restored = join(scratch, 'standalone');
    await execGit(['init', restored], scratch);
    await execGit(['fetch', join(result.archiveDir, 'commits.bundle'), '+refs/portos/archive/*:refs/recovered/*'], restored);
    await execGit(['checkout', '--detach', c.release.head], restored);
    await execGit(['apply', '--index', join(result.archiveDir, 'index.diff')], restored);
    await execGit(['apply', join(result.archiveDir, 'worktree.diff')], restored);
    await cp(join(result.archiveDir, 'files'), restored, { recursive: true });
    for (const link of manifest.captured.symlinks) {
      await mkdir(dirname(join(restored, link.path)), { recursive: true });
      await symlink(link.target, join(restored, link.path));
    }
    expect((await execGit(['rev-parse', 'HEAD'], restored)).stdout.trim()).toBe(c.release.head);
    expect(await readdir(join(restored, 'vendor'))).toEqual([]);
    expect((await execGit(['show', ':staged.txt'], restored)).stdout).toBe('unique staged content\n');
    expect(await readFile(join(restored, 'initial.txt'), 'utf8')).toBe('tracked edit\n');
    expect(await readFile(join(restored, 'untracked.txt'), 'utf8')).toBe('untracked work\n');
    expect(await readFile(join(restored, 'ignored.txt'), 'utf8')).toBe('ignored work\n');
    if (SYMLINKS) expect(await readFile(join(restored, 'server/node_modules/untouched'), 'utf8')).toBe('shared installation\n');
    await execGit(['fsck', '--full', '--strict'], restored);
  });

  it.each(['head-mismatch', 'same-checkout-failed', 'ambiguous-history', 'current-manual', 'current-active', 'checkout-alias', 'primary-alias'])(
    'keeps the full original checkout when reused-branch proof changes: %s', async change => {
      const c = await reviewedCheckout('quality-held');
      const current = reusedBranchOwners(c);
      const prepared = await c.prepare();
      expect(prepared.ok).toBe(true);
      if (change === 'head-mismatch') c.forge.prHead = c.forge.changeBase;
      if (change === 'same-checkout-failed') injected.policies[1].metadata.workspacePath = c.release.path;
      if (change === 'ambiguous-history') delete injected.policies[1].metadata.workspacePath;
      if (change === 'current-manual') current.metadata.prCompletionPolicy = 'leave-open';
      if (change === 'current-active') current.status = 'running';
      if (change === 'checkout-alias' || change === 'primary-alias') {
        const alias = join(external, 'historical-alias');
        await symlink(change === 'checkout-alias' ? c.path : repo, alias, process.platform === 'win32' ? 'junction' : 'dir');
        injected.policies[1].metadata.workspacePath = alias;
      }
      expect(await c.confirm(prepared.review)).toMatchObject({ ok: false });
      expect(await lockText(c.release.path)).toBe(c.release.lockReason);
      expect((await execGit(['rev-parse', `refs/heads/${c.release.branch}`], repo)).stdout.trim()).toBe(c.release.head);
      expect(await readFile(join(c.path, 'ignored.txt'), 'utf8')).toBe('ignored work\n');
      expect(await archives()).toEqual([]);
    });

  it.each(['content', 'index', 'administration', 'default', 'pr-head', 'forge', 'policy', 'unreadable-policy', 'submodule', 'inventory'])('refuses changed %s evidence between review and confirmation', async change => {
    const c = await reviewedCheckout('changed-review', { gitlink: true });
    const prepared = await c.prepare();
    expect(prepared.ok).toBe(true);
    if (change === 'content') await writeFile(join(c.path, 'ignored.txt'), 'new evidence');
    if (change === 'index') { await writeFile(join(c.path, 'staged.txt'), 'new index'); await execGit(['add', 'staged.txt'], c.path); }
    if (change === 'administration') await writeFile(join(c.admin, 'portos-review-status'), 'new review');
    if (change === 'default') {
      await writeFile(join(repo, 'later.txt'), 'later default');
      await execGit(['add', 'later.txt'], repo); await execGit(['commit', '-m', 'later default'], repo);
      c.forge.defaultHead = (await execGit(['rev-parse', 'HEAD'], repo)).stdout.trim();
    }
    if (change === 'pr-head') c.forge.prHead = c.forge.defaultHead;
    if (change === 'unreadable-policy') injected.policies = null;
    if (change === 'forge') c.forge.remoteHead = c.release.head;
    if (change === 'policy') injected.policies[0].metadata.prCompletionPolicy = 'leave-open';
    if (change === 'submodule') await writeFile(join(c.path, 'vendor', 'unique.txt'), 'submodule work');
    if (change === 'inventory') injected.schedule.executions = {};
    const result = await c.confirm(prepared.review);
    expect(result.ok).toBe(false);
    expect(await registered(c.release.path)).toBe(true);
    expect(await lockText(c.release.path)).toBe(c.release.lockReason);
    expect(await archives()).toEqual([]);
  });

  it.each(['running', 'paused'])('refuses a %s owner that arrives after preparation', async status => {
    const c = await reviewedCheckout('owner-review');
    const prepared = await c.prepare();
    const result = await c.confirm(prepared.review, { readAgents: async () => [{ id: 'agent-live', status,
      metadata: { workspacePath: repo, claimBranches: [c.release.branch] } }] });
    expect(result).toMatchObject({ ok: false, reason: 'claim-owner-active' });
    expect(await registered(c.release.path)).toBe(true);
  });

  it('preserves archive and checkout when fresh forge evidence changes after archiving', async () => {
    const c = await reviewedCheckout('late-forge');
    const prepared = await c.prepare();
    let reads = 0;
    const result = await c.confirm(prepared.review, { readForge: async () => ({ ...c.forge, remoteHead: ++reads === 1 ? null : c.release.head }) });
    expect(result).toMatchObject({ ok: false, reason: 'retirement-review-changed', archiveDir: expect.any(String) });
    expect(await readFile(join(result.archiveDir, 'files/ignored.txt'), 'utf8')).toBe('ignored work\n');
    expect(await registered(c.release.path)).toBe(true);
    expect(await lockText(c.release.path)).toBe(c.release.lockReason);
  });

});
