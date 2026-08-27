import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./github.js', () => ({
  execGh: vi.fn(),
  ensureForgeReachable: vi.fn(),
}));
vi.mock('./gitlab.js', () => ({
  execGlabJson: vi.fn(),
}));
vi.mock('../lib/workTracker.js', () => ({
  resolveAppForgeTarget: vi.fn(),
}));

import { execGh, ensureForgeReachable } from './github.js';
import { execGlabJson } from './gitlab.js';
import { resolveAppForgeTarget } from '../lib/workTracker.js';
import { listAppPullRequests } from './appPullRequests.js';

const APP = { id: 'app-001', name: 'Widget', repoPath: '/repo', workTracker: 'auto' };

beforeEach(() => {
  vi.clearAllMocks();
  ensureForgeReachable.mockResolvedValue({ ok: true });
  resolveAppForgeTarget.mockResolvedValue({
    tracker: 'github',
    target: { forge: 'github', fullName: 'acme/widget', repoSpec: 'github.com/acme/widget', apiHost: 'github.com' },
  });
});

describe('listAppPullRequests', () => {
  it('normalizes GitHub review, merge, branch, label, and check state', async () => {
    execGh.mockResolvedValue(JSON.stringify([{
      number: 17,
      title: 'Fix the save path',
      url: 'https://github.com/acme/widget/pull/17',
      author: { login: 'alice' },
      createdAt: '2026-08-01T00:00:00Z',
      updatedAt: '2026-08-02T00:00:00Z',
      isDraft: false,
      headRefName: 'fix/save-path',
      baseRefName: 'main',
      reviewDecision: 'CHANGES_REQUESTED',
      mergeStateStatus: 'DIRTY',
      mergeable: 'CONFLICTING',
      labels: [{ name: 'bug' }],
      statusCheckRollup: [
        { name: 'unit', conclusion: 'SUCCESS', detailsUrl: 'https://ci.example/unit' },
        { name: 'lint', status: 'IN_PROGRESS' },
      ],
    }]));

    const result = await listAppPullRequests(APP);

    expect(ensureForgeReachable).toHaveBeenCalledWith('app-pull-requests', { hostname: 'github.com' });
    expect(execGh).toHaveBeenCalledWith(expect.arrayContaining([
      'pr', 'list', '--repo', 'github.com/acme/widget', '--state', 'open', '--limit', '200',
    ]));
    expect(result).toMatchObject({
      forge: 'github',
      tracker: 'github',
      fullName: 'acme/widget',
      reason: 'ok',
      transient: false,
      pullRequests: [{
        number: 17,
        title: 'Fix the save path',
        author: 'alice',
        headBranch: 'fix/save-path',
        baseBranch: 'main',
        reviewDecision: 'CHANGES_REQUESTED',
        mergeStateStatus: 'DIRTY',
        mergeable: 'CONFLICTING',
        labels: ['bug'],
        checks: [
          { name: 'unit', status: 'SUCCESS', url: 'https://ci.example/unit' },
          { name: 'lint', status: 'IN_PROGRESS', url: null },
        ],
      }],
    });
  });

  it('keeps an answered empty GitHub list distinct from a failed read', async () => {
    execGh.mockResolvedValue('[]');

    const result = await listAppPullRequests(APP);

    expect(result).toMatchObject({ pullRequests: [], reason: 'no-open-pull-requests', transient: false });
  });

  it('does not turn a malformed nonempty GitHub response into an empty success', async () => {
    execGh.mockResolvedValue(JSON.stringify([null, { title: 'missing number' }]));

    const result = await listAppPullRequests(APP);

    expect(result).toMatchObject({
      pullRequests: [],
      reason: 'unreadable-response',
      transient: true,
    });
  });

  it('returns a transient sentinel when the forge cannot be reached', async () => {
    ensureForgeReachable.mockResolvedValue({
      ok: false,
      status: 'unauthenticated',
      remedy: 'run gh auth login',
    });

    const result = await listAppPullRequests(APP);

    expect(execGh).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      pullRequests: [],
      reason: 'gh-unauthenticated',
      transient: true,
      remedy: 'run gh auth login',
    });
  });

  it('normalizes GitLab merge-request and pipeline state from the repo cwd', async () => {
    resolveAppForgeTarget.mockResolvedValue({
      tracker: 'plan',
      target: { forge: 'gitlab', fullName: 'group/widget', repoSpec: null, apiHost: null },
    });
    execGlabJson.mockResolvedValue({
      reason: 'ok',
      rows: [{
        iid: 8,
        title: 'Improve the editor',
        web_url: 'https://gitlab.example/group/widget/-/merge_requests/8',
        author: { username: 'bob' },
        created_at: '2026-08-03T00:00:00Z',
        updated_at: '2026-08-04T00:00:00Z',
        draft: true,
        source_branch: 'feat/editor',
        target_branch: 'main',
        approved: true,
        detailed_merge_status: 'mergeable',
        merge_status: 'can_be_merged',
        labels: ['enhancement'],
        head_pipeline: { status: 'success', web_url: 'https://gitlab.example/group/widget/-/pipelines/4' },
      }],
    });

    const result = await listAppPullRequests(APP);

    expect(execGlabJson).toHaveBeenCalledWith(['mr', 'list', '--per-page', '100'], '/repo');
    expect(result).toMatchObject({
      forge: 'gitlab',
      tracker: 'plan',
      pullRequests: [{
        number: 8,
        state: 'open',
        author: 'bob',
        isDraft: true,
        headBranch: 'feat/editor',
        baseBranch: 'main',
        reviewDecision: 'APPROVED',
        mergeStateStatus: 'mergeable',
        mergeable: 'can_be_merged',
        checks: [{ name: 'Pipeline', status: 'SUCCESS', url: 'https://gitlab.example/group/widget/-/pipelines/4' }],
      }],
    });
  });

  it('returns a non-transient unsupported-forge sentinel without invoking a CLI', async () => {
    resolveAppForgeTarget.mockResolvedValue({ tracker: 'plan', target: null });

    const result = await listAppPullRequests(APP);

    expect(execGh).not.toHaveBeenCalled();
    expect(execGlabJson).not.toHaveBeenCalled();
    expect(result).toMatchObject({ tracker: 'plan', pullRequests: [], reason: 'unsupported-forge', transient: false });
  });
});
