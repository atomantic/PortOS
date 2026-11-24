/**
 * Call-count and concurrency contracts of the notification triage reader (#17277),
 * exercised through the public triage and status-refresh entry points with the
 * database and `gh` mocked, so no Postgres is needed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('./github.js', () => ({ execGh: vi.fn() }));
vi.mock('./apps.js', () => ({ getAllApps: vi.fn(async () => []) }));
vi.mock('../lib/gitRemote.js', async (importOriginal) => ({ ...(await importOriginal()), readOriginRemoteUrl: vi.fn(async () => null) }));
vi.mock('./githubAccounts.js', () => ({ listAccounts: vi.fn(async () => [{ host: 'github.com', login: 'octocat' }]) }));

const { query, withTransaction } = await import('../lib/db.js');
const { execGh } = await import('./github.js');
const { triageAccountNotifications, refreshOpenPullRequestStatus, createManagedAppsLoader, threadDiscussionVouched } = await import('./githubNotificationTriage.js');
const { getAllApps } = await import('./apps.js');
const { readOriginRemoteUrl } = await import('../lib/gitRemote.js');

const account = { id: 'acct', host: 'github.com', login: 'octocat', mode: 'observe', trust: 'public' };
const NOW = Date.parse('2026-11-21T00:00:00Z');

const row = (n, extra = {}) => ({
  thread_id: `t${n}`, account_id: 'acct', repo_full_name: 'acme/widgets', repo_owner: 'acme', reason: 'review_requested',
  subject_type: 'PullRequest', subject_title: `PR ${n}`, subject_api_url: `https://api.github.com/repos/acme/widgets/pulls/${n}`,
  latest_comment_api_url: null, gh_updated_at: '2026-11-20T00:00:00Z', triaged_for: null, decision: null, state: 'open', evidence: {}, ...extra,
});

let inFlight;
let maxInFlight;
let calls;

function mockForge() {
  inFlight = 0;
  maxInFlight = 0;
  calls = [];
  vi.mocked(execGh).mockImplementation(async (args) => {
    const endpoint = args[args.indexOf('--method') + 2];
    calls.push(endpoint);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    if (endpoint.startsWith('repos/acme/widgets/pulls/')) {
      return JSON.stringify({ author: 'stranger', authorType: 'User', state: 'open', merged: false, draft: false, mergeableState: 'clean' });
    }
    if (endpoint === 'repos/acme/widgets') return JSON.stringify({ defaultBranch: 'main', canPush: true });
    if (endpoint.startsWith('users/')) return '2020-01-01T00:00:00Z';
    throw Object.assign(new Error('HTTP 404'), { ghExitCode: 1, ghStderr: 'HTTP 404' });
  });
}

describe('triageAccountNotifications reads', () => {
  const writes = [];
  beforeEach(() => {
    vi.mocked(query).mockReset();
    vi.mocked(execGh).mockReset();
    writes.length = 0;
    mockForge();
    vi.mocked(withTransaction).mockImplementation(async (fn) => fn({
      query: vi.fn(async (sql, params) => {
        writes.push([sql, params]);
        return { rows: [], rowCount: 1 };
      }),
    }));
  });

  it('counts repo history in one grouped query, fetches the repo once and bounds concurrency', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(i + 1));
    vi.mocked(query).mockImplementation(async (sql) => {
      if (/FROM github_notifications WHERE account_id = \$1 AND \(triaged_for/.test(sql)) return { rows };
      if (/GROUP BY repo_full_name/.test(sql)) return { rows: [{ repo_full_name: 'acme/widgets', n: 12 }] };
      if (/github_notification_rules/.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await triageAccountNotifications(account, {}, { now: NOW });

    expect(result.triaged).toBe(12);
    const countQueries = vi.mocked(query).mock.calls.filter(([sql]) => /COUNT\(\*\)/.test(sql));
    expect(countQueries).toHaveLength(1);
    expect(countQueries[0][1]).toEqual(['acct', ['acme/widgets']]);
    expect(calls.filter((endpoint) => endpoint === 'repos/acme/widgets')).toHaveLength(1);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(5);
  });

  it('keeps per-thread spam history and writes verdicts in input order', async () => {
    // Two threads in the repo -> each sees one prior thread, so the stranger is "first-time" only with no history.
    const rows = [row(1), row(2)];
    vi.mocked(query).mockImplementation(async (sql) => {
      if (/FROM github_notifications WHERE account_id = \$1 AND \(triaged_for/.test(sql)) return { rows };
      if (/GROUP BY repo_full_name/.test(sql)) return { rows: [{ repo_full_name: 'acme/widgets', n: 2 }] };
      return { rows: [] };
    });
    await triageAccountNotifications(account, {}, { now: NOW });
    const updated = writes.filter(([sql]) => /SET decision/.test(sql)).map(([, params]) => params[1]);
    expect(updated).toEqual(['t1', 't2']);
  });
});

describe('refreshOpenPullRequestStatus', () => {
  it('re-reads PRs concurrently within the bound and counts moved statuses', async () => {
    vi.mocked(query).mockReset();
    mockForge();
    const rows = Array.from({ length: 12 }, (_, i) => row(i + 1, { evidence: { subjectState: 'open', subjectDraft: false, mergeState: i % 2 ? 'clean' : 'dirty' } }));
    vi.mocked(query).mockImplementation(async (sql) => (/^\s*SELECT/.test(sql) ? { rows } : { rows: [], rowCount: 1 }));

    const changed = await refreshOpenPullRequestStatus(account, {}, { now: NOW });

    expect(changed).toBe(6);
    expect(vi.mocked(query).mock.calls.filter(([sql]) => /UPDATE github_notifications/.test(sql))).toHaveLength(12);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(5);
  });
});

describe('managed app lookup', () => {
  it('reads each managed app origin once per loader however many stages ask', async () => {
    vi.mocked(getAllApps).mockClear();
    vi.mocked(readOriginRemoteUrl).mockClear();
    vi.mocked(getAllApps).mockResolvedValueOnce([{ id: 'a', repoPath: '/repo/a' }, { id: 'b', repoPath: '/repo/b' }]);
    const load = createManagedAppsLoader();

    const [first, second, third] = await Promise.all([load(), load(), load()]);

    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(getAllApps).toHaveBeenCalledTimes(1);
    expect(readOriginRemoteUrl).toHaveBeenCalledTimes(2);
  });
});

describe('threadDiscussionVouched', () => {
  it('fetches the issue, review-comment and review lists concurrently', async () => {
    vi.mocked(execGh).mockReset();
    let active = 0;
    let peak = 0;
    vi.mocked(execGh).mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return '';
    });

    const vouched = await threadDiscussionVouched(account, {}, row(7));

    expect(vouched).toBe(true);
    expect(vi.mocked(execGh)).toHaveBeenCalledTimes(3);
    expect(peak).toBe(3);
  });
});
