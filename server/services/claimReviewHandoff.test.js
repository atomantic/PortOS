import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./agent/agentAppWorkspace.js', () => ({ getAppDataForTask: vi.fn() }));
vi.mock('../lib/gitRemote.js', () => ({ getOriginInfo: vi.fn() }));
vi.mock('./prProbe.js', async () => {
  const { awaitsHumanReviewOnRequiredChecks } = await vi.importActual('./prView.js');
  return { readPullRequest: vi.fn(), awaitsHumanReviewOnRequiredChecks };
});
vi.mock('./github.js', () => ({ execGh: vi.fn() }));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: async () => ({}) }));
vi.mock('./worktreeManager.js', () => ({ listWorktrees: vi.fn() }));
vi.mock('../lib/execGit.js', () => ({ execGit: vi.fn() }));
vi.mock('../lib/localReviewLifecycle.js', () => ({ localReviewLifecycle: vi.fn() }));

import { getAppDataForTask } from './agent/agentAppWorkspace.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import { readPullRequest } from './prProbe.js';
import { listWorktrees } from './worktreeManager.js';
import { execGit } from '../lib/execGit.js';
import { localReviewLifecycle } from '../lib/localReviewLifecycle.js';
import { execGh } from './github.js';
import { verifyClaimReviewHandoff } from './claimReviewHandoff.js';

const head = 'a'.repeat(40);
const otherHead = 'b'.repeat(40);
const url = number => `https://github.example.test/example/project/pull/${number}`;
const task = { id: 'task-example', taskType: 'user', metadata: { app: 'example', claimFlow: true, claimTarget: '42', prCompletion: 'review-then-merge' } };
const agent = { id: 'agent-example', taskId: task.id, metadata: { sourceWorkspace: '/example/project',
  workspacePath: '/example/claim-42', claimBranches: ['claim/issue-42'] } };
const reportedOutcome = { status: 'blocked', reason: 'Untrusted prose: a code owner must approve.' };
const green = [{ __typename: 'CheckRun', name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }];
let views;
let tips;
let dirt;
const view = (branch, number, overrides = {}) => ({ number, url: url(number), state: 'OPEN', isDraft: false, isCrossRepository: false,
  headRefName: branch, headRefOid: tips[branch], mergeable: 'MERGEABLE', reviewDecision: 'REVIEW_REQUIRED', statusCheckRollup: green, ...overrides });
const verify = (extra = {}) => verifyClaimReviewHandoff({ task, agent, reportedOutcome, success: true, ...extra });

beforeEach(() => {
  vi.resetAllMocks();
  tips = { 'claim/issue-42': head, 'claim/issue-43': otherHead };
  views = { 'claim/issue-42': view('claim/issue-42', 7) };
  dirt = '';
  getAppDataForTask.mockResolvedValue({ repoPath: '/example/project', forgeAccount: 'configured-account' });
  getOriginInfo.mockResolvedValue({ host: 'github.example.test', fullName: 'example/project' });
  listWorktrees.mockResolvedValue([
    { branch: 'refs/heads/main', path: '/example/project' },
    { branch: 'refs/heads/claim/issue-42', path: '/example/claim-42' },
    { branch: 'refs/heads/claim/issue-43', path: '/example/claim-43' },
  ]);
  execGit.mockImplementation(async args => {
    if (args[0] === 'rev-parse') return { exitCode: 0, stdout: `${tips[args[2].replace(/^refs\/heads\//, '').replace(/\^\{commit\}$/, '')]}\n` };
    if (args[0] === 'status') return { exitCode: 0, stdout: dirt };
    throw new Error(`unexpected git ${args.join(' ')}`);
  });
  readPullRequest.mockImplementation(async branch => views[branch] ?? null);
  localReviewLifecycle.mockImplementation(async (_cwd, { prUrl }) => ({ reusable: true, receipt: { status: 'partial', prUrl } }));
});

describe('claim human-review handoff with advisory failures', () => {
  const rollup = [{ name: 'CI', conclusion: 'SUCCESS' }, { name: 'ruleset drift', conclusion: 'FAILURE' }];
  const answerRequired = required => execGh.mockResolvedValue(JSON.stringify({ data: { repository: { pullRequest: { commits: { nodes: [{ commit: { oid: head, statusCheckRollup: {
    contexts: { pageInfo: { hasNextPage: false }, nodes: rollup.map(c => ({ name: c.name, isRequired: required.includes(c.name) })) } } } }] } } } } }));
  beforeEach(() => { views['claim/issue-42'] = view('claim/issue-42', 7, { statusCheckRollup: rollup }); });

  it('verifies when only a non-required check failed', async () => {
    answerRequired(['CI']);
    expect(await verify()).toMatchObject({ status: 'verified', pullRequests: [{ awaitingHumanReview: true }] });
  });
  it('refuses when a required check failed', async () => {
    answerRequired(['CI', 'ruleset drift']);
    expect(await verify()).toEqual({ status: 'unverified', reason: 'pull-request-not-awaiting-human-review' });
  });
  it('refuses when a required check is missing from the viewed rollup', async () => {
    views['claim/issue-42'] = view('claim/issue-42', 7, { statusCheckRollup: [rollup[1]] });
    answerRequired(['CI', 'ruleset drift']);
    expect(await verify()).toEqual({ status: 'unverified', reason: 'pull-request-not-awaiting-human-review' });
  });
  it('refuses when a node lacks a boolean requiredness', async () => {
    execGh.mockResolvedValue(JSON.stringify({ data: { repository: { pullRequest: { commits: { nodes: [{ commit: { oid: head, statusCheckRollup: {
      contexts: { pageInfo: { hasNextPage: false }, nodes: [{ name: 'CI', isRequired: true }, { name: 'ruleset drift' }] } } } }] } } } } }));
    expect(await verify()).toEqual({ status: 'unverified', reason: 'pull-request-not-awaiting-human-review' });
  });
  it('refuses when requiredness was read for a newer head', async () => {
    answerRequired(['CI']);
    views['claim/issue-42'] = view('claim/issue-42', 7, { statusCheckRollup: rollup, headRefOid: otherHead });
    tips['claim/issue-42'] = otherHead;
    expect(await verify()).toEqual({ status: 'unverified', reason: 'pull-request-not-awaiting-human-review' });
  });
  it('refuses when the required set cannot be read', async () => {
    execGh.mockRejectedValue(new Error('graphql unavailable'));
    expect(await verify()).toEqual({ status: 'unverified', reason: 'pull-request-not-awaiting-human-review' });
  });
});

describe('claim human-review handoff', () => {
  it('verifies a published, green claim PR held only by a required approving review', async () => {
    expect(await verify()).toEqual({ status: 'verified', taskId: task.id, agentId: agent.id, pullRequests: [
      { branch: 'claim/issue-42', number: 7, url: url(7), head, state: 'OPEN', awaitingHumanReview: true },
    ] });
    // The run's own binding and the forge decide; the agent's reason is never parsed.
    expect(readPullRequest).toHaveBeenCalledWith('claim/issue-42', expect.stringContaining('reviewDecision'),
      { repoPath: '/example/project', forgeAccount: 'configured-account', repoSpec: 'github.example.test/example/project' });
    expect(execGit).toHaveBeenCalledWith(['status', '--porcelain', '--untracked-files=no'], '/example/claim-42', { ignoreExitCode: true });
    expect(localReviewLifecycle).toHaveBeenCalledWith('/example/claim-42', { prUrl: url(7) });
  });

  it.each([
    ['an unsuccessful process', { success: false }],
    ['a completed report', { reportedOutcome: { status: 'completed', reason: 'Merged.' } }],
    ['an explicit approval request', { reportedOutcome: { ...reportedOutcome, recovery: { mode: 'approval', options: ['a', 'b'] } } }],
    ['a non-claim task', { task: { ...task, metadata: { app: 'example' } } }],
  ])('does not apply to %s', async (_label, extra) => {
    expect(await verify(extra)).toBeNull();
    expect(readPullRequest).not.toHaveBeenCalled();
  });

  it('applies to an incomplete report too, since a retry cannot supply the approval', async () => {
    expect(await verify({ reportedOutcome: { status: 'incomplete', reason: 'Waiting for approval.' } })).toMatchObject({ status: 'verified' });
  });

  it.each([
    ['task-binding-unverified', () => ({ agent: { ...agent, taskId: 'task-other' } })],
    ['claim-branches-unbound', () => ({ agent: { ...agent, metadata: { ...agent.metadata, claimBranches: [] } } })],
    ['repository-binding-unverified', () => { getAppDataForTask.mockResolvedValue({ repoPath: '/example/elsewhere' }); }],
    ['forge-unsupported', () => { getOriginInfo.mockResolvedValue({ host: 'gitlab.example.test', fullName: 'example/project' }); }],
    ['checkout-unavailable', () => { listWorktrees.mockRejectedValue(new Error('inventory unavailable')); }],
    ['claim-head-unavailable', () => { tips['claim/issue-42'] = ''; }],
    ['pull-request-head-unverified', () => { tips['claim/issue-42'] = otherHead; }],
    ['pull-request-head-unverified', () => { views['claim/issue-42'] = null; }],
    ['pull-request-head-unverified', () => { views['claim/issue-42'].isCrossRepository = true; }],
    ['pull-request-not-awaiting-human-review', () => { views['claim/issue-42'].reviewDecision = 'APPROVED'; }],
    ['pull-request-not-awaiting-human-review', () => { views['claim/issue-42'].reviewDecision = 'CHANGES_REQUESTED'; }],
    ['pull-request-not-awaiting-human-review', () => { views['claim/issue-42'].statusCheckRollup = [{ conclusion: 'FAILURE' }]; }],
    ['pull-request-not-awaiting-human-review', () => { views['claim/issue-42'].statusCheckRollup = [{ status: 'IN_PROGRESS', conclusion: '' }]; }],
    ['checkout-has-uncommitted-work', () => { dirt = ' M src/unfinished.js\n'; }],
    ['local-review-incomplete', () => { localReviewLifecycle.mockResolvedValue({ reusable: true, receipt: { status: 'review-blocked' } }); }],
    ['local-review-incomplete', () => { localReviewLifecycle.mockResolvedValue({ reusable: false, receipt: null }); }],
    ['checkout-unavailable', () => { listWorktrees.mockResolvedValue([{ branch: 'refs/heads/main', path: '/example/project' }]); }],
  ])('keeps the bounded retry when %s', async (reason, arrange) => {
    const extra = arrange() || {};
    expect(await verify(extra)).toEqual({ status: 'unverified', reason });
  });

  it('does not require a local review receipt when the policy merges on green', async () => {
    localReviewLifecycle.mockResolvedValue({ reusable: false, receipt: null });
    const mergeOnGreen = { ...task, metadata: { ...task.metadata, prCompletion: 'merge-on-green' } };
    expect(await verify({ task: mergeOnGreen })).toMatchObject({ status: 'verified' });
    expect(localReviewLifecycle).not.toHaveBeenCalled();
  });

  describe('a swarm with several bound claims', () => {
    const swarm = { ...agent, metadata: { ...agent.metadata, claimBranches: ['claim/issue-42', 'claim/issue-43'] } };

    it('verifies when every child is merged or waiting only on a human approval', async () => {
      views['claim/issue-43'] = view('claim/issue-43', 8, { state: 'MERGED' });
      expect(await verify({ agent: swarm })).toMatchObject({ status: 'verified', pullRequests: [
        { branch: 'claim/issue-42', state: 'OPEN', awaitingHumanReview: true },
        { branch: 'claim/issue-43', state: 'MERGED', number: 8 },
      ] });
    });

    it('keeps the retry when one child still has agent work', async () => {
      views['claim/issue-43'] = view('claim/issue-43', 8, { statusCheckRollup: [{ conclusion: 'FAILURE' }] });
      expect(await verify({ agent: swarm })).toEqual({ status: 'unverified', reason: 'pull-request-not-awaiting-human-review' });
    });

    it('leaves an all-merged result to the delivery verifiers', async () => {
      views['claim/issue-42'] = view('claim/issue-42', 7, { state: 'MERGED' });
      views['claim/issue-43'] = view('claim/issue-43', 8, { state: 'MERGED' });
      expect(await verify({ agent: swarm })).toEqual({ status: 'unverified', reason: 'no-pull-request-awaiting-human-review' });
    });
  });
});
