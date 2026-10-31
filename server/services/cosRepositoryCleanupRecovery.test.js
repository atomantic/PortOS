import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { generateTasksMarkdown, parseTasksMarkdown } from '../lib/taskParser.js';

// Existing repository-cleanup recoveries (#12251) keep their server-written
// backlink on the completed parent after an upgrade. They hold no handoff
// authority (the pending-merge coordinator takes registered runs only), and the
// current audit must not create another cognitive task for an absent,
// unverified original checkout.
vi.mock('../lib/backupSnapshotBoundary.js', () => ({ withBackupAssetPublication: work => work() }));
const f = vi.hoisted(() => ({ state: null, disk: null, tasks: {}, archive: {} }));
vi.mock('./cos.js', () => ({}));
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
vi.mock('./cosTaskStore.js', () => ({
  addTask: vi.fn(async () => ({ id: 'task-recovery-1' })),
  getAllTasks: vi.fn(async () => ({ user: { tasks: [] }, cos: { tasks: [] } })),
  getTaskById: async id => f.tasks[id] ?? null,
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
// The original checkout is absent; Git cannot verify its local ref state.
vi.mock('../lib/execGit.js', () => ({ execGit: async () => ({ exitCode: 1, stdout: '', stderr: '' }) }));
vi.mock('../lib/gitRemote.js', () => ({ getOriginInfo: async path => ({ host: 'github.com', fullName: path === '/repos/other' ? 'example/other' : 'example/repo' }) }));

const BRANCH = vi.hoisted(() => 'cos/task-parent/parent-1');
const PR_URL = 'https://github.com/example/repo/pull/7';

import { addTask } from './cosTaskStore.js';
import { findPullRequestForBranch } from './github.js';
import { buildTaskMetadata } from './cosTaskIntake.js';
import { buildAgentRegistration } from '../lib/agentRegistrationRecord.js';
import { registerAgent, recordRepoStateRecovery } from './cosAgentLifecycle.js';
import { verifyAgentRepoState } from './agentRepoStateVerification.js';
import { resolveMergeHandoffOwner } from './mergeHandoffOwner.js';

const persist = () => { f.disk = structuredClone(f.state); };
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

const legacyRecoveryPayload = (branch = BRANCH, url = PR_URL) => ({
  description: `Finish delivery for ${branch}`,
  context: `Land the parent PR ${url || '(unverified)'}`,
  app: 'example-app',
  isRecovery: true,
  useWorktree: false,
  metadata: { recoveryOrigin: { parentAgentId: 'parent-1', parentTaskId: parentTask.id,
    subsystem: 'repository-cleanup', attempt: 1, observation: 'a'.repeat(64), noProgress: false },
  ...(url ? { recoveryMergeTarget: { url, branch } } : {}) },
});

// Model a recovery already filed before upgrade. Keep the real TASKS.md
// intake round-trip, server-only backlink writer and registration;
// do not make the new deterministic audit manufacture legacy authority.
async function resumeLegacyRecovery({ id = 'task-recovery-1', branch = BRANCH, url = PR_URL, claimRun = false } = {}) {
  const task = queue(id, legacyRecoveryPayload(branch, url));
  if (url) expect(await recordRepoStateRecovery('parent-1', { taskId: id, url, branch }, { claimRun })).toBeTruthy();
  await register('recovery-1', task);
  return task;
}

beforeEach(() => {
  addTask.mockClear();
  findPullRequestForBranch.mockResolvedValue({ status: 'found', url: PR_URL, number: 7, detail: 'OPEN' });
  f.tasks = {}; f.archive = {};
  f.state = { agents: { 'parent-1': { id: 'parent-1', taskId: 'task-parent', status: 'completed', startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T01:00:00Z', metadata: { isWorktree: true, sourceWorkspace: '/repos/source', worktreeBranch: BRANCH,
      workspacePath: '/repos/source/data/cos/worktrees/parent-1', prOpenedBy: 'agent-slashdo' } } }, stats: { agentsSpawned: 0 } };
  f.archive[join('/synthetic/agents', '2026-01-01', 'parent-1', 'metadata.json')] = JSON.stringify(f.state.agents['parent-1']);
  persist();
});

describe('repository-cleanup recovery', () => {
  it('resumes a persisted recovery with no parent checkout, through intake and registration', async () => {
    await resumeLegacyRecovery();
    expect(f.tasks['task-recovery-1'].metadata.recoveryMergeTarget).toEqual({ url: PR_URL, branch: BRANCH });
    expect(f.state.agents['recovery-1'].metadata.recoveryMergeTarget).toEqual({ url: PR_URL, branch: BRANCH });
    expect(f.state.agents['recovery-1'].metadata.recoveryOrigin).toEqual(legacyRecoveryPayload().metadata.recoveryOrigin);
    const backlink = { taskId: 'task-recovery-1', url: PR_URL, branch: BRANCH };
    expect(f.state.agents['parent-1'].metadata.repoStateRecovery).toEqual(backlink);
    expect(f.state.agents['recovery-1'].metadata.claimPicksOwnBranch).toBeUndefined();
    // Not a registered handoff participant: it lands its PR through the forge.
    expect(await resolveMergeHandoffOwner('recovery-1')).toEqual({ refused: 'handoff-owner-unverified' });
  });

  it('keeps a backlink for each claim-swarm recovery after the second one is written', async () => {
    const parent = f.state.agents['parent-1'];
    parent.metadata = { ...parent.metadata, isWorktree: false, worktreeBranch: null,
      claimPicksOwnBranch: true, claimBranches: ['claim/issue-11', 'claim/issue-12'] };
    for (const [index, id] of ['task-first', 'task-second'].entries()) {
      const branch = parent.metadata.claimBranches[index];
      const url = `https://github.com/example/repo/pull/${index + 11}`;
      queue(id, legacyRecoveryPayload(branch, url));
      expect(await recordRepoStateRecovery('parent-1', { taskId: id, url, branch }, { claimRun: true })).toBeTruthy();
    }
    expect(Object.keys(f.state.agents['parent-1'].metadata.repoStateRecoveries)).toEqual(['claim/issue-11', 'claim/issue-12']);
  });

  it('does not synthesize a date bucket while a failed archive move still owns the flat directory', async () => {
    f.archive = {};
    await recordRepoStateRecovery('parent-1', { taskId: 'recovery', url: PR_URL, branch: BRANCH });
    expect(f.archive).toEqual({});
    expect(f.disk.agents['parent-1'].metadata.repoStateRecovery.taskId).toBe('recovery');
  });

  it('does not dispatch a new recovery for an absent original checkout with unverified delivery evidence', async () => {
    const audit = await verifyAgentRepoState({ agentId: 'parent-1', task: parentTask,
      agentState: f.state.agents['parent-1'], success: true, prExpected: true });
    expect(audit).toMatchObject({ verified: false, recoveryTaskId: null, skipReason: 'delivery-evidence-unavailable',
      observed: { worktreePresent: false, localBranchPresent: null, prState: 'OPEN' } });
    expect(addTask).not.toHaveBeenCalled();
    expect(f.state.agents['parent-1'].metadata.repoStateRecovery).toBeUndefined();
    expect(f.state.agents['parent-1'].metadata.cleanupOutcome).toMatchObject({ status: 'blocked', reason: 'delivery-evidence-unavailable' });
  });
});
