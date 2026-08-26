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
  reapMergedWorktrees: vi.fn(async () => ({ reaped: [], skipped: [] })),
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
}));
// Worktree age drives the claim windows (STALE_CLAIM_IDLE_MS / SHIPPED_CLAIM_IDLE_MS),
// and gatherBranchState reads it via stat(). Default to "ancient" so tests that
// don't care about age behave as before; set worktreeMtimeMs to pin a specific age.
let worktreeMtimeMs = 0;
vi.mock('node:fs/promises', () => ({
  stat: vi.fn(async () => ({ mtimeMs: worktreeMtimeMs })),
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
// `tryReadFile`/`atomicWrite` are reached through supersededLedger.js (the
// SUPERSEDED verdict cache); the default `tryReadFile` returns null = no ledger,
// which is the fail-open "analyze everything" path the pre-#3842 suite assumes.
const tryReadFileMock = vi.fn(async () => null);
vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { root: '/repo', cos: '/repo/data/cos' },
  safeJSONParse: (raw, fallback) => { try { return JSON.parse(raw); } catch { return fallback; } },
  isPathInsideDir: (dir, candidate) => typeof dir === 'string' && typeof candidate === 'string'
    && candidate.startsWith(`${dir}/`),
  tryReadFile: (...args) => tryReadFileMock(...args),
  atomicWrite: vi.fn(async () => {})
}));

import {
  classifyBranch, classifyBranches, cleanupMerged, reconcile, gatherBranchState, worktreeProtectionReason,
  isAbandonedAgentWorktree, resolveLiveOwnerReason, gatherDivergence,
  actionOn, filterActionable, desiredEndState, formatInFlightForPrompt, actionableSignature,
  limitBranchesForAgent,
  branchPriorityRank, prioritizeBranches, worktreeProtectionExpiresAt, describeIdleReconcilePark,
  SHIPPED_CLAIM_IDLE_MS, STALE_CLAIM_IDLE_MS,
  upstreamBranchName, parseRemoteHeads, partitionRemoteOrphans, reapOrphanedRemotes
} from './branchReconcile.js';
import * as git from './git.js';
import * as wt from './worktreeManager.js';
import { execGit } from '../lib/execGit.js';
import { execGh } from './github.js';
import { getOriginInfo } from '../lib/gitRemote.js';

beforeEach(() => {
  vi.clearAllMocks();
  // Ancient by default, so age-indifferent tests keep their pre-window behavior;
  // a test that pins a specific age must not leak it into the next one.
  worktreeMtimeMs = 0;
  // clearAllMocks keeps implementations, so restore the default GitHub origin —
  // a case that swaps in a GitLab/origin-less remote would otherwise leak into
  // every test after it.
  getOriginInfo.mockResolvedValue({
    hasOrigin: true, isGithub: true, host: 'github.com', fullName: 'atomantic/PortOS'
  });
  git.getDefaultBranch.mockResolvedValue('main');
  git.deleteBranch.mockResolvedValue({ branch: 'x', results: { local: 'deleted' } });
  wt.forceRemoveWorktreeDir.mockResolvedValue(undefined);
  wt.reapMergedWorktrees.mockResolvedValue({ reaped: [], skipped: [] });
  execGit.mockResolvedValue({ stdout: '', exitCode: 0 });
  tryReadFileMock.mockResolvedValue(null);
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
  // A branch somebody is working in right now keeps moving on its own; dispatching
  // an agent onto it both races the live session and re-advances the drain's
  // progress signature every cycle (the overnight re-dispatch loop).
  it('clean worktree of a LIVE owner → WIP, even with an open PR', () => {
    const live = { isMerged: false, hasUpstream: true, worktreeDirty: false, liveOwnerReason: 'worktree-active-agent' };
    expect(classifyBranch({ ...live, openPr: { mergeable: 'MERGEABLE' } })).toBe('WIP');
    expect(classifyBranch({ ...live, openPr: { mergeable: 'CONFLICTING' } })).toBe('WIP');
    expect(classifyBranch({ ...live, openPr: null })).toBe('WIP');
  });
  it('a live worktree does NOT hide a merged branch from cleanup (MERGED still wins)', () => {
    expect(classifyBranch({
      isMerged: true, hasUpstream: true, worktreeDirty: false,
      liveOwnerReason: 'worktree-active-agent', openPr: null
    })).toBe('MERGED');
  });
  it('an ABANDONED agent worktree is still driven (its owner is not live)', () => {
    expect(classifyBranch({
      isMerged: false, hasUpstream: true, worktreeDirty: true, abandonedAgentWorktree: true,
      liveOwnerReason: null, openPr: null
    })).toBe('ABANDONED_WIP');
  });
  it('local-only bare pointer (no upstream, no commits of its own) → WIP', () => {
    expect(classifyBranch({ isMerged: false, openPr: null, hasUpstream: false, worktreeDirty: false })).toBe('WIP');
    expect(classifyBranch({ isMerged: false, openPr: null, hasUpstream: false, worktreeDirty: false, ahead: 0 })).toBe('WIP');
  });

  // The shape of eight `claim/*` branches that sat unreconciled: each /claim
  // session committed real work and died before its `git push -u`, so the branch
  // had commits ahead of `main` and no upstream — classified WIP, never in-flight,
  // and every run parked on "no branches in flight" with the work still sitting there.
  it('classifies a never-pushed branch holding commits as NEEDS_PR', () => {
    expect(classifyBranch({
      isMerged: false, openPr: null, hasUpstream: false, worktreeDirty: false, ahead: 2
    })).toBe('NEEDS_PR');
  });

  it('leaves a never-pushed branch WIP when its commit count is unreadable', () => {
    expect(classifyBranch({
      isMerged: false, openPr: null, hasUpstream: false, worktreeDirty: false, ahead: null
    })).toBe('WIP');
  });

  it('still protects a never-pushed branch that is dirty or live-owned', () => {
    expect(classifyBranch({
      isMerged: false, openPr: null, hasUpstream: false, worktreeDirty: true, ahead: 3
    })).toBe('WIP');
    expect(classifyBranch({
      isMerged: false, openPr: null, hasUpstream: false, worktreeDirty: false, ahead: 3,
      liveOwnerReason: 'worktree-active-agent'
    })).toBe('WIP');
  });

  it('does not conclude "no PR" for a never-pushed branch when the forge was unreadable', () => {
    expect(classifyBranch({
      isMerged: false, openPr: null, hasUpstream: false, worktreeDirty: false, ahead: 3,
      prStateUnavailable: true
    })).toBe('WIP');
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

  it('still protects a RECENT claim worktree even when merged + clean, and says when the hold lifts', async () => {
    git.isBranchMergedInto.mockResolvedValue(true);
    execGit.mockResolvedValue({ stdout: '', exitCode: 0 }); // clean
    const before = Date.now();
    const res = await cleanupMerged('/repo', 'main', [
      { branch: 'claim/issue-9999', worktreePath: '/repo/data/cos/worktrees/claim-issue-9999', worktreeAgeMs: 60 * 1000 } // 1 min old
    ]);
    expect(res.cleaned).toEqual([]);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0]).toMatchObject({ branch: 'claim/issue-9999', reason: 'worktree-human-claim' });
    // The whole point of retryAt: the caller can park until the grace window
    // lapses instead of sleeping to the next recheck. ~7 days minus 1 minute out.
    const retryMs = Date.parse(res.skipped[0].retryAt);
    expect(retryMs).toBeGreaterThan(before + 6.9 * 24 * 60 * 60 * 1000);
    expect(retryMs).toBeLessThanOrEqual(Date.now() + 7 * 24 * 60 * 60 * 1000);
    expect(wt.forceRemoveWorktreeDir).not.toHaveBeenCalled();
    expect(git.deleteBranch).not.toHaveBeenCalled();
  });

  it('reaps a SHIPPED claim once idle, but not while dirty, un-shipped, or still busy', async () => {
    const HOUR = 60 * 60 * 1000;
    const shipped = (over) => ({
      worktreePath: '/repo/data/cos/worktrees/claim-x', worktreeAgeMs: 2 * HOUR, upstreamGone: true, ...over
    });
    git.isBranchMergedInto.mockResolvedValue(true);

    execGit.mockResolvedValue({ stdout: '', exitCode: 0 }); // clean
    const reaped = await cleanupMerged('/repo', 'main', [{ branch: 'claim/issue-0', ...shipped() }]);
    expect(reaped.cleaned).toEqual(['claim/issue-0']);

    // The dirty gate is independent — a shorter window never overrides it.
    execGit.mockResolvedValue({ stdout: ' M server/index.js', exitCode: 0 }); // dirty
    const dirty = await cleanupMerged('/repo', 'main', [{ branch: 'claim/issue-1', ...shipped() }]);
    expect(dirty.cleaned).toEqual([]);
    expect(dirty.skipped).toEqual([{ branch: 'claim/issue-1', reason: 'worktree-dirty' }]);

    execGit.mockResolvedValue({ stdout: '', exitCode: 0 }); // clean
    // No completion proof — never pushed, remote ref still on origin, or the
    // remote could not be read. The week-long window still applies.
    const unshipped = await cleanupMerged('/repo', 'main', [
      { branch: 'claim/issue-2', ...shipped({ upstreamGone: false }) }
    ]);
    expect(unshipped.cleaned).toEqual([]);
    expect(unshipped.skipped[0]).toMatchObject({ branch: 'claim/issue-2', reason: 'worktree-human-claim' });

    // Shipped but touched a minute ago — a claim process mid-teardown, or a peer
    // machine merged the PR while this session is still running. Held, and the
    // caller is told when the short window lapses.
    const busy = await cleanupMerged('/repo', 'main', [
      { branch: 'claim/issue-3', ...shipped({ worktreeAgeMs: 60 * 1000 }) }
    ]);
    expect(busy.cleaned).toEqual([]);
    expect(busy.skipped[0]).toMatchObject({ branch: 'claim/issue-3', reason: 'worktree-human-claim' });
    expect(Date.parse(busy.skipped[0].retryAt)).toBeLessThanOrEqual(Date.now() + SHIPPED_CLAIM_IDLE_MS);
  });

  it('omits retryAt for holds that do NOT lift on a clock', async () => {
    git.isBranchMergedInto.mockResolvedValue(true);
    const res = await cleanupMerged('/repo', 'main', [
      { branch: 'locked-b', worktreePath: '/wt/locked', worktreeLocked: true, worktreeAgeMs: 60 * 1000 },
      { branch: 'active-b', worktreePath: '/repo/data/cos/worktrees/agent-abc12345', worktreeAgeMs: 60 * 1000 }
    ], { activeAgentIds: new Set(['agent-abc12345']) });
    // A lock and a running agent both end at a time nothing here can predict —
    // inventing one would park the drain past a hold that may already be gone.
    expect(res.skipped).toEqual([
      { branch: 'locked-b', reason: 'worktree-locked' },
      { branch: 'active-b', reason: 'worktree-active-agent' }
    ]);
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

  // A shipped claim gets a SHORTER window, not a bypass — so a worktree a live
  // claim process is still standing in (it just merged, or a peer machine merged
  // for it) is protected until it has been idle, and an unreadable mtime still
  // fails safe. Both properties come free from reusing the window; a bypass had
  // neither.
  it('honors the short shipped-claim window without abandoning the window itself', () => {
    const at = (ageMs, staleClaimIdleMs) => worktreeProtectionReason({ path: '/x/claim-foo', ageMs, staleClaimIdleMs });
    // Just-merged and still busy: inside the short window, still protected.
    expect(at(60 * 1000, SHIPPED_CLAIM_IDLE_MS)).toBe('worktree-human-claim');
    // Idle past it: reaped, without waiting out the week-long window.
    expect(at(2 * 60 * 60 * 1000, SHIPPED_CLAIM_IDLE_MS)).toBeNull();
    expect(at(2 * 60 * 60 * 1000, STALE_CLAIM_IDLE_MS)).toBe('worktree-human-claim');
    // Unreadable mtime fails safe even for a shipped claim.
    expect(at(null, SHIPPED_CLAIM_IDLE_MS)).toBe('worktree-human-claim');
    expect(SHIPPED_CLAIM_IDLE_MS).toBeLessThan(STALE_CLAIM_IDLE_MS);
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

describe('resolveLiveOwnerReason', () => {
  const live = new Set(['agent-aaaaaaaa']);

  it('reports dispatch-side ownership while cleanup keeps claim worktrees protected', () => {
    expect(resolveLiveOwnerReason({ path: '/wt/agent-aaaaaaaa', activeAgentIds: live })).toBe('worktree-active-agent');
    expect(resolveLiveOwnerReason({ path: '/wt/agent-bbbbbbbb', locked: true, activeAgentIds: live })).toBe('worktree-locked');
    // A claim directory identifies the claim, but not a live process — this side
    // passes allowLiveClaim. The cleanup-side protection remains covered by
    // worktreeProtectionReason. A lock still wins, structurally: the gate tests
    // it before the claim, so no slug rewriting happens here.
    expect(resolveLiveOwnerReason({ path: '/wt/claim-fix-thing', activeAgentIds: live })).toBeNull();
    expect(resolveLiveOwnerReason({ path: '/wt/claim-fix-thing', locked: true, activeAgentIds: live })).toBe('worktree-locked');
  });

  it('lets a LIVE owner outrank the claim exception, not the other way round', () => {
    // activeAgentIds holds `agent-<id>` keys, so a claim basename can only land
    // there out of contract — but the gate tests liveness BEFORE the claim, so
    // if one ever did, the branch is held rather than dispatched. That is the
    // intended direction: never hand a branch to an agent while something says
    // a process still owns it.
    expect(resolveLiveOwnerReason({ path: '/wt/claim-fix-thing', activeAgentIds: new Set(['claim-fix-thing']) }))
      .toBe('worktree-active-agent');
  });

  it('is null for a free worktree, a dead agent, and no worktree at all', () => {
    expect(resolveLiveOwnerReason({ path: '/wt/agent-bbbbbbbb', activeAgentIds: live })).toBeNull();
    expect(resolveLiveOwnerReason({ path: '/wt/next-issue-42', activeAgentIds: live })).toBeNull();
    expect(resolveLiveOwnerReason({ path: null, activeAgentIds: live })).toBeNull();
  });

  // The one case worktreeProtectionReason can't answer: it is only ever called with
  // an authoritative Set, so a missing one reads there as "nobody is running". For a
  // DISPATCH decision that default is backwards — presume live, like
  // isAbandonedAgentWorktree does.
  it('presumes an agent worktree is live when liveness is UNKNOWN', () => {
    expect(resolveLiveOwnerReason({ path: '/wt/agent-bbbbbbbb' })).toBe('worktree-agent-liveness-unknown');
    expect(resolveLiveOwnerReason({ path: '/wt/agent-bbbbbbbb', activeAgentIds: ['agent-cccccccc'] })).toBe('worktree-agent-liveness-unknown');
    // …but an authoritative empty Set really does mean nothing is running.
    expect(resolveLiveOwnerReason({ path: '/wt/agent-bbbbbbbb', activeAgentIds: new Set() })).toBeNull();
    // and a non-agent worktree is nobody's live session either way.
    expect(resolveLiveOwnerReason({ path: '/wt/next-issue-42' })).toBeNull();
  });

  // Ownership lives in the branch NAME (`cos/<taskId>/<agentId>`), so it outlives the
  // worktree. /do:pr's Phase-7 cleanup removes the worktree while the agent is still
  // running — without this the branch reads as un-owned, classifies IN_REVIEW, and
  // the coordinator is dispatched onto a branch its own agent is still pushing to.
  it('holds a branch whose OWNING agent is live even after its worktree is gone', () => {
    expect(resolveLiveOwnerReason({ branch: 'cos/task-abc/agent-aaaaaaaa', path: null, activeAgentIds: live }))
      .toBe('branch-active-agent');
    // A finished agent's branch is free again.
    expect(resolveLiveOwnerReason({ branch: 'cos/task-abc/agent-bbbbbbbb', path: null, activeAgentIds: live })).toBeNull();
    // Non-agent branch names are never owner keys, even by coincidence of suffix.
    expect(resolveLiveOwnerReason({ branch: 'feature/agent-aaaaaaaa-ui', path: null, activeAgentIds: live })).toBeNull();
    expect(resolveLiveOwnerReason({ branch: 'main', path: null, activeAgentIds: live })).toBeNull();
    // Liveness must be authoritative to claim a branch is owned — a non-Set can't
    // answer, and the branch alone (unlike an agent-* worktree) is not evidence.
    expect(resolveLiveOwnerReason({ branch: 'cos/task-abc/agent-aaaaaaaa', path: null })).toBeNull();
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

  it('surfaces a mid-cycle gh failure as prStateUnavailable so the caller retries instead of parking', async () => {
    git.getBranches.mockResolvedValue([
      { name: 'claim/issue-1', isDefault: false, current: false, tracking: 'origin/claim/issue-1', merged: false }
    ]);
    wt.listWorktrees.mockResolvedValue([]);
    execGh.mockRejectedValue(new Error('connect: bad file descriptor'));
    git.isBranchMergedInto.mockResolvedValue(false);

    const res = await reconcile('/repo');
    // The probe passed, so the cycle ran — but the in-flight set is empty for a
    // reason that says nothing about the repo, and parking on it would sit out a
    // full recheck cadence.
    expect(res.forgeUnavailable).toBeUndefined();
    expect(res.prStateUnavailable).toBe(true);
    expect(res.inFlight).toEqual([]);
  });

  it('leaves prStateUnavailable false on a clean cycle', async () => {
    git.getBranches.mockResolvedValue([
      { name: 'claim/issue-1', isDefault: false, current: false, tracking: 'origin/claim/issue-1', merged: false }
    ]);
    wt.listWorktrees.mockResolvedValue([]);
    execGh.mockResolvedValue('[]');
    git.isBranchMergedInto.mockResolvedValue(false);
    expect((await reconcile('/repo')).prStateUnavailable).toBe(false);
  });

  it('probes THIS repo\'s API host so an enterprise checkout is not gated on github.com', async () => {
    getOriginInfo.mockResolvedValue({ hasOrigin: true, isGithub: false, host: 'github.acme-corp.example', fullName: 'o/r' });
    ensureForgeReachableMock.mockResolvedValueOnce({ ok: false, status: 'not-authenticated', detail: null });
    await reconcile('/repo');
    expect(ensureForgeReachableMock).toHaveBeenCalledWith('branch-reconcile', { hostname: 'github.acme-corp.example' });
  });

  it('does not gate a non-GitHub repo on the gh probe — it has no gh PR state to lose', async () => {
    // A GitLab or origin-less checkout would otherwise be blocked forever from
    // the git-only merged-branch cleanup by a probe that can never pass.
    getOriginInfo.mockResolvedValue({ hasOrigin: true, isGithub: false, host: 'gitlab.example', fullName: 'g/p' });
    git.getBranches.mockResolvedValue([
      { name: 'feature/x', isDefault: false, current: false, tracking: 'origin/feature/x', merged: true }
    ]);
    wt.listWorktrees.mockResolvedValue([]);
    git.isBranchMergedInto.mockResolvedValue(true);

    const res = await reconcile('/repo');
    expect(ensureForgeReachableMock).not.toHaveBeenCalled();
    expect(res.forgeUnavailable).toBeUndefined();
    expect(res.cleaned).toEqual(['feature/x']);
  });

  it('runs clean-and-merged worktree cleanup before a forge probe', async () => {
    wt.reapMergedWorktrees.mockResolvedValueOnce({ reaped: [{ branch: 'feature/done' }], skipped: [] });
    ensureForgeReachableMock.mockResolvedValueOnce({ ok: false, status: 'unreachable', detail: 'dial tcp' });

    const res = await reconcile('/repo');
    expect(res.cleaned).toEqual(['feature/done']);
    expect(wt.reapMergedWorktrees).toHaveBeenCalledWith('/repo', {
      activeAgentIds: new Set(), includeClaudeTrees: true
    });
    expect(wt.reapMergedWorktrees.mock.invocationCallOrder[0])
      .toBeLessThan(ensureForgeReachableMock.mock.invocationCallOrder[0]);
  });

  it('skips branch classification when the gh probe is not ok', async () => {
    ensureForgeReachableMock.mockResolvedValueOnce({ ok: false, status: 'unreachable', detail: 'dial tcp' });
    const res = await reconcile('/repo');
    expect(res.forgeUnavailable).toBe(true);
    expect(res.forgeStatus).toBe('unreachable');
    expect(res.inFlight).toEqual([]);
    expect(res.cleaned).toEqual([]);
    // Crucially: no branch enumeration and no deletion happened, so the empty
    // result can't be mistaken for "the repo is clean". The cleanup-first pass
    // still ran, but had no candidates in this case.
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

  // The regression this whole `upstreamGone` path exists for: four claims whose
  // PRs had merged (deleting their remote branches) sat with their worktrees
  // intact, and every run reported "cleaned 0 / merged branches held back" for a
  // week because the claim grace window outranked the fact that they were done.
  it('cleans a SHIPPED claim end to end instead of parking on the grace window', async () => {
    git.getBranches.mockResolvedValue([
      { name: 'claim/issue-4348', isDefault: false, current: false, tracking: 'origin/claim/issue-4348', merged: true }
    ]);
    wt.listWorktrees.mockResolvedValue([
      { path: '/repo/data/cos/worktrees/claim-issue-4348', branch: 'refs/heads/claim/issue-4348' }
    ]);
    execGh.mockResolvedValue('[]');
    // ls-remote reports origin has only main — the claim's remote branch was
    // deleted when its PR merged. Everything else (status, etc.) reads clean.
    execGit.mockImplementation(async (args) => args[0] === 'ls-remote'
      ? { stdout: 'abc123\trefs/heads/main\n', exitCode: 0 }
      : { stdout: '', exitCode: 0 });
    // Idle for hours — past SHIPPED_CLAIM_IDLE_MS, so no live session is implied.
    worktreeMtimeMs = Date.now() - 4 * 60 * 60 * 1000;
    git.isBranchMergedInto.mockResolvedValue(true);

    const res = await reconcile('/repo');
    expect(res.cleaned).toEqual(['claim/issue-4348']);
    expect(res.skipped).toEqual([]);
    // Nothing left to report as held back — the park reason must be "quiet repo",
    // not "waiting on a protected worktree".
    expect(describeIdleReconcilePark(res.skipped, res.wip).reason).toBe('no-in-flight-branches');
    expect(wt.forceRemoveWorktreeDir).toHaveBeenCalledWith('/repo', '/repo/data/cos/worktrees/claim-issue-4348', expect.any(Object));
  });

  // The fail-safe half of the same signal: "we could not read origin" must never
  // read as "the remote branch is gone", or an unreachable network would start
  // reaping claim worktrees that were never shipped.
  it('does NOT treat an unreadable remote as proof a claim shipped', async () => {
    git.getBranches.mockResolvedValue([
      { name: 'claim/issue-4348', isDefault: false, current: false, tracking: 'origin/claim/issue-4348', merged: true }
    ]);
    wt.listWorktrees.mockResolvedValue([
      { path: '/repo/data/cos/worktrees/claim-issue-4348', branch: 'refs/heads/claim/issue-4348' }
    ]);
    execGh.mockResolvedValue('[]');
    execGit.mockImplementation(async (args) => args[0] === 'ls-remote'
      ? { stdout: '', exitCode: 1 } // ls-remote failed → listRemoteHeads returns null
      : { stdout: '', exitCode: 0 });
    // Idle long enough that the SHORT window would have released it — so the only
    // thing holding it back is the unreadable remote, which is what this pins.
    worktreeMtimeMs = Date.now() - 4 * 60 * 60 * 1000;
    git.isBranchMergedInto.mockResolvedValue(true);

    const res = await reconcile('/repo');
    expect(res.cleaned).toEqual([]);
    expect(res.skipped[0]).toMatchObject({ branch: 'claim/issue-4348', reason: 'worktree-human-claim' });
    expect(wt.forceRemoveWorktreeDir).not.toHaveBeenCalled();
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

  // The overnight re-dispatch loop's other half: a RUNNING agent's branch, clean
  // and with an open PR, classified IN_REVIEW and was handed to the coordinator —
  // which then raced the live session's pushes, each of which re-advanced the
  // drain's progress signature. It belongs in wip (with a liveOwnerReason), not inFlight.
  it('holds a LIVE agent\'s branch out of the in-flight set even with an open PR', async () => {
    git.getBranches.mockResolvedValue([
      { name: 'cos/task-y/agent-live1234', isDefault: false, current: false, tracking: 'origin/cos/task-y/agent-live1234', merged: false }
    ]);
    wt.listWorktrees.mockResolvedValue([
      { path: '/repo/data/cos/worktrees/agent-live1234', branch: 'refs/heads/cos/task-y/agent-live1234' }
    ]);
    git.isBranchMergedInto.mockResolvedValue(false);
    execGh.mockResolvedValue(JSON.stringify([
      { number: 4001, headRefName: 'cos/task-y/agent-live1234', mergeable: 'MERGEABLE', isDraft: false, url: 'u' }
    ]));
    // Clean worktree — the agent has committed and pushed but is still running.
    execGit.mockResolvedValue({ stdout: '', exitCode: 0 });

    const res = await reconcile('/repo', { activeAgentIds: new Set(['agent-live1234']) });
    expect(res.inFlight).toEqual([]);
    expect(res.wip.map((b) => [b.branch, b.liveOwnerReason]))
      .toEqual([['cos/task-y/agent-live1234', 'branch-active-agent']]);
    // …and the SAME repo with that agent gone is actionable again, so the hold is
    // the liveness answer and not an unconditional "cos branches are off-limits".
    const after = await reconcile('/repo', { activeAgentIds: new Set() });
    expect(after.inFlight.map((i) => i.state)).toEqual(['IN_REVIEW']);
    expect(after.wip).toEqual([]);
  });

  // The narrower window the worktree-only check missed: /do:pr Phase-7 removes the
  // agent's worktree while the agent is still running and still pushing.
  it('holds a live agent\'s branch when its worktree is ALREADY GONE', async () => {
    git.getBranches.mockResolvedValue([
      { name: 'cos/task-z/agent-live5678', isDefault: false, current: false, tracking: 'origin/cos/task-z/agent-live5678', merged: false }
    ]);
    wt.listWorktrees.mockResolvedValue([]); // worktree already cleaned up
    git.isBranchMergedInto.mockResolvedValue(false);
    execGh.mockResolvedValue(JSON.stringify([
      { number: 4002, headRefName: 'cos/task-z/agent-live5678', mergeable: 'MERGEABLE', isDraft: false, url: 'u' }
    ]));
    execGit.mockResolvedValue({ stdout: '', exitCode: 0 });

    const res = await reconcile('/repo', { activeAgentIds: new Set(['agent-live5678']) });
    expect(res.inFlight).toEqual([]);
    expect(res.wip.map((b) => b.liveOwnerReason)).toEqual(['branch-active-agent']);
  });

  it('surfaces a clean claim worktree with an open PR after its claim agent exits', async () => {
    git.getBranches.mockResolvedValue([
      { name: 'claim/issue-42', isDefault: false, current: false, tracking: 'origin/claim/issue-42', merged: false }
    ]);
    wt.listWorktrees.mockResolvedValue([
      { path: '/repo/data/cos/worktrees/claim-issue-42', branch: 'refs/heads/claim/issue-42' }
    ]);
    git.isBranchMergedInto.mockResolvedValue(false);
    execGh.mockResolvedValue(JSON.stringify([
      { number: 4200, headRefName: 'claim/issue-42', mergeable: 'MERGEABLE', isDraft: false, url: 'u' }
    ]));
    // The claim has committed its work and is no longer running. A clean claim
    // tree must be eligible for the same PR reconciliation as any other branch;
    // the cleanup-side claim guard is tested separately above.
    execGit.mockResolvedValue({ stdout: '', exitCode: 0 });

    const res = await reconcile('/repo', { activeAgentIds: new Set() });
    expect(res.inFlight.map((b) => [b.branch, b.state])).toEqual([['claim/issue-42', 'IN_REVIEW']]);
    expect(res.inFlight[0].liveOwnerReason).toBeNull();
    expect(res.wip).toEqual([]);
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

// #3842 — a SUPERSEDED branch is left untouched by design and is never `isMerged`
// (its work landed on the default branch under other names), so nothing reaps it
// and every recheck paid a full coordinator run to re-derive the same verdict.
// Two branches in this install were analyzed sixteen times that way.
describe('reconcile — cached SUPERSEDED verdicts (#3842)', () => {
  const BRANCH = 'cos/task-x/agent-deadbeef';
  const WORKTREE = '/repo/data/cos/worktrees/agent-deadbeef';
  const DIRTY = ' M server/services/thing.js\n';

  // The abandoned-worktree shape: branch fully behind main, uncommitted work in a
  // dead agent's worktree, one collision path with the default branch.
  const setupAbandoned = ({ tip = 'aaaaaaa', replacedByReachable = true } = {}) => {
    git.getBranches.mockResolvedValue([
      { name: BRANCH, isDefault: false, current: false, tracking: 'origin/main', merged: false }
    ]);
    wt.listWorktrees.mockResolvedValue([{ path: WORKTREE, branch: `refs/heads/${BRANCH}` }]);
    git.isBranchMergedInto.mockResolvedValue(false);
    execGit.mockImplementation(async (args) => {
      const [cmd] = args;
      if (cmd === 'rev-parse') return { stdout: `${tip}\n`, exitCode: 0 };
      if (cmd === 'merge-base' && args[1] === '--is-ancestor') {
        return { stdout: '', exitCode: replacedByReachable ? 0 : 1 };
      }
      if (cmd === 'merge-base') return { stdout: 'base000\n', exitCode: 0 };
      // `diff --name-only` on BOTH sides yields the same path → one collision.
      if (cmd === 'diff') return { stdout: 'server/services/thing.js\n', exitCode: 0 };
      if (cmd === 'rev-list') return { stdout: '301\t0\n', exitCode: 0 };
      // `status --porcelain` in the worktree.
      return { stdout: DIRTY, exitCode: 0 };
    });
  };

  const ledger = (over = {}) => JSON.stringify({
    version: 1,
    entries: [{
      branch: BRANCH,
      repoPath: '/repo',
      verdict: 'SUPERSEDED',
      tip: 'aaaaaaa',
      dirtyPaths: ['server/services/thing.js'],
      collisionPaths: ['server/services/thing.js'],
      replacedBy: ['ffffff1'],
      replacedByNote: 'thing.js now exports doTheThing()',
      ...over
    }]
  });

  it('drops a branch with a fresh cached verdict out of the actionable set', async () => {
    setupAbandoned();
    tryReadFileMock.mockResolvedValue(ledger());

    const res = await reconcile('/repo', { activeAgentIds: new Set() });
    expect(res.inFlight).toEqual([]);
    expect(res.superseded.map((s) => s.branch)).toEqual([BRANCH]);
    // Left completely alone — the whole point is that merging it would regress main.
    expect(wt.forceRemoveWorktreeDir).not.toHaveBeenCalled();
    expect(git.deleteBranch).not.toHaveBeenCalled();
  });

  it('re-analyzes when the branch tip moved', async () => {
    setupAbandoned({ tip: 'bbbbbbb' });
    tryReadFileMock.mockResolvedValue(ledger());

    const res = await reconcile('/repo', { activeAgentIds: new Set() });
    expect(res.inFlight.map((i) => i.branch)).toEqual([BRANCH]);
    expect(res.superseded).toEqual([]);
  });

  it('re-analyzes when the uncommitted change set moved', async () => {
    // An ABANDONED_WIP branch's entire deliverable is its dirty tree, so a tip SHA
    // alone would not notice a human editing the worktree.
    setupAbandoned();
    tryReadFileMock.mockResolvedValue(ledger({ dirtyPaths: ['server/services/other.js'] }));

    const res = await reconcile('/repo', { activeAgentIds: new Set() });
    expect(res.inFlight.map((i) => i.branch)).toEqual([BRANCH]);
    expect(res.superseded).toEqual([]);
  });

  it('re-analyzes when the collision set changed', async () => {
    setupAbandoned();
    tryReadFileMock.mockResolvedValue(ledger({ collisionPaths: [] }));

    const res = await reconcile('/repo', { activeAgentIds: new Set() });
    expect(res.inFlight.map((i) => i.branch)).toEqual([BRANCH]);
  });

  it('re-analyzes when what superseded the branch was reverted off the default branch', async () => {
    setupAbandoned({ replacedByReachable: false });
    tryReadFileMock.mockResolvedValue(ledger());

    const res = await reconcile('/repo', { activeAgentIds: new Set() });
    expect(res.inFlight.map((i) => i.branch)).toEqual([BRANCH]);
    expect(res.superseded).toEqual([]);
  });

  it('fails open on a malformed ledger rather than hiding the branch', async () => {
    setupAbandoned();
    tryReadFileMock.mockResolvedValue('{ not json');

    const res = await reconcile('/repo', { activeAgentIds: new Set() });
    expect(res.inFlight.map((i) => i.branch)).toEqual([BRANCH]);
  });

  // One ledger serves every managed app; `feature/x` in two apps is two branches.
  it('ignores a verdict recorded against a different app\'s repo', async () => {
    setupAbandoned();
    tryReadFileMock.mockResolvedValue(ledger({ repoPath: '/some/other-app' }));

    const res = await reconcile('/repo', { activeAgentIds: new Set() });
    expect(res.inFlight.map((i) => i.branch)).toEqual([BRANCH]);
    expect(res.superseded).toEqual([]);
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

describe('limitBranchesForAgent', () => {
  it('keeps the prioritized prefix and leaves the input untouched', () => {
    const input = [{ branch: 'claim/1' }, { branch: 'feature/2' }, { branch: 'fix/3' }];
    expect(limitBranchesForAgent(input, 2)).toEqual(input.slice(0, 2));
    expect(input).toHaveLength(3);
  });

  it('preserves legacy all-at-once behavior for an absent or invalid limit', () => {
    const input = [{ branch: 'a' }, { branch: 'b' }];
    expect(limitBranchesForAgent(input)).toBe(input);
    expect(limitBranchesForAgent(input, 0)).toBe(input);
    expect(limitBranchesForAgent(input, 1.5)).toBe(input);
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

  it('does not request or gate an IN_REVIEW branch on Copilot', () => {
    const instruction = desiredEndState('IN_REVIEW', {});
    expect(instruction).toContain('CI is green and the PR is MERGEABLE');
    expect(instruction.toLowerCase()).not.toContain('copilot');
    expect(instruction).not.toContain('request/await');
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

  // GitHub computes mergeability asynchronously and answers UNKNOWN until it
  // lands, so this field flaps across consecutive reads of a completely static PR.
  // Counting that as progress is what let the drain re-dispatch ~40 coordinators in
  // one night against two unchanged branches, so `mergeable` is deliberately OUT of
  // the signature. Nothing is lost: CONFLICTING is what makes classifyBranch return
  // CONFLICTED, so every real mergeability transition still shows up in `state`.
  it('ignores openPr.mergeable — GitHub flaps UNKNOWN → MERGEABLE with no real change', () => {
    const unknown = [{ branch: 'a', state: 'IN_REVIEW', openPr: { number: 3, mergeable: 'UNKNOWN' } }];
    const mergeable = [{ branch: 'a', state: 'IN_REVIEW', openPr: { number: 3, mergeable: 'MERGEABLE' } }];
    expect(actionableSignature(unknown)).toBe(actionableSignature(mergeable));
  });

  it('still changes when mergeability turns into a real state change (IN_REVIEW → CONFLICTED)', () => {
    const review = [{ branch: 'a', state: 'IN_REVIEW', openPr: { number: 3, mergeable: 'MERGEABLE' } }];
    const conflicted = [{ branch: 'a', state: 'CONFLICTED', openPr: { number: 3, mergeable: 'CONFLICTING' } }];
    expect(actionableSignature(review)).not.toBe(actionableSignature(conflicted));
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

  it('flags a never-pushed NEEDS_PR branch so the agent knows the push needs -u', () => {
    const block = formatInFlightForPrompt([
      { branch: 'claim/issue-1', state: 'NEEDS_PR', hasUpstream: false },
      { branch: 'claim/issue-2', state: 'NEEDS_PR', hasUpstream: true }
    ], { defaultBranch: 'main', actions: {} });
    const [first, second] = block.split('### `claim/issue-2`');
    expect(first).toContain('Never pushed: no upstream on `origin`');
    expect(second).not.toContain('Never pushed');
  });

  it('states the configured batch limit when supplied', () => {
    const block = formatInFlightForPrompt(
      [{ branch: 'next/issue-1', state: 'NEEDS_PR' }],
      { defaultBranch: 'main', actions: {}, branchesPerAgent: 3 }
    );
    expect(block).toContain('limited to up to 3 branch(es)');
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

describe('orphaned remote branches', () => {
  // `git ls-remote --heads` output is tab-separated: <sha>\trefs/heads/<branch>.
  const lsRemote = (entries) =>
    entries.map(([branch, sha]) => `${sha}\trefs/heads/${branch}`).join('\n');

  /**
   * Route `execGit` by subcommand so a case can state what origin holds without
   * disturbing the rev-parse/rev-list calls the rest of the gather makes.
   */
  const mockRemote = (stdout, { exitCode = 0 } = {}) => {
    execGit.mockImplementation(async (args) =>
      args[0] === 'ls-remote' ? { stdout, exitCode } : { stdout: '', exitCode: 0 }
    );
  };

  describe('upstreamBranchName', () => {
    it('strips exactly the origin/ prefix, leaving slashes in the branch name', () => {
      expect(upstreamBranchName('origin/cos/task-x/agent-y')).toBe('cos/task-x/agent-y');
    });

    it('ignores a remote we cannot delete against', () => {
      // deleteBranch hardcodes `git push origin --delete`, so an upstream on any
      // other remote must not be treated as a claim WE could act on.
      expect(upstreamBranchName('upstream/main')).toBeNull();
      expect(upstreamBranchName('fork/feature')).toBeNull();
    });

    it('returns null for a branch with no upstream', () => {
      expect(upstreamBranchName('')).toBeNull();
      expect(upstreamBranchName(null)).toBeNull();
      expect(upstreamBranchName(undefined)).toBeNull();
      // `origin/` with nothing after it names no branch.
      expect(upstreamBranchName('origin/')).toBeNull();
    });
  });

  describe('parseRemoteHeads', () => {
    it('maps branch to SHA and ignores non-head refs', () => {
      const heads = parseRemoteHeads([
        'aaa1\trefs/heads/main',
        'bbb2\trefs/heads/feature/x',
        'ccc3\trefs/tags/v1.0.0',
        'ddd4\trefs/pull/42/head'
      ].join('\n'));
      expect([...heads.keys()].sort()).toEqual(['feature/x', 'main']);
      expect(heads.get('feature/x')).toBe('bbb2');
    });

    it('yields an empty map for empty output', () => {
      expect(parseRemoteHeads('').size).toBe(0);
    });
  });

  describe('partitionRemoteOrphans', () => {
    it('treats a same-named local branch as a claim even with no upstream', () => {
      // A local `foo` with no tracking still owns `origin/foo` — that is where a
      // plain `git push` sends it. Reaping it would delete a live branch.
      const orphans = partitionRemoteOrphans(
        new Map([['foo', 'aaa']]),
        [{ name: 'foo', tracking: '' }],
        { defaultBranch: 'main' }
      );
      expect(orphans).toEqual([]);
    });

    it('treats a differently-named tracked branch as a claim', () => {
      // The case the name check alone misses, and the reason gatherBranchState
      // carries `tracking` rather than only the hasUpstream boolean.
      const orphans = partitionRemoteOrphans(
        new Map([['remote-name', 'aaa']]),
        [{ name: 'local-name', tracking: 'origin/remote-name' }],
        { defaultBranch: 'main' }
      );
      expect(orphans).toEqual([]);
    });

    it('never reports a protected or default branch as an orphan', () => {
      const orphans = partitionRemoteOrphans(
        new Map([['main', 'aaa'], ['release', 'bbb'], ['gh-pages', 'ccc']]),
        [],
        { defaultBranch: 'main' }
      );
      expect(orphans).toEqual([]);
    });

    it('surfaces a remote branch nothing local points at, name-sorted', () => {
      const orphans = partitionRemoteOrphans(
        new Map([['zeta', 'zzz'], ['alpha', 'aaa'], ['kept', 'kkk']]),
        [{ name: 'kept', tracking: 'origin/kept' }],
        { defaultBranch: 'main' }
      );
      expect(orphans).toEqual([
        { branch: 'alpha', sha: 'aaa' },
        { branch: 'zeta', sha: 'zzz' }
      ]);
    });
  });

  describe('reapOrphanedRemotes', () => {
    it('reports a merged orphan instead of deleting it by default', async () => {
      // The destructive step is opt-in: `git push origin --delete` reaches a
      // shared forge and cannot be undone from here.
      mockRemote(lsRemote([['stale/merged', 'sha-merged']]));
      git.getBranches.mockResolvedValue([]);
      git.isBranchMergedInto.mockResolvedValue(true);

      const res = await reapOrphanedRemotes('/repo', 'main');
      expect(res.reaped).toEqual([]);
      expect(res.reported).toEqual([{ branch: 'stale/merged', reason: 'reap-disabled' }]);
      expect(git.deleteBranch).not.toHaveBeenCalled();
    });

    it('deletes a merged orphan on the remote when reaping is enabled', async () => {
      mockRemote(lsRemote([['stale/merged', 'sha-merged']]));
      git.getBranches.mockResolvedValue([]);
      git.isBranchMergedInto.mockResolvedValue(true);
      git.deleteBranch.mockResolvedValue({ branch: 'stale/merged', results: { remote: 'deleted' } });

      const res = await reapOrphanedRemotes('/repo', 'main', { reap: true });
      expect(res.reaped).toEqual(['stale/merged']);
      expect(res.reported).toEqual([]);
      // Remote-only: the local half must not be touched, there is nothing local.
      expect(git.deleteBranch).toHaveBeenCalledWith('/repo', 'stale/merged', { remote: true });
    });

    it('merge-checks the SHA ls-remote reported, not the branch name', async () => {
      // A stale `origin/<branch>` ref can say "merged" about commits origin has
      // since moved past; the live SHA is the only safe thing to judge.
      mockRemote(lsRemote([['stale/merged', 'sha-from-ls-remote']]));
      git.getBranches.mockResolvedValue([]);
      git.isBranchMergedInto.mockResolvedValue(true);

      await reapOrphanedRemotes('/repo', 'main', { reap: true });
      expect(git.isBranchMergedInto).toHaveBeenCalledWith('/repo', 'sha-from-ls-remote', 'main');
    });

    it('never deletes an unmerged remote-only branch — it may be a peer\'s live work', async () => {
      mockRemote(lsRemote([['peer/in-progress', 'sha-unmerged']]));
      git.getBranches.mockResolvedValue([]);
      git.isBranchMergedInto.mockResolvedValue(false);

      const res = await reapOrphanedRemotes('/repo', 'main', { reap: true });
      expect(res.reaped).toEqual([]);
      expect(res.reported).toEqual([{ branch: 'peer/in-progress', reason: 'unmerged-remote-only' }]);
      expect(git.deleteBranch).not.toHaveBeenCalled();
    });

    it('fails closed when the merge check itself errors', async () => {
      // An unfetched SHA cannot be resolved locally — "unknown" must read as
      // "leave it alone", never as "not merged, so safe to assume".
      mockRemote(lsRemote([['never/fetched', 'sha-missing']]));
      git.getBranches.mockResolvedValue([]);
      git.isBranchMergedInto.mockRejectedValue(new Error('bad object'));

      const res = await reapOrphanedRemotes('/repo', 'main', { reap: true });
      expect(res.reaped).toEqual([]);
      expect(res.reported).toEqual([{ branch: 'never/fetched', reason: 'unmerged-remote-only' }]);
      expect(git.deleteBranch).not.toHaveBeenCalled();
    });

    it('reports nothing when the remote cannot be read', async () => {
      // An unreadable remote must not read as "origin has no branches" — and an
      // unknowable claim set must not make every remote branch look orphaned.
      mockRemote('', { exitCode: 128 });
      git.getBranches.mockResolvedValue([]);

      const res = await reapOrphanedRemotes('/repo', 'main', { reap: true });
      expect(res).toEqual({ reaped: [], reported: [], remoteUnavailable: true });
      expect(git.deleteBranch).not.toHaveBeenCalled();
    });

    it('reports nothing when the local branch list cannot be read', async () => {
      mockRemote(lsRemote([['anything', 'sha']]));
      git.getBranches.mockRejectedValue(new Error('not a git repo'));

      const res = await reapOrphanedRemotes('/repo', 'main', { reap: true });
      expect(res.remoteUnavailable).toBe(true);
      expect(git.deleteBranch).not.toHaveBeenCalled();
    });

    it('surfaces a failed remote delete rather than claiming it was reaped', async () => {
      mockRemote(lsRemote([['stale/merged', 'sha-merged']]));
      git.getBranches.mockResolvedValue([]);
      git.isBranchMergedInto.mockResolvedValue(true);
      git.deleteBranch.mockResolvedValue({ results: { remote: 'failed: protected branch' } });

      const res = await reapOrphanedRemotes('/repo', 'main', { reap: true });
      expect(res.reaped).toEqual([]);
      expect(res.reported[0].branch).toBe('stale/merged');
      expect(res.reported[0].reason).toContain('remote-delete-failed');
    });
  });

  describe('reconcile wiring', () => {
    it('reports the merged orphan a local cleanup left behind, without deleting it', async () => {
      // The composition this sweep exists for: cleanupMerged deletes the merged
      // LOCAL branch and leaves `origin/<branch>` behind, which the sweep — running
      // after it — then notices.
      git.getBranches.mockResolvedValue([
        { name: 'next/issue-1', isDefault: false, current: false, tracking: 'origin/next/issue-1', merged: true }
      ]);
      wt.listWorktrees.mockResolvedValue([]);
      execGh.mockResolvedValue('[]');
      git.isBranchMergedInto.mockResolvedValue(true);
      mockRemote(lsRemote([['left/behind', 'sha-merged'], ['main', 'sha-main']]));

      const res = await reconcile('/repo');
      expect(res.cleaned).toEqual(['next/issue-1']);
      expect(res.orphanRemotes.reaped).toEqual([]);
      expect(res.orphanRemotes.reported).toEqual([{ branch: 'left/behind', reason: 'reap-disabled' }]);
      // Only the local half of the cleanup ran.
      expect(git.deleteBranch).toHaveBeenCalledWith('/repo', 'next/issue-1', { local: true });
      expect(git.deleteBranch).not.toHaveBeenCalledWith('/repo', 'left/behind', { remote: true });
    });

    // getOriginInfo returns a fully-populated object with `hasOrigin: false` for an
    // origin-less repo — it does NOT return null — so a truthiness gate would run
    // the sweep anyway and log an ls-remote failure on every single cycle.
    it('skips the sweep on a repo whose origin-info says there is no origin', async () => {
      getOriginInfo.mockResolvedValue({
        hasOrigin: false, originUrl: null, host: null, owner: null, repo: null,
        fullName: null, isUpstream: false, isGithub: false, isFork: false
      });
      git.getBranches.mockResolvedValue([]);
      wt.listWorktrees.mockResolvedValue([]);
      mockRemote(lsRemote([['would/be/orphan', 'sha']]));

      const res = await reconcile('/repo');
      expect(res.orphanRemotes).toEqual({ reaped: [], reported: [] });
      expect(execGit).not.toHaveBeenCalledWith(
        expect.arrayContaining(['ls-remote']), expect.anything(), expect.anything()
      );
    });

    it('skips the sweep when origin-info could not be read at all', async () => {
      getOriginInfo.mockRejectedValue(new Error('not a git repo'));
      git.getBranches.mockResolvedValue([]);
      wt.listWorktrees.mockResolvedValue([]);

      const res = await reconcile('/repo');
      expect(res.orphanRemotes).toEqual({ reaped: [], reported: [] });
    });
  });
});

describe('worktreeProtectionExpiresAt', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const CLAIM = '/repo/data/cos/worktrees/claim-issue-42';
  const at = (over = {}) => worktreeProtectionExpiresAt({ path: CLAIM, ageMs: 2 * DAY, ...over });

  it('dates a claim hold to the end of its grace window', () => {
    const before = Date.now();
    const ms = Date.parse(at());
    // 7-day default window, 2 days elapsed ⇒ ~5 days out.
    expect(ms).toBeGreaterThanOrEqual(before + 5 * DAY);
    expect(ms).toBeLessThanOrEqual(Date.now() + 5 * DAY);
  });

  it('returns null for holds nothing can schedule', () => {
    // A locked or agent-owned tree lifts when a human or a process decides to,
    // not on a clock — promising a time would be a guess.
    expect(at({ locked: true })).toBeNull();
    expect(worktreeProtectionExpiresAt({
      path: '/repo/data/cos/worktrees/agent-abc12345', ageMs: 2 * DAY, activeAgentIds: new Set(['agent-abc12345'])
    })).toBeNull();
    expect(worktreeProtectionExpiresAt({ path: null, ageMs: 2 * DAY })).toBeNull();
  });

  it('returns null when the age is unknown rather than guessing one', () => {
    // An unmeasured age must not date the window from zero — that would park a
    // full window out on a tree that may already be reapable.
    for (const ageMs of [null, undefined, NaN, 'old']) expect(at({ ageMs })).toBeNull();
  });

  it('returns null once the window has already lapsed', () => {
    expect(at({ ageMs: 9 * DAY })).toBeNull();
  });

  it('gives no expiry to a claim worktree that is ALSO locked', () => {
    // The lock outlives the grace window, and the gate reports it as such: it
    // tests the lock BEFORE the claim, so a locked claim tree reads
    // 'worktree-locked' and there is no window here to date.
    expect(worktreeProtectionExpiresAt({ path: CLAIM, ageMs: 2 * DAY, locked: true })).toBeNull();
  });

  it('gives no expiry to a non-claim worktree that is not held at all', () => {
    expect(worktreeProtectionExpiresAt({ path: '/repo/data/cos/worktrees/agent-abc12345', ageMs: 2 * DAY, activeAgentIds: new Set() })).toBeNull();
  });
});

describe('describeIdleReconcilePark', () => {
  const CLAIM_HOLD = { branch: 'claim/issue-4348', reason: 'worktree-human-claim', retryAt: '2026-01-15T00:00:00.000Z' };

  it('reports a quiet repo when nothing is held', () => {
    expect(describeIdleReconcilePark([], [])).toEqual({
      reason: 'no-in-flight-branches', heldBackMerged: [], counts: null, notLaterThan: null
    });
    expect(describeIdleReconcilePark()).toMatchObject({ reason: 'no-in-flight-branches' });
  });

  it('names merged branches held back, with the count and the earliest lift', () => {
    // The regression this exists for: four merged claim branches queued behind a
    // grace window used to persist as 'no-in-flight-branches' / zero counts, so
    // the task read as idle — indistinguishable from not running at all.
    const out = describeIdleReconcilePark([
      CLAIM_HOLD,
      { branch: 'claim/issue-4442', reason: 'worktree-human-claim', retryAt: '2026-01-13T00:00:00.000Z' }
    ], []);
    expect(out.reason).toBe('merged-branches-held-back');
    expect(out.counts).toEqual({ heldBackMerged: 2 });
    expect(out.notLaterThan).toBe('2026-01-13T00:00:00.000Z');
    expect(out.heldBackMerged).toHaveLength(2);
  });

  it('live owners outrank a held-back merge — a running session is why it is idle', () => {
    const out = describeIdleReconcilePark([CLAIM_HOLD], [{ branch: 'cos/x', liveOwnerReason: 'worktree-active-agent' }]);
    expect(out.reason).toBe('branches-held-by-live-owners');
    // The held-back set still travels, so the log/UI can name both.
    expect(out.counts).toEqual({ heldBackMerged: 1 });
  });

  it('ignores skips that are not holds', () => {
    // 'cleanup-disabled' (a toggle) and 'not-merged-on-recheck' (never eligible)
    // are not pending work — counting them would invent a queue that does not exist.
    const out = describeIdleReconcilePark([
      { branch: 'a', reason: 'cleanup-disabled' },
      { branch: 'b', reason: 'not-merged-on-recheck' },
      { branch: 'c', reason: 'delete-failed: boom' }
    ], []);
    expect(out).toEqual({ reason: 'no-in-flight-branches', heldBackMerged: [], counts: null, notLaterThan: null });
  });

  it('ignores an unreadable retryAt rather than parking on NaN', () => {
    const out = describeIdleReconcilePark([
      { branch: 'a', reason: 'worktree-human-claim', retryAt: 'not-a-date' },
      { branch: 'b', reason: 'worktree-human-claim', retryAt: '2026-01-14T00:00:00.000Z' }
    ], []);
    expect(out.notLaterThan).toBe('2026-01-14T00:00:00.000Z');
  });

  it('holds with no scheduled lift park on the normal cadence', () => {
    const out = describeIdleReconcilePark([{ branch: 'a', reason: 'worktree-locked' }], []);
    expect(out.reason).toBe('merged-branches-held-back');
    expect(out.notLaterThan).toBeNull();
  });
});
