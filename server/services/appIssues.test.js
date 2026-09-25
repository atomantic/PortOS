import { describe, it, expect, vi, beforeEach } from 'vitest';

const ensureForgeReachableMock = vi.fn(async () => ({ ok: true, status: 'ok', detail: null, remedy: null }));
const resolveForgeForRepoMock = vi.fn(async () => ({ cli: 'gh', env: process.env, account: null }));
vi.mock('./github.js', () => ({
  execGh: vi.fn(async () => '[]'),
  ensureForgeReachable: (...args) => ensureForgeReachableMock(...args),
}));
vi.mock('./forgeAuth.js', () => ({
  resolveForgeForRepo: (...args) => resolveForgeForRepoMock(...args),
}));
vi.mock('./gitlab.js', () => ({ execGlab: vi.fn(), execGlabJson: vi.fn(async () => ({ rows: [], reason: 'ok' })) }));
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

import { homedir } from 'os';
import { fileForgeIssue, listAppIssues, prepareAppIssueClaim, probeForgeReachability, scrubForgeIssueText } from './appIssues.js';
import { execGh } from './github.js';
import { execGlab, execGlabJson } from './gitlab.js';
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
  resolveForgeForRepoMock.mockResolvedValue({ cli: 'gh', env: process.env, account: null });
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

  it('passes the app-pinned forge account token and repo cwd to gh and reachability check', async () => {
    resolveForgeForRepoMock.mockResolvedValue({
      cli: 'gh',
      env: { ...process.env, GH_TOKEN: 'other-user-token' },
      account: 'other-user',
    });
    execGh.mockResolvedValue('[]');
    await listAppIssues({ ...APP, forgeAccount: 'other-user' });

    expect(resolveForgeForRepoMock).toHaveBeenCalledWith('/repo', { forgeAccount: 'other-user' });
    expect(ensureForgeReachableMock).toHaveBeenCalledWith('app-issues', {
      hostname: 'github.com',
      env: expect.objectContaining({ GH_TOKEN: 'other-user-token' }),
    });
    expect(execGh).toHaveBeenCalledWith(
      expect.arrayContaining(['issue', 'list', '--repo', 'github.com/acme/widget']),
      undefined,
      expect.objectContaining({
        cwd: '/repo',
        env: expect.objectContaining({ GH_TOKEN: 'other-user-token' }),
      }),
    );
  });
});

describe('listAppIssues — GitLab', () => {
  it('normalizes iid / description / string labels / username assignees, joined to label-list colors', async () => {
    useGitlabOrigin();
    execGlabJson.mockImplementation(async (args) => {
      if (args[0] === 'label') {
        return { reason: 'ok', rows: [
          { name: 'feature', color: '#5843AD', description: 'New functionality' },
          { name: 'p2', color: 'D4C5F9', description: '' },
        ] };
      }
      return { reason: 'ok', rows: [{
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
      }] };
    });

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
      { name: 'feature', color: '#5843AD', description: 'New functionality' },
      // Bare-hex label colors get the same `#` prefixing the GitHub path applies.
      { name: 'p2', color: '#D4C5F9', description: '' },
    ]);
    // glab resolves the project from its cwd, so the repo path is load-bearing
    // on BOTH calls — issue list and label list alike.
    expect(execGlabJson.mock.calls[0][1]).toBe('/repo');
    // execGlabJson owns the output flag (lib/glabArgs.js); callers pass none.
    expect(execGlabJson.mock.calls[0][0]).toEqual(['issue', 'list', '--per-page', '100']);
    expect(execGlabJson.mock.calls[1][0]).toEqual(['label', 'list', '--per-page', '100']);
    expect(execGlabJson.mock.calls[1][1]).toBe('/repo');
  });

  it('a label absent from label list still renders neutral; the issue list is unaffected', async () => {
    useGitlabOrigin();
    execGlabJson.mockImplementation(async (args) => {
      if (args[0] === 'label') return { reason: 'ok', rows: [{ name: 'feature', color: '#5843AD', description: '' }] };
      return { reason: 'ok', rows: [{ iid: 7, title: 'Add export', labels: ['feature', 'unlisted'], assignees: [] }] };
    });
    const result = await listAppIssues(APP);
    expect(result).toMatchObject({ reason: 'ok', transient: false });
    expect(result.issues[0].labels).toEqual([
      { name: 'feature', color: '#5843AD', description: '' },
      { name: 'unlisted', color: null, description: '' },
    ]);
  });

  it('a failed label list is non-fatal — issues still return with neutral labels', async () => {
    useGitlabOrigin();
    execGlabJson.mockImplementation(async (args) => {
      if (args[0] === 'label') return { rows: null, reason: 'cli-failed' };
      return { reason: 'ok', rows: [{ iid: 7, title: 'Add export', labels: ['feature'], assignees: [] }] };
    });
    const result = await listAppIssues(APP);
    expect(result).toMatchObject({ reason: 'ok', transient: false });
    expect(result.issues[0].labels).toEqual([{ name: 'feature', color: null, description: '' }]);
  });

  it('a non-JSON label list is non-fatal — issues still return with neutral labels', async () => {
    useGitlabOrigin();
    execGlabJson.mockImplementation(async (args) => {
      if (args[0] === 'label') return { rows: null, reason: 'not-json' };
      return { reason: 'ok', rows: [{ iid: 7, title: 'Add export', labels: ['feature'], assignees: [] }] };
    });
    const result = await listAppIssues(APP);
    expect(result).toMatchObject({ reason: 'ok', transient: false });
    expect(result.issues[0].labels).toEqual([{ name: 'feature', color: null, description: '' }]);
  });

  it('tolerates the object label form, normalizing its color the same way', async () => {
    useGitlabOrigin();
    execGlabJson.mockImplementation(async (args) => {
      if (args[0] === 'label') return { reason: 'ok', rows: [] };
      return { reason: 'ok', rows: [{ iid: 7, title: 'Add export', labels: [{ name: 'bug', color: 'd73a4a', description: 'x' }], assignees: [] }] };
    });
    const result = await listAppIssues(APP);
    expect(result.issues[0].labels).toEqual([{ name: 'bug', color: '#d73a4a', description: 'x' }]);
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
    execGlabJson.mockImplementation(async (args) => {
      if (args[0] === 'label') return { reason: 'ok', rows: [{ name: 'bug', color: '#d73a4a', description: '' }] };
      return { reason: 'ok', rows: [{ iid: 3, title: 'Custom host works', labels: ['bug'], assignees: [] }] };
    });
    const result = await listAppIssues({ ...APP, workTracker: 'gitlab' });
    expect(result).toMatchObject({ forge: 'gitlab', tracker: 'gitlab', reason: 'ok' });
    expect(execGlabJson.mock.calls[0][1]).toBe('/repo');
    // The color enrichment runs in the same cwd with no hostname gate, so a
    // self-hosted repo gets forge colors through the identical path.
    expect(execGlabJson.mock.calls[1][0]).toEqual(['label', 'list', '--per-page', '100']);
    expect(execGlabJson.mock.calls[1][1]).toBe('/repo');
    expect(result.issues[0].labels).toEqual([{ name: 'bug', color: '#d73a4a', description: '' }]);
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

describe('prepareAppIssueClaim', () => {
  it('removes only invitations present on GitHub and verifies the result', async () => {
    execGh.mockResolvedValueOnce(JSON.stringify({ labels: [{ name: 'Help Wanted' }, { name: 'good first issue' }, { name: 'bug' }] }))
      .mockResolvedValueOnce('').mockResolvedValueOnce(JSON.stringify({ labels: [{ name: 'bug' }] }));
    await prepareAppIssueClaim(APP, '42', 'github');
    expect(execGh.mock.calls.map(([args]) => args)).toEqual([
      ['issue', 'view', '42', '--repo', 'github.com/acme/widget', '--json', 'labels'],
      ['issue', 'edit', '42', '--repo', 'github.com/acme/widget', '--remove-label', 'Help Wanted', '--remove-label', 'good first issue'],
      ['issue', 'view', '42', '--repo', 'github.com/acme/widget', '--json', 'labels'],
    ]);
  });

  it('does not mutate an issue without contributor labels', async () => {
    execGh.mockResolvedValue(JSON.stringify({ labels: [] }));
    await prepareAppIssueClaim(APP, '42', 'github');
    expect(execGh).toHaveBeenCalledTimes(1);
  });

  it('uses GitLab and preserves unrelated labels', async () => {
    useGitlabOrigin();
    execGlab.mockResolvedValueOnce(JSON.stringify({ labels: ['help wanted', 'bug'] }))
      .mockResolvedValueOnce('').mockResolvedValueOnce(JSON.stringify({ labels: ['bug'] }));
    await prepareAppIssueClaim(APP, '42', 'gitlab');
    expect(execGlab).toHaveBeenNthCalledWith(2, ['issue', 'update', '42', '--unlabel', 'help wanted'], '/repo', undefined, { rejectOnError: true });
    expect(execGh).not.toHaveBeenCalled();
  });

  it('rejects unreadable labels, failed edits, and labels that remain after an edit', async () => {
    execGh.mockResolvedValueOnce('{}');
    await expect(prepareAppIssueClaim(APP, '42', 'github')).rejects.toThrow('Could not read issue labels');
    execGh.mockResolvedValueOnce('{"labels":["help wanted"]}').mockRejectedValueOnce(new Error('offline'));
    await expect(prepareAppIssueClaim(APP, '42', 'github')).rejects.toThrow('offline');
    execGh.mockResolvedValue('{"labels":["help wanted"]}');
    await expect(prepareAppIssueClaim(APP, '42', 'github')).rejects.toThrow('Contributor labels remain');
  });

  it('passes cwd and repo forge auth env when claiming on GitHub', async () => {
    resolveForgeForRepoMock.mockResolvedValue({
      cli: 'gh',
      env: { ...process.env, GH_TOKEN: 'other-user-token' },
      account: 'other-user',
    });
    execGh.mockResolvedValueOnce(JSON.stringify({ labels: [{ name: 'Help Wanted' }] }))
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(JSON.stringify({ labels: [] }));

    await prepareAppIssueClaim({ ...APP, forgeAccount: 'other-user' }, '42', 'github');

    expect(resolveForgeForRepoMock).toHaveBeenCalledWith('/repo', { forgeAccount: 'other-user' });
    expect(execGh).toHaveBeenCalledWith(
      ['issue', 'view', '42', '--repo', 'github.com/acme/widget', '--json', 'labels'],
      undefined,
      expect.objectContaining({
        cwd: '/repo',
        env: expect.objectContaining({ GH_TOKEN: 'other-user-token' }),
      }),
    );
  });
});

// #7687 — the exec half every forge filer needs: probe, create labels, create
// the issue, and scrub the title/body by construction so no caller can forget.
describe('fileForgeIssue', () => {
  const LABELS = [{ name: 'plan', color: '0E8A16', description: 'Claimable backlog item' }];

  it('creates every label before the issue, then returns its parsed number/url', async () => {
    execGh.mockResolvedValueOnce('').mockResolvedValueOnce('https://github.com/acme/widget/issues/9\n');
    const result = await fileForgeIssue({ cli: 'gh', repo: 'github.com/acme/widget', title: 'T', body: 'B', labels: LABELS });

    expect(result).toEqual({ ok: true, number: 9, url: 'https://github.com/acme/widget/issues/9' });
    expect(execGh.mock.calls[0][0]).toEqual(['label', 'create', 'plan', '--repo', 'github.com/acme/widget', '--color', '0E8A16', '--description', 'Claimable backlog item']);
    expect(execGh.mock.calls[1][0]).toEqual(['issue', 'create', '--repo', 'github.com/acme/widget', '--title', 'T', '--body', 'B', '--label', 'plan']);
  });

  it('tolerates a label that already exists', async () => {
    execGh.mockRejectedValueOnce(new Error('label with this name already exists'))
      .mockResolvedValueOnce('https://github.com/acme/widget/issues/9');
    const result = await fileForgeIssue({ cli: 'gh', title: 'T', body: 'B', labels: LABELS });
    expect(result.ok).toBe(true);
  });

  it('aborts on a real label-create failure without attempting the issue create', async () => {
    execGh.mockRejectedValueOnce(new Error('HTTP 403: Resource not accessible'));
    const result = await fileForgeIssue({ cli: 'gh', title: 'T', body: 'B', labels: LABELS });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('HTTP 403') });
    expect(execGh).toHaveBeenCalledTimes(1);
  });

  it('reports a bounded error on a failed create rather than claiming success', async () => {
    execGh.mockResolvedValueOnce('').mockRejectedValueOnce(new Error('GraphQL: Resource not accessible'));
    const result = await fileForgeIssue({ cli: 'gh', title: 'T', body: 'B', labels: LABELS });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('Resource not accessible') });
  });

  it('probes reachability first when a hostname is given, before any label or issue call', async () => {
    ensureForgeReachableMock.mockResolvedValue({ ok: false, status: 'unauthenticated', remedy: 'run `gh auth login`' });
    const result = await fileForgeIssue({ cli: 'gh', hostname: 'github.com', title: 'T', body: 'B', labels: LABELS });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('gh auth login') });
    expect(execGh).not.toHaveBeenCalled();
  });

  it('skips the probe with no hostname — a caller that already probed', async () => {
    ensureForgeReachableMock.mockResolvedValue({ ok: false, status: 'unauthenticated' });
    execGh.mockResolvedValueOnce('').mockResolvedValueOnce('https://github.com/acme/widget/issues/1');
    const result = await fileForgeIssue({ cli: 'gh', title: 'T', body: 'B', labels: LABELS });
    expect(result.ok).toBe(true);
    expect(ensureForgeReachableMock).not.toHaveBeenCalled();
  });

  it('never probes a glab filer — ensureForgeReachable is gh-only', async () => {
    execGlab.mockResolvedValueOnce('').mockResolvedValueOnce('https://gitlab.com/group/proj/-/issues/1');
    const result = await fileForgeIssue({ cli: 'glab', hostname: 'gitlab.com', repoPath: '/repo', title: 'T', body: 'B', labels: LABELS });
    expect(result.ok).toBe(true);
    expect(ensureForgeReachableMock).not.toHaveBeenCalled();
  });

  it('creates through glab in the given repo checkout, joining labels with a comma', async () => {
    execGlab.mockResolvedValueOnce('').mockResolvedValueOnce('https://gitlab.com/group/proj/-/issues/4');
    await fileForgeIssue({ cli: 'glab', repoPath: '/repo', title: 'T', body: 'B', labels: LABELS });
    expect(execGlab).toHaveBeenNthCalledWith(2, ['issue', 'create', '--title', 'T', '--description', 'B', '--label', 'plan'], '/repo', undefined, { env: undefined, rejectOnError: true });
  });

  // #7687 — a filer that never called its own scrub (the Layered Intelligence
  // loop's `fileProposalToForge`) is protected the same as one that did, since
  // the strip is enforced here rather than trusted to each caller's memory.
  it('strips the home-directory prefix and credential-shaped tokens from the title and body', async () => {
    const home = homedir();
    execGh.mockResolvedValueOnce('').mockResolvedValueOnce('https://github.com/acme/widget/issues/1');
    await fileForgeIssue({
      cli: 'gh', labels: LABELS,
      title: `Sync fails under ${home}/work/demo`,
      body: `Retries with ghp_${'A'.repeat(36)} and dies.\nSee ${home}/logs/sync.log.`,
    });
    const createArgs = execGh.mock.calls[1][0];
    const title = createArgs[createArgs.indexOf('--title') + 1];
    const body = createArgs[createArgs.indexOf('--body') + 1];
    expect(title).toBe('Sync fails under ~/work/demo');
    expect(title).not.toContain(home);
    expect(body).toContain('[REDACTED]');
    expect(body).not.toContain('ghp_');
    expect(body).not.toContain(home);
  });

  // #8460 — the machine-identity/PII redactor rides the same choke point, so
  // an email, IP, tailnet host or phone number a model copied from the user's
  // records never reaches a (often public) tracker, whichever filer called.
  it('redacts emails, IPs, tailnet hosts and phone numbers from the title and body', async () => {
    const leaks = ['alice@example.com', '192.0.2.10', 'host-1.example.ts.net', '+1 555 010 0000'];
    execGh.mockResolvedValueOnce('').mockResolvedValueOnce('https://github.com/acme/widget/issues/1');
    await fileForgeIssue({
      cli: 'gh', labels: LABELS,
      title: `Invite to alice@example.com bounces`,
      body: `Peer host-1.example.ts.net at 192.0.2.10 fails; call +1 555 010 0000.`,
    });
    const argv = execGh.mock.calls[1][0].join('\n');
    for (const leak of leaks) expect(argv).not.toContain(leak);
    expect(argv).toContain('Invite to <email> bounces');
  });

  it('appends a machine-generated trailer after scrubbing, so redaction cannot rewrite it', async () => {
    execGh.mockResolvedValueOnce('').mockResolvedValueOnce('https://github.com/acme/widget/issues/1');
    const trailer = '\n\n<!-- marker: release-2026-09-25 -->';
    await fileForgeIssue({ cli: 'gh', labels: LABELS, title: 'T', body: 'Due 2026-09-25.', trailer });
    const createArgs = execGh.mock.calls[1][0];
    expect(createArgs[createArgs.indexOf('--body') + 1]).toBe(`Due <phone>.${trailer}`);
  });
});

describe('probeForgeReachability', () => {
  it('is a no-op for a non-github cli or a missing hostname', async () => {
    expect(await probeForgeReachability({ cli: 'glab', hostname: 'gitlab.com', label: 'x' })).toEqual({ ok: true });
    expect(await probeForgeReachability({ cli: 'gh', hostname: null, label: 'x' })).toEqual({ ok: true });
    expect(ensureForgeReachableMock).not.toHaveBeenCalled();
  });

  it('formats an unreachable github as a refusal naming the status and remedy', async () => {
    ensureForgeReachableMock.mockResolvedValue({ ok: false, status: 'offline', remedy: 'check the network' });
    expect(await probeForgeReachability({ cli: 'gh', hostname: 'github.com', label: 'x' }))
      .toEqual({ ok: false, error: 'GitHub is not reachable (offline); check the network' });
  });
});

describe('scrubForgeIssueText', () => {
  it('passes a non-string through untouched', () => {
    expect(scrubForgeIssueText(undefined)).toBeUndefined();
    expect(scrubForgeIssueText(null)).toBeNull();
  });

  it('leaves ordinary prose and repo-relative paths untouched', () => {
    const body = 'server/services/sync.js drops job 4f2a on retry.';
    expect(scrubForgeIssueText(body)).toBe(body);
  });
});
