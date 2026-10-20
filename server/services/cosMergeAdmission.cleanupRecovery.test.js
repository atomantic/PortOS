import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { generateTasksMarkdown, parseTasksMarkdown } from '../lib/taskParser.js';

// Repository-cleanup recovery (#12251): the post-completion audit files a
// recovery for a parent whose PR is still open; that recovery lands the PR
// inside repository merge admission. Authority comes from the audit's own
// forge observation and its backlink on the parent, never a caller claim.
vi.mock('../lib/backupSnapshotBoundary.js', () => ({ withBackupAssetPublication: work => work() }));
const f = vi.hoisted(() => ({ state: null, disk: null, tasks: {}, archive: {} }));
vi.mock('./cosState.js', () => ({
  AGENTS_DIR: '/synthetic/agents',
  withStateLock: createFileWriteQueue(),
  loadState: async () => f.state,
  saveState: async state => { f.state = state; f.disk = structuredClone(state); },
  readMergeAdmissionStateForSafetyCheck: async () => ({ trusted: true, ...structuredClone(f.disk) }),
}));
vi.mock('../lib/fileUtils.js', async () => ({
  ...await vi.importActual('../lib/fileUtils.js'),
  atomicWrite: async (path, value) => { f.archive[path] = JSON.stringify(value); },
  tryReadFile: async path => f.archive[path] ?? null,
}));
vi.mock('./cosAgentIndex.js', async () => ({
  ...await vi.importActual('./cosAgentIndex.js'),
  loadAgentIndex: async () => new Map([['parent-1', '2026-01-01']]),
}));
vi.mock('./cosClaimOwnership.js', () => ({ readClaimOwnershipAgents: async () => Object.values(f.state.agents) }));
vi.mock('./cosEvents.js', () => ({ cosEvents: { emit: vi.fn() }, emitLog: vi.fn() }));
vi.mock('./cosTaskStore.js', () => ({ getTaskById: async id => f.tasks[id] ?? null }));
vi.mock('./cos.js', () => ({
  addTask: vi.fn(async () => ({ id: 'task-recovery-1' })),
  getAllTasks: vi.fn(async () => ({ user: { tasks: [] }, cos: { tasks: [] } })),
}));
vi.mock('./prWatcher.js', () => ({ readPendingMergePrs: () => [] }));
vi.mock('./worktreeManager.js', () => ({ listWorktrees: async () => [] }));
vi.mock('./branchReconcile.js', () => ({
  listRemoteHeads: async () => new Map([[BRANCH, 'abc']]),
  cleanupMerged: async () => ({ cleaned: [] }),
  driveToMerge: pr => `merge ${pr} with --match-head-commit <verified-head>`,
}));
vi.mock('./git.js', () => ({
  getDefaultBranch: async () => 'main',
  hasBranchMergeEvidence: async () => false,
  resolveForgeForRepo: async () => ({ cli: 'gh', env: null }),
}));
vi.mock('./github.js', () => ({ findPullRequestForBranch: vi.fn() }));
vi.mock('./apps.js', () => ({ getAppById: async () => ({ id: 'example-app', name: 'Example App' }) }));
vi.mock('./brainTaskThreads.js', () => ({ ensureTaskThread: async () => ({}) }));
// The parent's worktree and local branch are already gone.
vi.mock('../lib/execGit.js', () => ({ execGit: async () => ({ exitCode: 1, stdout: '', stderr: '' }) }));
vi.mock('fs', async () => ({ ...await vi.importActual('fs'), existsSync: () => false }));
vi.mock('../lib/gitRemote.js', () => ({ getOriginInfo: async path => ({ host: 'github.com', fullName: path === '/repos/other' ? 'example/other' : 'example/repo' }) }));

const BRANCH = vi.hoisted(() => 'cos/task-parent/parent-1');
const PR_URL = 'https://github.com/example/repo/pull/7';
const REPOSITORY = 'github.com/example/repo';

import { addTask } from './cos.js';
import { findPullRequestForBranch } from './github.js';
import { buildTaskMetadata } from './cosTaskIntake.js';
import { buildAgentRegistration } from '../lib/agentRegistrationRecord.js';
import { registerAgent, recordRepoStateRecovery } from './cosAgentLifecycle.js';
import { verifyAgentRepoState } from './agentRepoStateVerification.js';
import { claimMergeAdmission, withPendingMergeAdmission } from './cosMergeAdmission.js';

const persist = () => { f.disk = structuredClone(f.state); };
const admission = (action, token, extra = {}) => claimMergeAdmission({ agentId: 'recovery-1', action, token, ...extra });
const parentTask = { id: 'task-parent', description: 'Fix the example', metadata: { app: 'example-app', openPR: true, prCompletion: 'merge-on-green' } };

// Queue entries round-trip through TASKS.md, so scalars arrive as strings.
const queue = (id, taskData) => {
  const [task] = parseTasksMarkdown(generateTasksMarkdown([{ id, status: 'in_progress', priority: 'HIGH',
    description: taskData.description, metadata: buildTaskMetadata(taskData, 'user') }]));
  f.tasks[id] = { ...task, taskType: 'user' };
  return f.tasks[id];
};
const register = (agentId, task) => registerAgent(agentId, task.id, buildAgentRegistration({ task, provider: { id: 'test' },
  modelSelection: {}, sourceWorkspace: '/repos/source', workspacePath: '/repos/source' }));

// The real audit files the recovery for the completed parent; the real
// intake, registration and admission then run on what it produced.
async function fileAndLaunch() {
  const audit = await verifyAgentRepoState({ agentId: 'parent-1', task: parentTask, agentState: f.state.agents['parent-1'], success: true, prExpected: true });
  expect(audit.recoveryTaskId).toBe('task-recovery-1');
  const task = queue('task-recovery-1', addTask.mock.calls.at(-1)[0]);
  await register('recovery-1', task);
  return task;
}

beforeEach(() => {
  addTask.mockClear();
  findPullRequestForBranch.mockResolvedValue({ status: 'found', url: PR_URL, number: 7, detail: 'OPEN' });
  f.tasks = {}; f.archive = {};
  f.state = { agents: { 'parent-1': { id: 'parent-1', taskId: 'task-parent', status: 'completed', startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T01:00:00Z', metadata: { isWorktree: true, sourceWorkspace: '/repos/source', worktreeBranch: BRANCH,
      workspacePath: '/repos/source/data/cos/worktrees/parent-1', prOpenedBy: 'agent-slashdo' } } }, mergeAdmissions: {}, stats: { agentsSpawned: 0 } };
  f.archive['/synthetic/agents/2026-01-01/parent-1/metadata.json'] = JSON.stringify(f.state.agents['parent-1']);
  persist();
});

describe('repository-cleanup recovery merge admission', () => {
  it('lands the registered parent PR with no parent checkout, from creation through release', async () => {
    await fileAndLaunch();
    expect(addTask.mock.calls[0][0].metadata.recoveryMergeTarget).toEqual({ url: PR_URL, branch: BRANCH });
    expect(f.state.agents['recovery-1'].metadata.recoveryMergeTarget).toEqual({ url: PR_URL, branch: BRANCH });
    const backlink = { taskId: 'task-recovery-1', url: PR_URL, branch: BRANCH };
    expect(f.state.agents['parent-1'].metadata.repoStateRecovery).toEqual(backlink);
    const lease = await admission('acquire');
    expect(lease).toMatchObject({ admitted: true, repository: REPOSITORY });
    expect(await admission('check', lease.token)).toMatchObject({ admitted: true });
    expect(await admission('release', lease.token, { outcome: 'merged' })).toMatchObject({ released: true });
    expect(f.disk.mergeAdmissions).toEqual({});
    expect(f.state.agents['recovery-1'].metadata.claimPicksOwnBranch).toBeUndefined();
  });

  it('keeps admission for both claim-swarm recoveries after the second backlink is written', async () => {
    const parent = f.state.agents['parent-1'];
    parent.metadata = { ...parent.metadata, isWorktree: false, worktreeBranch: null,
      claimPicksOwnBranch: true, claimBranches: ['claim/issue-11', 'claim/issue-12'] };
    findPullRequestForBranch.mockImplementation(async branch => ({ status: 'found', detail: 'OPEN',
      url: `https://github.com/example/repo/pull/${branch.endsWith('11') ? 11 : 12}` }));
    addTask.mockResolvedValueOnce({ id: 'task-first' }).mockResolvedValueOnce({ id: 'task-second' });
    await verifyAgentRepoState({ agentId: 'parent-1', task: parentTask, agentState: parent, success: true });
    expect(Object.keys(f.state.agents['parent-1'].metadata.repoStateRecoveries)).toEqual(['claim/issue-11', 'claim/issue-12']);
    for (const [index, id] of ['task-first', 'task-second'].entries()) {
      await register('recovery-1', queue(id, addTask.mock.calls[index][0]));
      const lease = await admission('acquire');
      expect(lease.admitted).toBe(true);
      await admission('release', lease.token, { outcome: 'merged' });
      delete f.state.agents['recovery-1']; persist();
    }
  });

  it('verifies a parent already archived out of live state through its persisted backlink', async () => {
    await fileAndLaunch();
    delete f.state.agents['parent-1']; persist();
    const lease = await admission('acquire');
    expect(lease).toMatchObject({ admitted: true, repository: REPOSITORY });
    expect(await admission('release', lease.token, { outcome: 'merged' })).toMatchObject({ released: true });
  });

  it('binds a recovery after the parent has already left live retention', async () => {
    const parent = f.state.agents['parent-1'];
    delete f.state.agents['parent-1']; persist();
    const audit = await verifyAgentRepoState({ agentId: 'parent-1', task: parentTask, agentState: parent, success: true, prExpected: true });
    expect(audit.recoveryTaskId).toBe('task-recovery-1');
    await register('recovery-1', queue('task-recovery-1', addTask.mock.calls.at(-1)[0]));
    expect(await admission('acquire')).toMatchObject({ admitted: true });
  });

  it('does not synthesize a date bucket while a failed archive move still owns the flat directory', async () => {
    f.archive = {};
    await recordRepoStateRecovery('parent-1', { taskId: 'recovery', url: PR_URL, branch: BRANCH });
    expect(f.archive).toEqual({});
    expect(f.disk.agents['parent-1'].metadata.repoStateRecovery.taskId).toBe('recovery');
  });

  it('keeps the repository-wide lease exclusive against claim runs and the sweep', async () => {
    await fileAndLaunch();
    f.state.agents.claim = { id: 'claim', taskId: 'claim-task', status: 'running', startedAt: new Date().toISOString(),
      metadata: { claimPicksOwnBranch: true, sourceWorkspace: '/repos/source' } }; persist();
    const claim = await claimMergeAdmission({ agentId: 'claim', action: 'acquire' });
    expect(await admission('acquire')).toMatchObject({ admitted: false, reason: 'owner-active-or-unverified' });
    await claimMergeAdmission({ agentId: 'claim', action: 'release', token: claim.token, outcome: 'merged' });
    const lease = await admission('acquire');
    expect(lease.admitted).toBe(true);
    expect((await withPendingMergeAdmission({ host: 'github.com', fullName: 'example/repo' }, vi.fn())).admitted).toBe(false);
  });

  it.each([
    'changed-task-target', 'changed-registration', 'leave-open', 'human-handoff', 'parent-leave-open', 'parent-running',
    'parent-other-task', 'parent-other-branch', 'parent-unbound', 'backlink-other-task', 'parent-other-repository',
    'other-lineage', 'completed-task',
  ])('refuses %s with a non-retryable blocker', async mode => {
    const task = await fileAndLaunch();
    const agent = f.state.agents['recovery-1'];
    const parent = f.state.agents['parent-1'];
    if (mode === 'changed-task-target') task.metadata.recoveryMergeTarget = { url: 'https://github.com/example/repo/pull/8', branch: BRANCH };
    if (mode === 'changed-registration') agent.metadata.recoveryMergeTarget = { url: PR_URL, branch: 'another/branch' };
    if (mode === 'leave-open') task.metadata.prCompletion = 'leave-open';
    if (mode === 'human-handoff') task.metadata.jiraTicketId = 'EX-1';
    if (mode === 'parent-leave-open') parent.metadata.prCompletionPolicy = 'leave-open';
    if (mode === 'parent-running') parent.status = 'running';
    if (mode === 'parent-other-task') parent.taskId = 'task-other';
    if (mode === 'parent-other-branch') parent.metadata.worktreeBranch = 'another/branch';
    if (mode === 'parent-unbound') delete parent.metadata.repoStateRecovery;
    if (mode === 'backlink-other-task') parent.metadata.repoStateRecovery.taskId = 'task-other';
    if (mode === 'parent-other-repository') parent.metadata.sourceWorkspace = '/repos/other';
    if (mode === 'other-lineage') task.metadata.recoveryOrigin = { ...task.metadata.recoveryOrigin, parentAgentId: 'parent-2' };
    if (mode === 'completed-task') task.status = 'completed';
    persist();
    expect(await admission('acquire')).toMatchObject({ admitted: false, reason: 'recovery-merge-target-unverified', retryable: false });
    expect(f.disk.mergeAdmissions).toEqual({});
  });

  it('refuses a copied recovery the parent never named, and copied prose alone', async () => {
    const original = await fileAndLaunch();
    const payload = addTask.mock.calls[0][0];
    // Identical lineage and target written through the task API: no backlink.
    await register('copy-1', queue('task-copy', payload));
    expect(await claimMergeAdmission({ agentId: 'copy-1', action: 'acquire' }))
      .toMatchObject({ admitted: false, reason: 'recovery-merge-target-unverified', retryable: false });
    // The same remediation prose without the trusted lineage is an ordinary run.
    await register('prose-1', queue('task-prose', { description: original.description, context: payload.context }));
    expect(await claimMergeAdmission({ agentId: 'prose-1', action: 'acquire' }))
      .toMatchObject({ admitted: false, reason: 'claim-owner-unverified' });
    expect(f.disk.mergeAdmissions).toEqual({});
  });

  it('refuses completed and unregistered callers', async () => {
    await fileAndLaunch();
    expect(await claimMergeAdmission({ agentId: 'missing', action: 'acquire' })).toMatchObject({ admitted: false, reason: 'claim-owner-unverified' });
    f.state.agents['recovery-1'].status = 'completed'; persist();
    expect(await admission('acquire')).toMatchObject({ admitted: false, reason: 'claim-owner-unverified' });
  });

  it('files no merge authority when the forge reported no PR, and reports that blocker', async () => {
    findPullRequestForBranch.mockResolvedValue({ status: 'none', url: null, detail: null });
    await fileAndLaunch();
    expect(addTask.mock.calls[0][0].metadata.recoveryMergeTarget).toBeUndefined();
    expect(f.state.agents['parent-1'].metadata.repoStateRecovery).toBeUndefined();
    expect(await admission('acquire')).toMatchObject({ admitted: false, reason: 'recovery-merge-target-unverified', retryable: false });
  });
});
