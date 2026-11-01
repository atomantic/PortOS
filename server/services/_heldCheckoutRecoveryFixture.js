/**
 * Shared per-case fixture for the held-checkout recovery suites
 * (heldCheckoutRecovery.test.js, heldCheckoutRecovery.receipts.test.js,
 * heldCheckoutRecovery.siblings.test.js): a fresh real Git repository per case,
 * the owned fixture-work lifecycle, and the checkout builders the suites share.
 * Not a test file itself: it only registers hooks and exports helpers.
 *
 * Import it only from a suite that has already declared the
 * _heldCheckoutRecoveryMocks.js `vi.mock` set; its own imports must resolve to
 * those mocks. The per-case bindings (`repo`, `external`, ...) are exported
 * live, so suites read the current case's values; suites reassign them only
 * through the setters.
 */
import { describe, it as vitestIt, beforeEach as vitestBeforeEach, afterEach, afterAll } from 'vitest';
import { cp, mkdtemp, mkdir, rm, writeFile, symlink } from 'fs/promises';
import { realpathSync } from 'fs';
import { tmpdir } from 'os';
import { createHash } from 'node:crypto';
import { join } from 'path';
import { execGit } from '../lib/execGit.js';
import { materializeGitRepo, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';
import { cleanupTempDataRoots, lazyTempDataRoot } from '../lib/mockPathsDataRoot.js';
import { owned, receiptTiming, retirementFaults, injected, SYMLINKS } from './_heldCheckoutRecoveryMocks.js';
import { retireInventoriedCheckout, prepareInventoriedCheckoutRetirement, retirePendingMergeCheckout } from './heldCheckoutRecovery.js';
import { recordBranchReconcileOutcome } from './branchReconcileOutcome.js';

export const it = owned.tests(vitestIt);
export const beforeEach = (body, ...options) => vitestBeforeEach(owned.wrap('setup', body), ...options);

export let scratch;
export let repo;
export let external;
export let cosDir;
export let receiptWork;
let pristineRepo;
export const setExternal = value => (external = value);
export const setReceiptWork = value => (receiptWork = value);
export const noOwners = async () => [];

/** Registers the suite's file hooks and its describe, preserving the original test names. */
export function describeHeldCheckoutRecovery(body) {
  vitestBeforeEach(() => owned.prepare());
  afterAll(() => owned.finish(cleanupTempDataRoots));
  describe.skipIf(SKIP_HEAVY_INTEGRATION)('held checkout recovery (real git)', () => {
    beforeEach(async ({ task }) => {
      scratch = null;
      receiptWork = null;
      const resumedLineage = task.name.includes('captured completed resume lineage before retirement');
      const remoteSquash = task.name.startsWith('fetches a remote-only squash commit');
      receiptTiming.current = resumedLineage || remoteSquash || task.name.startsWith('settles a normally merged checkout before the next scan')
        ? { entryPoint: resumedLineage ? 'completed resume lineage' : remoteSquash ? 'remote squash receipt' : task.name.endsWith('cleanupMerged') ? 'cleanupMerged' : 'early reaper', started: performance.now(), phases: {} } : null;
      await receiptTiming.run('fixture-setup', async () => {
        Object.assign(retirementFaults, { onRemove: null, onBranchDelete: null, scheduleWrites: 0, failScheduleWrite: null });
        Object.assign(injected, { policies: [], schedule: { tasks: {}, executions: {} }, app: { id: 'app-1', repoPath: null }, fetchRemote: null, fetches: [], onBundle: null, onArchiveRef: null, onEvidence: null, onProof: null, proofFailures: [], onOtherFiles: null, onUnlockedStatus: null, statusReads: 0, onSnapshot: null, onPreviewEvidence: null, policyInputs: [] });
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
    });
    afterEach(({ task, signal }) => {
      return owned.cleanup(async () => {
        const report = state => {
          const trace = receiptTiming.current;
          if (!trace) return;
          const phases = Object.entries(trace.phases).map(([phase, row]) =>
            `${phase}=${Math.round(row.ms)}ms/${row.count} max=${Math.round(row.maxMs)}ms active=${row.active}`).join('; ');
          process.stderr.write(`⏱️ merged-receipt ${trace.entryPoint} ${state}: ${Math.round(performance.now() - trace.started)}ms; ${phases}\n`);
        };
        const failed = Boolean(task.result?.errors?.length || signal.aborted);
        // CI's quiet setup replaces console methods, including on failed tests.
        const fixtureReport = () => process.stderr.write(`⏱️ retirement fixture: ${owned.summary()}\n`);
        if (failed) { report('before-settlement'); fixtureReport(); }
        // Vitest's deadline rejects its wrapper, not the async fixture. Never erase
        // the repo while archive/proof/removal work from this exact case is running.
        try { await owned.drain(); await receiptWork; }
        finally {
          if (failed || process.env.PORTOS_PROFILE_HELD_RECEIPT === '1') report('settled');
          if (failed || process.env.PORTOS_PROFILE_RETIREMENT_FIXTURE === '1') fixtureReport();
          receiptTiming.current = null;
          if (scratch) {
            try { await owned.run('scratch-removal', () => rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); }
            catch (error) { await owned.drain(); fixtureReport(); throw error; }
          }
        }
      });
    });
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
export const registered = async (path) => (await execGit(['worktree', 'list', '--porcelain'], repo)).stdout
  .split(/\r?\n/).includes(`worktree ${path.replaceAll('\\', '/')}`);
export const lockText = async (path) => (await execGit(['worktree', 'list', '--porcelain'], repo)).stdout
  .split(/\r?\n\r?\n/).find(block => block.split(/\r?\n/)[0] === `worktree ${path.replaceAll('\\', '/')}`)?.match(/^locked ?(.*)$/m)?.[1] ?? null;
/** The operator confirms a row the last sweep persisted. */
export async function retire(release, opts = {}) {
  await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...release, reason: 'worktree-locked' }] });
  return retireInventoriedCheckout({ appId: 'app-1', release }, { cosDir, readAgents: noOwners, ...opts });
}
export async function addProofOrigin() {
  // Keep forge identity synthetic while default-branch discovery stays local.
  // Only the explicitly intercepted proof fetch may read the private remote.
  await execGit(['remote', 'add', 'origin', 'https://github.com/example/repo.git'], repo);
  await execGit(['update-ref', 'refs/remotes/origin/main', 'main'], repo);
  await execGit(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], repo);
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

const reviewedHistories = new Map();
export async function reviewedHistory(options) {
  const { superseded, gitlink, normalMerge, featurePath, featureBody, multipleCommits, targetBranch } = options;
  const changeBase = (await execGit(['rev-parse', 'HEAD'], repo)).stdout.trim();
  const key = JSON.stringify({ changeBase, ...options });
  if (!reviewedHistories.has(key)) {
    const history = await owned.run('history-build', async () => {
      const root = join(lazyTempDataRoot('portos-held-histories-'), createHash('sha256').update(key).digest('hex'));
      const seed = join(root, 'repo');
      await mkdir(root, { recursive: true });
      await cp(repo, seed, { recursive: true });
      if (targetBranch !== 'main') await execGit(['switch', '-c', targetBranch, 'main'], seed);
      await execGit(['switch', '-c', 'feature/history', 'main'], seed);
      await writeFile(join(seed, '.gitignore'), 'ignored.txt\nlinked\nprivate-files/\nprivate-build-output/\nnode_modules\n');
      await writeFile(join(seed, featurePath), featureBody);
      await execGit(['--literal-pathspecs', 'add', '.gitignore', featurePath], seed);
      if (gitlink) {
        await execGit(['update-index', '--add', '--cacheinfo', `160000,${changeBase},vendor`], seed);
      }
      await execGit(['commit', '-m', 'original feature'], seed);
      if (multipleCommits) {
        await writeFile(join(seed, 'second.txt'), 'second original change\n');
        await execGit(['add', 'second.txt'], seed);
        await execGit(['commit', '-m', 'second original change'], seed);
      }
      await execGit(['switch', targetBranch], seed);
      if (normalMerge) await execGit(['merge', '--ff-only', 'feature/history'], seed);
      else {
        await execGit(['merge', '--squash', 'feature/history'], seed);
        await execGit(['commit', '-m', 'shipped feature'], seed);
      }
      if (superseded) {
        await writeFile(join(seed, featurePath), 'strengthened replacement\n');
        await execGit(['commit', '-am', 'strengthen implementation'], seed);
      }
      const [main, deliveryHead, head, firstCommit] = (await execGit(['rev-parse', 'main', targetBranch,
        'feature/history', multipleCommits ? 'feature/history^' : 'feature/history'], seed)).stdout.trim().split(/\r?\n/);
      await execGit(['branch', '-D', 'feature/history'], seed);
      return { seed, main, deliveryHead, head, firstCommit, changeBase };
    });
    reviewedHistories.set(key, history);
  }
  const history = reviewedHistories.get(key);
  // Copy only immutable history, never a checkout pointer, private worktree
  // administration or proof. Every case creates its own real Git registration.
  await owned.run('history-copy', () => cp(history.seed, repo, { recursive: true, force: true }));
  return history;
}

export async function reviewedCheckout(name, { superseded = false, gitlink = false, normalMerge = false, featurePath = 'feature.txt', featureBody = 'original feature\n', multipleCommits = false, targetBranch = 'main', ignoredPayload = false, unlocked = false } = {}) {
  const { main, deliveryHead, head, firstCommit, changeBase } = await reviewedHistory({
    superseded, gitlink, normalMerge, featurePath, featureBody, multipleCommits, targetBranch,
  });
  const branch = `feature/${name}`;
  const safePath = join(external, name);
  await execGit(['worktree', 'add', '-b', branch, safePath, head], repo);
  if (ignoredPayload) await writeFile(join(safePath, 'ignored.txt'), 'ignored work\n');
  if (SYMLINKS) await symlink('../shared-target', join(safePath, 'linked'));
  if (gitlink) await mkdir(join(safePath, 'vendor'), { recursive: true });
  if (!unlocked) await execGit(['worktree', 'lock', '--reason', 'synthetic external owner', safePath], repo);
  const [path, admin] = (await execGit(['rev-parse', '--show-toplevel', '--absolute-git-dir'], safePath)).stdout.trim().split(/\r?\n/);
  // Supersession replay persists this canonical inventory tuple verbatim.
  const release = { path, head, branch, locked: !unlocked, lockReason: unlocked ? null : 'synthetic external owner' };
  await writeFile(join(admin, 'portos-review-status'), 'private synthetic review marker');
  injected.policies = [{ id: 'agent-legacy', status: 'completed', result: { success: true },
    metadata: { workspacePath: repo, claimBranches: [release.branch], prCompletionPolicy: 'review-then-merge' } }];
  await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...release, reason: 'pr-completion-review-required' }] });
  const forge = { changedPaths: [featurePath, ...(gitlink ? ['vendor'] : []), ...(multipleCommits ? ['second.txt'] : [])], changeBase, firstCommit, repository: 'github.com/example/repo', prUrl: 'https://github.com/example/repo/pull/42', prHead: release.head,
    mergeCommit: deliveryHead, defaultBranch: 'main', defaultHead: main, remoteHead: null,
    ...(targetBranch !== 'main' && { targetBranch, targetHead: deliveryHead }) };
  const opts = { cosDir, readAgents: noOwners, readForge: async () => forge };
  const prepare = () => prepareInventoriedCheckoutRetirement({ appId: 'app-1', release, prUrl: forge.prUrl }, opts);
  const confirm = (review, more = {}) => retireInventoriedCheckout({ appId: 'app-1', release,
    review: { prUrl: forge.prUrl, digest: review.digest, acceptSuperseded: superseded } }, { ...opts, ...more });
  return { path, release, admin, opts, forge, prepare, confirm };
}

export async function receiptCheckout(name, options) {
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