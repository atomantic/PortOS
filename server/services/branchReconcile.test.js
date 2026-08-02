/**
 * Unit tests for the Branch & PR Reconciler deterministic core.
 *
 * - classifyBranch / classifyBranches — the pure state machine (no mocks).
 * - cleanupMerged — the safety gates: only delete a branch when it re-verifies
 *   merged AND its worktree is clean; a failed gate skips with a reason.
 * - reconcile — end-to-end wiring over a mocked gather (partitions cleaned /
 *   inFlight / wip correctly).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./git.js', () => ({
  getBranches: vi.fn(),
  getDefaultBranch: vi.fn(async () => 'main'),
  isBranchMergedInto: vi.fn(),
  deleteBranch: vi.fn(async () => ({ branch: 'x', results: { local: 'deleted' } }))
}));
vi.mock('../lib/execGit.js', () => ({
  execGit: vi.fn(async () => ({ stdout: '', exitCode: 0 }))
}));
vi.mock('./worktreeManager.js', () => ({
  listWorktrees: vi.fn(async () => []),
  forceRemoveWorktreeDir: vi.fn(async () => {}),
  // Real pure classifier semantics: empty porcelain = clean, and every non-empty
  // line is a real change path (the suite never feeds it lockfile churn). The
  // paths matter — gatherDivergence intersects them with the default branch's
  // changes to find work that may have been superseded.
  classifyWorktreeDirt: vi.fn((p) => {
    const lines = (p || '').split('\n').map((l) => l.trim()).filter(Boolean);
    return {
      hasRealChanges: lines.length > 0,
      realChangePaths: lines.map((l) => l.replace(/^\s*\S+\s+/, ''))
    };
  }),
  isHumanClaimWorktree: vi.fn((id) => typeof id === 'string' && id.startsWith('claim-'))
}));
const ensureForgeReachableMock = vi.fn(async () => ({ ok: true, status: 'ok', detail: null, remedy: null }));
vi.mock('./github.js', () => ({
  execGh: vi.fn(async () => '[]'),
  ensureForgeReachable: (...args) => ensureForgeReachableMock(...args),
}));
vi.mock('../lib/gitRemote.js', () => ({
  getOriginInfo: vi.fn(async () => ({
    hasOrigin: true, isGithub: true, host: 'github.com', fullName: 'atomantic/PortOS'
  }))
}));
vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { root: '/repo' },
  safeJSONParse: (raw, fallback) => { try { return JSON.parse(raw); } catch { return fallback; } }
}));

import {
  classifyBranch, classifyBranches, cleanupMerged, reconcile, gatherBranchState, worktreeProtectionReason,
  isAbandonedAgentWorktree, gatherDivergence,
  actionOn, filterActionable, desiredEndState, formatInFlightForPrompt, actionableSignature,
  branchPriorityRank, prioritizeBranches
} from './branchReconcile.js';
import * as git from './git.js';
import * as wt from './worktreeManager.js';
import { execGit } from '../lib/execGit.js';
import { execGh } from './github.js';
import { getOriginInfo } from '../lib/gitRemote.js';

beforeEach(() => {
  vi.clearAllMocks();
  git.getDefaultBranch.mockResolvedValue('main');
  git.deleteBranch.mockResolvedValue({ branch: 'x', results: { local: 'deleted' } });
  wt.forceRemoveWorktreeDir.mockResolvedValue(undefined);
  execGit.mockResolvedValue({ stdout: '', exitCode: 0 });
});

describe('classifyBranch', () => {
  it('merged wins even over an open PR', () => {
    expect(classifyBranch({ isMerged: true, openPr: { mergeable: 'MERGEABLE' }, hasUpstream: true })).toBe('MERGED');
  });
  it('open conflicting PR → CONFLICTED', () => {
    expect(classifyBranch({ isMerged: false, openPr: { mergeable: 'CONFLICTING' }, hasUpstream: true })).toBe('CONFLICTED');
  });
  it('open mergeable PR → IN_REVIEW', () => {
    expect(classifyBranch({ isMerged: false, openPr: { mergeable: 'MERGEABLE' }, hasUpstream: true })).toBe('IN_REVIEW');
  });
  it('pushed, no PR, clean → NEEDS_PR', () => {
    expect(classifyBranch({ isMerged: false, openPr: null, hasUpstream: true, worktreeDirty: false })).toBe('NEEDS_PR');
  });
  it('pushed but dirty worktree → WIP', () => {
    expect(classifyBranch({ isMerged: false, openPr: null, hasUpstream: true, worktreeDirty: true })).toBe('WIP');
  });
  it('dirty worktree wins over an open PR → WIP (never hand a dirty tree to the agent)', () => {
    expect(classifyBranch({ isMerged: false, openPr: { mergeable: 'MERGEABLE' }, hasUpstream: true, worktreeDirty: true })).toBe('WIP');
    expect(classifyBranch({ isMerged: false, openPr: { mergeable: 'CONFLICTING' }, hasUpstream: true, worktreeDirty: true })).toBe('WIP');
  });
  it('local-only (no upstream), no PR → WIP', () => {
    expect(classifyBranch({ isMerged: false, openPr: null, hasUpstream: false, worktreeDirty: false })).toBe('WIP');
  });

  // The exact shape of the three branches that went unreconciled for weeks: a CoS
  // agent exited without committing, so its branch pointer sat on an old `main`
  // commit (reads as MERGED) while the whole deliverable stayed uncommitted in the
  // worktree. MERGED routed it to cleanupMerged, which correctly refused to delete
  // a dirty worktree — so it was only ever `skipped`, never in-flight, and every
  // run logged "nothing in-flight".
  it('classifies a dead agent\'s dirty worktree as ABANDONED_WIP even when the branch reads merged', () => {
    expect(classifyBranch({
      isMerged: true, worktreeDirty: true, abandonedAgentWorktree: true, hasUpstream: true, openPr: null
    })).toBe('ABANDONED_WIP');
  });

  it('leaves a LIVE agent\'s dirty worktree alone (MERGED/WIP, never ABANDONED_WIP)', () => {
    expect(classifyBranch({
      isMerged: true, worktreeDirty: true, abandonedAgentWorktree: false, hasUpstream: true, openPr: null
    })).toBe('MERGED');
    expect(classifyBranch({
      isMerged: false, worktreeDirty: true, abandonedAgentWorktree: false, hasUpstream: true, openPr: null
    })).toBe('WIP');
  });
});

describe('classifyBranches', () => {
  it('annotates each input with its state', () => {
    const out = classifyBranches([
      { branch: 'a', isMerged: true, hasUpstream: true },
      { branch: 'b', isMerged: false, openPr: null, hasUpstream: false }
    ]);
    expect(out.map((o) => o.state)).toEqual(['MERGED', 'WIP']);
  });
});

describe('cleanupMerged', () => {
  it('removes worktree + deletes branch when merged and clean', async () => {
    git.isBranchMergedInto.mockResolvedValue(true);
    execGit.mockResolvedValue({ stdout: '', exitCode: 0 }); // clean worktree
    const res = await cleanupMerged('/repo', 'main', [{ branch: 'next/issue-2190', worktreePath: '/wt/2190' }]);
    expect(res.cleaned).toEqual(['next/issue-2190']);
    expect(wt.forceRemoveWorktreeDir).toHaveBeenCalledWith('/repo', '/wt/2190', expect.any(Object));
    expect(git.deleteBranch).toHaveBeenCalledWith('/repo', 'next/issue-2190', { local: true });
  });

  it('skips when re-check says not merged (fail closed)', async () => {
    git.isBranchMergedInto.mockResolvedValue(false);
    const res = await cleanupMerged('/repo', 'main', [{ branch: 'next/issue-2190', worktreePath: '/wt/2190' }]);
    expect(res.cleaned).toEqual([]);
    expect(res.skipped).toEqual([{ branch: 'next/issue-2190', reason: 'not-merged-on-recheck' }]);
    expect(git.deleteBranch).not.toHaveBeenCalled();
  });

  it('skips when the worktree has real uncommitted changes', async () => {
    git.isBranchMergedInto.mockResolvedValue(true);
    execGit.mockResolvedValue({ stdout: ' M server/index.js', exitCode: 0 }); // dirty
    const res = await cleanupMerged('/repo', 'main', [{ branch: 'next/issue-2196', worktreePath: '/wt/2196' }]);
    expect(res.cleaned).toEqual([]);
    expect(res.skipped).toEqual([{ branch: 'next/issue-2196', reason: 'worktree-dirty' }]);
    expect(wt.forceRemoveWorktreeDir).not.toHaveBeenCalled();
    expect(git.deleteBranch).not.toHaveBeenCalled();
  });

  it('deletes a merged branch with no worktree', async () => {
    git.isBranchMergedInto.mockResolvedValue(true);
    const res = await cleanupMerged('/repo', 'main', [{ branch: 'orphan', worktreePath: null }]);
    expect(res.cleaned).toEqual(['orphan']);
    expect(wt.forceRemoveWorktreeDir).not.toHaveBeenCalled();
  });

  it('never tears down a locked / human-claim / active-agent worktree', async () => {
    git.isBranchMergedInto.mockResolvedValue(true);
    const activeAgentIds = new Set(['agent-abc12345']);
    const res = await cleanupMerged('/repo', 'main', [
      { branch: 'locked-b', worktreePath: '/wt/locked', worktreeLocked: true },
      { branch: 'claim-b', worktreePath: '/repo/data/cos/worktrees/claim-foo' },
      { branch: 'active-b', worktreePath: '/repo/data/cos/worktrees/agent-abc12345' }
    ], { activeAgentIds });
    expect(res.cleaned).toEqual([]);
    expect(res.skipped).toEqual([
      { branch: 'locked-b', reason: 'worktree-locked' },
      { branch: 'claim-b', reason: 'worktree-human-claim' },
      { branch: 'active-b', reason: 'worktree-active-agent' }
    ]);
    expect(wt.forceRemoveWorktreeDir).not.toHaveBeenCalled();
    expect(git.deleteBranch).not.toHaveBeenCalled();
  });

  it('reaps an ABANDONED claim worktree (merged + clean + stale age)', async () => {
    git.isBranchMergedInto.mockResolvedValue(true);
    execGit.mockResolvedValue({ stdout: '', exitCode: 0 }); // clean
    const res = await cleanupMerged('/repo', 'main', [
      // 10 days old — comfortably past the 7-day STALE_CLAIM_IDLE_MS default
      { branch: 'claim/issue-1933', worktreePath: '/repo/data/cos/worktrees/claim-issue-1933', worktreeAgeMs: 10 * 24 * 60 * 60 * 1000 }
    ]);
    expect(res.cleaned).toEqual(['claim/issue-1933']);
    expect(wt.forceRemoveWorktreeDir).toHaveBeenCalledWith('/repo', '/repo/data/cos/worktrees/claim-issue-1933', expect.any(Object));
    expect(git.deleteBranch).toHaveBeenCalledWith('/repo', 'claim/issue-1933', { local: true });
  });

  it('still protects a RECENT claim worktree even when merged + clean', async () => {
    git.isBranchMergedInto.mockResolvedValue(true);
    execGit.mockResolvedValue({ stdout: '', exitCode: 0 }); // clean
    const res = await cleanupMerged('/repo', 'main', [
      { branch: 'claim/issue-9999', worktreePath: '/repo/data/cos/worktrees/claim-issue-9999', worktreeAgeMs: 60 * 1000 } // 1 min old
    ]);
    expect(res.cleaned).toEqual([]);
    expect(res.skipped).toEqual([{ branch: 'claim/issue-9999', reason: 'worktree-human-claim' }]);
    expect(wt.forceRemoveWorktreeDir).not.toHaveBeenCalled();
    expect(git.deleteBranch).not.toHaveBeenCalled();
  });
});

describe('worktreeProtectionReason', () => {
  it('flags locked, human-claim, and active-agent worktrees; passes ordinary ones', () => {
    expect(worktreeProtectionReason({ path: '/wt/x', locked: true })).toBe('worktree-locked');
    expect(worktreeProtectionReason({ path: '/x/claim-foo' })).toBe('worktree-human-claim');
    expect(worktreeProtectionReason({ path: '/x/agent-1', activeAgentIds: new Set(['agent-1']) })).toBe('worktree-active-agent');
    expect(worktreeProtectionReason({ path: '/repo/next-issue-2199', activeAgentIds: new Set(['agent-1']) })).toBeNull();
  });

  it('reaps an abandoned claim (stale age) but protects a recent one and unknown age', () => {
    const staleClaimIdleMs = 24 * 60 * 60 * 1000;
    // recent human /claim session (2h old) — still protected
    expect(worktreeProtectionReason({ path: '/x/claim-foo', ageMs: 2 * 60 * 60 * 1000, staleClaimIdleMs })).toBe('worktree-human-claim');
    // abandoned claim (3d old, merged+clean) — reaped
    expect(worktreeProtectionReason({ path: '/x/claim-foo', ageMs: 3 * 24 * 60 * 60 * 1000, staleClaimIdleMs })).toBeNull();
    // unknown age → fail safe toward protecting
    expect(worktreeProtectionReason({ path: '/x/claim-foo', ageMs: null, staleClaimIdleMs })).toBe('worktree-human-claim');
    // locked always wins even when stale
    expect(worktreeProtectionReason({ path: '/x/claim-foo', locked: true, ageMs: 3 * 24 * 60 * 60 * 1000, staleClaimIdleMs })).toBe('worktree-locked');
  });
});

describe('gatherBranchState', () => {
  it('excludes default/current/protected and folds in worktree + PR facts', async () => {
    git.getBranches.mockResolvedValue([
      { name: 'main', isDefault: true, current: true, tracking: 'origin/main', merged: false },
      { name: 'release', isDefault: false, current: false, tracking: 'origin/release', merged: false },
      // Long-lived shared branches that must never be reconciled or handed to the agent.
      { name: 'develop', isDefault: false, current: false, tracking: 'origin/develop', merged: false },
      { name: 'gh-pages', isDefault: false, current: false, tracking: 'origin/gh-pages', merged: false },
      { name: 'next/issue-2199', isDefault: false, current: false, tracking: 'origin/next/issue-2199', merged: false },
      { name: 'next/issue-2190', isDefault: false, current: false, tracking: 'origin/next/issue-2190', merged: true }
    ]);
    wt.listWorktrees.mockResolvedValue([
      { path: '/wt/2199', branch: 'refs/heads/next/issue-2199' }
    ]);
    execGh.mockResolvedValue(JSON.stringify([
      { number: 2206, headRefName: 'next/issue-2199', mergeable: 'MERGEABLE', isDraft: false, url: 'u' }
    ]));
    git.isBranchMergedInto.mockResolvedValue(false);

    const inputs = await gatherBranchState('/repo', { defaultBranch: 'main' });
    const names = inputs.map((i) => i.branch);
    expect(names).toEqual(['next/issue-2199', 'next/issue-2190']); // main/release/develop/gh-pages excluded

    const i2199 = inputs.find((i) => i.branch === 'next/issue-2199');
    expect(i2199.hasWorktree).toBe(true);
    expect(i2199.openPr.number).toBe(2206);
    expect(inputs.find((i) => i.branch === 'next/issue-2190').isMerged).toBe(true);
  });

  it('resolves PRs on a GitHub Enterprise host via a host-qualified --repo selector', async () => {
    // isGithub is github.com-only, but the enterprise host classifies as GitHub —
    // the scan must still run, targeting HOST/OWNER/REPO (not a bare OWNER/REPO,
    // which gh would resolve against github.com).
    getOriginInfo.mockResolvedValueOnce({
      hasOrigin: true, isGithub: false, host: 'github.acme.example', fullName: 'acme/app'
    });
    git.getBranches.mockResolvedValue([
      { name: 'next/issue-77', isDefault: false, current: false, tracking: 'origin/next/issue-77', merged: false }
    ]);
    wt.listWorktrees.mockResolvedValue([]);
    git.isBranchMergedInto.mockResolvedValue(false);
    execGh.mockResolvedValueOnce(JSON.stringify([
      { number: 77, headRefName: 'next/issue-77', mergeable: 'MERGEABLE', isDraft: false, url: 'u' }
    ]));

    const inputs = await gatherBranchState('/repo', { defaultBranch: 'main' });
    expect(inputs.find((i) => i.branch === 'next/issue-77').openPr.number).toBe(77);
    const args = execGh.mock.calls[0][0];
    const repoIdx = args.indexOf('--repo');
    expect(args[repoIdx + 1]).toBe('github.acme.example/acme/app');
  });

  it('returns no PR facts on a non-GitHub host (GitLab origin)', async () => {
    getOriginInfo.mockResolvedValueOnce({
      hasOrigin: true, isGithub: false, host: 'gitlab.com', fullName: 'acme/app'
    });
    git.getBranches.mockResolvedValue([
      { name: 'next/issue-88', isDefault: false, current: false, tracking: 'origin/next/issue-88', merged: false }
    ]);
    wt.listWorktrees.mockResolvedValue([]);
    git.isBranchMergedInto.mockResolvedValue(false);
    execGh.mockClear();

    const inputs = await gatherBranchState('/repo', { defaultBranch: 'main' });
    expect(inputs.find((i) => i.branch === 'next/issue-88').openPr).toBeNull();
    expect(execGh).not.toHaveBeenCalled();
  });
});

describe('isAbandonedAgentWorktree', () => {
  const live = new Set(['agent-aaaaaaaa']);

  it('is true only for an unlocked agent worktree whose agent is not running', () => {
    expect(isAbandonedAgentWorktree({ path: '/wt/agent-bbbbbbbb', activeAgentIds: live })).toBe(true);
    expect(isAbandonedAgentWorktree({ path: '/wt/agent-aaaaaaaa', activeAgentIds: live })).toBe(false);
    expect(isAbandonedAgentWorktree({ path: '/wt/agent-bbbbbbbb', locked: true, activeAgentIds: live })).toBe(false);
  });

  it('never claims a human /claim worktree, a non-agent sibling, or a missing path', () => {
    expect(isAbandonedAgentWorktree({ path: '/wt/claim-fix-thing', activeAgentIds: live })).toBe(false);
    expect(isAbandonedAgentWorktree({ path: '/wt/next-issue-42', activeAgentIds: live })).toBe(false);
    expect(isAbandonedAgentWorktree({ path: '', activeAgentIds: live })).toBe(false);
  });

  // Sentinel, not a plain collection: an empty Set is an authoritative "nothing is
  // running" (the common case), while an omitted/non-Set value means liveness is
  // unknown and must fail safe toward protecting the worktree.
  it('treats an empty Set as authoritative but an absent one as unknown', () => {
    expect(isAbandonedAgentWorktree({ path: '/wt/agent-bbbbbbbb', activeAgentIds: new Set() })).toBe(true);
    expect(isAbandonedAgentWorktree({ path: '/wt/agent-bbbbbbbb' })).toBe(false);
    expect(isAbandonedAgentWorktree({ path: '/wt/agent-bbbbbbbb', activeAgentIds: ['agent-cccccccc'] })).toBe(false);
  });
});

describe('gatherDivergence', () => {
  // Drives execGit by subcommand so each probe can be answered independently.
  const mockGit = ({ counts = '3\t2', mergeBase = 'base1', defaultChanged = '', branchChanged = '' } = {}) => {
    execGit.mockImplementation(async (args) => {
      if (args[0] === 'rev-list') return { stdout: counts, exitCode: 0 };
      if (args[0] === 'merge-base') return { stdout: mergeBase, exitCode: 0 };
      if (args[0] === 'diff' && args[args.length - 1] === 'main') return { stdout: defaultChanged, exitCode: 0 };
      if (args[0] === 'diff') return { stdout: branchChanged, exitCode: 0 };
      return { stdout: '', exitCode: 0 };
    });
  };

  it('reports drift counts and the files BOTH sides changed since the merge base', async () => {
    mockGit({
      counts: '101\t1',
      defaultChanged: 'server/services/agentWorktreeCleanup.js\nserver/lib/prDisposition.js\ndocs/UNRELATED.md',
      branchChanged: 'server/services/agentWorktreeCleanup.js\nserver/services/prAutoMerge.js'
    });
    const d = await gatherDivergence('/repo', 'stale-branch', 'main');
    expect(d.behind).toBe(101);
    expect(d.ahead).toBe(1);
    // Only the shared file — the branch's own new file and main's unrelated doc are not collisions.
    expect(d.collisionPaths).toEqual(['server/services/agentWorktreeCleanup.js']);
  });

  // An abandoned worktree's branch has NO commits, so its change set lives
  // entirely in the working tree. Probing only committed diffs would report a
  // clean, collision-free branch while the real collision sits uncommitted —
  // exactly the case this whole check exists for.
  it('counts uncommitted paths as part of the branch\'s change set', async () => {
    mockGit({ defaultChanged: 'server/services/agentWorktreeCleanup.js', branchChanged: '' });
    const d = await gatherDivergence('/repo', 'abandoned', 'main', ['server/services/agentWorktreeCleanup.js', 'server/services/prAutoMerge.js']);
    expect(d.collisionPaths).toEqual(['server/services/agentWorktreeCleanup.js']);
  });

  // Every branch touches the changelog, so alphabetical order would put it first
  // on virtually every entry and bury the source files that actually reveal a
  // reimplementation. It stays listed (it IS a real conflict) but ranks last.
  it('ranks always-churning files (changelog, lockfiles, README) below source files', async () => {
    const shared = '.changelog/NEXT.md\nserver/lib/README.md\npackage-lock.json\nserver/services/agentWorktreeCleanup.js\nclient/src/components/cos/constants.js';
    mockGit({ defaultChanged: shared, branchChanged: shared });
    const { collisionPaths } = await gatherDivergence('/repo', 'b', 'main');
    expect(collisionPaths).toEqual([
      'client/src/components/cos/constants.js',
      'server/services/agentWorktreeCleanup.js',
      '.changelog/NEXT.md',
      'package-lock.json',
      'server/lib/README.md'
    ]);
  });

  it('reports no collisions when the default branch has not touched the same files', async () => {
    mockGit({ defaultChanged: 'docs/OTHER.md', branchChanged: 'server/services/thing.js' });
    expect((await gatherDivergence('/repo', 'b', 'main')).collisionPaths).toEqual([]);
  });

  // A git failure must degrade to "unknown", never to a confident "no drift" —
  // the gate keys off these values to decide how hard to look for supersession.
  it('degrades to null counts and no collisions when git fails', async () => {
    execGit.mockRejectedValue(new Error('not a git repository'));
    const d = await gatherDivergence('/repo', 'b', 'main');
    expect(d).toEqual({ behind: null, ahead: null, collisionPaths: [] });
  });

  it('degrades when the branches share no history (no merge base)', async () => {
    mockGit({ counts: '5\t5', mergeBase: '' });
    const d = await gatherDivergence('/repo', 'orphan', 'main');
    expect(d.behind).toBe(5);
    expect(d.collisionPaths).toEqual([]);
  });
});

describe('branchPriorityRank / prioritizeBranches', () => {
  it('ranks recognized work-branch prefixes ahead of unrecognized ones, in list order', () => {
    expect(branchPriorityRank('claim/issue-1')).toBeLessThan(branchPriorityRank('cos/task/agent'));
    expect(branchPriorityRank('cos/task/agent')).toBeLessThan(branchPriorityRank('feature/x'));
    expect(branchPriorityRank('feature/x')).toBeLessThan(branchPriorityRank('random-scratch'));
    // Hyphen and slash separators both match; a bare keyword substring does not.
    expect(branchPriorityRank('feature-x')).toBe(branchPriorityRank('feature/x'));
    expect(branchPriorityRank('featureful')).toBe(branchPriorityRank('random-scratch'));
  });

  it('sorts by priority, ties broken by name, without mutating the input', () => {
    const input = [
      { branch: 'zzz-scratch' },
      { branch: 'feature/b' },
      { branch: 'claim/issue-9' },
      { branch: 'feature/a' },
      { branch: 'cos/task/agent-1' }
    ];
    const out = prioritizeBranches(input);
    expect(out.map((b) => b.branch)).toEqual([
      'claim/issue-9', 'cos/task/agent-1', 'feature/a', 'feature/b', 'zzz-scratch'
    ]);
    // Pure: original order untouched.
    expect(input[0].branch).toBe('zzz-scratch');
  });
});

// #3358 — an unreachable forge must read as "we could not ask", never as
// "this branch has no PR". Concluding the latter is what turned a firewalled
// `gh` into a NEEDS_PR list the coordinator would act on by opening duplicate
// PRs on top of the ones that already exist.
describe('unreachable forge (#3358)', () => {
  it('classifies a pushed branch as WIP — never NEEDS_PR — when PR state is unknown', () => {
    const branch = { isMerged: false, worktreeDirty: false, hasUpstream: true, openPr: null };
    expect(classifyBranch(branch)).toBe('NEEDS_PR');
    expect(classifyBranch({ ...branch, prStateUnavailable: true })).toBe('WIP');
  });

  it('still reports MERGED when PR state is unknown — that verdict is pure git truth', () => {
    expect(classifyBranch({ isMerged: true, hasUpstream: true, openPr: null, prStateUnavailable: true })).toBe('MERGED');
  });

  it('marks every gathered branch prStateUnavailable when gh pr list fails', async () => {
    git.getBranches.mockResolvedValue([
      { name: 'claim/issue-1', isDefault: false, current: false, tracking: 'origin/claim/issue-1', merged: false }
    ]);
    wt.listWorktrees.mockResolvedValue([]);
    execGh.mockRejectedValue(new Error('connect: bad file descriptor'));
    git.isBranchMergedInto.mockResolvedValue(false);

    const inputs = await gatherBranchState('/repo', { defaultBranch: 'main' });
    expect(inputs[0].prStateUnavailable).toBe(true);
    expect(classifyBranches(inputs)[0].state).toBe('WIP');
  });

  it('leaves prStateUnavailable false when gh answers with an empty list', async () => {
    git.getBranches.mockResolvedValue([
      { name: 'claim/issue-1', isDefault: false, current: false, tracking: 'origin/claim/issue-1', merged: false }
    ]);
    wt.listWorktrees.mockResolvedValue([]);
    execGh.mockResolvedValue('[]');
    git.isBranchMergedInto.mockResolvedValue(false);

    const inputs = await gatherBranchState('/repo', { defaultBranch: 'main' });
    expect(inputs[0].prStateUnavailable).toBe(false);
    expect(classifyBranches(inputs)[0].state).toBe('NEEDS_PR');
  });

  it('skips the whole cycle (never touches git) when the gh probe is not ok', async () => {
    ensureForgeReachableMock.mockResolvedValueOnce({ ok: false, status: 'unreachable', detail: 'dial tcp' });
    const res = await reconcile('/repo');
    expect(res.forgeUnavailable).toBe(true);
    expect(res.forgeStatus).toBe('unreachable');
    expect(res.inFlight).toEqual([]);
    expect(res.cleaned).toEqual([]);
    // Crucially: no branch enumeration and no deletion happened, so the empty
    // result can't be mistaken for "the repo is clean".
    expect(git.getBranches).not.toHaveBeenCalled();
    expect(git.deleteBranch).not.toHaveBeenCalled();
  });
});

describe('reconcile', () => {
  it('orders in-flight branches by work-branch priority', async () => {
    // A plain unrecognized branch, a feature branch, and a claim branch — all
    // NEEDS_PR (pushed, not merged, no PR, clean). The claim/feature branches must
    // lead the unrecognized one regardless of gather order.
    git.getBranches.mockResolvedValue([
      { name: 'scratch-thing', isDefault: false, current: false, tracking: 'origin/scratch-thing', merged: false },
      { name: 'feature/new-thing', isDefault: false, current: false, tracking: 'origin/feature/new-thing', merged: false },
      { name: 'claim/issue-42', isDefault: false, current: false, tracking: 'origin/claim/issue-42', merged: false }
    ]);
    wt.listWorktrees.mockResolvedValue([]);
    execGh.mockResolvedValue('[]');
    git.isBranchMergedInto.mockResolvedValue(false);

    const res = await reconcile('/repo');
    expect(res.inFlight.map((i) => i.branch)).toEqual(['claim/issue-42', 'feature/new-thing', 'scratch-thing']);
    expect(res.inFlight.every((i) => i.state === 'NEEDS_PR')).toBe(true);
  });

  it('cleans merged, returns in-flight + wip partitions', async () => {
    git.getBranches.mockResolvedValue([
      { name: 'next/issue-2190', isDefault: false, current: false, tracking: 'origin/x', merged: true },
      { name: 'next/issue-2199', isDefault: false, current: false, tracking: 'origin/y', merged: false },
      { name: 'wip-local', isDefault: false, current: false, tracking: '', merged: false }
    ]);
    wt.listWorktrees.mockResolvedValue([]);
    execGh.mockResolvedValue(JSON.stringify([
      { number: 2206, headRefName: 'next/issue-2199', mergeable: 'MERGEABLE', isDraft: false, url: 'u' }
    ]));
    // Branch-aware: only 2190 is merged (gather short-circuits it via merged:true;
    // this also satisfies the cleanup re-check). 2199 must stay un-merged so it
    // classifies IN_REVIEW rather than being swept into cleanup.
    git.isBranchMergedInto.mockImplementation(async (_dir, branch) => branch === 'next/issue-2190');

    const res = await reconcile('/repo');
    expect(res.cleaned).toEqual(['next/issue-2190']);
    expect(res.inFlight.map((i) => i.branch)).toEqual(['next/issue-2199']);
    expect(res.inFlight[0].state).toBe('IN_REVIEW');
    expect(res.wip.map((i) => i.branch)).toEqual(['wip-local']);
  });

  // Regression for the "3 orphan cos branches, no active agents, reconcile says
  // nothing in flight" report: surface the branch instead of silently skipping it,
  // and — critically — do NOT delete the worktree holding the only copy of the work.
  it('surfaces a dead agent\'s uncommitted work as in-flight instead of skipping it, and never deletes the worktree', async () => {
    git.getBranches.mockResolvedValue([
      { name: 'cos/task-x/agent-deadbeef', isDefault: false, current: false, tracking: 'origin/main', merged: true }
    ]);
    wt.listWorktrees.mockResolvedValue([
      { path: '/repo/data/cos/worktrees/agent-deadbeef', branch: 'refs/heads/cos/task-x/agent-deadbeef' }
    ]);
    git.isBranchMergedInto.mockResolvedValue(true);
    // Uncommitted work in the worktree.
    execGit.mockResolvedValue({ stdout: ' M server/services/thing.js\n?? server/services/newThing.js\n', exitCode: 0 });

    const res = await reconcile('/repo', { activeAgentIds: new Set() });
    expect(res.inFlight.map((i) => i.state)).toEqual(['ABANDONED_WIP']);
    expect(res.cleaned).toEqual([]);
    expect(wt.forceRemoveWorktreeDir).not.toHaveBeenCalled();
    expect(git.deleteBranch).not.toHaveBeenCalled();
  });

  it('still leaves that branch untouched while its agent is running', async () => {
    git.getBranches.mockResolvedValue([
      { name: 'cos/task-x/agent-deadbeef', isDefault: false, current: false, tracking: 'origin/main', merged: true }
    ]);
    wt.listWorktrees.mockResolvedValue([
      { path: '/repo/data/cos/worktrees/agent-deadbeef', branch: 'refs/heads/cos/task-x/agent-deadbeef' }
    ]);
    git.isBranchMergedInto.mockResolvedValue(true);
    execGit.mockResolvedValue({ stdout: ' M server/services/thing.js\n', exitCode: 0 });

    const res = await reconcile('/repo', { activeAgentIds: new Set(['agent-deadbeef']) });
    expect(res.inFlight).toEqual([]);
    expect(res.skipped.map((s) => s.reason)).toEqual(['worktree-active-agent']);
    expect(wt.forceRemoveWorktreeDir).not.toHaveBeenCalled();
  });
});

describe('actionOn', () => {
  it('is ON for absent/true, OFF only for explicit false', () => {
    expect(actionOn(undefined, 'openPr')).toBe(true);
    expect(actionOn({}, 'openPr')).toBe(true);
    expect(actionOn({ openPr: true }, 'openPr')).toBe(true);
    expect(actionOn({ openPr: false }, 'openPr')).toBe(false);
  });
});

describe('filterActionable', () => {
  const inFlight = [
    { branch: 'a', state: 'NEEDS_PR' },
    { branch: 'b', state: 'CONFLICTED' },
    { branch: 'c', state: 'IN_REVIEW' }
  ];

  it('keeps every state when all actions are on (defaults)', () => {
    expect(filterActionable(inFlight, {}).map((b) => b.branch)).toEqual(['a', 'b', 'c']);
  });

  it('drops NEEDS_PR when openPr is off', () => {
    expect(filterActionable(inFlight, { openPr: false }).map((b) => b.branch)).toEqual(['b', 'c']);
  });

  it('drops CONFLICTED when resolveConflicts is off, and IN_REVIEW only when BOTH resolveConflicts and autoMerge are off', () => {
    expect(filterActionable(inFlight, { resolveConflicts: false }).map((b) => b.branch)).toEqual(['a', 'c']);
    expect(filterActionable(inFlight, { resolveConflicts: false, autoMerge: false }).map((b) => b.branch)).toEqual(['a']);
  });

  it('never surfaces a non-actionable state (MERGED/WIP)', () => {
    expect(filterActionable([{ branch: 'm', state: 'MERGED' }, { branch: 'w', state: 'WIP' }], {})).toEqual([]);
  });

  it('keeps ABANDONED_WIP by default and drops it only when finishAbandoned is off', () => {
    const abandoned = [{ branch: 'z', state: 'ABANDONED_WIP' }];
    expect(filterActionable(abandoned, {}).map((b) => b.branch)).toEqual(['z']);
    expect(filterActionable(abandoned, { finishAbandoned: false })).toEqual([]);
  });
});

describe('desiredEndState', () => {
  it('tells IN_REVIEW to merge only when autoMerge is on', () => {
    expect(desiredEndState('IN_REVIEW', {})).toContain('gh pr merge <num> --merge --delete-branch');
    expect(desiredEndState('IN_REVIEW', { autoMerge: false })).toContain('Do NOT merge');
  });

  // The supersession gate is the answer to "is this work still needed?" — the one
  // failure a completeness check cannot catch, because superseded work IS
  // complete. It has to reach every state that can end in a merge, and it has to
  // come FIRST: once an agent has resolved the conflicts, the regression looks
  // like a deliberate merge.
  it.each(['ABANDONED_WIP', 'NEEDS_PR', 'CONFLICTED'])('opens the %s instruction with the supersession gate', (state) => {
    const instruction = desiredEndState(state, {}, {
      behind: 101,
      collisionPaths: ['server/services/agentWorktreeCleanup.js', 'client/src/components/cos/constants.js'],
      worktreePath: '/wt/agent-deadbeef'
    });
    expect(instruction).toContain('101 commit(s) behind');
    expect(instruction).toContain('`server/services/agentWorktreeCleanup.js`');
    expect(instruction).toContain('SUPERSEDED');
    expect(instruction).toContain('still needed');
    // Ordering: the gate precedes any instruction to commit/rebase/resolve.
    const gateAt = instruction.indexOf('still needed');
    for (const later of ['/do:pr', 'resolve all conflicts', 'commit it on this branch']) {
      const at = instruction.indexOf(later);
      if (at !== -1) expect(at).toBeGreaterThan(gateAt);
    }
  });

  it('names a resolvable conflict as NOT proof the work is wanted', () => {
    const instruction = desiredEndState('CONFLICTED', {}, { behind: 40, collisionPaths: ['server/services/thing.js'] });
    expect(instruction).toContain('a conflict you can resolve is exactly how a regression gets in');
  });

  it('softens the gate but keeps it when nothing collides', () => {
    const instruction = desiredEndState('NEEDS_PR', {}, { behind: 2, collisionPaths: [] });
    expect(instruction).toContain('supersession is unlikely');
    expect(instruction).not.toContain('read the default branch\'s current version');
  });

  // A rebase onto a moved default branch can break code that passed on the old
  // base, and a red PR costs a full round trip to notice.
  it.each(['ABANDONED_WIP', 'NEEDS_PR', 'CONFLICTED'])('makes %s rebase and run the suites before pushing', (state) => {
    const instruction = desiredEndState(state, {}, { worktreePath: '/wt/agent-deadbeef' });
    expect(instruction).toContain('Rebase onto the default branch before opening or updating a PR');
    expect(instruction).toContain('Never push a branch whose tests you have not seen pass');
  });

  it('tells ABANDONED_WIP to read the worktree first, refuse a half-finished commit, then ship', () => {
    const instruction = desiredEndState('ABANDONED_WIP', {}, { worktreePath: '/wt/agent-deadbeef' });
    expect(instruction).toContain('/wt/agent-deadbeef');
    expect(instruction).toContain('UNCOMMITTED');
    expect(instruction).toContain('do not commit it and do not delete it');
    expect(instruction).toContain('/do:pr --no-merge');
    expect(instruction).toContain('gh pr merge <num> --merge --delete-branch');
  });

  it('stops ABANDONED_WIP at an open PR when autoMerge is off', () => {
    const instruction = desiredEndState('ABANDONED_WIP', { autoMerge: false }, { worktreePath: '/wt/agent-deadbeef' });
    expect(instruction).toContain('Do NOT merge');
    expect(instruction).not.toContain('gh pr merge');
  });

  it('gives NEEDS_PR a completeness gate and CONFLICTED a rebase instruction', () => {
    expect(desiredEndState('NEEDS_PR', {})).toContain('/do:pr');
    expect(desiredEndState('CONFLICTED', {})).toContain('Rebase');
  });

  // CONFLICTED must drive to merge exactly like the other three merge-eligible
  // states — otherwise an agent that resolves conflicts and pushes just stops,
  // leaving a green PR open until the next scheduled run re-classifies it as
  // IN_REVIEW, contradicting driveToMerge's own "opening the PR is NOT the end
  // state" principle.
  it('tells CONFLICTED to merge only when autoMerge is on', () => {
    expect(desiredEndState('CONFLICTED', {})).toContain('gh pr merge <num> --merge --delete-branch');
    expect(desiredEndState('CONFLICTED', { autoMerge: false })).toContain('Do NOT merge');
    expect(desiredEndState('CONFLICTED', { autoMerge: false })).not.toContain('gh pr merge');
  });

  // The miss this pins: a NEEDS_PR run opened a PR, reported "left open for
  // review", and exited 51s later — while CI was still running on a branch the
  // task was supposed to finish. "PR opened" is a step, not the end state.
  it('drives NEEDS_PR past the PR to a merge when autoMerge is on', () => {
    const instruction = desiredEndState('NEEDS_PR', {});
    expect(instruction).toContain('gh pr checks <num> --required');
    expect(instruction).toContain('gh pr merge <num> --merge --delete-branch');
    expect(instruction).toContain('NOT the end state');
  });

  it('stops NEEDS_PR at an open PR when autoMerge is off', () => {
    const instruction = desiredEndState('NEEDS_PR', { autoMerge: false });
    expect(instruction).toContain('Do NOT merge');
    expect(instruction).not.toContain('gh pr merge');
  });

  // `/do:pr --merge` hands the merge to slashdo, which tries GitHub-native
  // auto-merge first and reports the PR as "queued" — ending the run with CI
  // still pending, the exact unattended exit this instruction closes. So the PR
  // is always opened with `--no-merge` and the merge gate stays in the Do: line.
  it('always opens the PR with --no-merge so the merge gate stays in-session', () => {
    for (const actions of [{}, { autoMerge: false }]) {
      const instruction = desiredEndState('NEEDS_PR', actions);
      expect(instruction).toContain('/do:pr --no-merge');
      expect(instruction).not.toContain('/do:pr --merge');
    }
  });

  it('makes both merge-bound states wait for CI in-session and forbid queued auto-merge', () => {
    for (const state of ['NEEDS_PR', 'IN_REVIEW']) {
      const instruction = desiredEndState(state, {});
      expect(instruction).toContain('gh pr checks <num> --required');
      expect(instruction).toContain('Never `--auto`');
    }
  });

  // branch-reconcile runs against ANY managed app; a repo that disallows merge
  // commits would strand the branch on a hardcoded `--merge`.
  it('gives the merge a method fallback and keeps it out of the branch worktree', () => {
    const instruction = desiredEndState('IN_REVIEW', {});
    expect(instruction).toContain('`--squash`');
    expect(instruction).toContain('`--rebase`');
    expect(instruction).toContain('NOT from inside the branch\'s worktree');
    // Worktree first, then the branch — the delete fails while it's checked out.
    expect(instruction).toContain('remove the branch\'s worktree first, then delete the local branch');
  });

  it('names the real PR number when the branch already has one', () => {
    const instruction = desiredEndState('IN_REVIEW', {}, { prNumber: 42 });
    expect(instruction).toContain('gh pr checks 42 --required');
    expect(instruction).toContain('gh pr merge 42 --merge --delete-branch');
    expect(instruction).not.toContain('<num>');
  });

  // A repo without Copilot review enabled never produces one — an unbounded
  // "await the review" would strand a green PR open forever.
  it('time-boxes the IN_REVIEW Copilot gate', () => {
    expect(desiredEndState('IN_REVIEW', {})).toContain('within 10 minutes');
  });
});

describe('actionableSignature', () => {
  it('is order-independent', () => {
    const a = [{ branch: 'x', state: 'NEEDS_PR', openPr: null }, { branch: 'y', state: 'IN_REVIEW', openPr: { number: 5 } }];
    const b = [{ branch: 'y', state: 'IN_REVIEW', openPr: { number: 5 } }, { branch: 'x', state: 'NEEDS_PR', openPr: null }];
    expect(actionableSignature(a)).toBe(actionableSignature(b));
  });

  it('changes when a branch advances state (progress) — drives the drain forward', () => {
    const before = [{ branch: 'x', state: 'NEEDS_PR', openPr: null }];
    const after = [{ branch: 'x', state: 'IN_REVIEW', openPr: { number: 9 } }];
    expect(actionableSignature(before)).not.toBe(actionableSignature(after));
  });

  it('is identical for the same stuck set (no progress) — the park trigger', () => {
    const set = [{ branch: 'stuck', state: 'NEEDS_PR', openPr: null }];
    expect(actionableSignature(set)).toBe(actionableSignature([{ branch: 'stuck', state: 'NEEDS_PR', openPr: null }]));
  });

  it('changes when a branch leaves the set (merged/cleaned)', () => {
    const two = [{ branch: 'a', state: 'IN_REVIEW', openPr: { number: 1 } }, { branch: 'b', state: 'NEEDS_PR', openPr: null }];
    const one = [{ branch: 'b', state: 'NEEDS_PR', openPr: null }];
    expect(actionableSignature(two)).not.toBe(actionableSignature(one));
  });

  it('changes when an IN_REVIEW PR becomes mergeable (readiness advanced within the same state)', () => {
    const unknown = [{ branch: 'a', state: 'IN_REVIEW', openPr: { number: 3, mergeable: 'UNKNOWN' } }];
    const mergeable = [{ branch: 'a', state: 'IN_REVIEW', openPr: { number: 3, mergeable: 'MERGEABLE' } }];
    expect(actionableSignature(unknown)).not.toBe(actionableSignature(mergeable));
  });

  it('empty set yields an empty signature', () => {
    expect(actionableSignature([])).toBe('');
  });
});

describe('formatInFlightForPrompt', () => {
  it('renders the default branch, each branch with its PR + worktree + Do line', () => {
    const block = formatInFlightForPrompt([
      { branch: 'next/issue-1', state: 'IN_REVIEW', worktreePath: '/wt/1', openPr: { number: 42, mergeable: 'MERGEABLE', url: 'https://pr/42' } },
      { branch: 'next/issue-2', state: 'NEEDS_PR' }
    ], { defaultBranch: 'main', actions: {} });
    expect(block).toContain('Default branch: `main`');
    expect(block).toContain('Branches to reconcile (2)');
    expect(block).toContain('### `next/issue-1` [IN_REVIEW] — PR #42 (MERGEABLE) https://pr/42');
    expect(block).toContain('- Worktree: `/wt/1`');
    expect(block).toContain('### `next/issue-2` [NEEDS_PR] — no PR');
    expect(block).toContain('- Do: ');
  });

  // The collision set gets its own line, not just prose inside the Do: text, so
  // the agent can open those files directly instead of re-deriving the set.
  it('surfaces drift and the collision files as their own lines', () => {
    const block = formatInFlightForPrompt([{
      branch: 'cos/task-x/agent-deadbeef',
      state: 'ABANDONED_WIP',
      worktreePath: '/wt/agent-deadbeef',
      behind: 101,
      ahead: 0,
      collisionPaths: ['server/services/agentWorktreeCleanup.js']
    }], { defaultBranch: 'main', actions: {} });
    expect(block).toContain('- Drift: 101 commit(s) behind `main`, 0 ahead');
    expect(block).toContain('**read these first — they are where supersession shows up**');
    expect(block).toContain('`server/services/agentWorktreeCleanup.js`');
    expect(block).toContain('holds UNCOMMITTED work');
  });

  it('omits the drift and collision lines when there is nothing to report', () => {
    const block = formatInFlightForPrompt(
      [{ branch: 'fresh', state: 'NEEDS_PR', behind: 0, ahead: 3, collisionPaths: [] }],
      { defaultBranch: 'main', actions: {} }
    );
    expect(block).toContain('- Drift: 0 commit(s) behind');
    expect(block).not.toContain('supersession shows up');
  });
});
