/**
 * Scoped retirement of held checkouts through real Git (#12002): a release
 * binds to the exact inventory row, every unique byte is archived before any
 * mutation, and an ownership change or archive failure leaves the checkout,
 * its lock and its branch as found.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, symlink, utimes } from 'fs/promises';
import { existsSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execGit } from '../lib/execGit.js';
import { materializeGitRepo, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';

const SYMLINKS = process.platform !== 'win32';
const injected = vi.hoisted(() => ({ policies: [], schedule: null, app: null, fetchRemote: null, fetches: [] }));

vi.mock('../lib/execGit.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, execGit: (args, cwd, options) => {
    if (args.includes('credential.helper=!gh auth git-credential') && args.includes('fetch')) {
      injected.fetches.push({ args, options });
      if (injected.fetchRemote) args = args.map(arg => arg === 'https://github.com/example/repo.git' ? injected.fetchRemote : arg);
    }
    return actual.execGit(args, cwd, options);
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
  updateSchedule: async (mutate) => (await mutate(injected.schedule)).result,
}));
vi.mock('./apps.js', () => ({ getAppById: async (id) => (injected.app?.id === id ? injected.app : null) }));

const { retireInventoriedCheckout, prepareInventoriedCheckoutRetirement, retirePendingMergeCheckout, heldCheckoutArchiveRoot, preserveMergedCheckout } = await import('./heldCheckoutRecovery.js');
const { recordBranchReconcileOutcome, getBranchReconcileOutcome } = await import('./taskSchedule.js');

describe.skipIf(SKIP_HEAVY_INTEGRATION)('held checkout recovery (real git)', () => {
  let scratch;
  let repo;
  let external;
  let cosDir;
  const noOwners = async () => [];

  beforeEach(async () => {
    Object.assign(injected, { policies: [], schedule: { executions: {} }, app: { id: 'app-1', repoPath: null }, fetchRemote: null, fetches: [] });
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
    return { path, release: { path: gitPath, head, branch, locked: true, lockReason } };
  }

  const registered = async (path) => (await execGit(['worktree', 'list', '--porcelain'], repo)).stdout.includes(`worktree ${path}`);
  const lockText = async (path) => (await execGit(['worktree', 'list', '--porcelain'], repo)).stdout
    .split('\n\n').find(block => block.startsWith(`worktree ${path}\n`))?.match(/^locked ?(.*)$/m)?.[1] ?? null;
  /** The operator confirms a row the last sweep persisted. */
  async function retire(release, opts = {}) {
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...release, reason: 'worktree-locked' }] });
    return retireInventoriedCheckout({ appId: 'app-1', release }, { cosDir, readAgents: noOwners, ...opts });
  }
  const archives = async () => (existsSync(heldCheckoutArchiveRoot(cosDir)) ? readdir(heldCheckoutArchiveRoot(cosDir)) : []);

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

  it('archives a missing checkout private index and staged contents before pruning', async () => {
    const path = join(external, 'missing');
    await execGit(['worktree', 'add', '-b', 'feature/missing', path, 'main'], repo);
    await writeFile(join(path, 'staged.txt'), 'only in the private index');
    await execGit(['add', 'staged.txt'], path);
    const tree = { path, branch: 'refs/heads/feature/missing', head: (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim() };
    await rm(path, { recursive: true, force: true });
    const saved = await preserveMergedCheckout(repo, tree, 'main', { cosDir });
    expect(await readFile(join(saved.archiveDir, 'index.diff'), 'utf8')).toContain('only in the private index');
    expect(existsSync(join(saved.archiveDir, 'administration', 'gitdir', 'index'))).toBe(true);
    expect(JSON.parse(await readFile(join(saved.archiveDir, 'manifest.json'), 'utf8')).captured.missingCheckout).toBe(true);
    expect(await saved.verify(tree)).toBe(null);
    await mkdir(path);
    await expect(saved.verify(tree)).rejects.toThrow('missing-checkout-reappeared');
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

    const result = await retireInventoriedCheckout({ appId: 'app-1', release }, { cosDir, readAgents: noOwners });

    expect(result).toMatchObject({ ok: true, branchDeleted: true });
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
