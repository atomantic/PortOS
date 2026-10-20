import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { generateTasksMarkdown, parseTasksMarkdown } from '../lib/taskParser.js';
import { forkLocalBranch } from '../lib/forkHead.js';
import { parsePullRequestUrl } from '../lib/gitForge.js';

const f = vi.hoisted(() => ({ state: null, disk: null, tasks: {}, branch: 'feature/fix', workspaceRepo: 'example/repo', originHost: 'github.com', row: null, head: null, upstream: null, remote: null, pushRemote: null }));
vi.mock('./cosState.js', () => ({
  AGENTS_DIR: '/synthetic/agents',
  withStateLock: createFileWriteQueue(),
  loadState: async () => f.state,
  saveState: async state => { f.state = state; f.disk = structuredClone(state); },
  readMergeAdmissionStateForSafetyCheck: async () => ({ trusted: true, ...structuredClone(f.disk) }),
}));
vi.mock('./cosEvents.js', () => ({ cosEvents: { emit: vi.fn() }, emitLog: vi.fn() }));
vi.mock('./cos.js', () => ({
  addTask: async task => { f.tasks[task.id] = { ...parseTasksMarkdown(generateTasksMarkdown([task]))[0], taskType: 'internal' }; return task; },
  forceSpawnTask: vi.fn(), getAgents: async () => [], updateTask: vi.fn(),
}));
vi.mock('./cosTaskStore.js', () => ({ getTaskById: async id => f.tasks[id] }));
vi.mock('../lib/gitRemote.js', async importOriginal => ({ ...(await importOriginal()),
  getOriginInfo: async path => ({ host: f.originHost, fullName: path === '/repos/worktree' ? f.workspaceRepo : 'example/repo' }) }));
vi.mock('./github.js', () => ({ execGh: vi.fn(async () => JSON.stringify(f.row)) }));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: async () => ({ cwd: '/repos/source', env: {} }) }));
vi.mock('./apps.js', () => ({ getAppById: async () => null }));
vi.mock('./agentAppWorkspace.js', () => ({ getAppWorkspace: async () => '/repos/source', getAppDataForTask: async () => null }));
vi.mock('../lib/spawnCwd.js', async importOriginal => ({ ...(await importOriginal()), resolveSpawnCwd: path => path }));
vi.mock('./taskConflict.js', () => ({ detectConflicts: vi.fn() }));
vi.mock('../lib/execGit.js', () => ({ execGit: async args => {
  let stdout;
  if (args[0] === 'symbolic-ref') stdout = f.branch;
  if (args[0] === 'rev-parse') stdout = f.head;
  if (args[0] === 'remote') stdout = args.includes('--push') ? f.pushRemote : f.remote;
  if (args[0] === 'config') stdout = args[2].endsWith('.remote') ? f.upstream.remote : f.upstream.merge;
  if (typeof stdout !== 'string') throw new Error('unreadable git fixture');
  return { stdout, exitCode: 0 };
} }));
vi.mock('./git.js', () => ({ parsePullRequestUrl, isRepo: async () => true, getRepoBranches: async () => ({ baseBranch: 'main' }) }));
vi.mock('./worktreeManager.js', () => ({ removeWorktree: vi.fn(), classifyWorktreeDirt: vi.fn(),
  listWorktrees: async () => [], findAdoptableWorktreeForBranch: async () => null, releaseIdleSiblingNextHolder: async () => null,
  createWorktree: vi.fn(async (_agent, _workspace, _task, options) => ({ worktreePath: '/repos/worktree', branchName: forkLocalBranch(options.existingBranch, options.forkHead) })),
}));
import { prepareAgentWorkspace } from './agentWorkspacePrep.js';
import { createWorktree } from './worktreeManager.js';
import { execGh } from './github.js';
import { spawnReviewLoopFollowUp } from './agentWorktreeCleanup.js';
import { buildAgentRegistration } from '../lib/agentRegistrationRecord.js';
import { registerAgent } from './cosAgentLifecycle.js';
import { claimMergeAdmission, withPendingMergeAdmission } from './cosMergeAdmission.js';

const admission = (action, token, extra = {}) => claimMergeAdmission({ agentId: 'review-agent', action, token, ...extra });
async function launch(overrides = {}) {
  const task = await spawnReviewLoopFollowUp({ originalAgentId: 'original', originalTask: { id: 'original-task', metadata: { app: 'synthetic-app' } },
    prUrl: 'https://github.com/example/repo/pull/42', prBranch: 'feature/fix',
    sourceWorkspace: '/repos/source', reviewers: [], ...overrides });
  const persisted = f.tasks[task.id];
  f.branch = forkLocalBranch(f.row?.headRefName || 'feature/fix', overrides.forkHead);
  const workspace = await prepareAgentWorkspace({ agentId: 'review-agent', task: persisted });
  expect(workspace.outcome).toBe('ready');
  const metadata = buildAgentRegistration({ task: persisted, provider: { id: 'test' }, modelSelection: {},
    sourceWorkspace: '/repos/source', workspacePath: workspace.workspacePath, worktreeInfo: workspace.worktreeInfo });
  await registerAgent('review-agent', task.id, metadata);
  return persisted;
}
const forkHead = { remoteUrl: 'https://github.com/contributor/repo.git', ownerLogin: 'contributor' };
const persist = () => { f.disk = structuredClone(f.state); };
beforeEach(() => {
  f.state = { agents: {}, mergeAdmissions: {}, stats: { agentsSpawned: 0 } };
  vi.clearAllMocks();
  f.tasks = {}; f.branch = 'feature/fix'; f.workspaceRepo = 'example/repo'; f.originHost = 'github.com';
  f.head = 'a'.repeat(40); f.remote = forkHead.remoteUrl; f.pushRemote = f.remote;
  f.upstream = { remote: 'fork-contributor', merge: 'refs/heads/feature/fix' };
  f.row = { url: 'https://github.com/example/repo/pull/42', number: 42, state: 'OPEN', headRefName: f.branch,
    headRefOid: f.head, baseRefName: 'main', isCrossRepository: true,
    headRepository: { id: 'fork-id', nameWithOwner: 'contributor/repo', name: 'repo' }, headRepositoryOwner: { login: 'contributor' } };
  persist();
});

describe('registered review-loop merge coordinator', () => {
  it('creates and registers a non-claim follow-up that acquires, checks and releases repository admission', async () => {
    await launch();
    expect(f.state.agents['review-agent'].metadata.claimPicksOwnBranch).not.toBe(true);
    const lease = await admission('acquire');
    expect(lease).toMatchObject({ admitted: true, repository: 'github.com/example/repo' });
    expect(await admission('check', lease.token)).toMatchObject({ admitted: true });
    f.branch = 'main'; // gh may switch away after deleting the merged branch.
    expect(await admission('release', lease.token, { outcome: 'merged' })).toMatchObject({ released: true });
    expect(f.disk.mergeAdmissions).toEqual({});
  });

  it.each([null, forkHead])('preserves active claim and sweep lease exclusion for %j', async forkHead => {
    await launch({ forkHead });
    f.state.agents.claim = { id: 'claim', taskId: 'claim-task', status: 'running', startedAt: new Date().toISOString(),
      metadata: { claimPicksOwnBranch: true, sourceWorkspace: '/repos/source' } }; persist();
    const claim = await claimMergeAdmission({ agentId: 'claim', action: 'acquire' });
    expect(await admission('acquire')).toMatchObject({ admitted: false, reason: 'owner-active-or-unverified' });
    await claimMergeAdmission({ agentId: 'claim', action: 'release', token: claim.token, outcome: 'merged' });
    await withPendingMergeAdmission({ host: 'github.com', fullName: 'example/repo' }, async () => {
      expect(await admission('acquire')).toMatchObject({ admitted: false, reason: 'owner-active-or-unverified' });
    });
    const review = await admission('acquire');
    expect((await claimMergeAdmission({ agentId: 'claim', action: 'acquire' })).admitted).toBe(false);
    expect((await withPendingMergeAdmission({ host: 'github.com', fullName: 'example/repo' }, vi.fn())).admitted).toBe(false);
    await admission('release', review.token, { outcome: 'merged' });
  });

  describe.each([null, forkHead])('participant liveness and binding with fork %j', forkHead => {
    it.each(['absent-agent', 'completed-agent', 'absent-task', 'completed-task', 'user-task', 'unregistered-target',
      'changed-target', 'unrelated-pr', 'unrelated-workspace', 'changed-checkout', 'changed-registration', 'leave-open', 'leave-open-policy'])
    ('refuses %s despite caller-supplied repository and branch claims', async mode => {
      const task = await launch({ forkHead });
      const agent = f.state.agents['review-agent'];
      if (mode === 'absent-agent') delete f.state.agents['review-agent'];
      if (mode === 'completed-agent') agent.status = 'completed';
      if (mode === 'absent-task') delete f.tasks[task.id];
      if (mode === 'completed-task') task.status = 'completed';
      if (mode === 'user-task') task.taskType = 'user';
      if (mode === 'unregistered-target') delete agent.metadata.reviewLoopMergeTarget;
      if (mode === 'changed-target') task.metadata.reviewLoopPRBranch = 'other';
      if (mode === 'unrelated-pr') {
        task.metadata.reviewLoopPRUrl = 'https://github.com/example/other/pull/42';
        task.metadata.reviewLoopPRRepo = 'other';
        agent.metadata.reviewLoopMergeTarget.url = task.metadata.reviewLoopPRUrl;
      }
      if (mode === 'unrelated-workspace') f.workspaceRepo = 'example/other';
      if (mode === 'changed-checkout') f.branch = 'another/branch';
      if (mode === 'changed-registration') agent.metadata.worktreeBranch = 'another/branch';
      if (mode === 'leave-open') task.metadata.reviewLoopLeaveOpen = true;
      if (mode === 'leave-open-policy') task.metadata.prCompletion = 'leave-open';
      persist();
      expect(await admission('acquire', undefined, { repository: 'github.com/example/repo', branch: 'feature/fix' }))
        .toMatchObject({ admitted: false });
      expect(f.disk.mergeAdmissions).toEqual({});
    });
  });
});

describe('fork follow-up creation through workspace, registration and admission', () => {
  it('admits the verified fork exact head under the base repository and excludes a same-repository coordinator', async () => {
    await launch({ forkHead });
    expect(createWorktree).toHaveBeenCalledWith('review-agent', '/repos/source', expect.any(String), expect.objectContaining({ forkHead, existingBranch: 'feature/fix' }));
    const forkLease = await admission('acquire');
    expect(forkLease).toMatchObject({ admitted: true, repository: 'github.com/example/repo' });
    expect(f.disk.mergeAdmissions[forkLease.repository].headSha).toBe(f.head);
    expect(await admission('check', forkLease.token)).toMatchObject({ admitted: true });
    // Another same-repository coordinator cannot enter while the fork holds.
    const same = structuredClone(f.state.agents['review-agent']);
    same.id = 'same'; same.taskId = 'same-task';
    same.metadata.worktreeBranch = 'feature/fix';
    same.metadata.reviewLoopMergeTarget = { url: f.row.url, branch: 'feature/fix' };
    const sameTask = structuredClone(f.tasks[f.state.agents['review-agent'].taskId]);
    sameTask.id = same.taskId; delete sameTask.metadata.forkHead; delete sameTask.metadata.reviewLoopForkTarget;
    f.tasks[sameTask.id] = sameTask; f.state.agents.same = same; persist();
    expect((await claimMergeAdmission({ agentId: 'same', action: 'acquire' })).admitted).toBe(false);
    await admission('release', forkLease.token, { outcome: 'merged' });
    f.branch = 'feature/fix';
    const sameLease = await claimMergeAdmission({ agentId: 'same', action: 'acquire' });
    expect(sameLease.admitted).toBe(true);
    expect((await admission('acquire')).admitted).toBe(false);
    expect(execGh).toHaveBeenCalledWith(expect.arrayContaining(['--repo', 'github.com/example/repo']), 10000, expect.objectContaining({ cwd: '/repos/source' }));
  });

  it('accepts the alternate GitHub SSH endpoint for both source and worktree origins', async () => {
    f.originHost = 'ssh.github.com';
    f.remote = f.pushRemote = 'ssh://git@ssh.github.com:443/contributor/repo.git';
    await launch({ forkHead });
    const lease = await admission('acquire');
    expect(lease).toMatchObject({ admitted: true, repository: 'github.com/example/repo' });
    expect(await admission('check', lease.token)).toMatchObject({ admitted: true });
    await admission('release', lease.token, { outcome: 'merged' });
  });

  it('allows a reviewed remediation head, but requires releasing a lease when its head changes', async () => {
    await launch({ forkHead });
    f.head = f.row.headRefOid = 'b'.repeat(40);
    const lease = await admission('acquire');
    expect(lease.admitted).toBe(true);
    f.head = f.row.headRefOid = 'c'.repeat(40);
    expect(await admission('check', lease.token)).toMatchObject({ admitted: false, reason: 'lease-head-changed' });
    expect(await admission('acquire')).toMatchObject({ admitted: false, reason: 'lease-head-changed' });
    await admission('release', lease.token, { outcome: 'resync' });
    const renewed = await admission('acquire');
    expect(renewed.admitted).toBe(true);
    f.branch = 'main'; f.row = null;
    expect(await admission('release', renewed.token, { outcome: 'merged' })).toMatchObject({ released: true });
  });

  it.each(['legacy', 'missing-registration', 'changed-task-fork', 'changed-base', 'changed-fork', 'recreated-fork', 'wrong-pr', 'closed-pr',
    'wrong-head', 'wrong-upstream', 'wrong-fetch-remote', 'wrong-push-remote', 'multiple-remotes', 'unreadable-forge', 'changed-workspace'])
  ('refuses %s without granting a lease and reports an actionable stop', async mode => {
    const task = await launch({ forkHead });
    const agent = f.state.agents['review-agent'];
    if (mode === 'legacy') delete agent.metadata.reviewLoopMergeTarget.fork;
    if (mode === 'missing-registration') delete agent.metadata.reviewLoopMergeTarget;
    if (mode === 'changed-task-fork') task.metadata.forkHead.remoteUrl = 'https://github.com/other/repo.git';
    if (mode === 'changed-base') f.row.baseRefName = 'release';
    if (mode === 'changed-fork') f.row.headRepository.nameWithOwner = 'other/repo';
    if (mode === 'recreated-fork') f.row.headRepository.id = 'replacement-id';
    if (mode === 'wrong-pr') f.row.url = 'https://github.com/example/other/pull/42';
    if (mode === 'closed-pr') f.row.state = 'CLOSED';
    if (mode === 'wrong-head') f.head = 'b'.repeat(40);
    if (mode === 'wrong-upstream') f.upstream.merge = 'refs/heads/main';
    if (mode === 'wrong-fetch-remote') f.remote = 'https://github.com/other/repo.git';
    if (mode === 'wrong-push-remote') f.pushRemote = 'https://github.com/example/repo.git';
    if (mode === 'multiple-remotes') f.pushRemote += '\nhttps://github.com/other/repo.git';
    if (mode === 'unreadable-forge') f.row = null;
    if (mode === 'changed-workspace') agent.metadata.workspacePath = '/repos/other';
    persist();
    expect(await admission('acquire', undefined, { forkHead, headSha: f.head }))
      .toMatchObject({ admitted: false, retryable: false, reason: 'fork-review-target-unverified', message: expect.stringContaining('fresh supported follow-up') });
    expect(f.disk.mergeAdmissions).toEqual({});
  });

  it('does not create a task from invalid fork coordinates or an unrelated live PR', async () => {
    await expect(launch({ forkHead: { remoteUrl: 'https://github.com/other/repo.git', ownerLogin: 'other' } })).rejects.toThrow('could not be verified');
    f.row.url = 'https://github.com/example/other/pull/42';
    await expect(launch({ forkHead })).rejects.toThrow('could not be verified');
    expect(f.tasks).toEqual({});
    expect(f.disk.mergeAdmissions).toEqual({});
  });
});
