import { describe, expect, it } from 'vitest';
import { isAgentWorktreeId, isHumanClaimWorktree, worktreeAgentId, worktreeOwnershipReason } from './worktreeOwnership.js';

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

  it('keeps human claims unless the stale-claim caller explicitly permits reclamation', () => {
    const input = { path: `${COS_ROOT}/claim-issue-42`, ageMs: 8_000, staleClaimIdleMs: 7_000 };
    expect(worktreeOwnershipReason(input)).toBe('worktree-human-claim');
    expect(worktreeOwnershipReason({ ...input, allowStaleClaim: true })).toBeNull();
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
