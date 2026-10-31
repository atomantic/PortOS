vi.mock('../lib/checkoutRetirementAdmission.js', () => ({ withCheckoutPublication: async (_repo, work) => work() }));
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { generateTasksMarkdown, parseTasksMarkdown } from '../lib/taskParser.js';
import { forkLocalBranch } from '../lib/forkHead.js';
import { parsePullRequestUrl } from '../lib/gitForge.js';

const f = vi.hoisted(() => ({ state: null, disk: null, tasks: {}, branch: 'feature/fix', workspaceRepo: 'example/repo', originHost: 'github.com', row: null, head: null, upstream: null, remote: null, pushRemote: null, detached: false }));
vi.mock('./cosState.js', () => ({
  AGENTS_DIR: '/synthetic/agents',
  withStateLock: createFileWriteQueue(),
  loadState: async () => f.state,
  saveState: async state => { f.state = state; f.disk = structuredClone(state); },
  readMergeAdmissionStateForSafetyCheck: async () => ({ trusted: true, ...structuredClone(f.disk) }),
}));
vi.mock('./cosEvents.js', () => ({ cosEvents: { emit: vi.fn() }, emitLog: vi.fn() }));
vi.mock('./cosTaskStore.js', () => ({
  addTask: async task => { f.tasks[task.id] = { ...parseTasksMarkdown(generateTasksMarkdown([task]))[0], taskType: 'internal' }; return task; }, updateTask: vi.fn(),
  getTaskById: async id => f.tasks[id],
}));
vi.mock('./cos.js', () => ({
  forceSpawnTask: vi.fn(),
}));
vi.mock('./cosAgentLifecycle.js', async importOriginal => ({ ...(await importOriginal()), getAgents: async () => [] }));
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
  if (args[0] === 'symbolic-ref' && f.branch === null) return { stdout: '', exitCode: 1 };
  if (args[0] === 'symbolic-ref') stdout = f.branch;
  if (args[0] === 'rev-parse') stdout = args.includes('--is-inside-work-tree') ? 'true' : f.head;
  if (args[0] === 'remote') stdout = args.includes('--push') ? f.pushRemote : f.remote;
  if (args[0] === 'config') stdout = args[2].endsWith('.remote') ? f.upstream.remote : f.upstream.merge;
  if (typeof stdout !== 'string') throw new Error('unreadable git fixture');
  return { stdout, exitCode: 0 };
} }));
vi.mock('./git.js', () => ({ parsePullRequestUrl, isRepo: async () => true, getRepoBranches: async () => ({ baseBranch: 'main' }) }));
vi.mock('./worktreeManager.js', () => ({ removeWorktree: vi.fn(), classifyWorktreeDirt: vi.fn(),
  listWorktrees: async () => [], findAdoptableWorktreeForBranch: async () => null, releaseIdleSiblingNextHolder: async () => null,
  createWorktree: vi.fn(async (_agent, _workspace, _task, options) => ({ worktreePath: '/repos/worktree', branchName: forkLocalBranch(options.existingBranch, options.forkHead),
    ...(f.detached ? { detached: true, headSha: f.head } : {}) })),
}));
import { prepareAgentWorkspace } from './agentWorkspacePrep.js';
import { createWorktree } from './worktreeManager.js';
import { spawnReviewLoopFollowUp } from './agentWorktreeCleanup.js';
import { buildAgentRegistration } from '../lib/agentRegistrationRecord.js';
import { registerAgent } from './cosAgentLifecycle.js';
import { resolveMergeHandoffOwner } from './mergeHandoffOwner.js';

const resolveOwner = () => resolveMergeHandoffOwner('review-agent');
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
  f.tasks = {}; f.branch = 'feature/fix'; f.workspaceRepo = 'example/repo'; f.originHost = 'github.com'; f.detached = false;
  f.head = 'a'.repeat(40); f.remote = forkHead.remoteUrl; f.pushRemote = f.remote;
  f.upstream = { remote: 'fork-contributor', merge: 'refs/heads/feature/fix' };
  f.row = { url: 'https://github.com/example/repo/pull/42', number: 42, state: 'OPEN', headRefName: f.branch,
    headRefOid: f.head, baseRefName: 'main', isCrossRepository: true,
    headRepository: { id: 'fork-id', nameWithOwner: 'contributor/repo', name: 'repo' }, headRepositoryOwner: { login: 'contributor' } };
  persist();
});

describe('registered review-loop merge coordinator', () => {
  it('registers a non-claim follow-up that resolves as the owner of its PR branch only', async () => {
    await launch();
    expect(f.state.agents['review-agent'].metadata.claimPicksOwnBranch).not.toBe(true);
    const owner = await resolveOwner();
    expect(owner).toMatchObject({ repository: 'github.com/example/repo', workspacePath: '/repos/worktree' });
    expect(owner.owns('feature/fix')).toBe(true);
    expect(owner.owns('main')).toBe(false);
  });

  it('accepts the alternate GitHub SSH endpoint under the canonical repository key', async () => {
    f.originHost = 'ssh.github.com';
    await launch();
    expect(await resolveOwner()).toMatchObject({ repository: 'github.com/example/repo' });
  });

  it.each(['absent-agent', 'completed-agent', 'absent-task', 'completed-task', 'user-task', 'unregistered-target',
    'changed-target', 'unrelated-pr', 'unrelated-workspace', 'changed-checkout', 'changed-registration', 'leave-open', 'leave-open-policy', 'read-only', 'human-landed'])
  ('refuses %s as a handoff owner', async mode => {
    const task = await launch();
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
    if (mode === 'read-only') task.metadata.readOnly = true;
    if (mode === 'human-landed') task.metadata.jiraTicketId = 'EX-1';
    persist();
    expect(await resolveOwner()).toEqual({ refused: 'handoff-owner-unverified' });
  });
});

describe('registered detached review checkout', () => {
  async function detachedLaunch() {
    f.detached = true;
    f.row.isCrossRepository = false;
    const task = await launch();
    f.branch = null;
    return task;
  }

  it('resolves the registered launch head as the owner of its PR branch', async () => {
    await detachedLaunch();
    expect(await resolveOwner()).toMatchObject({ repository: 'github.com/example/repo', owns: expect.any(Function) });
    f.row.headRefOid = 'b'.repeat(40);
    expect(await resolveOwner()).toEqual({ refused: 'handoff-owner-unverified' });
  });

  it.each(['unregistered', 'changed-workspace', 'changed-origin', 'attached', 'local-head', 'remote-head',
    'wrong-pr', 'closed', 'fork', 'leave-open', 'task-changed', 'unreadable'])('refuses %s', async mode => {
    const task = await detachedLaunch();
    const agent = f.state.agents['review-agent'];
    if (mode === 'unregistered') delete agent.metadata.reviewLoopMergeTarget.detached;
    if (mode === 'changed-workspace') agent.metadata.workspacePath = '/repos/other';
    if (mode === 'changed-origin') f.workspaceRepo = 'example/other';
    if (mode === 'attached') f.branch = 'feature/fix';
    if (mode === 'local-head') f.head = 'b'.repeat(40);
    if (mode === 'remote-head') f.row.headRefOid = 'b'.repeat(40);
    if (mode === 'wrong-pr') f.row.url = 'https://github.com/example/repo/pull/43';
    if (mode === 'closed') f.row.state = 'CLOSED';
    if (mode === 'fork') f.row.isCrossRepository = true;
    if (mode === 'leave-open') task.metadata.reviewLoopLeaveOpen = true;
    if (mode === 'task-changed') task.metadata.reviewLoopPRBranch = 'other';
    if (mode === 'unreadable') f.row = null;
    persist();
    expect(await resolveOwner()).toEqual({ refused: 'handoff-owner-unverified' });
  });
});

describe('fork follow-up creation', () => {
  it('registers the fork worktree but refuses it as a handoff owner: the coordinator merges same-repository heads only', async () => {
    await launch({ forkHead });
    expect(createWorktree).toHaveBeenCalledWith('review-agent', '/repos/source', expect.any(String), expect.objectContaining({ forkHead, existingBranch: 'feature/fix' }));
    expect(await resolveOwner()).toEqual({ refused: 'fork-target-unsupported' });
  });

  it('does not create a task from invalid fork coordinates or an unrelated live PR', async () => {
    await expect(launch({ forkHead: { remoteUrl: 'https://github.com/other/repo.git', ownerLogin: 'other' } })).rejects.toThrow('could not be verified');
    f.row.url = 'https://github.com/example/other/pull/42';
    await expect(launch({ forkHead })).rejects.toThrow('could not be verified');
    expect(f.tasks).toEqual({});
  });
});
