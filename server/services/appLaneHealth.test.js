import { describe, expect, it, vi } from 'vitest';
import { collectLaneHealth, getAppLaneHealth } from './appLaneHealth.js';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const DAY = 86_400_000;
const APP = { id: 'app-1', name: 'Example App', repoPath: '/repo' };
const GH = { cli: 'gh', env: { PATH: '/bin' }, host: 'github.com' };
const GLAB = { cli: 'glab', env: {}, host: 'gitlab.example.com' };
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();

// One fake per spawn: the forge CLI answers by subcommand, git by its log call.
const forgeExec = ({ issues = [], pullRequests = [] } = {}) => vi.fn(async (_cli, args) => {
  const rows = args[0] === 'issue' ? issues : pullRequests;
  return rows instanceof Error ? { code: -1, stdout: '', stderr: rows.message } : { code: 0, stdout: JSON.stringify(rows) };
});
const gitLog = (records) => vi.fn(async () => ({ exitCode: 0, stdout: records.map(({ sha, subject, body = '' }) => `${sha}\x1f${subject}\x1f${body}\x1e\n`).join('') }));

describe('appLaneHealth', () => {
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
    expect(exec).toHaveBeenCalledWith('gh', expect.arrayContaining(['pr', 'list', '--state', 'merged', '--search', 'merged:>=2026-08-18 sort:updated-desc']), { cwd: '/repo', env: GH.env });
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
    const runGit = gitLog([{ sha: 'cccc333', subject: 'Revert "drift"', body: 'This reverts commit abc1234567.' }]);
    const result = await collectLaneHealth(APP, { forge: GLAB, now: NOW, deps: { exec, runGit } });
    expect(exec).toHaveBeenCalledWith('glab', ['issue', 'list', '--all', '-P', '1000'], expect.any(Object));
    expect(exec).toHaveBeenCalledWith('glab', ['mr', 'list', '--merged', '-P', '300'], expect.any(Object));
    expect(result.lanes.length).toBeGreaterThan(20);
    expect(result.lanes.find(({ id }) => id === 'simplify')).toMatchObject({ filed: 1, completed: 1, reverted: 1 });
    expect(result.lanes.find(({ id }) => id === 'better-complexity')).toMatchObject({ filed: 1, open: 1 });
  });

  it('shortens a truncated window and names failed PR and commit reads instead of reading them as no reverts', async () => {
    const issues = [
      { number: 9, title: 'Newest', labels: ['complexity'], createdAt: iso(3), state: 'OPEN' },
      { number: 8, title: 'Oldest seen', labels: ['complexity'], createdAt: iso(20), state: 'OPEN' },
    ];
    const exec = forgeExec({ issues, pullRequests: new Error('gh: HTTP 500') });
    const result = await collectLaneHealth(APP, { forge: GH, taskType: 'better-complexity', now: NOW, deps: { exec, runGit: vi.fn().mockResolvedValue({ exitCode: 128, stdout: '' }) } });
    expect(result).toMatchObject({ ok: true, truncated: false, partial: ['pull-requests', 'commits'] });

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
    expect(await getAppLaneHealth(APP, deps)).toMatchObject({ available: false, reason: 'issues', error: expect.stringContaining('gh auth login') });
    expect(warn).toHaveBeenCalledTimes(1);

    deps.resolveTracker.mockResolvedValueOnce({ forge: 'jira' });
    expect(await getAppLaneHealth(APP, deps)).toEqual({ available: false, reason: 'forge-unavailable' });
    warn.mockRestore();
  });
});
