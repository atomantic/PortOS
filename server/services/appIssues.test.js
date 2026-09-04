import { describe, it, expect, vi, beforeEach } from 'vitest';

const ensureForgeReachableMock = vi.fn(async () => ({ ok: true, status: 'ok', detail: null, remedy: null }));
vi.mock('./github.js', () => ({
  execGh: vi.fn(async () => '[]'),
  ensureForgeReachable: (...args) => ensureForgeReachableMock(...args),
}));
vi.mock('./gitlab.js', () => ({ execGlabJson: vi.fn(async () => ({ rows: [], reason: 'ok' })) }));
// gitRemote is the only effectful dependency of the real forge classifier, so
// mock IT and let `resolveRepoForgeTarget` run for real — the github-vs-gitlab
// routing under test is exactly that mapping.
vi.mock('../lib/gitRemote.js', () => ({
  getOriginInfo: vi.fn(async () => ({ isGithub: true, host: 'github.com', fullName: 'acme/widget' })),
  readOriginRemoteUrl: vi.fn(async () => 'git@github.com:acme/widget.git'),
}));
vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { root: '/repo' },
  safeJSONParse: (raw, fallback) => { try { return JSON.parse(raw); } catch { return fallback; } },
}));

import { listAppIssues } from './appIssues.js';
import { execGh } from './github.js';
import { execGlabJson } from './gitlab.js';
import { getOriginInfo, readOriginRemoteUrl } from '../lib/gitRemote.js';

// `workTracker: 'auto'` resolves to whatever the origin host is — the common case.
const APP = { id: 'app-1', name: 'Widget', repoPath: '/repo', workTracker: 'auto' };

/** Point the origin at GitLab so the gitlab branch is exercised. */
function useGitlabOrigin() {
  getOriginInfo.mockResolvedValue({ isGithub: false, host: 'gitlab.com', fullName: 'group/proj' });
  readOriginRemoteUrl.mockResolvedValue('git@gitlab.com:group/proj.git');
}

beforeEach(() => {
  vi.clearAllMocks();
  ensureForgeReachableMock.mockResolvedValue({ ok: true, status: 'ok', detail: null, remedy: null });
  getOriginInfo.mockResolvedValue({ isGithub: true, host: 'github.com', fullName: 'acme/widget' });
  readOriginRemoteUrl.mockResolvedValue('git@github.com:acme/widget.git');
  execGh.mockResolvedValue('[]');
  execGlabJson.mockResolvedValue({ rows: [], reason: 'ok' });
});

describe('listAppIssues — GitHub', () => {
  it('normalizes a gh row into the common issue shape, with a #-prefixed label color', async () => {
    execGh.mockResolvedValue(JSON.stringify([{
      number: 42,
      title: 'Crash on save',
      body: 'Steps to reproduce…',
      url: 'https://github.com/acme/widget/issues/42',
      labels: [{ name: 'bug', color: 'd73a4a', description: 'Something is broken' }],
      assignees: [{ login: 'alice' }, { login: 'bob' }],
      author: { login: 'carol' },
      milestone: { title: 'v2' },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      comments: [{ body: 'me too' }, { body: 'on it' }],
    }]));

    const result = await listAppIssues(APP);

    expect(result.forge).toBe('github');
    expect(result.fullName).toBe('acme/widget');
    expect(result.reason).toBe('ok');
    expect(result.transient).toBe(false);
    expect(result.issues).toEqual([{
      number: 42,
      title: 'Crash on save',
      body: 'Steps to reproduce…',
      url: 'https://github.com/acme/widget/issues/42',
      labels: [{ name: 'bug', color: '#d73a4a', description: 'Something is broken' }],
      assignees: ['alice', 'bob'],
      author: 'carol',
      milestone: 'v2',
      updatedAt: '2026-01-02T00:00:00Z',
      commentCount: 2,
    }]);
  });

  it('does not re-read the origin remote inside the forge resolver', async () => {
    await listAppIssues(APP);
    // `getOriginInfo` already carries the URL, so `resolveRepoForgeTarget` must
    // not spawn a second `git remote get-url`. The one call here is the
    // independent work-tracker probe.
    expect(getOriginInfo).toHaveBeenCalledTimes(1);
    expect(readOriginRemoteUrl).toHaveBeenCalledTimes(1);
  });

  it('targets the host-qualified repo selector and asks only for OPEN issues', async () => {
    await listAppIssues(APP);
    const argv = execGh.mock.calls[0][0];
    expect(argv).toContain('--repo');
    expect(argv[argv.indexOf('--repo') + 1]).toBe('github.com/acme/widget');
    expect(argv[argv.indexOf('--state') + 1]).toBe('open');
  });

  it('asks gh for comments and ships only the count — gh has no scalar count field', async () => {
    execGh.mockResolvedValue(JSON.stringify([
      { number: 1, title: 'discussed', labels: [], assignees: [], comments: [{ body: 'a novel-length reply' }] },
      { number: 2, title: 'quiet', labels: [], assignees: [], comments: [] },
      { number: 3, title: 'field absent', labels: [], assignees: [] },
    ]));
    const result = await listAppIssues(APP);
    const argv = execGh.mock.calls[0][0];
    expect(argv[argv.indexOf('--json') + 1].split(',')).toContain('comments');
    expect(result.issues.map(i => i.commentCount)).toEqual([1, 0, 0]);
    // The bodies stay on the server — the tab renders a number, not a thread.
    expect(result.issues[0].comments).toBeUndefined();
  });

  it('an ANSWERED empty list is a definitive "no open issues", not a transient', async () => {
    execGh.mockResolvedValue('[]');
    const result = await listAppIssues(APP);
    expect(result.reason).toBe('no-open-issues');
    expect(result.transient).toBe(false);
  });

  it('an unreachable gh is transient — never collapsed into "no open issues"', async () => {
    ensureForgeReachableMock.mockResolvedValue({ ok: false, status: 'unauthenticated', detail: 'x', remedy: 'run gh auth login' });
    const result = await listAppIssues(APP);
    expect(result.transient).toBe(true);
    expect(result.reason).toBe('gh-unauthenticated');
    expect(result.remedy).toBe('run gh auth login');
    expect(result.issues).toEqual([]);
    // The probe short-circuits — no point spending a list call on a dead CLI.
    expect(execGh).not.toHaveBeenCalled();
  });

  it('a failed / unparseable gh list is transient', async () => {
    execGh.mockRejectedValue(new Error('bad file descriptor'));
    const failed = await listAppIssues(APP);
    expect(failed).toMatchObject({ reason: 'fetch-failed', transient: true, issues: [] });

    execGh.mockResolvedValue('not json');
    const unparseable = await listAppIssues(APP);
    expect(unparseable).toMatchObject({ reason: 'fetch-failed', transient: true });
  });

  it('truncates a novel-length body instead of shipping it whole', async () => {
    execGh.mockResolvedValue(JSON.stringify([{ number: 1, title: 't', body: 'x'.repeat(9000), labels: [], assignees: [] }]));
    const result = await listAppIssues(APP);
    expect(result.issues[0].body.length).toBeLessThan(9000);
    expect(result.issues[0].body).toMatch(/truncated/);
  });
});

describe('listAppIssues — GitLab', () => {
  it('normalizes iid / description / string labels / username assignees', async () => {
    useGitlabOrigin();
    execGlabJson.mockResolvedValue({ reason: 'ok', rows: [{
      iid: 7,
      title: 'Add export',
      description: 'We need CSV',
      web_url: 'https://gitlab.com/group/proj/-/issues/7',
      state: 'opened',
      labels: ['feature', 'p2'],
      assignees: [{ username: 'dana' }],
      author: { username: 'erin' },
      milestone: { title: 'Sprint 3' },
      created_at: '2026-02-01T00:00:00Z',
      updated_at: '2026-02-02T00:00:00Z',
      user_notes_count: 4,
    }] });

    const result = await listAppIssues(APP);

    expect(result.forge).toBe('gitlab');
    expect(result.issues[0]).toMatchObject({
      number: 7,
      title: 'Add export',
      body: 'We need CSV',
      assignees: ['dana'],
      author: 'erin',
      milestone: 'Sprint 3',
      commentCount: 4,
    });
    expect(result.issues[0].labels).toEqual([
      { name: 'feature', color: null, description: '' },
      { name: 'p2', color: null, description: '' },
    ]);
    // glab resolves the project from its cwd, so the repo path is load-bearing.
    expect(execGlabJson.mock.calls[0][1]).toBe('/repo');
    // execGlabJson owns the output flag (lib/glabArgs.js); callers pass none.
    expect(execGlabJson.mock.calls[0][0]).toEqual(['issue', 'list', '--per-page', '100']);
  });

  it('an older glab that omits user_notes_count reports 0 comments, never NaN', async () => {
    useGitlabOrigin();
    execGlabJson.mockResolvedValue({ reason: 'ok', rows: [{ iid: 8, title: 'no count field', labels: [], assignees: [] }] });
    const result = await listAppIssues(APP);
    expect(result.issues[0].commentCount).toBe(0);
  });

  it('a failed glab call (CLI missing / unauthenticated / timed out) is transient', async () => {
    useGitlabOrigin();
    execGlabJson.mockResolvedValue({ rows: null, reason: 'cli-failed' });
    const result = await listAppIssues(APP);
    expect(result).toMatchObject({ forge: 'gitlab', reason: 'fetch-failed', transient: true });
    // Every transient answer carries its own sentence — the client has no
    // fallback advice to guess with.
    expect(result.headline).toMatch(/Couldn't reach GitLab/);
    expect(result.remedy).toMatch(/glab auth status/);
  });

  it('a glab that ANSWERED with non-JSON gets its own headline + remedy, not the re-auth advice', async () => {
    useGitlabOrigin();
    execGlabJson.mockResolvedValue({ rows: null, reason: 'not-json' });
    const result = await listAppIssues(APP);
    expect(result).toMatchObject({ forge: 'gitlab', reason: 'glab-output-not-json', transient: true });
    // The sentence ships WITH the reason so the client never re-derives it.
    expect(result.headline).toMatch(/Reached GitLab/);
    expect(result.remedy).toMatch(/update `glab`/);
  });

  it('an ANSWERED empty list is the definitive no-open-issues, not a failed read', async () => {
    useGitlabOrigin();
    execGlabJson.mockResolvedValue({ rows: [], reason: 'ok' });
    const result = await listAppIssues(APP);
    expect(result).toMatchObject({ forge: 'gitlab', reason: 'no-open-issues', transient: false, issues: [] });
  });
});

describe('listAppIssues — non-forge apps', () => {
  it('reports no-repo-path without touching any CLI', async () => {
    const result = await listAppIssues({ id: 'app-2', name: 'No Repo' });
    expect(result).toMatchObject({ forge: null, reason: 'no-repo-path', transient: false, issues: [] });
    expect(execGh).not.toHaveBeenCalled();
    expect(execGlabJson).not.toHaveBeenCalled();
  });

  it('an unrecognized origin falls back to PLAN.md, which has no forge issue list', async () => {
    getOriginInfo.mockResolvedValue({ isGithub: false, host: 'bitbucket.org', fullName: 'acme/widget' });
    readOriginRemoteUrl.mockResolvedValue('git@bitbucket.org:acme/widget.git');
    const result = await listAppIssues(APP);
    expect(result).toMatchObject({ forge: null, tracker: 'plan', reason: 'tracker-not-a-forge', transient: false });
  });

  it('reports unsupported-forge when a forge tracker is pinned but the origin has no owner/repo to build a spec from', async () => {
    getOriginInfo.mockResolvedValue({ isGithub: false, host: null, fullName: null });
    readOriginRemoteUrl.mockResolvedValue(null);
    const result = await listAppIssues({ ...APP, workTracker: 'github' });
    expect(result).toMatchObject({ forge: null, tracker: 'github', reason: 'unsupported-forge', transient: false });
    expect(execGh).not.toHaveBeenCalled();
  });

  it('attempts the pinned forge on a non-matching-hostname origin instead of refusing outright, since a self-hosted forge can live on any domain', async () => {
    // `bitbucket.org` matches neither the github.* nor gitlab.* hostname
    // pattern — same as a real self-hosted GHE/GitLab instance on a custom
    // domain would. The hostname alone can't tell them apart, so an explicit
    // pin is trusted and the CLI is actually asked, rather than PortOS
    // pre-emptively claiming "isn't GitHub or GitLab".
    getOriginInfo.mockResolvedValue({ isGithub: false, host: 'bitbucket.org', fullName: 'acme/widget' });
    readOriginRemoteUrl.mockResolvedValue('git@bitbucket.org:acme/widget.git');
    execGh.mockResolvedValue(JSON.stringify([{ number: 1, title: 't', labels: [], assignees: [] }]));
    const result = await listAppIssues({ ...APP, workTracker: 'github' });
    expect(result).toMatchObject({ forge: 'github', tracker: 'github', reason: 'ok' });
    expect(execGh.mock.calls[0][0][execGh.mock.calls[0][0].indexOf('--repo') + 1]).toBe('bitbucket.org/acme/widget');
  });

  it('lists issues for a github tracker explicitly pinned on a custom-hostname enterprise origin', async () => {
    getOriginInfo.mockResolvedValue({ isGithub: false, host: 'git.example-corp.com', fullName: 'acme/widget' });
    readOriginRemoteUrl.mockResolvedValue('git@git.example-corp.com:acme/widget.git');
    execGh.mockResolvedValue(JSON.stringify([{ number: 9, title: 'Custom host works', labels: [], assignees: [] }]));
    const result = await listAppIssues({ ...APP, workTracker: 'github' });
    expect(result).toMatchObject({ forge: 'github', tracker: 'github', fullName: 'acme/widget', reason: 'ok' });
    expect(ensureForgeReachableMock).toHaveBeenCalledWith('app-issues', { hostname: 'git.example-corp.com' });
  });

  it('lists issues for a gitlab tracker explicitly pinned on a custom-hostname self-hosted origin', async () => {
    getOriginInfo.mockResolvedValue({ isGithub: false, host: 'git.example-corp.com', fullName: 'acme/widget' });
    readOriginRemoteUrl.mockResolvedValue('git@git.example-corp.com:acme/widget.git');
    execGlabJson.mockResolvedValue({ reason: 'ok', rows: [{ iid: 3, title: 'Custom host works', labels: [], assignees: [] }] });
    const result = await listAppIssues({ ...APP, workTracker: 'gitlab' });
    expect(result).toMatchObject({ forge: 'gitlab', tracker: 'gitlab', reason: 'ok' });
    expect(execGlabJson.mock.calls[0][1]).toBe('/repo');
  });
});

// The tab's whole promise is "the Claim button claims the issue you are looking
// at". `buildClaimWorkTask` routes on the app's RESOLVED work tracker, so listing
// anything the resolved tracker doesn't own would offer a claim that runs against
// a different tracker entirely.
describe('listAppIssues — the list must match the tracker a claim would use', () => {
  it('lists nothing for a JIRA-tracked app even when the origin is GitHub', async () => {
    const result = await listAppIssues({ ...APP, workTracker: 'jira' });
    expect(result).toMatchObject({ forge: null, tracker: 'jira', reason: 'tracker-not-a-forge', issues: [] });
    // Otherwise the Claim button would queue claim-issue-jira against ticket "42".
    expect(execGh).not.toHaveBeenCalled();
  });

  it('lists nothing for a PLAN.md-tracked app even when the origin is GitHub', async () => {
    const result = await listAppIssues({ ...APP, workTracker: 'plan' });
    expect(result).toMatchObject({ forge: null, tracker: 'plan', reason: 'tracker-not-a-forge' });
    expect(execGh).not.toHaveBeenCalled();
  });

  it('refuses to list the OTHER forge when the tracker is pinned across remotes', async () => {
    // Pinned to GitLab, but the remote is GitHub: neither answer is honest, so
    // list neither rather than showing issues a claim would never touch.
    const result = await listAppIssues({ ...APP, workTracker: 'gitlab' });
    expect(result).toMatchObject({ forge: null, tracker: 'gitlab', reason: 'tracker-forge-mismatch' });
    expect(execGh).not.toHaveBeenCalled();
    expect(execGlabJson).not.toHaveBeenCalled();
  });

  it('honors an explicit github pin on a GitHub remote', async () => {
    execGh.mockResolvedValue(JSON.stringify([{ number: 1, title: 't', labels: [], assignees: [] }]));
    const result = await listAppIssues({ ...APP, workTracker: 'github' });
    expect(result).toMatchObject({ forge: 'github', tracker: 'github', reason: 'ok' });
  });
});
