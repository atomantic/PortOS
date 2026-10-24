import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./agentAppWorkspace.js', () => ({ getAppDataForTask: vi.fn() }));
vi.mock('../lib/workTracker.js', () => ({ resolveAppForgeTarget: vi.fn() }));
vi.mock('./forgeAuth.js', () => ({ resolveForgeForRepo: vi.fn() }));
vi.mock('./github.js', () => ({ execGh: vi.fn() }));
vi.mock('./gitlab.js', () => ({ execGlab: vi.fn() }));

import { getAppDataForTask } from './agentAppWorkspace.js';
import { resolveAppForgeTarget } from '../lib/workTracker.js';
import { resolveForgeForRepo } from './forgeAuth.js';
import { execGh } from './github.js';
import { execGlab } from './gitlab.js';
import { verifyClaimDisposition } from './claimDisposition.js';

const target = { forge: 'github', fullName: 'example/project', webHost: 'github.example.test', apiHost: 'github.example.test', repoSpec: 'github.example.test/example/project' };
const task = { id: 'task-example', taskType: 'internal', metadata: { app: 'example', claimFlow: true, claimTarget: '42' } };
const agent = { id: 'agent-example', taskId: task.id, metadata: { sourceWorkspace: '/example/project' } };
const reportedOutcome = { status: 'no-action-needed', reason: 'Untrusted reason says this was delivered.' };
const merged = () => ({ __typename: 'PullRequest', number: 7, merged: true, mergedAt: '2026-10-01T10:00:00Z',
  baseRefName: 'main', baseRepository: { nameWithOwner: 'example/project' }, mergeCommit: { oid: 'a'.repeat(40) },
  closingIssuesReferences: { nodes: [{ number: 42, repository: { nameWithOwner: 'example/project' } }] } });
const closure = () => ({ actor: { login: 'example' }, createdAt: '2026-10-01T11:00:00Z', closer: null });
let repository;
const verify = (extra = {}) => verifyClaimDisposition({ task, agent, reportedOutcome, success: true, ...extra });

beforeEach(() => {
  vi.resetAllMocks();
  getAppDataForTask.mockResolvedValue({ repoPath: '/example/project', forgeAccount: 'configured-account' });
  resolveAppForgeTarget.mockResolvedValue({ tracker: 'github', target });
  resolveForgeForRepo.mockResolvedValue({ cli: 'gh', env: { GH_TOKEN: 'invented-test-token' } });
  repository = { nameWithOwner: 'example/project', defaultBranchRef: { name: 'main' },
    issue: { number: 42, state: 'CLOSED', stateReason: 'COMPLETED', repository: { nameWithOwner: 'example/project' },
      timelineItems: { nodes: [{ source: merged() }, closure()] } } };
  execGh.mockImplementation(async args => args[1] === 'graphql' ? JSON.stringify({ data: { repository } })
    : JSON.stringify({ login: 'configured-account' }));
});

describe('selected claim tracker completion', () => {
  it('verifies an exact closing PR merged into the configured default branch, including manual issue closure', async () => {
    expect(await verify()).toMatchObject({ status: 'verified', repository: 'github.example.test/example/project', taskId: task.id,
      issues: [{ disposition: 'delivered', issue: 42, changeRequest: 7, mergeCommit: 'a'.repeat(40), defaultBranch: 'main' }] });
    expect(resolveForgeForRepo).toHaveBeenCalledWith('/example/project', { forgeAccount: 'configured-account' });
    expect(execGh).toHaveBeenCalledWith(expect.arrayContaining(['--hostname', target.apiHost, 'number=42']), undefined,
      expect.objectContaining({ cwd: '/example/project', env: { GH_TOKEN: 'invented-test-token' } }));
    expect(execGh.mock.calls.every(([args]) => args[0] === 'api' && !args.includes('POST') && !args.includes('PATCH'))).toBe(true);
  });

  it('accepts an operator NOT_PLANNED disposition without manufacturing code delivery', async () => {
    repository.issue.stateReason = 'NOT_PLANNED';
    repository.issue.timelineItems.nodes = [closure()];
    expect(await verify()).toMatchObject({ status: 'verified', issues: [{ issue: 42, disposition: 'not-planned' }] });
    expect((await verify()).issues[0]).not.toHaveProperty('mergeCommit');
  });

  it('preserves delegated collaborator closure authority and rejects an untrusted invalidation', async () => {
    repository.issue.stateReason = 'NOT_PLANNED';
    repository.issue.timelineItems.nodes = [{ ...closure(), actor: { login: 'delegated-agent' } }];
    execGh.mockImplementation(async args => args[1] === 'graphql' ? JSON.stringify({ data: { repository } })
      : JSON.stringify(args.at(-1).includes('permission')
        ? { permission: 'write', user: { login: 'delegated-agent' } } : { login: 'configured-account' }));
    expect(await verify()).toMatchObject({ status: 'verified' });
    execGh.mockImplementation(async args => args[1] === 'graphql' ? JSON.stringify({ data: { repository } }) : '{}');
    expect(await verify()).toMatchObject({ status: 'unverified', reason: 'closure-authority-unverified' });
  });

  it.each([
    ['open issue', r => { r.issue.state = 'OPEN'; }],
    ['other issue', r => { r.issue.number = 43; }],
    ['other repository', r => { r.issue.repository.nameWithOwner = 'other/project'; }],
    ['unknown closure reason', r => { r.issue.stateReason = null; }],
    ['missing closure', r => { r.issue.timelineItems.nodes = []; }],
    ['unmerged PR', r => { r.issue.timelineItems.nodes[0].source.merged = false; }],
    ['PR targeting another branch', r => { r.issue.timelineItems.nodes[0].source.baseRefName = 'release'; }],
    ['PR targeting another repository', r => { r.issue.timelineItems.nodes[0].source.baseRepository.nameWithOwner = 'other/project'; }],
    ['mere cross-reference', r => { r.issue.timelineItems.nodes[0].source.closingIssuesReferences.nodes = []; }],
    ['closing another issue', r => { r.issue.timelineItems.nodes[0].source.closingIssuesReferences.nodes[0].number = 43; }],
    ['unproven merge commit', r => { r.issue.timelineItems.nodes[0].source.mergeCommit = null; }],
    ['closure before merge', r => { r.issue.timelineItems.nodes[0].source.mergedAt = '2026-10-02T00:00:00Z'; }],
  ])('refuses %s despite affirmative agent prose', async (_name, mutate) => {
    mutate(repository);
    expect(await verify()).toMatchObject({ status: 'unverified' });
  });

  it.each([
    ['missing target', { task: { ...task, metadata: { ...task.metadata, claimTarget: undefined } } }],
    ['a URL supplied as target', { task: { ...task, metadata: { ...task.metadata, claimTarget: 'https://github.example.test/other/project/issues/42' } } }],
    ['different task', { agent: { ...agent, taskId: 'other-task' } }],
    ['different source checkout', { agent: { ...agent, metadata: { sourceWorkspace: '/other/project' } } }],
  ])('refuses %s before querying the forge', async (_name, options) => {
    expect(await verify(options)).toMatchObject({ status: 'unverified' });
    expect(execGh).not.toHaveBeenCalled();
  });

  it('uses persisted selected child branches instead of a closed parent or arbitrary result target', async () => {
    const selected = { ...agent, metadata: { ...agent.metadata, claimBranches: ['claim/issue-43'] } };
    expect(await verify({ agent: selected, reportedOutcome: { ...reportedOutcome, issue: 42 } })).toMatchObject({ status: 'unverified' });
    expect(execGh.mock.calls[0][0]).toContain('number=43');
    expect(await verify({ task: { ...task, metadata: { ...task.metadata, claimTarget: undefined } },
      agent: { ...agent, metadata: { ...agent.metadata, claimBranches: ['claim/issue-42'] } } })).toMatchObject({ status: 'verified' });
  });

  it('requires all selected swarm issues, and refuses unrecognized bound branches', async () => {
    expect(await verify({ agent: { ...agent, metadata: { ...agent.metadata, claimBranches: ['claim/issue-42', 'claim/issue-43'] } } })).toMatchObject({ status: 'unverified' });
    expect(await verify({ agent: { ...agent, metadata: { ...agent.metadata, claimBranches: ['claim/unrecognized'] } } })).toMatchObject({ status: 'unverified' });
  });

  it('leaves unsupported trackers, malformed replies and GraphQL partial errors unverified', async () => {
    execGh.mockResolvedValue('not JSON');
    expect(await verify()).toMatchObject({ status: 'unverified' });
    execGh.mockResolvedValue(JSON.stringify({ data: { repository }, errors: [{ message: 'Partial data' }] }));
    expect(await verify()).toMatchObject({ status: 'unverified' });
    resolveAppForgeTarget.mockResolvedValue({ tracker: 'jira', target });
    expect(await verify()).toMatchObject({ status: 'unverified', reason: 'tracker-unsupported' });
  });

  it('does not grant ordinary shipping or failed runs a claim no-op criterion', async () => {
    expect(await verify({ reportedOutcome: { status: 'completed' } })).toBeNull();
    expect(await verify({ success: false })).toBeNull();
    expect(await verify({ task: { ...task, metadata: { app: 'example' } } })).toBeNull();
    expect(execGh).not.toHaveBeenCalled();
  });
});

describe('GitLab selected claim delivery', () => {
  const project = { id: 5, path_with_namespace: 'example/project', default_branch: 'main' };
  const issue = { iid: 42, project_id: 5, state: 'closed', closed_at: '2026-10-01T11:00:00Z' };
  const mr = { iid: 7, project_id: 5, target_project_id: 5, state: 'merged', target_branch: 'main',
    merge_commit_sha: 'b'.repeat(40), merged_at: '2026-10-01T10:00:00Z' };

  it('requires a same-project merged MR that explicitly closes this issue, and refuses unsupported closure-only claims', async () => {
    resolveAppForgeTarget.mockResolvedValue({ tracker: 'gitlab', target: { ...target, forge: 'gitlab' } });
    resolveForgeForRepo.mockResolvedValue({ cli: 'glab', env: { GITLAB_TOKEN: 'invented-token' } });
    let closes = [issue];
    execGlab.mockImplementation(async args => {
      const endpoint = args.at(-1);
      return JSON.stringify(endpoint.includes('closes_issues') ? closes
        : endpoint.includes('related_merge_requests') ? [mr] : endpoint.endsWith('/42') ? issue : project);
    });
    expect(await verify()).toMatchObject({ status: 'verified', tracker: 'gitlab', issues: [{ issue: 42, disposition: 'delivered', changeRequest: 7 }] });
    expect(execGlab.mock.calls[0]).toEqual([expect.arrayContaining(['--hostname', target.webHost, '--method', 'GET']),
      '/example/project', undefined, { env: { GITLAB_TOKEN: 'invented-token' } }]);
    closes = [{ ...issue, project_id: 6 }];
    expect(await verify()).toMatchObject({ status: 'unverified', reason: 'merged-delivery-unverified' });
    closes = [];
    expect(await verify()).toMatchObject({ status: 'unverified' });
  });
});
