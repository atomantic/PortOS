import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── mocks (must precede the import under test) ──────────────────────────────

const execGhMock = vi.fn();
vi.mock('./github.js', () => ({
  execGh: (...args) => execGhMock(...args),
}));

const mockApps = new Map();
vi.mock('./apps.js', () => ({
  getAppById: vi.fn(async (id) => mockApps.get(id) || null),
  updateApp: vi.fn(async (id, patch) => {
    const cur = mockApps.get(id) || { id };
    const next = { ...cur, ...patch };
    mockApps.set(id, next);
    return next;
  }),
}));

const getOriginInfoMock = vi.fn();
vi.mock('../lib/gitRemote.js', () => ({
  getOriginInfo: (...args) => getOriginInfoMock(...args),
}));

import {
  matchesAuthorFilter,
  computePrCheck,
  formatPullRequestsForPrompt,
  readPrWatcherState,
  checkPullRequests,
  getSelfLogin,
  __resetSelfLoginCache,
} from './prWatcher.js';

const pr = (number, login, extra = {}) => ({
  number,
  title: `PR ${number}`,
  authorLogin: login,
  url: `https://github.com/o/r/pull/${number}`,
  createdAt: '2026-06-05T00:00:00Z',
  isDraft: false,
  headRefName: `feat/${number}`,
  ...extra,
});

beforeEach(() => {
  execGhMock.mockReset();
  getOriginInfoMock.mockReset();
  mockApps.clear();
  __resetSelfLoginCache();
});

describe('matchesAuthorFilter', () => {
  it('any matches everything', () => {
    expect(matchesAuthorFilter(pr(1, 'alice'), 'any', 'bob')).toBe(true);
    expect(matchesAuthorFilter(pr(1, null), 'any', 'bob')).toBe(true);
  });
  it('self matches only the operator login', () => {
    expect(matchesAuthorFilter(pr(1, 'bob'), 'self', 'bob')).toBe(true);
    expect(matchesAuthorFilter(pr(1, 'alice'), 'self', 'bob')).toBe(false);
    expect(matchesAuthorFilter(pr(1, null), 'self', 'bob')).toBe(false);
  });
  it('others matches everyone but the operator', () => {
    expect(matchesAuthorFilter(pr(1, 'alice'), 'others', 'bob')).toBe(true);
    expect(matchesAuthorFilter(pr(1, 'bob'), 'others', 'bob')).toBe(false);
    expect(matchesAuthorFilter(pr(1, null), 'others', 'bob')).toBe(false);
  });
});

describe('computePrCheck', () => {
  it('first run baselines to max open PR and dispatches nothing', () => {
    const r = computePrCheck({ prs: [pr(5, 'a'), pr(8, 'b')], prevLastSeen: null, authorFilter: 'any', selfLogin: null });
    expect(r.firstRun).toBe(true);
    expect(r.newPrs).toEqual([]);
    expect(r.newLastSeen).toBe(8);
  });

  it('first run with no open PRs baselines to 0', () => {
    const r = computePrCheck({ prs: [], prevLastSeen: null, authorFilter: 'any', selfLogin: null });
    expect(r.firstRun).toBe(true);
    expect(r.newLastSeen).toBe(0);
  });

  it('detects only PRs above the high-water mark', () => {
    const r = computePrCheck({ prs: [pr(5, 'a'), pr(8, 'b'), pr(9, 'c')], prevLastSeen: 8, authorFilter: 'any', selfLogin: null });
    expect(r.newPrs.map(p => p.number)).toEqual([9]);
    expect(r.candidateCount).toBe(1);
    expect(r.newLastSeen).toBe(9);
  });

  it('applies the author gate but still advances the mark past gated-out PRs', () => {
    const r = computePrCheck({
      prs: [pr(10, 'bob'), pr(11, 'alice')],
      prevLastSeen: 9, authorFilter: 'others', selfLogin: 'bob'
    });
    // #10 (bob) gated out, #11 (alice) dispatched
    expect(r.newPrs.map(p => p.number)).toEqual([11]);
    expect(r.candidateCount).toBe(2);
    // mark advances past BOTH so the gated-out #10 never re-fires
    expect(r.newLastSeen).toBe(11);
  });

  it('never regresses the mark when open PRs are below it', () => {
    const r = computePrCheck({ prs: [pr(3, 'a')], prevLastSeen: 10, authorFilter: 'any', selfLogin: null });
    expect(r.newPrs).toEqual([]);
    expect(r.newLastSeen).toBe(10);
  });
});

describe('readPrWatcherState', () => {
  it('tolerates missing / malformed state', () => {
    expect(readPrWatcherState(undefined)).toEqual({});
    expect(readPrWatcherState({})).toEqual({});
    expect(readPrWatcherState({ prWatcherState: null })).toEqual({});
    expect(readPrWatcherState({ prWatcherState: [1, 2] })).toEqual({});
    expect(readPrWatcherState({ prWatcherState: { lastSeenPrNumber: 7 } })).toEqual({ lastSeenPrNumber: 7 });
  });
});

describe('formatPullRequestsForPrompt', () => {
  it('renders a markdown block with numbers, authors and urls', () => {
    const out = formatPullRequestsForPrompt(
      [pr(12, 'alice', { isDraft: true })],
      { repoFullName: 'o/r', defaultBranch: 'main' }
    );
    expect(out).toContain('o/r');
    expect(out).toContain('`main`');
    expect(out).toContain('#12');
    expect(out).toContain('by alice');
    expect(out).toContain('_(draft)_');
    expect(out).toContain('https://github.com/o/r/pull/12');
  });
});

describe('getSelfLogin', () => {
  it('resolves against the given host (via --hostname) and caches per host', async () => {
    execGhMock.mockResolvedValueOnce('bob\n');
    expect(await getSelfLogin('github.com')).toBe('bob');
    expect(await getSelfLogin('github.com')).toBe('bob');
    expect(execGhMock).toHaveBeenCalledTimes(1);
    // --hostname is required: without it `gh api` hits github.com regardless of
    // cwd and would resolve the wrong identity on an enterprise repo.
    expect(execGhMock).toHaveBeenCalledWith(['api', 'user', '--hostname', 'github.com', '--jq', '.login']);
  });

  it('caches each host independently — a different login per host', async () => {
    execGhMock
      .mockResolvedValueOnce('alice\n')        // github.com
      .mockResolvedValueOnce('alice_corp\n');  // enterprise
    expect(await getSelfLogin('github.com')).toBe('alice');
    expect(await getSelfLogin('github.enterprise.test')).toBe('alice_corp');
    // Both cached — no re-resolve for either host.
    expect(await getSelfLogin('github.com')).toBe('alice');
    expect(await getSelfLogin('github.enterprise.test')).toBe('alice_corp');
    expect(execGhMock).toHaveBeenCalledTimes(2);
  });

  it('returns null with no host and never shells out', async () => {
    expect(await getSelfLogin()).toBe(null);
    expect(await getSelfLogin('')).toBe(null);
    expect(execGhMock).not.toHaveBeenCalled();
  });

  it('returns null when gh fails', async () => {
    execGhMock.mockRejectedValueOnce(new Error('not authed'));
    expect(await getSelfLogin('github.com')).toBe(null);
  });

  it('does not cache a failed lookup — retries on the next call', async () => {
    execGhMock.mockRejectedValueOnce(new Error('keychain locked'));
    expect(await getSelfLogin('github.com')).toBe(null);
    // A transient failure must not wedge the cache: the next call retries.
    execGhMock.mockResolvedValueOnce('bob');
    expect(await getSelfLogin('github.com')).toBe('bob');
    expect(execGhMock).toHaveBeenCalledTimes(2);
  });
});

describe('checkPullRequests', () => {
  const app = { id: 'app1', repoPath: '/repos/app1' };

  it('bails when the repo is not a github repo', async () => {
    getOriginInfoMock.mockResolvedValue({ hasOrigin: false, isGithub: false, fullName: null });
    const r = await checkPullRequests(app, { authorFilter: 'any' });
    expect(r).toEqual({ ok: false, reason: 'not-a-github-repo' });
  });

  it('bails when the default branch cannot be resolved', async () => {
    getOriginInfoMock.mockResolvedValue({ hasOrigin: true, isGithub: true, host: 'github.com', fullName: 'o/r' });
    execGhMock.mockResolvedValueOnce(''); // repo view → empty
    const r = await checkPullRequests(app, { authorFilter: 'any' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('default-branch-unresolved');
  });

  it('bails when an author gate is set but self login is unavailable', async () => {
    getOriginInfoMock.mockResolvedValue({ hasOrigin: true, isGithub: true, host: 'github.com', fullName: 'o/r' });
    execGhMock
      .mockResolvedValueOnce('main')          // repo view → default branch
      .mockRejectedValueOnce(new Error('no auth')); // api user → fails
    const r = await checkPullRequests(app, { authorFilter: 'self' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('self-login-unavailable');
  });

  it('bails when the PR list call fails', async () => {
    getOriginInfoMock.mockResolvedValue({ hasOrigin: true, isGithub: true, host: 'github.com', fullName: 'o/r' });
    execGhMock
      .mockResolvedValueOnce('main')                  // repo view
      .mockRejectedValueOnce(new Error('list failed')); // pr list
    const r = await checkPullRequests(app, { authorFilter: 'any' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('pr-list-failed');
  });

  it('first run baselines without dispatching', async () => {
    getOriginInfoMock.mockResolvedValue({ hasOrigin: true, isGithub: true, host: 'github.com', fullName: 'o/r' });
    execGhMock
      .mockResolvedValueOnce('main') // repo view
      .mockResolvedValueOnce(JSON.stringify([
        { number: 4, title: 'a', author: { login: 'x' }, url: 'u4', createdAt: '2026-06-01T00:00:00Z', isDraft: false, headRefName: 'h4' }
      ]));
    const r = await checkPullRequests({ ...app, prWatcherState: {} }, { authorFilter: 'any' });
    expect(r.ok).toBe(true);
    expect(r.firstRun).toBe(true);
    expect(r.newLastSeen).toBe(4);
    expect(r.newPrs).toEqual([]);
  });

  it('dispatches new PRs above the mark, honoring the author gate', async () => {
    getOriginInfoMock.mockResolvedValue({ hasOrigin: true, isGithub: true, host: 'github.com', fullName: 'o/r' });
    execGhMock
      .mockResolvedValueOnce('main')        // repo view
      .mockResolvedValueOnce('bob')         // api user
      .mockResolvedValueOnce(JSON.stringify([
        { number: 7, title: 'mine', author: { login: 'bob' }, url: 'u7', createdAt: '2026-06-04T00:00:00Z', isDraft: false, headRefName: 'h7' },
        { number: 8, title: 'theirs', author: { login: 'alice' }, url: 'u8', createdAt: '2026-06-05T00:00:00Z', isDraft: false, headRefName: 'h8' }
      ]));
    const r = await checkPullRequests({ ...app, prWatcherState: { lastSeenPrNumber: 6 } }, { authorFilter: 'others' });
    expect(r.ok).toBe(true);
    expect(r.firstRun).toBe(false);
    expect(r.newPrs.map(p => p.number)).toEqual([8]);
    expect(r.newLastSeen).toBe(8);
    expect(r.repoFullName).toBe('o/r');
    expect(r.defaultBranch).toBe('main');
  });

  it('accepts a GitHub Enterprise host (isGithub false) and resolves self against THAT host', async () => {
    // The core fix: an enterprise repo (github.* but not github.com, so
    // origin.isGithub is false) must still be watched, and the self gate must
    // resolve identity on the enterprise host — not github.com.
    getOriginInfoMock.mockResolvedValue({ hasOrigin: true, isGithub: false, host: 'github.enterprise.test', fullName: 'o/r' });
    execGhMock
      .mockResolvedValueOnce('main')           // repo view (default branch)
      .mockResolvedValueOnce('alice_corp')     // api user --hostname github.enterprise.test
      .mockResolvedValueOnce(JSON.stringify([
        { number: 7, title: 'mine', author: { login: 'alice_corp' }, url: 'u7', createdAt: '2026-06-04T00:00:00Z', isDraft: false, headRefName: 'h7' }
      ]));
    const r = await checkPullRequests({ id: 'ent', repoPath: '/repos/ent', prWatcherState: { lastSeenPrNumber: 6 } }, { authorFilter: 'self' });
    expect(r.ok).toBe(true);
    expect(r.newPrs.map(p => p.number)).toEqual([7]);
    // Mechanism assertions (not just the end result): self is resolved on the
    // enterprise host via --hostname, and repo view / pr list pin the
    // host-qualified HOST/OWNER/REPO selector. These pin the exact contract so a
    // regression that reintroduced the original bug — a host-less `--repo o/r`
    // (defaults to github.com) or a dropped host qualifier — fails here.
    expect(execGhMock).toHaveBeenCalledWith(['api', 'user', '--hostname', 'github.enterprise.test', '--jq', '.login']);
    expect(execGhMock).toHaveBeenCalledWith(['repo', 'view', 'github.enterprise.test/o/r', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name']);
    expect(execGhMock).toHaveBeenCalledWith(['pr', 'list', '--repo', 'github.enterprise.test/o/r', '--base', 'main', '--state', 'open', '--limit', '200', '--json', 'number,title,author,url,createdAt,isDraft,headRefName']);
    // No call ever passes a host-less `--repo o/r` (the exact original bug).
    const usedHostlessRepo = execGhMock.mock.calls.some(([args]) =>
      Array.isArray(args) && args.indexOf('--repo') !== -1 && args[args.indexOf('--repo') + 1] === 'o/r');
    expect(usedHostlessRepo).toBe(false);
  });

  it('rejects a non-GitHub (GitLab) host as not-a-github-repo', async () => {
    getOriginInfoMock.mockResolvedValue({ hasOrigin: true, isGithub: false, host: 'gitlab.enterprise.test', fullName: 'o/r' });
    const r = await checkPullRequests({ id: 'gl', repoPath: '/repos/gl' }, { authorFilter: 'any' });
    expect(r).toEqual({ ok: false, reason: 'not-a-github-repo' });
    expect(execGhMock).not.toHaveBeenCalled();
  });
});
