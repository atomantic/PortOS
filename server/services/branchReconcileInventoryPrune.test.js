import { describe, it, expect, vi } from 'vitest';
vi.mock('./repoCleanupObservation.js', () => ({
  readCheckoutPathPresence: vi.fn(async () => false),
  readLocalBranchPresence: vi.fn(async () => false),
}));
import { findGoneInventoryRows } from './branchReconcileInventoryPrune.js';
import { readCheckoutPathPresence } from './repoCleanupObservation.js';

describe('historical checkout inventory', () => {
  it('keeps remote-only holds when their local branch is absent, while pruning missing local branches', async () => {
    const remote = { branch: 'fix/remote-only', reason: 'remote-branch-held' };
    const local = { branch: 'fix/gone', reason: 'actionable' };
    execGit.mockImplementation(async (args) => args[0] === 'worktree'
      ? { stdout: 'worktree /repo\nbranch refs/heads/main\n\n', exitCode: 0 }
      : { stdout: '', exitCode: 1 });
    expect(await findGoneInventoryRows('/repo', [remote, local], { includeObligations: true })).toEqual([local]);
  });

  it('reports missing obligation originals only for display, preserving the default pruning contract', async () => {
    const obligation = { path: '/old', branch: 'fix/example', reason: 'retirement-receipt-unverified' };
    const rows = [obligation];
    expect(await findGoneInventoryRows('/repo', rows)).toEqual([]);
    expect(await findGoneInventoryRows('/repo', rows, { includeObligations: true })).toEqual([obligation]);
    readCheckoutPathPresence.mockResolvedValueOnce(true);
    expect(await findGoneInventoryRows('/repo', rows, { includeObligations: true })).toEqual([]);
    readCheckoutPathPresence.mockResolvedValueOnce(null);
    await expect(findGoneInventoryRows('/repo', rows, { includeObligations: true })).rejects.toThrow('checkout-presence-unavailable');
  });
});
