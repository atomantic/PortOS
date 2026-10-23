import { describe, it, expect, vi } from 'vitest';
vi.mock('../lib/execGit.js', () => ({ execGit: vi.fn(async () => ({ stdout: 'worktree /repo\nbranch refs/heads/main\n\n', exitCode: 0 })) }));
vi.mock('../lib/fileCore.js', () => ({ pathExists: vi.fn(async () => false) }));
import { findGoneInventoryRows } from './branchReconcileInventoryPrune.js';
import { execGit } from '../lib/execGit.js';
import { pathExists } from '../lib/fileCore.js';

describe('historical checkout inventory', () => {
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
