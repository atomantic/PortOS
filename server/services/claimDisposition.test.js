import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./agentAppWorkspace.js', () => ({ getAppDataForTask: vi.fn() }));
vi.mock('../lib/workTracker.js', () => ({ resolveAppForgeTarget: vi.fn() }));
vi.mock('./forgeAuth.js', () => ({ resolveForgeForRepo: vi.fn() }));
vi.mock('./github.js', () => ({ execGh: vi.fn() }));
vi.mock('./gitlab.js', () => ({ execGlab: vi.fn() }));
vi.mock('../lib/execGit.js', () => ({ execGit: vi.fn() }));

import { getAppDataForTask } from './agentAppWorkspace.js';
import { resolveAppForgeTarget } from '../lib/workTracker.js';
import { resolveForgeForRepo } from './forgeAuth.js';
import { execGh } from './github.js';
import { execGlab } from './gitlab.js';
import { execGit } from '../lib/execGit.js';
import { verifyClaimDisposition } from './claimDisposition.js';

const target = { forge: 'github', fullName: 'example/project', webHost: 'github.example.test', apiHost: 'github.example.test', repoSpec: 'github.example.test/example/project' };
const task = { id: 'task-example', taskType: 'internal', metadata: { app: 'example', claimFlow: true, claimTarget: '42' } };
const agent = { id: 'agent-example', taskId: task.id, metadata: { sourceWorkspace: '/example/project', workspacePath: '/example/claim' } };
const reportedOutcome = { status: 'no-action-needed', reason: 'Untrusted reason says this was delivered.' };
const merged = () => ({ __typename: 'PullRequest', number: 7, merged: true, mergedAt: '2026-10-01T10:00:00Z',
  baseRefName: 'main', baseRepository: { nameWithOwner: 'example/project' }, mergeCommit: { oid: 'a'.repeat(40) },
  closingIssuesReferences: { nodes: [{ number: 42, repository: { nameWithOwner: 'example/project' } }] } });
const closure = () => ({ __typename: 'ClosedEvent', actor: { login: 'example' }, createdAt: '2026-10-01T11:00:00Z', closer: null });
const parkIssue = () => {
  repository.issue.state = 'OPEN';
  repository.issue.labels = { nodes: [{ name: 'blocked' }] };
  repository.issue.timelineItems.nodes = [{ __typename: 'LabeledEvent', actor: { login: 'example' },
    createdAt: '2026-10-01T11:00:00Z', label: { name: 'blocked' } }];
};
let repository;
const verify = (extra = {}) => verifyClaimDisposition({ task, agent, reportedOutcome, success: true, ...extra });

beforeEach(() => {
  vi.resetAllMocks();
  getAppDataForTask.mockResolvedValue({ repoPath: '/example/project', forgeAccount: 'configured-account' });
  resolveAppForgeTarget.mockResolvedValue({ tracker: 'github', target });
  resolveForgeForRepo.mockResolvedValue({ cli: 'gh', env: { GH_TOKEN: 'invented-test-token' } });
  repository = { nameWithOwner: 'example/project', defaultBranchRef: { name: 'main', target: { oid: 'c'.repeat(40) } },
    issue: { number: 42, state: 'CLOSED', stateReason: 'COMPLETED', repository: { nameWithOwner: 'example/project' },
      timelineItems: { nodes: [{ source: merged() }, closure()] } } };
  execGh.mockImplementation(async args => args[1] === 'graphql' ? JSON.stringify({ data: { repository } })
    : JSON.stringify({ login: 'configured-account' }));
  execGit.mockResolvedValue({ exitCode: 0, stdout: '' });
});

describe('selected claim tracker completion', () => {
  it.each(['no-action-needed', 'blocked'])('settles a reported %s when an operator parked the open issue and no code remains to deliver', async status => {
    parkIssue();
    expect(await verify({ reportedOutcome: { status, reason: 'Wait for new reproduction evidence.' } })).toMatchObject({
      status: 'verified', issues: [{ issue: 42, disposition: 'operator-blocked', blockedBy: 'example' }] });
    expect(execGit.mock.calls).toEqual([
      [['status', '--porcelain', '--untracked-files=all'], '/example/claim'],
      [['merge-base', '--is-ancestor', 'HEAD', 'c'.repeat(40)], '/example/claim', { ignoreExitCode: true }],
    ]);
    expect(repository.issue.state).toBe('OPEN');
  });

  it.each([
    ['missing event', r => { r.issue.timelineItems.nodes = []; }],
    ['removed label', r => { r.issue.labels.nodes = []; }],
    ['latest removal', r => { r.issue.timelineItems.nodes.push({ ...r.issue.timelineItems.nodes[0], __typename: 'UnlabeledEvent' }); }],
    ['untrusted latest actor', r => { r.issue.timelineItems.nodes.push({ ...r.issue.timelineItems.nodes[0], actor: { login: 'outside-contributor' } }); }],
    ['invalid event time', r => { r.issue.timelineItems.nodes[0].createdAt = 'unknown'; }],
    ['unknown default head', r => { r.defaultBranchRef.target = null; }],
  ])('does not accept an open issue with %s', async (_name, mutate) => {
    parkIssue();
    mutate(repository);
    expect(await verify()).toMatchObject({ status: 'unverified' });
  });

  it.each([
    ['uncommitted work', { exitCode: 0, stdout: ' M example.js' }],
    ['unmerged commits', { exitCode: 1, stdout: '' }],
    ['unavailable default commit', { exitCode: 128, stdout: '' }],
  ])('preserves %s despite an operator parking the issue', async (_name, result) => {
    parkIssue();
    execGit.mockImplementation(async args => args[0] === 'status' && result.exitCode !== 0
      ? { exitCode: 0, stdout: '' } : result);
    expect(await verify()).toMatchObject({ status: 'unverified', reason: 'checkout-has-undelivered-work' });
  });

  it('keeps explicit runtime and approval recovery separate from a parked issue', async () => {
    parkIssue();
    for (const mode of ['runtime', 'approval', 'cleanup']) {
      expect(await verify({ reportedOutcome: { status: 'blocked', reason: 'Unmet prerequisite.', recovery: { mode } } })).toBeNull();
    }
    expect(execGh).not.toHaveBeenCalled();
  });

  it('verifies exact remote ancestry when the live default head has not been fetched locally', async () => {
    parkIssue();
    const head = 'd'.repeat(40);
    execGit.mockImplementation(async args => args[0] === 'status' ? { exitCode: 0, stdout: '' }
      : args[0] === 'rev-parse' ? { exitCode: 0, stdout: head } : { exitCode: 128, stdout: '' });
    let comparison = { status: 'ahead', base_commit: { sha: head }, merge_base_commit: { sha: head } };
    execGh.mockImplementation(async args => JSON.stringify(args[1] === 'graphql' ? { data: { repository } }
      : args.at(-1).includes('/compare/') ? comparison : { login: 'configured-account' }));
    expect(await verify()).toMatchObject({ status: 'verified' });
    expect(execGh).toHaveBeenCalledWith(expect.arrayContaining([
      `repos/example/project/compare/${head}...${'c'.repeat(40)}`,
    ]), undefined, expect.objectContaining({ cwd: '/example/project' }));
    comparison = { ...comparison, status: 'diverged' };
    expect(await verify()).toMatchObject({ status: 'unverified' });
    comparison = { ...comparison, status: 'ahead', merge_base_commit: { sha: 'e'.repeat(40) } };
    expect(await verify()).toMatchObject({ status: 'unverified' });
  });

  it('checks bound swarm children instead of accepting the clean coordinator checkout', async () => {
    parkIssue();
    const selected = { ...agent, metadata: { ...agent.metadata, claimBranches: ['claim/issue-42', 'claim/issue-43'],
      checkoutSeeds: [42, 43].map(number => ({ agentId: agent.id, branch: `claim/issue-${number}`,
        repoPath: '/example/project', path: `/example/child-${number}` })) } };
    execGh.mockImplementation(async args => {
      if (args[1] !== 'graphql') return JSON.stringify({ login: 'configured-account' });
      return JSON.stringify({ data: { repository: { ...repository, issue: { ...repository.issue,
        number: Number(args.find(arg => arg.startsWith('number=')).split('=')[1]) } } } });
    });
    execGit.mockImplementation(async (args, cwd) => ({ exitCode: 0,
      stdout: args[0] === 'status' && cwd === '/example/child-43' ? ' M example.js' : '' }));
    expect(await verify({ agent: selected })).toMatchObject({ status: 'unverified', reason: 'checkout-has-undelivered-work' });
    execGit.mockResolvedValue({ exitCode: 0, stdout: '' });
    expect(await verify({ agent: selected })).toMatchObject({ status: 'verified' });
    selected.metadata.checkoutSeeds = [];
    expect(await verify({ agent: selected })).toMatchObject({ status: 'unverified', reason: 'checkout-unavailable' });
  });

  it('verifies an exact closing PR merged into the configured default branch, including manual issue closure', async () => {
    repository.issue.timelineItems.nodes.push({ __typename: 'UnlabeledEvent', actor: { login: 'outside-contributor' },
      createdAt: '2026-10-02T11:00:00Z', label: null });
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

  it('settles a trusted manual COMPLETED closure even when shipped work has no closing-keyword link', async () => {
    repository.issue.timelineItems.nodes[0].source.closingIssuesReferences.nodes = [];
    const result = await verify();
    expect(result).toMatchObject({ status: 'verified', issues: [{ issue: 42, disposition: 'operator-closed', closedBy: 'example' }] });
    expect(result.issues[0]).not.toHaveProperty('mergeCommit');
    expect(result.issues[0]).not.toHaveProperty('changeRequest');
    // Later retries see only the same closure; no PR or new agent is needed.
    repository.issue.timelineItems.nodes = [closure()];
    expect(await verify()).toEqual(result);
  });

  it('requires authority from the latest manual closure, ignoring earlier trusted closures', async () => {
    repository.issue.timelineItems.nodes = [closure(), { ...closure(),
      createdAt: '2026-10-02T11:00:00Z', actor: { login: 'outside-contributor' } }];
    execGh.mockImplementation(async args => args[1] === 'graphql' ? JSON.stringify({ data: { repository } }) : '{}');
    expect(await verify()).toMatchObject({ status: 'unverified', reason: 'closure-authority-unverified' });
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
    // An automatic PR closure must still satisfy the exact delivery contract.
    repository.issue.timelineItems.nodes[1].closer = repository.issue.timelineItems.nodes[0].source;
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

  it('requires a same-project merged MR that explicitly closes this issue, or a verified operator closure', async () => {
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

  it('verifies the GitLab closer through inherited project membership, and refuses read-only or mismatched members', async () => {
    resolveAppForgeTarget.mockResolvedValue({ tracker: 'gitlab', target: { ...target, forge: 'gitlab' } });
    resolveForgeForRepo.mockResolvedValue({ cli: 'glab' });
    let member = { id: 9, access_level: 30 };
    let requests = [];
    execGlab.mockImplementation(async args => {
      const endpoint = args.at(-1);
      return JSON.stringify(endpoint.includes('/members/all/') ? member
        : endpoint.includes('related_merge_requests') ? requests : endpoint.endsWith('/42') ? { ...issue, closed_by: { id: 9 } } : project);
    });
    const result = await verify();
    expect(result).toMatchObject({ status: 'verified', issues: [{ issue: 42, disposition: 'operator-closed' }] });
    expect(result.issues[0]).not.toHaveProperty('mergeCommit');
    member = { id: 9, access_level: 20 };
    expect(await verify()).toMatchObject({ status: 'unverified', reason: 'closure-authority-unverified' });
    member = { id: 10, access_level: 50 };
    expect(await verify()).toMatchObject({ status: 'unverified', reason: 'closure-authority-unverified' });
    member = { id: 9, access_level: 40 };
    requests = [{ ...mr, target_branch: 'release' }];
    expect(await verify()).toMatchObject({ status: 'unverified', reason: 'merged-delivery-unverified' });
  });
});
