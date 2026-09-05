import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── mocks (must precede the import under test) ──────────────────────────────

const execGhMock = vi.fn();
const ensureForgeReachableMock = vi.fn(async () => ({ ok: true, status: 'ok', detail: null, remedy: null }));
vi.mock('./github.js', () => ({
  execGh: (...args) => execGhMock(...args),
  ensureForgeReachable: (...args) => ensureForgeReachableMock(...args),
}));

const mergePrMock = vi.fn();
vi.mock('./git.js', () => ({
  mergePR: (...args) => mergePrMock(...args),
}));

const addNotificationMock = vi.fn();
vi.mock('./notifications.js', () => ({
  addNotification: (...args) => addNotificationMock(...args),
  NOTIFICATION_TYPES: { AGENT_WARNING: 'agent_warning' },
  PRIORITY_LEVELS: { HIGH: 'high' },
}));

const spawnReviewLoopFollowUpMock = vi.fn();
vi.mock('./agentWorktreeCleanup.js', () => ({
  spawnReviewLoopFollowUp: (...args) => spawnReviewLoopFollowUpMock(...args),
}));

const mockApps = new Map();
vi.mock('./apps.js', () => ({
  getActiveApps: vi.fn(async () => [...mockApps.values()]),
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
  readPendingMergePrs,
  queuePendingMerge,
  isPendingMergeReady,
  processPendingMergePrs,
  sweepPendingMergePrs,
  MAX_PENDING_MERGE_TICKS,
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
  ensureForgeReachableMock.mockReset();
  ensureForgeReachableMock.mockResolvedValue({ ok: true, status: 'ok', detail: null, remedy: null });
  mergePrMock.mockReset();
  addNotificationMock.mockReset();
  spawnReviewLoopFollowUpMock.mockReset();
  addNotificationMock.mockResolvedValue({ id: 'notification-1' });
  spawnReviewLoopFollowUpMock.mockResolvedValue({ id: 'follow-up-1' });
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

const pendingMerge = (overrides = {}) => ({
  prUrl: 'https://github.com/o/r/pull/88',
  prNumber: 88,
  prBranch: 'cos/task-88',
  sourceAgentId: 'agent-88',
  sourceTask: {
    id: 'task-88',
    priority: 'MEDIUM',
    description: 'Automated task',
    metadata: { app: 'app1' }
  },
  ticks: 0,
  ...overrides,
});

const pendingApp = (entries = [pendingMerge()]) => ({
  id: 'app1',
  repoPath: '/repos/app1',
  pendingMergePrs: entries
});

describe('merge-only PR watcher', () => {
  beforeEach(() => {
    getOriginInfoMock.mockResolvedValue({ hasOrigin: true, isGithub: true, host: 'github.com', fullName: 'o/r' });
  });

  it('queues a valid pending merge once without resetting its elapsed tick budget', async () => {
    mockApps.set('app1', pendingApp([pendingMerge({ ticks: 4 })]));

    const queued = await queuePendingMerge('app1', pendingMerge());

    expect(queued).toBe(true);
    expect(readPendingMergePrs(mockApps.get('app1'))).toHaveLength(1);
    expect(readPendingMergePrs(mockApps.get('app1'))[0].ticks).toBe(4);
  });

  it('recognizes only a clean OPEN PR with completed green checks as merge-ready', () => {
    expect(isPendingMergeReady({
      state: 'OPEN', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ conclusion: 'SUCCESS' }]
    })).toBe(true);
    expect(isPendingMergeReady({
      state: 'OPEN', mergeStateStatus: 'CLEAN', statusCheckRollup: []
    })).toBe(false);
    expect(isPendingMergeReady({
      state: 'OPEN', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ status: 'IN_PROGRESS' }]
    })).toBe(false);
  });

  it('merges a green pending PR without spawning a follow-up agent', async () => {
    const app = pendingApp();
    mockApps.set(app.id, app);
    execGhMock.mockResolvedValueOnce(JSON.stringify({
      state: 'OPEN', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ conclusion: 'SUCCESS' }]
    }));
    mergePrMock.mockResolvedValue({ success: true });

    const result = await processPendingMergePrs(app);

    expect(result).toMatchObject({ ok: true, checked: 1, merged: 1, escalated: 0 });
    expect(mergePrMock).toHaveBeenCalledWith('/repos/app1', 88);
    expect(spawnReviewLoopFollowUpMock).not.toHaveBeenCalled();
    expect(readPendingMergePrs(mockApps.get('app1'))).toEqual([]);
    expect(execGhMock).toHaveBeenCalledWith([
      'pr', 'view', '88', '--repo', 'github.com/o/r',
      '--json', 'state,mergeStateStatus,statusCheckRollup'
    ], undefined, { backoffKey: 'github.com/o/r' });
  });

  it.each([
    ['validation-failed', { state: 'OPEN', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ conclusion: 'FAILURE' }] }],
    ['merge-conflict', { state: 'OPEN', mergeStateStatus: 'DIRTY', statusCheckRollup: [{ conclusion: 'SUCCESS' }] }],
  ])('escalates %s to the existing merge-only follow-up', async (_reason, prView) => {
    const app = pendingApp();
    mockApps.set(app.id, app);
    execGhMock.mockResolvedValueOnce(JSON.stringify(prView));

    const result = await processPendingMergePrs(app);

    expect(result).toMatchObject({ ok: true, escalated: 1, merged: 0 });
    expect(spawnReviewLoopFollowUpMock).toHaveBeenCalledWith(expect.objectContaining({
      prUrl: 'https://github.com/o/r/pull/88',
      prBranch: 'cos/task-88',
      sourceWorkspace: '/repos/app1',
      prCompletion: 'merge-on-green',
      reviewers: []
    }));
    expect(mergePrMock).not.toHaveBeenCalled();
    expect(readPendingMergePrs(mockApps.get('app1'))).toEqual([]);
  });

  it('stops polling and notifies after the bounded pending-merge budget', async () => {
    const app = pendingApp([pendingMerge({ ticks: MAX_PENDING_MERGE_TICKS - 1 })]);
    mockApps.set(app.id, app);
    execGhMock.mockResolvedValueOnce(JSON.stringify({
      state: 'OPEN', mergeStateStatus: 'BLOCKED', statusCheckRollup: [{ status: 'IN_PROGRESS' }]
    }));

    const result = await processPendingMergePrs(app);

    expect(result).toMatchObject({ ok: true, timedOut: 1 });
    expect(addNotificationMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'agent_warning',
      priority: 'high',
      link: 'https://github.com/o/r/pull/88'
    }));
    expect(readPendingMergePrs(mockApps.get('app1'))).toEqual([]);
  });

  it('ticks an unreadable PR so a permanently-broken entry can time out', async () => {
    // `gh pr view` fails (deleted PR / renamed repo / revoked token). Counting
    // this cycle as an error but NOT as a tick re-queued the entry unchanged
    // forever — MAX_PENDING_MERGE_TICKS never fired and it leaked in apps.json.
    const app = pendingApp([pendingMerge({ ticks: 2 })]);
    mockApps.set(app.id, app);
    execGhMock.mockRejectedValueOnce(new Error('could not resolve to a PullRequest'));

    const result = await processPendingMergePrs(app);

    expect(result).toMatchObject({ ok: true, checked: 0, errors: 1, timedOut: 0 });
    expect(readPendingMergePrs(mockApps.get('app1'))[0].ticks).toBe(3);
  });

  it('times out and notifies once a permanently-unreadable PR exhausts its tick budget', async () => {
    const app = pendingApp([pendingMerge({ ticks: MAX_PENDING_MERGE_TICKS - 1 })]);
    mockApps.set(app.id, app);
    execGhMock.mockRejectedValueOnce(new Error('could not resolve to a PullRequest'));

    const result = await processPendingMergePrs(app);

    expect(result).toMatchObject({ ok: true, errors: 1, timedOut: 1 });
    expect(addNotificationMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'agent_warning',
      link: 'https://github.com/o/r/pull/88',
      description: expect.stringContaining('could not be read from the forge'),
    }));
    expect(readPendingMergePrs(mockApps.get('app1'))).toEqual([]);
  });
});

describe('sweepPendingMergePrs', () => {
  beforeEach(() => {
    mockApps.clear();
    getOriginInfoMock.mockResolvedValue({ hasOrigin: true, isGithub: true, host: 'github.com', fullName: 'o/r' });
  });

  // The regression this whole sweep exists for: pending merges used to drain
  // only when the app's `pr-watcher` scheduled task fired, so an install that
  // left that task disabled queued green PRs into a list nothing ever read.
  // The sweep must not consult the task schedule at all.
  it('drains a pending merge for an app with no pr-watcher config', async () => {
    mockApps.set('app1', { ...pendingApp(), name: 'App One', prWatcherState: undefined });
    execGhMock.mockResolvedValueOnce(JSON.stringify({
      state: 'OPEN', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ conclusion: 'SUCCESS' }]
    }));
    mergePrMock.mockResolvedValue({ success: true });

    const totals = await sweepPendingMergePrs();

    expect(totals).toMatchObject({ checked: 1, merged: 1, failures: 0 });
    expect(readPendingMergePrs(mockApps.get('app1'))).toEqual([]);
  });

  it('skips apps with no queued PRs without resolving their git origin', async () => {
    mockApps.set('app1', { id: 'app1', name: 'App One', repoPath: '/repos/app1' });
    mockApps.set('app2', { id: 'app2', name: 'App Two', repoPath: '/repos/app2', pendingMergePrs: [] });

    const totals = await sweepPendingMergePrs();

    expect(totals).toMatchObject({ checked: 0, merged: 0, failures: 0 });
    expect(getOriginInfoMock).not.toHaveBeenCalled();
    expect(execGhMock).not.toHaveBeenCalled();
  });

  it('counts a failing app and still sweeps the rest', async () => {
    mockApps.set('app1', { ...pendingApp(), name: 'App One' });
    mockApps.set('app2', {
      id: 'app2', name: 'App Two', repoPath: '/repos/app2',
      pendingMergePrs: [pendingMerge({ prNumber: 99, prUrl: 'https://github.com/o/r/pull/99' })]
    });
    // app1 fails the forge check; app2 proceeds and merges.
    ensureForgeReachableMock.mockResolvedValueOnce({ ok: false, status: 'unreachable' });
    execGhMock.mockResolvedValueOnce(JSON.stringify({
      state: 'OPEN', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ conclusion: 'SUCCESS' }]
    }));
    mergePrMock.mockResolvedValue({ success: true });

    const totals = await sweepPendingMergePrs();

    expect(totals).toMatchObject({ failures: 1, checked: 1, merged: 1 });
    // The unreachable app keeps its entry for the next tick.
    expect(readPendingMergePrs(mockApps.get('app1'))).toHaveLength(1);
    expect(readPendingMergePrs(mockApps.get('app2'))).toEqual([]);
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
    expect(execGhMock).toHaveBeenCalledWith(
      ['api', 'user', '--hostname', 'github.com', '--jq', '.login'],
      undefined,
      { backoffKey: 'github.com' }
    );
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

describe('checkPullRequests trusted maintenance boundary', () => {
  const app = { id: 'app1', repoPath: '/repos/example', prWatcherState: { lastSeenPrNumber: 9 } };
  const rawPr = (number, login, extra = {}) => ({ number, author: { login }, headRefOid: 'a'.repeat(40), updatedAt: '2026-08-01T00:00:00Z', ...extra });
  function forge(prs, { permission = 'write', host = 'github.com' } = {}) {
    getOriginInfoMock.mockResolvedValue({ host, fullName: 'example/project', hasOrigin: true });
    execGhMock.mockImplementation(async args => {
      if (args[0] === 'repo') return 'main';
      if (args[0] === 'pr') return JSON.stringify(prs);
      if (args.at(-1) === 'user') return JSON.stringify({ login: 'operator' });
      const login = args.at(-1).split('/').at(-2);
      return JSON.stringify({ user: { login }, permission: login === 'collaborator' ? permission : 'read' });
    });
  }

  it('routes self and live write collaborators, and legacy any/others never widen maintenance', async () => {
    forge([rawPr(10, 'operator'), rawPr(11, 'collaborator'), rawPr(12, 'external'), rawPr(13, null)]);
    for (const authorFilter of ['any', 'others', 'trusted']) {
      const result = await checkPullRequests(app, { authorFilter });
      expect(result.newPrs.map(pr => pr.number)).toEqual([10, 11]);
      expect(Object.keys(result.activityByPr)).toEqual(['10', '11']);
    }
    expect((await checkPullRequests(app, { authorFilter: 'self' })).newPrs.map(pr => pr.number)).toEqual([10]);
  });

  it('baselines once, converges, and re-dispatches an existing trusted PR after head or CI changes', async () => {
    const prs = [rawPr(3, 'collaborator')];
    forge(prs);
    const baseline = await checkPullRequests({ ...app, prWatcherState: {} });
    expect(baseline).toMatchObject({ firstRun: true, newPrs: [], newLastSeen: 3 });
    const tracked = { ...app, prWatcherState: { lastSeenPrNumber: 3, activityByPr: baseline.activityByPr } };
    expect((await checkPullRequests(tracked)).newPrs).toEqual([]);
    prs[0].headRefOid = 'b'.repeat(40);
    expect((await checkPullRequests(tracked)).newPrs.map(pr => pr.number)).toEqual([3]);
    prs[0].headRefOid = 'a'.repeat(40);
    prs[0].statusCheckRollup = [{ status: 'COMPLETED', conclusion: 'FAILURE' }];
    expect((await checkPullRequests(tracked)).newPrs.map(pr => pr.number)).toEqual([3]);
    const failureSeen = await checkPullRequests(tracked);
    prs[0].statusCheckRollup[0].completedAt = '2026-08-02T00:00:00Z';
    expect((await checkPullRequests({ ...tracked, prWatcherState: { lastSeenPrNumber: 3, activityByPr: failureSeen.activityByPr } })).newPrs.map(pr => pr.number)).toEqual([3]);
  });

  it('refreshes authority every poll and pins repository and permission queries to the enterprise host', async () => {
    forge([rawPr(10, 'collaborator')], { host: 'github.enterprise.example' });
    expect((await checkPullRequests(app)).newPrs).toHaveLength(1);
    expect(execGhMock.mock.calls.filter(([a]) => a[0] === 'api').every(([a]) => a.includes('github.enterprise.example'))).toBe(true);
    expect(execGhMock.mock.calls.filter(([a]) => a.includes('--repo')).every(([a]) => a.includes('github.enterprise.example/example/project'))).toBe(true);
    expect(execGhMock.mock.calls
      .filter(([a]) => a[0] === 'repo' || (a[0] === 'pr' && a[1] === 'list'))
      .every(([, , options]) => options?.backoffKey === 'github.enterprise.example/example/project')).toBe(true);
    forge([rawPr(10, 'collaborator')], { permission: 'read' });
    expect((await checkPullRequests(app)).newPrs).toEqual([]);
    execGhMock.mockImplementation(async args => args[0] === 'repo' ? 'main' : args[0] === 'pr' ? JSON.stringify([rawPr(10, 'collaborator')]) : Promise.reject(new Error('unavailable')));
    expect((await checkPullRequests(app)).newPrs).toEqual([]);
  });

  it('does not advance state after unsupported forge, unreachable, malformed or truncated input', async () => {
    getOriginInfoMock.mockResolvedValue({ host: 'gitlab.example.com', fullName: 'example/project' });
    expect(await checkPullRequests(app)).toMatchObject({ ok: false, reason: 'not-a-github-repo' });
    forge([]);
    ensureForgeReachableMock.mockResolvedValueOnce({ ok: false, status: 'unreachable' });
    expect(await checkPullRequests(app)).toMatchObject({ ok: false, reason: 'forge-unreachable' });
    execGhMock.mockImplementation(async args => args[0] === 'repo' ? 'main' : '{}');
    expect(await checkPullRequests(app)).toMatchObject({ ok: false, reason: 'pr-list-failed' });
    forge(Array.from({ length: 200 }, (_, i) => rawPr(i + 1, 'operator')));
    expect(await checkPullRequests(app)).toMatchObject({ ok: false, reason: 'too-many-open-prs' });
  });
});
