import { beforeEach, describe, expect, it, vi } from 'vitest';

const execGhMock = vi.fn();
const ensureForgeReachableMock = vi.fn();
vi.mock('./github.js', () => ({
  execGh: (...args) => execGhMock(...args),
  ensureForgeReachable: (...args) => ensureForgeReachableMock(...args),
}));

const mergePrMock = vi.fn();
const resolveForgeForRepoMock = vi.fn();
vi.mock('./git.js', () => ({
  mergePR: (...args) => mergePrMock(...args),
  resolveForgeForRepo: (...args) => resolveForgeForRepoMock(...args),
}));

const getOriginInfoMock = vi.fn();
vi.mock('../lib/gitRemote.js', () => ({
  getOriginInfo: (...args) => getOriginInfoMock(...args),
}));

const addNotificationMock = vi.fn();
vi.mock('./notifications.js', () => ({
  addNotification: (...args) => addNotificationMock(...args),
  NOTIFICATION_TYPES: { AGENT_WARNING: 'agent_warning' },
  PRIORITY_LEVELS: { HIGH: 'high' },
}));

const apps = new Map();
vi.mock('./apps.js', () => ({
  getAppById: vi.fn(async (id) => apps.get(id) || null),
  updateApp: vi.fn(async (id, patch) => {
    const next = { ...apps.get(id), ...patch };
    apps.set(id, next);
    return next;
  }),
}));

import {
  buildTaskInput,
  classifyChecks,
  isIssueClaimRequest,
  isTaskOutputPayload,
  parseAddedDiffLines,
  processTaskOutput,
  MAX_PENDING_APPROVAL_TICKS,
  MAX_PENDING_ISSUE_COMMENT_TICKS,
} from './issueWatcher.js';

const APP = { id: 'app-1', name: 'Example App', repoPath: '/repos/example' };
const DIFF = [
  'diff --git a/src/example.js b/src/example.js',
  '--- a/src/example.js',
  '+++ b/src/example.js',
  '@@ -1,1 +1,2 @@',
  ' const safe = true;',
  '+runUntrusted(input);',
].join('\n');

function pullRequest(overrides = {}) {
  return {
    number: 7,
    title: 'Contributor update',
    body: 'A small change',
    url: 'https://github.com/o/r/pull/7',
    state: 'OPEN',
    isDraft: false,
    author: { login: 'contributor' },
    labels: [{ name: 'good first issue' }],
    files: [{ path: 'src/example.js' }],
    additions: 1,
    deletions: 0,
    baseRefName: 'main',
    baseRefOid: 'b'.repeat(40),
    headRefName: 'contributor/update',
    headRefOid: 'a'.repeat(40),
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: [{ conclusion: 'SUCCESS' }],
    ...overrides,
  };
}

function installDefaultGhMock({ pr = pullRequest(), issueRows = [[]], commentRows = [[]], reviews = [[]] } = {}) {
  execGhMock.mockImplementation(async (args) => {
    if (args[0] === 'api' && args.includes('repos/o/r') && !args.some((arg) => String(arg).includes('/issues'))
      && !args.some((arg) => String(arg).includes('/pulls/')) && !args.some((arg) => String(arg).includes('/compare/'))) {
      return JSON.stringify({ owner: { login: 'owner', type: 'User' }, default_branch: 'main' });
    }
    if (args[0] === 'api' && args.some((arg) => String(arg).endsWith('/issues'))) return JSON.stringify(issueRows);
    if (args[0] === 'api' && args.some((arg) => String(arg).includes('/comments'))) return JSON.stringify(commentRows);
    if (args[0] === 'pr' && args[1] === 'list') {
      return JSON.stringify([{ number: pr.number, title: pr.title, author: pr.author, url: pr.url, isDraft: false, headRefOid: pr.headRefOid, updatedAt: '2026-08-30T01:00:00Z' }]);
    }
    if (args[0] === 'api' && args.some((arg) => String(arg).endsWith(`/pulls/${pr.number}/reviews`))) return JSON.stringify(reviews);
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify(pr);
    if (args[0] === 'api' && args.some((arg) => String(arg).includes('/compare/'))) return JSON.stringify({ behind_by: 2 });
    if (args[0] === 'pr' && args[1] === 'diff') return DIFF;
    if (args[0] === 'issue' && args[1] === 'edit') return '';
    return '{}';
  });
}

beforeEach(() => {
  apps.clear();
  apps.set(APP.id, { ...APP });
  execGhMock.mockReset();
  ensureForgeReachableMock.mockReset();
  ensureForgeReachableMock.mockResolvedValue({ ok: true, status: 'ok' });
  mergePrMock.mockReset();
  resolveForgeForRepoMock.mockReset();
  resolveForgeForRepoMock.mockResolvedValue({ cli: 'gh', env: { GH_TOKEN: 'test-token' }, host: 'github.com', owner: 'o', account: 'o' });
  getOriginInfoMock.mockReset();
  getOriginInfoMock.mockResolvedValue({ hasOrigin: true, host: 'github.com', owner: 'o', repo: 'r', fullName: 'o/r', isGithub: true });
  addNotificationMock.mockReset();
  addNotificationMock.mockResolvedValue({ id: 'notification-1' });
});

describe('issue-watcher pure contracts', () => {
  it.each([
    'I can take this issue',
    "I'd like to work on it",
    'Can you assign this to me?',
  ])('recognizes an explicit volunteer request: %s', (body) => {
    expect(isIssueClaimRequest(body)).toBe(true);
  });

  it.each([
    "I can't take this issue",
    'I can take a look at the logs',
    'This looks good to me',
  ])('does not infer ownership from: %s', (body) => {
    expect(isIssueClaimRequest(body)).toBe(false);
  });

  it('extracts only added RIGHT-side inline anchors', () => {
    const anchors = parseAddedDiffLines(DIFF);
    expect(anchors.has('src/example.js\u0000RIGHT\u00002')).toBe(true);
    expect(anchors.has('src/example.js\u0000RIGHT\u00001')).toBe(false);
  });

  it('keeps failed, pending, and green check states distinct', () => {
    expect(classifyChecks([{ conclusion: 'FAILURE' }])).toBe('failed');
    expect(classifyChecks([{ state: 'ERROR' }])).toBe('failed');
    expect(classifyChecks([{ conclusion: 'STARTUP_FAILURE' }])).toBe('failed');
    expect(classifyChecks([])).toBe('pending');
    expect(classifyChecks([{ status: 'IN_PROGRESS' }])).toBe('pending');
    expect(classifyChecks([{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }])).toBe('green');
  });

  it('requires both output arrays for transcript payload rescue', () => {
    expect(isTaskOutputPayload({ issueComments: [], pullRequests: [] })).toBe(true);
    expect(isTaskOutputPayload({ pullRequests: [] })).toBe(false);
    expect(isTaskOutputPayload([])).toBe(false);
  });
});

describe('buildTaskInput', () => {
  it('baselines issue comments but still reviews an existing unreviewed external PR', async () => {
    installDefaultGhMock();

    const result = await buildTaskInput({ app: APP });

    expect(result.skip).toBeUndefined();
    expect(result.prompt).toContain('Issue Watcher reasoning pass');
    expect(result.prompt).toContain('PR #7: Contributor update');
    expect(result.prompt).toContain('behind base: 2 commit(s)');
    expect(result.prompt).toContain('ciPolicy: "skippable"');
    expect(result.prompt).toContain('"summary": "brief completion summary"');
    expect(result.prompt).toContain('"blocking": true');
    expect(result.hookMetadata.issueWatcher.pullRequests).toEqual([
      { number: 7, headSha: 'a'.repeat(40), diffTruncated: false },
    ]);
    expect(result.hookMetadata.issueWatcher.issueComments).toEqual([]);
  });

  it('assigns an explicit volunteer without spending a cognition run', async () => {
    apps.set(APP.id, { ...APP, issueWatcherState: { cursor: '2026-08-29T00:00:00.000Z' } });
    installDefaultGhMock({
      issueRows: [[{ number: 12, title: 'Small task', body: 'Please help', assignees: [] }]],
      commentRows: [[{
        id: 99,
        body: 'I can take this issue',
        created_at: '2026-08-30T00:00:00.000Z',
        html_url: 'https://github.com/o/r/issues/12#issuecomment-99',
        user: { login: 'alice' },
      }]],
      pr: null,
    });
    execGhMock.mockImplementation(async (args) => {
      if (args[0] === 'api' && args.includes('repos/o/r') && !args.some((arg) => String(arg).includes('/issues'))) {
        return JSON.stringify({ owner: { login: 'owner', type: 'User' }, default_branch: 'main' });
      }
      if (args[0] === 'api' && args.some((arg) => String(arg).endsWith('/issues'))) {
        return JSON.stringify([[{ number: 12, title: 'Small task', body: 'Please help', assignees: [] }]]);
      }
      if (args[0] === 'api' && args.some((arg) => String(arg).includes('/comments'))) {
        return JSON.stringify([[{ id: 99, body: 'I can take this issue', created_at: '2026-08-30T00:00:00.000Z', user: { login: 'alice' } }]]);
      }
      if (args[0] === 'issue' && args[1] === 'edit') return '';
      if (args[0] === 'pr' && args[1] === 'list') return '[]';
      return '{}';
    });

    const result = await buildTaskInput({ app: apps.get(APP.id) });

    expect(result).toEqual({ skip: { reason: 'no-cognitive-activity' } });
    expect(execGhMock).toHaveBeenCalledWith(
      ['issue', 'edit', '12', '--repo', 'github.com/o/r', '--add-assignee', 'alice'],
      expect.any(Number),
      expect.objectContaining({ cwd: APP.repoPath, env: { GH_TOKEN: 'test-token' } }),
    );
    expect(apps.get(APP.id).issueWatcherState.cursor).toMatch(/^2026-/);
  });

  it('continues to cognition when an explicit volunteer cannot be assigned', async () => {
    apps.set(APP.id, { ...APP, issueWatcherState: { cursor: '2026-08-29T00:00:00.000Z' } });
    installDefaultGhMock({ pr: null });
    execGhMock.mockImplementation(async (args) => {
      if (args[0] === 'api' && args.includes('repos/o/r') && !args.some((arg) => String(arg).includes('/issues'))) {
        return JSON.stringify({ owner: { login: 'owner', type: 'User' } });
      }
      if (args[0] === 'api' && args.some((arg) => String(arg).endsWith('/issues'))) {
        return JSON.stringify([[{ number: 12, title: 'Small task', body: 'Please help', assignees: [] }]]);
      }
      if (args[0] === 'api' && args.some((arg) => String(arg).includes('/comments'))) {
        return JSON.stringify([[{ id: 99, body: 'I can take this issue', created_at: '2026-08-30T00:00:00.000Z', user: { login: 'alice' } }]]);
      }
      if (args[0] === 'issue' && args[1] === 'edit') throw new Error('HTTP 422');
      if (args[0] === 'pr' && args[1] === 'list') return '[]';
      return '{}';
    });

    const result = await buildTaskInput({ app: apps.get(APP.id) });

    expect(result.prompt).toContain('Issue #12: Small task');
    expect(result.hookMetadata.issueWatcher.issueComments).toEqual([{ issueNumber: 12, commentId: 99 }]);
    expect(apps.get(APP.id).issueWatcherState.cursor).toMatch(/^2026-/);
  });
});

describe('processTaskOutput', () => {
  const metadata = {
    issueWatcher: {
      cursor: '2026-08-30T02:00:00.000Z',
      repoFullName: 'o/r',
      issueComments: [],
      pullRequests: [{ number: 7, headSha: 'a'.repeat(40) }],
    },
  };

  it('posts validated findings as inline review comments and never merges', async () => {
    installDefaultGhMock();
    const payload = {
      issueComments: [],
      pullRequests: [{
        number: 7,
        headSha: 'a'.repeat(40),
        verdict: 'request_changes',
        summary: 'The new call accepts untrusted input.',
        findings: [{ path: 'src/example.js', line: 2, side: 'RIGHT', body: 'Validate input before this call.' }],
        rebaseRequired: false,
        ciPolicy: 'required',
      }],
    };

    const result = await processTaskOutput({ appId: APP.id, success: true, payload, task: { metadata } });

    expect(result).toMatchObject({ action: 'processed', reviewed: 1, merged: 0 });
    const reviewCall = execGhMock.mock.calls.find(([args]) => args.includes('repos/o/r/pulls/7/reviews') && args.includes('--input'));
    expect(reviewCall).toBeTruthy();
    expect(JSON.parse(reviewCall[2].input)).toMatchObject({
      event: 'REQUEST_CHANGES',
      comments: [{ path: 'src/example.js', line: 2, side: 'RIGHT', body: 'Validate input before this call.' }],
    });
    expect(mergePrMock).not.toHaveBeenCalled();
  });

  it('submits a blocking review when request-changes has no inline anchor', async () => {
    installDefaultGhMock();
    const payload = {
      issueComments: [],
      pullRequests: [{
        number: 7,
        headSha: 'a'.repeat(40),
        verdict: 'request_changes',
        summary: 'The change removes required compatibility behavior.',
        findings: [],
        rebaseRequired: false,
        ciPolicy: 'required',
      }],
    };

    await processTaskOutput({ appId: APP.id, success: true, payload, task: { metadata } });

    const reviewCall = execGhMock.mock.calls.find(([args]) => args.includes('repos/o/r/pulls/7/reviews') && args.includes('--input'));
    expect(JSON.parse(reviewCall[2].input)).toMatchObject({ event: 'REQUEST_CHANGES', comments: [] });
    expect(mergePrMock).not.toHaveBeenCalled();
  });

  it('explains when an approval was blocked because a finding could not be anchored', async () => {
    installDefaultGhMock();
    const payload = {
      issueComments: [],
      pullRequests: [{
        number: 7,
        headSha: 'a'.repeat(40),
        verdict: 'approve',
        summary: 'Looks fine; one follow-up is noted.',
        findings: [{
          path: 'src/example.js', line: 99, side: 'RIGHT', blocking: false,
          body: 'This line is not in the supplied diff.',
        }],
        rebaseRequired: false,
        ciPolicy: 'required',
      }],
    };

    await processTaskOutput({ appId: APP.id, success: true, payload, task: { metadata } });

    const reviewCall = execGhMock.mock.calls.find(([args]) => args.includes('repos/o/r/pulls/7/reviews') && args.includes('--input'));
    expect(JSON.parse(reviewCall[2].input)).toMatchObject({ event: 'REQUEST_CHANGES' });
    expect(JSON.parse(reviewCall[2].input).body).toContain('could not anchor one or more reported findings');
    expect(mergePrMock).not.toHaveBeenCalled();
  });

  it('updates a behind branch when the reviewer requires a rebase, then waits for a fresh review', async () => {
    installDefaultGhMock();
    const payload = {
      issueComments: [],
      pullRequests: [{
        number: 7, headSha: 'a'.repeat(40), verdict: 'approve', summary: 'Clean, but overlaps current main.', findings: [],
        rebaseRequired: true, ciPolicy: 'required',
      }],
    };

    const result = await processTaskOutput({ appId: APP.id, success: true, payload, task: { metadata } });

    expect(result).toMatchObject({ reviewed: 1, rebased: 1, merged: 0 });
    const updateCall = execGhMock.mock.calls.find(([args]) => args.includes('repos/o/r/pulls/7/update-branch'));
    expect(JSON.parse(updateCall[2].input)).toEqual({ expected_head_sha: 'a'.repeat(40), update_method: 'rebase' });
    expect(mergePrMock).not.toHaveBeenCalled();
  });

  it('approves and merges a fresh clean PR after green checks', async () => {
    installDefaultGhMock();
    mergePrMock.mockResolvedValue({ success: true });
    const payload = {
      issueComments: [],
      pullRequests: [{
        number: 7, headSha: 'a'.repeat(40), verdict: 'approve', summary: 'No material issues found.', findings: [],
        rebaseRequired: false, ciPolicy: 'required',
      }],
    };

    const result = await processTaskOutput({ appId: APP.id, success: true, payload, task: { metadata } });

    expect(result).toMatchObject({ reviewed: 1, merged: 1 });
    const reviewCall = execGhMock.mock.calls.find(([args]) => args.includes('repos/o/r/pulls/7/reviews') && args.includes('--input'));
    expect(JSON.parse(reviewCall[2].input)).toMatchObject({ event: 'APPROVE', comments: [] });
    expect(mergePrMock).toHaveBeenCalledWith(APP.repoPath, 7);
  });

  it('posts non-blocking findings on an approving review and still merges', async () => {
    installDefaultGhMock();
    mergePrMock.mockResolvedValue({ success: true });
    const payload = {
      issueComments: [],
      pullRequests: [{
        number: 7,
        headSha: 'a'.repeat(40),
        verdict: 'approve',
        summary: 'Safe to merge; one small follow-up is noted.',
        findings: [{
          path: 'src/example.js', line: 2, side: 'RIGHT', blocking: false,
          body: 'Consider making this helper name more specific in a follow-up.',
        }],
        rebaseRequired: false,
        ciPolicy: 'required',
      }],
    };

    const result = await processTaskOutput({ appId: APP.id, success: true, payload, task: { metadata } });

    expect(result).toMatchObject({ reviewed: 1, merged: 1 });
    const reviewCall = execGhMock.mock.calls.find(([args]) => args.includes('repos/o/r/pulls/7/reviews') && args.includes('--input'));
    expect(JSON.parse(reviewCall[2].input)).toMatchObject({
      event: 'APPROVE',
      comments: [{
        path: 'src/example.js', line: 2, side: 'RIGHT',
        body: 'Consider making this helper name more specific in a follow-up.',
      }],
    });
    expect(mergePrMock).toHaveBeenCalledWith(APP.repoPath, 7);
  });

  it('approves without inline comments when GitHub rejects the comment anchors', async () => {
    installDefaultGhMock();
    const defaultGhImplementation = execGhMock.getMockImplementation();
    let reviewAttempts = 0;
    execGhMock.mockImplementation(async (args, ...rest) => {
      if (args[0] === 'api' && args.some((arg) => String(arg).endsWith('/pulls/7/reviews'))) {
        reviewAttempts += 1;
        if (reviewAttempts === 1) throw new Error('HTTP 422: invalid review comment');
      }
      return defaultGhImplementation(args, ...rest);
    });
    mergePrMock.mockResolvedValue({ success: true });
    const payload = {
      issueComments: [],
      pullRequests: [{
        number: 7,
        headSha: 'a'.repeat(40),
        verdict: 'approve',
        summary: 'Safe to merge; comment delivery was unavailable.',
        findings: [{
          path: 'src/example.js', line: 2, side: 'RIGHT', blocking: false,
          body: 'Track this small cleanup in a follow-up.',
        }],
        rebaseRequired: false,
        ciPolicy: 'required',
      }],
    };

    const result = await processTaskOutput({ appId: APP.id, success: true, payload, task: { metadata } });

    expect(result).toMatchObject({ reviewed: 1, merged: 1 });
    const reviewCalls = execGhMock.mock.calls.filter(([args]) => args.includes('repos/o/r/pulls/7/reviews') && args.includes('--input'));
    expect(reviewCalls).toHaveLength(2);
    expect(JSON.parse(reviewCalls[1][2].input)).toMatchObject({ event: 'APPROVE', comments: [] });
    expect(mergePrMock).toHaveBeenCalledWith(APP.repoPath, 7);
  });

  it('treats a finding with no explicit blocking flag as blocking and does not merge', async () => {
    installDefaultGhMock();
    const payload = {
      issueComments: [],
      pullRequests: [{
        number: 7, headSha: 'a'.repeat(40), verdict: 'approve',
        summary: 'Looks fine.',
        findings: [{ path: 'src/example.js', line: 2, side: 'RIGHT', body: 'Validate input before this call.' }],
        rebaseRequired: false, ciPolicy: 'required',
      }],
    };

    const result = await processTaskOutput({ appId: APP.id, success: true, payload, task: { metadata } });

    expect(result).toMatchObject({ reviewed: 1, merged: 0 });
    const reviewCall = execGhMock.mock.calls.find(([args]) => args.includes('repos/o/r/pulls/7/reviews') && args.includes('--input'));
    expect(JSON.parse(reviewCall[2].input)).toMatchObject({ event: 'REQUEST_CHANGES' });
    expect(mergePrMock).not.toHaveBeenCalled();
  });

  it('does not review or merge when the PR head changed after cognition', async () => {
    installDefaultGhMock({ pr: pullRequest({ headRefOid: 'c'.repeat(40) }) });
    const payload = {
      issueComments: [],
      pullRequests: [{
        number: 7, headSha: 'a'.repeat(40), verdict: 'approve', summary: 'No material issues found.', findings: [],
        rebaseRequired: false, ciPolicy: 'required',
      }],
    };

    const result = await processTaskOutput({ appId: APP.id, success: true, payload, task: { metadata } });

    expect(result).toMatchObject({ reviewed: 0, merged: 0 });
    expect(execGhMock.mock.calls.some(([args]) => args.includes('repos/o/r/pulls/7/reviews') && args.includes('--input'))).toBe(false);
    expect(mergePrMock).not.toHaveBeenCalled();
  });

  it('waits one scheduled observation before treating absent CI as skippable', async () => {
    installDefaultGhMock({ pr: pullRequest({ statusCheckRollup: [] }) });
    mergePrMock.mockResolvedValue({ success: true });
    const payload = {
      issueComments: [],
      pullRequests: [{
        number: 7, headSha: 'a'.repeat(40), verdict: 'approve', summary: 'Documentation-only and safe.', findings: [],
        rebaseRequired: false, ciPolicy: 'skippable',
      }],
    };

    const result = await processTaskOutput({ appId: APP.id, success: true, payload, task: { metadata } });

    expect(result).toMatchObject({ reviewed: 1, merged: 0 });
    expect(mergePrMock).not.toHaveBeenCalled();
    expect(apps.get(APP.id).issueWatcherState.approvedPullRequests).toEqual([
      expect.objectContaining({ number: 7, ciPolicy: 'skippable', noChecksObserved: true }),
    ]);

    installDefaultGhMock({
      pr: pullRequest({ statusCheckRollup: [] }),
      reviews: [[{ user: { login: 'owner' }, commit_id: 'a'.repeat(40), state: 'APPROVED' }]],
    });
    const followUp = await buildTaskInput({ app: apps.get(APP.id) });

    expect(followUp).toEqual({ skip: { reason: 'baselined' } });
    expect(mergePrMock).toHaveBeenCalledWith(APP.repoPath, 7);
    expect(apps.get(APP.id).issueWatcherState.approvedPullRequests).toEqual([]);
  });

  it('never waives an actively running check for a low-risk PR', async () => {
    installDefaultGhMock({ pr: pullRequest({ statusCheckRollup: [{ status: 'IN_PROGRESS', conclusion: null }] }) });
    const payload = {
      issueComments: [],
      pullRequests: [{
        number: 7, headSha: 'a'.repeat(40), verdict: 'approve', summary: 'Low-risk documentation change.', findings: [],
        rebaseRequired: false, ciPolicy: 'skippable',
      }],
    };

    const result = await processTaskOutput({ appId: APP.id, success: true, payload, task: { metadata } });

    expect(result).toMatchObject({ reviewed: 1, merged: 0 });
    expect(mergePrMock).not.toHaveBeenCalled();
    expect(apps.get(APP.id).issueWatcherState.approvedPullRequests).toEqual([
      expect.objectContaining({ number: 7, noChecksObserved: false }),
    ]);
  });

  it('never waives a known failing check, even when CI was classified skippable', async () => {
    installDefaultGhMock({ pr: pullRequest({ statusCheckRollup: [{ conclusion: 'FAILURE' }] }) });
    const payload = {
      issueComments: [],
      pullRequests: [{
        number: 7, headSha: 'a'.repeat(40), verdict: 'approve', summary: 'Small change.', findings: [],
        rebaseRequired: false, ciPolicy: 'skippable',
      }],
    };

    const result = await processTaskOutput({ appId: APP.id, success: true, payload, task: { metadata } });

    expect(result).toMatchObject({ reviewed: 1, merged: 0 });
    expect(mergePrMock).not.toHaveBeenCalled();
    expect(apps.get(APP.id).issueWatcherState.approvedPullRequests).toEqual([]);
    expect(addNotificationMock).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Issue Watcher PR #7 needs attention',
      link: 'https://github.com/o/r/pull/7',
    }));
  });

  it('bounds polling for an approved PR whose CI never settles', async () => {
    const approval = {
      number: 7,
      headSha: 'a'.repeat(40),
      url: 'https://github.com/o/r/pull/7',
      ciPolicy: 'required',
      rebaseRequired: false,
      ticks: MAX_PENDING_APPROVAL_TICKS - 1,
    };
    apps.set(APP.id, { ...APP, issueWatcherState: { approvedPullRequests: [approval] } });
    installDefaultGhMock({
      pr: pullRequest({ statusCheckRollup: [] }),
      reviews: [[{ user: { login: 'owner' }, commit_id: 'a'.repeat(40), state: 'APPROVED' }]],
    });

    const result = await buildTaskInput({ app: apps.get(APP.id) });

    expect(result).toEqual({ skip: { reason: 'baselined' } });
    expect(apps.get(APP.id).issueWatcherState.approvedPullRequests).toEqual([]);
    expect(addNotificationMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'agent_warning',
      link: approval.url,
      metadata: { appId: APP.id, issueWatcherPrNumber: 7 },
    }));
  });

  it('ages out a repeatedly incomplete issue-comment decision and notifies', async () => {
    const pending = {
      issueNumber: 12,
      commentId: 99,
      commentUrl: 'https://github.com/o/r/issues/12#issuecomment-99',
      ticks: MAX_PENDING_ISSUE_COMMENT_TICKS - 1,
    };
    apps.set(APP.id, { ...APP, issueWatcherState: { pendingIssueComments: [pending] } });
    installDefaultGhMock();
    const commentMetadata = {
      issueWatcher: {
        ...metadata.issueWatcher,
        issueComments: [{ issueNumber: 12, commentId: 99 }],
        pullRequests: [],
      },
    };

    const result = await processTaskOutput({
      appId: APP.id,
      success: true,
      payload: { issueComments: [], pullRequests: [] },
      task: { metadata: commentMetadata },
    });

    expect(result).toMatchObject({ commentsHandled: false });
    expect(apps.get(APP.id).issueWatcherState.pendingIssueComments).toEqual([]);
    expect(addNotificationMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'agent_warning',
      link: pending.commentUrl,
      metadata: { appId: APP.id, issueWatcherCommentCount: 1 },
    }));
  });
});
