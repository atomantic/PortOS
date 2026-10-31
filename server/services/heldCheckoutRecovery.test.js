/**
 * Scoped retirement of held checkouts through real Git (#12002, #13519): a
 * release binds to the exact inventory row. A merged checkout is removed in
 * place (dirty only when its PR merged at the exact head). Dirty unmerged and
 * live-owner checkouts stay, and retirement never copies the checkout.
 *
 * This file: core retirement, superseded checkouts, ignored module caches and
 * reviewed-checkout preview.
 * The suite is split across heldCheckoutRecovery{,.receipts,.siblings}.test.js
 * so Vitest can run the slow real-Git cases in parallel; the shared mocks,
 * per-case repository and builders live in _heldCheckoutRecoveryMocks.js and
 * _heldCheckoutRecoveryFixture.js.
 */
import { expect, vi } from 'vitest';
// Load the factories before any import below resolves a mocked module.
import { mockBranchCompletionPolicy, mockClaimOwnershipState, mockExecGit, mockPaths, mockTaskScheduleStore, injected, receiptTiming, retirementFaults, SYMLINKS } from './_heldCheckoutRecoveryMocks.js';
import { appendFile, cp, mkdir, rm, rename, writeFile, readFile, readlink, symlink, truncate, stat } from 'fs/promises';
import { existsSync, realpathSync } from 'fs';
import { createHash } from 'node:crypto';
import { execFile } from '../lib/childProcess.js';
import { dirname, join } from 'path';
import { readRetirementCheckoutIdentity, isCurrentRetirementCheckout } from '../lib/retirementCheckoutObservation.js';
import { execGit } from '../lib/execGit.js';
import { PATHS } from '../lib/paths.js';

// Mock factories and their shared state live beside this file so the three
// split suites intercept exactly the same boundaries.
vi.mock('../lib/paths.js', async importOriginal => mockPaths(await importOriginal()));
vi.mock('./cosClaimOwnershipState.js', async importOriginal => mockClaimOwnershipState(await importOriginal()));
vi.mock('../lib/execGit.js', async importOriginal => mockExecGit(await importOriginal()));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: async () => ({ env: { ...process.env, GH_TOKEN: 'synthetic-account-token' } }) }));
vi.mock('./branchCompletionPolicy.js', async importOriginal => mockBranchCompletionPolicy(await importOriginal()));
vi.mock('./taskScheduleStore.js', async importOriginal => mockTaskScheduleStore(await importOriginal()));
const mergedPrHeads = new Set();
vi.mock('./prProbe.js', async importOriginal => ({ ...await importOriginal(), isMergedPrHead: async (_repo, branch, head) => mergedPrHeads.has(`${branch}@${head}`) }));
vi.mock('./apps.js', () => ({ getAppById: async (id) => (injected.app?.id === id ? injected.app : null) }));

import { describeHeldCheckoutRecovery, setReceiptWork, it, beforeEach, scratch, repo, external, cosDir, receiptWork, noOwners, heldCheckout, registered, lockText, retire, makeClean, supersededCheckout, reapSuperseded, reviewedCheckout } from './_heldCheckoutRecoveryFixture.js';
const { retireInventoriedCheckout, prepareInventoriedCheckoutRetirement, findMissingCheckoutPreservation } = await import('./heldCheckoutRecovery.js');
const { sha256File } = await import('../lib/fileUtils.js');
const { recordBranchReconcileOutcome, getBranchReconcileOutcome, recordHeldCheckoutRetirement } = await import('./branchReconcileOutcome.js');
const { parkPerpetual } = await import('./taskSchedule.js');
const { withClaimOwnershipLock, checkReconcileOwnership } = await import('./cosClaimOwnership.js');

describeHeldCheckoutRecovery(() => {

  // Both automatic retirement entry points used to omit their receipt, so the
  // next persisted scan manufactured a missing-source obligation after archival.
  it.each(['cleanupMerged', 'early reaper'])('settles a normally merged checkout before the next scan through %s', entryPoint => {
    setReceiptWork((async () => {
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
        await recordBranchReconcileOutcome('app-1', { status: 'complete', remaining: [] });
        const next = await getBranchReconcileOutcome('app-1');
        expect(next).toMatchObject({ remaining: [], retirementObligations: [] });
        expect(next.retired).toEqual(first.retired);
      });
    })());
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
    const outcome = await getBranchReconcileOutcome('app-1');
    expect(outcome.retired).toEqual([expect.objectContaining({ branch, head, branchDeleted: true, archiveDir: null })]);
    expect(outcome.retirementObligations).toContainEqual(expect.objectContaining(missingCheckout));
  });

  it('removes a clean superseded checkout without writing any backup or checkout archive', async () => {
    const { entry, release } = await supersededCheckout({ clean: true });
    expect(await reapSuperseded(entry)).toMatchObject({ reaped: [release.branch], skipped: [] });
    expect(existsSync(release.path)).toBe(false);
    expect((await execGit(['rev-parse', '--verify', '--quiet', `refs/heads/${release.branch}`], repo, { ignoreExitCode: true })).exitCode).toBe(1);
    expect(existsSync(join(cosDir, 'abandoned-worktree-backups'))).toBe(false);
    const outcome = await getBranchReconcileOutcome('app-1');
    expect(outcome.retired).toContainEqual(expect.objectContaining({
      path: release.path, branch: release.branch, head: release.head, archiveDir: null, branchDeleted: true, retiredAt: expect.any(String),
    }));
  });

  it('keeps a superseded checkout with uncommitted work, since nothing is copied before removal', async () => {
    const { entry, release } = await supersededCheckout();
    expect(await reapSuperseded(entry)).toMatchObject({ reaped: [], skipped: [expect.objectContaining({ branch: release.branch, reason: 'worktree-dirty' })] });
    expect(existsSync(release.path)).toBe(true);
    expect(await readFile(join(release.path, 'initial.txt'), 'utf8')).toBe('unstaged original work\n');
    expect(existsSync(join(cosDir, 'abandoned-worktree-backups'))).toBe(false);
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
    expect((await getBranchReconcileOutcome('app-1'))?.retired || []).toEqual([]);
  });

  it('discards ignored files with a clean superseded checkout', async () => {
    const { entry, release } = await supersededCheckout({ clean: true });
    await appendFile(join(repo, '.git', 'info', 'exclude'), 'ignored.txt\n');
    await writeFile(join(release.path, 'ignored.txt'), 'generated bytes');
    expect(await reapSuperseded(entry)).toMatchObject({ reaped: [release.branch], skipped: [] });
    expect(existsSync(release.path)).toBe(false);
  });

  it('preserves a superseded branch whose exact head no longer matches its verdict', async () => {
    const { entry, release } = await supersededCheckout();
    entry.tip = 'f'.repeat(40);
    entry.verdict.tip = entry.tip;
    expect(await reapSuperseded(entry)).toMatchObject({ reaped: [], skipped: [{ branch: release.branch, reason: 'branch-head-changed' }] });
    expect(existsSync(release.path)).toBe(true);
    expect(await registered(release.path)).toBe(true);
  });

  it('removes a superseded checkout even when an old obligation has no incarnation proof', async () => {
    const { entry, release } = await supersededCheckout({ clean: true });
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', retirementObligations: [{ ...release, reason: 'retirement-review-pending' }] });
    expect(await reapSuperseded(entry)).toMatchObject({ reaped: [release.branch], skipped: [] });
    expect(existsSync(release.path)).toBe(false);
  });

  it('reports an unverified receipt when retirement persistence fails and writes no checkout archive', async () => {
    const { entry, release } = await supersededCheckout({ clean: true });
    retirementFaults.failScheduleWrite = 1;
    expect(await reapSuperseded(entry)).toMatchObject({ reaped: [], skipped: [{ branch: release.branch, reason: 'retirement-receipt-unverified' }] });
    expect((await getBranchReconcileOutcome('app-1'))?.retired || []).toEqual([]);
    expect(existsSync(release.path)).toBe(false);
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
    expect((await execGit(['rev-parse', `refs/heads/${c.release.branch}`], repo)).stdout.trim()).toBe(c.release.head);
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
    mergedPrHeads.add(`${release.branch}@${'0'.repeat(40)}`);
    expect(await retire(release)).toEqual({ ok: false, reason: 'worktree-dirty' });
    expect(existsSync(join(path, 'scratch.txt'))).toBe(true);

    mergedPrHeads.add(`${release.branch}@${release.head}`);
    expect(await retire(release)).toMatchObject({ ok: true });
    mergedPrHeads.clear();
    expect(existsSync(path)).toBe(false);
  });

  it('keeps a dirty checkout when a nested repository is present and writes no archive', async () => {
    const { path, release } = await heldCheckout('archive-fails');
    await mkdir(join(path, 'nested'));
    await execGit(['init', '-q'], join(path, 'nested'));

    const result = await retire(release);

    expect(result).toEqual({ ok: false, reason: 'worktree-dirty' });
    expect(await lockText(release.path)).toBe('synthetic external owner');
    expect(existsSync(join(path, 'nested', '.git'))).toBe(true);
  });

  it.skipIf(!SYMLINKS)('preserves the checkout when a link target cannot be represented losslessly in archive metadata', async () => {
    const { path, release } = await heldCheckout('opaque-link', { branch: 'feature/opaque-link' });
    const target = Buffer.from([0xff]);
    await symlink(target, join(path, 'opaque-link'));

    expect(await retire(release)).toEqual({ ok: false, reason: 'worktree-dirty' });
    expect(await readlink(join(path, 'opaque-link'), { encoding: 'buffer' })).toEqual(target);
    expect(await lockText(path)).toBe('synthetic external owner');
    expect(await registered(path)).toBe(true);
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
  });

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
    const { recordSupersededCheckoutPreservation } = await import('./branchReconcileOutcome.js');
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
    expect(retirement, retirement.detail || retirement.reason).toMatchObject({ ok: true, branchDeleted: true });
    expect(existsSync(c.path)).toBe(false);
    const outcome = await getBranchReconcileOutcome('app-1');
    expect(outcome.retired).toContainEqual(expect.objectContaining({ head: c.release.head,
      disposition: 'superseded-preserved', supersessionDigest: review.digest, archiveDir: null }));
    await recordBranchReconcileOutcome('app-1', { status: 'complete', remaining: [] });
    expect((await getBranchReconcileOutcome('app-1')).retirementObligations).toEqual([]);
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

  it.each(['unpublished-source', 'private-commit', 'large-private-file', 'index-recovery', 'active-operation', 'unknown-private-ref'])('keeps a prototype with %s', async scenario => {
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
    // Private recovery references the evidence reader cannot interpret hold the checkout.
    if (scenario === 'active-operation') {
      await mkdir(join(c.admin, 'sequencer'), { recursive: true });
      await writeFile(join(c.admin, 'sequencer', 'todo'), `pick ${c.release.head}\n`);
    }
    if (scenario === 'unknown-private-ref') {
      await mkdir(join(c.admin, 'refs', 'worktree'), { recursive: true });
      await writeFile(join(c.admin, 'refs', 'worktree', 'unknown'), 'ref: HEAD^{tree}\n');
    }
    const result = await prepareInventoriedCheckoutRetirement({ appId: 'app-1', release: c.release,
      prUrl: c.forge.prUrl, kind: 'preserved-supersession' }, c.opts);
    const reasons = { 'unpublished-source': 'retirement-source-not-published', 'private-commit': 'retirement-source-private-work-unpublished',
      'index-recovery': 'retirement-source-index-recovery-unpublished', 'large-private-file': 'retirement-source-evidence-too-large',
      'active-operation': 'retirement-operation-active', 'unknown-private-ref': 'retirement-local-evidence-unavailable' };
    expect(result).toMatchObject({ ok: false, reason: reasons[scenario] });
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

  it.each(['reviewed', 'merged'])('discards ignored files through the %s retirement boundary', async mode => {
    const c = await reviewedCheckout(`ignored-payload-${mode}`, { normalMerge: true, ignoredPayload: true });
    const prepared = await c.prepare();
    expect(prepared.ok).toBe(true);
    const result = mode === 'reviewed' ? await c.confirm(prepared.review)
      : await retireInventoriedCheckout({ appId: 'app-1', release: c.release }, { ...c.opts, settleMergedReviewObligation: true });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(existsSync(c.path)).toBe(false);
    expect(await registered(c.path)).toBe(false);
  });

  it.each([
    { kind: 'oversized-file', cache: {} },
    { kind: 'oversized-total', cache: { count: 12, bytes: 22 * 1024 * 1024 } },
  ])('retires a reviewed checkout whose ignored module cache exceeds the review budget: $kind', async ({ kind, cache }) => {
    const c = await reviewedCheckout(`disposable-cache-${kind}`);
    await moduleCache(c, cache);
    const prepared = await c.prepare();
    expect(prepared).toMatchObject({ ok: true, review: { comparison: { disposition: 'integrated' } } });
    const retired = await c.confirm(prepared.review);
    expect(retired, JSON.stringify(retired)).toMatchObject({ ok: true, branchDeleted: true });
    expect(retired.archiveDir ?? null).toBeNull();
    expect(existsSync(c.path)).toBe(false);
    expect(await registered(c.path)).toBe(false);
  });

  // Untracked (not ignored) output is still bound by the review budget, even when cache-shaped.
  it('retains large untracked content that only resembles disposable module cache', async () => {
    const c = await reviewedCheckout('unverified-cache-untracked');
    const root = await moduleCache(c, { ignored: false });
    expect(await c.prepare()).toMatchObject({ ok: false, reason: 'retirement-archive-limit-exceeded' });
    expect(await registered(c.path)).toBe(true);
    expect((await stat(join(root, 'a'.repeat(40)))).size).toBe(26 * 1024 * 1024);
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
    const { wanted, before, link } = await cacheDirectoryLink(c);
    if (listing !== 'native') {
      // Git for Windows can enumerate junction descendants as ordinary files.
      // Reproduce that boundary on every OS while retaining a real link.
      injected.onOtherFiles = output => !existsSync(link) ? output
        : [...output.split('\0').filter(rel => rel && !rel.startsWith('server/.cache/vitest/modules')),
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
  });

  it('settles an absent original generation from its existing service receipt without any checkout archive', async () => {
    const c = await reviewedCheckout('receipt-no-archive');
    const checkoutIdentity = await readRetirementCheckoutIdentity(c.path);
    const release = { ...c.release, checkoutIdentity, createdAt: new Date(Date.now() - 1000).toISOString() };
    const prepared = await c.prepare();
    expect(await c.confirm(prepared.review)).toMatchObject({ ok: true, branchDeleted: true });
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
  });

  it('rechecks local work at confirmation after an unlocked preview observes an older tree', async () => {
    const c = await reviewedCheckout('preview-content-change');
    injected.onPreviewEvidence = async () => {
      injected.onPreviewEvidence = null;
      await writeFile(join(c.path, 'wanted.txt'), 'written during preview\n');
    };
    const prepared = await c.prepare();
    expect(prepared.ok).toBe(true);
    expect(await c.confirm(prepared.review)).toMatchObject({ ok: false, reason: 'worktree-dirty' });
    expect(await readFile(join(c.path, 'wanted.txt'), 'utf8')).toBe('written during preview\n');
    expect(await lockText(c.path)).toBe(c.release.lockReason);
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
    expect(await readFile(join(repo, scenario === 'changed-delivery' ? 'feature.txt' : 'upstream.txt'), 'utf8')).toBe('later upstream change\n');
  });


});
