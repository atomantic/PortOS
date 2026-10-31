/** Exact retirement receipts at the Git UI and daily cleanup boundaries (#13405). */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'fs/promises';
import { existsSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import { execGit } from '../lib/execGit.js';
import { readRetirementCheckoutIdentity } from '../lib/retirementCheckoutObservation.js';
import { materializeGitRepo, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { PATHS } from '../lib/paths.js';

const injected = vi.hoisted(() => ({ app: null, apps: null, schedule: null, scheduleWrites: 0, failScheduleWrite: null, failOrphanInventory: false, failMergedInventory: false, inventoryFailureArmed: false, inventoryFailures: 0 }));
vi.mock('../lib/paths.js', async importOriginal => makePathsProxy(await importOriginal(), {
  dataRoot: () => realpathSync.native(lazyTempDataRoot('portos-cleanup-receipts-')),
  extraOverrides: () => ({ root: injected.app?.repoPath || lazyTempDataRoot('portos-cleanup-receipts-') }),
}));
afterAll(cleanupTempDataRoots);
vi.mock('../lib/execGit.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, execGit: async (args, cwd, options) => {
    if (injected.failMergedInventory && args[0] === 'fetch') {
      injected.failMergedInventory = false;
      injected.inventoryFailureArmed = true;
    }
    if (injected.inventoryFailureArmed && args[0] === 'worktree' && args[1] === 'list') {
      injected.inventoryFailureArmed = false;
      injected.inventoryFailures++;
      throw new Error('synthetic orphan inventory failure');
    }
    return actual.execGit(args, cwd, options);
  } };
});
vi.mock('./apps.js', () => ({
  getAllApps: async () => { if (injected.apps instanceof Error) throw injected.apps; return injected.apps ?? (injected.app ? [injected.app] : []); },
  getAppById: async id => injected.app?.id === id ? injected.app : null,
}));
vi.mock('./cosState.js', () => ({ readAgentsStateForSafetyCheck: async () => ({ trusted: true, agents: {} }) }));
vi.mock('./cosAgentRepository.js', () => ({ listStoredAgentStatuses: async () => [] }));
vi.mock('./autobiography.js', () => ({ checkAndPrompt: vi.fn() }));
vi.mock('./goalCheckIn.js', () => ({ runGoalCheckIn: vi.fn() }));
vi.mock('./branchCompletionPolicy.js', () => ({ readBranchCompletionHold: async () => null }));
vi.mock('./taskScheduleStore.js', async importOriginal => ({
  ...await importOriginal(), loadSchedule: async () => injected.schedule,
  updateSchedule: async mutate => {
    if (++injected.scheduleWrites === injected.failScheduleWrite) {
      injected.inventoryFailureArmed = injected.failOrphanInventory;
      throw new Error('synthetic receipt persistence failure');
    }
    return (await mutate(injected.schedule)).result;
  },
}));
const { recordBranchReconcileOutcome, getBranchReconcileOutcome } = await import('./branchReconcileOutcome.js');

describe.skipIf(SKIP_HEAVY_INTEGRATION)('outside reconciliation retirement receipts (real git)', () => {
  let scratch;
  let repo;
  beforeEach(async () => {
    Object.assign(injected, { app: null, apps: null, schedule: { tasks: {}, executions: {} }, scheduleWrites: 0, failScheduleWrite: null, failOrphanInventory: false, failMergedInventory: false, inventoryFailureArmed: false, inventoryFailures: 0 });
    // Preserve the temp guard's Windows short-name spelling until materialization.
    scratch = await mkdtemp(join(tmpdir(), 'portos-cleanup-repo-'));
    await mkdir(join(scratch, 'repo'));
    await materializeGitRepo(join(scratch, 'repo'), { identity: { email: 'test@example.com', name: 'Test' } });
    repo = (await execGit(['rev-parse', '--show-toplevel'], join(scratch, 'repo'))).stdout.trim();
    injected.app = { id: 'app-1', repoPath: repo };
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  it.each(['Git UI', 'daily cleanup'])('persists exact %s retirement before the next inventory scan', async entryPoint => {
    const { release, unrelated, run } = await outsideCleanupFixture(entryPoint);
    const result = await run();
    if (entryPoint === 'Git UI') expect(result).toMatchObject({ deleted: [{ name: release.branch, local: 'deleted' }], skipped: [] });
    else expect(result).toMatchObject({ mergedReaped: 1, worktreesReaped: 0 });
    expect(existsSync(release.path)).toBe(false);
    expect((await execGit(['rev-parse', '--verify', '--quiet', `refs/heads/${release.branch}`], repo, { ignoreExitCode: true })).exitCode).toBe(1);
    const first = await getBranchReconcileOutcome('app-1');
    expect(first.retired).toEqual([expect.objectContaining({ branch: release.branch, path: release.path, head: release.head,
      checkoutIdentity: release.checkoutIdentity, branchDeleted: true, archiveDir: null })]);
    expect(existsSync(join(PATHS.cos, 'branch-retirement-archives'))).toBe(false);
    expect(existsSync(join(PATHS.cos, 'initialized-checkout-retirements'))).toBe(false);
    const next = await recordBranchReconcileOutcome('app-1', { status: 'complete', remaining: [] });
    expect(next.retired).toEqual(first.retired);
    expect(next.retirementObligations).toEqual([expect.objectContaining({ branch: unrelated.branch })]);
  });

  async function outsideCleanupFixture(entryPoint) {
    const branch = 'feature/outside-cleanup';
    const path = join(PATHS.worktrees, `agent-${basename(scratch)}`);
    await mkdir(dirname(path), { recursive: true });
    await execGit(['worktree', 'add', '-b', branch, path, 'main'], repo);
    const holder = (await (await import('./worktreeManager.js')).listWorktrees(repo)).find(tree => tree.branch === `refs/heads/${branch}`);
    const release = { branch, path: holder.path, head: holder.head, locked: false, lockReason: null,
      checkoutIdentity: await readRetirementCheckoutIdentity(path) };
    const unrelated = { branch: 'feature/unexplained', head: holder.head, reason: 'branch-held' };
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...release, reason: 'checkout-retained' }, unrelated] });
    if (entryPoint === 'Git UI') {
      const remote = join(scratch, 'origin.git');
      await execGit(['init', '--bare', remote], scratch);
      await execGit(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);
      await execGit(['remote', 'add', 'origin', remote], repo);
      await execGit(['push', 'origin', 'main'], repo);
    }
    const run = () => entryPoint === 'Git UI'
      ? import('./git.js').then(m => m.deleteMergedBranches(repo, { activeAgentIds: new Set() }))
      : import('./autonomousJobs/scriptHandlers.js').then(m => m.agentDataCleanup());
    return { release, unrelated, run };
  }

  it.each(['Git UI', 'daily cleanup'])('reports %s unverified when the removal receipt cannot be stored', async entryPoint => {
    const { release, run } = await outsideCleanupFixture(entryPoint);
    // The receipt is the only schedule write during removal, and it lands after the checkout is gone.
    injected.failScheduleWrite = injected.scheduleWrites + 1;
    const result = await run();
    expect(entryPoint === 'Git UI' ? result.deleted : result.mergedReaped).toEqual(entryPoint === 'Git UI' ? [] : 0);
    if (entryPoint === 'daily cleanup') expect(result.worktreesReaped).toBe(0);
    expect(existsSync(release.path)).toBe(false);
    expect(existsSync(join(PATHS.cos, 'branch-retirement-archives'))).toBe(false);
    expect((await execGit(['rev-parse', '--verify', '--quiet', `refs/heads/${release.branch}`], repo, { ignoreExitCode: true })).exitCode).toBe(1);
    expect((await getBranchReconcileOutcome('app-1')).retired || []).toEqual([]);
    if (entryPoint === 'Git UI') expect(result.skipped.join('\n')).toContain('retirement-receipt-unverified');
    else expect(result.worktreeHolds).toContainEqual(expect.objectContaining({ path: release.path, reason: 'retirement-receipt-unverified' }));
  });

  it('does not invent a receipt or orphan-remove again after an unverified daily removal', async () => {
    const { release, run } = await outsideCleanupFixture('daily cleanup');
    injected.failScheduleWrite = injected.scheduleWrites + 1;
    expect(await run()).toMatchObject({ mergedReaped: 0, worktreesReaped: 0,
      worktreeHolds: [expect.objectContaining({ path: release.path, reason: 'retirement-receipt-unverified' })] });
    injected.failMergedInventory = true;
    expect(await run()).toMatchObject({ mergedReaped: 0, worktreesReaped: 0 });
    expect(existsSync(release.path)).toBe(false);
    expect((await getBranchReconcileOutcome('app-1')).retired || []).toEqual([]);
  });

  it('keeps an unverified daily removal out of orphan cleanup when that inventory read fails', async () => {
    const { release, run } = await outsideCleanupFixture('daily cleanup');
    injected.failScheduleWrite = injected.scheduleWrites + 1;
    injected.failOrphanInventory = true;
    const result = await run();
    expect(injected.inventoryFailures).toBe(1);
    expect(result).toMatchObject({ mergedReaped: 0, worktreesReaped: 0,
      worktreeHolds: [expect.objectContaining({ path: release.path, reason: 'retirement-receipt-unverified' })] });
    expect(existsSync(release.path)).toBe(false);
    expect((await execGit(['rev-parse', '--verify', '--quiet', `refs/heads/${release.branch}`], repo, { ignoreExitCode: true })).exitCode).toBe(1);
    expect((await getBranchReconcileOutcome('app-1')).retired || []).toEqual([]);
    expect(existsSync(join(PATHS.cos, 'branch-retirement-archives'))).toBe(false);
  });

  it.each(['Git UI', 'daily cleanup'])('keeps a recreated %s checkout unsettled after in-place removal', async entryPoint => {
    const { release, unrelated, run } = await outsideCleanupFixture(entryPoint);
    const result = await run();
    if (entryPoint === 'Git UI') expect(result).toMatchObject({ deleted: [{ name: release.branch, local: 'deleted' }] });
    else expect(result).toMatchObject({ mergedReaped: 1, worktreesReaped: 0 });
    expect(existsSync(release.path)).toBe(false);
    const retired = await getBranchReconcileOutcome('app-1');
    expect(retired.retired).toEqual([expect.objectContaining({
      path: release.path, branch: release.branch, head: release.head,
      checkoutIdentity: release.checkoutIdentity, branchDeleted: true, archiveDir: null,
    })]);
    await execGit(['worktree', 'add', '-b', release.branch, release.path, release.head], repo);
    const recreated = {
      ...release,
      checkoutIdentity: await readRetirementCheckoutIdentity(release.path),
      reason: 'retirement-receipt-unverified',
    };
    expect(recreated.checkoutIdentity).not.toBe(release.checkoutIdentity);
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [recreated, unrelated] });
    const next = await recordBranchReconcileOutcome('app-1', { status: 'complete', remaining: [] });
    expect(next.retired).toEqual(retired.retired);
    expect(next.retirementObligations).toContainEqual(expect.objectContaining({
      path: recreated.path, head: recreated.head, checkoutIdentity: recreated.checkoutIdentity,
    }));
    expect(next.retirementObligations).toContainEqual(expect.objectContaining({ branch: unrelated.branch }));
    expect(existsSync(release.path)).toBe(true);
    expect(existsSync(join(PATHS.cos, 'branch-retirement-archives'))).toBe(false);
  });

  /** A published detached agent checkout that an earlier scan already inventoried. */
  async function detachedAgentFixture() {
    const remote = join(scratch, 'origin.git');
    await execGit(['init', '--bare', remote], scratch);
    await execGit(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);
    await execGit(['remote', 'add', 'origin', remote], repo);
    await execGit(['push', 'origin', 'main'], repo);
    await execGit(['fetch', 'origin'], repo);
    const agentId = `agent-${basename(scratch)}`;
    const path = join(PATHS.worktrees, agentId);
    await mkdir(dirname(path), { recursive: true });
    await execGit(['worktree', 'add', '--detach', path, 'main'], repo);
    const holder = (await (await import('./worktreeManager.js')).listWorktrees(repo)).find(tree => tree.detached && tree.path.endsWith(agentId));
    const release = { path: holder.path, head: holder.head, detached: true, managed: true,
      checkoutIdentity: await readRetirementCheckoutIdentity(path) };
    const unrelated = { branch: 'feature/unexplained', head: holder.head, reason: 'branch-held' };
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...release, reason: 'checkout-retained' }, unrelated] });
    return { agentId, path, release, unrelated };
  }

  it('settles direct removal of a detached agent checkout with a checkout-only receipt', async () => {
    const { agentId, path, release, unrelated } = await detachedAgentFixture();
    const { removeWorktree } = await import('./worktreeManager.js');
    expect(await removeWorktree(agentId, repo, 'cos/detached-follow-up')).toMatchObject({ removed: true });
    expect(existsSync(path)).toBe(false);
    const first = await getBranchReconcileOutcome('app-1');
    expect(first.retired).toEqual([expect.objectContaining({ path: release.path, head: release.head, checkoutIdentity: release.checkoutIdentity,
      branchDeleted: false, checkoutOnly: true, archiveDir: null })]);
    expect(first.retired[0]).not.toHaveProperty('branch');
    const next = await recordBranchReconcileOutcome('app-1', { status: 'complete', remaining: [] });
    expect(next.retirementObligations).toEqual([expect.objectContaining({ branch: unrelated.branch })]);
  });

  it('leaves a directly removed detached checkout unsettled when its receipt cannot be stored', async () => {
    const { agentId, path, release } = await detachedAgentFixture();
    const { removeWorktree } = await import('./worktreeManager.js');
    injected.failScheduleWrite = injected.scheduleWrites + 1;
    const result = await removeWorktree(agentId, repo, 'cos/detached-follow-up');
    expect(existsSync(path)).toBe(false);
    expect(result.warnings.join('\n')).toContain('Retirement receipt not recorded');
    expect((await getBranchReconcileOutcome('app-1')).retired || []).toEqual([]);
    const next = await recordBranchReconcileOutcome('app-1', { status: 'complete', remaining: [] });
    expect(next.retirementObligations).toContainEqual(expect.objectContaining({ path: release.path, reason: 'retirement-provenance-unverified' }));
  });

  it.each(['missing', 'ambiguous', 'unreadable'])('retains both cleanup entry points with %s app scope', async mode => {
    const { release, run } = await outsideCleanupFixture('Git UI');
    injected.apps = mode === 'missing' ? [] : mode === 'ambiguous' ? [injected.app, { ...injected.app, id: 'app-2' }] : new Error('synthetic registry unavailable');
    const reason = mode === 'missing' ? 'retirement-app-unavailable' : mode === 'ambiguous' ? 'retirement-app-ambiguous' : 'retirement-app-registry-unavailable';
    expect(await run()).toMatchObject({ deleted: [], skipped: [`cleanup (${reason})`] });
    expect(await (await import('./autonomousJobs/scriptHandlers.js')).agentDataCleanup()).toMatchObject({ mergedReaped: 0, worktreesReaped: 0, worktreeHold: reason });
    expect(existsSync(release.path)).toBe(true);
    expect((await execGit(['rev-parse', release.branch], repo)).stdout.trim()).toBe(release.head);
    expect((await getBranchReconcileOutcome('app-1')).retired || []).toEqual([]);
  });

});
