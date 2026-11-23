import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearLaneHealthCache, collectLaneHealth, getAppLaneHealth } from './appLaneHealth.js';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const DAY = 86_400_000;
const APP = { id: 'app-1', name: 'Example App', repoPath: '/repo' };
const GH = { cli: 'gh', env: { PATH: '/bin' }, host: 'github.com' };
const GLAB = { cli: 'glab', env: {}, host: 'gitlab.example.com' };
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();

// One fake per spawn: the forge CLI answers by subcommand, git by its log call.
const forgeExec = ({ issues = [], pullRequests = [] } = {}) => vi.fn(async (_cli, args) => {
  if ((args[0] === 'pr' || args[0] === 'mr') && args[1] === 'view') {
    const found = pullRequests instanceof Array ? pullRequests.find((pr) => String(pr.number ?? pr.iid) === args[2]) : null;
    return found ? { code: 0, stdout: JSON.stringify(found) } : { code: 1, stdout: '', stderr: 'Could not resolve to a PullRequest' };
  }
  const rows = args[0] === 'issue' ? issues : pullRequests;
  return rows instanceof Error ? { code: -1, stdout: '', stderr: rows.message } : { code: 0, stdout: JSON.stringify(rows) };
});
const gitLog = (records) => vi.fn(async () => ({ exitCode: 0, stdout: records.map(({ sha, subject, body = '' }) => `${sha}\x1f${subject}\x1f${body}\x1e\n`).join('') }));

describe('appLaneHealth', () => {
  beforeEach(() => { clearLaneHealthCache(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('reads one GitHub lane through gh and git, linking PRs either way and matching a rebase-merged revert', async () => {
    const exec = forgeExec({
      issues: [
        { number: 5, title: 'Hotspot', labels: [{ name: 'code-quality' }, { name: 'complexity' }], createdAt: iso(10), closedAt: iso(9), state: 'CLOSED', stateReason: 'COMPLETED', body: 'server/a.js:1', url: 'https://example.com/5', closedByPullRequestsReferences: [{ number: 50 }] },
        { number: 6, title: 'Linked from the PR side', labels: ['complexity'], createdAt: iso(8), closedAt: iso(7), state: 'CLOSED', stateReason: 'COMPLETED', body: '', closedByPullRequestsReferences: [] },
        { number: 4, title: 'Older than the re-file lookback', labels: ['complexity'], createdAt: iso(200), state: 'CLOSED' },
      ],
      pullRequests: [
        { number: 50, mergeCommit: null, commits: [{ oid: 'def1234567890', authors: [{ email: 'alice@example.com' }] }], closingIssuesReferences: [], body: '' },
        { number: 51, mergeCommit: { oid: 'abc9876543210' }, commits: [], closingIssuesReferences: [], body: 'Fixes #6' },
      ],
    });
    const runGit = gitLog([
      { sha: 'aaaa111', subject: 'Revert "fix: hotspot"', body: 'This reverts commit def1234567890.' },
      { sha: 'bbbb222', subject: 'Revert "fix: path (#51)"' },
    ]);
    const result = await collectLaneHealth(APP, { forge: GH, taskType: 'better-complexity', now: NOW, deps: { exec, runGit } });

    expect(exec).toHaveBeenCalledWith('gh', [
      'issue', 'list', '--state', 'all', '--limit', '500', '--search', 'created:>=2026-07-19 sort:created-desc', '--label', 'complexity',
      '--json', 'number,title,labels,createdAt,closedAt,state,stateReason,body,url,closedByPullRequestsReferences',
    ], { cwd: '/repo', env: GH.env });
    // Only the PRs the revert commits name are read: #51 by number, PR 50 by the SHA its revert cites.
    const prCalls = exec.mock.calls.filter(([, args]) => args[0] === 'pr').map(([, args]) => args.slice(0, 5).join(' '));
    expect(prCalls).toEqual(expect.arrayContaining(['pr view 51 --json number,mergeCommit,commits,closingIssuesReferences,body', 'pr list --state merged --limit']));
    expect(exec.mock.calls.some(([, args]) => args.includes('def1234567890'))).toBe(true);
    expect(prCalls.some((call) => call.includes('merged:>='))).toBe(false);
    expect(runGit).toHaveBeenCalledWith(['log', '--since=2026-08-18T12:00:00.000Z', '-i', '--grep=^revert', '--format=%H%x1f%s%x1f%b%x1e', 'HEAD'], '/repo', expect.objectContaining({ ignoreExitCode: true }));
    expect(result).toMatchObject({ ok: true, truncated: false, partial: [], windowDays: 60, refileDays: 30 });
    expect(result.lanes).toHaveLength(1);
    expect(result.lanes[0]).toMatchObject({ id: 'better-complexity', filed: 2, completed: 2, reverted: 2 });
    expect(result.lanes[0].flagged.map(({ number, reasons }) => [number, reasons])).toEqual([
      [6, [{ kind: 'reverted', pullRequest: 51, commit: 'bbbb222' }]],
      [5, [{ kind: 'reverted', pullRequest: 50, commit: 'aaaa111' }]],
    ]);
    // The commit payload's author identities never leave the adapter.
    expect(JSON.stringify(result)).not.toContain('alice');
  });

  it('reads every lane through glab, treating closed GitLab issues as completed and closing keywords as links', async () => {
    const exec = forgeExec({
      issues: [
        { iid: 7, title: 'Drift', labels: ['simplify'], created_at: iso(10), closed_at: iso(9), state: 'closed', description: 'lib/x.js:3', web_url: 'https://gitlab.example.com/7' },
        { iid: 8, title: 'Open', labels: ['complexity'], created_at: iso(5), state: 'opened', description: '' },
      ],
      pullRequests: [{ iid: 70, merge_commit_sha: 'abc1234567', sha: 'def1234567', description: 'Closes #7' }],
    });
    const runGit = gitLog([{ sha: 'cccc333', subject: 'Revert "drift" (#70)', body: 'This reverts commit abc1234567.' }]);
    const result = await collectLaneHealth(APP, { forge: GLAB, now: NOW, deps: { exec, runGit } });
    expect(exec).toHaveBeenCalledWith('glab', ['issue', 'list', '--all', '-P', '1000'], expect.any(Object));
    expect(exec).toHaveBeenCalledWith('glab', ['mr', 'view', '70', '--output', 'json'], expect.any(Object));
    expect(exec).not.toHaveBeenCalledWith('glab', expect.arrayContaining(['list', '--merged']), expect.anything());
    expect(result.lanes.length).toBeGreaterThan(20);
    expect(result.lanes.find(({ id }) => id === 'simplify')).toMatchObject({ filed: 1, completed: 1, reverted: 1 });
    expect(result.lanes.find(({ id }) => id === 'better-complexity')).toMatchObject({ filed: 1, open: 1 });
    const grouped = await collectLaneHealth(APP, { forge: GLAB, taskType: 'code-simplification', now: NOW, deps: { exec, runGit } });
    expect(grouped.lanes).toEqual([expect.objectContaining({ id: 'code-simplification', filed: 2, open: 1, reverted: 1 })]);
    expect(exec.mock.calls.filter(([, args]) => args[0] === 'issue').at(-1)[1]).toEqual(['issue', 'list', '--all', '-P', '1000']);
  });

  it('shortens a truncated window and names a failed commit read instead of reading them as no reverts', async () => {
    const issues = [
      { number: 9, title: 'Newest', labels: ['complexity'], createdAt: iso(3), state: 'OPEN' },
      { number: 8, title: 'Oldest seen', labels: ['complexity'], createdAt: iso(20), state: 'OPEN' },
    ];
    const exec = forgeExec({ issues, pullRequests: new Error('gh: HTTP 500') });
    const result = await collectLaneHealth(APP, { forge: GH, taskType: 'better-complexity', now: NOW, deps: { exec, runGit: vi.fn().mockResolvedValue({ exitCode: 128, stdout: '' }) } });
    expect(result).toMatchObject({ ok: true, truncated: false, partial: ['commits'] });

    clearLaneHealthCache();
    const full = Array.from({ length: 500 }, (_, index) => ({ ...issues[0], number: 1000 + index, createdAt: iso(3 + index / 100) }));
    const truncated = await collectLaneHealth(APP, { forge: GH, taskType: 'better-complexity', now: NOW, deps: { exec: forgeExec({ issues: full }), runGit: vi.fn().mockRejectedValue(new Error('timeout')) } });
    expect(truncated).toMatchObject({ ok: true, truncated: true, partial: ['commits'], from: iso(3 + 499 / 100) });
    expect(truncated.lanes[0].filed).toBe(500);
  });

  it('separates a failed or unusable forge from an empty one', async () => {
    const empty = await collectLaneHealth(APP, { forge: GH, taskType: 'better-complexity', now: NOW, deps: { exec: forgeExec(), runGit: gitLog([]) } });
    expect(empty.lanes[0]).toMatchObject({ filed: 0, flagged: [] });
    const blank = vi.fn().mockResolvedValue({ code: 0, stdout: '  ' });
    expect(await collectLaneHealth(APP, { forge: GH, now: NOW, deps: { exec: blank, runGit: gitLog([]) } })).toEqual({ ok: false, reason: 'issues', error: 'gh returned no parseable list' });
    const failed = forgeExec({ issues: new Error('gh: HTTP 502') });
    expect(await collectLaneHealth(APP, { forge: GH, now: NOW, deps: { exec: failed, runGit: gitLog([]) } })).toEqual({ ok: false, reason: 'issues', error: 'gh: HTTP 502' });
    expect(await collectLaneHealth(APP, { forge: null, now: NOW })).toEqual({ ok: false, reason: 'forge-unavailable' });
    expect(await collectLaneHealth(APP, { forge: GH, taskType: 'plan-feature', now: NOW })).toEqual({ ok: false, reason: 'not-an-audit-lane' });
  });

  it('resolves the forge for the page read and answers unavailable with the remedy instead of throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exec = forgeExec();
    const deps = {
      now: NOW,
      resolveTracker: vi.fn().mockResolvedValue({ forge: 'gh', host: 'github.com' }),
      resolveTokenEnv: vi.fn().mockResolvedValue({ GH_TOKEN: 'test-token' }),
      environment: { PATH: '/bin' },
      exec,
      runGit: gitLog([]),
    };
    const available = await getAppLaneHealth(APP, deps);
    expect(available).toMatchObject({ available: true, truncated: false, partial: [], windowDays: 60 });
    expect(available.ok).toBeUndefined();
    expect(exec).toHaveBeenCalledWith('gh', expect.any(Array), { cwd: '/repo', env: { PATH: '/bin', GH_TOKEN: 'test-token' } });

    deps.exec = forgeExec({ issues: new Error('To get started with GitHub CLI, please run:  gh auth login') });
    expect(await getAppLaneHealth(APP, { ...deps, refresh: true })).toMatchObject({ available: false, reason: 'issues', error: expect.stringContaining('gh auth login') });
    expect(warn).toHaveBeenCalledTimes(1);

    deps.resolveTracker.mockResolvedValueOnce({ forge: 'jira' });
    expect(await getAppLaneHealth(APP, deps)).toEqual({ available: false, reason: 'forge-unavailable' });
    warn.mockRestore();
  });
  it('skips the pull request forge read entirely when no revert commit is in the window', async () => {
    const exec = forgeExec({ issues: [{ number: 5, title: 'Hotspot', labels: ['complexity'], createdAt: iso(10), state: 'OPEN' }] });
    // The grep prefilter matches a body line; only a Revert subject counts.
    const runGit = gitLog([{ sha: 'dddd444', subject: 'feat: add thing', body: 'Revert the flag default later' }]);
    const result = await collectLaneHealth(APP, { forge: GH, taskType: 'better-complexity', now: NOW, deps: { exec, runGit } });
    expect(result).toMatchObject({ ok: true, partial: [] });
    expect(exec.mock.calls.map(([, args]) => args[0])).toEqual(['issue']);
    const unreadable = forgeExec();
    await collectLaneHealth(APP, { forge: GH, taskType: 'ux', now: NOW, deps: { exec: unreadable, runGit: vi.fn().mockResolvedValue({ exitCode: 128, stdout: '' }) } });
    expect(unreadable.mock.calls.map(([, args]) => args[0])).toEqual(['issue']);
  });

  it('detects a revert older than the newest merged PRs by resolving only the PRs it names, tolerating a #N that is an issue', async () => {
    const exec = forgeExec({
      issues: [{ number: 5, title: 'Old fix', labels: ['complexity'], createdAt: iso(55), closedAt: iso(54), state: 'CLOSED', stateReason: 'COMPLETED', closedByPullRequestsReferences: [{ number: 12 }] }],
      pullRequests: [{ number: 12, mergeCommit: { oid: 'abc9876543210' }, commits: [], closingIssuesReferences: [], body: '' }],
    });
    const runGit = gitLog([{ sha: 'eeee555', subject: 'Revert "fix (#12)"', body: 'Refs #999' }]);
    const result = await collectLaneHealth(APP, { forge: GH, taskType: 'better-complexity', now: NOW, deps: { exec, runGit } });
    expect(result.partial).toEqual([]);
    expect(result.lanes[0]).toMatchObject({ filed: 1, reverted: 1 });
    expect(exec.mock.calls.filter(([, args]) => args[0] === 'pr').map(([, args]) => args[2])).toEqual(expect.arrayContaining(['12', '999']));
  });

  it('names a failed targeted PR lookup as a partial read', async () => {
    const exec = vi.fn(async (_cli, args) => (args[0] === 'issue' ? { code: 0, stdout: '[]' } : { code: 1, stdout: '', stderr: 'gh: HTTP 502' }));
    const runGit = gitLog([{ sha: 'ffff666', subject: 'Revert "x (#3)"' }]);
    const result = await collectLaneHealth(APP, { forge: GH, taskType: 'better-complexity', now: NOW, deps: { exec, runGit } });
    expect(result).toMatchObject({ ok: true, partial: ['pull-requests'] });
  });

  it('filters a consolidated domain by its metric and member labels on GitHub, and reads glab unfiltered', async () => {
    const exec = forgeExec({
      issues: [
        { number: 1, title: 'Member finding', labels: ['typing'], createdAt: iso(5), state: 'OPEN' },
        { number: 2, title: 'Domain finding', labels: ['architecture-maintainability'], createdAt: iso(4), state: 'OPEN' },
      ],
    });
    const result = await collectLaneHealth(APP, { forge: GH, taskType: 'architecture-maintainability', now: NOW, deps: { exec, runGit: gitLog([]) } });
    const [, args] = exec.mock.calls.find(([, call]) => call[0] === 'issue');
    expect(args[args.indexOf('--limit') + 1]).toBe('500');
    expect(args).not.toContain('--label');
    expect(args[args.indexOf('--search') + 1]).toBe('created:>=2026-07-19 sort:created-desc label:"architecture-maintainability","code-quality","structural-drift","module-hygiene","typing","source:architecture-maintainability"');
    expect(result.lanes).toEqual([expect.objectContaining({ id: 'architecture-maintainability', filed: 2 })]);

    const glab = forgeExec();
    await collectLaneHealth(APP, { forge: GLAB, taskType: 'architecture-maintainability', now: NOW, deps: { exec: glab, runGit: gitLog([]) } });
    expect(glab).toHaveBeenCalledWith('glab', ['issue', 'list', '--all', '-P', '1000'], expect.any(Object));
  });

  it('serves a fresh read from cache, shares an in-flight read, honors refresh, expires after 5 minutes and never stores a failure', async () => {
    const exec = forgeExec();
    const deps = { exec, runGit: gitLog([]) };
    const read = (extra = {}) => collectLaneHealth(APP, { forge: GH, taskType: 'ux', now: NOW, deps, ...extra });
    const [first, second] = await Promise.all([read(), read()]);
    expect(second).toBe(first);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(await read()).toBe(first);
    expect(exec).toHaveBeenCalledTimes(1);
    // Another lane, another forge CLI and another repo are separate entries.
    await collectLaneHealth(APP, { forge: GH, taskType: 'ui-runtime-bugs', now: NOW, deps });
    await collectLaneHealth({ ...APP, repoPath: '/other' }, { forge: GH, taskType: 'ux', now: NOW, deps });
    expect(exec).toHaveBeenCalledTimes(3);
    expect(await read({ refresh: true })).not.toBe(first);
    expect(exec).toHaveBeenCalledTimes(4);

    const later = Date.now() + 5 * 60_000 + 1;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    await read();
    expect(exec).toHaveBeenCalledTimes(5);

    const failing = forgeExec({ issues: new Error('gh: HTTP 502') });
    const failDeps = { exec: failing, runGit: gitLog([]) };
    await collectLaneHealth(APP, { forge: GH, taskType: 'design', now: NOW, deps: failDeps });
    await collectLaneHealth(APP, { forge: GH, taskType: 'design', now: NOW, deps: failDeps });
    expect(failing.mock.calls.filter(([, args]) => args[0] === 'issue')).toHaveLength(2);
  });
});
