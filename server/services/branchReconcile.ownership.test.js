/**
 * Worktree ownership through branch-reconcile's real cleanup boundary (#10270).
 *
 * A checkout freshly cut from the default branch is clean and an ancestor of
 * it, so the merged-branch cleanup used to retire it — and its branch — while
 * the process that created it was still running. These tests drive `reconcile`
 * against a real throwaway repository (no forge is consulted) to pin that only
 * PortOS-managed roots are retired unattended. The Git page's merged-branch
 * action shares those ownership gates; external checkouts need scoped release.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, onTestFailed, vi } from 'vitest';
import { mkdtemp, mkdir, rm, utimes, writeFile, appendFile, unlink } from 'fs/promises';
import { existsSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execGit } from '../lib/execGit.js';
import { materializeGitRepo, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { captureCompletedCheckouts } from './completedCheckoutEvidence.js';
import { readRetirementCheckoutIdentity } from '../lib/retirementCheckoutObservation.js';

// Keep retirement I/O inside a test-owned data root, never the install's data tree.
vi.mock('../lib/paths.js', async importOriginal => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-reconcile-own-archives-'),
}));
const pendingPhases = new Set();
afterAll(async () => {
  await Promise.all(pendingPhases);
  await cleanupTempDataRoots();
});

const injected = vi.hoisted(() => ({ statusPath: null, statusThrows: false, beforeRemove: null, owners: [], policies: [], app: null, schedule: { tasks: {}, executions: {} }, failScheduleWrite: false, forge: {}, gitSpawns: [], gitInFlight: new Set(), phase: null }));
vi.mock('../lib/execGit.js', async (importOriginal) => {
  const actual = await importOriginal();
  const observe = run => async (args, cwd, options) => {
    const phase = injected.phase;
    if (!phase) return run(args, cwd, options);
    phase.signal.throwIfAborted();
    if (phase.closed) throw new Error(`Manual claim ${phase.name} already settled`);
    const remaining = 30000 - (performance.now() - phase.started);
    if (remaining <= 0) throw new Error(`Manual claim ${phase.name} exceeded its 30s deadline`);
    const command = ['worktree', 'bundle', 'remote'].includes(args[0]) ? args.slice(0, 2).join(' ') : args[0];
    const pending = { command, started: performance.now() };
    phase.pending.add(pending);
    try {
      const operation = run(args, cwd, { ...options, timeout: Math.min(options?.timeout || 30000, remaining) });
      pending.settled = operation.then(() => {}, () => {});
      return await operation;
    }
    finally {
      phase.pending.delete(pending);
      const ms = performance.now() - pending.started;
      const row = phase.commands.get(command) || { count: 0, ms: 0, maxMs: 0 };
      row.count++;
      row.ms += ms;
      row.maxMs = Math.max(row.maxMs, ms);
      phase.commands.set(command, row);
    }
  };
  return { ...actual, execGit: async (args, cwd, options) => {
    injected.gitSpawns.push({ args, cwd });
    // Git reports forward slashes even when path.join uses Windows separators.
    if (args[0] === 'status' && injected.statusPath && cwd?.replaceAll('\\', '/') === injected.statusPath.replaceAll('\\', '/')) {
      if (injected.statusThrows || !options?.ignoreExitCode) throw new Error('synthetic unreadable index');
      return { stdout: '', stderr: 'synthetic unreadable index', exitCode: 128 };
    }
    if (args[0] === 'worktree' && args[1] === 'remove' && injected.beforeRemove) {
      const before = injected.beforeRemove;
      injected.beforeRemove = null;
      await before();
      throw new Error('synthetic Git removal failure');
    }
    const running = { args, startedAt: Date.now() };
    injected.gitInFlight.add(running);
    try {
      return await observe(actual.execGit)(args, cwd, options);
    } finally {
      injected.gitInFlight.delete(running);
    }
  }, execGitSafe: observe(actual.execGitSafe) };
});
vi.mock('./apps.js', () => ({ getAllApps: async () => [injected.app], getAppById: async id => injected.app?.id === id ? injected.app : null }));
vi.mock('./taskScheduleStore.js', async importOriginal => ({
  ...await importOriginal(), loadSchedule: async () => injected.schedule,
  updateSchedule: async mutate => {
    if (injected.failScheduleWrite) throw new Error('synthetic receipt persistence failure');
    return (await mutate(injected.schedule)).result;
  },
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
vi.mock('./heldCheckoutReview.js', async (importOriginal) => ({
  ...await importOriginal(),
  findMergedPullRequest: async (repoPath, branch) => {
    const pr = injected.forge[branch];
    if (!pr || pr === 'unavailable') throw new Error('retirement-forge-unavailable');
    return { url: `https://github.com/example/repo/pull/${branch.split('-').at(-1)}`, mergedAt: pr.mergedAt };
  },
  readRetirementForgeEvidence: async (repoPath, branch, prUrl) => ({ prUrl, prHead: injected.forge[branch].head }),
}));

// Keep the run hermetic: the verdict ledger otherwise reads this install's
// real CoS data directory.
vi.mock('./supersededLedger.js', async (importOriginal) => ({
  ...await importOriginal(),
  readVerdictLedger: async () => [],
}));

const { reconcile, gatherBranchState, classifyBranches, cleanupMerged, reapSupersededBranches, describeIdleReconcilePark } = await import('./branchReconcile.js');
const { clearAgentDispatching, getActiveAgentIds, markAgentDispatching } = await import('./agentState.js');
const { deleteMergedBranches } = await import('./git.js');
const { PATHS } = await import('../lib/paths.js');

const DAY = 24 * 60 * 60 * 1000;
// A reconcile pass is ~55 sequential real-Git spawns plus fixture setup, all inside
// Vitest's 30s test budget. A load-induced stall (#13459) otherwise surfaces as a bare
// timeout; name the stalled Git command before the budget expires.
const SLOW_REPORT_MS = 20_000;

describe.skipIf(SKIP_HEAVY_INTEGRATION)('branch-reconcile worktree ownership (real git)', () => {
  let scratch;
  let repo;
  let external;
  let slowReport;

  beforeEach(async () => {
    await Promise.all(pendingPhases);
    Object.assign(injected, { statusPath: null, statusThrows: false, beforeRemove: null, owners: [], policies: [], app: null, schedule: { tasks: {}, executions: {} }, failScheduleWrite: false, forge: {}, gitSpawns: [], gitInFlight: new Set(), phase: null });
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
    // Vitest timeouts do not settle the hook/body promise. Never erase a repo
    // while a timed-out phase still has a Git command or continuation using it.
    await Promise.all(pendingPhases);
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  function phaseSummary(phase) {
    const commands = [...phase.commands].sort((a, b) => b[1].ms - a[1].ms);
    return { phase: phase.name, ms: Math.round((phase.finished ?? performance.now()) - phase.started),
      gitCalls: commands.reduce((sum, [, row]) => sum + row.count, 0),
      commands: commands.slice(0, 5).map(([command, row]) => ({ command, count: row.count, ms: Math.round(row.ms), maxMs: Math.round(row.maxMs) })),
      pending: [...phase.pending].slice(0, 5).map(row => ({ command: row.command, ms: Math.round(performance.now() - row.started) })) };
  }

  function runPhase(name, signal, work) {
    const phase = { name, signal, started: performance.now(), commands: new Map(), pending: new Set() };
    injected.phase = phase;
    // stderr survives pregate's console suppression, including a hook timeout.
    onTestFailed(() => process.stderr.write(`Manual claim diagnostic: ${JSON.stringify(phaseSummary(phase))}\n`));
    const run = Promise.resolve().then(work).finally(async () => {
      // A rejected Promise.all can leave sibling Git calls running. Close the
      // phase to new spawns, then join those calls before releasing its fixture.
      phase.closed = true;
      await Promise.all([...phase.pending].map(row => row.settled));
      phase.finished = performance.now();
      process.stderr.write(`Manual claim diagnostic: ${JSON.stringify(phaseSummary(phase))}\n`);
    });
    const settled = run.then(() => {}, () => {});
    pendingPhases.add(settled);
    settled.then(() => pendingPhases.delete(settled));
    return run;
  }

  /** A clean checkout of a new branch at main — "merged" by ancestry alone. */
  async function addTree(path, branch, { ageMs = 0 } = {}) {
    await execGit(['worktree', 'add', '-b', branch, path, 'main'], repo);
    if (ageMs) {
      const then = new Date(Date.now() - ageMs);
      await utimes(path, then, then);
    }
    return path;
  }

  const branches = async () => (await execGit(['branch', '--format=%(refname:short)'], repo)).stdout.trim().split('\n');
  // Git expands Windows' short TEMP spelling and emits forward slashes; the
  // inventory promises Git's checkout path, not Node's fixture-input spelling.
  const gitCheckoutPath = async (path) => (await execGit(['rev-parse', '--show-toplevel'], path)).stdout.trim();

  // Operator cleanup independently verifies the remote's advertised default.
  // A bare fixture's default HEAD otherwise points at an unborn master branch.
  async function addOrigin() {
    const remote = join(scratch, 'origin.git');
    await execGit(['init', '--bare', remote], scratch);
    await execGit(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);
    await execGit(['remote', 'add', 'origin', remote], repo);
    await execGit(['push', 'origin', 'main'], repo);
  }

  it('reports an unmerged detached checkout without discarding its tracked, untracked or ignored content', async () => {
    const path = await addTree(join(external, 'detached-work'), 'temporary-work');
    await writeFile(join(path, 'tracked.txt'), 'unique committed work\n');
    await writeFile(join(path, '.gitignore'), 'ignored.txt\n');
    await execGit(['add', 'tracked.txt', '.gitignore'], path);
    await execGit(['commit', '-m', 'feat: synthetic detached work'], path);
    const head = (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim();
    await execGit(['checkout', '--detach'], path);
    await execGit(['branch', '-D', 'temporary-work'], repo);
    await writeFile(join(path, 'untracked.txt'), 'unique untracked work\n');
    await writeFile(join(path, 'ignored.txt'), 'unique ignored work\n');
    await execGit(['worktree', 'lock', '--reason', 'explicit owner handoff required', path], repo);

    const checkoutIdentity = await readRetirementCheckoutIdentity(path);
    expect(checkoutIdentity).toMatch(/^[a-f0-9]{64}$/);
    const observationStartedAt = Date.now();
    const result = await reconcile(repo, { activeAgentIds: new Set() });
    const observationFinishedAt = Date.now();
    expect(result.detachedWorktrees).toEqual([]); // old merged-only projection cannot see it
    const report = describeIdleReconcilePark(result.skipped, [], { worktreeInventory: result.worktreeInventory });
    expect(report.remaining).toEqual([{
      path: await gitCheckoutPath(path), head, detached: true, locked: true, lockReason: 'explicit owner handoff required',
      managed: false, reason: 'worktree-locked', checkoutIdentity, observedAt: expect.any(String),
    }]);
    const observedAt = Date.parse(report.remaining[0].observedAt);
    expect(observedAt).toBeGreaterThanOrEqual(observationStartedAt);
    expect(observedAt).toBeLessThanOrEqual(observationFinishedAt);
    expect(report.remaining[0].observedAt).toBe(new Date(observedAt).toISOString());
    for (const name of ['tracked.txt', 'untracked.txt', 'ignored.txt']) expect(existsSync(join(path, name))).toBe(true);
    expect((await execGit(['rev-parse', 'HEAD'], path)).stdout.trim()).toBe(head);
  });

  it('preserves unmanaged and unverified manual checkouts regardless of age', async () => {
    const claudeRoot = join(repo, '.claude', 'worktrees');
    await mkdir(claudeRoot, { recursive: true });
    const fresh = await addTree(join(external, 'release-preparation'), 'release-prep/v9.9.9');
    const old = await addTree(join(external, 'old-workspace'), 'old-workspace', { ageMs: 30 * DAY });
    const staleClaim = await addTree(join(claudeRoot, 'claim-issue-5'), 'claim/issue-5', { ageMs: 30 * DAY });
    const lockedClaim = await addTree(join(claudeRoot, 'claim-issue-6'), 'claim/issue-6', { ageMs: 30 * DAY });
    await execGit(['worktree', 'lock', '--reason', 'await scoped owner release', lockedClaim], repo);
    const dirtyClaim = await addTree(join(claudeRoot, 'claim-issue-7'), 'claim/issue-7');
    await writeFile(join(dirtyClaim, 'wip.txt'), 'unsaved\n');
    await utimes(dirtyClaim, new Date(Date.now() - 30 * DAY), new Date(Date.now() - 30 * DAY));
    const staleClaimPath = await gitCheckoutPath(staleClaim);

    const result = await reconcile(repo, { activeAgentIds: new Set() });
    const reasonFor = (branch) => result.skipped.find((s) => s.branch === branch)?.reason;
    const context = JSON.stringify({ cleaned: result.cleaned, skipped: result.skipped });

    // Unmanaged: held at any age, checkout AND branch intact.
    expect(reasonFor('release-prep/v9.9.9'), context).toBe('worktree-unmanaged-location');
    expect(reasonFor('old-workspace'), context).toBe('worktree-unmanaged-location');
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(old)).toBe(true);

    // Age and registry absence do not prove a manual claim finished.
    expect(result.cleaned, context).not.toContain('claim/issue-5');
    expect(reasonFor('claim/issue-5'), context).toBe('claim-completion-unverified');
    expect(result.merged).toContainEqual(expect.objectContaining({ branch: 'claim/issue-5', state: 'MERGED' }));
    expect(existsSync(staleClaim)).toBe(true);
    expect(reasonFor('claim/issue-6'), context).toBe('worktree-locked');
    expect(existsSync(lockedClaim)).toBe(true);
    const report = describeIdleReconcilePark(result.skipped, [], {
      wip: result.wip, worktreeInventory: result.worktreeInventory,
    });
    expect(report.remaining).toContainEqual(expect.objectContaining({
      branch: 'claim/issue-6', path: await gitCheckoutPath(lockedClaim), reason: 'worktree-locked',
      head: expect.any(String), locked: true, lockReason: 'await scoped owner release', managed: true,
    }));
    expect(report.remaining).toContainEqual(expect.objectContaining({
      branch: 'old-workspace', path: await gitCheckoutPath(old), reason: 'worktree-unmanaged-location', managed: false,
    }));
    expect(report.remaining).toContainEqual(expect.objectContaining({
      path: staleClaimPath, branch: 'claim/issue-5', reason: 'claim-completion-unverified',
    }));
    expect(result.cleaned, context).not.toContain('claim/issue-7');
    expect(existsSync(dirtyClaim)).toBe(true);

    const left = await branches();
    expect(left).toEqual(expect.arrayContaining(['release-prep/v9.9.9', 'old-workspace', 'claim/issue-6', 'claim/issue-7']));
    expect(left).toContain('claim/issue-5');
  });

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
    const result = await reconcileWithoutOwners();
    expect(result.cleaned).toEqual(['claim/issue-11']);
    expect(existsSync(clean)).toBe(false);
    expect(result.skipped).toContainEqual(expect.objectContaining({ branch: 'claim/issue-12', reason: 'worktree-locked' }));
    expect(existsSync(locked)).toBe(true);
    expect(await branches()).toEqual(expect.arrayContaining(['claim/issue-12']));
    // Pinned spawn-count ceiling for single-checkout retirement (#13154):
    // Reduced from ~120 serial spawns down to <=105 by sharing Git reads inside
    // the critical section (e.g. 1 worktree list per admission, repo common-dir cache).
    expect(injected.gitSpawns.length).toBeLessThanOrEqual(105);
  });

  it('holds a claim checkout with uncommitted or unmerged work', async () => {
    const root = join(repo, '.claude', 'worktrees');
    const dirty = await addTree(join(root, 'claim-issue-13'), 'claim/issue-13');
    await writeFile(join(dirty, 'unfinished.txt'), 'preserve this work\n');
    const unmerged = await addTree(join(root, 'claim-issue-14'), 'claim/issue-14');
    await writeFile(join(unmerged, 'committed.txt'), 'finish this work\n');
    await execGit(['add', 'committed.txt'], unmerged);
    await execGit(['commit', '-m', 'feat: unfinished work'], unmerged);

    const result = await reconcileWithoutOwners();
    expect(result.cleaned).toEqual([]);
    expect(result.inFlight).toEqual(expect.arrayContaining([
      expect.objectContaining({ branch: 'claim/issue-13', state: 'ABANDONED_WIP' }),
    ]));
    // This hermetic repo has no forge, so committed work is held until PR state
    // can be established rather than being retired as merged.
    expect(result.wip).toContainEqual(expect.objectContaining({ branch: 'claim/issue-14' }));
    for (const path of [dirty, unmerged]) expect(existsSync(path)).toBe(true);
    expect(existsSync(join(dirty, 'unfinished.txt'))).toBe(true);
    expect(await branches()).toEqual(expect.arrayContaining(['claim/issue-13', 'claim/issue-14']));
  });

  // A manual /claim: commit in the checkout, merge it into main, leave the tree
  // under the managed root, and have the forge report the merge (#12849).
  const HOUR = 60 * 60 * 1000;
  const mergedLongAgo = () => new Date(Date.now() - 3 * HOUR).toISOString();
  async function addManualClaim(n, { merge = true, ageMs = 2 * HOUR } = {}) {
    const root = join(repo, '.claude', 'worktrees');
    await mkdir(root, { recursive: true });
    const branch = `claim/issue-${n}`;
    const path = await addTree(join(root, `claim-issue-${n}`), branch);
    await writeFile(join(path, `work-${n}.txt`), `issue ${n}\n`);
    await execGit(['add', `work-${n}.txt`], path);
    await execGit(['commit', '-m', `feat: issue ${n}`], path);
    const head = (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim();
    if (merge) await execGit(['merge', '--no-ff', '-m', `Merge ${branch}`, branch], repo);
    if (ageMs) await utimes(path, new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
    injected.forge[branch] = { head, mergedAt: mergedLongAgo() };
    return { branch, path, head };
  }
  const reconcileManualClaims = () => reconcile(repo, {
    activeAgentIds: new Set(), claimOwners: { agents: injected.owners, readAgents: async () => injected.owners },
  });
  const expectHeld = async (held) => {
    for (const { path } of held) expect(existsSync(path)).toBe(true);
    expect(await branches()).toEqual(expect.arrayContaining(held.map(claim => claim.branch)));
  };

  describe('manual claim retirement with an active sibling', () => {
    let shipped;
    let owned;
    // #13473 retained a 31.445s failure under three-worker pregate. Its single
    // passing A/B did not diagnose the cause. Give fixture construction and the
    // public action their existing, separate 30s hook/test budgets; per-command
    // diagnostics and the remaining phase deadline keep a hang visible/bounded.
    beforeEach(({ signal }) => runPhase('fixture', signal, async () => {
      shipped = await addManualClaim(21);
      owned = await addManualClaim(24);
      injected.owners = [{ id: 'agent-live-claim', status: 'running', sourceWorkspace: repo, workspacePath: repo,
        metadata: { sourceWorkspace: repo, claimBranches: [owned.branch] } }];
    }));

    it('retires a forge-merged manual claim without a run receipt while an actively owned sibling stays (#12849)', ({ signal }) => runPhase('reconcile and preservation assertions', signal, async () => {
      const result = await reconcileManualClaims();
      const context = JSON.stringify({ cleaned: result.cleaned, skipped: result.skipped });
      expect(result.cleaned, context).toEqual([shipped.branch]);
      expect(existsSync(shipped.path)).toBe(false);
      expect(await branches()).not.toContain(shipped.branch);
      // #13519 replaced archival with archive-free merged cleanup. The exact
      // completed ref still protects recovery inside the original repository.
      for (const directory of ['branch-retirement-archives', 'initialized-checkout-retirements']) {
        expect(existsSync(join(PATHS.cos, directory))).toBe(false);
      }
      expect((await execGit(['rev-parse', `refs/portos/completed/${shipped.head}`], repo)).stdout.trim()).toBe(shipped.head);
      expect(result.skipped.find(row => row.branch === owned.branch)?.reason, context).toBe('claim-owner-active');
      await expectHeld([owned]);
      expect((await execGit(['rev-parse', 'HEAD'], owned.path)).stdout.trim()).toBe(owned.head);
    }));
  });

  it('holds a merged manual claim that is dirty or locked (#12849)', async () => {
    const dirty = await addManualClaim(22);
    await writeFile(join(dirty.path, 'unsaved.txt'), 'preserve\n');
    await utimes(dirty.path, new Date(Date.now() - 2 * HOUR), new Date(Date.now() - 2 * HOUR));
    const locked = await addManualClaim(23);
    await execGit(['worktree', 'lock', locked.path], repo);

    const result = await reconcileManualClaims();
    const context = JSON.stringify({ cleaned: result.cleaned, skipped: result.skipped });
    expect(result.cleaned, context).toEqual([]);
    expect(result.skipped.find(row => row.branch === locked.branch)?.reason, context).toBe('worktree-locked');
    expect(result.inFlight).toContainEqual(expect.objectContaining({ branch: dirty.branch, state: 'ABANDONED_WIP' }));
    expect(existsSync(join(dirty.path, 'unsaved.txt'))).toBe(true);
    await expectHeld([dirty, locked]);
  });

  it('holds a manual claim whose merge the forge cannot prove for its exact head (#12849)', async () => {
    const unmerged = await addManualClaim(25, { merge: false });
    const forgeDown = await addManualClaim(26);
    injected.forge[forgeDown.branch] = 'unavailable';
    const otherHead = await addManualClaim(27);
    injected.forge[otherHead.branch] = { head: 'f'.repeat(40), mergedAt: mergedLongAgo() };

    const result = await reconcileManualClaims();
    const context = JSON.stringify({ cleaned: result.cleaned, skipped: result.skipped });
    expect(result.cleaned, context).toEqual([]);
    const reasonFor = branch => result.skipped.find(row => row.branch === branch)?.reason;
    for (const held of [forgeDown, otherHead]) expect(reasonFor(held.branch), context).toBe('claim-completion-unverified');
    expect(result.wip).toContainEqual(expect.objectContaining({ branch: unmerged.branch }));
    await expectHeld([unmerged, forgeDown, otherHead]);
  });

  it('holds a forge-merged manual claim that was merged or created too recently to retire (#12849)', async () => {
    const justMerged = await addManualClaim(28);
    injected.forge[justMerged.branch].mergedAt = new Date().toISOString();
    const young = await addManualClaim(29, { ageMs: 0 });

    const result = await reconcileManualClaims();
    const context = JSON.stringify({ cleaned: result.cleaned, skipped: result.skipped });
    expect(result.cleaned, context).toEqual([]);
    for (const held of [justMerged, young]) expect(result.skipped.find(row => row.branch === held.branch)?.reason, context).toBe('claim-completion-unverified');
    await expectHeld([justMerged, young]);
  });

  it('holds a clean agent tree at the default HEAD while its dispatch is still registering (#11775)', async () => {
    const root = join(repo, '.claude', 'worktrees');
    await mkdir(root, { recursive: true });
    const tree = await addTree(join(root, 'agent-dispatching'), 'agent/dispatching');
    markAgentDispatching('agent-dispatching');
    try {
      const held = await reconcile(repo, { activeAgentIds: new Set(getActiveAgentIds()) });
      expect(held.cleaned).not.toContain('agent/dispatching');
      expect(held.skipped).toContainEqual(expect.objectContaining({ branch: 'agent/dispatching', reason: 'worktree-active-agent' }));
      expect(existsSync(tree)).toBe(true);
    } finally {
      clearAgentDispatching('agent-dispatching');
    }
    // Once dispatch settles without registering an owner, the same tree is reaped.
    const reaped = await reconcile(repo, { activeAgentIds: new Set(getActiveAgentIds()) });
    expect(reaped.cleaned).toContain('agent/dispatching');
    expect(existsSync(tree)).toBe(false);
  });

  // #12990: omitted ids used to become `new Set(null)` — "nobody running" — so an
  // agent tree in its dispatch-registration window was retired by the default call.
  it('holds an agent tree when the operator cleanup is not given live-agent ids', async () => {
    const tree = await addTree(join(repo, '.claude', 'worktrees', 'agent-registering'), 'agent/registering');
    await addOrigin();
    markAgentDispatching('agent-registering');
    try {
      const unknown = await deleteMergedBranches(repo);
      expect(unknown.deleted).toEqual([]);
      expect(unknown.skipped).toContain('agent/registering (local: agent liveness unknown)');
      expect(existsSync(tree)).toBe(true);
    } finally {
      clearAgentDispatching('agent-registering');
    }
    const known = await deleteMergedBranches(repo, { activeAgentIds: new Set() });
    expect(known.deleted.map((row) => row.name)).toEqual(['agent/registering']);
    expect(existsSync(tree)).toBe(false);
  });

  it('keeps an unmanaged checkout held at the operator merged-branch cleanup boundary', async () => {
    const loose = await addTree(join(external, 'loose'), 'loose-br', { ageMs: 30 * DAY });

    const held = await reconcile(repo, { activeAgentIds: new Set() });
    expect(held.skipped.find((s) => s.branch === 'loose-br')?.reason).toBe('worktree-unmanaged-location');

    await addOrigin();
    const operator = await deleteMergedBranches(repo, { activeAgentIds: new Set() });
    expect(operator.deleted).toEqual([]);
    expect(operator.skipped).toContain('loose-br (local: worktree-unmanaged-location)');
    expect(existsSync(loose)).toBe(true);
    expect(await branches()).toContain('loose-br');
  });

  it.each([false, true])('preserves authored files when status is unreadable (throws=%s)', async (throws) => {
    const path = await addTree(join(repo, '.claude', 'worktrees', 'claim-unreadable'), 'claim/issue-31', { ageMs: 30 * DAY });
    await writeFile(join(path, 'unfinished.txt'), 'keep this work\n');
    injected.statusPath = throws ? path : path.replaceAll('/', '\\');
    injected.statusThrows = throws;
    const result = await reconcile(repo, { activeAgentIds: new Set() });
    expect(result.cleaned).not.toContain('claim/issue-31');
    expect(result.skipped).toContainEqual(expect.objectContaining({ branch: 'claim/issue-31', reason: 'worktree-status-unavailable' }));
    expect(existsSync(join(path, 'unfinished.txt'))).toBe(true);
    expect(await branches()).toContain('claim/issue-31');
  });

  it('does not let a superseded verdict authorize retirement of an unreadable checkout', async () => {
    const branch = 'fix/superseded-unreadable';
    const path = await addTree(join(repo, '.claude', 'worktrees', 'superseded'), branch);
    await writeFile(join(path, 'unfinished.txt'), 'preserve before backup\n');
    const tip = (await execGit(['rev-parse', branch], repo)).stdout.trim();
    injected.statusPath = path;
    const result = await reapSupersededBranches(repo, 'main', [{
      branch, tip, worktreePath: path, dirtyPaths: ['unfinished.txt'],
      verdict: { branch, tip, verdict: 'SUPERSEDED', dirtyPaths: ['unfinished.txt'] },
    }], { cosDir: join(scratch, 'cos') });

    expect(result.reaped).toEqual([]);
    expect(result.skipped).toContainEqual({ branch, reason: 'worktree-status-unavailable' });
    expect(existsSync(join(path, 'unfinished.txt'))).toBe(true);
    expect(await branches()).toContain(branch);
  });

  it('checks current owners when direct cleanup receives only a previously merged ref', async () => {
    const branch = 'fix/newly-reserved';
    await execGit(['branch', branch, 'main'], repo);
    injected.owners = [{ id: 'coordinator', status: 'running', metadata: {
      sourceWorkspace: repo, claimBranches: [branch],
    } }];

    const result = await cleanupMerged(repo, 'main', [{ branch, upstreamGone: true }]);

    expect(result.cleaned).toEqual([]);
    expect(result.skipped).toEqual([{ branch, reason: 'claim-owner-active' }]);
    expect(await branches()).toContain(branch);
  });

  it('refreshes a stale empty ownership snapshot before retiring a newly claimed branch', async () => {
    const branch = 'fix/stale-owner-snapshot';
    const path = await addTree(join(repo, '.claude', 'worktrees', 'snapshot'), branch);
    injected.owners = [{ id: 'new-owner', status: 'running', metadata: {
      sourceWorkspace: repo, claimBranches: [branch],
    } }];
    const result = await cleanupMerged(repo, 'main', [{ branch, upstreamGone: true }], { claimOwners: { agents: [] } });
    expect(result.cleaned).toEqual([]);
    expect(result.skipped).toEqual([{ branch, reason: 'claim-owner-active' }]);
    expect(existsSync(path)).toBe(true);
    expect(await branches()).toContain(branch);
  });

  it('never uses an old manual claim age or empty snapshot as completion proof', async () => {
    const branch = 'claim/issue-55';
    const path = await addTree(join(repo, '.claude', 'worktrees', 'claim-issue-55'), branch, { ageMs: 30 * DAY });
    // Match gatherBranchState's Git-reported spelling, including Windows
    // separators and expanded short paths, so this reaches the policy gate.
    const worktreePath = (await execGit(['rev-parse', '--show-toplevel'], path)).stdout.trim();
    const entry = { branch, worktreePath, worktreeAgeMs: 30 * DAY, upstreamGone: true };
    for (const claimOwners of [{ agents: [] }, { agents: null }, null]) {
      const result = await cleanupMerged(repo, 'main', [entry], { claimOwners });
      expect(result.cleaned).toEqual([]);
      expect(result.skipped).toContainEqual(expect.objectContaining({ branch,
        reason: claimOwners?.agents ? 'claim-completion-unverified' : 'claim-ownership-unreadable' }));
      expect(existsSync(path)).toBe(true);
      expect(await branches()).toContain(branch);
    }
  });

  it('holds a branch queued for the pending-merge coordinator instead of dispatching its open PR, and fails closed when the queue is unreadable', async () => {
    const branch = 'claim/issue-1';
    await execGit(['checkout', '-q', '-b', branch], repo);
    await writeFile(join(repo, 'queued.txt'), 'queued work\n');
    await execGit(['add', 'queued.txt'], repo);
    await execGit(['commit', '-m', 'feat: queued work'], repo);
    await execGit(['checkout', '-q', 'main'], repo);
    const base = { defaultBranch: 'main', activeAgentIds: new Set(), claimOwners: { agents: [], readAgents: async () => [] } };
    // No origin means no forge read, so the PR the coordinator owns is supplied
    // on the gathered entry the way the forge listing would.
    const stateFor = async (pendingMergeBranches) => {
      const entry = (await gatherBranchState(repo, { ...base, pendingMergeBranches })).find(i => i.branch === branch);
      return classifyBranches([{ ...entry, hasOrigin: true, openPr: { number: 1, mergeable: 'MERGEABLE' } }])[0];
    };

    expect(await stateFor(undefined)).toMatchObject({ state: 'IN_REVIEW' });
    expect(await stateFor(new Set())).toMatchObject({ state: 'IN_REVIEW' });
    expect(await stateFor(new Set([branch]))).toMatchObject({ state: 'WIP', liveOwnerReason: 'pending-merge-queued' });
    expect(await stateFor(null)).toMatchObject({ state: 'WIP', liveOwnerReason: 'pending-merge-unavailable' });
  });

  it('refreshes a completion handoff before direct retirement and after a Git refusal', async () => {
    const ref = 'fix/policy-held-ref';
    const checkedOut = 'fix/policy-held-tree';
    await execGit(['branch', ref, 'main'], repo);
    const path = await addTree(join(repo, '.claude', 'worktrees', 'policy-held'), checkedOut);
    const hold = branch => ({ id: `completed-${branch.replaceAll('/', '-')}`, status: 'completed', metadata: {
      sourceWorkspace: repo, worktreeBranch: branch, prCompletionPolicy: 'leave-open',
    } });
    injected.policies = [hold(ref)];
    const direct = await cleanupMerged(repo, 'main', [{ branch: ref, upstreamGone: true }]);
    expect(direct.cleaned).toEqual([]);
    expect(direct.skipped).toEqual([{ branch: ref, reason: 'pr-completion-human-handoff' }]);

    injected.beforeRemove = async () => { injected.policies.push(hold(checkedOut)); };
    const result = await reconcile(repo);
    expect(result.cleaned).not.toContain(checkedOut);
    expect(result.wip).toContainEqual(expect.objectContaining({ branch: checkedOut, completionPolicyReason: 'pr-completion-human-handoff' }));
    expect(existsSync(path)).toBe(true);
    expect(await branches()).toEqual(expect.arrayContaining([ref, checkedOut]));
  });

  it('protects registered branch owners and coordinator reservations during the early reap', async () => {
    const root = join(repo, '.claude', 'worktrees');
    const owned = await addTree(join(root, 'owned'), 'claim/issue-32');
    const reserved = await addTree(join(root, 'reserved'), 'next/issue-33');
    injected.owners = [
      { id: 'agent-owner', status: 'paused', sourceWorkspace: repo, workspacePath: repo, metadata: { claimBranch: 'claim/issue-32' } },
      { id: 'agent-coordinator', status: 'running', sourceWorkspace: repo, workspacePath: repo, metadata: { claimBranches: ['next/issue-33'] } },
    ];
    const result = await reconcile(repo, { activeAgentIds: new Set(), claimOwners: { agents: injected.owners, readAgents: async () => injected.owners } });
    expect(result.cleaned).toEqual([]);
    for (const path of [owned, reserved]) expect(existsSync(path)).toBe(true);
    expect(result.skipped.map(row => row.reason)).toEqual(['claim-owner-active', 'claim-owner-active']);
  });

  it.each(['owner', 'lock', 'status failure'])('preserves a tree when a new %s appears before the early reaper fallback', async (change) => {
    const path = await addTree(join(repo, '.claude', 'worktrees', 'fallback'), 'fix/fallback');
    const owners = { agents: [], readAgents: async () => injected.owners };
    injected.beforeRemove = async () => {
      if (change === 'lock') await execGit(['worktree', 'lock', path], repo);
      else if (change === 'status failure') injected.statusPath = path;
      else injected.owners = [{ id: 'agent-new-owner', status: 'running', workspacePath: path }];
    };
    const result = await reconcile(repo, { activeAgentIds: new Set(), claimOwners: owners });
    expect(result.cleaned).toEqual([]);
    expect(existsSync(path)).toBe(true);
    expect(await branches()).toContain('fix/fallback');
    const registration = (await execGit(['worktree', 'list', '--porcelain'], repo)).stdout;
    expect(registration.split(/\r?\n/)).toContain(`worktree ${path.replaceAll('\\', '/')}`);
    if (change === 'lock') expect(registration).toContain('locked');
    expect(result.skipped).toContainEqual(expect.objectContaining({ branch: 'fix/fallback', reason: change === 'lock' ? 'worktree-locked' : change === 'status failure' ? 'worktree-status-unavailable' : 'claim-owner-active' }));
  });

  it('fails closed on an unreadable registry or unknown owner status at the operator cleanup boundary', async () => {
    const path = await addTree(join(external, 'unknown-owner'), 'fix/unknown-owner');
    await addOrigin();
    for (const owners of [null, [{ id: 'agent-unknown', status: 'unknown', workspacePath: path }]]) {
      injected.owners = owners;
      const result = await deleteMergedBranches(repo, { activeAgentIds: new Set() });
      expect(result.deleted).toEqual([]);
      expect(result.skipped.some(reason => reason.includes('claim-ownership-unreadable'))).toBe(true);
      expect(existsSync(path)).toBe(true);
      expect(await branches()).toContain('fix/unknown-owner');
    }
  });

  it('preserves an unreadable detached tree and still retires a clean detached peer', async () => {
    const root = join(repo, '.claude', 'worktrees');
    const unreadable = join(root, 'unreadable-detached');
    const clean = join(root, 'clean-detached');
    await execGit(['worktree', 'add', '--detach', unreadable, 'main'], repo);
    await execGit(['worktree', 'add', '--detach', clean, 'main'], repo);
    await writeFile(join(unreadable, 'unfinished.txt'), 'preserve\n');
    injected.statusPath = unreadable;
    const result = await reconcile(repo, { activeAgentIds: new Set(), claimOwners: { agents: [], readAgents: async () => [] } });
    expect(result.detachedWorktrees).toContainEqual(expect.objectContaining({ path: unreadable.replaceAll('\\', '/'), reason: 'worktree-status-unavailable' }));
    expect(existsSync(join(unreadable, 'unfinished.txt'))).toBe(true);
    expect(existsSync(clean)).toBe(false);
    expect(result.cleaned).toContain(clean.replaceAll('\\', '/'));
  });

  describe('detached checkout receipts (#13405)', () => {
    /** A clean managed detached checkout that a previous scan already inventoried. */
    async function inventoriedDetached() {
      const outcomes = await import('./branchReconcileOutcome.js');
      const path = join(repo, '.claude', 'worktrees', 'clean-detached');
      await execGit(['worktree', 'add', '--detach', path, 'main'], repo);
      const gitPath = await gitCheckoutPath(path);
      const head = (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim();
      const release = { path: gitPath, head, detached: true, managed: true, checkoutIdentity: await readRetirementCheckoutIdentity(path) };
      const unrelated = { branch: 'feature/unexplained', head, reason: 'branch-held' };
      await outcomes.recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...release, reason: 'checkout-retained' }, unrelated] });
      return { outcomes, path, release, unrelated };
    }
    const sweep = (options = {}) => reconcile(repo, { activeAgentIds: new Set(), claimOwners: { agents: [], readAgents: async () => [] }, ...options });

    it('settles a retired detached checkout before the next inventory without claiming a branch deletion', async () => {
      const { outcomes, path, release, unrelated } = await inventoriedDetached();
      const result = await sweep({ appId: 'app-1' });
      expect(result.cleaned).toContain(release.path);
      expect(existsSync(path)).toBe(false);
      const first = await outcomes.getBranchReconcileOutcome('app-1');
      expect(first.retired).toEqual([expect.objectContaining({ path: release.path, head: release.head, checkoutIdentity: release.checkoutIdentity,
        branchDeleted: false, checkoutOnly: true, archiveDir: null })]);
      expect(first.retired[0]).not.toHaveProperty('branch');
      const next = await outcomes.recordBranchReconcileOutcome('app-1', { status: 'complete', remaining: [] });
      expect(next.retired).toEqual(first.retired);
      expect(next.retirementObligations).toEqual([expect.objectContaining({ branch: unrelated.branch })]);
    });

    it('leaves a removed detached checkout a missing-source obligation when its receipt cannot be stored', async () => {
      const { outcomes, path, release, unrelated } = await inventoriedDetached();
      injected.failScheduleWrite = true;
      const result = await sweep({ appId: 'app-1' });
      expect(existsSync(path)).toBe(false);
      expect(result.cleaned).not.toContain(release.path);
      expect(result.detachedWorktrees).toContainEqual(expect.objectContaining({ path: release.path, reason: 'retirement-receipt-unverified' }));
      injected.failScheduleWrite = false;
      expect((await outcomes.getBranchReconcileOutcome('app-1')).retired || []).toEqual([]);
      const next = await outcomes.recordBranchReconcileOutcome('app-1', { status: 'complete', remaining: [] });
      expect(next.retirementObligations).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: release.path, reason: 'retirement-provenance-unverified' }),
        expect.objectContaining({ branch: unrelated.branch }),
      ]));
    });

    it('does not let a recreated same-path detached checkout borrow the old checkout-only receipt', async () => {
      const { outcomes, path, release, unrelated } = await inventoriedDetached();
      await sweep({ appId: 'app-1' });
      const retired = (await outcomes.getBranchReconcileOutcome('app-1')).retired;
      await execGit(['worktree', 'add', '--detach', path, 'main'], repo);
      const recreated = { ...release, checkoutIdentity: await readRetirementCheckoutIdentity(path), reason: 'retirement-receipt-unverified' };
      expect(recreated.checkoutIdentity).not.toBe(release.checkoutIdentity);
      await outcomes.recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [recreated, unrelated] });
      const next = await outcomes.recordBranchReconcileOutcome('app-1', { status: 'complete', remaining: [] });
      expect(next.retired).toEqual(retired);
      expect(next.retirementObligations).toContainEqual(expect.objectContaining({ path: recreated.path, checkoutIdentity: recreated.checkoutIdentity }));
      expect(existsSync(path)).toBe(true);
    });
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
