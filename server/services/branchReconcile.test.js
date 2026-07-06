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
  // Real pure classifier semantics: empty porcelain = clean.
  classifyWorktreeDirt: vi.fn((p) => ({ hasRealChanges: Boolean((p || '').trim()) }))
}));
vi.mock('./github.js', () => ({ execGh: vi.fn(async () => '[]') }));
vi.mock('../lib/gitRemote.js', () => ({
  getOriginInfo: vi.fn(async () => ({ isGithub: true, fullName: 'atomantic/PortOS' }))
}));
vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { root: '/repo' },
  safeJSONParse: (raw, fallback) => { try { return JSON.parse(raw); } catch { return fallback; } }
}));

import {
  classifyBranch, classifyBranches, cleanupMerged, reconcile, gatherBranchState
} from './branchReconcile.js';
import * as git from './git.js';
import * as wt from './worktreeManager.js';
import { execGit } from '../lib/execGit.js';
import { execGh } from './github.js';

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
});

describe('gatherBranchState', () => {
  it('excludes default/current/protected and folds in worktree + PR facts', async () => {
    git.getBranches.mockResolvedValue([
      { name: 'main', isDefault: true, current: true, tracking: 'origin/main', merged: false },
      { name: 'release', isDefault: false, current: false, tracking: 'origin/release', merged: false },
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
    expect(names).toEqual(['next/issue-2199', 'next/issue-2190']); // main + release excluded

    const i2199 = inputs.find((i) => i.branch === 'next/issue-2199');
    expect(i2199.hasWorktree).toBe(true);
    expect(i2199.openPr.number).toBe(2206);
    expect(inputs.find((i) => i.branch === 'next/issue-2190').isMerged).toBe(true);
  });
});

describe('reconcile', () => {
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
});
