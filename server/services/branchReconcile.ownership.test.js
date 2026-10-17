/**
 * Worktree ownership through branch-reconcile's real cleanup boundary (#10270).
 *
 * A checkout freshly cut from the default branch is clean and an ancestor of
 * it, so the merged-branch cleanup used to retire it — and its branch — while
 * the process that created it was still running. These tests drive `reconcile`
 * against a real throwaway repository (no origin, so no forge is consulted) to
 * pin that only PortOS-managed roots are retired unattended, while the
 * operator's explicit merged-branch cleanup keeps its wider reach.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, utimes, writeFile, appendFile, unlink } from 'fs/promises';
import { existsSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execGit } from '../lib/execGit.js';
import { materializeGitRepo, SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';

const injected = vi.hoisted(() => ({ statusPath: null, statusThrows: false, beforeRemove: null, owners: [], policies: [] }));
vi.mock('../lib/execGit.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execGit: async (args, cwd, options) => {
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
    return actual.execGit(args, cwd, options);
  } };
});
vi.mock('./cosState.js', () => ({
  readAgentsStateForSafetyCheck: async () => ({ trusted: injected.owners !== null,
    agents: injected.owners && Object.fromEntries(injected.owners.map(agent => [agent.id, agent])) }),
}));

// Keep archive I/O at the boundary; use the real completion-policy evaluator.
vi.mock('./branchCompletionPolicy.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, readBranchCompletionPolicies: async () => injected.policies, readBranchCompletionHold: input => actual.readBranchCompletionHold(input, {
    readPolicies: async () => injected.policies,
  }) };
});

// Keep the run hermetic: the verdict ledger otherwise reads this install's
// real CoS data directory.
vi.mock('./supersededLedger.js', async (importOriginal) => ({
  ...await importOriginal(),
  readVerdictLedger: async () => [],
}));

const { reconcile, cleanupMerged, reapSupersededBranches } = await import('./branchReconcile.js');
const { clearAgentDispatching, getActiveAgentIds, markAgentDispatching } = await import('./agentState.js');
const { deleteMergedBranches } = await import('./git.js');

const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(SKIP_HEAVY_INTEGRATION)('branch-reconcile worktree ownership (real git)', () => {
  let scratch;
  let repo;
  let external;

  beforeEach(async () => {
    Object.assign(injected, { statusPath: null, statusThrows: false, beforeRemove: null, owners: [], policies: [] });
    scratch = realpathSync(await mkdtemp(join(tmpdir(), 'portos-reconcile-own-')));
    const safeRepo = join(scratch, 'repo');
    await mkdir(safeRepo);
    await materializeGitRepo(safeRepo, { identity: { email: 'test@example.com', name: 'Test' } });
    repo = (await execGit(['rev-parse', '--show-toplevel'], safeRepo)).stdout.trim() || safeRepo;
    external = join(scratch, 'elsewhere');
    await mkdir(external);
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

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

  it('retires inactive managed trees but never a fresh or old unmanaged one', async () => {
    const claudeRoot = join(repo, '.claude', 'worktrees');
    await mkdir(claudeRoot, { recursive: true });
    const fresh = await addTree(join(external, 'release-preparation'), 'release-prep/v9.9.9');
    const old = await addTree(join(external, 'old-workspace'), 'old-workspace', { ageMs: 30 * DAY });
    const staleClaim = await addTree(join(claudeRoot, 'claim-issue-5'), 'claim/issue-5', { ageMs: 30 * DAY });
    const lockedClaim = await addTree(join(claudeRoot, 'claim-issue-6'), 'claim/issue-6', { ageMs: 30 * DAY });
    await execGit(['worktree', 'lock', lockedClaim], repo);
    const dirtyClaim = await addTree(join(claudeRoot, 'claim-issue-7'), 'claim/issue-7');
    await writeFile(join(dirtyClaim, 'wip.txt'), 'unsaved\n');
    await utimes(dirtyClaim, new Date(Date.now() - 30 * DAY), new Date(Date.now() - 30 * DAY));

    const result = await reconcile(repo, { activeAgentIds: new Set() });
    const reasonFor = (branch) => result.skipped.find((s) => s.branch === branch)?.reason;
    const context = JSON.stringify({ cleaned: result.cleaned, skipped: result.skipped });

    // Unmanaged: held at any age, checkout AND branch intact.
    expect(reasonFor('release-prep/v9.9.9'), context).toBe('worktree-unmanaged-location');
    expect(reasonFor('old-workspace'), context).toBe('worktree-unmanaged-location');
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(old)).toBe(true);

    // Managed: an abandoned claim is still retired; a lock or real work holds.
    expect(result.cleaned, context).toContain('claim/issue-5');
    expect(existsSync(staleClaim)).toBe(false);
    expect(reasonFor('claim/issue-6'), context).toBe('worktree-locked');
    expect(existsSync(lockedClaim)).toBe(true);
    expect(result.cleaned, context).not.toContain('claim/issue-7');
    expect(existsSync(dirtyClaim)).toBe(true);

    const left = await branches();
    expect(left).toEqual(expect.arrayContaining(['release-prep/v9.9.9', 'old-workspace', 'claim/issue-6', 'claim/issue-7']));
    expect(left).not.toContain('claim/issue-5');
  });

  it('retires fresh owner-free claims while preserving locked and unfinished work', async () => {
    const root = join(repo, '.claude', 'worktrees');
    await mkdir(root, { recursive: true });
    const clean = await addTree(join(root, 'claim-issue-11'), 'claim/issue-11');
    const locked = await addTree(join(root, 'claim-issue-12'), 'claim/issue-12');
    await execGit(['worktree', 'lock', locked], repo);
    const dirty = await addTree(join(root, 'claim-issue-13'), 'claim/issue-13');
    await writeFile(join(dirty, 'unfinished.txt'), 'preserve this work\n');
    const unmerged = await addTree(join(root, 'claim-issue-14'), 'claim/issue-14');
    await writeFile(join(unmerged, 'committed.txt'), 'finish this work\n');
    await execGit(['add', 'committed.txt'], unmerged);
    await execGit(['commit', '-m', 'feat: unfinished work'], unmerged);

    const result = await reconcile(repo, {
      activeAgentIds: new Set(), claimOwners: { agents: [], readAgents: async () => [] },
    });
    expect(result.cleaned).toEqual(['claim/issue-11']);
    expect(existsSync(clean)).toBe(false);
    expect(result.skipped).toContainEqual(expect.objectContaining({ branch: 'claim/issue-12', reason: 'worktree-locked' }));
    expect(result.inFlight).toEqual(expect.arrayContaining([
      expect.objectContaining({ branch: 'claim/issue-13', state: 'ABANDONED_WIP' }),
    ]));
    // This hermetic repo has no forge, so committed work is held until PR state
    // can be established rather than being retired as merged.
    expect(result.wip).toContainEqual(expect.objectContaining({ branch: 'claim/issue-14' }));
    for (const path of [locked, dirty, unmerged]) expect(existsSync(path)).toBe(true);
    expect(await branches()).toEqual(expect.arrayContaining(['claim/issue-12', 'claim/issue-13', 'claim/issue-14']));
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

  it('leaves the operator-initiated merged-branch cleanup able to remove an unmanaged tree', async () => {
    const loose = await addTree(join(external, 'loose'), 'loose-br', { ageMs: 30 * DAY });

    const held = await reconcile(repo, { activeAgentIds: new Set() });
    expect(held.skipped.find((s) => s.branch === 'loose-br')?.reason).toBe('worktree-unmanaged-location');

    const operator = await deleteMergedBranches(repo, { activeAgentIds: new Set() });
    expect(operator.deleted.map((d) => d.name), JSON.stringify(operator)).toContain('loose-br');
    expect(existsSync(loose)).toBe(false);
    expect(await branches()).not.toContain('loose-br');
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
    for (const owners of [null, [{ id: 'agent-unknown', status: 'unknown', workspacePath: path }]]) {
      injected.owners = owners;
      const result = await deleteMergedBranches(repo, { activeAgentIds: new Set() });
      expect(result.deleted).toEqual([]);
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
