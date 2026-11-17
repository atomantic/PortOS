/**
 * Worktree ownership through branch-reconcile's real cleanup boundary (#10270).
 *
 * One real-Git contract per retirement outcome (retire, dirty, locked,
 * unmerged, unreadable status) and per destructive-path refusal (live owner,
 * changed head, unmerged work, holds that appear during removal). Every other
 * permutation of holder, head, merge, dirt, lock and owner is decided over
 * inspected state in branchRetirementDecision.test.js (#16115); add new
 * permutations there, and a case here only for a new outcome or boundary.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, appendFile, unlink } from 'fs/promises';
import { existsSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execGit } from '../lib/execGit.js';
import { attachBareOrigin, materializeGitRepo, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { captureCompletedCheckouts } from './completedCheckoutEvidence.js';
import { readRetirementCheckoutIdentity } from '../lib/retirementCheckoutObservation.js';

// Keep retirement I/O inside a test-owned data root, never the install's data tree.
vi.mock('../lib/paths.js', async importOriginal => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-reconcile-own-archives-'),
}));
afterAll(cleanupTempDataRoots);

const { injected, freshInjection } = vi.hoisted(() => {
  const fresh = () => ({ statusPath: null, beforeRemove: new Map(), owners: [], policies: [], app: null, schedule: { tasks: {}, executions: {} }, forge: {}, gitSpawns: [], gitInFlight: new Set() });
  return { injected: fresh(), freshInjection: fresh };
});
vi.mock('../lib/execGit.js', async (importOriginal) => {
  const actual = await importOriginal();
  const samePath = (a, b) => a?.replaceAll('\\', '/') === b?.replaceAll('\\', '/');
  return { ...actual, execGit: async (args, cwd, options) => {
    injected.gitSpawns.push({ args, cwd });
    // Git reports forward slashes even when path.join uses Windows separators.
    if (args[0] === 'status' && injected.statusPath && samePath(cwd, injected.statusPath)) {
      if (!options?.ignoreExitCode) throw new Error('synthetic unreadable index');
      return { stdout: '', stderr: 'synthetic unreadable index', exitCode: 128 };
    }
    // A hold that appears while Git removes a checkout, then a Git removal
    // failure that sends the removal down its manual fallback. Fires once per path.
    const removing = args[0] === 'worktree' && args[1] === 'remove' && [...injected.beforeRemove.keys()].find(path => args.some(arg => samePath(arg, path)));
    if (removing) {
      const before = injected.beforeRemove.get(removing);
      injected.beforeRemove.delete(removing);
      await before();
      throw new Error('synthetic Git removal failure');
    }
    const running = { args, startedAt: Date.now() };
    injected.gitInFlight.add(running);
    try {
      return await actual.execGit(args, cwd, options);
    } finally {
      injected.gitInFlight.delete(running);
    }
  } };
});
vi.mock('./apps.js', () => ({ getAllApps: async () => [injected.app], getAppById: async id => injected.app?.id === id ? injected.app : null }));
vi.mock('./taskScheduleStore.js', async importOriginal => ({
  ...await importOriginal(), loadSchedule: async () => injected.schedule,
  updateSchedule: async mutate => (await mutate(injected.schedule)).result,
}));
vi.mock('./cosState.js', () => ({
  readAgentsStateForSafetyCheck: async () => ({ trusted: injected.owners !== null,
    agents: injected.owners && Object.fromEntries(injected.owners.map(agent => [agent.id, agent])) }),
}));

// Use the real completion-policy evaluator with synthetic policy records.
vi.mock('./branchCompletionPolicy.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, readBranchCompletionPolicies: async () => injected.policies, readBranchCompletionHold: input => actual.readBranchCompletionHold(input, {
    readPolicies: async () => injected.policies,
  }) };
});

// The hermetic repo has no forge. A branch's merged PR is injected at the
// forge-read boundary: { head, mergedAt }, or 'unavailable' for a failed read.
vi.mock('./mergedPrEvidence.js', async (importOriginal) => ({
  ...await importOriginal(),
  findMergedPullRequest: async (repoPath, branch) => {
    const pr = injected.forge[branch];
    if (!pr || pr === 'unavailable') throw new Error('merged-pr-forge-unavailable');
    return { url: `https://github.com/example/repo/pull/${branch.split('-').at(-1)}`, mergedAt: pr.mergedAt };
  },
  readMergedPrDelivery: async (repoPath, branch, prUrl) => ({ prUrl, prHead: injected.forge[branch].head }),
}));

// Keep the run hermetic: the verdict ledger otherwise reads this install's
// real CoS data directory.
vi.mock('./supersededLedger.js', async (importOriginal) => ({
  ...await importOriginal(),
  readVerdictLedger: async () => [],
}));

const { reconcile, cleanupMerged, reapSupersededBranches } = await import('./branchReconcile.js');
const { reapMergedWorktrees } = await import('./worktreeManager.js');

// A reconcile pass is dozens of sequential real-Git spawns plus fixture setup, all
// inside Vitest's 30s test budget. A load-induced stall (#13459) otherwise surfaces
// as a bare timeout; name the stalled Git command before the budget expires.
const SLOW_REPORT_MS = 20_000;

describe.skipIf(SKIP_HEAVY_INTEGRATION)('branch-reconcile worktree ownership (real git)', () => {
  let scratch;
  let repo;
  let external;
  let slowReport;

  beforeEach(async () => {
    Object.assign(injected, freshInjection());
    slowReport = setTimeout(() => {
      const now = Date.now();
      const running = [...injected.gitInFlight].map(({ args, startedAt }) => `git ${args.slice(0, 3).join(' ')} (${now - startedAt}ms)`).join('; ') || 'none';
      console.log(`🐢 ownership test still running after ${SLOW_REPORT_MS}ms: ${injected.gitSpawns.length} git spawns, in flight: ${running}`);
    }, SLOW_REPORT_MS).unref();
    scratch = realpathSync(await mkdtemp(join(tmpdir(), 'portos-reconcile-own-')));
    const safeRepo = join(scratch, 'repo');
    await mkdir(safeRepo);
    await materializeGitRepo(safeRepo, { identity: { email: 'test@example.com', name: 'Test' } });
    repo = (await execGit(['rev-parse', '--show-toplevel'], safeRepo)).stdout.trim() || safeRepo;
    injected.app = { id: 'app-1', repoPath: repo };
    external = join(scratch, 'elsewhere');
    await mkdir(external);
  });
  afterEach(async () => {
    clearTimeout(slowReport);
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /** A clean checkout of a new branch at main — "merged" by ancestry alone. */
  async function addTree(path, branch) {
    await execGit(['worktree', 'add', '-b', branch, path, 'main'], repo);
    return path;
  }

  const branches = async () => (await execGit(['branch', '--format=%(refname:short)'], repo)).stdout.trim().split('\n');
  // Git expands Windows' short TEMP spelling and emits forward slashes; the
  // inventory promises Git's checkout path, not Node's fixture-input spelling.
  const gitCheckoutPath = async (path) => (await execGit(['rev-parse', '--show-toplevel'], path)).stdout.trim();

  // A real-Git `reconcile` is hundreds of serial Git spawns, and retiring even
  // one checkout re-verifies it ~100 times (that floor is the production
  // admission contract). The scenarios below therefore keep one retirement per
  // test; a single test holding every sibling exhausted the 30s budget when
  // pregate loaded the host (#13113).
  async function addCompletedClaim() {
    const root = join(repo, '.claude', 'worktrees');
    await mkdir(root, { recursive: true });
    const clean = await addTree(join(root, 'claim-issue-11'), 'claim/issue-11');
    const owner = { id: 'completed-claim', status: 'running', startedAt: new Date(Date.now() - 1000).toISOString(),
      metadata: { sourceWorkspace: repo, claimPicksOwnBranch: true, claimBranches: ['claim/issue-11'] } };
    const completedCheckouts = await captureCompletedCheckouts(owner, { success: true });
    expect(completedCheckouts).toHaveLength(1);
    injected.policies = [{ ...owner, status: 'completed', result: { success: true }, completedAt: new Date().toISOString(),
      metadata: { ...owner.metadata, completedCheckouts } }];
    return clean;
  }
  const reconcileWithoutOwners = () => reconcile(repo, {
    activeAgentIds: new Set(), claimOwners: { agents: [], readAgents: async () => [] },
  });

  it('retires a fresh claim with exact completion evidence while preserving a locked sibling', async () => {
    const root = join(repo, '.claude', 'worktrees');
    const locked = await addTree(join(root, 'claim-issue-12'), 'claim/issue-12');
    await execGit(['worktree', 'lock', locked], repo);
    const clean = await addCompletedClaim();

    injected.gitSpawns.length = 0;
    const log = vi.spyOn(console, 'log');
    const result = await reconcileWithoutOwners();
    const removals = log.mock.calls.map(([line]) => String(line)).filter(line => line.includes(': removed '));
    log.mockRestore();
    expect(result.cleaned).toEqual(['claim/issue-11']);
    expect(existsSync(clean)).toBe(false);
    // The removal names the checkout and the evidence that admitted it (#16618).
    expect(removals).toEqual([expect.stringMatching(/^🔀 branch-reconcile: remove worktree for claim\/issue-11: removed .*claim-issue-11 at [0-9a-f]{12} \(head contained in main\)$/)]);
    expect(result.skipped).toContainEqual(expect.objectContaining({ branch: 'claim/issue-12', reason: 'worktree-locked' }));
    expect(existsSync(locked)).toBe(true);
    expect(await branches()).toEqual(expect.arrayContaining(['claim/issue-12']));
    // Pinned spawn-count ceiling for single-checkout retirement (#13154):
    // Reduced from ~120 serial spawns down to <=105 by sharing Git reads inside
    // the critical section (e.g. 1 worktree list per admission, repo common-dir cache).
    expect(injected.gitSpawns.length).toBeLessThanOrEqual(105);
  });

  // Content and integration are re-proven at the destructive boundary, not taken
  // from the scan: the entry names only the branch, as the Git page passes it.
  it('refuses a merged checkout with uncommitted work and a branch with unmerged commits', async () => {
    const dirty = await addTree(join(external, 'dirty-merged'), 'fix/dirty-merged');
    await writeFile(join(dirty, 'unfinished.txt'), 'uncommitted feature work\n');
    const unmerged = await addTree(join(external, 'unmerged'), 'fix/unmerged');
    await writeFile(join(unmerged, 'committed.txt'), 'finish this work\n');
    await execGit(['add', 'committed.txt'], unmerged);
    await execGit(['commit', '-m', 'feat: unfinished work'], unmerged);
    const unmergedHead = (await execGit(['rev-parse', 'HEAD'], unmerged)).stdout.trim();

    const result = await cleanupMerged(repo, 'main', [{ branch: 'fix/dirty-merged' }, { branch: 'fix/unmerged' }], { activeAgentIds: new Set() });

    expect(result.cleaned).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ branch: 'fix/dirty-merged', reason: 'worktree-dirty' }),
      { branch: 'fix/unmerged', reason: 'not-merged-on-recheck' },
    ]);
    expect((await execGit(['status', '--porcelain'], dirty)).stdout).toContain('unfinished.txt');
    expect((await execGit(['rev-parse', 'HEAD'], unmerged)).stdout.trim()).toBe(unmergedHead);
    expect(await branches()).toEqual(expect.arrayContaining(['fix/dirty-merged', 'fix/unmerged']));
  });

  // A superseded verdict is never permission on its own: the head it was
  // recorded against and a readable checkout are re-proven before removal.
  it('refuses a superseded verdict once the branch head moved past it or its checkout is unreadable', async () => {
    const moved = 'fix/superseded-moved';
    const movedPath = await addTree(join(repo, '.claude', 'worktrees', 'superseded-moved'), moved);
    const movedTip = (await execGit(['rev-parse', moved], repo)).stdout.trim();
    await writeFile(join(movedPath, 'later.txt'), 'work committed after the verdict\n');
    await execGit(['add', 'later.txt'], movedPath);
    await execGit(['commit', '-m', 'feat: later work'], movedPath);
    const movedHead = (await execGit(['rev-parse', 'HEAD'], movedPath)).stdout.trim();
    const unreadable = 'fix/superseded-unreadable';
    const unreadablePath = await addTree(join(repo, '.claude', 'worktrees', 'superseded'), unreadable);
    await writeFile(join(unreadablePath, 'unfinished.txt'), 'preserve before backup\n');
    const unreadableTip = (await execGit(['rev-parse', unreadable], repo)).stdout.trim();
    injected.statusPath = unreadablePath;

    const result = await reapSupersededBranches(repo, 'main', [{
      branch: moved, tip: movedTip, worktreePath: await gitCheckoutPath(movedPath), worktreeLocked: false, dirtyPaths: [],
      verdict: { branch: moved, tip: movedTip, verdict: 'SUPERSEDED', dirtyPaths: [] },
    }, {
      branch: unreadable, tip: unreadableTip, worktreePath: unreadablePath, dirtyPaths: ['unfinished.txt'],
      verdict: { branch: unreadable, tip: unreadableTip, verdict: 'SUPERSEDED', dirtyPaths: ['unfinished.txt'] },
    }], { cosDir: join(scratch, 'cos') });

    expect(result.reaped).toEqual([]);
    expect(result.skipped).toEqual([
      { branch: moved, reason: 'branch-head-changed' },
      { branch: unreadable, reason: 'worktree-status-unavailable' },
    ]);
    expect((await execGit(['rev-parse', moved], repo)).stdout.trim()).toBe(movedHead);
    expect(existsSync(join(movedPath, 'later.txt'))).toBe(true);
    expect(existsSync(join(unreadablePath, 'unfinished.txt'))).toBe(true);
    expect(await branches()).toEqual(expect.arrayContaining([moved, unreadable]));
  });

  // Ownership is re-read at the destructive boundary: neither a ref the caller
  // already judged merged nor an empty caller snapshot grants retirement.
  it('holds a newly reserved branch for its current owner, including past a stale empty snapshot', async () => {
    const reserved = 'fix/newly-reserved';
    await execGit(['branch', reserved, 'main'], repo);
    const claimed = 'fix/stale-owner-snapshot';
    const path = await addTree(join(repo, '.claude', 'worktrees', 'snapshot'), claimed);
    injected.owners = [{ id: 'coordinator', status: 'running', metadata: { sourceWorkspace: repo, claimBranches: [reserved, claimed] } }];

    const direct = await cleanupMerged(repo, 'main', [{ branch: reserved, upstreamGone: true }]);
    const stale = await cleanupMerged(repo, 'main', [{ branch: claimed, upstreamGone: true }], { claimOwners: { agents: [] } });

    expect(direct).toMatchObject({ cleaned: [], skipped: [{ branch: reserved, reason: 'claim-owner-active' }] });
    expect(stale).toMatchObject({ cleaned: [], skipped: [{ branch: claimed, reason: 'claim-owner-active' }] });
    expect(existsSync(path)).toBe(true);
    expect(await branches()).toEqual(expect.arrayContaining([reserved, claimed]));
  });

  // Reconcile's first step. A Git removal failure falls back to a manual
  // removal, which must re-prove every hold that may have appeared meanwhile.
  it('preserves each tree whose new owner, lock or status failure appears before the early reaper fallback', async () => {
    const root = join(repo, '.claude', 'worktrees');
    const trees = {};
    for (const change of ['owner', 'lock', 'status']) trees[change] = await addTree(join(root, `fallback-${change}`), `fix/fallback-${change}`);
    injected.beforeRemove.set(trees.owner, async () => { injected.owners = [{ id: 'agent-new-owner', status: 'running', workspacePath: trees.owner }]; });
    injected.beforeRemove.set(trees.lock, () => execGit(['worktree', 'lock', trees.lock], repo));
    injected.beforeRemove.set(trees.status, async () => { injected.statusPath = trees.status; });

    const result = await reapMergedWorktrees(repo, { activeAgentIds: new Set(), claimOwners: { agents: [], readAgents: async () => injected.owners } });

    expect(injected.beforeRemove.size).toBe(0);
    expect(result.reaped).toEqual([]);
    const registration = (await execGit(['worktree', 'list', '--porcelain'], repo)).stdout;
    for (const [change, reason] of [['owner', 'claim-owner-active'], ['lock', 'worktree-locked'], ['status', 'worktree-status-unavailable']]) {
      const path = trees[change];
      expect(existsSync(path)).toBe(true);
      expect(registration.split(/\r?\n/)).toContain(`worktree ${path.replaceAll('\\', '/')}`);
      expect(result.skipped).toContainEqual(expect.objectContaining({ branch: `fix/fallback-${change}`, reason }));
    }
    expect(registration).toMatch(/fallback-lock\nHEAD [a-f0-9]+\nbranch refs\/heads\/fix\/fallback-lock\nlocked/);
    expect(await branches()).toEqual(expect.arrayContaining(['fix/fallback-owner', 'fix/fallback-lock', 'fix/fallback-status']));
  });

  // Detached retirement settles a checkout-only receipt, and the receipt is
  // bound to that checkout's identity rather than its path (#13405).
  it('retires a clean detached checkout without letting a recreated same-path checkout borrow its receipt', async () => {
    const outcomes = await import('./branchReconcileOutcome.js');
    const path = join(repo, '.claude', 'worktrees', 'clean-detached');
    await execGit(['worktree', 'add', '--detach', path, 'main'], repo);
    const head = (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim();
    const release = { path: await gitCheckoutPath(path), head, detached: true, managed: true, checkoutIdentity: await readRetirementCheckoutIdentity(path) };
    const unrelated = { branch: 'feature/unexplained', head, reason: 'branch-held' };
    await outcomes.recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...release, reason: 'checkout-retained' }, unrelated] });

    const result = await reconcile(repo, { activeAgentIds: new Set(), claimOwners: { agents: [], readAgents: async () => [] }, appId: 'app-1' });
    expect(result.cleaned).toContain(release.path);
    expect(existsSync(path)).toBe(false);
    const { retired } = await outcomes.getBranchReconcileOutcome('app-1');
    expect(retired).toEqual([expect.objectContaining({ path: release.path, head, checkoutIdentity: release.checkoutIdentity,
      branchDeleted: false, checkoutOnly: true, archiveDir: null })]);
    expect(retired[0]).not.toHaveProperty('branch');

    await execGit(['worktree', 'add', '--detach', path, 'main'], repo);
    const recreated = { ...release, checkoutIdentity: await readRetirementCheckoutIdentity(path), reason: 'retirement-receipt-unverified' };
    expect(recreated.checkoutIdentity).not.toBe(release.checkoutIdentity);
    await outcomes.recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [recreated, unrelated] });
    const next = await outcomes.getBranchReconcileInventory('app-1');
    expect(next.retired).toEqual(retired);
    expect(next.remaining).toContainEqual(recreated);
    expect(next).not.toHaveProperty('retirementObligations');
    expect(existsSync(path)).toBe(true);
  });

  // A `/do:next` claim: a sibling checkout on a pushed branch that has no
  // commits yet. Its head equals main, so ancestry alone reads it as merged;
  // reconcile used to retire it and delete the local branch (#16625).
  it('holds a fresh published sibling claim checkout that has no commits of its own', async () => {
    await attachBareOrigin(scratch, repo);
    const sibling = await addTree(join(scratch, 'next-issue-7'), 'next/issue-7');
    await execGit(['push', '-u', 'origin', 'next/issue-7'], sibling);

    const result = await reconcileWithoutOwners();

    expect(result.cleaned).toEqual([]);
    expect(result.skipped).toContainEqual(expect.objectContaining({ branch: 'next/issue-7', reason: 'branch-has-no-own-commits' }));
    expect(existsSync(sibling)).toBe(true);
    expect((await execGit(['worktree', 'list', '--porcelain'], repo)).stdout).toContain(`branch refs/heads/next/issue-7`);
    expect(await branches()).toContain('next/issue-7');
  });

  it('preserves a prunable checkout whose missing pointer makes Git report the parent clean', async () => {
    await appendFile(join(repo, '.git', 'info', 'exclude'), '\n.claude/\n');
    const path = await addTree(join(repo, '.claude', 'worktrees', 'broken'), 'fix/broken');
    await writeFile(join(path, 'unique.txt'), 'uncommitted work\n');
    await unlink(join(path, '.git'));
    expect((await execGit(['status', '--porcelain'], path)).stdout).toBe('');
    expect((await execGit(['worktree', 'list', '--porcelain'], repo)).stdout).toContain('prunable');
    const result = await reconcile(repo, { activeAgentIds: new Set() });
    expect(result.cleaned).toEqual([]);
    expect(result.skipped).toContainEqual(expect.objectContaining({ branch: 'fix/broken', reason: 'worktree-status-unavailable' }));
    expect(existsSync(join(path, 'unique.txt'))).toBe(true);
    expect(await branches()).toContain('fix/broken');
  });
});
