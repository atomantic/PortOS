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
  classifyWorktreeDirt: vi.fn((p) => ({ hasRealChanges: Boolean((p || '').trim()) })),
  isHumanClaimWorktree: vi.fn((id) => typeof id === 'string' && id.startsWith('claim-'))
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
  classifyBranch, classifyBranches, cleanupMerged, reconcile, gatherBranchState, worktreeProtectionReason,
  actionOn, filterActionable, desiredEndState, formatInFlightForPrompt
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
});

describe('worktreeProtectionReason', () => {
  it('flags locked, human-claim, and active-agent worktrees; passes ordinary ones', () => {
    expect(worktreeProtectionReason({ path: '/wt/x', locked: true })).toBe('worktree-locked');
    expect(worktreeProtectionReason({ path: '/x/claim-foo' })).toBe('worktree-human-claim');
    expect(worktreeProtectionReason({ path: '/x/agent-1', activeAgentIds: new Set(['agent-1']) })).toBe('worktree-active-agent');
    expect(worktreeProtectionReason({ path: '/repo/next-issue-2199', activeAgentIds: new Set(['agent-1']) })).toBeNull();
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
});

describe('desiredEndState', () => {
  it('tells IN_REVIEW to merge only when autoMerge is on', () => {
    expect(desiredEndState('IN_REVIEW', {})).toContain('gh pr merge --merge --delete-branch');
    expect(desiredEndState('IN_REVIEW', { autoMerge: false })).toContain('Do NOT merge');
  });

  it('gives NEEDS_PR a completeness gate and CONFLICTED a rebase instruction', () => {
    expect(desiredEndState('NEEDS_PR', {})).toContain('/do:pr');
    expect(desiredEndState('CONFLICTED', {})).toContain('Rebase');
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
});
