import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ gh: vi.fn(), git: vi.fn(), options: vi.fn() }));
vi.mock('./github.js', () => ({ execGh: mock.gh }));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: mock.options }));
vi.mock('../lib/execGit.js', () => ({ execGit: mock.git }));
vi.mock('../lib/gitRemote.js', () => ({ getOriginInfo: async () => ({ hasOrigin: true, isGithub: true, host: 'github.com', fullName: 'example/repo' }) }));
import { findMergedPullRequest, readMergedPrDelivery } from './mergedPrEvidence.js';

const prUrl = 'https://github.com/example/repo/pull/42';
const head = 'a'.repeat(40);

describe('merged PR delivery evidence', () => {
  let pr;
  let detail;
  let compare;
  beforeEach(() => {
    vi.clearAllMocks();
    pr = { url: prUrl, state: 'MERGED', headRefName: 'claim/42', headRefOid: head,
      mergeCommit: { oid: 'b'.repeat(40) }, isCrossRepository: false, baseRefName: 'main' };
    detail = { merged: true, head: { sha: head }, base: { ref: 'main' }, merge_commit_sha: 'b'.repeat(40) };
    compare = null;
    mock.options.mockResolvedValue({ cwd: '/synthetic/repo', env: {} });
    mock.git.mockResolvedValue({ stdout: '', exitCode: 0 });
    mock.gh.mockImplementation(async args => {
      const path = args.at(-1);
      if (args[0] === 'pr') return JSON.stringify(pr);
      if (path.includes('/compare/')) {
        if (compare instanceof Error) throw compare;
        return JSON.stringify(compare);
      }
      return JSON.stringify(path.includes('/pulls/') ? detail
        : path.includes('/git/ref/') ? { object: { sha: 'c'.repeat(40) } } : { default_branch: 'main' });
    });
  });

  it('binds the actual repository, default branch and PR refs using the managed app account', async () => {
    expect(await readMergedPrDelivery('/synthetic/repo', 'claim/42', prUrl, { forgeAccount: 'configured-owner' }))
      .toEqual({ repository: 'github.com/example/repo', prUrl, prHead: head, mergeCommit: 'b'.repeat(40),
        defaultBranch: 'main', defaultHead: 'c'.repeat(40), remoteHead: null });
    expect(mock.options).toHaveBeenCalledWith('/synthetic/repo', { forgeAccount: 'configured-owner' });
  });

  it.each([
    { state: 'OPEN' }, { state: 'CLOSED' }, { headRefName: 'another-claim' },
    { isCrossRepository: true }, { baseRefName: null }, { baseRefName: '--upload-pack=x' }, { mergeCommit: null },
  ])('refuses a nonmatching merged PR: %j', async change => {
    Object.assign(pr, change);
    await expect(readMergedPrDelivery('/synthetic/repo', 'claim/42', prUrl)).rejects.toThrow('merged-pr-not-matching');
  });

  it.each([{ merged: false }, { merge_commit_sha: 'd'.repeat(40) }, { head: { sha: 'd'.repeat(40) } }])(
    'refuses PR detail that disagrees with the merged PR: %j', async change => {
      Object.assign(detail, change);
      await expect(readMergedPrDelivery('/synthetic/repo', 'claim/42', prUrl)).rejects.toThrow('merged-pr-not-matching');
    });

  it('binds a merged release PR to its actual target and rejects inconsistent base evidence', async () => {
    pr.baseRefName = 'release';
    detail.base.ref = 'release';
    expect(await readMergedPrDelivery('/synthetic/repo', 'claim/42', prUrl)).toMatchObject({ defaultBranch: 'main', targetBranch: 'release', targetHead: 'c'.repeat(40) });
    expect(mock.gh).toHaveBeenCalledWith(['api', '--hostname', 'github.com', 'repos/example/repo/git/ref/heads/release'], undefined, expect.any(Object));
    detail.base.ref = 'another-target';
    await expect(readMergedPrDelivery('/synthetic/repo', 'claim/42', prUrl)).rejects.toThrow('merged-pr-not-matching');
  });

  it('names an exact delivered head, or one the merged head contains, from fresh forge facts', async () => {
    expect(await readMergedPrDelivery('/synthetic/repo', 'claim/42', prUrl, { exactDeliveredHead: head })).toMatchObject({ scopeProof: 'exact-delivered-head' });
    expect(mock.gh.mock.calls.some(([args]) => args.at(-1).includes('/compare/'))).toBe(false);
    const older = 'e'.repeat(40);
    compare = { status: 'ahead', behind_by: 0, base_commit: { sha: older }, merge_base_commit: { sha: older } };
    expect(await readMergedPrDelivery('/synthetic/repo', 'claim/42', prUrl, { exactDeliveredHead: older }))
      .toMatchObject({ scopeProof: 'ancestor-of-delivered-head', deliveredAncestorHead: older });
    expect(mock.gh).toHaveBeenCalledWith(['api', '--hostname', 'github.com', `repos/example/repo/compare/${older}...${head}?per_page=1`], undefined, expect.any(Object));
    compare = { status: 'diverged', behind_by: 1, base_commit: { sha: older }, merge_base_commit: { sha: 'f'.repeat(40) } };
    expect(await readMergedPrDelivery('/synthetic/repo', 'claim/42', prUrl, { exactDeliveredHead: older })).not.toHaveProperty('scopeProof');
    // An unpublished local commit is not contained; any other failure is unknown.
    compare = Object.assign(new Error('missing'), { ghStderr: 'gh: Not Found (HTTP 404)' });
    expect(await readMergedPrDelivery('/synthetic/repo', 'claim/42', prUrl, { exactDeliveredHead: older })).not.toHaveProperty('scopeProof');
    compare = Object.assign(new Error('limited'), { ghStderr: 'gh: rate limit exceeded (HTTP 403)' });
    await expect(readMergedPrDelivery('/synthetic/repo', 'claim/42', prUrl, { exactDeliveredHead: older })).rejects.toThrow('merged-pr-forge-unavailable');
  });

  it('refuses a different repository before sending a forge request', async () => {
    await expect(readMergedPrDelivery('/synthetic/repo', 'claim/42', 'https://github.com/other/repo/pull/42'))
      .rejects.toThrow('merged-pr-repository-mismatch');
    expect(mock.gh).not.toHaveBeenCalled();
  });

  it('distinguishes a failed remote lookup and a remote head moved past the merge from absence', async () => {
    mock.git.mockRejectedValueOnce(new Error('synthetic unavailable'));
    await expect(readMergedPrDelivery('/synthetic/repo', 'claim/42', prUrl)).rejects.toThrow('merged-pr-remote-ref-unreadable');
    mock.git.mockResolvedValueOnce({ stdout: `${'d'.repeat(40)}\trefs/heads/claim/42\n`, exitCode: 0 });
    await expect(readMergedPrDelivery('/synthetic/repo', 'claim/42', prUrl)).rejects.toThrow('merged-pr-remote-head-changed');
    mock.git.mockResolvedValueOnce({ stdout: `${head}\trefs/heads/claim/42\n`, exitCode: 0 });
    expect(await readMergedPrDelivery('/synthetic/repo', 'claim/42', prUrl)).toMatchObject({ remoteHead: `${head}\trefs/heads/claim/42` });
  });
});

describe('merged PR selection for an exact local tip', () => {
  const branch = 'claim/issue-42';
  const row = () => ({ html_url: prUrl, head: { ref: branch, sha: head, repo: { full_name: 'example/repo' } },
    base: { repo: { full_name: 'example/repo' } }, state: 'closed', merged_at: '2026-01-01T00:00:00Z' });
  const find = () => findMergedPullRequest('/example/repo', branch, head);
  beforeEach(() => {
    vi.clearAllMocks();
    mock.options.mockResolvedValue({ cwd: '/example/repo', env: { GH_TOKEN: 'synthetic' } });
  });

  it('selects the unique exact head on a reused branch', async () => {
    mock.gh.mockResolvedValue(JSON.stringify([{ ...row(), html_url: 'https://github.com/example/repo/pull/41', head: { ...row().head, sha: 'b'.repeat(40) } }, row()]));
    expect(await find()).toEqual({ url: prUrl, mergedAt: '2026-01-01T00:00:00Z' });
    expect(mock.gh).toHaveBeenLastCalledWith(['api', '--hostname', 'github.com', `repos/example/repo/commits/${head}/pulls?per_page=100`], undefined,
      { cwd: '/example/repo', env: { GH_TOKEN: 'synthetic' } });
  });

  it.each([404, 422])('falls back to the one merged branch PR when the local tip is not published (HTTP %s)', async status => {
    mock.gh.mockRejectedValueOnce(Object.assign(new Error('synthetic missing commit'), {
      ghStderr: `gh: No commit found for SHA: ${head} (HTTP ${status})`,
    })).mockResolvedValueOnce(JSON.stringify([{ url: prUrl }]));
    expect(await find()).toEqual({ url: prUrl, mergedAt: null });
    expect(mock.gh).toHaveBeenLastCalledWith(['pr', 'list', '--repo', 'github.com/example/repo', '--head', branch,
      '--state', 'merged', '--limit', '2', '--json', 'url'], undefined, expect.any(Object));
  });

  it.each([
    { history: [] },
    { history: [{ url: 'https://github.com/example/repo/pull/41' }, { url: prUrl }] },
    { history: [{ url: 'https://github.com/other/repo/pull/42' }] },
  ])('does not turn missing exact-head evidence into a historical match: %j', async ({ history }) => {
    mock.gh.mockRejectedValueOnce(Object.assign(new Error('missing'), { ghStderr: 'gh: Not Found (HTTP 404)' }))
      .mockResolvedValueOnce(JSON.stringify(history));
    await expect(find()).rejects.toThrow('merged-pr-ambiguous');
  });

  it('keeps a failed historical fallback unavailable rather than inferring a merged PR', async () => {
    mock.gh.mockRejectedValueOnce(Object.assign(new Error('gh: Not Found (HTTP 404)'), { ghStderr: 'gh: Not Found (HTTP 404)' }))
      .mockRejectedValueOnce(new Error('synthetic unavailable'));
    await expect(find()).rejects.toThrow('merged-pr-forge-unavailable');
  });

  it.each(['gh: rate limit exceeded (HTTP 403)', 'gh: authentication required (HTTP 401)', 'operation timed out',
    'gh: Validation Failed (HTTP 422)', `gh: No commit found for SHA: ${'b'.repeat(40)} (HTTP 422)`])(
    'does not replace an unreadable exact-head lookup with branch history: %s', async message => {
      mock.gh.mockRejectedValueOnce(Object.assign(new Error(message), { ghStderr: message }));
      await expect(find()).rejects.toThrow('merged-pr-forge-unavailable');
      expect(mock.gh).toHaveBeenCalledTimes(1);
    });

  it.each(['duplicate-head', 'no-matching-head', 'capped', 'foreign-repository', 'foreign-branch', 'fork', 'duplicate-url', 'unreadable'])(
    'keeps reused-branch ambiguity unresolved: %s', async change => {
      let rows = [row(), { ...row(), html_url: 'https://github.com/example/repo/pull/41', head: { ...row().head, sha: 'b'.repeat(40) } }];
      if (change === 'duplicate-head') rows[1].head.sha = head;
      if (change === 'no-matching-head') rows[0].head.sha = 'c'.repeat(40);
      if (change === 'capped') rows = Array.from({ length: 100 }, (_, index) => ({ ...row(), html_url: `https://github.com/example/repo/pull/${index + 1}` }));
      if (change === 'foreign-repository') rows[0].html_url = 'https://github.com/other/repo/pull/42';
      if (change === 'foreign-branch') rows[0].head.ref = 'another/branch';
      if (change === 'fork') rows[0].head.repo.full_name = 'fork/repo';
      if (change === 'duplicate-url') rows[1].html_url = prUrl;
      if (change === 'unreadable') rows = null;
      mock.gh.mockResolvedValue(JSON.stringify(rows));
      await expect(find()).rejects.toThrow('merged-pr-ambiguous');
    });
});
