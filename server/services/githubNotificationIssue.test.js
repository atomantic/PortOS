import { beforeEach, describe, expect, it, vi } from 'vitest';

const doubles = vi.hoisted(() => ({
  query: vi.fn(),
  appByRepo: vi.fn(),
  trusted: vi.fn(),
  requireAccount: vi.fn(),
  accountSelector: vi.fn(),
  preflight: vi.fn(),
  build: vi.fn(),
  add: vi.fn(),
}));
vi.mock('../lib/db.js', () => ({ query: doubles.query }));
vi.mock('./githubNotificationTriage.js', () => ({ managedAppsByRepoKey: doubles.appByRepo, threadDiscussionVouched: doubles.trusted }));
vi.mock('./githubNotifications.js', () => ({ requireAccountEnv: doubles.requireAccount }));
vi.mock('./githubAccounts.js', () => ({ githubReviewAccountSelector: doubles.accountSelector }));
vi.mock('./appIssues.js', () => ({ prepareAppIssueClaim: doubles.preflight }));
vi.mock('./cos/cosTaskClaimWork.js', () => ({ buildClaimWorkTask: doubles.build }));
vi.mock('./cos/cosTaskStore.js', () => ({ addTask: doubles.add }));

const { claimNotificationIssue } = await import('./githubNotificationIssue.js');

const account = { id: 'acct', enabled: true, mode: 'observe', host: 'github.com', login: 'operator' };
const app = { id: 'example', name: 'Example' };
const row = {
  subject_type: 'Issue',
  subject_api_url: 'https://api.github.com/repos/example/app/issues/42',
  repo_full_name: 'example/app',
  state: 'open', trust: 'yours',
  evidence: { subjectState: 'open', repoManaged: true, actorType: 'User', actor: 'operator' },
};
const pin = { provider: 'example-codex', model: 'example-model', effort: 'medium' };
const forClaim = issue => doubles.query.mockResolvedValue({ rows: [issue] });

beforeEach(() => {
  vi.resetAllMocks();
  forClaim(row);
  doubles.appByRepo.mockResolvedValue(new Map([['github.com/example/app', app]]));
  doubles.trusted.mockResolvedValue(true);
  doubles.requireAccount.mockResolvedValue({});
  doubles.accountSelector.mockResolvedValue({ id: account.id, login: account.login, host: account.host });
  doubles.preflight.mockResolvedValue({
    commentsClear: true, forgeContext: { repo: row.repo_full_name, host: account.host, me: account.login },
    issueContext: { number: 42, title: 'Example issue', body: 'Trusted description' },
  });
  doubles.build.mockResolvedValue({ tracker: 'github', target: '42', prompt: 'Pinned manual claim', taskMetadata: { claimServerCheckout: true } });
  doubles.add.mockResolvedValue({ id: 'task-1', status: 'pending' });
});

describe('claiming a GitHub issue from its notification', () => {
  it('queues the same pinned manual claim, using the issue number rather than the thread ID', async () => {
    expect(await claimNotificationIssue(account, '9001', pin)).toEqual({ taskId: 'task-1', duplicate: false });
    expect(doubles.query).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^SELECT /), ['acct', '9001']);
    expect(doubles.preflight).toHaveBeenCalledExactlyOnceWith(app, '42', 'github', {
      includePreflight: true,
      expectedGithubIssue: { host: account.host, repo: row.repo_full_name, number: 42, author: 'operator', login: 'operator' },
    });
    expect(doubles.build).toHaveBeenLastCalledWith(app, expect.objectContaining({
      target: '42', preverified: true, commentsClear: false,
      issueContext: { number: 42, title: 'Example issue', body: 'Trusted description' },
    }));
    expect(doubles.add).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      app: 'example', claimTarget: '42', claimFlow: true, claimServerCheckout: true, ...pin,
      description: expect.stringContaining('claim GitHub Issues item 42'),
      metadata: {
        prompt: 'Pinned manual claim',
        githubAccount: { id: 'acct', host: 'github.com', login: 'operator' },
        githubIssueClaim: { host: 'github.com', repo: 'example/app', number: 42, author: 'operator' },
        githubNotificationAccount: { accountId: 'acct', host: 'github.com', login: 'operator', origin: 'user' },
      },
    }), 'user');
  });

  it.each([
    { subject_type: 'PullRequest' },
    { trust: 'outside' },
    { state: 'done' },
    { suspect: true },
    { evidence: { ...row.evidence, subjectState: 'closed' } },
    { subject_api_url: 'https://api.github.com/repos/other/app/issues/42' },
    { subject_api_url: 'https://api.github.com/repos/example/app/pulls/42' },
  ])('does not dispatch or read forge content for an ineligible thread: %j', async override => {
    forClaim({ ...row, ...override });
    await expect(claimNotificationIssue(account, '9001', pin)).rejects.toMatchObject({ status: 409 });
    expect(doubles.requireAccount).not.toHaveBeenCalled();
    expect(doubles.add).not.toHaveBeenCalled();
  });

  it('refuses unverified comments before preflight and private accounts before reading anything', async () => {
    doubles.trusted.mockResolvedValue(false);
    await expect(claimNotificationIssue(account, '9001', pin)).rejects.toMatchObject({ status: 409 });
    expect(doubles.preflight).not.toHaveBeenCalled();
    doubles.requireAccount.mockClear();
    await expect(claimNotificationIssue({ ...account, trust: 'private', allowAgents: false }, '9001', pin)).rejects.toMatchObject({ status: 409 });
    expect(doubles.requireAccount).not.toHaveBeenCalled();
    expect(doubles.add).not.toHaveBeenCalled();
  });

  it('refuses a mismatched work tracker and surfaces a stale issue before task creation', async () => {
    doubles.build.mockResolvedValueOnce({ tracker: 'plan', target: '42' });
    await expect(claimNotificationIssue(account, '9001', pin)).rejects.toMatchObject({ code: 'CLAIM_TRACKER_MISMATCH' });
    expect(doubles.preflight).not.toHaveBeenCalled();
    doubles.preflight.mockRejectedValueOnce(Object.assign(new Error('Issue closed'), { code: 'ISSUE_IN_FLIGHT' }));
    await expect(claimNotificationIssue(account, '9001', pin)).rejects.toMatchObject({ code: 'ISSUE_IN_FLIGHT' });
    expect(doubles.add).not.toHaveBeenCalled();
  });
});
