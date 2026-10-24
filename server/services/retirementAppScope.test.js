/** Exact retirement receipts at the Git UI and daily cleanup boundaries (#13405). */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, rm, readFile } from 'fs/promises';
import { existsSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import { execGit } from '../lib/execGit.js';
import { readRetirementCheckoutIdentity } from '../lib/retirementCheckoutObservation.js';
import { materializeGitRepo, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { PATHS } from '../lib/paths.js';

const injected = vi.hoisted(() => ({ app: null, apps: null, schedule: null, scheduleWrites: 0, failScheduleWrite: null }));
vi.mock('../lib/paths.js', async importOriginal => makePathsProxy(await importOriginal(), {
  dataRoot: () => realpathSync.native(lazyTempDataRoot('portos-cleanup-receipts-')),
  extraOverrides: () => ({ root: injected.app?.repoPath || lazyTempDataRoot('portos-cleanup-receipts-') }),
}));
afterAll(cleanupTempDataRoots);
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
    if (++injected.scheduleWrites === injected.failScheduleWrite) throw new Error('synthetic receipt persistence failure');
    return (await mutate(injected.schedule)).result;
  },
}));
const { recordBranchReconcileOutcome, getBranchReconcileOutcome } = await import('./taskSchedule.js');

describe.skipIf(SKIP_HEAVY_INTEGRATION)('outside reconciliation retirement receipts (real git)', () => {
  let scratch;
  let repo;
  beforeEach(async () => {
    Object.assign(injected, { app: null, apps: null, schedule: { tasks: {}, executions: {} }, scheduleWrites: 0, failScheduleWrite: null });
    scratch = realpathSync.native(await mkdtemp(join(tmpdir(), 'portos-cleanup-repo-')));
    await mkdir(join(scratch, 'repo'));
    await materializeGitRepo(join(scratch, 'repo'), { identity: { email: 'test@example.com', name: 'Test' } });
    repo = (await execGit(['rev-parse', '--show-toplevel'], join(scratch, 'repo'))).stdout.trim();
    injected.app = { id: 'app-1', repoPath: repo };
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const registered = async path => (await execGit(['worktree', 'list', '--porcelain'], repo)).stdout
    .split(/\r?\n/).includes(`worktree ${path.replaceAll('\\', '/')}`);

  it.each(['Git UI', 'daily cleanup'])('persists exact %s retirement before the next inventory scan', async entryPoint => {
    const { release, unrelated, run } = await outsideCleanupFixture(entryPoint);
    const result = await run();
    if (entryPoint === 'Git UI') expect(result).toMatchObject({ deleted: [{ name: release.branch, local: 'deleted' }], skipped: [] });
    else expect(result).toMatchObject({ mergedReaped: 1, worktreesReaped: 0 });
    expect(existsSync(release.path)).toBe(false);
    expect((await execGit(['rev-parse', '--verify', '--quiet', `refs/heads/${release.branch}`], repo, { ignoreExitCode: true })).exitCode).toBe(1);
    const first = await getBranchReconcileOutcome('app-1');
    expect(first.retired).toEqual([expect.objectContaining({ branch: release.branch, path: release.path, head: release.head,
      checkoutIdentity: release.checkoutIdentity, branchDeleted: true, archiveDir: expect.any(String) })]);
    const manifest = JSON.parse(await readFile(join(first.retired[0].archiveDir, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ repoPath: repo, branch: release.branch });
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

  it.each(['Git UI', 'daily cleanup'])('retains originals when %s cannot persist preservation, including the orphan fallback', async entryPoint => {
    const { release, run } = await outsideCleanupFixture(entryPoint);
    injected.failScheduleWrite = injected.scheduleWrites + 3;
    const result = await run();
    expect(entryPoint === 'Git UI' ? result.deleted : result.mergedReaped).toEqual(entryPoint === 'Git UI' ? [] : 0);
    if (entryPoint === 'daily cleanup') expect(result.worktreesReaped).toBe(0);
    expect(existsSync(release.path)).toBe(true);
    expect(await registered(release.path)).toBe(true);
    expect((await execGit(['rev-parse', release.branch], repo)).stdout.trim()).toBe(release.head);
    const outcome = await getBranchReconcileOutcome('app-1');
    expect(outcome.retired || []).toEqual([]);
    expect(outcome.retirementObligations, JSON.stringify(result)).toContainEqual(expect.objectContaining({ path: release.path, head: release.head }));
  });

  it.each(['Git UI', 'daily cleanup'])('keeps failed %s completion and a recreated checkout separate from its old archive', async entryPoint => {
    const { release, unrelated, run } = await outsideCleanupFixture(entryPoint);
    injected.failScheduleWrite = injected.scheduleWrites + 4;
    await run();
    expect(existsSync(release.path)).toBe(false);
    const failed = await getBranchReconcileOutcome('app-1');
    expect(failed.retired || []).toEqual([]);
    const obligation = failed.retirementObligations.find(row => row.path === release.path);
    expect(obligation.preservationReceipt.archiveDir).toBeTruthy();
    await execGit(['worktree', 'add', '-b', release.branch, release.path, release.head], repo);
    const recreated = { ...release, checkoutIdentity: await readRetirementCheckoutIdentity(release.path), reason: 'checkout-retained' };
    expect(recreated.checkoutIdentity).not.toBe(release.checkoutIdentity);
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [recreated, unrelated] });
    const next = await recordBranchReconcileOutcome('app-1', { status: 'complete', remaining: [] });
    expect(next.retired || []).toEqual([]);
    expect(next.retirementObligations).toContainEqual(expect.objectContaining({ path: recreated.path, head: recreated.head }));
    expect(next.retirementObligations).toContainEqual(expect.objectContaining({ branch: unrelated.branch }));
    expect(existsSync(release.path)).toBe(true);
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
