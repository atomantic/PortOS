import { describe, expect, it, vi } from 'vitest';
import { releaseCandidateTrees, retireMergedReleaseCandidates } from './branchReconcileReleaseCandidates.js';

const app = { id: 'example', repoPath: '/example/repo' };
const head = 'a'.repeat(40);
const branch = 'codex/release-example';
const tree = { branch, path: '/example/release', head, managed: true, locked: true, lockReason: `Active release candidate ${branch}` };
const scan = (t = {}) => ({ worktreeInventory: [{ ...tree, ...t }] });
const review = (over = {}) => ({ ok: true, review: { digest: 'd'.repeat(64), forge: { prHead: head },
  comparison: { disposition: 'integrated', localPatch: '+x', difference: '' }, ...over } });
const deps = (extra = {}) => ({ readPr: vi.fn(async () => 'https://github.com/example/repo/pull/1'), prepare: vi.fn(async () => review()),
  retire: vi.fn(async () => ({ ok: true, branchDeleted: true })), beforeMutation: vi.fn(), ...extra });

describe('merged release candidate lock release', () => {
  it('retires a locked candidate whose release PR merged at the exact head, passing the lock through the fenced service', async () => {
    const d = deps();
    const out = await retireMergedReleaseCandidates(app, scan(), d);
    expect(out).toMatchObject({ held: [], retired: [expect.objectContaining({ branch, head, locked: true })] });
    expect(d.retire).toHaveBeenCalledWith({ appId: app.id, release: expect.objectContaining({ locked: true, lockReason: tree.lockReason }),
      review: { prUrl: 'https://github.com/example/repo/pull/1', digest: 'd'.repeat(64), acceptSuperseded: false } },
    { beforeMutation: d.beforeMutation });
  });

  it('keeps the lock when the PR is not merged, the head differs, or the review is not exact integration', async () => {
    const open = deps({ readPr: vi.fn(async () => { throw new Error('retirement-pr-ambiguous'); }) });
    const moved = deps({ prepare: vi.fn(async () => review({ forge: { prHead: 'b'.repeat(40) } })) });
    const diff = deps({ prepare: vi.fn(async () => review({ comparison: { disposition: 'integrated', difference: '+new' } })) });
    const refused = deps({ prepare: vi.fn(async () => ({ ok: false, reason: 'x' })) });
    for (const d of [open, moved, diff, refused]) {
      expect(await retireMergedReleaseCandidates(app, scan(), d)).toEqual({ retired: [], held: [] });
      expect(d.retire).not.toHaveBeenCalled();
    }
  });

  it('only considers a lock naming its own branch', () => {
    expect(releaseCandidateTrees(scan({ lockReason: 'Active release candidate other' }))).toEqual([]);
    expect(releaseCandidateTrees(scan({ lockReason: 'explicit owner handoff required' }))).toEqual([]);
    expect(releaseCandidateTrees(scan({ locked: false }))).toEqual([]);
  });

  it('reports a service refusal as held', async () => {
    const d = deps({ retire: vi.fn(async () => ({ ok: false, reason: 'worktree-dirty' })) });
    expect(await retireMergedReleaseCandidates(app, scan(), d)).toMatchObject({ retired: [], held: [{ branch, reason: 'worktree-dirty' }] });
  });
});
