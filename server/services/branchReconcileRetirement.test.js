import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareReconcileRetirements, retirementReviewInstructions, retirementCognitiveIdentity } from './branchReconcileRetirement.js';

const forge = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('./github.js', () => ({ execGh: forge.read }));
vi.mock('../lib/gitRemote.js', () => ({ getOriginInfo: async () => ({ hasOrigin: true, isGithub: true, host: 'github.com', fullName: 'example/repo' }) }));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: async () => ({ cwd: '/example/repo', env: { GH_TOKEN: 'synthetic' } }) }));

const app = { id: 'example', repoPath: '/example/repo' };
const head = 'a'.repeat(40);
const branch = { branch: 'claim/issue-42', tip: head, worktreePath: '/example/checkout', isMerged: false,
  rule: 'completion-policy', completionPolicyReason: 'pr-completion-review-required' };
const tree = { branch: branch.branch, path: branch.worktreePath, head, managed: true, locked: false, lockReason: null };
const scan = (b = {}, t = {}) => ({ wip: [{ ...branch, ...b }], worktreeInventory: [{ ...tree, ...t }] });
const setup = () => ({
  readPr: vi.fn(async () => 'https://github.com/example/repo/pull/42'),
  prepare: vi.fn(async () => ({ ok: true, review: { digest: 'd'.repeat(64), policy: { policies: [{ id: 'old-owner', status: 'completed', success: true }] }, comparison: { disposition: 'review-supersession', localPatch: '+old', difference: '+new' }, forge: { prHead: head } } })),
});

describe('historical completed-checkout review obligations', () => {
  beforeEach(() => forge.read.mockReset());
  it('archives and retires a checkout whose commits are all on the default branch without a PR read or dispatch', async () => {
    const deps = setup();
    deps.retire = vi.fn(async () => ({ ok: true, branchDeleted: true, archiveDir: '/private/verified-archive' }));
    const observation = { observedAt: '2026-10-23T00:00:00Z', checkoutIdentity: 'original-checkout' };
    const result = await prepareReconcileRetirements(app, scan({ isMerged: true }, observation), deps);
    expect(result).toMatchObject({ candidates: [], held: [], retired: [expect.objectContaining({ branch: branch.branch, head })] });
    expect(deps.readPr).not.toHaveBeenCalled();
    expect(deps.retire).toHaveBeenCalledWith({ appId: app.id, release: { ...observation, branch: tree.branch, path: tree.path, head, locked: false, lockReason: null } },
      { beforeMutation: expect.any(Function), settleMergedReviewObligation: true });
  });

  it('keeps a merged checkout the fenced service refuses, with its reason', async () => {
    const deps = setup();
    deps.retire = vi.fn(async () => ({ ok: false, reason: 'pr-completion-human-handoff' }));
    expect(await prepareReconcileRetirements(app, scan({ isMerged: true }), deps)).toMatchObject({
      retired: [], held: [{ branch: branch.branch, reason: 'pr-completion-human-handoff' }],
    });
    deps.retire = vi.fn(async () => { throw new Error('daemon-stopped'); });
    expect((await prepareReconcileRetirements(app, scan({ isMerged: true }), deps)).held[0].reason).toBe('daemon-stopped');
  });

  it('retires integrated exact-head work without cognitive dispatch through the fenced service', async () => {
    const deps = setup();
    const prepared = await deps.prepare();
    prepared.review.comparison = { disposition: 'integrated', localPatch: '', difference: '' };
    deps.prepare.mockResolvedValue(prepared);
    deps.retire = vi.fn(async () => ({ ok: true, branchDeleted: true, archiveDir: '/private/verified-archive' }));
    const result = await prepareReconcileRetirements(app, scan(), deps);
    expect(result.candidates).toEqual([]);
    expect(result.retired).toEqual([expect.objectContaining({ branch: branch.branch, head })]);
    expect(deps.retire).toHaveBeenCalledWith(expect.objectContaining({ release: expect.objectContaining({ head }),
      review: { prUrl: 'https://github.com/example/repo/pull/42', digest: 'd'.repeat(64), acceptSuperseded: false } }),
      { beforeMutation: expect.any(Function) });
  });

  it('retains a missing archive receipt across repeated deterministic attempts without dispatch', async () => {
    const deps = setup();
    const prepared = await deps.prepare();
    prepared.review.comparison = { disposition: 'integrated', localPatch: '', difference: '' };
    deps.prepare.mockResolvedValue(prepared);
    deps.retire = vi.fn(async () => ({ ok: true, branchDeleted: true }));
    for (let n = 0; n < 70; n++) expect(await prepareReconcileRetirements(app, scan(), deps)).toMatchObject({
      candidates: [], retired: [], held: [{ reason: 'retirement-receipt-unverified' }],
    });
  });

  it('does not wake cognitive review for an unrelated default advance, timestamp or digest change', () => {
    const review = { policy: { policies: [{ id: 'original-owner' }] }, comparison: { disposition: 'superseded', localPatch: '+local', difference: '+replacement' }, digest: 'old', forge: { defaultHead: 'a' } };
    const first = retirementCognitiveIdentity(review, tree, 'https://github.com/example/repo/pull/42');
    expect(retirementCognitiveIdentity({ ...review, digest: 'new', observedAt: 'later', forge: { defaultHead: 'b' } }, tree, 'https://github.com/example/repo/pull/42')).toEqual(first);
    expect(retirementCognitiveIdentity({ ...review, comparison: { ...review.comparison, difference: '+changed source' } }, tree, 'https://github.com/example/repo/pull/42')).not.toEqual(first);
  });

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
    const result = await prepareReconcileRetirements(app, scan(), deps);
    expect(result.candidates).toHaveLength(1);
    expect(deps.prepare).toHaveBeenCalledOnce();
    deps.prepare.mockResolvedValue({ ok: false, reason: 'retirement-pr-not-matching-merged' });
    expect(await prepareReconcileRetirements(app, scan(), deps)).toMatchObject({
      candidates: [], held: [{ reason: 'retirement-pr-not-matching-merged' }],
    });
  });

  it.each([
    [{ liveOwnerReason: 'claim-owner-active' }, {}],
    [{ completionPolicyReason: 'pr-completion-human-handoff' }, {}],
    [{ openPr: { isDraft: true } }, {}],
    [{ openPr: { isDraft: false, headRefOid: head } }, {}],
    [{ openPr: { isDraft: false, headRefOid: null } }, {}],
    [{ worktreeDirty: true }, {}],
    [{ worktreeStatusUnavailable: true }, {}],
    [{}, { locked: true }], [{}, { managed: false }], [{}, { head: 'b'.repeat(40) }],
  ])('never dispatches or retires an unsafe or intentionally held candidate: %j %j', async (b, t) => {
    const deps = setup();
    deps.retire = vi.fn();
    for (const isMerged of [false, true]) {
      expect(await prepareReconcileRetirements(app, scan({ isMerged, ...b }, t), deps)).toMatchObject({ candidates: [], retired: [] });
    }
    expect(deps.prepare).not.toHaveBeenCalled();
    expect(deps.retire).not.toHaveBeenCalled();
  });

  it('retires a merged checkout left idle behind its open PR, and keeps one still in use', async () => {
    const deps = setup();
    deps.retire = vi.fn(async () => ({ ok: true, branchDeleted: true, archiveDir: '/private/verified-archive' }));
    const behind = { isMerged: true, openPr: { isDraft: false, headRefOid: 'c'.repeat(40) } };
    deps.checkoutIdleMs = vi.fn(async () => 2 * 60 * 60 * 1000);
    expect(await prepareReconcileRetirements(app, scan(behind), deps)).toMatchObject({ retired: [expect.objectContaining({ head })], held: [] });
    expect(deps.checkoutIdleMs).toHaveBeenCalledWith(tree.path);
    expect(deps.retire).toHaveBeenCalledWith(expect.objectContaining({ release: expect.objectContaining({ head }) }),
      { beforeMutation: expect.any(Function), settleMergedReviewObligation: true });
    deps.retire.mockClear();
    for (const idle of [5 * 60 * 1000, null]) {
      deps.checkoutIdleMs = vi.fn(async () => idle);
      expect(await prepareReconcileRetirements(app, scan(behind), deps)).toMatchObject({ candidates: [], retired: [], held: [] });
    }
    expect(await prepareReconcileRetirements(app, scan({ ...behind, isMerged: false }), deps)).toMatchObject({ candidates: [], retired: [] });
    expect(deps.retire).not.toHaveBeenCalled();
    expect(deps.prepare).not.toHaveBeenCalled();
  });

  it('never retires a draft that also carries a completion-policy hold (rule draft)', async () => {
    const deps = setup();
    deps.retire = vi.fn();
    const draft = { rule: 'draft', isMerged: true, openPr: { isDraft: true, headRefOid: 'c'.repeat(40) } };
    expect(await prepareReconcileRetirements(app, scan(draft), deps)).toMatchObject({ candidates: [], retired: [], held: [] });
    expect(deps.retire).not.toHaveBeenCalled();
    expect(deps.prepare).not.toHaveBeenCalled();
  });

  it.each(['claim-owner-active', 'retirement-local-objects-missing', 'retirement-submodule-not-uninitialized', 'retirement-policy-not-legacy-completed'])('keeps a fresh preview refusal visible: %s', async reason => {
    const deps = setup(); deps.prepare.mockResolvedValue({ ok: false, reason });
    expect(await prepareReconcileRetirements(app, scan(), deps)).toMatchObject({ candidates: [], held: [{ branch: branch.branch, reason }] });
  });

  it.each(['preview', 'merged-retirement', 'reviewed-retirement'])('keeps archive capacity diagnostics in held status after %s', async phase => {
    const deps = setup();
    const refusal = { ok: false, reason: 'retirement-archive-limit-exceeded', archiveLimit: {
      scope: 'content', kind: 'total', limitBytes: 250 * 1024 * 1024, observedBytes: 264 * 1024 * 1024,
    } };
    if (phase === 'preview') deps.prepare.mockResolvedValue(refusal);
    if (phase === 'reviewed-retirement') {
      const prepared = await deps.prepare();
      prepared.review.comparison = { disposition: 'integrated', localPatch: '', difference: '' };
      deps.prepare.mockResolvedValue(prepared);
    }
    deps.retire = vi.fn(async () => refusal);
    expect(await prepareReconcileRetirements(app, scan({ isMerged: phase === 'merged-retirement' }), deps)).toEqual({ candidates: [], retired: [], held: [{ branch: tree.branch, path: tree.path, head, locked: false, lockReason: null,
      reason: refusal.reason, archiveLimit: refusal.archiveLimit,
    }] });
    if (phase === 'preview') expect(deps.retire).not.toHaveBeenCalled();
  });

  it('does not invent approval after forge failure or vanished historical policy', async () => {
    const deps = setup(); deps.readPr.mockRejectedValueOnce(new Error('unreadable'));
    expect((await prepareReconcileRetirements(app, scan(), deps)).held[0].reason).toBe('retirement-pr-lookup-unavailable');
    deps.prepare.mockResolvedValue({ ok: true, review: { policy: { policies: [] } } });
    expect((await prepareReconcileRetirements(app, scan(), deps)).held[0].reason).toBe('retirement-policy-changed');
  });

  it.each([404, 422])('recovers historical review when the local tip is not published on the forge (HTTP %s)', async status => {
    const deps = setup();
    forge.read.mockRejectedValueOnce(Object.assign(new Error('synthetic missing commit'), {
      ghStderr: `gh: No commit found for SHA: ${head} (HTTP ${status})`, ghExitCode: 1,
    })).mockResolvedValueOnce(JSON.stringify([{ url: 'https://github.com/example/repo/pull/42' }]));
    const result = await prepareReconcileRetirements(app, scan(), { prepare: deps.prepare });
    expect(result.candidates).toHaveLength(1);
    expect(deps.prepare).toHaveBeenCalledWith(expect.objectContaining({ prUrl: 'https://github.com/example/repo/pull/42', release: expect.objectContaining({ head }) }));
    expect(forge.read).toHaveBeenLastCalledWith(['pr', 'list', '--repo', 'github.com/example/repo', '--head', branch.branch,
      '--state', 'merged', '--limit', '2', '--json', 'url'], undefined, expect.any(Object));
  });

  it.each([
    { history: [] },
    { history: [{ url: 'https://github.com/example/repo/pull/41' }, { url: 'https://github.com/example/repo/pull/42' }] },
    { history: [{ url: 'https://github.com/other/repo/pull/42' }] },
  ])('does not turn missing exact-head evidence into historical approval: %j', async ({ history }) => {
    const deps = setup();
    forge.read.mockRejectedValueOnce(Object.assign(new Error('missing'), { ghStderr: 'gh: Not Found (HTTP 404)' }))
      .mockResolvedValueOnce(JSON.stringify(history));
    expect(await prepareReconcileRetirements(app, scan(), { prepare: deps.prepare })).toMatchObject({
      candidates: [], retired: [], held: [{ reason: 'retirement-pr-ambiguous' }],
    });
    expect(deps.prepare).not.toHaveBeenCalled();
  });

  it('retains a historical candidate when fresh preview refuses it', async () => {
    const deps = setup();
    forge.read.mockRejectedValueOnce(Object.assign(new Error('missing'), { ghStderr: 'gh: Not Found (HTTP 404)' }))
      .mockResolvedValueOnce(JSON.stringify([{ url: 'https://github.com/example/repo/pull/42' }]));
    deps.prepare.mockResolvedValue({ ok: false, reason: 'claim-owner-active' });
    expect(await prepareReconcileRetirements(app, scan(), { prepare: deps.prepare })).toMatchObject({
      candidates: [], retired: [], held: [{ reason: 'claim-owner-active' }],
    });
  });

  it('distinguishes a failed preview from uncertain retirement without leaking raw errors', async () => {
    const deps = setup();
    deps.prepare.mockRejectedValueOnce(new Error('private diagnostic'));
    expect((await prepareReconcileRetirements(app, scan(), deps)).held[0].reason).toBe('retirement-review-unavailable');
    const prepared = await deps.prepare();
    prepared.review.comparison = { disposition: 'integrated', localPatch: '', difference: '' };
    deps.prepare.mockResolvedValue(prepared);
    deps.retire = vi.fn(async () => { throw new Error('private diagnostic after possible removal'); });
    expect(await prepareReconcileRetirements(app, scan(), deps)).toMatchObject({
      candidates: [], retired: [], held: [{ reason: 'retirement-receipt-unverified' }],
    });
    expect(deps.retire).toHaveBeenCalledOnce();
  });

  it('keeps a failed historical fallback held rather than inferring a merged PR', async () => {
    const deps = setup();
    forge.read.mockRejectedValueOnce(Object.assign(new Error('gh: Not Found (HTTP 404)'), { ghStderr: 'gh: Not Found (HTTP 404)' }))
      .mockRejectedValueOnce(new Error('synthetic unavailable'));
    expect(await prepareReconcileRetirements(app, scan(), { prepare: deps.prepare })).toMatchObject({
      candidates: [], retired: [], held: [{ reason: 'retirement-forge-unavailable' }],
    });
    expect(deps.prepare).not.toHaveBeenCalled();
  });

  it.each(['gh: rate limit exceeded (HTTP 403)', 'gh: authentication required (HTTP 401)', 'operation timed out',
    'gh: Validation Failed (HTTP 422)', `gh: No commit found for SHA: ${'b'.repeat(40)} (HTTP 422)`])(
    'does not replace an unreadable exact-head lookup with branch history: %s', async message => {
      const deps = setup();
      forge.read.mockRejectedValueOnce(Object.assign(new Error(message), { ghStderr: message }));
      const calls = forge.read.mock.calls.length;
      expect(await prepareReconcileRetirements(app, scan(), { prepare: deps.prepare })).toMatchObject({
        candidates: [], retired: [], held: [{ reason: 'retirement-forge-unavailable' }],
      });
      expect(forge.read.mock.calls.length).toBe(calls + 1);
      expect(deps.prepare).not.toHaveBeenCalled();
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
