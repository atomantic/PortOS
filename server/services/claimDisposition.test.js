import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./agent/agentAppWorkspace.js', () => ({ getAppDataForTask: vi.fn() }));
vi.mock('../lib/workTracker.js', () => ({ resolveAppForgeTarget: vi.fn() }));
vi.mock('./forgeAuth.js', () => ({ resolveForgeForRepo: vi.fn() }));
vi.mock('./github.js', () => ({ execGh: vi.fn() }));
vi.mock('./gitlab.js', () => ({ execGlab: vi.fn() }));
vi.mock('./worktreeManager.js', () => ({ listWorktrees: vi.fn() }));
vi.mock('../lib/execGit.js', () => ({ execGit: vi.fn() }));

import { getAppDataForTask } from './agent/agentAppWorkspace.js';
import { resolveAppForgeTarget } from '../lib/workTracker.js';
import { resolveForgeForRepo } from './forgeAuth.js';
import { execGh } from './github.js';
import { execGlab } from './gitlab.js';
import { execGit } from '../lib/execGit.js';
import { listWorktrees } from './worktreeManager.js';
import { verifyClaimDisposition, verifyCleanupClaimDisposition } from './claimDisposition.js';
import { buildMainRedIssueBody, mainHealthRecoveryLine } from '../../scripts/ci-nightly-report.js';

const target = { forge: 'github', fullName: 'example/project', webHost: 'github.example.test', apiHost: 'github.example.test', repoSpec: 'github.example.test/example/project' };
const task = { id: 'task-example', taskType: 'internal', metadata: { app: 'example', claimFlow: true, claimTarget: '42' } };
const agent = { id: 'agent-example', taskId: task.id, metadata: { sourceWorkspace: '/example/project', workspacePath: '/example/claim', claimBranches: ['claim/issue-42'] } };
const reportedOutcome = { status: 'no-action-needed', reason: 'Untrusted reason says this was delivered.' };
const merged = () => ({ __typename: 'PullRequest', number: 7, merged: true, mergedAt: '2026-10-01T10:00:00Z',
  baseRefName: 'main', baseRepository: { nameWithOwner: 'example/project' }, mergeCommit: { oid: 'a'.repeat(40) },
  closingIssuesReferences: { nodes: [{ number: 42, repository: { nameWithOwner: 'example/project' } }] } });
const closure = () => ({ __typename: 'ClosedEvent', actor: { login: 'example' }, createdAt: '2026-10-01T11:00:00Z', closer: null });
const parkIssue = (label = 'blocked') => {
  repository.issue.state = 'OPEN';
  repository.issue.labels = { nodes: [{ name: label }] };
  repository.issue.timelineItems.nodes = [{ __typename: 'LabeledEvent', actor: { login: 'example' },
    createdAt: '2026-10-01T11:00:00Z', label: { name: label } }];
};
let repository;
const verify = (extra = {}) => verifyClaimDisposition({ task, agent, reportedOutcome, success: true, ...extra });

beforeEach(() => {
  vi.resetAllMocks();
  listWorktrees.mockResolvedValue([{ branch: 'refs/heads/claim/issue-42', path: '/example/claim' }]);
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

  it.each([['absent', undefined], ['empty', []]])('settles an unbound park without inspecting unrelated dirty primary work (%s bindings)', async (_name, claimBranches) => {
    parkIssue();
    listWorktrees.mockResolvedValue([
      { branch: 'refs/heads/main', path: '/example/project' },
      { branch: 'refs/heads/claim/issue-43', path: '/example/other-claim' },
    ]);
    execGit.mockResolvedValue({ exitCode: 0, stdout: ' M unrelated.js' });
    const unbound = { ...agent, metadata: { ...agent.metadata, workspacePath: '/example/project', claimBranches } };
    expect(await verify({ agent: unbound })).toMatchObject({
      status: 'verified', issues: [{ issue: 42, disposition: 'operator-blocked' }],
    });
    expect(listWorktrees).toHaveBeenCalledWith('/example/project');
    expect(execGit).not.toHaveBeenCalled();
  });

  it('refuses an unbound park when the selected issue still holds a claim worktree', async () => {
    parkIssue();
    const unbound = { ...agent, metadata: { ...agent.metadata, claimBranches: [] } };
    expect(await verify({ agent: unbound })).toMatchObject({
      status: 'unverified', reason: 'checkout-has-undelivered-work',
    });
    expect(execGit).not.toHaveBeenCalled();
  });

  it('refuses an unbound park when worktree inventory is unavailable', async () => {
    parkIssue();
    listWorktrees.mockRejectedValueOnce(new Error('inventory unavailable'));
    const unbound = { ...agent, metadata: { ...agent.metadata, claimBranches: [] } };
    expect(await verify({ agent: unbound })).toMatchObject({ status: 'unverified', reason: 'checkout-unavailable' });
    expect(execGit).not.toHaveBeenCalled();
  });

  // The claim prompt's Phase 3 parks with needs-input and calls it converging.
  // Rejecting it retried a settled claim until its recovery budget ran out.
  it('settles the needs-input park under the same authority and checkout gates', async () => {
    parkIssue('needs-input');
    expect(await verify()).toMatchObject({ status: 'verified', issues: [{ issue: 42, disposition: 'operator-blocked' }] });

    execGit.mockResolvedValueOnce({ exitCode: 0, stdout: ' M example.js' });
    expect(await verify()).toMatchObject({ status: 'unverified', reason: 'checkout-has-undelivered-work' });

    repository.issue.timelineItems.nodes.push({ ...repository.issue.timelineItems.nodes[0], actor: { login: 'outside-contributor' } });
    expect(await verify()).toMatchObject({ status: 'unverified', reason: 'block-authority-unverified' });
  });

  it('ignores an earlier park label that is no longer applied', async () => {
    parkIssue('blocked');
    repository.issue.timelineItems.nodes.push({ __typename: 'LabeledEvent', actor: { login: 'outside-contributor' },
      createdAt: '2026-10-01T11:30:00Z', label: { name: 'needs-input' } },
    { __typename: 'UnlabeledEvent', actor: { login: 'example' }, createdAt: '2026-10-01T11:40:00Z', label: { name: 'needs-input' } });
    expect(await verify()).toMatchObject({ status: 'verified', issues: [{ blockedBy: 'example' }] });
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

  it('reads parked issue evidence for a completed cleanup owner without converting its outcome', async () => {
    parkIssue();
    const outcome = { status: 'incomplete', recovery: { mode: 'cleanup' } };
    const owner = { ...agent, status: 'completed', metadata: { ...agent.metadata, isWorktree: false, configClaimFlow: true,
      claimBranches: ['claim/issue-42'], checkoutSeeds: [{ agentId: agent.id, branch: 'claim/issue-42',
        repoPath: '/example/project', path: '/example/claim' }] },
    result: { executionSuccess: true, deliveryRecoveryOwned: true, cleanupPending: true, taskOutcome: outcome } };
    expect(await verifyCleanupClaimDisposition({ task, agent: owner })).toMatchObject({ status: 'verified',
      issues: [{ issue: 42, disposition: 'operator-blocked' }] });
    expect(owner.result.taskOutcome).toEqual(outcome);
    owner.metadata.executionInterruption = { reason: 'interrupted' };
    expect(await verifyCleanupClaimDisposition({ task, agent: owner })).toBeNull();
    delete owner.metadata.executionInterruption;
    owner.result.executionSuccess = false;
    expect(await verifyCleanupClaimDisposition({ task, agent: owner })).toBeNull();
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
    listWorktrees.mockResolvedValue([42, 43].map(number => ({ branch: `refs/heads/claim/issue-${number}`, path: `/example/child-${number}` })));
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
    expect(await verify({ agent: selected })).toMatchObject({ status: 'verified' });
    listWorktrees.mockRejectedValueOnce(new Error('inventory unavailable'));
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
    ['missing target', { agent: { ...agent, metadata: { ...agent.metadata, claimBranches: [] } }, task: { ...task, metadata: { ...task.metadata, claimTarget: undefined } } }],
    ['a URL supplied as target', { agent: { ...agent, metadata: { ...agent.metadata, claimBranches: [] } }, task: { ...task, metadata: { ...task.metadata, claimTarget: 'https://github.example.test/other/project/issues/42' } } }],
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

  it.each(['blocked', 'needs-input'])('verifies a GitLab %s park with trusted current label and clean contained checkout', async label => {
    resolveAppForgeTarget.mockResolvedValue({ tracker: 'gitlab', target: { ...target, forge: 'gitlab' } });
    resolveForgeForRepo.mockResolvedValue({ cli: 'glab' });
    let current = { ...issue, state: 'opened', labels: [label] };
    let events = [{ id: 1, action: 'add', label: { name: label }, user: { id: 9, username: 'operator' }, created_at: '2026-10-01T11:00:00Z' }];
    let member = { id: 9, access_level: 30 };
    execGlab.mockImplementation(async args => {
      const endpoint = args.at(-1);
      return JSON.stringify(endpoint.includes('resource_label_events') ? events
        : endpoint.includes('/members/all/') ? member : endpoint.includes('/repository/branches/') ? { commit: { id: 'c'.repeat(40) } }
          : endpoint.endsWith('/42') ? current : project);
    });
    expect(await verify()).toMatchObject({ status: 'verified', issues: [{ disposition: 'operator-blocked', blockedBy: 'operator' }] });
    const event = events[0];
    events = [];
    expect(await verify()).toMatchObject({ status: 'unverified' });
    events = [{ ...event, action: 'remove' }];
    expect(await verify()).toMatchObject({ status: 'unverified' });
    events = [event];
    member = { id: 9, access_level: 20 };
    expect(await verify()).toMatchObject({ status: 'unverified' });
    member = null;
    expect(await verify()).toMatchObject({ status: 'unverified' });
    member = { id: 9, access_level: 30 };
    current = { ...current, labels: [] };
    expect(await verify()).toMatchObject({ status: 'unverified' });
    current = { ...current, labels: [label] };
    execGit.mockResolvedValueOnce({ exitCode: 0, stdout: ' M file' });
    expect(await verify()).toMatchObject({ status: 'unverified', reason: 'checkout-has-undelivered-work' });
    execGit.mockResolvedValueOnce({ exitCode: 0, stdout: '' }).mockResolvedValueOnce({ exitCode: 1, stdout: '' });
    expect(await verify()).toMatchObject({ status: 'unverified', reason: 'checkout-has-undelivered-work' });
  });

  it('proves remote GitLab ancestry using compare and merge base', async () => {
    resolveAppForgeTarget.mockResolvedValue({ tracker: 'gitlab', target: { ...target, forge: 'gitlab' } });
    resolveForgeForRepo.mockResolvedValue({ cli: 'glab' });
    const head = 'd'.repeat(40);
    let base = head;
    execGit.mockImplementation(async args => args[0] === 'status' ? { exitCode: 0, stdout: '' }
      : args[0] === 'rev-parse' ? { exitCode: 0, stdout: head } : { exitCode: 128, stdout: '' });
    execGlab.mockImplementation(async args => {
      const endpoint = args.at(-1);
      return JSON.stringify(endpoint.includes('resource_label_events') ? [{ id: 1, action: 'add', label: { name: 'blocked' }, user: { id: 9 }, created_at: '2026-10-01T11:00:00Z' }]
        : endpoint.includes('/members/all/') ? { id: 9, access_level: 30 }
          : endpoint.includes('/repository/branches/') ? { commit: { id: 'c'.repeat(40) } }
            : endpoint.includes('/repository/compare?') ? { commit: { id: 'c'.repeat(40) } }
              : endpoint.includes('/repository/merge_base?') ? { id: base }
                : endpoint.endsWith('/42') ? { ...issue, state: 'opened', labels: ['blocked'] } : project);
    });
    expect(await verify()).toMatchObject({ status: 'verified' });
    expect(execGlab).toHaveBeenCalledWith(expect.arrayContaining([`projects/example%2Fproject/repository/compare?from=${head}&to=${'c'.repeat(40)}`]), '/example/project', undefined, expect.anything());
    base = 'e'.repeat(40);
    expect(await verify()).toMatchObject({ status: 'unverified', reason: 'checkout-has-undelivered-work' });
  });

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

describe('Main health incident closure', () => {
  const ciSha = 'd'.repeat(40);
  const ciRunUrl = 'https://github.example.test/example/project/actions/runs/500';
  const bot = { login: 'github-actions[bot]', type: 'Bot' };
  let forge;
  const incidentBody = () => `${buildMainRedIssueBody({ failedJobs: [], base: null, head: 'e'.repeat(40),
    runUrl: 'https://github.example.test/example/project/actions/runs/400', compareBase: 'https://github.example.test/example/project/compare' })}\n\n${mainHealthRecoveryLine(ciSha, ciRunUrl)}`;
  const repoMeta = { full_name: 'example/project' };
  const run = extra => ({ repository: repoMeta, head_repository: repoMeta, head_branch: 'main', head_sha: ciSha,
    status: 'completed', conclusion: 'success', ...extra });

  beforeEach(() => {
    repository.issue.timelineItems.nodes = [{ __typename: 'ClosedEvent', actor: { login: 'github-actions' },
      createdAt: '2026-10-01T11:00:05Z', closer: null }];
    forge = {
      issue: { number: 42, title: 'main is red', state: 'closed', state_reason: 'completed', user: bot, closed_by: bot,
        closed_at: '2026-10-01T11:00:05Z', labels: [{ name: 'area:ci' }], body: incidentBody() },
      ci: run({ id: 500, path: '.github/workflows/ci.yml', event: 'push', run_started_at: '2026-10-01T10:50:00Z' }),
      compare: { status: 'ahead' },
      monitors: { total_count: 1, workflow_runs: [run({ id: 600, path: '.github/workflows/main-health.yml',
        event: 'workflow_run', created_at: '2026-10-01T11:00:00Z' })] },
      jobs: { total_count: 1, jobs: [{ run_id: 600, name: 'Update the main-is-red issue', head_sha: ciSha,
        status: 'completed', conclusion: 'success', started_at: '2026-10-01T11:00:02Z', completed_at: '2026-10-01T11:00:09Z' }] },
    };
    execGh.mockImplementation(async args => {
      if (args[1] === 'graphql') return JSON.stringify({ data: { repository } });
      const endpoint = args.at(-1);
      const reply = endpoint === 'repos/example/project/issues/42' ? forge.issue
        : endpoint === 'repos/example/project/actions/runs/500' ? forge.ci
        : endpoint === `repos/example/project/compare/${ciSha}...${'c'.repeat(40)}` ? forge.compare
        : endpoint === `repos/example/project/actions/workflows/main-health.yml/runs?head_sha=${ciSha}&event=workflow_run&per_page=100` ? forge.monitors
        : endpoint === 'repos/example/project/actions/runs/600/jobs?filter=all&per_page=100' ? forge.jobs
        : { message: 'Not Found' };
      return JSON.stringify(reply);
    });
  });

  it('settles a no-code claim when the verified Main health workflow closed the incident after green CI', async () => {
    const result = await verify();
    expect(result).toMatchObject({ status: 'verified', issues: [{ issue: 42, disposition: 'ci-recovered',
      closedBy: 'github-actions', ciRun: 500, ciCommit: ciSha, monitorRun: 600, defaultCommit: 'c'.repeat(40) }] });
    expect(result.issues[0]).not.toHaveProperty('mergeCommit');
    // No code shipped, so the bound claim checkout must be clean and contained.
    expect(execGit.mock.calls).toEqual([
      [['status', '--porcelain', '--untracked-files=all'], '/example/claim'],
      [['merge-base', '--is-ancestor', 'HEAD', 'c'.repeat(40)], '/example/claim', { ignoreExitCode: true }],
    ]);
    // The bot is never asked for collaborator authority, and nothing is written.
    expect(execGh.mock.calls.some(([args]) => args.at(-1).includes('/collaborators/'))).toBe(false);
    expect(execGh.mock.calls.every(([args]) => args[0] === 'api' && !args.includes('POST') && !args.includes('PATCH'))).toBe(true);
    // A retry sees the same closure and settles identically.
    expect(await verify()).toEqual(result);
  });

  it('keeps undelivered claim work from settling behind a CI recovery', async () => {
    execGit.mockResolvedValue({ exitCode: 0, stdout: ' M example.js' });
    expect(await verify()).toMatchObject({ status: 'unverified', reason: 'checkout-has-undelivered-work' });
    execGit.mockImplementation(async args => ({ exitCode: args[0] === 'merge-base' ? 1 : 0, stdout: '' }));
    expect(await verify()).toMatchObject({ status: 'unverified', reason: 'checkout-has-undelivered-work' });
  });

  it.each([
    ['an issue a person opened', f => { f.issue.user = { login: 'outside-contributor', type: 'User' }; }],
    ['another title', f => { f.issue.title = 'main is red again'; }],
    ['a REST closer other than the bot', f => { f.issue.closed_by = { login: 'outside-contributor', type: 'User' }; }],
    ['a different closure time', f => { f.issue.closed_at = '2026-10-01T12:00:00Z'; }],
    ['a not-planned closure', f => { f.issue.state_reason = 'not_planned'; }],
    ['a missing recovery line', f => { f.issue.body = f.issue.body.replace(/\n\nGreen again.*$/, ''); }],
    ['a recovery line that is not the last line', f => { f.issue.body += '\n\nEdited afterwards.'; }],
    ['a run in another repository', f => { f.issue.body = f.issue.body.replace(ciRunUrl, 'https://github.example.test/other/project/actions/runs/500'); }],
    ['a run on another host', f => { f.issue.body = f.issue.body.replace(ciRunUrl, 'https://forge.example.test/example/project/actions/runs/500'); }],
    ['a label and matching text alone', f => { f.ci = { message: 'Not Found' }; }],
    ['a failed CI run', f => { f.ci.conclusion = 'failure'; }],
    ['an unfinished CI run', f => { f.ci.status = 'in_progress'; }],
    ['a CI run on another branch', f => { f.ci.head_branch = 'release'; }],
    ['a pull-request CI run', f => { f.ci.event = 'pull_request'; }],
    ['another workflow named as CI', f => { f.ci.path = '.github/workflows/other.yml'; }],
    ['a CI run from a fork', f => { f.ci.head_repository = { full_name: 'fork/project' }; }],
    ['a CI commit that does not match the recovery line', f => { f.ci.head_sha = 'f'.repeat(40); }],
    ['a CI commit the default branch no longer contains', f => { f.compare = { status: 'diverged' }; }],
    ['no Main health run', f => { f.monitors = { total_count: 0, workflow_runs: [] }; }],
    ['an unreadable Main health listing', f => { f.monitors = { message: 'Server Error' }; }],
    ['a truncated Main health listing', f => { f.monitors.total_count = 101; }],
    ['another workflow as the monitor', f => { f.monitors.workflow_runs[0].path = '.github/workflows/triage.yml'; }],
    ['a monitor run for another commit', f => { f.monitors.workflow_runs[0].head_sha = 'f'.repeat(40); }],
    ['a monitor triggered another way', f => { f.monitors.workflow_runs[0].event = 'issues'; }],
    ['a closure outside the report job', f => { f.jobs.jobs[0].completed_at = '2026-10-01T11:00:04Z'; }],
    ['a failed report job', f => { f.jobs.jobs[0].conclusion = 'failure'; }],
    ['another job in the monitor run', f => { f.jobs.jobs[0].name = 'Triage issues'; }],
    ['two report jobs covering the closure', f => { f.jobs.total_count = 2; f.jobs.jobs.push({ ...f.jobs.jobs[0] }); }],
  ])('fails closed on %s', async (_name, mutate) => {
    mutate(forge);
    const result = await verify();
    expect(result).toMatchObject({ status: 'unverified' });
    expect(result.reason).toMatch(/^main-health-/);
  });

  it('grants a bot closure no authority without Actions evidence, and keeps operator and PR closures unchanged', async () => {
    execGh.mockImplementation(async args => args[1] === 'graphql' ? JSON.stringify({ data: { repository } }) : '{}');
    expect(await verify()).toMatchObject({ status: 'unverified', reason: 'main-health-incident-unverified' });
    repository.issue.timelineItems.nodes = [{ ...closure(), actor: { login: 'outside-contributor' } }];
    expect(await verify()).toMatchObject({ status: 'unverified', reason: 'closure-authority-unverified' });
    repository.issue.timelineItems.nodes = [{ source: merged() }, { ...closure(), actor: { login: 'github-actions' } }];
    expect(await verify()).toMatchObject({ status: 'verified', issues: [{ issue: 42, disposition: 'delivered', changeRequest: 7 }] });
  });
});
