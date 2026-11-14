/**
 * Per-case fixture for the real-Git held-checkout retirement suite
 * (heldCheckoutRecovery.test.js): a fresh Git repository per case, the owned
 * fixture-work lifecycle, and the checkout builders. Not a test file itself: it
 * only registers hooks and exports helpers.
 *
 * Import it only after the suite has declared the _heldCheckoutRecoveryMocks.js
 * `vi.mock` set; its own imports must resolve to those mocks. The per-case
 * bindings (`repo`, `external`, ...) are exported live.
 */
import { describe, it as vitestIt, beforeEach as vitestBeforeEach, afterEach, afterAll } from 'vitest';
import { cp, mkdtemp, mkdir, rm, writeFile, symlink } from 'fs/promises';
import { realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execGit } from '../lib/execGit.js';
import { materializeGitRepo, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';
import { cleanupTempDataRoots, lazyTempDataRoot } from '../lib/mockPathsDataRoot.js';
import { owned, retirementFaults, injected, SYMLINKS } from './_heldCheckoutRecoveryMocks.js';
import { retireInventoriedCheckout } from './heldCheckoutRecovery.js';
import { recordBranchReconcileOutcome } from './branchReconcileOutcome.js';

export const it = owned.tests(vitestIt);
export const beforeEach = (body, ...options) => vitestBeforeEach(owned.wrap('setup', body), ...options);

export let scratch;
export let repo;
export let external;
export let cosDir;
let pristineRepo;
export const noOwners = async () => [];

/** Registers the suite's file hooks and its real-Git describe. */
export function describeHeldCheckoutRecovery(body) {
  vitestBeforeEach(() => owned.prepare());
  afterAll(() => owned.finish(cleanupTempDataRoots));
  describe.skipIf(SKIP_HEAVY_INTEGRATION)('held checkout retirement (real git)', () => {
    beforeEach(async () => {
      scratch = null;
      Object.assign(retirementFaults, { onRemove: null, onBranchDelete: null, scheduleWrites: 0, failScheduleWrite: null });
      Object.assign(injected, { policies: [], schedule: { tasks: {}, executions: {} }, app: { id: 'app-1', repoPath: null }, onUnlockedStatus: null, statusReads: 0, onOtherFiles: null });
      scratch = realpathSync(await mkdtemp(join(tmpdir(), 'portos-held-checkout-')));
      const safeRepo = join(scratch, 'repo');
      await mkdir(safeRepo);
      if (!pristineRepo) {
        const seed = join(lazyTempDataRoot('portos-held-pristine-'), 'repo');
        await mkdir(seed);
        await materializeGitRepo(seed, { identity: { email: 'test@example.com', name: 'Test' } });
        pristineRepo = seed;
      }
      await cp(pristineRepo, safeRepo, { recursive: true });
      repo = (await execGit(['rev-parse', '--show-toplevel'], safeRepo)).stdout.trim() || safeRepo;
      external = join(scratch, 'elsewhere');
      cosDir = join(scratch, 'cos');
      await mkdir(external);
      injected.app.repoPath = repo;
    });
    afterEach(({ task, signal }) => owned.cleanup(async () => {
      const failed = Boolean(task.result?.errors?.length || signal.aborted);
      // CI's quiet setup replaces console methods, including on failed tests.
      const fixtureReport = () => process.stderr.write(`⏱️ retirement fixture: ${owned.summary()}\n`);
      if (failed) fixtureReport();
      // Vitest's deadline rejects its wrapper, not the async fixture. Never erase
      // the repo while removal work from this exact case is running.
      await owned.drain();
      if (scratch) {
        try { await owned.run('scratch-removal', () => rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); }
        catch (error) { await owned.drain(); fixtureReport(); throw error; }
      }
    }));
    body();
  });
}

/** A locked checkout outside the managed roots holding unique uncommitted work. */
export async function heldCheckout(name, { branch = null, lockReason = 'synthetic external owner', beforeLock } = {}) {
  const path = join(external, name);
  await execGit(['worktree', 'add', ...(branch ? ['-b', branch, path] : ['--detach', path]), 'main'], repo);
  await writeFile(join(path, '.gitignore'), 'ignored.txt\nlinked\n');
  await writeFile(join(path, 'initial.txt'), 'tracked edit\n');
  await writeFile(join(path, 'untracked.txt'), 'untracked work\n');
  await writeFile(join(path, 'ignored.txt'), 'ignored work\n');
  // Windows runners may lack symlink privilege; the retirement contract is the same.
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

/**
 * A clean checkout of `feature/<name>` whose single commit main already holds:
 * fast-forwarded (`merge: 'ff'`), squash-merged (`'squash'`), or not merged at
 * all (`'none'`). The persisted inventory row is held for completion review.
 */
export async function mergedCheckout(name, { merge = 'ff', locked = false } = {}) {
  const branch = `feature/${name}`;
  const path = join(external, name);
  await execGit(['worktree', 'add', '-b', branch, path, 'main'], repo);
  await writeFile(join(path, 'feature.txt'), `${name}\n`);
  await execGit(['add', 'feature.txt'], path);
  await execGit(['commit', '-m', `feat: ${name}`], path);
  if (merge === 'ff') await execGit(['merge', '--ff-only', branch], repo);
  if (merge === 'squash') {
    await execGit(['merge', '--squash', branch], repo);
    await execGit(['commit', '-m', `feat: ${name} (squash)`], repo);
  }
  if (locked) await execGit(['worktree', 'lock', '--reason', 'synthetic external owner', path], repo);
  const [gitPath, head] = (await Promise.all([
    execGit(['rev-parse', '--show-toplevel'], path), execGit(['rev-parse', 'HEAD'], path),
  ])).map(result => result.stdout.trim());
  const release = { path: gitPath, head, branch, locked, lockReason: locked ? 'synthetic external owner' : null };
  await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...release, reason: 'pr-completion-review-required' }] });
  return { path: gitPath, release };
}

// Git emits forward slashes on Windows even when the fixture uses native paths.
export const registered = async (path) => (await execGit(['worktree', 'list', '--porcelain'], repo)).stdout
  .split(/\r?\n/).includes(`worktree ${path.replaceAll('\\', '/')}`);
export const lockText = async (path) => (await execGit(['worktree', 'list', '--porcelain'], repo)).stdout
  .split(/\r?\n\r?\n/).find(block => block.split(/\r?\n/)[0] === `worktree ${path.replaceAll('\\', '/')}`)?.match(/^locked ?(.*)$/m)?.[1] ?? null;
/** The operator confirms a row the last sweep persisted. */
export async function retire(release, opts = {}) {
  await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...release, reason: 'worktree-locked' }] });
  return retireInventoriedCheckout({ appId: 'app-1', release }, { readAgents: noOwners, ...opts });
}
export const makeClean = async (path) => {
  await execGit(['checkout', '--', '.'], path);
  await execGit(['clean', '-fdx'], path);
};

export async function supersededCheckout({ clean = false } = {}) {
  const { release } = await heldCheckout('superseded', { branch: 'feature/superseded' });
  await rm(join(release.path, 'ignored.txt'));
  await execGit(['worktree', 'unlock', release.path], repo);
  if (clean) {
    await execGit(['reset', '--hard'], release.path);
    await execGit(['clean', '-fdx'], release.path);
  } else {
    await execGit(['add', 'initial.txt'], release.path);
    await writeFile(join(release.path, 'initial.txt'), 'unstaged original work\n');
  }
  const gitdir = (await execGit(['rev-parse', '--absolute-git-dir'], release.path)).stdout.trim();
  await writeFile(join(gitdir, 'private-note'), 'private administration');
  const dirtyPaths = (await execGit(['status', '--porcelain'], release.path)).stdout.trimEnd().split('\n').filter(Boolean).map(line => line.slice(3));
  const entry = { branch: release.branch, tip: release.head, worktreePath: release.path, worktreeLocked: false,
    worktreeAgeMs: 365 * 86400000, dirtyPaths,
    verdict: { branch: release.branch, tip: release.head, verdict: 'SUPERSEDED', dirtyPaths } };
  return { entry, release: { ...release, locked: false, lockReason: null } };
}
export const reapSuperseded = async (entry, readAgents = noOwners) => (await import('./branchReconcile.js')).reapSupersededBranches(repo, 'main', [entry], {
  appId: 'app-1', cosDir, claimOwners: { agents: [], readAgents },
});
