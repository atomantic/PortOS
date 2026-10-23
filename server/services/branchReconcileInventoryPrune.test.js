import { describe, it, expect, vi } from 'vitest';
vi.mock('../lib/execGit.js', () => ({ execGit: vi.fn(async () => ({ stdout: 'worktree /repo\nbranch refs/heads/main\n\n', exitCode: 0 })) }));
vi.mock('../lib/fileCore.js', () => ({ pathExists: vi.fn(async () => false) }));
import { findGoneInventoryRows } from './branchReconcileInventoryPrune.js';
import { execGit } from '../lib/execGit.js';
import { pathExists } from '../lib/fileCore.js';

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
    const primary = { path: '/repo', branch: 'main' };
    const obligation = { path: '/old', branch: 'fix/example', reason: 'retirement-receipt-unverified' };
    const rows = [primary, obligation];
    expect(await findGoneInventoryRows('/repo', rows)).toEqual([]);
    expect(await findGoneInventoryRows('/repo', rows, { includeObligations: true })).toEqual([obligation]);
    pathExists.mockResolvedValueOnce(true);
    expect(await findGoneInventoryRows('/repo', rows, { includeObligations: true })).toEqual([]);
    execGit.mockRejectedValueOnce(new Error('git unavailable'));
    await expect(findGoneInventoryRows('/repo', rows, { includeObligations: true })).rejects.toThrow('git unavailable');
  });
});
