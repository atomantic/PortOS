import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./github.js', () => ({ execGh: vi.fn() }));
vi.mock('./gitlab.js', () => ({ execGlab: vi.fn() }));
vi.mock('./forgeExecOptions.js', () => ({
  resolveForgeExecOptions: vi.fn(async () => ({ cwd: '/repo', env: { GH_TOKEN: 'x' }, customEnv: { GH_TOKEN: 'x' } })),
}));
vi.mock('../lib/workTracker.js', () => ({ resolveAppForgeTarget: vi.fn() }));

import { execGh } from './github.js';
import { execGlab } from './gitlab.js';
import { resolveAppForgeTarget } from '../lib/workTracker.js';
import { mergeAppPullRequest } from './appPullRequestMerge.js';

const APP = { id: 'app-001', name: 'Widget', repoPath: '/repo' };
const PR = { headSha: 'a'.repeat(40), number: 17, headBranch: 'fix/save-path', baseBranch: 'main' };

const githubTarget = () => ({
  tracker: 'github',
  target: { forge: 'github', fullName: 'acme/widget', repoSpec: 'github.com/acme/widget', apiHost: 'github.com' },
});

beforeEach(() => {
  vi.clearAllMocks();
  resolveAppForgeTarget.mockResolvedValue(githubTarget());
  execGh.mockResolvedValue('');
  execGlab.mockResolvedValue('');
});

describe('mergeAppPullRequest', () => {
  it('merges a GitHub request with the requested method and deletes the branch remotely', async () => {
    const result = await mergeAppPullRequest(APP, PR, { method: 'squash', deleteBranch: true });

    expect(result).toMatchObject({ ok: true, method: 'squash', deletedBranch: true });
    // `--repo` keeps gh in remote mode, so `--delete-branch` never checks out a
    // branch in the user's working tree.
    expect(execGh).toHaveBeenCalledWith(
      ['pr', 'merge', '17', '--repo', 'github.com/acme/widget', '--squash', '--delete-branch', '--match-head-commit', PR.headSha],
      expect.any(Number),
      { cwd: '/repo', env: { GH_TOKEN: 'x' } },
    );
  });

  it('refuses an unknown GitHub head and preserves a head-mismatch failure', async () => {
    expect(await mergeAppPullRequest(APP, { ...PR, headSha: null })).toMatchObject({ ok: false, code: 'invalid-head' });
    expect(execGh).not.toHaveBeenCalled();
    execGh.mockRejectedValue(new Error('Head commit changed'));
    expect(await mergeAppPullRequest(APP, PR)).toMatchObject({ ok: false, code: 'merge-failed' });
    expect(execGh.mock.calls[0][0]).toContain(PR.headSha);
  });

  // A `main → release` request's head is a long-lived branch, so an obedient
  // `--delete-branch` there deletes `main`. An unnamed head is treated the same
  // way: never delete a branch we cannot identify.
  it.each([
    ['a long-lived head', { number: 9, headBranch: 'main', baseBranch: 'release' }],
    ['a head equal to the base', { number: 9, headBranch: 'topic', baseBranch: 'topic' }],
    ['an unreadable head', { number: 9, headBranch: '', baseBranch: 'main' }],
  ])('merges but refuses to delete %s', async (_label, pullRequest) => {
    const result = await mergeAppPullRequest(APP, { headSha: PR.headSha, ...pullRequest }, { deleteBranch: true });

    expect(result).toMatchObject({ ok: true, deletedBranch: false });
    expect(execGh.mock.calls[0][0]).not.toContain('--delete-branch');
  });

  it('refuses a draft, which both forges would reject anyway', async () => {
    const result = await mergeAppPullRequest(APP, { ...PR, isDraft: true }, {});

    expect(result).toMatchObject({ ok: false, code: 'draft' });
    expect(execGh).not.toHaveBeenCalled();
  });

  it('reports a forbidden merge method rather than silently using another one', async () => {
    execGh.mockRejectedValue(Object.assign(new Error('failed'), {
      ghStderr: 'GraphQL: Squash merges are not allowed on this repository',
    }));

    const result = await mergeAppPullRequest(APP, PR, { method: 'squash' });

    expect(result).toMatchObject({ ok: false, code: 'method-not-allowed' });
    expect(result.error).toContain('Squash merges are not allowed');
    expect(execGh).toHaveBeenCalledTimes(1);
  });

  it('reports a failed merge with the forge message', async () => {
    execGh.mockRejectedValue(Object.assign(new Error('failed'), {
      ghStderr: 'GraphQL: Pull Request is not mergeable',
    }));

    const result = await mergeAppPullRequest(APP, PR, {});

    expect(result).toMatchObject({ ok: false, code: 'merge-failed' });
  });

  it('merges a GitLab request immediately instead of waiting on its pipeline', async () => {
    resolveAppForgeTarget.mockResolvedValue({
      tracker: 'gitlab',
      target: { forge: 'gitlab', fullName: 'acme/widget', repoSpec: null, apiHost: null },
    });

    const result = await mergeAppPullRequest(APP, PR, { method: 'rebase', deleteBranch: true });

    expect(result).toMatchObject({ ok: true, method: 'rebase', deletedBranch: true });
    expect(execGlab).toHaveBeenCalledWith(
      ['mr', 'merge', '17', '--yes', '--when-pipeline-succeeds=false', '--rebase', '--remove-source-branch'],
      '/repo',
      expect.any(Number),
      { env: { GH_TOKEN: 'x' }, rejectOnError: true },
    );
  });

  it('retries without the immediate-merge flag on a glab that renamed it', async () => {
    resolveAppForgeTarget.mockResolvedValue({
      tracker: 'gitlab',
      target: { forge: 'gitlab', fullName: 'acme/widget', repoSpec: null, apiHost: null },
    });
    execGlab.mockRejectedValueOnce(new Error('unknown flag: --when-pipeline-succeeds'));

    const result = await mergeAppPullRequest(APP, PR, {});

    expect(result).toMatchObject({ ok: true, method: 'merge' });
    expect(execGlab).toHaveBeenCalledTimes(2);
    expect(execGlab.mock.calls[1][0]).toEqual(['mr', 'merge', '17', '--yes']);
  });

  it('refuses a forge it cannot merge on', async () => {
    resolveAppForgeTarget.mockResolvedValue({ tracker: null, target: null });

    expect(await mergeAppPullRequest(APP, PR, {})).toMatchObject({ ok: false, code: 'unsupported-forge' });
    expect(execGh).not.toHaveBeenCalled();
  });
});

