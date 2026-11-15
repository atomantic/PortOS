import { describe, expect, it, vi } from 'vitest';
import { releaseCandidateTrees, retireMergedReleaseCandidates } from './branchReconcileReleaseCandidates.js';

const app = { id: 'example', repoPath: '/example/repo' };
const head = 'a'.repeat(40);
const branch = 'codex/release-example';
const tree = { branch, path: '/example/release', head, managed: true, locked: true, lockReason: `Active release candidate ${branch}` };
const scan = (t = {}) => ({ worktreeInventory: [{ ...tree, ...t }] });
const deps = (extra = {}) => ({ readForgeDelivery: vi.fn(async () => 'exact'), unlockAbandoned: vi.fn(async () => false),
  retire: vi.fn(async () => ({ ok: true, branchDeleted: true })), beforeMutation: vi.fn(), ...extra });

describe('merged release candidate lock release', () => {
  it.each(['exact', 'contained'])('retires a locked candidate whose release PR delivered its head (%s), passing the lock through the fenced service', async delivery => {
    const d = deps({ readForgeDelivery: vi.fn(async () => delivery) });
    const out = await retireMergedReleaseCandidates(app, scan(), d);
    expect(out).toMatchObject({ held: [], retired: [expect.objectContaining({ branch, head, locked: true })] });
    expect(d.readForgeDelivery).toHaveBeenCalledWith(app.repoPath, branch, head);
    expect(d.retire).toHaveBeenCalledWith({ appId: app.id, release: expect.objectContaining({ locked: true, lockReason: tree.lockReason }) },
      { beforeMutation: d.beforeMutation, delivery });
  });

  it.each(['none', null])('keeps the lock when the release PR has not delivered the head: %s', async delivery => {
    const d = deps({ readForgeDelivery: vi.fn(async () => delivery) });
    expect(await retireMergedReleaseCandidates(app, scan(), d)).toEqual({ retired: [], held: [] });
    expect(d.retire).not.toHaveBeenCalled();
    expect(d.unlockAbandoned).toHaveBeenCalledOnce();
  });

  it('returns an abandoned candidate to normal reconciliation without deleting its contents', async () => {
    const d = deps({ readForgeDelivery: vi.fn(async () => 'none'), unlockAbandoned: vi.fn(async () => true) });
    expect(await retireMergedReleaseCandidates(app, scan(), d)).toMatchObject({
      retired: [], held: [{ branch, locked: false, reason: 'candidate-unlocked-for-reconciliation' }],
    });
    expect(d.retire).not.toHaveBeenCalled();
  });

  it('only considers a lock naming its own branch', () => {
    expect(releaseCandidateTrees(scan({ lockReason: 'Active release candidate other' }))).toEqual([]);
    expect(releaseCandidateTrees(scan({ lockReason: 'explicit owner handoff required' }))).toEqual([]);
    expect(releaseCandidateTrees(scan({ locked: false }))).toEqual([]);
  });

  it('reports a service refusal or failure as held, never a raw error', async () => {
    const refused = deps({ retire: vi.fn(async () => ({ ok: false, reason: 'worktree-dirty' })) });
    expect(await retireMergedReleaseCandidates(app, scan(), refused)).toMatchObject({ retired: [], held: [{ branch, reason: 'worktree-dirty' }] });
    const failed = deps({ retire: vi.fn(async () => { throw new Error('private diagnostic'); }) });
    expect((await retireMergedReleaseCandidates(app, scan(), failed)).held[0].reason).toBe('retirement-outcome-uncertain');
  });
});
