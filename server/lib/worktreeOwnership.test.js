import { describe, expect, it } from 'vitest';
import { isAgentWorktreeId, isHumanClaimWorktree, worktreeAgentId, worktreeHoldExpiresAt, worktreeOwnershipReason } from './worktreeOwnership.js';

describe('worktree ownership', () => {
  const COS_ROOT = '/repo/data/cos/worktrees';

  it('permits only an inactive, unlocked CoS agent tree under the configured root', () => {
    const options = {
      roots: [{ path: COS_ROOT, requireAgentId: true }],
      activeAgentIds: new Set(),
      requireKnownLiveness: true,
    };
    expect(worktreeOwnershipReason({ ...options, path: `${COS_ROOT}/agent-dead` })).toBeNull();
    expect(worktreeOwnershipReason({ ...options, path: '/repo/elsewhere/agent-dead' })).toBe('worktree-unmanaged-location');
    expect(worktreeOwnershipReason({ ...options, path: `${COS_ROOT}/next-issue-42` })).toBe('worktree-missing-agent-id');
    expect(worktreeOwnershipReason({ ...options, path: `${COS_ROOT}/agent-live`, activeAgentIds: new Set(['agent-live']) }))
      .toBe('worktree-active-agent');
    expect(worktreeOwnershipReason({ ...options, path: `${COS_ROOT}/agent-locked`, locked: true })).toBe('worktree-locked');
  });

  it('keeps human claims unless the caller explicitly permits reclamation', () => {
    const input = { path: `${COS_ROOT}/claim-issue-42`, ageMs: 8_000, staleClaimIdleMs: 7_000 };
    expect(worktreeOwnershipReason(input)).toBe('worktree-human-claim');
    // A reaper may take an ABANDONED claim once its window lapses…
    expect(worktreeOwnershipReason({ ...input, allowStaleClaim: true })).toBeNull();
    // …and the dispatch side never treats the directory as an owner at all,
    // regardless of age (it reads the tree as a claim MARKER, not a process).
    expect(worktreeOwnershipReason({ ...input, ageMs: 1, allowLiveClaim: true })).toBeNull();
  });

  it('tests the claim LAST, so every unconditional hold outranks it', () => {
    // The ordering IS the precedence: a claim tree that is also locked / also
    // running an agent reports that hold, not 'worktree-human-claim'. Callers
    // therefore never have to re-derive "a lock beats a claim" from the slug.
    const claim = `${COS_ROOT}/claim-issue-42`;
    expect(worktreeOwnershipReason({ path: claim, locked: true })).toBe('worktree-locked');
    expect(worktreeOwnershipReason({ path: claim, activeAgentIds: new Set(['claim-issue-42']) }))
      .toBe('worktree-active-agent');
    // …and the exceptions cannot reach past them either.
    expect(worktreeOwnershipReason({
      path: claim, locked: true, allowLiveClaim: true, allowStaleClaim: true, ageMs: 8_000, staleClaimIdleMs: 7_000
    })).toBe('worktree-locked');
    // A root that demands an agent id refuses the claim basename on that ground.
    expect(worktreeOwnershipReason({ path: claim, roots: [{ path: COS_ROOT, requireAgentId: true }] }))
      .toBe('worktree-missing-agent-id');
    // …unless the caller opted into live-claim adoption, which lets a claim
    // basename through the agent-id root gate so the claim test below it (not
    // this one) decides the verdict.
    expect(worktreeOwnershipReason({
      path: claim, roots: [{ path: COS_ROOT, requireAgentId: true }], allowLiveClaim: true
    })).toBeNull();
    // A non-claim, non-agent basename still can't ride that carve-out through.
    expect(worktreeOwnershipReason({
      path: `${COS_ROOT}/next-issue-42`, roots: [{ path: COS_ROOT, requireAgentId: true }], allowLiveClaim: true
    })).toBe('worktree-missing-agent-id');
  });

  it('fails closed when agent liveness is unknown and permits an explicitly non-agent root', () => {
    expect(worktreeOwnershipReason({
      path: `${COS_ROOT}/agent-unknown`,
      requireAgentId: true,
      requireKnownLiveness: true,
    })).toBe('worktree-agent-liveness-unknown');
    expect(worktreeOwnershipReason({
      path: '/repo/.claude/worktrees/review-fix',
      roots: [{ path: '/repo/.claude/worktrees', requireAgentId: false }],
      activeAgentIds: new Set(),
      requireKnownLiveness: true,
    })).toBeNull();
  });

  it('uses one separator-safe namespace definition', () => {
    expect(worktreeAgentId('H:/repo/data/cos/worktrees/agent-abc')).toBe('agent-abc');
    expect(worktreeAgentId('H:\\repo\\data\\cos\\worktrees\\claim-issue-42')).toBe('claim-issue-42');
    expect(isAgentWorktreeId('agent-abc')).toBe(true);
    expect(isAgentWorktreeId('next-issue-42')).toBe(false);
    expect(isHumanClaimWorktree('claim-issue-42')).toBe(true);
  });
});

describe('worktreeHoldExpiresAt', () => {
  const COS_ROOT = '/repo/data/cos/worktrees';
  const NOW = Date.parse('2026-01-10T00:00:00.000Z');
  const claim = (over = {}) => worktreeHoldExpiresAt({
    path: `${COS_ROOT}/claim-issue-42`, allowStaleClaim: true, ageMs: 2_000, staleClaimIdleMs: 7_000, nowMs: NOW, ...over
  });

  it('dates a stale-claim hold to the moment its window lapses', () => {
    expect(claim()).toBe(new Date(NOW + 5_000).toISOString());
  });

  it('gives no expiry to a claim tree that is ALSO locked', () => {
    // The lock outlives the window, and the gate now says so structurally: a
    // locked claim tree reports 'worktree-locked', never the claim slug, so
    // there is no window here to date.
    expect(claim({ locked: true })).toBeNull();
  });

  it('gives no expiry to a claim tree whose agent is still live', () => {
    expect(worktreeHoldExpiresAt({
      path: `${COS_ROOT}/claim-issue-42`, allowStaleClaim: true, ageMs: 2_000, staleClaimIdleMs: 7_000,
      activeAgentIds: new Set(['claim-issue-42']), nowMs: NOW
    })).toBeNull();
  });

  it('gives no expiry when the caller has not opted into stale-claim reclamation', () => {
    // Without allowStaleClaim the window never lapses for this caller, so there
    // is no deadline to report.
    expect(claim({ allowStaleClaim: false })).toBeNull();
  });

  it('gives no expiry once the window has already lapsed, or when age is unknown', () => {
    expect(claim({ ageMs: 9_000 })).toBeNull();
    expect(claim({ ageMs: 7_000 })).toBeNull();
    for (const ageMs of [null, undefined, NaN, 'old']) expect(claim({ ageMs })).toBeNull();
    expect(claim({ staleClaimIdleMs: undefined })).toBeNull();
  });

  it('gives no expiry to holds that are not the stale-claim window', () => {
    expect(worktreeHoldExpiresAt({ path: `${COS_ROOT}/agent-live`, activeAgentIds: new Set(['agent-live']), ageMs: 2_000, staleClaimIdleMs: 7_000 })).toBeNull();
    expect(worktreeHoldExpiresAt({ path: null })).toBeNull();
    // A tree nothing holds at all has no expiry either — there is no wait.
    expect(worktreeHoldExpiresAt({ path: `${COS_ROOT}/agent-dead`, activeAgentIds: new Set(), ageMs: 2_000, staleClaimIdleMs: 7_000 })).toBeNull();
  });
});
