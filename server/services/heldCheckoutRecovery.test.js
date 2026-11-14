/**
 * Retirement of held checkouts through real Git (#12002, #16016): a release
 * binds to the exact inventory row. A merged checkout is removed in place, its
 * uncommitted files too when its PR merged at the exact head. Unmerged work,
 * live owners and manual handoffs stay, and nothing is copied.
 */
import { describe, expect, it as unitIt, vi } from 'vitest';
// Load the factories before any import below resolves a mocked module.
import { mockBranchCompletionPolicy, mockExecGit, mockPaths, mockTaskScheduleStore, injected, retirementFaults, SYMLINKS } from './_heldCheckoutRecoveryMocks.js';
import { appendFile, lstat, mkdir, readlink, symlink, writeFile, readFile } from 'fs/promises';
import { existsSync, realpathSync } from 'fs';
import { dirname, join } from 'path';
import { readRetirementCheckoutIdentity, isCurrentRetirementCheckout } from '../lib/retirementCheckoutObservation.js';
import { execGit } from '../lib/execGit.js';
import { PATHS } from '../lib/paths.js';

vi.mock('../lib/paths.js', async importOriginal => mockPaths(await importOriginal()));
vi.mock('../lib/execGit.js', async importOriginal => mockExecGit(await importOriginal()));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: async () => ({ env: { ...process.env, GH_TOKEN: 'synthetic-account-token' } }) }));
vi.mock('./branchCompletionPolicy.js', async importOriginal => mockBranchCompletionPolicy(await importOriginal()));
vi.mock('./taskScheduleStore.js', async importOriginal => mockTaskScheduleStore(await importOriginal()));
// The forge's answers: which `branch@head` pairs merged (newest last), and the
// merged-PR read behind a receipt or a contained-delivery check.
const forge = vi.hoisted(() => ({ mergedHeads: new Set(), unreadable: false, delivery: null }));
vi.mock('./git.js', async importOriginal => ({ ...await importOriginal(), resolveForgeForRepo: async () => ({ cli: 'gh', env: null }) }));
vi.mock('./prProbe.js', async importOriginal => ({ ...await importOriginal(),
  isMergedPrHead: async (_repo, branch, head) => forge.mergedHeads.has(`${branch}@${head}`),
  probePrForBranch: async (_repo, branch) => {
    if (forge.unreadable) return { readable: false, cli: 'gh', prState: null, prHead: null, prUrl: null };
    const merged = [...forge.mergedHeads].filter(key => key.startsWith(`${branch}@`)).at(-1);
    return { readable: true, cli: 'gh', prState: merged ? 'MERGED' : null, prHead: merged ? merged.slice(branch.length + 1) : null,
      prUrl: merged ? 'https://github.com/example/repo/pull/42' : null };
  } }));
vi.mock('./mergedPrEvidence.js', () => ({ readMergedPrDelivery: async () => {
  if (forge.delivery instanceof Error) throw forge.delivery;
  return forge.delivery;
} }));
vi.mock('./apps.js', () => ({ getAppById: async (id) => (injected.app?.id === id ? injected.app : null) }));

import { describeHeldCheckoutRecovery, it, beforeEach, scratch, repo, external, noOwners, heldCheckout, mergedCheckout, registered, lockText, retire, makeClean, supersededCheckout, reapSuperseded } from './_heldCheckoutRecoveryFixture.js';
const { retireInventoriedCheckout, retirePendingMergeCheckout, readMergedDelivery, retireCompletedCheckouts } = await import('./heldCheckoutRecovery.js');
const { recordBranchReconcileOutcome, getBranchReconcileOutcome, getBranchReconcileInventory } = await import('./branchReconcileOutcome.js');
const { readBranchCompletionHold } = await import('./branchCompletionPolicy.js');

const reviewPolicy = (branch, extra = {}) => ({ id: 'agent-done', status: 'completed', startedAt: '2026-01-01T00:00:00.000Z', result: { success: true },
  metadata: { sourceWorkspace: repo, worktreeBranch: branch, prCompletionPolicy: 'review-then-merge',
    reviewLoopMergeTarget: { branch, url: 'https://github.com/example/repo/pull/42' }, ...extra } });

describeHeldCheckoutRecovery(() => {
  beforeEach(() => {
    forge.mergedHeads.clear();
    forge.unreadable = false;
    forge.delivery = null;
  });

  it.each([false, true])('retires a dirty exact merged delivery with an initialized submodule (locked: %s)', async locked => {
    const branch = 'feature/submodule-delivery';
    const path = join(external, 'submodule-delivery');
    await execGit(['worktree', 'add', '-b', branch, path, 'main'], repo);
    const base = (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim();
    await execGit(['update-index', '--add', '--cacheinfo', `160000,${base},vendor`], path);
    await writeFile(join(path, '.gitmodules'), '[submodule "vendor"]\n\tpath = vendor\n\turl = ./fixture-vendor\n');
    await execGit(['add', '.gitmodules'], path);
    await execGit(['commit', '-m', 'feat: vendored submodule'], path);
    await execGit(['clone', '--no-hardlinks', repo, join(path, 'vendor')], repo);
    await execGit(['checkout', '--detach', base], join(path, 'vendor'));
    await execGit(['submodule', 'absorbgitdirs', 'vendor'], path);
    await writeFile(join(path, 'scratch.txt'), 'uncommitted after merge\n');
    if (locked) await execGit(['worktree', 'lock', '--reason', 'synthetic external owner', path], repo);
    const head = (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim();
    const release = { path: (await execGit(['rev-parse', '--show-toplevel'], path)).stdout.trim(), head, branch,
      locked, lockReason: locked ? 'synthetic external owner' : null };
    // Not on local main: only the forge's exact-head merge makes it disposable.
    forge.mergedHeads.add(`${branch}@${head}`);
    expect(await retire(release)).toMatchObject({ ok: true, branchDeleted: true });
    expect(existsSync(release.path)).toBe(false);
    expect(await registered(release.path)).toBe(false);
    expect((await getBranchReconcileOutcome('app-1')).retired).toContainEqual(expect.objectContaining({ path: release.path, branch,
      head, branchDeleted: true, archiveDir: null, checkoutIdentity: expect.any(String) }));
  });

  it('settles a completion-review obligation in one operator step once the work merged', async () => {
    const { path, release } = await mergedCheckout('operator-one-step');
    injected.policies = [reviewPolicy(release.branch)];
    expect(await readBranchCompletionHold({ repoPath: repo, branch: release.branch, retirement: true })).toBe('pr-completion-review-required');
    expect(await retireInventoriedCheckout({ appId: 'app-1', release }, { readAgents: noOwners })).toMatchObject({ ok: true, branchDeleted: true });
    expect(existsSync(path)).toBe(false);
    expect(await registered(path)).toBe(false);
    expect((await execGit(['branch', '--list', release.branch], repo)).stdout.trim()).toBe('');
  });

  it('keeps an unmerged completion-review checkout and its work, even beside a PR merged at another head', async () => {
    const { path, release } = await mergedCheckout('operator-unmerged', { merge: 'none' });
    injected.policies = [reviewPolicy(release.branch)];
    await writeFile(join(path, 'wanted.txt'), 'still wanted\n');
    forge.mergedHeads.add(`${release.branch}@${'0'.repeat(40)}`);
    forge.delivery = { prHead: '0'.repeat(40) };
    expect(await retireInventoriedCheckout({ appId: 'app-1', release }, { readAgents: noOwners })).toEqual({ ok: false, reason: 'not-merged-on-recheck' });
    expect(await readFile(join(path, 'wanted.txt'), 'utf8')).toBe('still wanted\n');
    expect((await execGit(['rev-parse', release.branch], repo)).stdout.trim()).toBe(release.head);
  });

  it('retires a clean checkout whose commits a later merged PR head contains, and keeps a dirty one', async () => {
    const { path, release } = await mergedCheckout('contained-delivery', { merge: 'none' });
    // The PR gained a commit pushed from elsewhere, then merged (squash) at that later head.
    forge.mergedHeads.add(`${release.branch}@${'c'.repeat(40)}`);
    forge.delivery = { prHead: 'c'.repeat(40), scopeProof: 'ancestor-of-delivered-head', deliveredAncestorHead: release.head };
    await writeFile(join(path, 'wanted.txt'), 'uncommitted\n');
    expect(await retireInventoriedCheckout({ appId: 'app-1', release }, { readAgents: noOwners })).toEqual({ ok: false, reason: 'worktree-dirty' });
    expect(await readFile(join(path, 'wanted.txt'), 'utf8')).toBe('uncommitted\n');
    await makeClean(path);
    expect(await retireInventoriedCheckout({ appId: 'app-1', release }, { readAgents: noOwners })).toMatchObject({ ok: true, branchDeleted: true });
    expect(existsSync(path)).toBe(false);
  });

  it.each(['cleanupMerged', 'early reaper'])('settles a normally merged checkout before the next scan through %s', async entryPoint => {
    const branch = 'feature/merged-receipt';
    const path = join(repo, '.claude', 'worktrees', 'merged-receipt');
    await mkdir(dirname(path), { recursive: true });
    await execGit(['worktree', 'add', '-b', branch, path, 'main'], repo);
    await writeFile(join(path, '.gitignore'), 'ignored.txt\n');
    await execGit(['add', '.gitignore'], path);
    await execGit(['commit', '-m', 'fixture ignore rule'], path);
    await execGit(['merge', '--ff-only', branch], repo);
    const holder = (await (await import('./worktreeManager.js')).listWorktrees(repo)).find(tree => tree.branch === `refs/heads/${branch}`);
    const release = { branch, path: holder.path, head: holder.head, locked: false, lockReason: null };
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...release,
      checkoutIdentity: await readRetirementCheckoutIdentity(path), reason: 'checkout-retained' }] });
    const options = { appId: 'app-1', activeAgentIds: new Set(), claimOwners: { agents: [], readAgents: noOwners } };
    if (entryPoint === 'cleanupMerged') {
      const result = await (await import('./branchReconcile.js')).cleanupMerged(repo, 'main', [{ branch, worktreePath: holder.path }], options);
      expect(result).toMatchObject({ cleaned: [branch], skipped: [] });
    } else {
      const result = await (await import('./worktreeManager.js')).reapMergedWorktrees(repo, options);
      expect(result.reaped).toEqual([expect.objectContaining({ branch, branchDeleted: true })]);
      expect(result.skipped).toEqual([]);
    }
    expect(existsSync(path)).toBe(false);
    expect((await execGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo, { ignoreExitCode: true })).exitCode).toBe(1);
    const first = await getBranchReconcileOutcome('app-1');
    expect(first.retired).toEqual([expect.objectContaining({ branch, path: holder.path, head: holder.head, branchDeleted: true, archiveDir: null })]);
    await recordBranchReconcileOutcome('app-1', { status: 'complete', remaining: [] });
    const next = await getBranchReconcileOutcome('app-1');
    expect(next.remaining).toEqual([]);
    expect(next.retired).toEqual(first.retired);
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
  });

  it('deletes an inventoried merged branch without a checkout, and keeps unmerged or unproven ones', async () => {
    const merged = 'feature/inventoried-merged';
    await execGit(['branch', merged, 'main'], repo);
    const head = (await execGit(['rev-parse', merged], repo)).stdout.trim();
    const unmerged = 'feature/inventoried-unmerged';
    const unmergedHead = (await execGit(['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'unmerged branch-only work'], repo)).stdout.trim();
    await execGit(['branch', unmerged, unmergedHead], repo);
    const absent = { branch: 'feature/already-gone', head: unmergedHead };
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [
      { branch: merged, head, reason: 'branch-held' }, { branch: unmerged, head: unmergedHead, reason: 'branch-held' },
      { ...absent, reason: 'branch-held' }] });
    const row = (branch, at) => ({ appId: 'app-1', release: { branch, head: at, locked: false, lockReason: null } });
    expect(await retireInventoriedCheckout(row(unmerged, unmergedHead), { readAgents: noOwners })).toEqual({ ok: false, reason: 'not-merged-on-recheck' });
    expect((await execGit(['rev-parse', unmerged], repo)).stdout.trim()).toBe(unmergedHead);
    // An absent ref records retirement only on the forge's exact merge.
    expect(await retireInventoriedCheckout(row(absent.branch, absent.head), { readAgents: noOwners })).toEqual({ ok: false, reason: 'not-merged-on-recheck' });
    forge.mergedHeads.add(`${absent.branch}@${absent.head}`);
    expect(await retireInventoriedCheckout(row(absent.branch, absent.head), { readAgents: noOwners })).toEqual({ ok: true, branchDeleted: true });
    expect(await retireInventoriedCheckout(row(merged, head), { readAgents: noOwners })).toEqual({ ok: true, branchDeleted: true });
    expect((await execGit(['rev-parse', '--verify', '--quiet', `refs/heads/${merged}`], repo, { ignoreExitCode: true })).exitCode).toBe(1);
    const outcome = await getBranchReconcileOutcome('app-1');
    expect(outcome.retired.map(entry => entry.branch).sort()).toEqual([absent.branch, merged].sort());
    expect(outcome.remaining).toEqual([{ branch: unmerged, head: unmergedHead, reason: 'branch-held' }]);
  });

  it('retires a superseded branch without a worktree and does not claim checkout preservation', async () => {
    const branch = 'feature/no-worktree';
    const head = (await execGit(['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'superseded branch-only commit'], repo)).stdout.trim();
    await execGit(['branch', branch, head], repo);
    const missingCheckout = { branch, path: join(external, 'lost-original'), head, locked: false, lockReason: null };
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...missingCheckout, reason: 'checkout-retained' }] });
    let seenHead = null;
    retirementFaults.onBranchDelete = async () => {
      seenHead = (await execGit(['rev-parse', '--verify', `refs/heads/${branch}`], repo)).stdout.trim();
    };
    const entry = { branch, tip: head, worktreePath: null, dirtyPaths: [], verdict: { branch, tip: head, verdict: 'SUPERSEDED', dirtyPaths: [] } };
    expect(await reapSuperseded(entry)).toMatchObject({ reaped: [branch], skipped: [] });
    expect(seenHead).toBe(head);
    expect((await execGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo, { ignoreExitCode: true })).exitCode).toBe(1);
    const outcome = await getBranchReconcileOutcome('app-1');
    expect(outcome.retired).toEqual([expect.objectContaining({ branch, head, branchDeleted: true, archiveDir: null })]);
    expect((await getBranchReconcileInventory('app-1')).remaining).toEqual([]);
  });

  it('removes a clean superseded checkout, ignored files included, without writing any backup', async () => {
    const { entry, release } = await supersededCheckout({ clean: true });
    await appendFile(join(repo, '.git', 'info', 'exclude'), 'ignored.txt\n');
    await writeFile(join(release.path, 'ignored.txt'), 'generated bytes');
    expect(await reapSuperseded(entry)).toMatchObject({ reaped: [release.branch], skipped: [] });
    expect(existsSync(release.path)).toBe(false);
    expect((await execGit(['rev-parse', '--verify', '--quiet', `refs/heads/${release.branch}`], repo, { ignoreExitCode: true })).exitCode).toBe(1);
    expect((await getBranchReconcileOutcome('app-1')).retired).toContainEqual(expect.objectContaining({
      path: release.path, branch: release.branch, head: release.head, archiveDir: null, branchDeleted: true, retiredAt: expect.any(String),
    }));
  });

  it('keeps a superseded checkout with uncommitted work, since nothing is copied before removal', async () => {
    const { entry, release } = await supersededCheckout();
    expect(await reapSuperseded(entry)).toMatchObject({ reaped: [], skipped: [expect.objectContaining({ branch: release.branch, reason: 'worktree-dirty' })] });
    expect(await readFile(join(release.path, 'initial.txt'), 'utf8')).toBe('unstaged original work\n');
  });

  it('keeps a superseded checkout held by a live owner', async () => {
    const { entry, release } = await supersededCheckout();
    const owners = [{ id: 'new-owner', status: 'running', metadata: { sourceWorkspace: repo, claimBranches: [release.branch] } }];
    const result = await reapSuperseded(entry, async () => owners);
    expect(result.reaped).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(await registered(release.path)).toBe(true);
    expect((await execGit(['rev-parse', release.branch], repo)).stdout.trim()).toBe(release.head);
    expect((await getBranchReconcileOutcome('app-1'))?.retired || []).toEqual([]);
  });

  it('preserves a superseded branch whose exact head no longer matches its verdict', async () => {
    const { entry, release } = await supersededCheckout();
    entry.tip = 'f'.repeat(40);
    entry.verdict.tip = entry.tip;
    expect(await reapSuperseded(entry)).toMatchObject({ reaped: [], skipped: [{ branch: release.branch, reason: 'branch-head-changed' }] });
    expect(await registered(release.path)).toBe(true);
  });

  it('removes a superseded checkout that an earlier pass left in the inventory', async () => {
    const { entry, release } = await supersededCheckout({ clean: true });
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...release, reason: 'retirement-pending' }] });
    expect(await reapSuperseded(entry)).toMatchObject({ reaped: [release.branch], skipped: [] });
    expect(existsSync(release.path)).toBe(false);
    expect((await getBranchReconcileInventory('app-1')).remaining).toEqual([]);
  });

  it('reports an unverified receipt when retirement persistence fails', async () => {
    const { entry, release } = await supersededCheckout({ clean: true });
    retirementFaults.failScheduleWrite = 1;
    expect(await reapSuperseded(entry)).toMatchObject({ reaped: [], skipped: [{ branch: release.branch, reason: 'retirement-receipt-unverified' }] });
    expect((await getBranchReconcileOutcome('app-1'))?.retired || []).toEqual([]);
    expect(existsSync(release.path)).toBe(false);
  });

  it('keeps a dirty locked detached checkout', async () => {
    const { path, release } = await heldCheckout('detached-held');
    await writeFile(join(path, 'staged-only.txt'), 'staged work\n');
    await execGit(['add', 'staged-only.txt'], path);
    expect(await retire(release)).toEqual({ ok: false, reason: 'worktree-dirty' });
    expect(await registered(release.path)).toBe(true);
    expect(await lockText(release.path)).toBe(release.lockReason);
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
    const delayed = { ...release, checkoutIdentity, observedAt: new Date().toISOString(), reason: 'retirement-pending' };
    await recordBranchReconcileOutcome('app-1', {
      status: 'incomplete', reason: 'holds-remaining', nextAction: 'Recover held checkouts.',
      remaining: [{ ...delayed, managed: false, reason: 'worktree-locked' }, { branch: 'other', reason: 'actionable' }],
    });
    expect(await retireInventoriedCheckout({ appId: 'app-1', release: { ...release, checkoutIdentity: '0'.repeat(64) } }, { readAgents: noOwners }))
      .toEqual({ ok: false, reason: 'release-not-in-inventory' });
    expect(await isCurrentRetirementCheckout(delayed)).toBe(true);
    await makeClean(path);
    const result = await retireInventoriedCheckout({ appId: 'app-1', release }, { readAgents: noOwners });
    expect(result, JSON.stringify(result)).toEqual({ ok: true, branchDeleted: true, checkoutIdentity });
    expect(existsSync(path)).toBe(false);
    expect((await execGit(['branch', '--list', 'feature/held'], repo)).stdout.trim()).toBe('');
    const outcome = await getBranchReconcileOutcome('app-1');
    expect(outcome.remaining).toEqual([{ branch: 'other', reason: 'actionable' }]);
    expect(outcome.retired[0]).toMatchObject({ path: release.path, branch: 'feature/held', branchDeleted: true, archiveDir: null, checkoutIdentity });
    await recordBranchReconcileOutcome('app-1', { status: 'running', remaining: [delayed] });
    expect((await getBranchReconcileInventory('app-1')).remaining).toEqual([]);
    await execGit(['worktree', 'add', '-b', release.branch, path, release.head], repo);
    const recreated = { ...delayed, checkoutIdentity: await readRetirementCheckoutIdentity(path), observedAt: new Date().toISOString() };
    expect(recreated.checkoutIdentity).not.toBe(checkoutIdentity);
    expect(await isCurrentRetirementCheckout(delayed)).toBe(false);
    await recordBranchReconcileOutcome('app-1', { status: 'running', remaining: [recreated] });
    expect((await getBranchReconcileInventory('app-1')).remaining).toEqual([recreated]);
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
  });

  it('keeps the checkout, its content and its original lock when an owner appears before removal', async () => {
    const { path, release } = await heldCheckout('owner-arrives', { lockReason: 'handoff pending' });
    let reads = 0;
    // Clear at admission; a live run occupies the checkout by the removal recheck.
    const readAgents = async () => (++reads === 1 ? [] : [{ id: 'agent-live', status: 'running', workspacePath: release.path }]);
    await makeClean(path);
    expect(await retire(release, { readAgents })).toEqual({ ok: false, reason: 'claim-owner-active' });
    expect(await registered(release.path)).toBe(true);
    expect(await lockText(release.path)).toBe('handoff pending');
    expect(existsSync(join(path, 'initial.txt'))).toBe(true);
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
  });

  it('retires a dirty checkout whose PR merged at its exact head, and keeps one whose head differs', async () => {
    const { path, release } = await heldCheckout('merged-dirty', { branch: 'feature/merged-dirty' });
    await writeFile(join(path, 'scratch.txt'), 'unsaved\n');
    forge.mergedHeads.add(`${release.branch}@${'0'.repeat(40)}`);
    expect(await retire(release)).toEqual({ ok: false, reason: 'worktree-dirty' });
    expect(existsSync(join(path, 'scratch.txt'))).toBe(true);
    forge.mergedHeads.add(`${release.branch}@${release.head}`);
    expect(await retire(release)).toMatchObject({ ok: true });
    expect(existsSync(path)).toBe(false);
  });

  it('keeps a dirty checkout when a nested repository is present', async () => {
    const { path, release } = await heldCheckout('nested-repository');
    await mkdir(join(path, 'nested'));
    await execGit(['init', '-q'], join(path, 'nested'));
    expect(await retire(release)).toEqual({ ok: false, reason: 'worktree-dirty' });
    expect(await lockText(release.path)).toBe('synthetic external owner');
    expect(existsSync(join(path, 'nested', '.git'))).toBe(true);
  });

  it('refuses unmerged work, a manual completion handoff and unreadable policy before removing anything', async () => {
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
    expect(await retire(handoff.release)).toEqual({ ok: false, reason: 'pr-completion-human-handoff' });
    injected.policies = null;
    expect(await retire(handoff.release)).toEqual({ ok: false, reason: 'pr-completion-policy-unavailable' });
    expect(existsSync(handoff.path)).toBe(true);
    expect(await lockText(handoff.path)).toBe(handoff.release.lockReason);
  });

  it('retires a pending-merge receipt checkout at its exact merged head, uncommitted files included', async () => {
    const { path, release } = await mergedCheckout('receipt', { merge: 'none' });
    await writeFile(join(path, 'feature.txt'), 'edited after handoff\n');
    const receipt = (more = {}) => ({ repoPath: repo, release, prUrl: 'https://github.com/example/repo/pull/42', expectedHeadSha: release.head, ...more });
    forge.delivery = { prHead: 'f'.repeat(40) };
    expect(await retirePendingMergeCheckout(receipt())).toEqual({ ok: false, reason: 'receipt-pr-head-changed' });
    forge.delivery = new Error('merged-pr-remote-head-changed');
    expect(await retirePendingMergeCheckout(receipt())).toEqual({ ok: false, reason: 'merged-pr-remote-head-changed' });
    expect(await retirePendingMergeCheckout(receipt({ release: { ...release, locked: true, lockReason: 'owner' } }))).toEqual({ ok: false, reason: 'receipt-checkout-locked' });
    expect(await retirePendingMergeCheckout(receipt({ expectedHeadSha: 'e'.repeat(40) }))).toEqual({ ok: false, reason: 'receipt-checkout-head-unverified' });
    expect(await readFile(join(path, 'feature.txt'), 'utf8')).toBe('edited after handoff\n');
    forge.delivery = { prHead: release.head };
    expect(await retirePendingMergeCheckout(receipt(), { readAgents: noOwners })).toMatchObject({ ok: true, branchDeleted: true });
    expect(existsSync(path)).toBe(false);
    expect((await getBranchReconcileOutcome('app-1')).retired).toContainEqual(expect.objectContaining({ path: release.path, branch: release.branch, branchDeleted: true }));
  });

  it('retires a clean receipt checkout contained in the merged PR head and holds a dirty one', async () => {
    const contained = (release) => ({ prHead: 'c'.repeat(40), scopeProof: 'ancestor-of-delivered-head', deliveredAncestorHead: release.head });
    const clean = await mergedCheckout('receipt-contained-clean', { merge: 'none' });
    await makeClean(clean.path);
    forge.delivery = contained(clean.release);
    expect(await retirePendingMergeCheckout({ repoPath: repo, release: clean.release, prUrl: 'https://github.com/example/repo/pull/42',
      expectedHeadSha: clean.release.head }, { readAgents: noOwners })).toMatchObject({ ok: true, branchDeleted: true });
    expect(existsSync(clean.path)).toBe(false);

    const dirty = await mergedCheckout('receipt-contained-dirty', { merge: 'none' });
    await writeFile(join(dirty.path, 'feature.txt'), 'edited after handoff\n');
    forge.delivery = contained(dirty.release);
    const held = await retirePendingMergeCheckout({ repoPath: repo, release: dirty.release, prUrl: 'https://github.com/example/repo/pull/42',
      expectedHeadSha: dirty.release.head }, { readAgents: noOwners });
    expect(held.ok).toBe(false);
    expect(await readFile(join(dirty.path, 'feature.txt'), 'utf8')).toBe('edited after handoff\n');
  });

  it('keeps a receipt checkout whose head moved after the handoff', async () => {
    const { path, release } = await mergedCheckout('receipt-moved', { merge: 'none' });
    await execGit(['commit', '--allow-empty', '-m', 'feat: work after handoff'], path);
    forge.delivery = { prHead: release.head };
    expect(await retirePendingMergeCheckout({ repoPath: repo, release, prUrl: 'https://github.com/example/repo/pull/42',
      expectedHeadSha: release.head }, { readAgents: noOwners })).toEqual({ ok: false, reason: 'checkout-head-changed' });
    expect(await registered(path)).toBe(true);
  });

  it('reads merged delivery as merged, unmerged or unknown without changing the checkout', async () => {
    const merged = await mergedCheckout('delivery-merged');
    expect(await readMergedDelivery(repo, merged.release)).toBe(true);
    const unmerged = await mergedCheckout('delivery-unmerged', { merge: 'none' });
    expect(await readMergedDelivery(repo, unmerged.release)).toBe(false);
    forge.unreadable = true;
    expect(await readMergedDelivery(repo, unmerged.release)).toBeNull();
    forge.unreadable = false;
    // Every commit on main, but uncommitted work stays unless the PR merged at this head.
    await writeFile(join(merged.path, 'wanted.txt'), 'uncommitted\n');
    expect(await readMergedDelivery(repo, merged.release)).toBe(false);
    forge.mergedHeads.add(`${merged.release.branch}@${merged.release.head}`);
    expect(await readMergedDelivery(repo, merged.release)).toBe(true);
    expect(await readFile(join(merged.path, 'wanted.txt'), 'utf8')).toBe('uncommitted\n');
    // A later merged head that contains the work retires it only when clean.
    forge.mergedHeads.add(`${unmerged.release.branch}@${'c'.repeat(40)}`);
    forge.delivery = { prHead: 'c'.repeat(40), scopeProof: 'ancestor-of-delivered-head', deliveredAncestorHead: unmerged.release.head };
    expect(await readMergedDelivery(repo, unmerged.release)).toBe(true);
    forge.delivery = new Error('merged-pr-forge-unavailable');
    expect(await readMergedDelivery(repo, unmerged.release)).toBeNull();
  });

  // A merged checkout holding an ignored link to an outside directory.
  async function linkedCheckout(name) {
    const checkout = await mergedCheckout(name);
    await appendFile(join(repo, '.git', 'info', 'exclude'), 'linked-dir\n');
    const outside = join(scratch, `outside-${name}`);
    await mkdir(outside);
    await writeFile(join(outside, 'wanted.txt'), 'outside bytes\n');
    const link = join(checkout.path, 'linked-dir');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    return { ...checkout, outside, link, target: await readlink(link) };
  }

  it.skipIf(!SYMLINKS).each(['native', 'descendant'])('never follows a directory link while retiring, with a %s listing', async listing => {
    const c = await linkedCheckout(`linked-${listing}`);
    // Git for Windows can enumerate a junction's descendants as ordinary files.
    if (listing === 'descendant') injected.onOtherFiles = output => output.split('\0')
      .map(entry => (entry === 'linked-dir' ? 'linked-dir/wanted.txt' : entry)).join('\0');
    expect(await retireInventoriedCheckout({ appId: 'app-1', release: c.release }, { readAgents: noOwners })).toMatchObject({ ok: true, branchDeleted: true });
    expect(existsSync(c.path)).toBe(false);
    expect(await readFile(join(c.outside, 'wanted.txt'), 'utf8')).toBe('outside bytes\n');
  });

  it.skipIf(!SYMLINKS)('restores unlinked directory links when Git refuses removal', async () => {
    const c = await linkedCheckout('linked-refused');
    let linkGoneAtRemoval = null;
    retirementFaults.onRemove = async () => {
      linkGoneAtRemoval = !(await lstat(c.link).catch(() => null));
      throw new Error('synthetic Git removal refusal');
    };
    expect(await retireInventoriedCheckout({ appId: 'app-1', release: c.release }, { readAgents: noOwners })).toMatchObject({ ok: false });
    expect(linkGoneAtRemoval).toBe(true);
    expect(await readlink(c.link)).toBe(c.target);
    expect(await readFile(join(c.outside, 'wanted.txt'), 'utf8')).toBe('outside bytes\n');
    expect(await registered(c.path)).toBe(true);
  });
});

describe('automatic retirement of completed local work', () => {
  const app = { id: 'example', repoPath: '/example/repo' };
  const head = 'a'.repeat(40);
  const branch = { branch: 'claim/issue-42', tip: head, worktreePath: '/example/checkout', isMerged: false,
    rule: 'completion-policy', completionPolicyReason: 'pr-completion-review-required' };
  const tree = { branch: branch.branch, path: branch.worktreePath, head, managed: true, locked: false, lockReason: null };
  const scan = (b = {}, t = {}) => ({ wip: [{ ...branch, ...b }], worktreeInventory: [{ ...tree, ...t }] });
  const release = { branch: tree.branch, path: tree.path, head, locked: false, lockReason: null };
  const deps = (extra = {}) => ({ retire: vi.fn(async () => ({ ok: true, branchDeleted: true })), readForgeDelivery: vi.fn(async () => 'none'),
    retireReleaseCandidates: vi.fn(async () => ({ retired: [], held: [] })), ...extra });

  unitIt('retires a clean checkout whose commits are all on the default branch, binding the observed row', async () => {
    const d = deps();
    const observation = { observedAt: '2026-10-23T00:00:00Z', checkoutIdentity: 'original-checkout' };
    expect(await retireCompletedCheckouts(app, scan({ isMerged: true }, observation), d)).toEqual({ held: [], retired: [{ ...observation, ...release }] });
    // The forge answer read for the pass is handed on, so the service does not ask again.
    expect(d.retire).toHaveBeenCalledWith({ appId: app.id, release: { ...observation, ...release } }, { beforeMutation: expect.any(Function), delivery: 'none' });
  });

  unitIt('retires a dirty or squash-merged checkout only when its PR merged at the exact head', async () => {
    const d = deps({ readForgeDelivery: vi.fn(async () => 'exact') });
    expect(await retireCompletedCheckouts(app, scan({ worktreeDirty: true }), d)).toMatchObject({ retired: [release] });
    expect(d.readForgeDelivery).toHaveBeenCalledWith(app.repoPath, branch.branch, head);
    expect(d.retire).toHaveBeenCalledWith({ appId: app.id, release }, { beforeMutation: expect.any(Function), delivery: 'exact' });
    const contained = deps({ readForgeDelivery: vi.fn(async () => 'contained') });
    expect(await retireCompletedCheckouts(app, scan(), contained)).toMatchObject({ retired: [release] });
    expect(contained.retire).toHaveBeenCalledWith({ appId: app.id, release }, { beforeMutation: expect.any(Function), delivery: 'contained' });
    for (const [delivery, b] of [['none', {}], ['none', { worktreeDirty: true }], ['none', { isMerged: true, worktreeDirty: true }],
      ['contained', { worktreeDirty: true }], [null, {}]]) {
      const held = deps({ readForgeDelivery: vi.fn(async () => delivery) });
      expect(await retireCompletedCheckouts(app, scan(b), held)).toEqual({ held: [], retired: [] });
      expect(held.retire).not.toHaveBeenCalled();
    }
  });

  unitIt.each([
    [{ liveOwnerReason: 'claim-owner-active' }, {}],
    [{ completionPolicyReason: 'pr-completion-human-handoff' }, {}],
    [{ rule: 'draft', openPr: { isDraft: true, headRefOid: 'c'.repeat(40) } }, {}],
    [{ openPr: { isDraft: false, headRefOid: head } }, {}],
    [{ openPr: { isDraft: false, headRefOid: null } }, {}],
    [{ worktreeStatusUnavailable: true }, {}],
    [{}, { locked: true }], [{}, { managed: false }], [{}, { head: 'b'.repeat(40) }],
  ])('never retires an unsafe or intentionally held candidate: %j %j', async (b, t) => {
    const d = deps({ readForgeDelivery: vi.fn(async () => 'exact') });
    for (const isMerged of [false, true]) {
      expect(await retireCompletedCheckouts(app, scan({ isMerged, ...b }, t), d)).toEqual({ held: [], retired: [] });
    }
    expect(d.retire).not.toHaveBeenCalled();
  });

  unitIt('retires a merged checkout left idle behind its open PR, and keeps one still in use', async () => {
    const behind = { isMerged: true, openPr: { isDraft: false, headRefOid: 'c'.repeat(40) } };
    const d = deps({ checkoutIdleMs: vi.fn(async () => 2 * 60 * 60 * 1000) });
    expect(await retireCompletedCheckouts(app, scan(behind), d)).toMatchObject({ retired: [release], held: [] });
    expect(d.checkoutIdleMs).toHaveBeenCalledWith(tree.path);
    expect(d.readForgeDelivery).not.toHaveBeenCalled();
    for (const idle of [5 * 60 * 1000, null]) {
      const busy = deps({ checkoutIdleMs: vi.fn(async () => idle) });
      expect(await retireCompletedCheckouts(app, scan(behind), busy)).toEqual({ held: [], retired: [] });
      expect(busy.retire).not.toHaveBeenCalled();
    }
  });

  unitIt('keeps a refused or failed retirement held with its reason, never a raw error', async () => {
    const merged = scan({ isMerged: true });
    expect(await retireCompletedCheckouts(app, merged, deps({ retire: vi.fn(async () => ({ ok: false, reason: 'pr-completion-human-handoff' })) })))
      .toEqual({ retired: [], held: [{ ...release, reason: 'pr-completion-human-handoff' }] });
    expect((await retireCompletedCheckouts(app, merged, deps({ retire: vi.fn(async () => ({ ok: true, branchDeleted: false, branchRetainedReason: 'branch-has-new-holder' })) }))).held[0].reason)
      .toBe('branch-has-new-holder');
    expect((await retireCompletedCheckouts(app, merged, deps({ retire: vi.fn(async () => { throw new Error('daemon-stopped'); }) }))).held[0].reason).toBe('daemon-stopped');
    expect((await retireCompletedCheckouts(app, merged, deps({ retire: vi.fn(async () => { throw new Error('private diagnostic'); }) }))).held[0].reason)
      .toBe('retirement-outcome-uncertain');
  });

  unitIt('folds release-candidate results into the pass', async () => {
    const candidate = { branch: 'codex/release-agent-x', path: '/example/release', head, locked: true, lockReason: 'Active release candidate codex/release-agent-x' };
    const d = deps({ retireReleaseCandidates: vi.fn(async () => ({ retired: [candidate], held: [{ ...candidate, reason: 'worktree-dirty' }] })) });
    expect(await retireCompletedCheckouts(app, { wip: [], worktreeInventory: [] }, d)).toEqual({ retired: [candidate], held: [{ ...candidate, reason: 'worktree-dirty' }] });
    expect(d.retireReleaseCandidates).toHaveBeenCalledWith(app, { wip: [], worktreeInventory: [] }, d);
  });
});
