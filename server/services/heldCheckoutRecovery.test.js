/**
 * Scoped retirement of held checkouts through real Git (#12002, #13519): a
 * release binds to the exact inventory row. A merged clean checkout is removed
 * in place. Dirty, unmerged, and live-owner checkouts stay, and retirement
 * does not copy the checkout. Historical archives written by preserveMergedCheckout
 * remain readable.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { cp, mkdtemp, mkdir, rm, rename, writeFile, readFile, readdir, readlink, symlink, utimes, truncate, chmod, stat } from 'fs/promises';
import { existsSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from '../lib/childProcess.js';
import { dirname, join } from 'path';
import { readRetirementCheckoutIdentity, isCurrentRetirementCheckout } from '../lib/retirementCheckoutObservation.js';
import { execGit } from '../lib/execGit.js';
import { materializeGitRepo, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { PATHS } from '../lib/paths.js';

// Local branch deletion archives the common reflog using PATHS.cos, independently
// of the checkout archive's explicit cosDir option.
vi.mock('../lib/paths.js', async importOriginal => makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-held-branch-archives-') }));
afterAll(cleanupTempDataRoots);

// Fixed phase names and aggregates only: diagnostics must never expose fixture
// paths, Git arguments, captured bytes or an unbounded per-command transcript.
const receiptTiming = vi.hoisted(() => ({
  current: null,
  async run(phase, work) {
    const trace = this.current;
    if (!trace) return work();
    const started = performance.now();
    const row = trace.phases[phase] ??= { count: 0, ms: 0, maxMs: 0, active: 0 };
    row.active++;
    try { return await work(); }
    finally {
      const elapsed = performance.now() - started;
      row.active--;
      row.count++;
      row.ms += elapsed;
      row.maxMs = Math.max(row.maxMs, elapsed);
    }
  },
}));

// Keep the real ownership queue, archive and destructive guards. Only time the
// existing callbacks, including queue wait in retirement-total's remainder.
vi.mock('./cosClaimOwnershipState.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, retireWithUnlockedArchive: options => receiptTiming.run('retirement-total', () => actual.retireWithUnlockedArchive({
    ...options,
    admit: (...args) => receiptTiming.run('ownership-admission', () => options.admit(...args)),
    archive: (...args) => receiptTiming.run('preservation', () => options.archive(...args)),
    finish: (...args) => receiptTiming.run('destructive-settlement', () => options.finish(...args)),
  })) };
});

const SYMLINKS = process.platform !== 'win32';
const retirementFaults = vi.hoisted(() => ({ onRemove: null, onBranchDelete: null, scheduleWrites: 0, failScheduleWrite: null }));
const injected = vi.hoisted(() => ({ policies: [], schedule: null, app: null, fetchRemote: null, fetches: [], onBundle: null, onArchiveRef: null, onEvidence: null, onProof: null, proofFailures: [], onOtherFiles: null }));

vi.mock('../lib/execGit.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, execGit: async (args, cwd, options) => {
    if (injected.onSnapshot && args[0] === 'ls-files' && args[1] === '-u') await injected.onSnapshot();
    // Pauses an archive mid-write, after its first snapshot and before its re-read.
    if (injected.onBundle && args.includes('bundle') && args.includes('create')) await injected.onBundle();
    if (injected.onUnlockedStatus && args[0] === 'status' && args[1] === '--porcelain') {
      injected.statusReads = (injected.statusReads || 0) + 1;
      if (injected.statusReads > 1) await injected.onUnlockedStatus();
    }
    if (injected.onEvidence && args[0] === 'bundle' && args[1] === 'verify') await injected.onEvidence();
    if (retirementFaults.onRemove && args[0] === 'worktree' && args[1] === 'remove') await retirementFaults.onRemove();
    if (retirementFaults.onBranchDelete && args[0] === 'push' && args.some(arg => arg.startsWith(':refs/heads/'))) await retirementFaults.onBranchDelete();
    if (args.includes('credential.helper=!gh auth git-credential') && args.includes('fetch')) {
      injected.fetches.push({ args, options });
      if (injected.fetchRemote) args = args.map(arg => arg === 'https://github.com/example/repo.git' ? injected.fetchRemote : arg);
    }
    try {
      const phase = options?.env?.GIT_NO_REPLACE_OBJECTS === '1' ? 'independent-object-proof'
        : args.includes('bundle') ? 'bundle' : 'other-git';
      const result = await receiptTiming.run(phase, () => actual.execGit(args, cwd, options));
      if (injected.onPreviewEvidence && args[0] === '--literal-pathspecs' && args[1] === 'diff') await injected.onPreviewEvidence();
      if (injected.onArchiveRef && args[0] === 'update-ref' && args[1]?.startsWith('refs/portos/archive/')) await injected.onArchiveRef();
      if (injected.onProof && args.includes('--bare') && options?.env?.GIT_NO_REPLACE_OBJECTS === '1') await injected.onProof();
      if (injected.onOtherFiles && args[0] === 'ls-files' && args[1] === '--others') {
        return { ...result, stdout: Buffer.from(injected.onOtherFiles(result.stdout.toString())) };
      }
      return result;
    }
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
  updateSchedule: mutate => receiptTiming.run('schedule-persistence', async () => {
    if (++retirementFaults.scheduleWrites === retirementFaults.failScheduleWrite) throw new Error('synthetic receipt persistence failure');
    return (await mutate(injected.schedule)).result;
  }),
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
  let receiptWork;
  const noOwners = async () => [];

  beforeEach(async ({ task }) => {
    receiptWork = null;
    receiptTiming.current = task.name.startsWith('settles a normally merged checkout before the next scan')
      ? { entryPoint: task.name.endsWith('cleanupMerged') ? 'cleanupMerged' : 'early reaper', started: performance.now(), phases: {} } : null;
    await receiptTiming.run('fixture-setup', async () => {
      Object.assign(retirementFaults, { onRemove: null, onBranchDelete: null, scheduleWrites: 0, failScheduleWrite: null });
      Object.assign(injected, { policies: [], schedule: { tasks: {}, executions: {} }, app: { id: 'app-1', repoPath: null }, fetchRemote: null, fetches: [], onBundle: null, onArchiveRef: null, onEvidence: null, onProof: null, proofFailures: [], onOtherFiles: null, onUnlockedStatus: null, statusReads: 0, onSnapshot: null, onPreviewEvidence: null });
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
  });
  afterEach(async ({ task }) => {
    const report = state => {
      const trace = receiptTiming.current;
      if (!trace) return;
      const phases = Object.entries(trace.phases).map(([phase, row]) =>
        `${phase}=${Math.round(row.ms)}ms/${row.count} max=${Math.round(row.maxMs)}ms active=${row.active}`).join('; ');
      console.log(`⏱️ merged-receipt ${trace.entryPoint} ${state}: ${Math.round(performance.now() - trace.started)}ms; ${phases}`);
    };
    const failed = Boolean(task.result?.errors?.length);
    if (failed) report('before-settlement');
    // Vitest's deadline rejects its wrapper, not the async fixture. Never erase
    // the repo while archive/proof/removal work from this exact case is running.
    try { await receiptWork?.catch(() => {}); }
    finally {
      if (failed || process.env.PORTOS_PROFILE_HELD_RECEIPT === '1') report('settled');
      receiptTiming.current = null;
      await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
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
  const makeClean = async (path) => {
    await execGit(['checkout', '--', '.'], path);
    await execGit(['clean', '-fdx'], path);
  };

  async function historicalArchive(prepare = async () => {}) {
    const path = join(external, 'historical');
    const branch = 'feature/historical';
    await execGit(['worktree', 'add', '-b', branch, path, 'main'], repo);
    await writeFile(join(path, 'initial.txt'), 'staged historical work\n');
    await execGit(['add', 'initial.txt'], path);
    await writeFile(join(path, 'private.txt'), 'synthetic private bytes');
    await prepare(path);
    const release = { path, branch, head: (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim(), locked: false, lockReason: null };
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...release, reason: 'retirement-review-pending' }] });
    const saved = await preserveMergedCheckout(repo, { ...release, branch: `refs/heads/${branch}` }, 'main', { cosDir: PATHS.cos });
    await execGit(['worktree', 'remove', '--force', path], repo);
    return { release, saved };
  }

  async function supersededCheckout() {
    const { release } = await heldCheckout('superseded', { branch: 'feature/superseded' });
    await rm(join(release.path, 'ignored.txt'));
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

  // Both automatic retirement entry points used to omit their receipt, so the
  // next persisted scan manufactured a missing-source obligation after archival.
  it.each(['cleanupMerged', 'early reaper'])('settles a normally merged checkout before the next scan through %s', entryPoint => {
    receiptWork = (async () => {
      const branch = 'feature/merged-receipt';
      const path = join(repo, '.claude', 'worktrees', 'merged-receipt');
      const holder = await receiptTiming.run('merged-fixture', async () => {
        await mkdir(dirname(path), { recursive: true });
        await execGit(['worktree', 'add', '-b', branch, path, 'main'], repo);
        await writeFile(join(path, '.gitignore'), 'ignored.txt\n');
        await execGit(['add', '.gitignore'], path);
        await execGit(['commit', '-m', 'fixture ignore rule'], path);
        await execGit(['merge', '--ff-only', branch], repo);
        return (await (await import('./worktreeManager.js')).listWorktrees(repo)).find(tree => tree.branch === `refs/heads/${branch}`);
      });
      const release = { branch, path: holder.path, head: holder.head, locked: false, lockReason: null };
      await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...release,
        checkoutIdentity: await readRetirementCheckoutIdentity(path), reason: 'checkout-retained' }] });
      const options = { appId: 'app-1', activeAgentIds: new Set(), claimOwners: { agents: [], readAgents: noOwners } };
      await receiptTiming.run('cleanup-with-import', async () => {
        if (entryPoint === 'cleanupMerged') {
          const result = await (await import('./branchReconcile.js')).cleanupMerged(repo, 'main', [{ branch, worktreePath: holder.path }], options);
          expect(result).toMatchObject({ cleaned: [branch], skipped: [] });
        } else {
          const result = await (await import('./worktreeManager.js')).reapMergedWorktrees(repo, options);
          expect(result.reaped).toEqual([expect.objectContaining({ branch, branchDeleted: true })]);
          expect(result.skipped).toEqual([]);
        }
      });
      await receiptTiming.run('receipt-and-next-scan-readback', async () => {
        expect(existsSync(path)).toBe(false);
        expect((await execGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo, { ignoreExitCode: true })).exitCode).toBe(1);
        const first = await getBranchReconcileOutcome('app-1');
        expect(first.retired).toEqual([expect.objectContaining({ branch, path: holder.path, head: holder.head, branchDeleted: true, archiveDir: null })]);
        expect(await archives()).toEqual([]);
        await recordBranchReconcileOutcome('app-1', { status: 'complete', remaining: [] });
        const next = await getBranchReconcileOutcome('app-1');
        expect(next).toMatchObject({ remaining: [], retirementObligations: [] });
        expect(next.retired).toEqual(first.retired);
      });
    })();
    return receiptWork;
  });

  it('settles a normally retired branch-only row while retaining unrelated unexplained disappearance', async () => {
    const branch = 'feature/merged-branch-only';
    await execGit(['branch', branch, 'main'], repo);
    const head = (await execGit(['rev-parse', branch], repo)).stdout.trim();
    const vanished = { branch: 'feature/unexplained-disappearance', head, reason: 'branch-held' };
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ branch, head, reason: 'branch-held' }, vanished] });
    const result = await (await import('./branchReconcile.js')).cleanupMerged(repo, 'main', [{ branch }], {
      appId: 'app-1', activeAgentIds: new Set(), claimOwners: { agents: [], readAgents: noOwners },
    });
    expect(result).toMatchObject({ cleaned: [branch], skipped: [] });
    const first = await getBranchReconcileOutcome('app-1');
    expect(first.retired).toEqual([expect.objectContaining({ branch, head, branchDeleted: true, archiveDir: null })]);
    expect(first.remaining).toEqual([vanished]);
    expect((await execGit(['rev-parse', '--verify', '--quiet', `refs/portos/completed/${head}`], repo)).stdout.trim()).toBe(head);
    expect(existsSync(join(PATHS.cos, 'branch-retirement-archives'))).toBe(false);
    await recordBranchReconcileOutcome('app-1', { status: 'complete', remaining: [] });
    const next = await getBranchReconcileOutcome('app-1');
    expect(next.retirementObligations).toEqual([expect.objectContaining({ branch: vanished.branch, head, reason: 'retirement-provenance-unverified' })]);
    expect(next.remaining).toEqual(next.retirementObligations);
  });

  it('retires a superseded branch without a worktree and does not claim checkout preservation', async () => {
    const branch = 'feature/no-worktree';
    const head = (await execGit(['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'superseded branch-only commit'], repo)).stdout.trim();
    await execGit(['branch', branch, head], repo);
    const missingCheckout = { branch, path: join(external, 'lost-original'), head, locked: false, lockReason: null };
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', retirementObligations: [{ ...missingCheckout, reason: 'retirement-provenance-unverified' }] });
    let seenHead = null;
    retirementFaults.onBranchDelete = async () => {
      seenHead = (await execGit(['rev-parse', '--verify', `refs/heads/${branch}`], repo)).stdout.trim();
    };
    const entry = { branch, tip: head, worktreePath: null, dirtyPaths: [], verdict: { branch, tip: head, verdict: 'SUPERSEDED', dirtyPaths: [] } };
    expect(await reapSuperseded(entry)).toMatchObject({ reaped: [branch], skipped: [] });
    expect(seenHead).toBe(head);
    expect((await execGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo, { ignoreExitCode: true })).exitCode).toBe(1);
    expect(existsSync(join(PATHS.cos, 'branch-retirement-archives'))).toBe(false);
    expect(await archives()).toEqual([]);
    const outcome = await getBranchReconcileOutcome('app-1');
    expect(outcome.retired).toEqual([expect.objectContaining({ branch, head, branchDeleted: true, archiveDir: null })]);
    expect(outcome.retirementObligations).toContainEqual(expect.objectContaining(missingCheckout));
    expect(await archives()).toEqual([]);
  });

  it('removes a superseded checkout after the abandoned-worktree backup without copying the checkout', async () => {
    const { entry, release } = await supersededCheckout();
    const { backupRoot, backupSlug } = await import('./supersededBackup.js');
    const backupDir = join(backupRoot(cosDir), backupSlug(release.branch));
    retirementFaults.onRemove = async () => {
      expect(existsSync(release.path)).toBe(true);
      expect(await readFile(join(backupDir, 'worktree.diff'), 'utf8')).toContain('unstaged original work');
      expect(existsSync(heldCheckoutArchiveRoot(cosDir))).toBe(false);
    };
    expect(await reapSuperseded(entry)).toMatchObject({ reaped: [release.branch], skipped: [] });
    expect(existsSync(release.path)).toBe(false);
    expect((await execGit(['rev-parse', '--verify', '--quiet', `refs/heads/${release.branch}`], repo, { ignoreExitCode: true })).exitCode).toBe(1);
    expect(await archives()).toEqual([]);
    const outcome = await getBranchReconcileOutcome('app-1');
    expect(outcome.retired).toContainEqual(expect.objectContaining({
      path: release.path, branch: release.branch, head: release.head, archiveDir: null, branchDeleted: true, retiredAt: expect.any(String),
    }));
  });

  it('keeps a superseded checkout held by a live owner and writes no checkout archive', async () => {
    const { entry, release } = await supersededCheckout();
    const owners = [{ id: 'new-owner', status: 'running', metadata: { sourceWorkspace: repo, claimBranches: [release.branch] } }];
    const result = await reapSuperseded(entry, async () => owners);
    expect(result.reaped).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(existsSync(release.path)).toBe(true);
    expect(await registered(release.path)).toBe(true);
    expect((await execGit(['rev-parse', release.branch], repo)).stdout.trim()).toBe(release.head);
    expect(await archives()).toEqual([]);
    expect((await getBranchReconcileOutcome('app-1'))?.retired || []).toEqual([]);
  });

  it('retains ignored payload that the superseded patch backup does not preserve', async () => {
    const { entry, release } = await supersededCheckout();
    await writeFile(join(release.path, 'ignored.txt'), 'sole unpublished bytes');
    const result = await reapSuperseded(entry);
    expect(result.reaped).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain('checkout-ignored-payload-unverified');
    expect(await readFile(join(release.path, 'ignored.txt'), 'utf8')).toBe('sole unpublished bytes');
    expect(await registered(release.path)).toBe(true);
    expect((await execGit(['rev-parse', release.branch], repo)).stdout.trim()).toBe(release.head);
    expect(await archives()).toEqual([]);
  });

  it('keeps a superseded checkout when its untracked backup cannot be copied', async () => {
    const { entry, release } = await supersededCheckout();
    // Mode 000 does not deny the owner on Windows, so that simulation would
    // copy the file and remove the checkout. A non-directory backup root
    // fails the same gate.
    if (process.platform === 'win32') {
      await rm(cosDir, { recursive: true, force: true });
      await writeFile(cosDir, 'not-a-directory');
      const result = await reapSuperseded(entry);
      expect(result.reaped).toEqual([]);
      expect(result.skipped[0].reason).toMatch(/backup-failed/);
      expect(existsSync(release.path)).toBe(true);
      expect(await registered(release.path)).toBe(true);
      expect(await archives()).toEqual([]);
      return;
    }
    await chmod(join(release.path, 'untracked.txt'), 0o000);
    try {
      const result = await reapSuperseded(entry);
      expect(result.reaped).toEqual([]);
      expect(result.skipped[0].reason).toMatch(/backup-failed/);
      expect(existsSync(release.path)).toBe(true);
      expect(await registered(release.path)).toBe(true);
      expect(await archives()).toEqual([]);
    } finally {
      await chmod(join(release.path, 'untracked.txt'), 0o644).catch(() => {});
    }
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

  it('removes a superseded checkout even when an old obligation has no incarnation proof', async () => {
    const { entry, release } = await supersededCheckout();
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', retirementObligations: [{ ...release, reason: 'retirement-review-pending' }] });
    expect(await reapSuperseded(entry)).toMatchObject({ reaped: [release.branch], skipped: [] });
    expect(existsSync(release.path)).toBe(false);
    expect(await archives()).toEqual([]);
  });

  it('reports an unverified receipt when retirement persistence fails and writes no checkout archive', async () => {
    const { entry, release } = await supersededCheckout();
    retirementFaults.failScheduleWrite = 1;
    expect(await reapSuperseded(entry)).toMatchObject({ reaped: [], skipped: [{ branch: release.branch, reason: 'retirement-receipt-unverified' }] });
    expect((await getBranchReconcileOutcome('app-1'))?.retired || []).toEqual([]);
    expect(existsSync(release.path)).toBe(false);
    expect(await archives()).toEqual([]);
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

  describe('bounded historical evidence', () => {
    beforeEach(cleanupTempDataRoots);
    afterEach(cleanupTempDataRoots);

    it('bounds persisted recovery diagnostics across obligations and unrelated archives while verifying the exact matching archive', async () => {
      const { release, saved } = await historicalArchive();
      const original = await getBranchReconcileOutcome('app-1');
      const root = heldCheckoutArchiveRoot(PATHS.cos);
      const obligations = Array.from({ length: 6 }, (_, i) => ({ ...original.retirementObligations[0],
        branch: `feature/missing-${i}`, path: join(external, `missing-${i}`),
        preservationEvidence: { status: 'unresolved', archives: [{ reason: 'legacy-diagnostic' }] } }));
      const metadata = async (name, identity) => {
        const dir = join(root, name);
        await mkdir(dir);
        await writeFile(join(dir, 'manifest.json'), JSON.stringify({ repoPath: repo, ...identity, archivedAt: '2000-01-01T00:00:00Z' }));
      };
      for (let i = 0; i < 80; i++) await metadata(`unrelated-${i}`, { ...release, path: join(external, `unrelated-${i}`) });
      for (const [i, obligation] of obligations.entries()) {
        for (let j = 0; j < 8; j++) await metadata(`matching-${i}-${j}`, obligation);
      }
      const receipt = { branch: 'feature/settled', path: join(external, 'settled'), head: release.head,
        archiveDir: 'synthetic-previous-archive', branchDeleted: true, retiredAt: new Date().toISOString() };
      original.retired = [receipt];
      const outcome = await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [],
        retirementObligations: [...original.retirementObligations, ...obligations] });
      expect(outcome.recoveredPreservations).toEqual([expect.objectContaining({ path: release.path, archiveDir: saved.archiveDir, verified: true })]);
      expect(outcome.retirementObligations).toHaveLength(6);
      expect(outcome.retired).toEqual([receipt]);
      expect(outcome.preservationDiscovery).toMatchObject({ candidates: 129, indexed: 129, complete: true, errors: 0 });
      const evidence = outcome.retirementObligations.map(row => row.preservationEvidence);
      expect(evidence.every(row => row.coverage.matching === 8 && row.coverage.attempted === 8 && row.coverage.unrelated === 121)).toBe(true);
      const details = evidence.flatMap(row => row.archives);
      expect(details.length).toBeLessThanOrEqual(20);
      expect(details.every(row => row.reason === 'archive-generation-mismatch')).toBe(true);
      expect(evidence.reduce((total, row) => total + row.coverage.detailsOmitted, details.length)).toBe(48);
      expect(JSON.stringify(outcome).length).toBeLessThan(30000);
      expect(await getBranchReconcileOutcome('app-1')).toEqual(outcome);
    });

    it('bounds bytes read from oversized metadata across discovery candidates', async () => {
      await historicalArchive();
      const root = heldCheckoutArchiveRoot(PATHS.cos);
      for (let i = 0; i < 6; i++) {
        const dir = join(root, `oversized-${i}`);
        await mkdir(dir);
        const path = join(dir, 'manifest.json');
        await writeFile(path, '');
        await truncate(path, 17 * 1024 * 1024);
      }
      const outcome = await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [] });
      expect(outcome.recoveredPreservations).toEqual([]);
      expect(outcome.retirementObligations).toHaveLength(1);
      expect(outcome.preservationDiscovery).toMatchObject({ complete: false, truncated: true });
      // Streaming discovery can consume at most one additional 64 KiB chunk.
      expect(outcome.preservationDiscovery.metadataBytes).toBeLessThanOrEqual(64 * 1024 * 1024 + 64 * 1024);
      expect(outcome.preservationDiscovery.details).toContainEqual(expect.objectContaining({ reason: 'archive-discovery-budget-exceeded' }));
    });

    it.each(['ambiguous', 'unreadable-metadata', 'missing-discovery', 'truncated-discovery'])(
      'retains an explicit hold for %s despite a complete matching archive', async failure => {
        const { saved } = await historicalArchive();
        const root = heldCheckoutArchiveRoot(PATHS.cos);
        if (failure === 'ambiguous') await cp(saved.archiveDir, join(root, 'second-matching-archive'), { recursive: true });
        if (failure === 'unreadable-metadata') {
          for (let i = 0; i < 25; i++) {
            await mkdir(join(root, `broken-metadata-${i}`));
            await writeFile(join(root, `broken-metadata-${i}`, 'manifest.json'), '{');
          }
        }
        if (failure === 'missing-discovery') await writeFile(join(PATHS.cos, 'initialized-checkout-retirements'), 'unreadable archive root');
        if (failure === 'truncated-discovery') {
          for (let i = 0; i < 1001; i++) await writeFile(join(root, `entry-${i}`), '');
        }
        const outcome = await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [] });
        expect(outcome.recoveredPreservations).toEqual([]);
        expect(outcome.retirementObligations).toHaveLength(1);
        expect(outcome.retirementObligations[0].preservationEvidence.reason).toBe(
          failure === 'ambiguous' ? 'archive-preservation-ambiguous' : 'archive-discovery-incomplete');
        if (failure !== 'ambiguous') {
          expect(outcome.preservationDiscovery).toMatchObject({ complete: false, errors: failure === 'unreadable-metadata' ? 25 : 1 });
          expect(outcome.preservationDiscovery.details).toHaveLength(failure === 'unreadable-metadata' ? 20 : 1);
          expect(outcome.preservationDiscovery.detailsOmitted).toBe(failure === 'unreadable-metadata' ? 5 : 0);
          expect(outcome.preservationDiscovery.truncated).toBe(failure === 'truncated-discovery');
        }
      });

  });

  it.each(['cancel', 'time', 'git-output', 'git-time'])('retains the %s diagnosis when isolated Git proof is interrupted without settling preservation', async mode => {
    const { saved } = await historicalArchive();
    const outcome = await getBranchReconcileOutcome('app-1');
    const controller = new AbortController();
    let clock;
    injected.onProof = () => {
      if (mode === 'cancel') controller.abort();
      else if (mode === 'time') clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 11 * 60 * 1000);
      else throw Object.assign(new Error('synthetic Git resource exhaustion'), mode === 'git-output'
        ? { code: 'GIT_OUTPUT_LIMIT', limitCodeUnits: 64 * 1024 * 1024, observedCodeUnits: 64 * 1024 * 1024 + 1 }
        : { code: 'GIT_TIMEOUT', limitMs: 30000, observedMs: 30001 });
    };
    try {
      const result = await recoverMissingCheckoutPreservations({ appId: 'app-1', repoPath: repo, outcome }, { signal: controller.signal });
      expect(result.recoveredPreservations || []).toEqual([]);
      expect(result.retirementObligations).toHaveLength(1);
      const evidence = result.retirementObligations[0].preservationEvidence.archives.find(row => row.archiveDir === saved.archiveDir);
      expect(evidence).toMatchObject({ reason: mode === 'cancel' ? 'retirement-archive-cancelled'
        : mode === 'git-output' ? 'retirement-archive-limit-exceeded' : 'retirement-archive-work-limit-exceeded', nextAction: expect.any(String) });
      if (mode === 'git-output') expect(evidence.archiveLimit).toEqual({ scope: 'git-output', kind: 'output',
        limitCodeUnits: 64 * 1024 * 1024, observedCodeUnits: 64 * 1024 * 1024 + 1 });
      if (mode === 'git-time') expect(evidence.archiveLimit).toEqual({ scope: 'git-command', kind: 'time', limitMs: 30000, observedMs: 30001 });
      if (mode === 'time') expect(evidence.archiveLimit).toMatchObject({ scope: 'verification', kind: 'time', limitMs: 600000, observedMs: expect.any(Number) });
      expect(result.retired).toBeUndefined();
      expect(existsSync(saved.archiveDir)).toBe(true);
    } finally { clock?.mockRestore(); }
  });

  it('recognizes an absent completion archive without a schedule obligation and rejects changed or older evidence', async () => {
    const { release, saved } = await historicalArchive();
    const outcome = await getBranchReconcileOutcome('app-1');
    const original = { ...release, createdAt: outcome.retirementObligations[0].createdAt };
    injected.schedule = { executions: {} };
    const withoutObligation = await getBranchReconcileOutcome('app-1');
    await execGit(['branch', '-d', release.branch], repo);
    const controller = new AbortController();
    const proof = await findMissingCheckoutPreservation({ repoPath: repo, release: original }, { signal: controller.signal });
    expect(proof).toMatchObject({ archiveDir: saved.archiveDir, evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(await proof.recheck()).toBe(true);
    await mkdir(release.path);
    expect(await proof.recheck()).toBe(false);
    await rm(release.path, { recursive: true });
    controller.abort();
    await expect(proof.recheck()).rejects.toThrow('retirement-archive-cancelled');
    const manifest = JSON.parse(await readFile(join(saved.archiveDir, 'manifest.json'), 'utf8'));
    expect(await findMissingCheckoutPreservation({ repoPath: repo, release: { ...original, createdAt: new Date(Date.parse(manifest.archivedAt) + 1).toISOString() } })).toBeNull();
    await writeFile(join(saved.archiveDir, 'files', 'private.txt'), 'corrupt archived evidence');
    expect(await findMissingCheckoutPreservation({ repoPath: repo, release: original })).toBeNull();
    expect(await getBranchReconcileOutcome('app-1')).toEqual(withoutObligation);
  });

  // A matching patch hash cannot detect bytes damaged before the old writer hashed them.
  it.each(['compatible', 'split-index', 'damaged', 'omitted-patch', 'missing-index'])('independently reconstructs a legacy staged-only index: %s', async variant => {
    let patch;
    let originalEntries;
    const { release, saved } = await historicalArchive(async path => {
      await writeFile(join(path, 'staged-only.txt'), Buffer.concat([Buffer.from('café staged content\n'), Buffer.from([0xff, 0x0a])]));
      await execGit(['add', 'staged-only.txt'], path);
      if (variant === 'split-index') await execGit(['update-index', '--split-index'], path);
      originalEntries = (await execGit(['-c', 'core.quotePath=true', 'ls-files', '--stage'], path)).stdout;
      // Capture the original bytes independently of the legacy execGit text decoder.
      patch = (await promisify(execFile)('git', ['diff', '--cached', '--binary', '--no-textconv', '--no-ext-diff'], { cwd: path, encoding: 'buffer' })).stdout;
      await rm(join(path, 'staged-only.txt'));
    });
    const manifestPath = join(saved.archiveDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    delete manifest.resourceContract;
    if (variant === 'damaged') {
      const split = patch.indexOf(Buffer.from('é')) + 1;
      expect(split).toBeGreaterThan(0);
      patch = Buffer.from(patch.subarray(0, split).toString('utf8') + patch.subarray(split).toString('utf8'));
    }
    await writeFile(join(saved.archiveDir, 'index.diff'), patch);
    manifest.patchHashes.index = await sha256File(join(saved.archiveDir, 'index.diff'));
    if (variant === 'omitted-patch') manifest.captured.indexDiff = false;
    if (variant === 'missing-index') {
      manifest.administration.files = manifest.administration.files.filter(file => file.path !== 'gitdir/index');
      const { createHash } = await import('node:crypto');
      manifest.administration.fingerprint = createHash('sha256').update(JSON.stringify({
        files: manifest.administration.files.filter(file => file.path !== 'gitdir/locked'), symlinks: manifest.administration.symlinks,
      })).digest('hex');
    }
    await writeFile(manifestPath, JSON.stringify(manifest));
    const before = (await execGit(['show-ref'], repo)).stdout;
    const outcome = await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [] });
    if (['damaged', 'omitted-patch', 'missing-index'].includes(variant)) {
      expect(outcome.retirementObligations).toEqual([expect.objectContaining({ ...release,
        preservationEvidence: expect.objectContaining({ status: 'unresolved', nextAction: expect.stringContaining('backup'),
          archives: expect.arrayContaining([expect.objectContaining({ reason: 'archive-index-reconstruction-failed' })]) }),
      })]);
      expect(outcome.recoveredPreservations).toEqual([]);
    } else {
      expect(outcome.retirementObligations, JSON.stringify(injected.proofFailures)).toEqual([]);
      expect(outcome.recoveredPreservations).toContainEqual(expect.objectContaining({ archiveDir: saved.archiveDir, verified: true }));
      const restored = join(scratch, 'legacy-restore.git');
      await execGit(['init', '--bare', restored], scratch);
      await execGit(['bundle', 'unbundle', join(saved.archiveDir, 'commits.bundle')], restored);
      await execGit(['read-tree', release.head], restored);
      await execGit(['apply', '--cached', join(saved.archiveDir, 'index.diff')], restored);
      expect((await execGit(['-c', 'core.quotePath=true', 'ls-files', '--stage'], restored)).stdout).toBe(originalEntries);
    }
    expect(outcome.retired).toBeUndefined();
    expect((await execGit(['show-ref'], repo)).stdout).toBe(before);
    expect(existsSync(saved.archiveDir)).toBe(true);
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

  it('keeps a dirty locked detached checkout and does not copy it', async () => {
    const { path, release } = await heldCheckout('detached-held');
    await writeFile(join(path, 'staged-only.txt'), 'staged work\n');
    await execGit(['add', 'staged-only.txt'], path);
    const result = await retire(release);
    expect(result).toEqual({ ok: false, reason: 'worktree-dirty' });
    expect(existsSync(path)).toBe(true);
    expect(await registered(release.path)).toBe(true);
    expect(await lockText(release.path)).toBe(release.lockReason);
    expect(await archives()).toEqual([]);
  });

  it('removes a squash-merged branch with its checkout and drops it from the persisted inventory', async () => {
    const { path, release } = await heldCheckout('branch-held', { branch: 'feature/held', beforeLock: async (tree) => {
      await writeFile(join(tree, 'feature.txt'), 'feature\n');
      await execGit(['add', 'feature.txt'], tree);
      await execGit(['commit', '-m', 'feat: synthetic feature'], tree);
      await execGit(['merge', '--squash', 'feature/held'], repo);
      await execGit(['commit', '-m', 'feat: synthetic feature (squash)'], repo);
    } });
    const checkoutIdentity = await readRetirementCheckoutIdentity(path);
    const delayed = { ...release, checkoutIdentity, observedAt: new Date().toISOString(), reason: 'retirement-review-pending' };
    await recordBranchReconcileOutcome('app-1', {
      status: 'incomplete', reason: 'holds-remaining', nextAction: 'Recover held checkouts.',
      remaining: [{ ...delayed, managed: false, reason: 'worktree-locked' }, { branch: 'other', reason: 'actionable' }],
    });
    expect(await retireInventoriedCheckout({ appId: 'app-1', release: { ...release, checkoutIdentity: '0'.repeat(64) } }, { cosDir, readAgents: noOwners }))
      .toEqual({ ok: false, reason: 'release-not-in-inventory' });
    expect(await isCurrentRetirementCheckout(delayed)).toBe(true);
    await makeClean(path);
    const result = await retireInventoriedCheckout({ appId: 'app-1', release }, { cosDir, readAgents: noOwners });

    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, branchDeleted: true, checkoutIdentity });
    expect(result.archiveDir).toBeUndefined();
    expect(existsSync(join(PATHS.cos, 'branch-retirement-archives'))).toBe(false);
    expect(await archives()).toEqual([]);
    expect(existsSync(path)).toBe(false);
    expect((await execGit(['branch', '--list', 'feature/held'], repo)).stdout.trim()).toBe('');
    const outcome = await getBranchReconcileOutcome('app-1');
    expect(outcome.status).toBe('incomplete');
    expect(outcome.remaining).toEqual([{ branch: 'other', reason: 'actionable' }]);
    expect(outcome.retired[0]).toMatchObject({ path: release.path, branch: 'feature/held', branchDeleted: true, archiveDir: null, checkoutIdentity });
    await recordBranchReconcileOutcome('app-1', { status: 'running', remaining: [delayed] });
    // The stale retired checkout stays settled. The sibling row left this scan, and its
    // branch is absent, so disappearance stays a provenance obligation.
    const settled = await getBranchReconcileOutcome('app-1');
    expect(settled.retirementObligations).toEqual([
      expect.objectContaining({ branch: 'other', reason: 'retirement-provenance-unverified' }),
    ]);
    expect(settled.retirementObligations.some(row => row.path === delayed.path)).toBe(false);
    await execGit(['worktree', 'add', '-b', release.branch, path, release.head], repo);
    const recreated = { ...delayed, checkoutIdentity: await readRetirementCheckoutIdentity(path), observedAt: new Date().toISOString() };
    expect(recreated.checkoutIdentity).not.toBe(checkoutIdentity);
    expect(await isCurrentRetirementCheckout(delayed)).toBe(false);
    expect(await isCurrentRetirementCheckout({ ...recreated, head: '0'.repeat(40) })).toBe(false);
    // Even while the new tuple is live, the old scan cannot create its obligation.
    await recordBranchReconcileOutcome('app-1', { status: 'running', remaining: [delayed] });
    expect((await getBranchReconcileOutcome('app-1')).retirementObligations).toEqual([
      expect.objectContaining({ branch: 'other', reason: 'retirement-provenance-unverified' }),
    ]);
    await recordBranchReconcileOutcome('app-1', { status: 'running', remaining: [recreated] });
    expect((await getBranchReconcileOutcome('app-1')).retirementObligations).toEqual([
      expect.objectContaining({ branch: 'other', reason: 'retirement-provenance-unverified' }),
      expect.objectContaining({ checkoutIdentity: recreated.checkoutIdentity, reason: 'retirement-receipt-unverified' }),
    ]);
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

  it('refuses a lexically equal release when the filesystem resolver identifies a different checkout', async () => {
    const c = await heldCheckout('physical-alias-mismatch', { branch: 'feature/physical-alias-mismatch' });
    const release = { ...c.release, path: `${c.path}/.` };
    const originalRealpath = realpathSync.native;
    // Inject at the filesystem boundary: lexical '..' across a symlink can
    // name a different physical directory. Windows and POSIX resolve that
    // syntax differently, so pin the disagreement rather than OS parsing.
    const resolver = vi.spyOn(realpathSync, 'native').mockImplementation((path, ...args) =>
      originalRealpath(path === release.path ? external : path, ...args));
    try {
      expect(await retire(release)).toMatchObject({ ok: false, reason: 'checkout-identity-changed' });
    } finally { resolver.mockRestore(); }
    expect(await registered(c.path)).toBe(true);
    expect(await readFile(join(c.path, 'ignored.txt'), 'utf8')).toBe('ignored work\n');
    expect(await lockText(c.path)).toBe(c.release.lockReason);
    expect((await execGit(['rev-parse', `refs/heads/${c.release.branch}`], repo)).stdout.trim()).toBe(c.release.head);
    expect(await archives()).toEqual([]);
  });

  it('keeps the checkout, its content and its original lock when an owner appears after the archive', async () => {
    const { path, release } = await heldCheckout('owner-arrives', { lockReason: 'handoff pending' });
    let reads = 0;
    // Clear for the pre-archive check; a live run occupies the checkout by the removal recheck.
    const readAgents = async () => (++reads === 1 ? [] : [{ id: 'agent-live', status: 'running', workspacePath: release.path }]);

    await makeClean(path);
    const result = await retire(release, { readAgents });

    expect(result).toMatchObject({ ok: false, reason: 'claim-owner-active' });
    expect(await registered(release.path)).toBe(true);
    expect(await lockText(release.path)).toBe('handoff pending');
    expect(existsSync(join(path, 'initial.txt'))).toBe(true);
    expect(result.archiveDir).toBeUndefined();
    expect(await archives()).toEqual([]);
  });

  it('keeps a clean checkout that becomes dirty before removal', async () => {
    const { path, release } = await heldCheckout('rewritten');
    await makeClean(path);
    injected.onUnlockedStatus = async () => {
      injected.onUnlockedStatus = null;
      await writeFile(join(path, 'late.txt'), 'late work\n');
    };
    expect(await retire(release)).toEqual({ ok: false, reason: 'worktree-dirty' });
    expect(await readFile(join(path, 'late.txt'), 'utf8')).toBe('late work\n');
    expect(await lockText(release.path)).toBe('synthetic external owner');
    expect(await archives()).toEqual([]);
  });

  it('keeps a dirty checkout when a nested repository is present and writes no archive', async () => {
    const { path, release } = await heldCheckout('archive-fails');
    await mkdir(join(path, 'nested'));
    await execGit(['init', '-q'], join(path, 'nested'));

    const result = await retire(release);

    expect(result).toEqual({ ok: false, reason: 'worktree-dirty' });
    expect(await lockText(release.path)).toBe('synthetic external owner');
    expect(existsSync(join(path, 'nested', '.git'))).toBe(true);
    expect(await archives()).toEqual([]);
  });

  it.skipIf(!SYMLINKS)('preserves the checkout when a link target cannot be represented losslessly in archive metadata', async () => {
    const { path, release } = await heldCheckout('opaque-link', { branch: 'feature/opaque-link' });
    const target = Buffer.from([0xff]);
    await symlink(target, join(path, 'opaque-link'));

    expect(await retire(release)).toEqual({ ok: false, reason: 'worktree-dirty' });
    expect(await readlink(join(path, 'opaque-link'), { encoding: 'buffer' })).toEqual(target);
    expect(await lockText(path)).toBe('synthetic external owner');
    expect(await registered(path)).toBe(true);
    expect(await archives()).toEqual([]);
    expect((await execGit(['rev-parse', release.branch], repo)).stdout.trim()).toBe(release.head);
  });

  // #12682: archive I/O ran inside the shared ownership lock and starved every
  // claim-ownership check behind its 15 s queue budget for minutes.
  it('rechecks a clean checkout with the ownership queue free and removes it without a copy', async () => {
    const { path, release } = await heldCheckout('fenced', { branch: 'feature/fenced' });
    await makeClean(path);
    let paused;
    let resume;
    const pausedRecheck = new Promise(resolve => { paused = resolve; });
    injected.onUnlockedStatus = () => new Promise(resolve => { resume = resolve; paused(); });
    const admission = branch => checkReconcileOwnership({ appId: 'app-1', branch },
      { getAgents: async () => [], getActiveAgentIds: () => [], readCompletionHold: async () => null });

    const retiring = retire(release);
    await pausedRecheck;
    injected.onUnlockedStatus = null;
    expect(await withClaimOwnershipLock(() => 'settled')).toBe('settled');
    expect(await admission('feature/fenced')).toEqual({ admitted: false, reason: 'checkout-retirement-reserved' });
    expect(await admission('feature/unrelated')).toEqual({ admitted: true });
    expect(await retireInventoriedCheckout({ appId: 'app-1', release }, { cosDir, readAgents: noOwners }))
      .toEqual({ ok: false, reason: 'checkout-retirement-reserved' });
    expect(existsSync(path)).toBe(true);

    resume();
    expect(await retiring).toMatchObject({ ok: true, branchDeleted: true });
    expect(existsSync(path)).toBe(false);
    expect(await archives()).toEqual([]);
    expect(await admission('feature/fenced')).toEqual({ admitted: true });
  });

  it('keeps a clean checkout that gains a file during the unlocked recheck', async () => {
    const { path, release } = await heldCheckout('mid-recheck');
    await makeClean(path);
    injected.onUnlockedStatus = async () => {
      injected.onUnlockedStatus = null;
      await writeFile(join(path, 'late.txt'), 'late work\n');
    };
    expect(await retire(release)).toEqual({ ok: false, reason: 'worktree-dirty' });
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
    await makeClean(handoff.path);
    injected.policies = [{ id: 'agent-done', status: 'completed', startedAt: '2026-01-01T00:00:00.000Z',
      metadata: { sourceWorkspace: repo, worktreeBranch: 'feature/handoff', prCompletionPolicy: 'leave-open' } }];
    expect(await retire(handoff.release))
      .toEqual({ ok: false, reason: 'pr-completion-human-handoff' });
    expect(existsSync(handoff.path)).toBe(true);
    expect(await archives()).toEqual([]);
  });
  async function reviewedCheckout(name, { superseded = false, gitlink = false, normalMerge = false, featurePath = 'feature.txt', featureBody = 'original feature\n', multipleCommits = false, targetBranch = 'main', ignoredPayload = false } = {}) {
    if (targetBranch !== 'main') await execGit(['switch', '-c', targetBranch, 'main'], repo);
    let firstCommit;
    let changeBase;
    const { path, release } = await heldCheckout(name, { branch: `feature/${name}`, beforeLock: async tree => {
      await writeFile(join(tree, '.gitignore'), 'ignored.txt\nlinked\nprivate-files/\nprivate-build-output/\nnode_modules\n');
      await execGit(['add', '.gitignore'], tree);
      await writeFile(join(tree, featurePath), featureBody);
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
    // Successful retirement fixtures contain no wanted ignored payload.
    await execGit(['checkout', '--', '.'], path);
    await execGit(['clean', '-fd'], path);
    if (!ignoredPayload) await rm(join(path, 'ignored.txt'));
    const [main, admin] = (await Promise.all([
      execGit(['rev-parse', 'main'], repo), execGit(['rev-parse', '--absolute-git-dir'], path),
    ])).map(result => result.stdout.trim());
    await writeFile(join(admin, 'portos-review-status'), 'private synthetic review marker');
    injected.policies = [{ id: 'agent-legacy', status: 'completed', result: { success: true },
      metadata: { workspacePath: repo, claimBranches: [release.branch], prCompletionPolicy: 'review-then-merge' } }];
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...release, reason: 'pr-completion-review-required' }] });
    const deliveryHead = (await execGit(['rev-parse', targetBranch], repo)).stdout.trim();
    const forge = { changedPaths: [featurePath, ...(gitlink ? ['vendor'] : []), ...(multipleCommits ? ['second.txt'] : [])], changeBase, firstCommit, repository: 'github.com/example/repo', prUrl: 'https://github.com/example/repo/pull/42', prHead: release.head,
      mergeCommit: deliveryHead, defaultBranch: 'main', defaultHead: main, remoteHead: null,
      ...(targetBranch !== 'main' && { targetBranch, targetHead: deliveryHead }) };
    const opts = { cosDir, readAgents: noOwners, readForge: async () => forge };
    const prepare = () => prepareInventoriedCheckoutRetirement({ appId: 'app-1', release, prUrl: forge.prUrl }, opts);
    const confirm = (review, more = {}) => retireInventoriedCheckout({ appId: 'app-1', release,
      review: { prUrl: forge.prUrl, digest: review.digest, acceptSuperseded: superseded } }, { ...opts, ...more });
    return { path, release, admin, opts, forge, prepare, confirm };
  }

  // Uniquely catches the gap between exact merged delivery and an abandoned
  // prototype whose implementation was replaced rather than merged verbatim.
  it.each([false, true])('retires an explicitly accepted published prototype only after durable small-evidence preservation, replacement changed=%s', async superseded => {
    const c = await reviewedCheckout('published-prototype', { superseded });
    c.forge.prHead = c.forge.mergeCommit;
    c.forge.firstCommit = c.forge.mergeCommit;
    c.forge.changeBase = (await execGit(['rev-parse', `${c.forge.mergeCommit}^`], repo)).stdout.trim();
    c.forge.sourceSupersessionHead = c.release.head;
    c.forge.remoteHead = `${c.release.head}\trefs/heads/${c.release.branch}`;
    c.forge.sourcePreservation = { head: c.release.head, remoteRef: `refs/heads/${c.release.branch}`,
      prUrl: 'https://github.com/example/repo/pull/41' };
    await writeFile(join(c.path, 'ignored.txt'), 'small private prototype evidence');
    const input = { appId: 'app-1', release: c.release, prUrl: c.forge.prUrl, kind: 'preserved-supersession' };
    const prepared = await prepareInventoriedCheckoutRetirement(input, c.opts);
    expect(prepared, prepared.reason).toMatchObject({ ok: true, review: { comparison: { disposition: 'review-supersession', exactMergedDelivery: false } } });
    const review = { prUrl: c.forge.prUrl, kind: input.kind, digest: prepared.review.digest, acceptSuperseded: false };
    expect(await retireInventoriedCheckout({ appId: input.appId, release: c.release, review }, c.opts))
      .toMatchObject({ ok: false, reason: 'retirement-supersession-not-accepted' });
    expect(existsSync(c.path)).toBe(true);
    retirementFaults.onRemove = async () => {
      const outcome = await getBranchReconcileOutcome('app-1');
      const saved = outcome.supersededSourceEvidence[review.digest].proof;
      expect(saved.source.files).toContainEqual(expect.objectContaining({ path: 'ignored.txt',
        data: Buffer.from('small private prototype evidence').toString('base64') }));
      expect(outcome.retired || []).toEqual([]);
    };
    review.acceptSuperseded = true;
    const { recordSupersededCheckoutPreservation } = await import('./taskSchedule.js');
    // Abandoned preparations have no receipt and no current inventory holder;
    // they must not grow the schedule on every future preparation.
    injected.schedule.executions['task:branch-reconcile'].perApp['app-1'].branchReconcileOutcome.supersededSourceEvidence = {
      stale: { proof: { release: { path: '/synthetic/absent', branch: 'old', head: 'a'.repeat(40) }, data: 'x'.repeat(1024 * 1024) } },
    };
    expect(await recordSupersededCheckoutPreservation('app-1', c.release, prepared.review)).toBe(true);
    expect(Object.keys((await getBranchReconcileOutcome('app-1')).supersededSourceEvidence)).toEqual([review.digest]);
    const preservedAt = (await getBranchReconcileOutcome('app-1')).supersededSourceEvidence[review.digest].preservedAt;
    // Simulate restart after preparation but before removal: replay uses saved
    // evidence, creates no receipt early, and preserves the original timestamp.
    injected.schedule = JSON.parse(JSON.stringify(injected.schedule));
    expect(await recordSupersededCheckoutPreservation('app-1', c.release, prepared.review)).toBe(true);
    expect((await getBranchReconcileOutcome('app-1')).supersededSourceEvidence[review.digest].preservedAt).toBe(preservedAt);
    const retirement = await retireInventoriedCheckout({ appId: input.appId, release: c.release, review }, c.opts);
    expect(retirement, retirement.reason || retirement.detail).toMatchObject({ ok: true, branchDeleted: true });
    expect(existsSync(c.path)).toBe(false);
    const outcome = await getBranchReconcileOutcome('app-1');
    expect(outcome.retired).toContainEqual(expect.objectContaining({ head: c.release.head,
      disposition: 'superseded-preserved', supersessionDigest: review.digest, archiveDir: null }));
    await recordBranchReconcileOutcome('app-1', { status: 'complete', remaining: [] });
    expect((await getBranchReconcileOutcome('app-1')).retirementObligations).toEqual([]);
    expect(await archives()).toEqual([]);
  });

  it.each(['changed-source', 'persistence-failure', 'preservation-capacity', 'changed-private-evidence', 'changed-preservation'])('preserves the original when supersession confirmation encounters %s', async scenario => {
    const c = await reviewedCheckout(`prototype-confirm-${scenario}`, { superseded: true });
    c.forge.prHead = c.forge.mergeCommit;
    c.forge.firstCommit = c.forge.mergeCommit;
    c.forge.changeBase = (await execGit(['rev-parse', `${c.forge.mergeCommit}^`], repo)).stdout.trim();
    c.forge.sourceSupersessionHead = c.release.head;
    c.forge.remoteHead = `${c.release.head}\trefs/heads/${c.release.branch}`;
    c.forge.sourcePreservation = { head: c.release.head, remoteRef: `refs/heads/${c.release.branch}`, prUrl: 'https://github.com/example/repo/pull/41' };
    const mutateAfterPreservation = scenario === 'changed-private-evidence' || scenario === 'changed-preservation';
    if (mutateAfterPreservation) await writeFile(join(c.path, 'ignored.txt'), 'original private evidence');
    const prepared = await prepareInventoriedCheckoutRetirement({ appId: 'app-1', release: c.release,
      prUrl: c.forge.prUrl, kind: 'preserved-supersession' }, c.opts);
    expect(prepared, prepared.reason).toMatchObject({ ok: true });
    if (scenario === 'changed-source') c.forge.remoteHead = null;
    else if (scenario === 'persistence-failure') retirementFaults.failScheduleWrite = retirementFaults.scheduleWrites + 1;
    else if (mutateAfterPreservation) {
      let mutations = 0;
      c.opts.beforeMutation = async () => {
        // Admission is first; the second boundary follows durable preservation.
        if (++mutations !== 2) return;
        const saved = (await getBranchReconcileOutcome('app-1')).supersededSourceEvidence[prepared.review.digest];
        const file = saved.proof.source.files.find(entry => entry.scope === 'content' && entry.path === 'ignored.txt');
        expect(file.data).toBe(Buffer.from('original private evidence').toString('base64'));
        if (scenario === 'changed-private-evidence') await writeFile(join(c.path, 'ignored.txt'), 'changed private evidence');
        else file.data = Buffer.from('changed saved evidence').toString('base64');
      };
    }
    else {
      const outcome = injected.schedule.executions['task:branch-reconcile'].perApp['app-1'].branchReconcileOutcome;
      outcome.supersededSourceEvidence = { completed: { proof: { data: 'x'.repeat(1024 * 1024) } } };
      outcome.retirementReceiptEvidence = { completed: { supersessionDigest: 'completed' } };
    }
    const result = await retireInventoriedCheckout({ appId: 'app-1', release: c.release,
      review: { prUrl: c.forge.prUrl, kind: 'preserved-supersession', digest: prepared.review.digest, acceptSuperseded: true } }, c.opts);
    const reasons = { 'changed-source': 'retirement-source-not-published', 'changed-private-evidence': 'retirement-review-changed',
      'changed-preservation': 'retirement-source-preservation-unavailable' };
    expect(result).toMatchObject({ ok: false, reason: reasons[scenario] || 'checkout-not-disposable' });
    expect(existsSync(c.path)).toBe(true);
    expect((await execGit(['rev-parse', c.release.branch], repo)).stdout.trim()).toBe(c.release.head);
    expect((await getBranchReconcileOutcome('app-1')).retired || []).toEqual([]);
    if (mutateAfterPreservation) {
      expect(await readFile(join(c.path, 'ignored.txt'), 'utf8')).toBe(scenario === 'changed-private-evidence'
        ? 'changed private evidence' : 'original private evidence');
      expect(await lockText(c.path)).toBe(c.release.lockReason);
    }
    if (scenario === 'preservation-capacity') expect((await getBranchReconcileOutcome('app-1'))
      .supersededSourceEvidence.completed.proof.data).toHaveLength(1024 * 1024);
  });

  it.each(['unpublished-source', 'private-commit', 'large-private-file', 'index-recovery'])('keeps a prototype with %s', async scenario => {
    const c = await reviewedCheckout(`prototype-${scenario}`, { superseded: true });
    c.forge.prHead = c.forge.mergeCommit;
    c.forge.firstCommit = c.forge.mergeCommit;
    c.forge.changeBase = (await execGit(['rev-parse', `${c.forge.mergeCommit}^`], repo)).stdout.trim();
    c.forge.sourceSupersessionHead = c.release.head;
    c.forge.remoteHead = `${c.release.head}\trefs/heads/${c.release.branch}`;
    c.forge.sourcePreservation = { head: c.release.head, remoteRef: `refs/heads/${c.release.branch}`, prUrl: 'https://github.com/example/repo/pull/41' };
    if (scenario === 'unpublished-source') c.forge.remoteHead = null;
    if (scenario === 'large-private-file') await writeFile(join(c.path, 'ignored.txt'), Buffer.alloc(64 * 1024 + 1));
    if (scenario === 'index-recovery') {
      const blob = (await execGit(['rev-parse', 'HEAD:feature.txt'], c.path)).stdout.trim();
      await new Promise((resolve, reject) => {
        const child = execFile('git', ['update-index', '--index-info'], { cwd: c.path }, error => error ? reject(error) : resolve());
        child.stdin.end(`0 ${'0'.repeat(40)}\tfeature.txt\n${[1, 2, 3].map(stage => `100644 ${blob} ${stage}\tfeature.txt\n`).join('')}`);
      });
      await execGit(['add', 'feature.txt'], c.path);
      expect((await execGit(['ls-files', '--resolve-undo'], c.path)).stdout).toContain('feature.txt');
    }
    if (scenario === 'private-commit') {
      const unique = (await execGit(['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'unpublished private work'], c.path)).stdout.trim();
      await writeFile(join(c.admin, 'ORIG_HEAD'), `${unique}\n`);
    }
    const result = await prepareInventoriedCheckoutRetirement({ appId: 'app-1', release: c.release,
      prUrl: c.forge.prUrl, kind: 'preserved-supersession' }, c.opts);
    expect(result).toMatchObject({ ok: false, reason: scenario === 'unpublished-source' ? 'retirement-source-not-published'
      : scenario === 'private-commit' ? 'retirement-source-private-work-unpublished'
        : scenario === 'index-recovery' ? 'retirement-source-index-recovery-unpublished' : 'retirement-source-evidence-too-large' });
    expect(existsSync(c.path)).toBe(true);
    expect((await getBranchReconcileOutcome('app-1')).retired || []).toEqual([]);
  });

  async function moduleCache(checkout, { count = 1, bytes = 26 * 1024 * 1024, ignored = true,
    tagged = true, name = 'a'.repeat(40),
    // Match Vitest's producer: SHA-256(lockfile contents), truncated to eight.
    metadata = { lockfileHash: createHash('sha256').update('synthetic lockfile').digest('hex').slice(0, 8) } } = {}) {
    if (ignored) await writeFile(join(repo, '.git', 'info', 'exclude'), 'server/.cache/\n');
    const root = join(checkout.path, 'server/.cache/vitest/modules');
    await mkdir(root, { recursive: true });
    if (tagged) await writeFile(join(root, 'CACHEDIR.TAG'),
      'Signature: 8a477f597d28d172789f06886806bc55\n# This file is a cache directory tag created by Vitest.\n');
    await writeFile(join(root, '_metadata.json'), JSON.stringify(metadata));
    for (let i = 0; i < count; i++) {
      const path = join(root, count === 1 ? name : i.toString(16).padStart(40, '0'));
      await writeFile(path, 'synthetic compiled module\n');
      await truncate(path, bytes);
    }
    return root;
  }

  it.each(['reviewed', 'merged'])('retains ignored payload through the %s retirement boundary', async mode => {
    const c = await reviewedCheckout(`ignored-payload-${mode}`, { normalMerge: true, ignoredPayload: true });
    const prepared = await c.prepare();
    expect(prepared.ok).toBe(true);
    expect((await execGit(['status', '--porcelain'], c.path)).stdout.trim()).toBe('');
    const result = mode === 'reviewed' ? await c.confirm(prepared.review)
      : await retireInventoriedCheckout({ appId: 'app-1', release: c.release }, { ...c.opts, settleMergedReviewObligation: true });
    expect(result).toMatchObject({ ok: false, reason: 'checkout-ignored-payload-unverified' });
    expect(await readFile(join(c.path, 'ignored.txt'), 'utf8')).toBe('ignored work\n');
    expect(await registered(c.path)).toBe(true);
    expect(await lockText(c.path)).toBe(c.release.lockReason);
    expect((await execGit(['rev-parse', c.release.branch], repo)).stdout.trim()).toBe(c.release.head);
    expect(await archives()).toEqual([]);
  });

  it.each([
    { kind: 'oversized-file', cache: {} },
    { kind: 'oversized-total', cache: { count: 12, bytes: 22 * 1024 * 1024 } },
    { kind: 'compatible-long-hash-40', cache: { bytes: 32, metadata: { lockfileHash: 'b'.repeat(40) } } },
    { kind: 'compatible-long-hash-64', cache: { bytes: 32, metadata: { lockfileHash: 'b'.repeat(64) } } },
  ])('retires a reviewed checkout with verified disposable module cache: $kind', async ({ kind, cache }) => {
    const c = await reviewedCheckout(`disposable-cache-${kind}`);
    await moduleCache(c, cache);
    const prepared = await c.prepare();
    expect(prepared).toMatchObject({ ok: true, review: { comparison: { disposition: 'integrated' } } });
    const retired = await c.confirm(prepared.review);
    expect(retired, JSON.stringify(retired)).toMatchObject({ ok: true, branchDeleted: true });
    expect(retired.archiveDir ?? null).toBeNull();
    expect(existsSync(c.path)).toBe(false);
    expect(await registered(c.path)).toBe(false);
    expect(await archives()).toEqual([]);
  });

  // Normal tests generate state caches as well as compiled modules. Only their
  // tagged producer schema may pass the actual destructive retirement boundary.
  it.each(['results', 'dependencies', 'unknown-field', 'bad-version', 'bad-project', 'bad-index', 'untagged', 'untracked', 'sidecar'])(
    'recognizes only the actual tagged Vitest state producer: %s', async kind => {
      const c = await reviewedCheckout(`state-cache-${kind}`);
      const root = join(c.path, 'server/.cache/vitest/vitest');
      const project = join(root, 'a'.repeat(40)); await mkdir(project, { recursive: true });
      if (kind !== 'untracked') await writeFile(join(repo, '.git', 'info', 'exclude'), 'server/.cache/\n');
      if (kind !== 'untagged') await writeFile(join(root, 'CACHEDIR.TAG'),
        'Signature: 8a477f597d28d172789f06886806bc55\n# This file is a cache directory tag created by Vitest.\n# For information about cache directory tags see https://bford.info/cachedir/\n');
      const dependencies = ['dependencies', 'bad-index'].includes(kind);
      const value = { version: 1, projects: { parallel: dependencies
        ? { modules: ['services/feature.js'], globalSetup: [], files: { 'services/feature.test.js': [kind === 'bad-index' ? 99 : 0] } }
        : { files: { 'services/feature.test.js': { failed: false, duration: 12, lastRun: 12345 } } } } };
      if (kind === 'unknown-field') value.wanted = 'unique user content';
      if (kind === 'bad-version') value.version = 99;
      if (kind === 'bad-project') value.projects.parallel = { wanted: 'unique user content' };
      const file = join(project, dependencies ? 'dependencies.json' : 'results.json');
      await writeFile(file, JSON.stringify(value));
      if (kind === 'sidecar') await writeFile(join(project, 'wanted.txt'), 'unique user data');
      const prepared = await c.prepare();
      expect(prepared.ok).toBe(true);
      const retired = await c.confirm(prepared.review);
      if (['results', 'dependencies'].includes(kind)) {
        expect(retired, JSON.stringify(retired)).toMatchObject({ ok: true, branchDeleted: true });
        expect(await registered(c.path)).toBe(false);
      } else {
        expect(retired.ok).toBe(false);
        expect(await registered(c.path)).toBe(true);
        expect(await readFile(file, 'utf8')).toBe(JSON.stringify(value));
      }
      expect(await archives()).toEqual([]);
    });

  it('retains an ignored validation receipt beside a verified disposable module cache', async () => {
    const c = await reviewedCheckout('cache-with-receipt');
    await moduleCache(c, { bytes: 32 });
    const receiptDir = join(c.path, 'server/.cache/pregate');
    await mkdir(receiptDir, { recursive: true });
    const receipt = join(receiptDir, 'report.json');
    await writeFile(receipt, '{"validatedTree":"unpublished-evidence"}');
    const prepared = await c.prepare();
    expect(prepared.ok).toBe(true);
    expect(await c.confirm(prepared.review)).toMatchObject({ ok: false, reason: 'checkout-ignored-payload-unverified' });
    expect(await readFile(receipt, 'utf8')).toBe('{"validatedTree":"unpublished-evidence"}');
    expect(await registered(c.path)).toBe(true);
    expect(await lockText(c.path)).toBe(c.release.lockReason);
    expect(await archives()).toEqual([]);
  });

  it.each(['untagged', 'unique-file', 'untracked', 'unknown-metadata', 'wrong-hash-width', 'nonhex-hash', 'non-string-hash', 'newline-hash', 'extra-metadata'])(
    'retains large content that only resembles disposable module cache: %s', async kind => {
      const c = await reviewedCheckout(`unverified-cache-${kind}`);
      const metadata = {
        'unknown-metadata': { wanted: 'unique user data' },
        'wrong-hash-width': { lockfileHash: 'b'.repeat(7) },
        'nonhex-hash': { lockfileHash: 'not-hex!' },
        'non-string-hash': { lockfileHash: 12345678 },
        'newline-hash': { lockfileHash: '12345678\n' },
        'extra-metadata': { lockfileHash: '12345678', wanted: 'unique user data' },
      }[kind];
      const root = await moduleCache(c, { tagged: kind !== 'untagged', ignored: kind !== 'untracked',
        name: kind === 'unique-file' ? 'wanted-dataset.bin' : 'a'.repeat(40),
        metadata });
      expect(await c.prepare()).toMatchObject({ ok: false, reason: 'retirement-archive-limit-exceeded' });
      expect(await registered(c.path)).toBe(true);
      expect((await stat(join(root, kind === 'unique-file' ? 'wanted-dataset.bin' : 'a'.repeat(40)))).size).toBe(26 * 1024 * 1024);
      expect(await archives()).toEqual([]);
    });

  it('keeps archive creation limits intact even for a tagged disposable cache', async () => {
    const c = await reviewedCheckout('archive-cache-budget');
    await moduleCache(c);
    await expect(preserveMergedCheckout(repo, { path: c.path, branch: `refs/heads/${c.release.branch}`, head: c.release.head }, 'main', { cosDir }))
      .rejects.toThrow('retirement-archive-limit-exceeded');
    expect(await registered(c.path)).toBe(true);
    expect(await archives()).toEqual([]);
  });

  async function cacheDirectoryLink(checkout) {
    await writeFile(join(repo, '.git', 'info', 'exclude'), 'server/.cache/\n');
    const outside = join(scratch, 'wanted-outside-cache');
    await mkdir(outside);
    const wanted = join(outside, 'a'.repeat(40));
    await writeFile(wanted, 'wanted outside bytes');
    await truncate(wanted, 26 * 1024 * 1024);
    const before = await sha256File(wanted);
    const root = join(checkout.path, 'server/.cache/vitest');
    await mkdir(root, { recursive: true });
    const link = join(root, 'modules');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    return { wanted, before, link };
  }

  it.each(['native', 'traversed', 'directory'])('never follows a cache directory link or removes the outside content: %s listing', async listing => {
    const c = await reviewedCheckout('linked-cache');
    const { wanted, before } = await cacheDirectoryLink(c);
    if (listing !== 'native') {
      // Git for Windows can enumerate junction descendants as ordinary files.
      // Reproduce that boundary on every OS while retaining a real link.
      injected.onOtherFiles = output => [...output.split('\0').filter(rel => rel && !rel.startsWith('server/.cache/vitest/modules')),
        ...(listing === 'directory' ? ['server/.cache/vitest/modules/']
          : [`server/.cache/vitest/modules/${'a'.repeat(40)}`, 'server/.cache/vitest/modules/missing'])].join('\0') + '\0';
    }
    const prepared = await c.prepare();
    expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true });
    const retired = await c.confirm(prepared.review);
    expect(retired, JSON.stringify(retired)).toMatchObject({ ok: true, branchDeleted: true });
    expect(existsSync(c.path)).toBe(false);
    expect(await registered(c.path)).toBe(false);
    expect(await sha256File(wanted)).toBe(before);
    expect(await archives()).toEqual([]);
  });

  it('restores reviewed cache directory links when Git refuses removal', async () => {
    const c = await reviewedCheckout('linked-cache-removal-refused');
    const { wanted, before, link } = await cacheDirectoryLink(c);
    const target = await readlink(link);
    const prepared = await c.prepare();
    expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true });
    retirementFaults.onRemove = vi.fn(async () => {
      expect(existsSync(link)).toBe(false);
      expect(await sha256File(wanted)).toBe(before);
      throw new Error('synthetic Git removal refusal');
    });
    expect(await c.confirm(prepared.review)).toMatchObject({ ok: false });
    expect(retirementFaults.onRemove).toHaveBeenCalledTimes(1);
    expect(await readlink(link)).toBe(target);
    expect(await sha256File(wanted)).toBe(before);
    expect(existsSync(c.path)).toBe(true);
    expect(await registered(c.path)).toBe(true);
    expect(await archives()).toEqual([]);
  });

  it('settles an absent original generation from its existing service receipt without any checkout archive', async () => {
    const c = await reviewedCheckout('receipt-no-archive');
    const checkoutIdentity = await readRetirementCheckoutIdentity(c.path);
    const release = { ...c.release, checkoutIdentity, createdAt: new Date(Date.now() - 1000).toISOString() };
    const prepared = await c.prepare();
    expect(await c.confirm(prepared.review)).toMatchObject({ ok: true, branchDeleted: true });
    expect(await archives()).toEqual([]);
    const proof = await findMissingCheckoutPreservation({ repoPath: repo, release });
    expect(proof).toMatchObject({ kind: 'service-retirement-receipt', archiveDir: null,
      receipt: { branchDeleted: true, checkoutIdentity }, evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(await proof.recheck()).toBe(true);
    expect(await findMissingCheckoutPreservation({ repoPath: repo, release: { ...release, checkoutIdentity: '0'.repeat(64) } })).toBeNull();
    expect(await findMissingCheckoutPreservation({ repoPath: repo, release: { ...release, createdAt: new Date(Date.now() + 1000).toISOString() } })).toBeNull();
    await mkdir(c.path);
    expect(await proof.recheck()).toBe(false);
  });

  it.each(['delivered', 'unpublished-tip', 'lagging-local-default', 'merge-not-in-default'])(
    'keeps exact squash delivery retirement scoped when shared files change: %s', async scenario => {
      const c = await reviewedCheckout(`exact-squash-${scenario}`, { multipleCommits: true, superseded: true });
      if (scenario === 'unpublished-tip') {
        await writeFile(join(c.path, 'unpublished.txt'), 'still wanted local work\n');
        await execGit(['add', 'unpublished.txt'], c.path);
        await execGit(['commit', '-m', 'unpublished local continuation'], c.path);
        c.release.head = (await execGit(['rev-parse', 'HEAD'], c.path)).stdout.trim();
        await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...c.release, reason: 'pr-completion-review-required' }] });
      }
      if (scenario === 'lagging-local-default') {
        await execGit(['checkout', '--detach', 'main'], repo);
        await execGit(['branch', '-f', 'main', c.forge.changeBase], repo);
      }
      if (scenario === 'merge-not-in-default') c.forge.defaultHead = c.forge.changeBase;
      const prepared = await c.prepare();
      if (scenario === 'merge-not-in-default') {
        expect(prepared).toMatchObject({ ok: false, reason: 'retirement-merge-not-in-default' });
        expect(await registered(c.path)).toBe(true);
        expect(existsSync(c.path)).toBe(true);
        return;
      }
      expect(prepared).toMatchObject({ ok: true, review: { comparison: { disposition: scenario === 'unpublished-tip' ? 'review-supersession' : 'integrated' } } });
      const result = await retireInventoriedCheckout({ appId: 'app-1', release: c.release,
        review: { prUrl: c.forge.prUrl, digest: prepared.review.digest, acceptSuperseded: false } }, c.opts);
      if (scenario !== 'unpublished-tip') {
        expect(result).toMatchObject({ ok: true, branchDeleted: true });
        expect(await registered(c.path)).toBe(false);
        expect(existsSync(c.path)).toBe(false);
        expect(await archives()).toEqual([]);
      } else {
        expect(result.ok).toBe(false);
        expect(await registered(c.path)).toBe(true);
        expect(existsSync(c.path)).toBe(true);
        if (scenario === 'unpublished-tip') expect(await readFile(join(c.path, 'unpublished.txt'), 'utf8')).toBe('still wanted local work\n');
      }
    });
  it.each(['snapshot', 'forge'])('keeps unrelated ownership admission available while preview %s work is pending', async phase => {
    const c = await reviewedCheckout(`preview-queue-${phase}`);
    let paused;
    let resume;
    const entered = new Promise(resolve => { paused = resolve; });
    const pending = new Promise(resolve => { resume = resolve; });
    const pause = async () => { paused(); await pending; };
    if (phase === 'snapshot') injected.onSnapshot = pause;
    else c.opts.readForge = async () => { await pause(); return c.forge; };
    const preparing = c.prepare();
    try {
      await entered;
      expect(await withClaimOwnershipLock(() => 'settled')).toBe('settled');
      expect(await checkReconcileOwnership({ appId: 'app-1', branch: 'feature/unrelated' }, {
        getAgents: async () => [], getActiveAgentIds: () => [], readCompletionHold: async () => null,
      })).toEqual({ admitted: true });
    } finally {
      resume();
    }
    expect(await preparing).toMatchObject({ ok: true });
    expect(await registered(c.path)).toBe(true);
    expect(await lockText(c.path)).toBe(c.release.lockReason);
    expect(await archives()).toEqual([]);
  });

  it.each([
    ['owner', 'claim-owner-active'],
    ['unreadable-owner', 'claim-ownership-unreadable'],
    ['handoff', 'pr-completion-human-handoff'],
    ['policy', 'retirement-review-changed'],
    ['head', 'checkout-head-changed'],
    ['lock', 'checkout-lock-changed'],
    ['pointer', 'checkout-identity-changed'],
    ['administration', 'checkout-identity-changed'],
  ])('refuses preview when %s changes during unlocked evidence construction', async (change, reason) => {
    const c = await reviewedCheckout(`preview-race-${change}`, { ignoredPayload: true });
    let owners = [];
    c.opts.readAgents = async () => owners;
    injected.onPreviewEvidence = async () => {
      injected.onPreviewEvidence = null;
      if (change === 'owner') owners = [{ id: 'agent-live', status: 'running', workspacePath: c.path }];
      if (change === 'unreadable-owner') owners = null;
      if (change === 'handoff') injected.policies[0].metadata.prCompletionPolicy = 'leave-open';
      if (change === 'policy') injected.policies[0].id = 'different-completed-agent';
      if (change === 'head') await execGit(['commit', '--allow-empty', '-m', 'new work during preview'], c.path);
      if (change === 'lock') await writeFile(join(c.admin, 'locked'), 'new owner lock');
      if (change === 'pointer') {
        const pointer = join(c.path, '.git');
        const bytes = await readFile(pointer);
        await rename(pointer, join(scratch, 'original-pointer'));
        await writeFile(pointer, bytes);
      }
      if (change === 'administration') {
        const original = join(scratch, 'original-administration');
        await rename(c.admin, original);
        await cp(original, c.admin, { recursive: true });
      }
    };
    expect(await c.prepare()).toMatchObject({ ok: false, reason });
    expect(await registered(c.path)).toBe(true);
    expect(await readFile(join(c.path, 'ignored.txt'), 'utf8')).toBe('ignored work\n');
    expect(await archives()).toEqual([]);
  });

  it('rebuilds content evidence at confirmation after an unlocked preview observes older bytes', async () => {
    const c = await reviewedCheckout('preview-content-change');
    injected.onPreviewEvidence = async () => {
      injected.onPreviewEvidence = null;
      await writeFile(join(c.path, 'ignored.txt'), 'changed during preview\n');
    };
    const prepared = await c.prepare();
    expect(prepared.ok).toBe(true);
    expect(await c.confirm(prepared.review)).toMatchObject({ ok: false, reason: 'retirement-review-changed' });
    expect(await readFile(join(c.path, 'ignored.txt'), 'utf8')).toBe('changed during preview\n');
    expect(await lockText(c.path)).toBe(c.release.lockReason);
    expect(await archives()).toEqual([]);
  });

  it.each(['unrelated-upstream', 'changed-delivery'])('uses exact merged PR file scope after inherited upstream history: %s', async scenario => {
    const c = await reviewedCheckout(`scope-${scenario}`, { normalMerge: true });
    await writeFile(join(repo, 'upstream.txt'), 'inherited upstream\n');
    await execGit(['add', 'upstream.txt'], repo);
    await execGit(['commit', '-m', 'upstream work already delivered elsewhere'], repo);
    await execGit(['merge', '--ff-only', 'main'], c.path);
    await writeFile(join(c.path, 'feature.txt'), 'current PR delivery\n');
    await execGit(['commit', '-am', 'current PR'], c.path);
    c.release.head = (await execGit(['rev-parse', 'HEAD'], c.path)).stdout.trim();
    await execGit(['merge', '--ff-only', c.release.branch], repo);
    c.forge.prHead = c.release.head;
    c.forge.mergeCommit = c.release.head;
    await writeFile(join(repo, scenario === 'changed-delivery' ? 'feature.txt' : 'upstream.txt'), 'later upstream change\n');
    await execGit(['commit', '-am', 'advance default after delivery'], repo);
    c.forge.defaultHead = (await execGit(['rev-parse', 'HEAD'], repo)).stdout.trim();
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...c.release, reason: 'pr-completion-review-required' }] });
    const prepared = await c.prepare();
    expect(prepared).toMatchObject({ ok: true, review: { comparison: { paths: ['feature.txt'],
      disposition: 'integrated' } } });
    const result = await c.confirm(prepared.review);
    expect(result).toMatchObject({ ok: true, branchDeleted: true });
    expect(await registered(c.path)).toBe(false);
    expect(await archives()).toEqual([]);
    expect(await readFile(join(repo, scenario === 'changed-delivery' ? 'feature.txt' : 'upstream.txt'), 'utf8')).toBe('later upstream change\n');
  });

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

  it.each(['delivered', 'recreated-after-removal', 'different-generation', 'unmerged-original', 'unreadable-original', 'unrelated-capture',
    'human-handoff', 'failed-validation', 'batch-with-target', 'batch-without-target', 'failed-execution', 'batch-unmerged-current'])(
    'binds a later merged delivery to its captured owner without rewriting history: %s', async scenario => {
      const c = await reviewedCheckout(`continued-${scenario}`, { normalMerge: true });
      const { readCompletedCheckoutIdentity } = await import('./completedCheckoutEvidence.js');
      const captured = await readCompletedCheckoutIdentity({ repoPath: repo, ...c.release, allowLocked: true });
      expect(captured).not.toBeNull();
      // Persisted JSON object key order is not part of physical generation.
      captured.incarnation = { gitdir: { ...captured.incarnation.gitdir }, pointer: { ...captured.incarnation.pointer } };
      const oldHead = c.release.head;
      const oldUrl = 'https://github.com/example/repo/pull/41';
      const agent = { id: 'agent-continued', status: 'completed', startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:03:00.000Z', result: { success: true }, metadata: {
          sourceWorkspace: repo, workspacePath: captured.path, worktreeBranch: c.release.branch,
          prCompletionPolicy: scenario === 'human-handoff' ? 'leave-open' : 'review-then-merge',
          reviewLoopMergeTarget: { branch: c.release.branch, url: oldUrl },
          completedCheckouts: [{ version: 1, agentId: 'agent-continued', startedAt: '2026-01-01T00:00:00.000Z',
            capturedAt: '2026-01-01T00:02:00.000Z', ...captured }],
        } };
      let unfinished;
      if (['batch-with-target', 'batch-without-target', 'failed-execution', 'failed-validation', 'batch-unmerged-current'].includes(scenario)) {
        agent.result = { success: false, executionSuccess: scenario !== 'failed-execution',
          taskOutcome: { status: 'incomplete', reason: 'Another claim remains unfinished' } };
        agent.metadata.sourceWorkspace = null;
        agent.metadata.workspacePath = repo;
        agent.metadata.claimBranches = [c.release.branch];
        delete agent.metadata.worktreeBranch;
        agent.metadata.reviewLoopMergeTarget = scenario === 'batch-with-target' ? { branch: c.release.branch, url: c.forge.prUrl } : null;
      }
      if (scenario === 'batch-without-target') {
        unfinished = await heldCheckout('batch-unfinished', { branch: 'feature/batch-unfinished', beforeLock: async tree => {
          await writeFile(join(tree, 'pending.txt'), 'unfinished unique work\n');
          await execGit(['add', 'pending.txt'], tree);
          await execGit(['commit', '-m', 'unfinished claim'], tree);
        } });
        const pendingCapture = await readCompletedCheckoutIdentity({ repoPath: repo, ...unfinished.release, allowLocked: true });
        agent.metadata.claimBranches.push(unfinished.release.branch);
        agent.metadata.completedCheckouts.push({ version: 1, agentId: agent.id, startedAt: agent.startedAt,
          capturedAt: '2026-01-01T00:02:00.000Z', ...pendingCapture });
      }
      if (scenario === 'failed-validation') agent.result.validationPassed = false;
      if (scenario === 'different-generation') agent.metadata.completedCheckouts[0].incarnation.gitdir.ino += '0';
      if (scenario === 'unrelated-capture') {
        const tree = (await execGit(['rev-parse', `${oldHead}^{tree}`], repo)).stdout.trim();
        agent.metadata.completedCheckouts[0].head = (await execGit(['commit-tree', tree, '-m', 'unrelated captured history'], repo)).stdout.trim();
      }
      injected.policies = [agent];
      await writeFile(join(c.path, 'continued.txt'), 'later delivered change\n');
      await execGit(['add', 'continued.txt'], c.path);
      await execGit(['commit', '-m', 'later delivery on the same checkout'], c.path);
      c.release.head = (await execGit(['rev-parse', 'HEAD'], c.path)).stdout.trim();
      await execGit(['merge', '--ff-only', c.release.branch], repo);
      if (scenario === 'unrelated-capture') {
        const unrelated = agent.metadata.completedCheckouts[0].head;
        // Virtual replacement history must not turn missing delivery into proof.
        await execGit(['replace', '--graft', unrelated, oldHead], repo);
        await execGit(['replace', '--graft', c.release.head, unrelated], repo);
      }
      Object.assign(c.forge, { prHead: c.release.head, mergeCommit: c.release.head, defaultHead: c.release.head,
        changedPaths: ['continued.txt', 'feature.txt'] });
      if (scenario === 'batch-unmerged-current') {
        const tree = (await execGit(['rev-parse', `${oldHead}^{tree}`], repo)).stdout.trim();
        c.forge.mergeCommit = (await execGit(['commit-tree', tree, '-m', 'unintegrated delivery'], repo)).stdout.trim();
      }
      c.opts.readHistoricalMerge = async () => scenario === 'unreadable-original' ? null : ({ url: oldUrl,
        state: scenario === 'unmerged-original' ? 'OPEN' : 'MERGED', isCrossRepository: false,
        headRefName: c.release.branch, headRefOid: oldHead, mergeCommit: { oid: oldHead }, baseRefName: 'main' });
      if (scenario === 'recreated-after-removal') c.opts.readForge = async () => {
        if (!existsSync(c.path)) {
          await mkdir(c.path);
          await writeFile(join(c.path, 'new-owner.txt'), 'unrelated new work\n');
        }
        return c.forge;
      };
      await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...c.release, reason: 'pr-completion-review-required' }] });
      const original = structuredClone(agent);
      const prepared = await c.prepare();
      if (!['delivered', 'recreated-after-removal', 'batch-with-target', 'batch-without-target'].includes(scenario)) {
        expect(prepared).toMatchObject({ ok: false, reason: scenario === 'human-handoff'
          ? 'pr-completion-human-handoff' : 'retirement-policy-not-legacy-completed' });
        expect(await registered(c.path)).toBe(true);
        expect(await archives()).toEqual([]);
      } else {
        expect(prepared).toMatchObject({ ok: true, review: { policy: { policies: [{ continuedDelivery: {
          originalPrUrl: agent.metadata.reviewLoopMergeTarget?.url ?? null, capturedHead: oldHead, tip: c.release.head,
        } }] } } });
        const retired = await c.confirm(prepared.review);
        expect(retired).toMatchObject({ ok: true, branchDeleted: scenario !== 'recreated-after-removal' });
        if (scenario === 'recreated-after-removal') {
          expect(retired.branchRetainedReason).toBe('retirement-evidence-changed');
          expect(await readFile(join(c.path, 'new-owner.txt'), 'utf8')).toBe('unrelated new work\n');
          expect((await execGit(['rev-parse', c.release.branch], repo)).stdout.trim()).toBe(c.release.head);
        }
        expect(retired.archiveDir).toBeUndefined();
        expect(await archives()).toEqual([]);
        if (scenario !== 'recreated-after-removal') expect(await registered(c.path)).toBe(false);
        expect((await c.prepare()).ok).toBe(false);
        if (unfinished) {
          expect(await registered(unfinished.path)).toBe(true);
          expect(await lockText(unfinished.path)).toBe(unfinished.release.lockReason);
          expect(await readFile(join(unfinished.path, 'pending.txt'), 'utf8')).toBe('unfinished unique work\n');
          expect((await execGit(['rev-parse', unfinished.release.branch], repo)).stdout.trim()).toBe(unfinished.release.head);
        }
      }
      expect(agent).toEqual(original);
    });

  it('preserves the checkout when escaped review evidence exceeds the recovery manifest limit', async () => {
    const c = await reviewedCheckout('manifest-byte-limit', {
      superseded: true, featurePath: 'tabs.txt', featureBody: '\t'.repeat(4 * 1024 * 1024 - 512) + '\n',
    });
    await execGit(['rm', 'tabs.txt'], repo);
    await execGit(['commit', '-m', 'remove superseded feature'], repo);
    c.forge.defaultHead = (await execGit(['rev-parse', 'main'], repo)).stdout.trim();
    const prepared = await c.prepare();
    expect(prepared.ok).toBe(true);
    expect(Buffer.byteLength(prepared.review.comparison.localPatch)).toBeLessThan(4 * 1024 * 1024);
    expect(Buffer.byteLength(prepared.review.comparison.difference)).toBeLessThan(4 * 1024 * 1024);
    expect(await c.confirm(prepared.review)).toMatchObject({ ok: true, branchDeleted: true });
    expect(existsSync(c.path)).toBe(false);
    expect(await registered(c.path)).toBe(false);
    expect((await execGit(['rev-parse', '--verify', '--quiet', `refs/heads/${c.release.branch}`], repo, { ignoreExitCode: true })).exitCode).toBe(1);
    expect(await archives()).toEqual([]);
  });

  it('removes a merged clean checkout once and does not create an archive', async () => {
    const c = await reviewedCheckout('bounded-interruption', { normalMerge: true });
    const prepared = await c.prepare();
    expect(prepared.ok).toBe(true);
    expect(await c.confirm(prepared.review)).toMatchObject({ ok: true, branchDeleted: true });
    expect(existsSync(c.path)).toBe(false);
    expect(await archives()).toEqual([]);
    expect((await c.confirm(prepared.review)).ok).toBe(false);
    expect(await archives()).toEqual([]);
  });

  it('refuses combined content and administration bytes before preview or teardown while each snapshot fits', async () => {
    const c = await reviewedCheckout('combined-byte-limit', { normalMerge: true });
    const prepared = await c.prepare();
    expect(prepared.ok).toBe(true);
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
    const refusal = { ok: false, reason: 'retirement-archive-limit-exceeded', nextAction: expect.any(String), archiveLimit: {
      scope: 'combined', kind: 'total', limitBytes: 250 * 1024 * 1024, observedBytes: expect.any(Number),
    } };
    const preview = await c.prepare();
    expect(preview).toEqual(refusal);
    expect(preview.archiveLimit.observedBytes).toBeGreaterThanOrEqual(12 * bytes);
    expect(preview.archiveLimit.observedBytes).toBeLessThan(12 * bytes + 1024 * 1024);
    expect(await c.confirm(prepared.review)).toEqual(refusal);
    expect(await Promise.all(files.map(sha256File))).toEqual(hashes);
    expect(await registered(c.path)).toBe(true);
    expect(await lockText(c.path)).toBe(c.release.lockReason);
    expect((await execGit(['rev-parse', c.release.branch], repo)).stdout.trim()).toBe(c.release.head);
    expect(await archives()).toEqual([]);
    expect(await getBranchReconcileOutcome('app-1')).toEqual(before);
    // Unattended cleanup must also preserve bytes omitted from Git status.
    const removed = await retireInventoriedCheckout({ appId: 'app-1', release: c.release }, {
      ...c.opts, settleMergedReviewObligation: true,
    });
    expect(removed).toMatchObject({ ok: false, reason: 'checkout-ignored-payload-unverified' });
    expect(removed.archiveDir).toBeUndefined();
    expect(await Promise.all(files.map(sha256File))).toEqual(hashes);
    expect(await registered(c.path)).toBe(true);
    expect(await archives()).toEqual([]);
  });

  describe('many-file resource-bounded preservation', () => {
    let c;
    let prepared;
    let retired;
    // Retain main's separate fixture/retirement/proof phases and their existing
    // 30-second budgets while exercising more than 1,000 files in both snapshots.
    beforeEach(async () => {
      c = await reviewedCheckout('file-count-admitted', { normalMerge: true });
      const directory = join(c.path, 'private-files');
      await mkdir(directory);
      await Promise.all(Array.from({ length: 1050 }, (_, i) => writeFile(join(directory, `item-${i}`), 'retained ignored bytes\n')));
      if (process.platform !== 'win32') await chmod(join(directory, 'item-1049'), 0o755);
      const privateDir = join(c.admin, 'private-files');
      await mkdir(privateDir);
      await Promise.all(Array.from({ length: 60 }, (_, i) => writeFile(join(privateDir, `item-${i}`), 'private recovery bytes\n')));
      prepared = await c.prepare();
      expect(prepared.ok).toBe(true);
    });

    beforeEach(async () => {
      retired = await c.confirm(prepared.review);
      expect(retired).toMatchObject({ ok: false, reason: 'checkout-ignored-payload-unverified' });
    });

    it('retains more than 1000 ignored files and their original checkout without copying', async () => {
      expect(retired.archiveDir).toBeUndefined();
      expect(await readFile(join(c.path, 'private-files', 'item-1049'), 'utf8')).toBe('retained ignored bytes\n');
      expect(await registered(c.path)).toBe(true);
      expect(await lockText(c.path)).toBe(c.release.lockReason);
      expect((await execGit(['rev-parse', c.release.branch], repo)).stdout.trim()).toBe(c.release.head);
      expect(await archives()).toEqual([]);
    });
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
    const files = Array.from({ length: count }, (_, i) => join(root, `private-${i}.bin`));
    for (const file of files) {
      await writeFile(file, 'synthetic preserved bytes');
      await truncate(file, bytes);
    }
    const hashes = await Promise.all(files.map(sha256File));
    const before = await getBranchReconcileOutcome('app-1');
    const result = await c.prepare();
    expect(result).toEqual({ ok: false, reason: 'retirement-archive-limit-exceeded', nextAction: expect.any(String), archiveLimit: {
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
    await writeFile(file, 'synthetic ignored payload');
    await truncate(file, bytes);
    const hash = await sha256File(file);
    const before = await getBranchReconcileOutcome('app-1');
    const result = mode === 'reviewed' ? await c.confirm(prepared.review)
      : await retireInventoriedCheckout({ appId: 'app-1', release: c.release }, { ...c.opts, settleMergedReviewObligation: true });
    if (mode === 'reviewed') {
      expect(result).toEqual({ ok: false, reason: 'retirement-archive-limit-exceeded', nextAction: expect.any(String), archiveLimit: {
        scope: 'content', kind: 'file', limitBytes: bytes - 1, observedBytes: bytes,
      } });
      expect(await sha256File(file)).toBe(hash);
      expect(await registered(c.path)).toBe(true);
      expect(await lockText(c.path)).toBe(c.release.lockReason);
      expect((await execGit(['rev-parse', c.release.branch], repo)).stdout.trim()).toBe(c.release.head);
      expect(await archives()).toEqual([]);
      expect(await getBranchReconcileOutcome('app-1')).toEqual(before);
      return;
    }
    expect(result).toMatchObject({ ok: false, reason: 'checkout-ignored-payload-unverified' });
    expect(result.archiveDir).toBeUndefined();
    expect(await sha256File(file)).toBe(hash);
    expect(await registered(c.path)).toBe(true);
    expect(await lockText(c.path)).toBe(c.release.lockReason);
    expect(await archives()).toEqual([]);
  });

  it('retains measured capacity and the exact lock when the final refreshed review exceeds its budget', async () => {
    const c = await reviewedCheckout('final-review-capacity', { normalMerge: true });
    const prepared = await c.prepare();
    expect(prepared.ok).toBe(true);
    const before = await getBranchReconcileOutcome('app-1');
    const file = join(c.path, 'ignored.txt');
    const bytes = 25 * 1024 * 1024 + 1;
    let mutations = 0;
    let changedHash;
    const result = await c.confirm(prepared.review, { beforeMutation: async () => {
      if (++mutations === 2) {
        await writeFile(file, 'synthetic ignored payload');
        await truncate(file, bytes);
        changedHash = await sha256File(file);
      }
    } });
    expect(result).toMatchObject({ ok: false, reason: 'retirement-archive-limit-exceeded', nextAction: expect.any(String),
      archiveLimit: { scope: 'content', kind: 'file', limitBytes: bytes - 1, observedBytes: bytes } });
    expect(result.archiveDir).toBeUndefined();
    expect(changedHash).toBeTruthy();
    expect(await sha256File(file)).toBe(changedHash);
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
    expect(result.archiveDir).toBeUndefined();
    expect(await registered(c.release.path)).toBe(false);
    expect(await archives()).toEqual([]);
    expect((await execGit(['rev-parse', '--verify', '--quiet', `refs/heads/${c.release.branch}`], repo, { ignoreExitCode: true })).exitCode).toBe(1);
  });

  it('refreshes missing operator-review proof objects after remote main moves without accepting the old digest or advancing refs', async () => {
    const c = await reviewedCheckout('advanced-default', { ignoredPayload: true });
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
    await makeClean(c.path);
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
    expect(result.archiveDir).toBeUndefined();
    expect(existsSync(c.path)).toBe(false);
    expect(await archives()).toEqual([]);
  });

  it.each(['head', 'supersession'])('binds receipt cleanup to the exact merged head despite later edits: %s', async change => {
    const c = await receiptCheckout('receipt-evidence', {
      superseded: change === 'supersession', multipleCommits: change === 'head',
    });
    // A different head with valid original ancestry reaches the receipt's
    // exact-head guard; the squash commit has no such ancestry and fails earlier.
    if (change === 'head') {
      c.forge.prHead = c.forge.firstCommit;
      c.forge.changedPaths = ['feature.txt'];
    }
    const result = await c.retireReceipt();
    expect(result).toMatchObject(change === 'head' ? { ok: false, reason: 'receipt-pr-head-changed' }
      : { ok: true, branchDeleted: true });
    expect(await registered(c.release.path)).toBe(change === 'head');
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
    const result = await c.retireReceipt({ readAgents: async () => (++reads < 3 ? [] : [{
      id: 'agent-live', status: 'running', workspacePath: c.release.path,
    }]) });
    expect(result).toMatchObject({ ok: false, reason: 'claim-owner-active' });
    expect(result.archiveDir).toBeUndefined();
    expect(await registered(c.release.path)).toBe(true);
    expect(await readFile(join(c.path, 'feature.txt'), 'utf8')).toBe('original feature\n');
    expect(await archives()).toEqual([]);
  });

  it.each(['original', 'repo-alias', 'recreated-pointer', 'active-owner', 'different-pr-head', 'failed-validation', 'missing-terminal-head', 'late-writer'])('recovers a merged orphan only from its exact early generation: %s', async scenario => {
    const c = await reviewedCheckout(`orphan-${scenario}`);
    await execGit(['worktree', 'unlock', c.path], repo);
    Object.assign(c.release, { locked: false, lockReason: null });
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...c.release, reason: 'pr-completion-review-required' }] });
    const evidence = await import('./completedCheckoutEvidence.js');
    const agent = { id: 'original-orphan', status: 'running', startedAt: new Date(Date.now() - 60_000).toISOString(),
      result: { success: false, executionSuccess: false, orphaned: true, validationPassed: null },
      metadata: { isWorktree: true, sourceWorkspace: repo, workspacePath: c.path, worktreeBranch: c.release.branch,
        prCompletionPolicy: 'review-then-merge', reviewLoopMergeTarget: { url: c.forge.prUrl, branch: c.release.branch } } };
    agent.metadata.checkoutSeeds = await evidence.captureCheckoutSeeds(agent);
    // completeAgent preserves this exact target while the run is still bound,
    // before publishing an orphan's terminal state with an empty initial capture.
    const targets = await evidence.captureSeededCompletionCheckouts(agent, { preterminal: true });
    expect(targets).toEqual([expect.objectContaining({ head: c.release.head, startedAt: agent.startedAt })]);
    agent.metadata.checkoutCapture = { status: 'captured', targets, unknown: false };
    agent.status = 'completed';
    agent.completedAt = new Date().toISOString();
    agent.metadata.completedCheckouts = [];
    if (scenario === 'missing-terminal-head') agent.metadata.checkoutCapture = { status: 'captured' };
    if (scenario === 'late-writer') {
      await writeFile(join(c.path, 'later-user.txt'), 'later independent work\n');
      await execGit(['add', 'later-user.txt'], c.path);
      await execGit(['commit', '-m', 'later independent writer'], c.path);
      expect(await evidence.captureSeededCompletionCheckouts(agent)).toBeNull();
    }
    if (scenario === 'repo-alias') injected.app.repoPath = `${repo}/../repo`;
    if (scenario === 'failed-validation') agent.result.validationPassed = false;
    injected.policies = [agent];
    const originalResult = structuredClone(agent.result);
    let recoveries = 0;
    c.opts.recoverCheckoutCapture = async (id, { retirement }) => {
      expect(id).toBe(agent.id);
      expect(retirement).toMatchObject({ ...c.release, repoPath: realpathSync(repo), path: realpathSync(c.path) });
      const captured = await evidence.captureSeededCompletionCheckouts(agent);
      if (!captured) return false;
      agent.metadata.completedCheckouts = captured;
      recoveries++;
      return true;
    };
    if (scenario === 'recreated-pointer') {
      const bytes = await readFile(join(c.path, '.git'));
      await rename(join(c.path, '.git'), join(scratch, 'original-pointer'));
      await writeFile(join(c.path, '.git'), bytes);
    }
    if (scenario === 'active-owner') c.opts.readAgents = async () => [{ id: 'other', status: 'running', workspacePath: c.path }];
    if (scenario === 'different-pr-head') c.forge.prHead = 'b'.repeat(40);
    const prepared = await c.prepare();
    expect(agent.result).toEqual(originalResult);
    if (!['original', 'repo-alias'].includes(scenario)) {
      expect(prepared.ok).toBe(false);
      expect(await registered(c.path)).toBe(true);
      expect(await archives()).toEqual([]);
      expect(recoveries).toBe(0);
      if (scenario === 'late-writer') expect(await readFile(join(c.path, 'later-user.txt'), 'utf8')).toBe('later independent work\n');
      return;
    }
    expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true, review: { policy: { policies: [{ success: false, orphanedExecution: true }] } } });
    const receipt = agent.metadata.completedCheckouts[0];
    expect(receipt).toMatchObject({ version: 2, head: c.release.head });
    expect(evidence.completedCheckoutReceiptValid(agent, receipt)).toBe(true);
    const retired = await c.confirm(prepared.review);
    expect(retired).toMatchObject({ ok: true, branchDeleted: true });
    expect(retired.archiveDir).toBeUndefined();
    expect(await registered(c.path)).toBe(false);
    expect((await c.prepare()).ok).toBe(false);
    expect(await archives()).toEqual([]);
    expect(recoveries).toBe(1);
    expect(agent.result).toEqual(originalResult);
  });

  it('retires exact release-target delivery without merging it into the unrelated default branch', async () => {
    const c = await reviewedCheckout('release-target-delivery', { targetBranch: 'release' });
    await expect(execGit(['merge-base', '--is-ancestor', c.forge.mergeCommit, 'main'], repo)).rejects.toThrow();
    const prepared = await c.prepare();
    expect(prepared).toMatchObject({ ok: true, review: { forge: { targetBranch: 'release' }, comparison: { disposition: 'integrated' } } });
    expect(await c.confirm(prepared.review)).toMatchObject({ ok: true, branchDeleted: true });
    expect(await registered(c.path)).toBe(false);
    expect((await execGit(['rev-parse', 'release'], repo)).stdout.trim()).toBe(c.forge.targetHead);
    expect((await execGit(['rev-parse', 'main'], repo)).stdout.trim()).toBe(c.forge.defaultHead);
    expect(await archives()).toEqual([]);
  });

  it('settles the captured release delivery of an incomplete batch without declaring its siblings successful', async () => {
    const c = await reviewedCheckout('release-incomplete-batch', { targetBranch: 'release' });
    const { readCompletedCheckoutIdentity } = await import('./completedCheckoutEvidence.js');
    const identity = await readCompletedCheckoutIdentity({ repoPath: repo, ...c.release, allowLocked: true });
    expect(identity?.head).toBe(c.release.head);
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const capturedAt = new Date().toISOString();
    const result = { success: false, executionSuccess: true, validationPassed: true,
      taskOutcome: { status: 'incomplete', reason: 'A different batch branch still needs delivery.' } };
    injected.policies = [{ id: 'completed-batch', status: 'completed', startedAt, completedAt: capturedAt, result,
      metadata: { workspacePath: repo, claimBranches: [c.release.branch], prCompletionPolicy: 'review-then-merge',
        completedCheckouts: [{ version: 1, agentId: 'completed-batch', startedAt, capturedAt,
          ...identity, repoPath: repo, branch: c.release.branch, path: c.path }] } }];
    const before = structuredClone(result);
    const prepared = await c.prepare();
    expect(prepared).toMatchObject({ ok: true, review: { policy: { policies: [expect.objectContaining({ continuedDelivery: expect.any(Object) })] } } });
    expect(await c.confirm(prepared.review)).toMatchObject({ ok: true, branchDeleted: true });
    expect(injected.policies[0].result).toEqual(before);
    expect(await registered(c.path)).toBe(false);
  });

  it.each(['wrong-target', 'unpublished-continuation'])('preserves release checkout with %s', async scenario => {
    const c = await reviewedCheckout(`release-target-${scenario}`, { targetBranch: 'release' });
    if (scenario === 'wrong-target') c.forge.targetHead = c.forge.defaultHead;
    else {
      await writeFile(join(c.path, 'unpublished.txt'), 'wanted unfinished continuation\n');
      await execGit(['add', 'unpublished.txt'], c.path);
      await execGit(['commit', '-m', 'unpublished continuation'], c.path);
      c.release.head = (await execGit(['rev-parse', 'HEAD'], c.path)).stdout.trim();
      await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...c.release, reason: 'pr-completion-review-required' }] });
    }
    const prepared = await c.prepare();
    if (scenario === 'wrong-target') expect(prepared).toMatchObject({ ok: false, reason: 'retirement-merge-not-in-target' });
    else {
      expect(prepared).toMatchObject({ ok: true, review: { comparison: { disposition: 'review-supersession', exactMergedDelivery: false } } });
      expect(await c.confirm(prepared.review)).toMatchObject({ ok: false });
      expect(await readFile(join(c.path, 'unpublished.txt'), 'utf8')).toContain('wanted unfinished continuation');
    }
    expect(await registered(c.path)).toBe(true);
    expect(await archives()).toEqual([]);
  });

  it('does not require manual supersession acceptance for an exact delivered head after later edits', async () => {
    const c = await reviewedCheckout('ancestral', { normalMerge: true, superseded: true });
    const prepared = await c.prepare();
    expect(prepared).toMatchObject({ ok: true, review: { comparison: { disposition: 'integrated', exactMergedDelivery: true } } });
    expect(prepared.review.comparison.difference).toContain('strengthened replacement');
    expect(await retireInventoriedCheckout({ appId: 'app-1', release: c.release,
      review: { prUrl: c.forge.prUrl, digest: prepared.review.digest, acceptSuperseded: false } }, c.opts))
      .toMatchObject({ ok: true, branchDeleted: true });
  });

  it('compares pathspec glob filenames literally', async () => {
    const c = await reviewedCheckout('literal', { featurePath: '[literal].txt', superseded: true });
    await writeFile(join(repo, 'l.txt'), 'unrelated glob match\n');
    await execGit(['add', 'l.txt'], repo);
    await execGit(['commit', '-m', 'unrelated default change'], repo);
    c.forge.defaultHead = (await execGit(['rev-parse', 'HEAD'], repo)).stdout.trim();
    const prepared = await c.prepare();
    expect(prepared.ok).toBe(true);
    expect(prepared.review.comparison.disposition).toBe('integrated');
    expect(prepared.review.comparison.exactMergedDelivery).toBe(true);
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
    // A stale stat cache must not let confirmation's own status read rewrite
    // the private index and invalidate an otherwise unchanged scoped review.
    await utimes(join(c.path, 'feature.txt'), new Date('2001-01-01'), new Date('2001-01-01'));
    const index = await readFile(join(c.admin, 'index'));
    const prepared = await c.prepare();
    expect(prepared.ok).toBe(true);
    expect(await readFile(join(c.admin, 'index'))).toEqual(index);
    expect(prepared.review.comparison.disposition).toBe('integrated');
    const result = await c.confirm(prepared.review);
    expect(result, `Confirmation refusal: ${result.reason ?? 'none'}`).toMatchObject({ ok: true, branchDeleted: true });
    expect(result.archiveDir).toBeUndefined();
    expect(existsSync(c.path)).toBe(false);
    expect(await archives()).toEqual([]);
    expect(injected.policies[0].metadata.branchCompletionPolicy).toBeUndefined();
  });

  it('proves rewritten delivery only for the captured completed resume lineage before retirement', async () => {
    const c = await reviewedCheckout('rewritten-resume', { normalMerge: true });
    await execGit(['worktree', 'unlock', c.path], repo);
    Object.assign(c.release, { locked: false, lockReason: null });
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...c.release, reason: 'pr-completion-review-required' }] });
    const { readCompletedCheckoutIdentity } = await import('./completedCheckoutEvidence.js');
    const captured = await readCompletedCheckoutIdentity({ repoPath: repo, ...c.release });
    const base = (await execGit(['rev-parse', `${c.release.head}^`], repo)).stdout.trim();
    const rewritten = (await execGit(['commit-tree', `${c.release.head}^{tree}`, '-p', base, '-m', 'before review rewrite'], repo)).stdout.trim();
    const attempts = ['predecessor', 'successor'].map((id, index) => {
      const startedAt = `2026-03-01T0${index}:00:00.000Z`;
      const path = index ? c.path : join(external, 'original-before-move');
      return { id, taskId: 'same-original-task', status: 'completed', startedAt,
        completedAt: `2026-03-01T0${index}:01:00.000Z`,
        result: { success: false, executionSuccess: true, validationPassed: index ? true : null,
          ...(index && { cleanupPending: true, taskOutcome: { status: 'incomplete', recovery: { mode: 'cleanup' } } }) },
        metadata: { sourceWorkspace: repo, workspacePath: path, worktreeBranch: c.release.branch,
          prCompletionPolicy: 'review-then-merge', reviewLoopMergeTarget: { branch: c.release.branch, url: c.forge.prUrl },
          resumedFromAgentId: index ? 'predecessor' : null,
          completedCheckouts: [{ version: 1, agentId: id, startedAt, capturedAt: startedAt, ...captured,
            path, head: index ? c.release.head : rewritten }] } };
    });
    injected.policies = attempts;
    const unchanged = structuredClone(attempts);
    // A changed patch and an additional dropped patch must not be mistaken for
    // a rebase, even with the exact same trusted resume/physical lineage.
    const rejected = [];
    const scratchCheckout = join(external, 'unmatched-original');
    await execGit(['worktree', 'add', '--detach', scratchCheckout, base], repo);
    await writeFile(join(scratchCheckout, 'feature.txt'), 'changed original patch\n');
    await execGit(['add', 'feature.txt'], scratchCheckout);
    await execGit(['commit', '-m', 'changed original patch'], scratchCheckout);
    rejected.push((await execGit(['rev-parse', 'HEAD'], scratchCheckout)).stdout.trim());
    await execGit(['checkout', '--detach', rewritten], scratchCheckout);
    await writeFile(join(scratchCheckout, 'dropped.txt'), 'wanted undelivered patch\n');
    await execGit(['add', 'dropped.txt'], scratchCheckout);
    await execGit(['commit', '-m', 'undelivered additional patch'], scratchCheckout);
    rejected.push((await execGit(['rev-parse', 'HEAD'], scratchCheckout)).stdout.trim());
    await execGit(['worktree', 'remove', scratchCheckout], repo);
    rejected.push((await execGit(['commit-tree', `${c.release.head}^{tree}`, '-p', base, '-p', c.release.head, '-m', 'ambiguous original merge'], repo)).stdout.trim());
    const row = attempts[0].metadata.completedCheckouts[0];
    for (const head of rejected) {
      row.head = head;
      expect(await c.prepare()).toMatchObject({ ok: false, reason: 'retirement-policy-not-legacy-completed' });
      expect(await registered(c.path)).toBe(true);
    }
    row.head = rewritten;
    for (const [target, key, value] of [[attempts[0], 'taskId', 'other-task'], [attempts[0], 'status', 'running'],
      [attempts[0].metadata.reviewLoopMergeTarget, 'url', 'https://github.com/example/repo/pull/43'],
      [attempts[0].metadata, 'prCompletionPolicy', 'leave-open'],
      [row, 'incarnation', { pointer: { ino: 'different' } }]]) {
      const prior = target[key]; target[key] = value;
      const refused = await c.prepare();
      expect(refused, `${key}: ${JSON.stringify(refused)}`).toMatchObject({ ok: false });
      expect(await registered(c.path)).toBe(true);
      target[key] = prior;
    }
    // An explicit original-head policy must bind the captured old head, rather
    // than being replaced with the rewritten tip to make the review pass.
    attempts[0].metadata.branchCompletionPolicy = { branch: c.release.branch, completion: 'review-then-merge',
      prUrl: c.forge.prUrl, tip: 'b'.repeat(40) };
    expect(await c.prepare()).toMatchObject({ ok: false });
    attempts[0].metadata.branchCompletionPolicy.tip = rewritten;
    const boundPolicy = await c.prepare();
    expect(boundPolicy, JSON.stringify(boundPolicy)).toMatchObject({ ok: true });
    delete attempts[0].metadata.branchCompletionPolicy;
    const prepared = await c.prepare();
    expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true, review: { policy: { policies: [
      { id: 'predecessor', success: false, resumedCleanup: { successorAgentId: 'successor' } },
      { id: 'successor', success: false },
    ] } } });
    const retired = await c.confirm(prepared.review);
    expect(retired, JSON.stringify(retired)).toMatchObject({ ok: true, branchDeleted: true });
    expect(existsSync(c.path)).toBe(false);
    expect(retired.archiveDir ?? null).toBeNull();
    expect(await archives()).toEqual([]);
    expect(injected.policies).toEqual(unchanged);
    expect((await getBranchReconcileOutcome('app-1')).retired).toContainEqual(expect.objectContaining({
      branch: c.release.branch, head: c.release.head, branchDeleted: true, archiveDir: null,
    }));
  });

  it('retires a resumed merged checkout without promoting failed attempts or accepting unrelated generations', async () => {
    const c = await reviewedCheckout('resumed-cleanup', { normalMerge: true });
    await execGit(['worktree', 'unlock', c.path], repo);
    Object.assign(c.release, { locked: false, lockReason: null });
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...c.release, reason: 'pr-completion-review-required' }] });
    const { readCompletedCheckoutIdentity } = await import('./completedCheckoutEvidence.js');
    const captured = await readCompletedCheckoutIdentity({ repoPath: repo, ...c.release });
    const attempts = ['failed', 'cleanup', 'resumed'].map((id, index) => {
      const startedAt = `2026-03-01T0${index}:00:00.000Z`;
      const path = index === 2 ? c.path : join(external, id);
      return { id, taskId: 'same-original-task', status: 'completed', startedAt,
        completedAt: `2026-03-01T0${index}:01:00.000Z`,
        result: index === 0 ? { success: false, executionSuccess: false, validationPassed: null }
          : { success: false, executionSuccess: true, validationPassed: true, cleanupPending: true,
            taskOutcome: { status: 'incomplete', recovery: { mode: 'cleanup' } } },
        metadata: { sourceWorkspace: repo, workspacePath: path, worktreeBranch: c.release.branch,
          prCompletionPolicy: 'review-then-merge', reviewLoopMergeTarget: { branch: c.release.branch, url: c.forge.prUrl },
          checkoutSeeds: [],
          resumedFromAgentId: index ? ['failed', 'cleanup'][index - 1] : null,
          completedCheckouts: [{ version: 1, agentId: id, startedAt, capturedAt: startedAt, ...captured, path }] } };
    });
    injected.policies = attempts;
    // Git and realpath can spell the same Windows path differently. Exercise
    // equivalent receipt paths on every platform, retaining the real identity.
    const receipt = attempts[2].metadata.completedCheckouts[0];
    receipt.repoPath += '/.';
    receipt.path += '/.';
    const original = structuredClone(attempts);
    // A missing link, a different task or physical generation, and a real
    // validation/human hold cannot be released by a later successful execution.
    for (const [target, key, value] of [[attempts[2].metadata, 'resumedFromAgentId', null],
      [attempts[0], 'taskId', 'other-task'], [attempts[0].result, 'validationPassed', false],
      [attempts[0].metadata, 'prCompletionPolicy', 'leave-open'],
      [receipt, 'repoPath', join(scratch, 'unrelated-repo')],
      [receipt, 'path', join(external, 'unrelated-checkout')],
      [attempts[0].metadata.completedCheckouts[0], 'head', 'b'.repeat(40)],
      [attempts[0].metadata.completedCheckouts[0], 'incarnation', { pointer: { ino: 'other' } }]]) {
      const prior = target[key]; target[key] = value;
      const refused = await c.prepare();
      expect(refused, `${key}: ${JSON.stringify(refused)}`).toMatchObject({ ok: false });
      expect(await registered(c.path)).toBe(true);
      target[key] = prior;
    }
    const prepared = await c.prepare();
    expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true, review: { policy: { policies: [
      { id: 'cleanup', success: false, resumedCleanup: { successorAgentId: 'resumed' } },
      { id: 'failed', success: false, resumedCleanup: { successorAgentId: 'resumed' } },
      { id: 'resumed', success: false },
    ] } } });
    const retired = await c.confirm(prepared.review);
    expect(retired, JSON.stringify(retired)).toMatchObject({ ok: true, branchDeleted: true });
    expect(existsSync(c.path)).toBe(false);
    expect(await archives()).toEqual([]);
    expect(injected.policies).toEqual(original);
    expect((await getBranchReconcileOutcome('app-1')).retired).toContainEqual(expect.objectContaining({
      branch: c.release.branch, path: c.path, head: c.release.head, branchDeleted: true, archiveDir: null,
    }));
  });

  it.each(['captured', 'legacy-capture', 'missing-capture', 'failed-validation', 'failed-execution', 'human-handoff', 'changed-generation'])(
    'retires captured merge-on-green delivery without promoting its aggregate outcome: %s', async scenario => {
      const c = await reviewedCheckout(`merge-on-green-${scenario}`);
      await execGit(['worktree', 'unlock', c.path], repo);
      Object.assign(c.release, { locked: false, lockReason: null });
      await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...c.release, reason: 'pr-completion-review-required' }] });
      const evidence = await import('./completedCheckoutEvidence.js');
      const agent = { id: 'completed-automatic-owner', status: 'running', startedAt: new Date(Date.now() - 60_000).toISOString(),
        metadata: { isWorktree: true, sourceWorkspace: repo, workspacePath: c.path, worktreeBranch: c.release.branch,
          prCompletionPolicy: 'merge-on-green' } };
      agent.metadata.checkoutSeeds = await evidence.captureCheckoutSeeds(agent);
      agent.metadata.completedCheckouts = await evidence.captureSeededCompletionCheckouts(agent, { preterminal: true });
      expect(agent.metadata.completedCheckouts).toHaveLength(1);
      agent.status = 'completed'; agent.completedAt = new Date().toISOString();
      agent.result = { success: false, executionSuccess: true, validationPassed: true,
        taskOutcome: { status: 'blocked', recovery: { mode: 'runtime', prUrl: c.forge.prUrl, requiredCommit: c.forge.defaultHead } } };
      if (scenario === 'legacy-capture') agent.metadata.completedCheckouts = agent.metadata.completedCheckouts.map(row =>
        ({ ...row, version: 1, capturedAt: agent.completedAt }));
      if (scenario === 'missing-capture') agent.metadata.completedCheckouts = [];
      if (scenario === 'failed-validation') agent.result.validationPassed = false;
      if (scenario === 'failed-execution') agent.result.executionSuccess = false;
      if (scenario === 'human-handoff') agent.metadata.prCompletionPolicy = 'leave-open';
      if (scenario === 'changed-generation') agent.metadata.completedCheckouts[0].incarnation.pointer.ino = '1';
      injected.policies = [agent];
      const original = structuredClone(agent);
      const prepared = await c.prepare();
      if (!['captured', 'legacy-capture'].includes(scenario)) {
        expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: false });
        expect(await registered(c.path)).toBe(true);
      } else {
        expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true, review: { policy: { policies: [
          { id: agent.id, success: false, completion: 'merge-on-green', continuedDelivery: { kind: 'captured-merged-delivery' } },
        ] } } });
        const retired = await c.confirm(prepared.review);
        expect(retired, JSON.stringify(retired)).toMatchObject({ ok: true, branchDeleted: true });
        expect(await registered(c.path)).toBe(false);
      }
      expect(agent).toEqual(original);
      expect(await archives()).toEqual([]);
    });

  it.each([false, true])('retires legacy pinned cleanup with lagging main and missing remote proof=%s', async missingProof => {
    const c = await reviewedCheckout('pinned-cleanup', { normalMerge: true });
    injected.policies[0].result = { success: false, executionSuccess: true,
      taskOutcome: { status: 'incomplete', recovery: { mode: 'cleanup' } } };
    let shippedDefault = c.forge.defaultHead;
    if (missingProof) {
      const remote = join(scratch, 'proof-remote');
      await execGit(['clone', '--no-hardlinks', repo, remote], scratch);
      await execGit(['config', 'user.email', 'test@example.com'], remote);
      await execGit(['config', 'user.name', 'Test'], remote);
      await execGit(['commit', '--allow-empty', '-m', 'new remote default'], remote);
      shippedDefault = (await execGit(['rev-parse', 'HEAD'], remote)).stdout.trim();
      expect((await execGit(['cat-file', '-e', `${shippedDefault}^{commit}`], repo, { ignoreExitCode: true })).exitCode).not.toBe(0);
      await execGit(['remote', 'add', 'origin', 'https://github.com/example/repo.git'], repo);
      injected.fetchRemote = remote;
    }
    await execGit(['reset', '--hard', 'HEAD^'], repo);
    const localMain = (await execGit(['rev-parse', 'main'], repo)).stdout.trim();
    c.forge.defaultHead = localMain;
    expect(await c.prepare()).toMatchObject({ ok: false, reason: 'retirement-policy-not-legacy-completed' });
    c.forge.defaultHead = shippedDefault;
    injected.policies[0].result.validationPassed = false;
    expect(await c.prepare()).toMatchObject({ ok: false, reason: 'retirement-policy-not-legacy-completed' });
    injected.policies[0].result.validationPassed = null;
    const prepared = await c.prepare();
    expect(prepared).toMatchObject({ ok: true, review: { comparison: { disposition: 'integrated', difference: '' },
      policy: { integratedCleanupHead: shippedDefault } } });
    const result = await c.confirm(prepared.review);
    expect(result).toMatchObject({ ok: true, branchDeleted: true });
    expect(result.archiveDir).toBeUndefined();
    expect(await registered(c.path)).toBe(false);
    expect((await execGit(['rev-parse', 'main'], repo)).stdout.trim()).toBe(localMain);
    expect(await archives()).toEqual([]);
    expect((await getBranchReconcileOutcome('app-1')).retired).toContainEqual(expect.objectContaining({
      branch: c.release.branch, head: c.release.head, archiveDir: null, branchDeleted: true,
    }));
    expect(injected.fetches).toHaveLength(missingProof ? 1 : 0);
  });

  it.each(['complete', 'owner-reacquired', 'identity-changed'])('recovers retained merged claims through persisted retirement: %s', async scenario => {
    external = join(repo, '.claude', 'worktrees');
    await mkdir(external, { recursive: true });
    const c = await reviewedCheckout('claim-issue-425', { normalMerge: true });
    await execGit(['branch', '-m', c.release.branch, 'claim/issue-425'], repo);
    await execGit(['worktree', 'unlock', c.path], repo);
    await execGit(['restore', 'initial.txt'], c.path);
    await mkdir(join(c.admin, 'info'), { recursive: true });
    await writeFile(join(c.admin, 'info', 'exclude'), 'private fixture exclusion note\n');
    expect((await execGit(['status', '--porcelain'], c.path)).stdout).toBe('');
    const release = { ...c.release, branch: 'claim/issue-425', locked: false, lockReason: null,
      checkoutIdentity: await readRetirementCheckoutIdentity(c.path) };
    injected.policies[0].metadata.claimBranches = [release.branch];
    injected.policies[0].result = { success: false, executionSuccess: true,
      taskOutcome: { status: 'incomplete', recovery: { mode: 'cleanup' } } };
    const merged = { branch: release.branch, tip: release.head, worktreePath: release.path,
      state: 'MERGED', isMerged: true, worktreeAgeMs: 0, worktreeLocked: false };
    const { cleanupMerged } = await import('./branchReconcile.js');
    const initial = await cleanupMerged(repo, 'main', [merged], { appId: 'app-1', activeAgentIds: new Set(),
      claimOwners: { agents: [], readAgents: noOwners } });
    expect(initial).toMatchObject({ cleaned: [], skipped: [{ branch: release.branch, reason: 'claim-completion-unverified' }] });
    const remaining = [{ ...release, reason: 'claim-completion-unverified' }];
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining });
    const { prepareReconcileRetirements } = await import('./branchReconcileRetirement.js');
    const input = { wip: [], merged: [merged], skipped: initial.skipped,
      worktreeInventory: [{ ...release, managed: true }] };
    const result = await prepareReconcileRetirements(injected.app, input, {
      readPr: async () => c.forge.prUrl,
      prepare: async request => {
        const reviewed = await prepareInventoriedCheckoutRetirement(request, c.opts);
        if (scenario === 'owner-reacquired') c.opts.readAgents = async () => [{ id: 'new-owner', status: 'running',
          metadata: { sourceWorkspace: repo, workspacePath: c.path, worktreeBranch: release.branch } }];
        if (scenario === 'identity-changed') {
          const pointer = await readFile(join(c.path, '.git'));
          await rename(join(c.path, '.git'), join(c.path, '.git.previous')); await writeFile(join(c.path, '.git'), pointer);
        }
        return reviewed;
      },
      // Model the daemon's admitted mutation callback; exercise the actual
      // inventory, policy, owner, archive, removal and persisted-receipt gates.
      retire: (request, options) => retireInventoriedCheckout(request, { ...c.opts, ...options, beforeMutation: async () => {} }),
    });
    const outcome = await getBranchReconcileOutcome('app-1');
    if (scenario !== 'complete') {
      expect(result).toMatchObject({ retired: [], held: [{ reason: scenario === 'owner-reacquired' ? 'claim-owner-active' : 'checkout-identity-changed' }] });
      expect(await registered(c.path)).toBe(true);
      expect(outcome.retired || []).toEqual([]);
      return;
    }
    expect(result).toMatchObject({ candidates: [], held: [], retired: [expect.objectContaining({ checkoutIdentity: release.checkoutIdentity })] });
    expect(await registered(c.path)).toBe(false);
    const receipt = outcome.retired.find(row => row.branch === release.branch);
    expect(receipt).toMatchObject({ head: release.head, branchDeleted: true, archiveDir: null, checkoutIdentity: release.checkoutIdentity });
    expect(await archives()).toEqual([]);
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
    expect(result.archiveDir).toBeUndefined();
    expect(await registered(release.path)).toBe(false);
    expect(await archives()).toEqual([]);
    expect((await execGit(['cat-file', '-t', release.head], repo)).stdout.trim()).toBe('commit');
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
    expect(result).toMatchObject({ ok: true, branchDeleted: true });
    expect(result.archiveDir).toBeUndefined();
    expect(existsSync(c.path)).toBe(false);
    expect(await archives()).toEqual([]);
    expect((await getBranchReconcileOutcome('app-1')).retired).toContainEqual(expect.objectContaining({
      path: c.release.path, branch: c.release.branch, head: c.release.head, archiveDir: null, branchDeleted: true,
    }));
    for (const oid of [old, next, fetched]) expect((await execGit(['cat-file', '-t', oid], repo)).stdout.trim()).toBe('commit');
    expect((await execGit(['cat-file', '-e', absent], repo, { ignoreExitCode: true })).exitCode).not.toBe(0);
  });

  it('retires a freshly reviewed reused-branch incarnation with a standalone archive and exact receipt', async () => {
    const c = await reviewedCheckout('quality-reused', { gitlink: true });
    reusedBranchOwners(c);
    const shared = join(scratch, 'shared-dependencies');
    await mkdir(shared);
    await writeFile(join(shared, 'untouched'), 'shared installation\n');
    if (SYMLINKS) {
      for (const relative of ['node_modules', 'server/node_modules', 'client/node_modules', 'autofixer/node_modules']) {
        await mkdir(dirname(join(c.path, relative)), { recursive: true });
        await symlink(shared, join(c.path, relative), 'dir');
      }
    }
    const policiesBefore = structuredClone(injected.policies);
    const prepared = await c.prepare();
    expect(prepared).toMatchObject({ ok: true, review: { policy: {
      policies: [{ id: 'current-review-owner' }], reviewedPr: { tip: c.release.head, prUrl: c.forge.prUrl },
    } } });
    expect(prepared.review.policy.priorCheckouts).toHaveLength(33);
    expect(prepared.review.comparison.localPatch).toContain('original feature');
    const result = await c.confirm(prepared.review);
    expect(result).toMatchObject({ ok: true, branchDeleted: true });
    expect(result.archiveDir).toBeUndefined();
    expect(existsSync(c.path)).toBe(false);
    expect(await registered(c.release.path)).toBe(false);
    expect((await execGit(['show-ref', '--verify', '--quiet', `refs/heads/${c.release.branch}`], repo, { ignoreExitCode: true })).exitCode).not.toBe(0);
    expect((await getBranchReconcileOutcome('app-1')).retired).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: c.release.path, branch: c.release.branch, head: c.release.head,
        archiveDir: null, branchDeleted: true }),
    ]));
    expect(injected.policies).toEqual(policiesBefore);
    expect(await archives()).toEqual([]);
    expect(await readFile(join(shared, 'untouched'), 'utf8')).toBe('shared installation\n');
  });

  it.each(['head-mismatch', 'same-checkout-failed', 'ambiguous-history', 'current-manual', 'current-active', 'checkout-alias', 'primary-alias'])(
    'keeps the full original checkout when reused-branch proof changes: %s', async change => {
      const c = await reviewedCheckout('quality-held', { ignoredPayload: true });
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

  it('preserves the checkout and inventory when private administration is recreated behind an unchanged Git pointer', async () => {
    const c = await reviewedCheckout('replaced-administration', { ignoredPayload: true });
    await writeFile(join(c.path, 'untracked.txt'), 'untracked work\n');
    const { readCompletedCheckoutIdentity } = await import('./completedCheckoutEvidence.js');
    const identity = await readCompletedCheckoutIdentity({ repoPath: repo, ...c.release, allowLocked: true });
    expect(identity).not.toBeNull();
    const checkoutIdentity = await readRetirementCheckoutIdentity(c.path);
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...c.release,
      checkoutIdentity, checkoutIncarnation: identity.incarnation, reason: 'retirement-review-pending' }] });
    const before = await getBranchReconcileOutcome('app-1');
    const prepared = await c.prepare();
    expect(prepared.ok).toBe(true); // Tuple-only clients use the stored full identity.
    const pointer = await readFile(join(c.path, '.git'));
    const index = await readFile(join(c.admin, 'index'));
    const tracked = await readFile(join(c.path, 'initial.txt'));
    const preserved = join(scratch, 'preserved-administration');
    await rename(c.admin, preserved);
    await cp(preserved, c.admin, { recursive: true });
    expect((await execGit(['worktree', 'list', '--porcelain'], repo)).stdout.split('\n')
      .filter(line => line === `branch refs/heads/${c.release.branch}`)).toHaveLength(1);
    expect(await readRetirementCheckoutIdentity(c.path)).toBe(checkoutIdentity);
    expect(await c.prepare()).toMatchObject({ ok: false, reason: 'checkout-identity-changed' });
    expect(await c.confirm(prepared.review)).toMatchObject({ ok: false, reason: 'checkout-identity-changed' });
    expect(await readFile(join(c.path, '.git'))).toEqual(pointer);
    expect(await readFile(join(c.admin, 'index'))).toEqual(index);
    expect(await readFile(join(c.path, 'initial.txt'))).toEqual(tracked);
    expect(await readFile(join(preserved, 'index'))).toEqual(index);
    expect(await readFile(join(c.admin, 'portos-review-status'), 'utf8')).toBe('private synthetic review marker');
    expect(await readFile(join(c.path, 'ignored.txt'), 'utf8')).toBe('ignored work\n');
    expect(await readFile(join(c.path, 'untracked.txt'), 'utf8')).toBe('untracked work\n');
    expect(await lockText(c.path)).toBe(c.release.lockReason);
    expect((await execGit(['rev-parse', `refs/heads/${c.release.branch}`], repo)).stdout.trim()).toBe(c.release.head);
    expect(await registered(c.path)).toBe(true);
    expect(await archives()).toEqual([]);
    const after = await getBranchReconcileOutcome('app-1');
    expect(after.remaining).toEqual(before.remaining);
    expect(after.retired).toEqual(before.retired);
    expect(after.retirementObligations).toEqual(before.retirementObligations);
  });

  describe.each(['content', 'index', 'administration', 'default', 'pr-head', 'forge', 'policy', 'unreadable-policy', 'submodule', 'inventory'])('changed %s evidence between review and confirmation', change => {
    let c;
    let prepared;
    // Fixture construction, preview and confirmation are distinct real-Git
    // workflows; each retains the existing 30-second phase budget.
    beforeEach(async () => {
      c = await reviewedCheckout('changed-review', { gitlink: true });
    });
    beforeEach(async () => {
      prepared = await c.prepare();
      expect(prepared.ok).toBe(true);
    });
    it('refuses confirmation and retains the checkout, lock and archive state', async () => {
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
  });

  it.each(['running', 'paused'])('refuses a %s owner that arrives after preparation', async status => {
    const c = await reviewedCheckout('owner-review');
    const prepared = await c.prepare();
    const result = await c.confirm(prepared.review, { readAgents: async () => [{ id: 'agent-live', status,
      metadata: { workspacePath: repo, claimBranches: [c.release.branch] } }] });
    expect(result).toMatchObject({ ok: false, reason: 'claim-owner-active' });
    expect(await registered(c.release.path)).toBe(true);
  });

  it.each(['confirmed', 'unconfirmed', 'human-handoff', 'active-owner', 'changed-default', 'changed-source'])('reviews source-superseded local work through the existing archive fence: %s', async scenario => {
    const c = await reviewedCheckout(`source-${scenario}`, { superseded: scenario !== 'unconfirmed' });
    c.forge.prHead = c.forge.firstCommit = c.forge.mergeCommit;
    c.forge.changeBase = (await execGit(['rev-parse', `${c.forge.firstCommit}^`], repo)).stdout.trim();
    c.forge.sourceSupersessionHead = c.release.head;
    const prepare = () => prepareInventoriedCheckoutRetirement({ appId: 'app-1', release: c.release,
      prUrl: c.forge.prUrl, kind: 'source-supersession' }, c.opts);
    if (scenario === 'human-handoff') injected.policies[0].metadata.prCompletionPolicy = 'leave-open';
    if (scenario === 'active-owner') c.opts.readAgents = async () => [{ id: 'live', status: 'running', metadata: { workspacePath: repo, claimBranches: [c.release.branch] } }];
    const prepared = await prepare();
    if (['human-handoff', 'active-owner'].includes(scenario)) {
      expect(prepared.ok).toBe(false);
      expect(await archives()).toEqual([]);
      expect(await registered(c.path)).toBe(true);
      return;
    }
    expect(prepared).toMatchObject({ ok: true, review: { kind: 'source-supersession',
      forge: { sourceSupersessionHead: c.release.head }, comparison: { disposition: 'review-supersession' } } });
    if (scenario === 'changed-source') await writeFile(join(c.path, 'ignored.txt'), 'new local work\n');
    if (scenario === 'changed-default') {
      await writeFile(join(repo, 'later.txt'), 'new default\n');
      await execGit(['add', 'later.txt'], repo);
      await execGit(['commit', '-m', 'later default'], repo);
      c.forge.defaultHead = (await execGit(['rev-parse', 'HEAD'], repo)).stdout.trim();
    }
    const result = await retireInventoriedCheckout({ appId: 'app-1', release: c.release, review: {
      prUrl: c.forge.prUrl, digest: prepared.review.digest, kind: 'source-supersession', acceptSuperseded: scenario !== 'unconfirmed',
    } }, c.opts);
    if (scenario !== 'confirmed') {
      expect(result).toMatchObject({ ok: false, reason: scenario === 'unconfirmed' ? 'retirement-supersession-not-accepted' : 'retirement-review-changed' });
      expect(await registered(c.path)).toBe(true);
      expect(await archives()).toEqual([]);
      return;
    }
    expect(result).toMatchObject({ ok: true, branchDeleted: true });
    expect(result.archiveDir).toBeUndefined();
    expect(await registered(c.path)).toBe(false);
    expect(await archives()).toEqual([]);
    expect((await getBranchReconcileOutcome('app-1')).retired).toEqual(expect.arrayContaining([expect.objectContaining({ head: c.release.head, archiveDir: null })]));
    expect((await execGit(['show', `${c.release.head}:feature.txt`], repo)).stdout).toBe('original feature\n');
  });

  it.each(['confirmed', 'human-handoff', 'published-owner'])('reviews an exact merged detached checkout without borrowing branch retirement: %s', async scenario => {
    const c = await reviewedCheckout(`detached-review-${scenario}`);
    const publishedBranch = c.release.branch;
    await execGit(['switch', '--detach', c.release.head], c.path);
    c.release.branch = null;
    c.forge.publishedBranch = publishedBranch;
    c.forge.exactAliasHead = c.release.head;
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...c.release, reason: 'worktree-unmanaged-location' }] });
    if (scenario === 'human-handoff') injected.policies[0].metadata.prCompletionPolicy = 'leave-open';
    if (scenario === 'published-owner') c.opts.readAgents = async () => [{ id: 'live', status: 'running', metadata: { workspacePath: repo, claimBranches: [publishedBranch] } }];
    const prepared = await c.prepare();
    if (scenario !== 'confirmed') {
      expect(prepared.ok).toBe(false);
      expect(await registered(c.path)).toBe(true);
      expect(await archives()).toEqual([]);
      return;
    }
    expect(prepared.ok).toBe(true);
    const result = await c.confirm(prepared.review);
    expect(result).toMatchObject({ ok: true, branchDeleted: false });
    expect(result.archiveDir).toBeUndefined();
    expect(await registered(c.path)).toBe(false);
    expect((await execGit(['rev-parse', publishedBranch], repo)).stdout.trim()).toBe(c.release.head);
    expect(await archives()).toEqual([]);
  });

  it.each(['confirmed', 'owner-alias', 'missing-receipt', 'same-incarnation', 'human-handoff', 'active-owner', 'normal-completed', 'normal-invalid-time', 'normal-resumed-lineage'])('keeps an original sibling obligation separate from a detached copy: %s', async scenario => {
    const c = await reviewedCheckout(`orphan-sibling-${scenario}`);
    const namedPath = c.path;
    const namedBranch = c.release.branch;
    await execGit(['worktree', 'unlock', namedPath], repo);
    const evidence = await import('./completedCheckoutEvidence.js');
    const agent = { id: 'sibling-owner', status: 'running', startedAt: new Date(Date.now() - 60_000).toISOString(),
      metadata: { sourceWorkspace: repo, workspacePath: namedPath, isWorktree: true, worktreeBranch: namedBranch,
        prCompletionPolicy: 'review-then-merge', reviewLoopMergeTarget: { url: c.forge.prUrl, branch: namedBranch } } };
    agent.metadata.checkoutSeeds = await evidence.captureCheckoutSeeds(agent);
    // Completion records the exact terminal target before publishing the orphan.
    const targets = await evidence.captureSeededCompletionCheckouts(agent, { preterminal: true });
    expect(targets).toEqual([expect.objectContaining({ head: c.release.head, startedAt: agent.startedAt })]);
    agent.metadata.checkoutCapture = { status: 'captured', targets, unknown: false };
    agent.status = 'completed'; agent.completedAt = new Date().toISOString();
    agent.result = { success: false, executionSuccess: false, orphaned: true, validationPassed: null };
    agent.metadata.completedCheckouts = await evidence.captureSeededCompletionCheckouts(agent);
    expect(agent.metadata.completedCheckouts).toHaveLength(1);
    if (scenario.startsWith('normal-')) {
      agent.result = { success: false, executionSuccess: true, validationPassed: true, cleanupPending: true,
        taskOutcome: { status: 'incomplete', recovery: { mode: 'cleanup' } } };
      agent.metadata.completedCheckouts = agent.metadata.completedCheckouts.map(row => ({ ...row, version: 1,
        capturedAt: scenario === 'normal-invalid-time' ? new Date(Date.parse(agent.completedAt) + 1000).toISOString() : agent.completedAt }));
    }
    const originalResult = structuredClone(agent.result);
    if (scenario === 'owner-alias') {
      const alias = join(external, 'canonical-owner-alias');
      await symlink(namedPath, alias, 'junction');
      agent.metadata.workspacePath = alias;
    }
    let path = join(external, `detached-${scenario}`);
    if (scenario === 'same-incarnation') {
      const pointerIdentity = await readRetirementCheckoutIdentity(namedPath);
      await execGit(['worktree', 'move', namedPath, path], repo);
      await execGit(['switch', '--detach', c.release.head], path);
      expect(await readRetirementCheckoutIdentity(path)).toBe(pointerIdentity);
    }
    else {
      await execGit(['worktree', 'add', '--detach', path, c.release.head], repo);
    }
    // Real inventories use Git's observed spelling. Windows temp paths can
    // differ from that registration (including short names and drive casing).
    path = (await execGit(['rev-parse', '--show-toplevel'], path)).stdout.trim();
    expect(await registered(path)).toBe(true);
    const release = { path, branch: null, head: c.release.head, locked: false, lockReason: null };
    c.forge.publishedBranch = namedBranch; c.forge.exactAliasHead = release.head;
    injected.policies = [agent];
    let lineageControls = [];
    if (scenario === 'normal-resumed-lineage') {
      agent.taskId = 'original-cleanup-task';
      const ancestors = ['failed-first', 'failed-second'].map((id, index) => {
        const startedAt = new Date(Date.parse(agent.startedAt) - (2 - index) * 60_000).toISOString();
        const completedAt = new Date(Date.parse(startedAt) + 1000).toISOString();
        const workspacePath = join(external, id);
        return { id, taskId: agent.taskId, status: 'completed', startedAt, completedAt,
          result: { success: false, executionSuccess: false, validationPassed: null },
          metadata: { sourceWorkspace: repo, workspacePath, worktreeBranch: namedBranch,
            prCompletionPolicy: 'review-then-merge', reviewLoopMergeTarget: { branch: namedBranch, url: c.forge.prUrl },
            resumedFromAgentId: index ? 'failed-first' : null,
            completedCheckouts: [{ ...agent.metadata.completedCheckouts[0], version: 1, agentId: id,
              startedAt, capturedAt: completedAt, path: workspacePath }] } };
      });
      agent.metadata.resumedFromAgentId = 'failed-second';
      injected.policies = [...ancestors, agent];
      const differentGeneration = structuredClone(agent.metadata.completedCheckouts[0].incarnation);
      differentGeneration.pointer.ino = String(BigInt(differentGeneration.pointer.ino) + 1n);
      lineageControls = [[ancestors[0], 'taskId', 'unrelated-task'],
        [ancestors[0].metadata.completedCheckouts[0], 'incarnation', differentGeneration],
        [ancestors[0].metadata, 'prCompletionPolicy', 'leave-open'], [ancestors[0], 'status', 'running']];
    }
    if (scenario === 'missing-receipt') agent.metadata.completedCheckouts = [];
    if (scenario === 'human-handoff') agent.metadata.prCompletionPolicy = 'leave-open';
    if (scenario === 'active-owner') { agent.status = 'running'; c.opts.readAgents = async () => [agent]; }
    const originalRelease = scenario === 'normal-resumed-lineage'
      ? { ...c.release, locked: false, lockReason: null, checkoutIdentity: await readRetirementCheckoutIdentity(namedPath) } : null;
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [
      ...(scenario === 'normal-resumed-lineage' ? [{ ...originalRelease, reason: 'retirement-receipt-unverified' }] : []),
      { ...release, reason: 'worktree-unmanaged-location' },
    ] });
    const originalPolicies = structuredClone(injected.policies);
    for (const [target, key, value] of lineageControls) {
      const prior = target[key]; target[key] = value;
      const refused = await prepareInventoriedCheckoutRetirement({ appId: 'app-1', release, prUrl: c.forge.prUrl }, c.opts);
      expect(refused, `${key}: ${JSON.stringify(refused)}`).toMatchObject({ ok: false });
      expect(await registered(path)).toBe(true); expect(await registered(namedPath)).toBe(true);
      target[key] = prior;
    }
    const prepared = await prepareInventoriedCheckoutRetirement({ appId: 'app-1', release, prUrl: c.forge.prUrl }, c.opts);
    if (!['confirmed', 'owner-alias', 'normal-completed', 'normal-resumed-lineage'].includes(scenario)) {
      const reason = scenario === 'human-handoff' ? 'pr-completion-human-handoff'
        : 'retirement-policy-not-legacy-completed';
      expect(prepared).toMatchObject({ ok: false, reason });
      expect(await registered(path)).toBe(true); expect(await archives()).toEqual([]);
      return;
    }
    expect(prepared.reason).toBeUndefined();
    if (scenario === 'normal-resumed-lineage') {
      const detachedIdentity = await readRetirementCheckoutIdentity(path);
      expect(prepared).toMatchObject({ ok: true, review: { policy: { policies: [
        { id: 'failed-first', success: false, resumedCleanup: { successorAgentId: agent.id, detachedCheckoutIdentity: detachedIdentity,
          checkoutIncarnation: agent.metadata.completedCheckouts[0].incarnation } },
        { id: 'failed-second', success: false, resumedCleanup: { successorAgentId: agent.id, detachedCheckoutIdentity: detachedIdentity } },
        { id: agent.id, success: false, completedSibling: true },
      ] } } });
    }
    else expect(prepared).toMatchObject({ ok: true, review: { policy: { policies: [{ success: false, ...(scenario === 'normal-completed' ? { completedSibling: true } : { orphanedSibling: true }) }] } } });
    const result = await retireInventoriedCheckout({ appId: 'app-1', release,
      review: { prUrl: c.forge.prUrl, digest: prepared.review.digest, acceptSuperseded: false } }, c.opts);
    expect(result).toMatchObject({ ok: true, branchDeleted: false });
    expect(result.archiveDir).toBeUndefined();
    expect(await registered(path)).toBe(false);
    expect(await registered(namedPath)).toBe(true);
    expect((await execGit(['rev-parse', namedBranch], repo)).stdout.trim()).toBe(release.head);
    expect(agent.result).toEqual(originalResult);
    expect(injected.policies).toEqual(originalPolicies);
    if (scenario === 'normal-resumed-lineage') {
      const outcome = await getBranchReconcileOutcome('app-1');
      expect(outcome.remaining).toContainEqual(expect.objectContaining({ path: namedPath, branch: namedBranch, reason: 'retirement-receipt-unverified' }));
      const copyReceipt = outcome.retired.find(row => row.path === path);
      expect(copyReceipt).toMatchObject({ head: release.head, branchDeleted: false,
        checkoutIdentity: prepared.review.policy.policies.find(row => row.id === agent.id).detachedCheckoutIdentity });
      expect(copyReceipt.branch ?? null).toBeNull();
      expect(outcome.retired.some(row => row.path === namedPath)).toBe(false);
    }
    expect(await archives()).toEqual([]);
  });

  it('preserves archive and checkout when fresh forge evidence changes after archiving', async () => {
    const c = await reviewedCheckout('late-forge');
    const prepared = await c.prepare();
    let reads = 0;
    const result = await c.confirm(prepared.review, { readForge: async () => ({ ...c.forge, remoteHead: ++reads === 1 ? null : c.release.head }) });
    expect(result).toMatchObject({ ok: false, reason: 'retirement-review-changed' });
    expect(result.archiveDir).toBeUndefined();
    expect(await readFile(join(c.path, 'feature.txt'), 'utf8')).toBe('original feature\n');
    expect(await archives()).toEqual([]);
    expect(await registered(c.release.path)).toBe(true);
    expect(await lockText(c.release.path)).toBe(c.release.lockReason);
  });

});
