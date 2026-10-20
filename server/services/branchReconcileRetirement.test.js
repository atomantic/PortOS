import { describe, expect, it, vi } from 'vitest';
import { prepareReconcileRetirements, retirementReviewInstructions } from './branchReconcileRetirement.js';

const forge = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('./github.js', () => ({ execGh: forge.read }));
vi.mock('../lib/gitRemote.js', () => ({ getOriginInfo: async () => ({ hasOrigin: true, isGithub: true, host: 'github.com', fullName: 'example/repo' }) }));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: async () => ({ cwd: '/example/repo', env: { GH_TOKEN: 'synthetic' } }) }));

const app = { id: 'example', repoPath: '/example/repo' };
const head = 'a'.repeat(40);
const branch = { branch: 'claim/issue-42', tip: head, worktreePath: '/example/checkout', isMerged: true,
  completionPolicyReason: 'pr-completion-review-required' };
const tree = { branch: branch.branch, path: branch.worktreePath, head, managed: true, locked: false, lockReason: null };
const scan = (b = {}, t = {}) => ({ wip: [{ ...branch, ...b }], worktreeInventory: [{ ...tree, ...t }] });
const setup = () => ({
  readPr: vi.fn(async () => 'https://github.com/example/repo/pull/42'),
  prepare: vi.fn(async () => ({ ok: true, review: { digest: 'd'.repeat(64), policy: { policies: [{ id: 'old-owner', status: 'completed', success: true }] } } })),
});

describe('historical completed-checkout review obligations', () => {
  it('dispatches a scoped obligation only after the live preview accepts the exact release', async () => {
    const deps = setup();
    const result = await prepareReconcileRetirements(app, scan(), deps);
    expect(deps.prepare).toHaveBeenCalledWith({ appId: app.id, release: { branch: tree.branch, path: tree.path, head, locked: false, lockReason: null }, prUrl: 'https://github.com/example/repo/pull/42' });
    expect(result.candidates).toHaveLength(1);
    const prompt = retirementReviewInstructions(result.candidates[0], app.id);
    expect(prompt).toContain('FULL returned review.comparison.localPatch and difference');
    expect(prompt).toContain('checkouts/review');
    expect(prompt).toContain('checkouts/retire');
    expect(prompt).toContain('An uncertain response requires reading the outcome/checkout first');
    expect(prompt).toContain('Do not claim/bind');
    expect(prompt).not.toContain('git worktree remove');
  });

  it('reviews nonancestral squash/supersession work only through fresh merged-PR proof', async () => {
    const deps = setup();
    const result = await prepareReconcileRetirements(app, scan({ isMerged: false }), deps);
    expect(result.candidates).toHaveLength(1);
    expect(deps.prepare).toHaveBeenCalledOnce();
    deps.prepare.mockResolvedValue({ ok: false, reason: 'retirement-pr-not-matching-merged' });
    expect(await prepareReconcileRetirements(app, scan({ isMerged: false }), deps)).toMatchObject({
      candidates: [], held: [{ reason: 'retirement-pr-not-matching-merged' }],
    });
  });

  it.each([
    [{ liveOwnerReason: 'claim-owner-active' }, {}],
    [{ completionPolicyReason: 'pr-completion-human-handoff' }, {}],
    [{ openPr: { isDraft: true } }, {}],
    [{ worktreeDirty: true }, {}],
    [{ worktreeStatusUnavailable: true }, {}],
    [{}, { locked: true }], [{}, { managed: false }], [{}, { head: 'b'.repeat(40) }],
  ])('never dispatches an unsafe or intentionally held candidate: %j %j', async (b, t) => {
    const deps = setup();
    expect((await prepareReconcileRetirements(app, scan(b, t), deps)).candidates).toEqual([]);
    expect(deps.prepare).not.toHaveBeenCalled();
  });

  it.each(['claim-owner-active', 'retirement-local-objects-missing', 'retirement-submodule-not-uninitialized', 'retirement-policy-not-legacy-completed'])('keeps a fresh preview refusal visible: %s', async reason => {
    const deps = setup(); deps.prepare.mockResolvedValue({ ok: false, reason });
    expect(await prepareReconcileRetirements(app, scan(), deps)).toMatchObject({ candidates: [], held: [{ branch: branch.branch, reason }] });
  });

  it('does not invent approval after forge failure or vanished historical policy', async () => {
    const deps = setup(); deps.readPr.mockRejectedValueOnce(new Error('unreadable'));
    expect((await prepareReconcileRetirements(app, scan(), deps)).held[0].reason).toBe('retirement-review-unavailable');
    deps.prepare.mockResolvedValue({ ok: true, review: { policy: { policies: [] } } });
    expect((await prepareReconcileRetirements(app, scan(), deps)).held[0].reason).toBe('retirement-policy-changed');
  });

  it('selects the unique exact head on a reused branch, then requires its fresh preview', async () => {
    const deps = setup();
    const row = { html_url: 'https://github.com/example/repo/pull/42', head: { ref: branch.branch, sha: head, repo: { full_name: 'example/repo' } },
      base: { repo: { full_name: 'example/repo' } }, state: 'closed', merged_at: '2026-01-01T00:00:00Z' };
    forge.read.mockResolvedValue(JSON.stringify([{ ...row, html_url: 'https://github.com/example/repo/pull/41', head: { ...row.head, sha: 'b'.repeat(40) } }, row]));
    const result = await prepareReconcileRetirements(app, scan(), { prepare: deps.prepare });
    expect(result.candidates).toHaveLength(1);
    expect(deps.prepare).toHaveBeenCalledWith(expect.objectContaining({ prUrl: row.html_url, release: expect.objectContaining({ head }) }));
    expect(forge.read).toHaveBeenLastCalledWith(['api', '--hostname', 'github.com', `repos/example/repo/commits/${head}/pulls?per_page=100`], undefined,
      { cwd: '/example/repo', env: { GH_TOKEN: 'synthetic' } });
    deps.prepare.mockResolvedValue({ ok: false, reason: 'retirement-pr-not-matching-merged' });
    expect(await prepareReconcileRetirements(app, scan(), { prepare: deps.prepare })).toMatchObject({
      candidates: [], held: [{ reason: 'retirement-pr-not-matching-merged' }],
    });
  });

  it.each(['duplicate-head', 'no-matching-head', 'capped', 'foreign-repository', 'foreign-branch', 'fork', 'duplicate-url', 'unreadable'])(
    'retains reused-branch ambiguity instead of dispatching: %s', async change => {
      const row = { html_url: 'https://github.com/example/repo/pull/42', head: { ref: branch.branch, sha: head, repo: { full_name: 'example/repo' } },
      base: { repo: { full_name: 'example/repo' } }, state: 'closed', merged_at: '2026-01-01T00:00:00Z' };
      let rows = [row, { ...row, html_url: 'https://github.com/example/repo/pull/41', head: { ...row.head, sha: 'b'.repeat(40) } }];
      if (change === 'duplicate-head') rows[1].head.sha = head;
      if (change === 'no-matching-head') rows[0].head.sha = 'c'.repeat(40);
      if (change === 'capped') rows = Array.from({ length: 100 }, (_, index) => ({ ...row, html_url: `https://github.com/example/repo/pull/${index + 1}` }));
      if (change === 'foreign-repository') rows[0].html_url = 'https://github.com/other/repo/pull/42';
      if (change === 'foreign-branch') rows[0].head.ref = 'another/branch';
      if (change === 'fork') rows[0].head.repo.full_name = 'fork/repo';
      if (change === 'duplicate-url') rows[1].html_url = row.html_url;
      if (change === 'unreadable') rows = null;
      forge.read.mockResolvedValue(JSON.stringify(rows));
      const deps = setup();
      expect(await prepareReconcileRetirements(app, scan(), { prepare: deps.prepare })).toMatchObject({
        candidates: [], held: [{ reason: 'retirement-pr-ambiguous' }],
      });
      expect(deps.prepare).not.toHaveBeenCalled();
    });
});
