import { retirementCheckoutIdentityFromPointer } from '../lib/retirementCheckoutObservation.js';
vi.mock('./instanceIdentity.js', () => ({ getInstanceId: vi.fn(async () => 'fixture-local'), UNKNOWN_INSTANCE_ID: 'unknown' }));
vi.mock('../lib/gitRepositoryIdentity.js', () => ({ readGitCommonDirectory: vi.fn(async () => '/repo/.git') }));
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { readGitCommonDirectory } from '../lib/gitRepositoryIdentity.js';
vi.mock('./branchCompletionPolicy.js', async () => ({
  ...await vi.importActual('./branchCompletionPolicy.js'),
  readBranchCompletionPolicies: vi.fn(async () => []),
  readBranchCompletionHold: vi.fn(async () => null),
}));
/**
 * Tests for the post-completion repo-state audit.
 *
 * The failure this guards is the one the pure layer cannot see: cleanup returned
 * ZERO warnings, the completion path called the run a success, and the worktree
 * plus its branch are still on disk. Every case drives the real
 * `verifyAgentRepoState` against mocked git/forge answers and asserts what it
 * files — a recovery task, or deliberately nothing.
 *
 * The task-queue mocks return `getAllTasks`'s REAL `{user, cos}` shape via the
 * real `readAllTasksFlat`. An earlier revision mocked it as a bare array, which
 * hid a `tasks.some is not a function` throw that made the pending-owner escape
 * permanently false — the audit then filed a recovery task against every branch a
 * review-loop follow-up was queued to land.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { currentGitMutationLifetime, withGitMutationLifetime } from '../lib/gitMutationLifetime.js';

vi.mock('./agentWorktreeCleanup.js', () => ({ releaseRetryHold: vi.fn(async () => ({})) }));
vi.mock('./claimDisposition.js', () => ({ verifyCleanupClaimDisposition: vi.fn(async () => null) }));
vi.mock('./releaseSynchronization.js', () => ({ recoverReleaseSynchronizationHandoffs: vi.fn(async () => {}),
  verifyReleaseSynchronizationTask: vi.fn(async () => ({ status: 'verified' })) }));
import { recoverReleaseSynchronizationHandoffs, verifyReleaseSynchronizationTask } from './releaseSynchronization.js';
vi.mock('./repoCleanupRecovery.js', () => ({ inspectOrQueueCompletedReview: vi.fn(async () => ({ disposition: 'held', reason: 'delivery-ci-or-review-pending' })) }));
vi.mock('./repoCleanupObservation.js', async original => ({ ...await original(), readCheckoutPathPresence: vi.fn(async () => false), readLocalBranchPresence: vi.fn(async () => false) }));
vi.mock('../lib/gitRemote.js', () => ({ getOriginInfo: vi.fn(async () => ({ host: 'github.com', fullName: 'example/repo', isGithub: true })) }));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: vi.fn(async () => ({})) }));
vi.mock('./heldCheckoutReview.js', () => ({ readRetirementForgeEvidence: vi.fn(async () => ({ prHead: '1'.repeat(40), mergeCommit: '3'.repeat(40), defaultHead: '2'.repeat(40) })) }));
vi.mock('./completedCheckoutEvidence.js', async original => ({ ...await original(), readCompletedCheckoutIdentity: vi.fn() }));
vi.mock('./cos.js', () => ({}));
vi.mock('./cosState.js', () => ({ getConfig: vi.fn(async () => ({ autoApproveInvestigations: true })) }));
vi.mock('./agentCompletionData.js', () => ({ readCompletionData: vi.fn() }));
vi.mock('./agentCompletionCleanup.js', () => ({ replayAgentCompletionCleanup: vi.fn(async () => {}) }));
vi.mock('./cosAgentLifecycle.js', async original => ({ recordHistoricalCleanupReconciliation: vi.fn(async () => true), recordInheritedCheckoutRetirement: vi.fn(async () => true), recordSeededCheckoutRetirement: vi.fn(async () => true), isSettleableCompletionReceipt: (await original()).isSettleableCompletionReceipt, recordSuccessorCheckoutRetirement: vi.fn(async () => true), settleAbsentTaskCompletion: vi.fn(async () => true), retryCompletionCheckoutCapture: vi.fn(async () => false), reserveRepoCleanupRecovery: vi.fn(async () => ({ admitted: true, attempt: 1 })), recordRepoCleanupRecovery: vi.fn(async () => true), recordCleanupOutcome: vi.fn(async () => true), recordSwarmCleanupDelivery: vi.fn(async () => true), recordSwarmCleanupContinuationAttempt: vi.fn(async () => true), updateAgent: vi.fn().mockResolvedValue({}), recordRepoStateRecovery: vi.fn().mockResolvedValue(true), recordRepoStateVerification: vi.fn().mockResolvedValue(true), getAgentRecord: vi.fn(async () => null), recordCompletionCleanup: vi.fn(async () => true) }));
vi.mock('./cosClaimOwnership.js', () => ({ readClaimOwnershipAgents: vi.fn().mockResolvedValue([]), withClaimOwnershipLock: fn => fn() }));
vi.mock('./branchReconcileOutcome.js', () => ({ recordBranchReconcileOutcome: vi.fn().mockResolvedValue({}) }));
vi.mock('./taskScheduleStore.js', () => ({ loadSchedule: vi.fn(async () => ({})) }));
vi.mock('./taskSchedule.js', () => ({ acknowledgeSwarmCleanupRefill: vi.fn(async () => true) }));
vi.mock('node:fs/promises', async original => { const actual = await original(); return { ...actual, lstat: vi.fn(actual.lstat) }; });
vi.mock('./heldCheckoutRecovery.js', () => ({
  findMissingCheckoutPreservation: vi.fn(async () => null),
  retireInventoriedCheckout: vi.fn(async () => ({ ok: true, archiveDir: '/private/archive', branchDeleted: true })),
  prepareInventoriedCheckoutRetirement: vi.fn().mockResolvedValue({ ok: true, review: { digest: 'a'.repeat(64) } }),
}));
vi.mock('./cosEvents.js', async original => ({ ...await original(), emitLog: vi.fn() }));
vi.mock('./cosTaskStore.js', () => ({
  addTask: vi.fn().mockResolvedValue({ id: 'task-recovery-1' }),
  getAllTasks: vi.fn().mockResolvedValue({ user: { tasks: [] }, cos: { tasks: [] } }),
  getTaskById: vi.fn().mockResolvedValue(null),
  updateTask: vi.fn().mockResolvedValue({ status: 'completed' }),
}));
vi.mock('./prWatcher.js', () => ({ readPendingMergePrs: vi.fn().mockReturnValue([]) }));
vi.mock('./worktreeManager.js', () => ({ listWorktrees: vi.fn().mockResolvedValue([]) }));
vi.mock('./branchReconcileRetirement.js', async original => ({ ...await original(), assertAutomaticRetirementAllowed: vi.fn(async () => {}) }));
vi.mock('./branchReconcile.js', () => ({
  listRemoteHeads: vi.fn().mockResolvedValue(new Map()),
  cleanupMerged: vi.fn().mockResolvedValue({ cleaned: [] }),
  driveToMerge: (pr) => `merge ${pr} from the repo root once CI is green`,
}));
vi.mock('./git.js', () => ({
  getDefaultBranch: vi.fn().mockResolvedValue('main'),
  hasBranchMergeEvidence: vi.fn().mockResolvedValue(true),
  resolveForgeForRepo: vi.fn().mockResolvedValue({ cli: 'gh', env: null }),
}));
vi.mock('./github.js', () => ({
  execGh: vi.fn(), getPullRequestState: vi.fn(async () => ({ status: 'known', state: 'MERGED' })),
  findPullRequestForBranch: vi.fn().mockResolvedValue({ status: 'none', url: null, detail: null }),
}));
vi.mock('./gitlab.js', () => ({
  findMergeRequestForBranch: vi.fn().mockResolvedValue({ status: 'none', url: null, detail: null }),
}));
vi.mock('./apps.js', () => ({ getAppById: vi.fn().mockResolvedValue({ id: 'demo-app', name: 'Demo App' }) }));
vi.mock('./retirementAppScope.js', () => ({ resolveRetirementApp: vi.fn() }));
vi.mock('./notifications.js', () => ({
  addNotification: vi.fn().mockResolvedValue({}),
  exists: vi.fn().mockResolvedValue(false),
  NOTIFICATION_TYPES: { AGENT_WARNING: 'agent_warning' },
  PRIORITY_LEVELS: { HIGH: 'high' },
}));
vi.mock('./brainTaskThreads.js', () => ({ ensureTaskThread: vi.fn().mockResolvedValue({}), reconcileCleanupThreads: vi.fn(async () => ({ candidates: 0, archived: 0 })) }));
vi.mock('../lib/execGit.js', () => ({ execGit: vi.fn() }));
vi.mock('fs', () => ({ existsSync: vi.fn().mockReturnValue(false) }));
vi.mock('./cosState.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadState: vi.fn(async () => ({ config: { autoApproveInvestigations: true } })),
  };
});

import { inspectOrQueueCompletedReview } from './repoCleanupRecovery.js';
import { readLocalBranchPresence, readCheckoutPathPresence } from './repoCleanupObservation.js';
import { readRetirementForgeEvidence } from './heldCheckoutReview.js';
import { readCompletedCheckoutIdentity } from './completedCheckoutEvidence.js';
import { readClaimOwnershipAgents } from './cosClaimOwnership.js';
import { recordSwarmCleanupContinuationAttempt, recordHistoricalCleanupReconciliation, retryCompletionCheckoutCapture, getAgentRecord, recordCleanupOutcome, recordSwarmCleanupDelivery, reserveRepoCleanupRecovery, recordRepoStateRecovery, recordRepoStateVerification } from './cosAgentLifecycle.js';
import { readCompletionData } from './agentCompletionData.js';
import { recordCompletionCleanup, recordInheritedCheckoutRetirement, recordSeededCheckoutRetirement, recordSuccessorCheckoutRetirement, settleAbsentTaskCompletion } from './cosAgentLifecycle.js';
import { replayAgentCompletionCleanup } from './agentCompletionCleanup.js';
import { recheckAgentCleanup, resumeAgentCompletionRetirement, resumeDeferredRepoStateVerifications, verifyAgentRepoState, sweepRepoStateVerifications, bindCompletionRetirementEvents, REPO_STATE_REMEDIATIONS } from './agentRepoStateVerification.js';
import { readBranchCompletionPolicies } from './branchCompletionPolicy.js';
import { assertAutomaticRetirementAllowed } from './branchReconcileRetirement.js';
import { releaseRetryHold } from './agentWorktreeCleanup.js';
import { verifyCleanupClaimDisposition } from './claimDisposition.js';
import { getTaskById, updateTask } from './cosTaskStore.js';
import { recordBranchReconcileOutcome } from './branchReconcileOutcome.js';
import { loadSchedule } from './taskScheduleStore.js';
import { acknowledgeSwarmCleanupRefill } from './taskSchedule.js';
import { lstat } from 'node:fs/promises';
import { findMissingCheckoutPreservation, prepareInventoriedCheckoutRetirement, retireInventoriedCheckout } from './heldCheckoutRecovery.js';
import { addTask, getAllTasks } from './cosTaskStore.js';
import { ensureTaskThread } from './brainTaskThreads.js';
import { listWorktrees } from './worktreeManager.js';
import { listRemoteHeads, cleanupMerged } from './branchReconcile.js';
import { hasBranchMergeEvidence, resolveForgeForRepo } from './git.js';
import { findPullRequestForBranch, execGh, getPullRequestState } from './github.js';
import { findMergeRequestForBranch } from './gitlab.js';
import { getAppById } from './apps.js';
import { resolveRetirementApp } from './retirementAppScope.js';
import { addNotification, exists as notificationExists } from './notifications.js';
import { cosEvents, emitLog } from './cosEvents.js';
import { readPendingMergePrs } from './prWatcher.js';
import { execGit } from '../lib/execGit.js';
import { existsSync } from 'fs';
import { REPO_STATE_ISSUES, REPO_STATE_SKIPS } from '../lib/repoStateExpectations.js';

const BRANCH = 'cos/task-x/agent-1';
const WORKTREE = '/repo/data/cos/worktrees/agent-1';
const HEAD = '1'.repeat(40);
const RELEASE = { branch: BRANCH, path: WORKTREE, head: HEAD, locked: false, lockReason: null };
const CREATED_AT = '2026-01-01T00:00:00.000Z';

const agentState = (overrides = {}) => ({
  startedAt: CREATED_AT,
  metadata: {
    isWorktree: true,
    sourceWorkspace: '/repo',
    worktreeBranch: BRANCH,
    workspacePath: WORKTREE,
    ...overrides,
  },
});

const task = (metadata = {}) => ({
  id: 'task-1',
  description: 'Do the thing',
  metadata: { app: 'demo-app', appName: 'Demo App', openPR: true, prCompletion: 'merge-on-green', ...metadata },
});

/** `git show-ref --verify refs/heads/<branch>` — exit 0 means the branch is present. */
const localBranch = present => {
  readLocalBranchPresence.mockResolvedValue(present);
  execGit.mockImplementation(async args => ({ exitCode: args[0] === 'merge-base' || present ? 0 : 1, stdout: args[0] === 'rev-parse' ? `${HEAD}\n` : '', stderr: '' }));
};
const review = () => ({ digest: 'a'.repeat(64), policy: { policies: [{ id: 'agent-1', startedAt: CREATED_AT }] },
  comparison: { disposition: 'review-supersession', localPatch: '+old behavior', difference: '+new behavior' }, forge: { prHead: HEAD } });
const completedCleanup = () => ({ version: 1, status: 'completed', stages: Object.fromEntries(
  ['sentinel', 'jira', 'notification', 'pipeline', 'creative', 'worktree', 'report'].map(key => [key, { status: 'done' }])) });
const manualCleanupResult = () => ({ success: false, cleanupPending: true, deliveryRecoveryOwned: true,
  executionSuccess: true, validationPassed: null, taskOutcome: { status: 'incomplete', recovery: { mode: 'cleanup' } } });
const openView = (patch = {}) => JSON.stringify({ number: 9, state: 'OPEN', isDraft: false, isCrossRepository: false, headRefName: BRANCH, headRefOid: HEAD, mergeable: 'MERGEABLE', reviewDecision: '', statusCheckRollup: [{ name: 'CI', status: 'QUEUED' }], ...patch });

/** The `{user, cos}` shape `getAllTasks` really returns. Follow-ups land in `cos`. */
const queuedTasks = (tasks) => getAllTasks.mockResolvedValue({ user: { tasks: [] }, cos: { tasks } });

const observeCompletedTask = async task => {
  const events = new EventEmitter();
  const unbind = bindCompletionRetirementEvents(events);
  try { return await events.listeners('tasks:changed')[0]({ task }); }
  finally { unbind(); }
};

it('verifies a finished release outside the closed spawn Git lifetime while preserving caller context', async () => {
  const caller = new AsyncLocalStorage();
  const agent = { id: 'release-finished', taskId: 'release-sync-task', status: 'completed',
    metadata: { taskAnalysisType: 'release-sync' }, result: { success: true } };
  getAgentRecord.mockResolvedValue(agent);
  verifyReleaseSynchronizationTask.mockImplementationOnce(async id => {
    expect(id).toBe(agent.taskId);
    expect(currentGitMutationLifetime()).toBeUndefined();
    expect(caller.getStore()).toEqual({ operator: 'existing-caller' });
    return { status: 'verified' };
  });
  await caller.run({ operator: 'existing-caller' }, async () => {
    let afterExit, span;
    await withGitMutationLifetime(async () => {
      span = currentGitMutationLifetime();
      afterExit = AsyncResource.bind(() => resumeAgentCompletionRetirement(agent.id));
    });
    expect(span.closed).toBe(true);
    await afterExit();
    expect(span.closed).toBe(true);
  });
  expect(verifyReleaseSynchronizationTask).toHaveBeenCalledOnce();
});

it('reads the claim checkout inventory after owner release even when the spawn Git lifetime closed', async () => {
  const gitWork = await vi.importActual('../lib/execGit.js');
  const caller = new AsyncLocalStorage();
  const branch = 'claim/issue-42';
  const state = { id: 'claim-owner', taskId: 'claim-task', status: 'completed', startedAt: CREATED_AT,
    result: { success: false, cleanupPending: true }, metadata: { isWorktree: false, workspacePath: '/repo',
      claimBranches: [branch], repoStateVerification: { status: 'pending' }, completionCleanup: { status: 'completed' } } };
  const currentTask = { id: state.taskId, taskType: 'user', status: 'in_progress', metadata: {
    app: 'demo-app', deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: state.id } };
  getAgentRecord.mockResolvedValue(state);
  getTaskById.mockResolvedValue(currentTask);
  listWorktrees.mockImplementationOnce(async () => {
    expect(caller.getStore()).toEqual({ operator: 'agent' });
    await gitWork.execGit(['--version'], tmpdir());
    return [];
  });
  readClaimOwnershipAgents.mockResolvedValue([{ id: 'other-owner', status: 'running',
    metadata: { sourceWorkspace: '/repo', claimBranches: [branch] } }]);
  await caller.run({ operator: 'agent' }, async () => {
    let completionCallback;
    await gitWork.withGitMutationLifetime(async () => { completionCallback = AsyncLocalStorage.snapshot(); });
    await completionCallback(async () => {
      const result = await resumeAgentCompletionRetirement(state.id);
      expect(result.branches).toMatchObject([{ branch, verified: false, skipReason: 'claim-owner-active' }]);
      await expect(gitWork.execGit(['--version'], tmpdir())).rejects.toMatchObject({ code: 'GIT_MUTATION_LIFETIME_CLOSED' });
    });
  });
  expect(retireInventoriedCheckout).not.toHaveBeenCalled();
  expect(updateTask).not.toHaveBeenCalled();
});

const run = (overrides = {}) => verifyAgentRepoState({
  agentId: 'agent-1',
  task: task(),
  agentState: agentState(),
  success: true,
  prExpected: true,
  ...overrides,
});

it.each(['all-merged', 'all-retired', 'one-open', 'manual-merged'])('wakes a cleanup-held swarm only after independent delivery proof: %s', async scenario => {
  const start = CREATED_AT;
  const branches = ['claim/issue-1', 'claim/issue-2'];
  const heads = ['a'.repeat(40), 'b'.repeat(40)];
  const urls = branches.map((_, i) => `https://github.com/example/repo/pull/${i + 1}`);
  const outcome = { status: 'incomplete', recovery: { mode: 'cleanup' } };
  const originalTask = { id: 'task-swarm', taskType: 'internal', status: 'in_progress', metadata: {
    app: 'demo-app', analysisType: 'claim-issue', perpetual: true, claimFlow: true, swarmCount: 2,
    claimedBy: 'fixture-local', claimedAt: start, lastSpawnedAt: start, totalSpawnCount: 1,
    deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-swarm', taskOutcome: outcome,
  } };
  const agent = { id: 'agent-swarm', taskId: originalTask.id, status: 'completed', startedAt: start,
    completedAt: '2026-01-01T00:01:00.000Z', result: { executionSuccess: true, cleanupPending: true,
      deliveryRecoveryOwned: true, taskOutcome: outcome }, metadata: { instanceId: 'fixture-local', taskApp: 'demo-app',
      taskAnalysisType: 'claim-issue', configClaimFlow: true, isWorktree: false, workspacePath: '/repo',
      claimBranches: branches, claimReleasedBranches: [], checkoutCapture: { status: 'captured' }, repoStateVerification: { status: 'pending' },
      completionTaskDispatch: { taskId: originalTask.id, taskType: 'internal', expected: [
        ['claimedBy', 'fixture-local'], ['claimedAt', start], ['lastSpawnedAt', start], ['totalSpawnCount', 1],
      ] }, completedCheckouts: branches.map((branch, index) => ({ version: 1, agentId: 'agent-swarm', startedAt: start,
        capturedAt: start, repoPath: '/repo', path: `/tree/${index}`, branch, head: heads[index],
        incarnation: { pointer: { dev: '1', ino: '2', birthtimeNs: '3' } } })) } };
  getAgentRecord.mockResolvedValue(agent);
  getTaskById.mockResolvedValue(originalTask);
  listWorktrees.mockResolvedValue(branches.map((branch, index) => ({ branch: `refs/heads/${branch}`, path: `/tree/${index}`, head: heads[index] })));
  readCompletedCheckoutIdentity.mockImplementation(async ({ branch }) => agent.metadata.completedCheckouts.find(row => row.branch === branch));
  readCheckoutPathPresence.mockResolvedValue(true);
  prepareInventoriedCheckoutRetirement.mockResolvedValue({ ok: false, reason: 'worktree-dirty' });
  findPullRequestForBranch.mockImplementation(async branch => {
    const index = branches.indexOf(branch);
    return { status: 'found', number: index + 1, url: urls[index],
      detail: scenario === 'one-open' && index === 1 ? 'OPEN' : 'MERGED' };
  });
  readRetirementForgeEvidence.mockImplementation(async (_repo, branch) => {
    const index = branches.indexOf(branch);
    return { scopeProof: 'exact-delivered-head', prHead: heads[index], prUrl: urls[index] };
  });
  recordSwarmCleanupDelivery.mockImplementation(async (_id, _expected, proof) => {
    agent.metadata.swarmCleanupDelivery = proof;
    return true;
  });
  if (scenario === 'all-retired') {
    recordBranchReconcileOutcome.mockImplementation(async (_app, input) => ({
      retirementObligations: input.retirementObligations?.map(row => ({ ...row, createdAt: CREATED_AT })) || [],
    }));
    prepareInventoriedCheckoutRetirement.mockImplementation(async ({ release }) => ({ ok: true, review: { digest: 'a'.repeat(64),
      forge: { prHead: release.head }, comparison: { disposition: 'integrated', localPatch: '', difference: '' } } }));
    updateTask.mockImplementation(async (_id, patch) => {
      originalTask.status = patch.status;
      Object.assign(originalTask.metadata, patch.metadata);
      return originalTask;
    });
    recordRepoStateVerification.mockImplementation(async (_id, verification) => {
      agent.metadata.repoStateVerification = verification;
      agent.metadata.cleanupOutcome = { status: 'verified', unresolved: 0, committedIntegrationVerified: true };
      agent.result = { ...agent.result, success: true, cleanupPending: false, deferredDeliveryOutcome: outcome, taskOutcome: { status: 'completed' } };
      return true;
    });
  }
  const emitted = vi.spyOn(cosEvents, 'emit');
  try {
    const manualCleanupOnly = scenario === 'manual-merged';
    const result = await run({ agentId: agent.id, task: originalTask, agentState: agent, success: false,
      ...(manualCleanupOnly && { manualCleanupOnly, recheckCleanup: async () => {} }) });
    expect(result.verified).toBe(scenario === 'all-retired');
    expect(originalTask.status).toBe(scenario === 'all-retired' ? 'completed' : 'in_progress');
    if (scenario !== 'one-open' && !manualCleanupOnly) {
      expect(recordSwarmCleanupDelivery).toHaveBeenCalledWith(agent.id, agent, expect.objectContaining({ version: 1 }));
      expect(emitted).toHaveBeenCalledWith('swarm:cleanup-delivery-verified', { agentId: agent.id });
      const notification = emitted.mock.calls.findIndex(([event]) => event === 'swarm:cleanup-delivery-verified');
      expect(emitted.mock.invocationCallOrder[notification]).toBeGreaterThan(listWorktrees.mock.invocationCallOrder.at(-1));
    } else {
      expect(recordSwarmCleanupDelivery).not.toHaveBeenCalled();
      expect(emitted).not.toHaveBeenCalledWith('swarm:cleanup-delivery-verified', expect.anything());
    }
  } finally { emitted.mockRestore(); }
});

beforeEach(() => {
  vi.clearAllMocks();
  lstat.mockImplementation(async (...args) => (await vi.importActual('node:fs/promises')).lstat(...args));
  loadSchedule.mockReset().mockResolvedValue({});
  readGitCommonDirectory.mockReset().mockResolvedValue('/repo/.git');
  retryCompletionCheckoutCapture.mockReset().mockResolvedValue(false);
  getAgentRecord.mockReset().mockResolvedValue(null);
  findMissingCheckoutPreservation.mockResolvedValue(null);
  recordCleanupOutcome.mockReset().mockResolvedValue(true);
  readRetirementForgeEvidence.mockReset().mockResolvedValue({ prHead: HEAD, mergeCommit: '3'.repeat(40), defaultHead: '2'.repeat(40) });
  inspectOrQueueCompletedReview.mockResolvedValue({ disposition: 'held', reason: 'delivery-ci-or-review-pending' });
  readBranchCompletionPolicies.mockResolvedValue([]);
  updateTask.mockReset().mockResolvedValue({ status: 'completed' });
  getTaskById.mockResolvedValue({ ...task(), status: 'in_progress', metadata: { ...task().metadata,
    deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-1' } });
  recordBranchReconcileOutcome.mockResolvedValue({ retirementObligations: [{ ...RELEASE, createdAt: CREATED_AT }] });
  prepareInventoriedCheckoutRetirement.mockResolvedValue({ ok: true, review: review() });
  retireInventoriedCheckout.mockReset().mockResolvedValue({ ok: true, archiveDir: '/private/archive', branchDeleted: true });
  execGh.mockResolvedValue(openView());
  readClaimOwnershipAgents.mockResolvedValue([]);
  reserveRepoCleanupRecovery.mockResolvedValue({ admitted: true, attempt: 1 });
  listWorktrees.mockResolvedValue([]);
  listRemoteHeads.mockResolvedValue(new Map());
  cleanupMerged.mockResolvedValue({ cleaned: [] });
  existsSync.mockReturnValue(false);
  readCheckoutPathPresence.mockImplementation(async () => existsSync());
  hasBranchMergeEvidence.mockResolvedValue(true);
  queuedTasks([]);
  getAppById.mockResolvedValue({ id: 'demo-app', name: 'Demo App', repoPath: '/repo' });
  readPendingMergePrs.mockReturnValue([]);
  resolveForgeForRepo.mockResolvedValue({ cli: 'gh', env: null });
  findPullRequestForBranch.mockResolvedValue({ status: 'none', url: null, detail: null });
  findMergeRequestForBranch.mockResolvedValue({ status: 'none', url: null, detail: null });
  notificationExists.mockResolvedValue(false);
  addTask.mockImplementation(async payload => {
    const created = { ...payload, id: 'task-recovery-1', metadata: payload.metadata };
    const existing = getTaskById.getMockImplementation();
    getTaskById.mockImplementation(async id => id === created.id ? created : existing?.(id));
    return created;
  });
  localBranch(false);
});

describe('verifyAgentRepoState — clean runs', () => {
  it.each(['pending', 'captured', 'lost-record'])('retries failed-run identity capture without promoting delivery or cleanup: %s', async scenario => {
    const state = { ...agentState({ checkoutCapture: { status: 'pending' }, repoStateVerification: { status: 'pending' } }),
      id: 'agent-1', status: 'completed', startedAt: CREATED_AT, result: { success: false, executionSuccess: false, orphaned: true } };
    retryCompletionCheckoutCapture.mockResolvedValue(scenario !== 'pending');
    if (scenario === 'captured') getAgentRecord.mockResolvedValue({ ...state,
      metadata: { ...state.metadata, checkoutCapture: { status: 'captured' }, completedCheckouts: [RELEASE] } });
    expect(await run({ success: false, agentState: state })).toMatchObject({
      skipReason: scenario === 'captured' ? REPO_STATE_SKIPS.FAILED_RUN : 'checkout-capture-pending',
    });
    expect(state.result).toEqual({ success: false, executionSuccess: false, orphaned: true });
    expect(addTask).not.toHaveBeenCalled();
    expect(retireInventoriedCheckout).not.toHaveBeenCalled();
  });

  it('retains unresolved verification after an explicit retry without adopting its task or touching Git', async () => {
    getTaskById.mockResolvedValue({ ...task(), status: 'pending' });
    const state = { ...agentState({ repoStateVerification: { status: 'pending' } }), result: { cleanupPending: true } };
    expect(await run({ success: false, agentState: state })).toMatchObject({ skipReason: 'cleanup-owner-changed' });
    expect(retireInventoriedCheckout).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    expect(recordRepoStateVerification).not.toHaveBeenCalled();
  });

  it('settles an exhausted original cleanup owner after merge verification without another dispatch', async () => {
    const blocked = { ...task(), status: 'blocked', metadata: { ...task().metadata,
      blockedCategory: 'task-recovery-exhausted', deliveryDecisionAgentId: 'agent-1',
      deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-1', failureCount: '3', totalSpawnCount: '3', lastSpawnedAt: CREATED_AT } };
    const completed = { version: 1, agentId: 'agent-1', repoPath: '/repo', branch: BRANCH, path: WORKTREE,
      head: HEAD, startedAt: CREATED_AT, capturedAt: CREATED_AT, incarnation: { pointer: { dev: '1', ino: '2', birthtimeNs: '3' } } };
    const state = { ...agentState({ completedCheckouts: [completed], completionCleanup: { version: 1, status: 'pending' },
      reviewLoopMergeTarget: { url: 'https://github.com/example/repo/pull/7', branch: BRANCH },
      completionTaskDispatch: { taskId: 'task-1', taskType: 'user', expected: [['lastSpawnedAt', CREATED_AT], ['totalSpawnCount', 3]] } }),
      id: 'agent-1', taskId: 'task-1', status: 'completed',
      result: { success: false, executionSuccess: true, cleanupPending: true } };
    const original = structuredClone(blocked);
    getTaskById.mockResolvedValue(blocked);
    state.metadata.isPersistentWorktree = true;
    expect(await run({ success: false, agentState: state, task: blocked })).toMatchObject({ verified: false });
    expect(updateTask).not.toHaveBeenCalled();
    expect(releaseRetryHold).not.toHaveBeenCalled();
    delete state.metadata.isPersistentWorktree;
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://github.com/example/repo/pull/7', detail: { state: 'MERGED' } });
    existsSync.mockReturnValue(true);
    localBranch(true);
    listWorktrees.mockResolvedValue([RELEASE]);
    readCompletedCheckoutIdentity.mockResolvedValue(completed);
    expect(await run({ success: false, agentState: state, task: blocked })).toMatchObject({ skipReason: 'cleanup-budget-exhausted' });
    expect(addTask).not.toHaveBeenCalled();
    existsSync.mockReturnValue(false);
    localBranch(false);
    listWorktrees.mockResolvedValue([]);
    findMissingCheckoutPreservation.mockResolvedValue({ archiveDir: null, evidenceDigest: 'a'.repeat(64), recheck: async () => true });
    for (const [key, value] of [['blocker', 'operator hold'], ['blockedCategory', 'task-approval'], ['totalSpawnCount', '4'],
      ['deliveryRecoveryAgentId', 'another-owner']]) {
      const prior = blocked.metadata[key]; blocked.metadata[key] = value;
      expect(await run({ success: false, agentState: state, task: blocked })).toMatchObject({ skipReason: 'cleanup-owner-changed' });
      expect(updateTask).not.toHaveBeenCalled();
      if (prior === undefined) delete blocked.metadata[key]; else blocked.metadata[key] = prior;
    }
    updateTask.mockResolvedValueOnce({ statusChanged: true });
    expect(await run({ success: false, agentState: state, task: blocked })).toMatchObject({ skipReason: 'cleanup-task-settlement-unverified' });
    expect(await run({ success: false, agentState: state, task: blocked })).toMatchObject({ verified: true });
    expect(updateTask).toHaveBeenLastCalledWith('task-1', expect.objectContaining({ status: 'completed' }), 'user', {
      expectedStatus: 'blocked', expectedTask: { description: blocked.description, priority: blocked.priority, metadata: blocked.metadata },
      recoveryOwner: { id: 'agent-1', startedAt: CREATED_AT }, preserveRetryBudget: true,
    });
    expect(blocked).toEqual(original);
    expect(state.result).toEqual({ success: false, executionSuccess: true, cleanupPending: true });
    expect(addTask).not.toHaveBeenCalled();
    expect(releaseRetryHold).not.toHaveBeenCalled();
    expect(retireInventoriedCheckout).not.toHaveBeenCalled();
  });

  it('transfers a cleanup handoff that cannot retire a human leave-open branch', async () => {
    updateTask.mockResolvedValueOnce({ status: 'in_progress' });
    const pending = { ...task({ prCompletion: 'leave-open' }), status: 'in_progress', metadata: {
      ...task({ prCompletion: 'leave-open' }).metadata, deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-1',
    } };
    getTaskById.mockResolvedValue(pending);
    existsSync.mockReturnValue(true);
    localBranch(true);
    const state = { ...agentState(), result: { cleanupPending: true } };
    expect(await run({ success: false, agentState: state, task: pending })).toMatchObject({ skipReason: 'cleanup-transferred-to-recovery' });
    expect(retireInventoriedCheckout).not.toHaveBeenCalled();
    expect(releaseRetryHold).toHaveBeenCalledOnce();
  });

  it('keeps a merged delivery policy hold in service recovery without retrying the review task', async () => {
    const pending = { ...task({ prCompletion: 'review-then-merge', reviewLoopFollowUp: 'true' }), status: 'in_progress' };
    pending.metadata = { ...pending.metadata, deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-1', totalSpawnCount: '2' };
    getTaskById.mockResolvedValue(pending);
    const state = { ...agentState({ repoStateVerification: { status: 'pending' } }),
      result: { success: false, executionSuccess: true, cleanupPending: true } };
    existsSync.mockReturnValue(true);
    localBranch(true);
    listWorktrees.mockResolvedValue([RELEASE]);
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://github.com/example/repo/pull/7', detail: 'MERGED' });
    prepareInventoriedCheckoutRetirement.mockResolvedValue({ ok: false, reason: 'retirement-policy-not-legacy-completed' });
    // Repeated completion sweeps must retain ownership and the original budget.
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await run({ task: pending, success: false, agentState: state })).toMatchObject({
        verified: false, skipReason: 'retirement-policy-not-legacy-completed', recoveryTaskId: null,
      });
    }
    expect(recordBranchReconcileOutcome).toHaveBeenCalledWith('demo-app', expect.objectContaining({
      retirementObligations: [{ ...RELEASE, reason: 'retirement-review-pending' }],
    }));
    expect(recordRepoStateVerification).toHaveBeenLastCalledWith('agent-1', expect.objectContaining({
      status: 'pending', reasons: ['retirement-policy-not-legacy-completed'],
    }));
    expect(updateTask).not.toHaveBeenCalled();
    expect(releaseRetryHold).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
    expect(retireInventoriedCheckout).not.toHaveBeenCalled();
    // Once the hold clears, the same service owner retries retirement, not delivery.
    prepareInventoriedCheckoutRetirement.mockResolvedValue({ ok: true, review: {
      ...review(), comparison: { disposition: 'integrated', localPatch: '', difference: '' },
    } });
    retireInventoriedCheckout.mockResolvedValue({ ok: true, branchDeleted: true, archiveDir: null });
    expect(await run({ task: pending, success: false, agentState: state })).toMatchObject({ verified: true });
    expect(updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'completed' }), 'user', expect.any(Object));
    expect(releaseRetryHold).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  it('transfers unsupported cleanup verification back to bounded recovery', async () => {
    updateTask.mockResolvedValueOnce({ status: 'in_progress' });
    const state = { ...agentState({ isPersistentWorktree: true, repoStateVerification: { status: 'pending' } }),
      result: { success: false, cleanupPending: true } };
    expect(await run({ success: false, agentState: state })).toMatchObject({ skipReason: 'cleanup-transferred-to-recovery' });
    expect(updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'in_progress',
      metadata: expect.objectContaining({ failureCount: 1, retryPendingCleanup: 'agent-1' }) }), 'user', expect.any(Object));
    expect(releaseRetryHold).toHaveBeenCalledOnce();
    expect(recordRepoStateVerification).toHaveBeenLastCalledWith('agent-1', expect.objectContaining({ status: 'completed', reasons: ['cleanup-transferred-to-recovery'] }));
  });

  it.each(['OPEN', 'CLOSED'])('transfers a definitive %s undelivered PR out of the cleanup hold', async prState => {
    updateTask.mockResolvedValueOnce({ status: 'in_progress' });
    const pending = { ...task({ openPR: false, claimFlow: true }), status: 'in_progress' };
    pending.metadata = { ...pending.metadata, deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-1' };
    getTaskById.mockResolvedValue(pending);
    localBranch(true);
    existsSync.mockReturnValue(true);
    findPullRequestForBranch.mockResolvedValue({ status: 'found', detail: prState, url: 'https://github.com/example/repo/pull/7' });
    const state = { ...agentState(), result: { success: false, cleanupPending: true } };
    expect(await run({ task: pending, prExpected: false, success: false, agentState: state })).toMatchObject({ skipReason: 'cleanup-transferred-to-recovery' });
    expect(releaseRetryHold).toHaveBeenCalledOnce();
    expect(addTask).not.toHaveBeenCalled();
  });

  it.each(['parked', 'unverified', 'wrong-issue', 'open-pr'])('retains only an independently verified parked swarm checkout: %s', async scenario => {
    const branch = 'claim/issue-42';
    const capture = { version: 1, agentId: 'agent-swarm', startedAt: CREATED_AT, capturedAt: CREATED_AT,
      repoPath: '/repo', branch, path: '/tree/42', head: HEAD,
      incarnation: { pointer: { dev: '1', ino: '2', birthtimeNs: '3' } } };
    const delivered = { ...capture, branch: 'claim/issue-43', path: '/tree/43' };
    const outcome = { status: 'incomplete', recovery: { mode: 'cleanup' } };
    const state = { id: 'agent-swarm', taskId: 'task-1', status: 'completed', startedAt: CREATED_AT,
      result: { executionSuccess: true, deliveryRecoveryOwned: true, cleanupPending: true, taskOutcome: outcome },
      metadata: { isWorktree: false, workspacePath: '/repo', configClaimFlow: true, claimPicksOwnBranch: true,
        claimBranches: [branch, delivered.branch], completedCheckouts: [capture, delivered], repoStateVerification: { status: 'pending' } } };
    const pending = { ...task({ claimFlow: true }), status: 'in_progress', metadata: { ...task({ claimFlow: true }).metadata,
      deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: state.id } };
    getTaskById.mockResolvedValue(pending);
    listWorktrees.mockResolvedValue([capture, delivered].map(row => ({ branch: `refs/heads/${row.branch}`, path: row.path, head: row.head })));
    readCompletedCheckoutIdentity.mockImplementation(async ({ branch: name }) => name === branch ? capture : delivered);
    readCheckoutPathPresence.mockResolvedValue(true);
    localBranch(true);
    findPullRequestForBranch.mockImplementation(async name => name === delivered.branch
      ? { status: 'found', detail: 'MERGED', url: 'https://github.com/example/repo/pull/43' }
      : scenario === 'open-pr' ? { status: 'found', detail: 'OPEN', url: 'https://github.com/example/repo/pull/42' }
        : { status: 'none', url: null, detail: null });
    verifyCleanupClaimDisposition.mockResolvedValue(scenario === 'unverified' ? { status: 'unverified' }
      : { status: 'verified', issues: [{ issue: scenario === 'wrong-issue' ? 43 : 42, disposition: 'operator-blocked' }] });
    updateTask.mockResolvedValue({ status: 'in_progress' });
    const result = await run({ agentId: state.id, task: pending, agentState: state, success: false });
    if (scenario === 'parked') {
      expect(result.branches).toMatchObject([{ branch, verified: false, skipReason: 'cleanup-delivery-unverified' },
        { branch: delivered.branch, verified: false }]);
      expect(recordRepoStateVerification).toHaveBeenLastCalledWith(state.id, expect.objectContaining({ status: 'pending' }));
      expect(updateTask).not.toHaveBeenCalled();
      expect(releaseRetryHold).not.toHaveBeenCalled();
    } else {
      expect(result.skipReason).toBe('cleanup-transferred-to-recovery');
      expect(releaseRetryHold).toHaveBeenCalledOnce();
    }
    expect(retireInventoriedCheckout).not.toHaveBeenCalled();
  });

  it.each(['follow-up', 'capture'])('immediately finalizes receipt-retired delivery after %s, including duplicate observations', async event => {
    const completed = { version: 1, agentId: 'agent-1', repoPath: '/repo', branch: BRANCH, path: WORKTREE, head: HEAD,
      startedAt: CREATED_AT, capturedAt: CREATED_AT, incarnation: { pointer: { dev: '1', ino: '2', birthtimeNs: '3' } } };
    const state = { ...agentState({ instanceId: 'fixture-local', completedCheckouts: [completed],
      reviewLoopMergeTarget: { url: 'https://github.com/example/repo/pull/7' }, repoStateVerification: { status: 'pending' },
      completionCleanup: { version: 1 } }), id: 'agent-1', taskId: 'task-1', status: 'completed',
      result: { success: false, executionSuccess: true, cleanupPending: true } };
    getAgentRecord.mockResolvedValue(state);
    findMissingCheckoutPreservation.mockResolvedValue({ archiveDir: null, evidenceDigest: 'a'.repeat(64), recheck: async () => true });
    // The old source SHA is not an ancestor after squash; only the actual merge is.
    execGit.mockImplementation(async args => ({ exitCode: args[0] === 'merge-base' ? (args[2] === '3'.repeat(40) ? 0 : 1) : 1, stdout: '' }));
    const followUp = { id: 'delivery-follow-up', status: 'completed', metadata: { reviewLoopFollowUp: 'true',
      sourceAgentId: 'agent-1', sourceTaskId: 'task-1', reviewLoopPRBranch: BRANCH } };
    queuedTasks([followUp]);
    const events = new EventEmitter();
    const unbind = bindCompletionRetirementEvents(events);
    const name = event === 'capture' ? 'agent:checkout-captured' : 'tasks:changed';
    const payload = event === 'capture' ? { agentId: 'agent-1' } : { type: 'internal', task: followUp, previousStatus: 'in_progress' };
    events.emit(name, payload);
    events.emit(name, payload);
    await vi.waitFor(() => expect(recordRepoStateVerification).toHaveBeenLastCalledWith('agent-1', expect.objectContaining({ status: 'completed' })));
    unbind();
    expect(updateTask).toHaveBeenCalledOnce();
    expect(updateTask).toHaveBeenLastCalledWith('task-1', expect.objectContaining({ status: 'completed' }), 'user', expect.any(Object));
    expect(recordRepoStateVerification).toHaveBeenLastCalledWith('agent-1', expect.objectContaining({ status: 'completed' }));
    expect(addTask).not.toHaveBeenCalled();
    expect(inspectOrQueueCompletedReview).not.toHaveBeenCalled();
    expect(retireInventoriedCheckout).not.toHaveBeenCalled();
    expect(findMissingCheckoutPreservation).not.toHaveBeenCalled();
    expect(state.result).toEqual({ success: false, executionSuccess: true, cleanupPending: true });
  });

  it.each(['verified', 'startup', 'duplicate', 'missing-receipt', 'wrong-generation', 'foreign-instance', 'replaced-repository', 'receipt-raced', 'live-owner', 'live-path', 'live-ref',
    'moved-alias', 'alias-wrong-head', 'alias-wrong-generation', 'alias-wrong-branch', 'alias-unsettled', 'alias-live-path'])(
    'settles only physical cleanup from its own seed and canonical receipt: %s', async scenario => {
      const physical = { dev: '1', ino: '2', birthtimeNs: '3' };
      const seed = { version: 1, agentId: 'unknown-source', startedAt: CREATED_AT,
        seededAt: '2026-01-01T00:00:01.000Z', repoPath: '/repo', branch: BRANCH, path: WORKTREE,
        repository: physical, checkout: physical,
        incarnation: { pointer: physical, gitdir: { ...physical, path: '/repo/.git/worktrees/original' } } };
      const state = { id: seed.agentId, taskId: 'no-change-investigation', status: 'completed', startedAt: CREATED_AT,
        completedAt: '2026-01-01T00:01:00.000Z', result: { success: false, validationPassed: false, taskOutcome: { status: 'blocked' } },
        metadata: { instanceId: 'fixture-local', sourceWorkspace: '/repo', workspacePath: WORKTREE, worktreeBranch: BRANCH,
          checkoutSeeds: [seed], completedCheckouts: [], checkoutCapture: { status: 'pending', unknown: true, targets: [] },
          repoStateVerification: { status: 'pending' }, completionCleanup: { status: 'pending' } } };
      const checkoutIdentity = retirementCheckoutIdentityFromPointer(physical);
      const receipt = { path: WORKTREE, branch: BRANCH, head: HEAD, checkoutIdentity,
        branchDeleted: true, retiredAt: '2026-01-01T00:02:00.000Z', archiveDir: null };
      if (scenario === 'moved-alias' || scenario.startsWith('alias-')) {
        receipt.path = `${WORKTREE}-successor`;
        receipt.settledObservations = [{ observation: { path: WORKTREE, branch: BRANCH, head: HEAD, checkoutIdentity },
          settledAt: '2026-01-01T00:02:01.000Z' }];
        const alias = receipt.settledObservations[0];
        if (scenario === 'alias-wrong-head') alias.observation.head = 'c'.repeat(40);
        if (scenario === 'alias-wrong-generation') alias.observation.checkoutIdentity = 'f'.repeat(64);
        if (scenario === 'alias-wrong-branch') alias.observation.branch = 'other-branch';
        if (scenario === 'alias-unsettled') delete alias.settledAt;
      }
      if (scenario === 'wrong-generation') receipt.checkoutIdentity = 'f'.repeat(64);
      if (scenario === 'foreign-instance') state.metadata.instanceId = 'another-install';
      loadSchedule.mockResolvedValue({ executions: { 'task:branch-reconcile': { perApp: { 'demo-app': {
        branchReconcileOutcome: { retired: scenario === 'missing-receipt' ? [] : [receipt], retirementReceiptEvidence: {} } } } } } });
      lstat.mockResolvedValue({ isDirectory: () => true, dev: 1n, ino: scenario === 'replaced-repository' ? 9n : 2n, birthtimeNs: 3n });
      findMissingCheckoutPreservation.mockResolvedValue({ kind: 'service-retirement-receipt', evidenceDigest: 'a'.repeat(64),
        recheck: async () => scenario !== 'receipt-raced' });
      if (scenario === 'live-owner') readClaimOwnershipAgents.mockResolvedValue([{ status: 'running', metadata: {
        sourceWorkspace: '/repo', worktreeBranch: BRANCH } }]);
      if (scenario === 'live-path' || scenario === 'alias-live-path') readCheckoutPathPresence.mockResolvedValue(true);
      if (scenario === 'live-ref') readLocalBranchPresence.mockResolvedValue(true);
      getAgentRecord.mockResolvedValue(state); readBranchCompletionPolicies.mockResolvedValue([state]);
      if (scenario === 'startup' || scenario === 'duplicate') {
        // A receipt written before restart settles without waiting for retryAt.
        state.metadata.completionCleanup.retryAt = '2999-01-01T00:00:00Z';
        recordSeededCheckoutRetirement.mockImplementationOnce(async () => {
          state.metadata.checkoutCapture.status = 'retired';
          state.metadata.completionCleanup.status = state.metadata.repoStateVerification.status = 'completed';
          return true;
        });
        if (scenario === 'startup') {
          await sweepRepoStateVerifications();
          expect(loadSchedule).toHaveBeenCalledOnce();
        } else {
          const events = new EventEmitter(), unbind = bindCompletionRetirementEvents(events);
          try {
            const observe = events.listeners('checkout:retired')[0];
            await observe({ appId: 'demo-app', ...receipt });
            await observe({ appId: 'demo-app', ...receipt });
          } finally { unbind(); }
        }
      } else {
        const events = new EventEmitter(), unbind = bindCompletionRetirementEvents(events);
        try { await events.listeners('checkout:retired')[0]({ appId: 'demo-app', ...receipt }); } finally { unbind(); }
      }
      const settled = ['verified', 'startup', 'duplicate', 'moved-alias'].includes(scenario);
      expect(recordSeededCheckoutRetirement).toHaveBeenCalledTimes(settled ? 1 : 0);
      if (settled) expect(recordSeededCheckoutRetirement).toHaveBeenCalledWith(state.id, state, {
        checkoutIdentity, retiredHead: HEAD, receiptDigest: 'a'.repeat(64) });
      if (scenario === 'moved-alias') expect(findMissingCheckoutPreservation).toHaveBeenCalledWith({ repoPath: '/repo',
        release: { path: receipt.path, branch: BRANCH, head: HEAD, createdAt: seed.seededAt, checkoutIdentity } });
      expect(state.metadata.completedCheckouts).toEqual([]);
      expect(state.result).toEqual({ success: false, validationPassed: false, taskOutcome: { status: 'blocked' } });
      expect(addTask).not.toHaveBeenCalled(); expect(updateTask).not.toHaveBeenCalled();
      expect(retireInventoriedCheckout).not.toHaveBeenCalled();
    });

  it.each(['startup', 'direct', 'wrong-parent', 'wrong-task', 'foreign-instance', 'own-seed', 'live-owner', 'live-source-path',
    'parent-raced', 'late-retirement', 'wrong-generation', 'wrong-branch', 'unreadable-receipt'])(
    'settles only a primary continuation of an already retired inherited scope: %s', async scenario => {
      const physical = { dev: '1', ino: '2', birthtimeNs: '3' };
      const seed = { version: 1, agentId: 'parent', startedAt: CREATED_AT, seededAt: '2026-01-01T00:00:01.000Z',
        repoPath: '/repo', branch: BRANCH, path: WORKTREE, repository: physical, checkout: physical,
        incarnation: { pointer: physical, gitdir: { ...physical, path: '/repo/.git/worktrees/parent' } } };
      const parent = { id: 'parent', taskId: 'old-claim', status: 'completed', startedAt: CREATED_AT,
        completedAt: '2026-01-01T00:01:00.000Z', result: { success: false }, metadata: {
          instanceId: 'fixture-local', sourceWorkspace: '/repo', workspacePath: WORKTREE, worktreeBranch: BRANCH,
          checkoutSeeds: [seed], completedCheckouts: [{ version: 1, agentId: 'parent', startedAt: CREATED_AT,
            capturedAt: '2026-01-01T00:00:59.000Z', repoPath: '/repo', branch: BRANCH, path: WORKTREE, head: HEAD,
            incarnation: seed.incarnation }], completionCleanup: { status: 'completed' }, repoStateVerification: { status: 'completed' } } };
      const child = { id: 'child', taskId: 'old-claim', status: 'completed', startedAt: '2026-01-01T00:04:00.000Z',
        completedAt: '2026-01-01T00:05:00.000Z', result: { success: false, executionSuccess: true, taskOutcome: { status: 'incomplete' } },
        metadata: { instanceId: 'fixture-local', isWorktree: false, workspacePath: '/repo', resumedFromAgentId: 'parent',
          claimBranches: [BRANCH], checkoutCapture: { status: 'pending', unknown: true, targets: [] },
          completionCleanup: { status: 'pending' }, repoStateVerification: { status: 'pending' } } };
      const receipt = { path: WORKTREE, branch: BRANCH, head: HEAD, checkoutIdentity: retirementCheckoutIdentityFromPointer(physical),
        branchDeleted: true, archiveDir: null, retiredAt: '2026-01-01T00:02:00.000Z' };
      if (scenario === 'wrong-parent') child.metadata.resumedFromAgentId = 'missing';
      if (scenario === 'wrong-task') parent.taskId = 'other-task';
      if (scenario === 'foreign-instance') child.metadata.instanceId = 'foreign';
      if (scenario === 'own-seed') child.metadata.checkoutSeeds = [seed];
      if (scenario === 'wrong-branch') child.metadata.claimBranches = ['unrelated'];
      if (scenario === 'late-retirement') receipt.retiredAt = '2026-01-01T00:04:01.000Z';
      if (scenario === 'wrong-generation') receipt.checkoutIdentity = 'f'.repeat(64);
      if (scenario === 'live-source-path') readCheckoutPathPresence.mockResolvedValue(true);
      if (scenario === 'live-owner') readClaimOwnershipAgents.mockResolvedValue([{ status: 'running', metadata: { sourceWorkspace: '/repo', worktreeBranch: BRANCH } }]);
      loadSchedule.mockResolvedValue({ executions: { 'task:branch-reconcile': { perApp: { app: { branchReconcileOutcome: { retired: [receipt] } } } } } });
      if (scenario === 'unreadable-receipt') loadSchedule.mockRejectedValue(new Error('synthetic unreadable receipts'));
      lstat.mockResolvedValue({ isDirectory: () => true, dev: 1n, ino: 2n, birthtimeNs: 3n });
      findMissingCheckoutPreservation.mockResolvedValue({ kind: 'service-retirement-receipt', evidenceDigest: 'a'.repeat(64), recheck: async () => true });
      let parentReads = 0;
      getAgentRecord.mockImplementation(async id => id === child.id ? child : id === parent.id
        ? scenario === 'parent-raced' && ++parentReads > 1 ? { ...parent, taskId: 'changed' } : parent : null);
      readBranchCompletionPolicies.mockResolvedValue([parent, child]);
      if (scenario === 'direct') await resumeAgentCompletionRetirement(child.id);
      else await sweepRepoStateVerifications();
      expect(recordInheritedCheckoutRetirement).toHaveBeenCalledTimes(['startup', 'direct'].includes(scenario) ? 1 : 0);
      if (['startup', 'direct'].includes(scenario)) expect(recordInheritedCheckoutRetirement).toHaveBeenCalledWith(child.id, child, {
        checkoutIdentity: receipt.checkoutIdentity, retiredHead: HEAD, receiptDigest: 'a'.repeat(64), inheritedFromAgentId: parent.id });
      expect(child.result).toEqual({ success: false, executionSuccess: true, taskOutcome: { status: 'incomplete' } });
      expect(child.metadata.checkoutSeeds).toEqual(scenario === 'own-seed' ? [seed] : undefined);
      expect(recordSeededCheckoutRetirement).not.toHaveBeenCalled();
      expect(addTask).not.toHaveBeenCalled(); expect(updateTask).not.toHaveBeenCalled(); expect(retireInventoriedCheckout).not.toHaveBeenCalled();
    });

  it.each(['available', 'unavailable'])('shares one %s receipt context across ordinary startup replay records', async scenario => {
    const physical = { dev: '1', ino: '2', birthtimeNs: '3' };
    const agents = Array.from({ length: 3 }, (_, index) => {
      const id = `ordinary-${index}`, branch = `feature/${id}`, path = `/repo/worktrees/${id}`;
      const seed = { version: 1, agentId: id, startedAt: CREATED_AT, seededAt: '2026-01-01T00:00:01.000Z',
        repoPath: '/repo', branch, path, repository: physical, checkout: physical,
        incarnation: { pointer: physical, gitdir: { ...physical, path: `/repo/.git/worktrees/${id}` } } };
      return { id, taskId: `task-${id}`, status: 'completed', startedAt: CREATED_AT, completedAt: '2026-01-01T00:01:00.000Z',
        result: { success: false, cleanupPending: true, validationPassed: false },
        metadata: { instanceId: index === 0 ? 'other-install' : 'fixture-local', sourceWorkspace: '/repo',
          workspacePath: path, worktreeBranch: branch, checkoutSeeds: index === 2 ? [] : [seed],
          completedCheckouts: [], checkoutCapture: { status: 'pending', unknown: true },
          repoStateVerification: { status: 'pending' }, completionCleanup: { status: 'pending', replay: { version: 1 } } } };
    });
    if (scenario === 'unavailable') loadSchedule.mockRejectedValue(new Error('synthetic schedule unavailable'));
    readBranchCompletionPolicies.mockResolvedValue(agents);
    getAgentRecord.mockImplementation(async id => agents.find(agent => agent.id === id));
    getTaskById.mockResolvedValue(null);
    expect(await sweepRepoStateVerifications()).toMatchObject({ checked: agents.length });
    expect(loadSchedule).toHaveBeenCalledOnce();
    for (const agent of agents) expect(getAgentRecord).toHaveBeenCalledWith(agent.id);
    expect(recordSeededCheckoutRetirement).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('does not load a receipt context for an unseeded completed callback', async () => {
    getAgentRecord.mockResolvedValue({ id: 'unseeded', status: 'completed', metadata: {}, result: { success: false } });
    await resumeAgentCompletionRetirement('unseeded');
    expect(loadSchedule).not.toHaveBeenCalled();
    expect(recordSeededCheckoutRetirement).not.toHaveBeenCalled();
  });

  it.each(['ineligible-history', 'deep-held-history', 'deep-held-stamp-failed'])(
    'reaches a canonical own-seed receipt beyond the startup batch: %s', async scenario => {
      const physical = { dev: '1', ino: '2', birthtimeNs: '3' };
      const create = index => {
        const id = `seeded-${index}`, branch = `feature/seeded-${index}`, path = `/repo/worktrees/${id}`;
        const seed = { version: 1, agentId: id, startedAt: CREATED_AT, seededAt: '2026-01-01T00:00:01.000Z',
          repoPath: '/repo', branch, path, repository: physical, checkout: physical,
          incarnation: { pointer: { ...physical, ino: String(index + 10) }, gitdir: { ...physical, path: `/repo/.git/worktrees/${id}` } } };
        const agent = { id, taskId: `failed-${index}`, status: 'completed', startedAt: CREATED_AT,
          completedAt: '2026-01-01T00:01:00.000Z', result: { success: false, validationPassed: false },
          metadata: { instanceId: 'fixture-local', sourceWorkspace: '/repo', workspacePath: path, worktreeBranch: branch,
            checkoutSeeds: [seed], completedCheckouts: [], checkoutCapture: { status: 'pending', unknown: true },
            repoStateVerification: { status: 'pending' }, completionCleanup: { status: 'pending', retryAt: '2999-01-01T00:00:00Z' } } };
        return { agent, receipt: { path, branch, head: HEAD, checkoutIdentity: retirementCheckoutIdentityFromPointer(seed.incarnation.pointer),
          branchDeleted: true, archiveDir: null, retiredAt: '2026-01-01T00:02:00.000Z' } };
      };
      const deepHeld = scenario.startsWith('deep-held');
      const rows = Array.from({ length: 13 }, (_, index) => create(index));
      const target = rows.at(-1).agent;
      if (scenario === 'ineligible-history') for (const [index, { agent }] of rows.slice(0, -1).entries()) {
        if (index % 3 === 0) agent.metadata.checkoutSeeds = [];
        if (index % 3 === 1) agent.metadata.instanceId = 'other-install';
      }
      const receipts = rows.filter((_, index) => deepHeld || index % 3 !== 2 || index === rows.length - 1).map(row => row.receipt);
      loadSchedule.mockResolvedValue({ executions: { 'task:branch-reconcile': { perApp: { 'demo-app': {
        branchReconcileOutcome: { retired: receipts, retirementReceiptEvidence: {} } } } } } });
      lstat.mockResolvedValue({ isDirectory: () => true, dev: 1n, ino: 2n, birthtimeNs: 3n });
      readBranchCompletionPolicies.mockResolvedValue(rows.map(row => row.agent));
      findMissingCheckoutPreservation.mockResolvedValue({ kind: 'service-retirement-receipt', evidenceDigest: 'a'.repeat(64), recheck: async () => true });
      readCheckoutPathPresence.mockImplementation(async path => deepHeld && path !== target.metadata.workspacePath);
      recordSeededCheckoutRetirement.mockImplementation(async (_id, agent) => {
        agent.metadata.checkoutCapture.status = 'retired';
        agent.metadata.completionCleanup.status = agent.metadata.repoStateVerification.status = 'completed';
        return true;
      });
      let stampFailed = false;
      recordCompletionCleanup.mockImplementation(async (id, _startedAt, patch) => {
        if (scenario === 'deep-held-stamp-failed' && !stampFailed) {
          stampFailed = true;
          throw new Error('synthetic attempt write unavailable');
        }
        const row = rows.find(row => row.agent.id === id);
        row.agent.metadata.completionCleanup = { ...row.agent.metadata.completionCleanup, ...patch };
        return true;
      });
      try {
        await sweepRepoStateVerifications();
        expect(loadSchedule).toHaveBeenCalledOnce();
        if (deepHeld) {
          expect(recordSeededCheckoutRetirement).not.toHaveBeenCalled();
          await sweepRepoStateVerifications();
          expect(loadSchedule).toHaveBeenCalledTimes(2);
        }
        expect(recordSeededCheckoutRetirement).toHaveBeenCalledExactlyOnceWith(target.id, target, expect.any(Object));
        if (!deepHeld) expect(recordCompletionCleanup).not.toHaveBeenCalled();
        if (scenario === 'deep-held-stamp-failed') expect(emitLog).toHaveBeenCalledWith('warn', expect.stringContaining('synthetic attempt write unavailable'));
        expect(addTask).not.toHaveBeenCalled(); expect(updateTask).not.toHaveBeenCalled();
      } finally {
        recordSeededCheckoutRetirement.mockReset().mockResolvedValue(true);
        recordCompletionCleanup.mockReset().mockResolvedValue(true);
      }
    });

  it.each(['verified', 'missing-receipt', 'receipt-raced', 'live-holder', 'live-owner', 'reused-source-path', 'unverified-successor', 'foreign-instance'])(
    'settles unknown predecessor cleanup from the verified successor receipt: %s', async scenario => {
      const physical = { dev: '1', ino: '2', birthtimeNs: '3' };
      const incarnation = { pointer: physical, gitdir: { ...physical, path: '/repo/.git/worktrees/original' } };
      const makeOwner = (id, hour, unknown) => {
        const startedAt = `2026-01-01T0${hour}:00:00.000Z`, seededAt = `2026-01-01T0${hour}:00:01.000Z`;
        const seed = { version: 1, agentId: id, startedAt, seededAt, repoPath: '/repo', branch: BRANCH, path: WORKTREE,
          repository: physical, checkout: physical, incarnation };
        return { id, taskId: 'same-task', status: 'completed', startedAt, completedAt: `2026-01-01T0${hour}:01:00.000Z`,
          result: { success: false, executionSuccess: true }, metadata: { instanceId: 'fixture-local', isWorktree: true,
            sourceWorkspace: '/repo', workspacePath: WORKTREE, worktreeBranch: BRANCH, prCompletionPolicy: 'review-then-merge',
            reviewLoopMergeTarget: { url: 'https://github.com/example/repo/pull/7', branch: BRANCH }, checkoutSeeds: [seed],
            completionTaskDispatch: { taskId: 'same-task', taskType: 'internal', expected: [['claimedBy', 'fixture-local'],
              ['claimedAt', seededAt], ['lastSpawnedAt', seededAt], ['totalSpawnCount', 2]] },
            checkoutCapture: { status: unknown ? 'pending' : 'captured', unknown, targets: [] },
            repoStateVerification: { status: unknown ? 'pending' : 'completed' }, completionCleanup: { status: unknown ? 'pending' : 'completed' },
            completedCheckouts: unknown ? [] : [{ ...seed, version: 2, head: HEAD, capturedAt: `2026-01-01T0${hour}:01:01.000Z` }] } };
      };
      const source = makeOwner('unknown-source', 1, true), successor = makeOwner('delivered-successor', 2, false);
      if (scenario === 'unverified-successor') successor.metadata.repoStateVerification.status = 'pending';
      if (scenario === 'foreign-instance') source.metadata.instanceId = 'other-install';
      if (scenario === 'reused-source-path') {
        source.metadata.workspacePath = source.metadata.checkoutSeeds[0].path = '/repo/old-source';
        readCheckoutPathPresence.mockImplementation(async path => path === '/repo/old-source');
      }
      if (scenario === 'live-owner') readClaimOwnershipAgents.mockResolvedValue([{ status: 'running',
        metadata: { sourceWorkspace: '/repo', worktreeBranch: BRANCH } }]);
      getAgentRecord.mockResolvedValue(source); readBranchCompletionPolicies.mockResolvedValue([source, successor]);
      findMissingCheckoutPreservation.mockResolvedValue(scenario === 'missing-receipt' ? null : { recheck: async () => scenario !== 'receipt-raced' });
      if (scenario === 'live-holder') listWorktrees.mockResolvedValue([{ path: WORKTREE, branch: `refs/heads/${BRANCH}` }]);
      const events = new EventEmitter(), unbind = bindCompletionRetirementEvents(events);
      try { await events.listeners('checkout:retired')[0]({ appId: 'demo-app', path: WORKTREE, branch: BRANCH, head: HEAD,
        checkoutIdentity: retirementCheckoutIdentityFromPointer(physical) }); } finally { unbind(); }
      expect(recordSuccessorCheckoutRetirement).toHaveBeenCalledTimes(scenario === 'verified' ? 1 : 0);
      expect(source.metadata.completedCheckouts).toEqual([]);
      expect(source.result.success).toBe(false);
      expect(addTask).not.toHaveBeenCalled();
      expect(retireInventoriedCheckout).not.toHaveBeenCalled();
    });

  it.each(['verified', 'wrong-generation', 'wrong-head', 'wrong-task', 'live-owner', 'live-ref', 'refused-cas'])(
    'settles a known same-head moved predecessor newest-first from a fresh receipt: %s', async scenario => {
      const pointer = { dev: '1', ino: '2', birthtimeNs: '3' };
      const incarnation = { pointer, gitdir: { ...pointer, path: '/repo/.git/worktrees/original' } };
      const makeOwner = (id, hour, path, resumedFromAgentId = null) => ({ id, taskId: 'same-task', status: 'completed',
        startedAt: `2026-01-01T0${hour}:00:00.000Z`, completedAt: `2026-01-01T0${hour}:02:00.000Z`,
        result: { success: false, executionSuccess: true, validationPassed: true, cleanupPending: true, deliveryRecoveryOwned: true,
          taskOutcome: { status: 'incomplete', recovery: { mode: 'cleanup' } } }, metadata: { instanceId: 'fixture-local', isWorktree: true,
          sourceWorkspace: '/repo', workspacePath: path, worktreeBranch: BRANCH, prCompletionPolicy: 'review-then-merge', resumedFromAgentId,
          reviewLoopMergeTarget: { url: 'https://github.com/example/repo/pull/7', branch: BRANCH },
          checkoutCapture: { status: 'captured' }, repoStateVerification: { status: 'pending' }, completionCleanup: { status: 'pending' },
          completedCheckouts: [{ version: 1, agentId: id, startedAt: `2026-01-01T0${hour}:00:00.000Z`,
            capturedAt: `2026-01-01T0${hour}:01:00.000Z`, repoPath: '/repo', branch: BRANCH, path, head: HEAD, incarnation }] } });
      const source = makeOwner('known-source', 1, '/repo/old-source');
      const successor = makeOwner('delivered-current', 2, WORKTREE, source.id);
      if (scenario === 'wrong-generation') source.metadata.completedCheckouts[0].incarnation = {
        ...incarnation, pointer: { ...pointer, ino: '9' } };
      if (scenario === 'wrong-head') source.metadata.completedCheckouts[0].head = '4'.repeat(40);
      if (scenario === 'wrong-task') source.taskId = 'other-task';
      const originalCapture = structuredClone(source.metadata.completedCheckouts);
      const order = [];
      getAgentRecord.mockImplementation(async id => {
        order.push(id);
        if (id === successor.id) {
          // The current owner's receipt settlement becomes visible when its
          // turn is joined. An older-first callback would see stale pending state.
          successor.metadata.repoStateVerification.status = 'completed';
          successor.metadata.completionCleanup.status = 'completed';
          successor.metadata.cleanupOutcome = { status: 'verified', unresolved: 0, committedIntegrationVerified: true };
          successor.result.success = true; successor.result.cleanupPending = false;
        }
        return id === successor.id ? successor : source;
      });
      readBranchCompletionPolicies.mockResolvedValue([source, successor]);
      findMissingCheckoutPreservation.mockResolvedValue({ kind: 'service-retirement-receipt', evidenceDigest: 'a'.repeat(64), recheck: async () => true });
      if (scenario === 'live-owner') readClaimOwnershipAgents.mockResolvedValue([{ status: 'running',
        metadata: { sourceWorkspace: '/repo', worktreeBranch: BRANCH } }]);
      if (scenario === 'live-ref') readLocalBranchPresence.mockResolvedValue(true);
      recordSuccessorCheckoutRetirement.mockReset().mockImplementation(async () => {
        if (scenario === 'refused-cas') return false;
        source.metadata.repoStateVerification.status = 'completed'; source.metadata.completionCleanup.status = 'completed';
        return true;
      });
      const events = new EventEmitter(), unbind = bindCompletionRetirementEvents(events);
      const receipt = { appId: 'demo-app', path: WORKTREE, branch: BRANCH, head: HEAD,
        checkoutIdentity: retirementCheckoutIdentityFromPointer(pointer) };
      try {
        await events.listeners('checkout:retired')[0](receipt);
        expect(order[0]).toBe(successor.id);
        expect(recordSuccessorCheckoutRetirement).toHaveBeenCalledTimes(['verified', 'refused-cas'].includes(scenario) ? 1 : 0);
        if (scenario === 'verified') {
          expect(recordSuccessorCheckoutRetirement).toHaveBeenCalledWith(source.id, source, expect.objectContaining({
            successorAgentId: successor.id, head: HEAD, sourceCapture: originalCapture[0], receiptDigest: 'a'.repeat(64) }));
          await events.listeners('checkout:retired')[0](receipt);
          expect(recordSuccessorCheckoutRetirement).toHaveBeenCalledTimes(1);
        }
        expect(source.metadata.completedCheckouts).toEqual(originalCapture);
        expect(addTask).not.toHaveBeenCalled(); expect(retireInventoriedCheckout).not.toHaveBeenCalled();
      } finally { unbind(); recordSuccessorCheckoutRetirement.mockReset().mockResolvedValue(true); }
    });

  it.each(['verified', 'missing-receipt', 'changed-generation', 'unrelated-head', 'receipt-raced'])(
    'settles an older successful capture only through the same-generation retirement receipt: %s', async scenario => {
      const pointer = { dev: '1', ino: '2', birthtimeNs: '3' };
      const completed = { version: 1, agentId: 'agent-1', repoPath: '/repo', branch: BRANCH, path: WORKTREE,
        head: '4'.repeat(40), startedAt: CREATED_AT, capturedAt: CREATED_AT, incarnation: { pointer } };
      const state = { ...agentState({ instanceId: 'fixture-local', completedCheckouts: [completed],
        reviewLoopMergeTarget: { url: 'https://github.com/example/repo/pull/7' }, repoStateVerification: { status: 'pending' },
        completionCleanup: { status: 'completed', version: 1 } }), id: 'agent-1', taskId: 'task-1', status: 'completed', completedAt: CREATED_AT,
        result: { success: true, executionSuccess: true } };
      getAgentRecord.mockResolvedValue(state);
      readBranchCompletionPolicies.mockResolvedValue([state]);
      execGh.mockResolvedValue(openView({ state: 'MERGED' }));
      findMissingCheckoutPreservation.mockResolvedValue(scenario === 'missing-receipt' ? null
        : { kind: 'service-retirement-receipt', archiveDir: null, evidenceDigest: 'a'.repeat(64), recheck: async () => scenario !== 'receipt-raced' });
      execGit.mockImplementation(async args => ({ exitCode: args[0] === 'merge-base'
        ? (scenario === 'unrelated-head' && args[2] === completed.head ? 1 : 0) : 1, stdout: '' }));
      const events = new EventEmitter();
      const unbind = bindCompletionRetirementEvents(events);
      try {
        await events.listeners('checkout:retired')[0]({ appId: 'demo-app', path: WORKTREE, branch: BRANCH, head: HEAD,
          checkoutIdentity: retirementCheckoutIdentityFromPointer(scenario === 'changed-generation' ? { ...pointer, ino: '9' } : pointer) });
      } finally { unbind(); }
      if (scenario === 'verified') {
        expect(recordRepoStateVerification).toHaveBeenLastCalledWith('agent-1', expect.objectContaining({ status: 'completed' }));
      } else {
        expect(recordRepoStateVerification.mock.calls.some(([, row]) => row.status === 'completed')).toBe(false);
      }
      expect(addTask).not.toHaveBeenCalled();
      expect(retireInventoriedCheckout).not.toHaveBeenCalled();
      expect(state.result).toEqual({ success: true, executionSuccess: true });
    });

  it.each([{ integrated: true }, { integrated: false }, { integrated: true, restart: true }])('reconciles an eventual merge after a terminal pre-merge report with exact proof (%j)', async ({ integrated, restart }) => {
    const capture = { version: 1, agentId: 'agent-1', repoPath: '/repo', branch: BRANCH, path: WORKTREE, head: HEAD,
      startedAt: CREATED_AT, capturedAt: CREATED_AT, incarnation: { pointer: { dev: '1', ino: '2', birthtimeNs: '3' } } };
    const originalResult = { success: false, executionSuccess: true, deliveryRecoveryOwned: true,
      taskOutcome: { status: 'incomplete', reason: 'Main moved during three guard rounds.' } };
    const state = { ...agentState({ instanceId: 'fixture-local', completedCheckouts: [capture],
      completionCleanup: { status: 'completed', stages: { worktree: { status: 'done', value: [] } } } }),
      id: 'agent-1', taskId: 'task-1', status: 'completed', result: originalResult };
    getAgentRecord.mockResolvedValue(state);
    getTaskById.mockResolvedValue({ ...task(), status: 'completed' });
    execGit.mockImplementation(async args => ({ exitCode: integrated && args[0] === 'merge-base' ? 0 : 1, stdout: '' }));
    const followUp = { id: 'follow-up', status: 'completed', metadata: { reviewLoopFollowUp: 'true',
      sourceAgentId: 'agent-1', sourceTaskId: 'task-1', reviewLoopPRBranch: BRANCH,
      reviewLoopPRUrl: 'https://github.com/example/repo/pull/7',
      mergedReviewFollowUp: { status: 'verified', prUrl: 'https://github.com/example/repo/pull/7' } } };
    queuedTasks([followUp]);
    if (restart) {
      readBranchCompletionPolicies.mockResolvedValueOnce([state]);
      await sweepRepoStateVerifications();
    } else await observeCompletedTask(followUp);
    if (integrated) expect(recordRepoStateVerification).toHaveBeenCalledWith('agent-1', expect.objectContaining({ deliveryVerified: true }));
    else expect(recordRepoStateVerification).not.toHaveBeenCalled();
    expect(state.result).toEqual(originalResult);
    expect(updateTask).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
    expect(retireInventoriedCheckout).not.toHaveBeenCalled();
  });

  it('replays a failed no-PR run cleanup at owner release without promoting its original result', async () => {
    const state = { id: 'failed-no-pr', taskId: 'failed-task', status: 'completed',
      result: { success: false, executionSuccess: true, taskOutcome: { status: 'blocked' } },
      metadata: { completionCleanup: { status: 'pending' } } };
    getAgentRecord.mockResolvedValue(state);
    getTaskById.mockResolvedValue({ id: 'failed-task', taskType: 'internal', status: 'blocked', metadata: { failureCount: 3 } });
    const before = JSON.stringify(state);
    expect(await resumeAgentCompletionRetirement(state.id)).toMatchObject({ cleanupReplayed: true,
      verified: false, skipReason: 'original-result-preserved' });
    expect(replayAgentCompletionCleanup).toHaveBeenCalledWith(state);
    expect(recordRepoStateVerification).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
    expect(JSON.stringify(state)).toBe(before);
  });

  it('waits out a pre-release owner-active audit and immediately verifies again after release', async () => {
    const completed = { version: 1, agentId: 'agent-1', repoPath: '/repo', branch: BRANCH, path: WORKTREE, head: HEAD,
      startedAt: CREATED_AT, capturedAt: CREATED_AT };
    const state = { ...agentState({ instanceId: 'fixture-local', completedCheckouts: [completed],
      reviewLoopMergeTarget: { url: 'https://github.com/example/repo/pull/7' }, repoStateVerification: { status: 'pending' } }),
      id: 'agent-1', taskId: 'task-1', status: 'completed', result: { success: false, cleanupPending: true } };
    getAgentRecord.mockResolvedValue(state);
    findMissingCheckoutPreservation.mockResolvedValue({ archiveDir: null, evidenceDigest: 'a'.repeat(64), recheck: async () => true });
    const followUp = { id: 'follow-up', status: 'completed', metadata: { reviewLoopFollowUp: true,
      sourceAgentId: 'agent-1', sourceTaskId: 'task-1', reviewLoopPRBranch: BRANCH } };
    queuedTasks([followUp]);
    let releaseFirst, entered;
    const reached = new Promise(resolve => { entered = resolve; });
    getAllTasks.mockImplementationOnce(() => { entered(); return new Promise(resolve => { releaseFirst = resolve; }); });
    const preRelease = run({ agentState: state, success: false });
    await reached;
    const afterRelease = observeCompletedTask(followUp);
    releaseFirst({ user: { tasks: [] }, cos: { tasks: [{ ...followUp, status: 'pending', metadata: { ...followUp.metadata, app: 'demo-app' } }] } });
    expect(await preRelease).toMatchObject({ skipReason: 'follow-up-pending' });
    expect(await afterRelease).toMatchObject({ verified: true });
    expect(updateTask).toHaveBeenCalledOnce();
    expect(addTask).not.toHaveBeenCalled();
  });

  it('does not wake a different task or another instance from follow-up metadata', async () => {
    const followUp = { status: 'completed', metadata: { reviewLoopFollowUp: true, sourceAgentId: 'agent-1', sourceTaskId: 'task-1' } };
    for (const state of [{ taskId: 'another-task', metadata: { instanceId: 'fixture-local' } },
      { taskId: 'task-1', metadata: { instanceId: 'another-instance' } }]) {
      getAgentRecord.mockResolvedValue(state);
      await observeCompletedTask(followUp);
    }
    expect(updateTask).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  it('ignores the exact cleanup task itself while preserving a different pending owner', async () => {
    const own = { ...task(), status: 'in_progress', metadata: { ...task().metadata,
      existingBranch: BRANCH, deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-1' } };
    const state = { ...agentState(), result: { success: false, cleanupPending: true } };
    queuedTasks([own]);
    expect((await run({ success: false, agentState: state, task: own })).skipReason).not.toBe('follow-up-pending');
    queuedTasks([own, { ...own, id: 'other-task' }]);
    expect(await run({ success: false, agentState: state, task: own })).toMatchObject({ skipReason: 'follow-up-pending' });
  });

  it('ignores independent repositories with the same branch and deduplicates app reads per audit', async () => {
    getAppById.mockImplementation(async id => ({ id, repoPath: id === 'demo-app' ? '/repo' : '/other' }));
    readGitCommonDirectory.mockImplementation(async path => `${path}/.git`);
    queuedTasks(['first', 'second'].map(id => ({ id, status: 'pending', metadata: { app: 'other-app', existingBranch: BRANCH } })));
    expect((await run()).skipReason).not.toBe(REPO_STATE_SKIPS.FOLLOW_UP_PENDING);
    expect(getAppById.mock.calls.filter(([id]) => id === 'other-app')).toHaveLength(1);
    expect(readGitCommonDirectory).toHaveBeenCalledWith('/other');
  });

  it.each(['/alias', '/linked-worktree'])('preserves another app sharing the common directory through %s', async repoPath => {
    getAppById.mockImplementation(async id => ({ id, repoPath: id === 'demo-app' ? '/repo' : repoPath }));
    queuedTasks([{ status: 'pending', metadata: { app: 'alias-app', existingBranch: BRANCH } }]);
    expect(await run()).toMatchObject({ skipReason: REPO_STATE_SKIPS.FOLLOW_UP_PENDING });
    expect(readGitCommonDirectory).toHaveBeenCalledWith(repoPath);
  });

  it.each(['missing-scope', 'missing-app', 'app-read-failed', 'missing-path', 'unreadable-target', 'unreadable-candidate'])('holds when ownership identity is unknown: %s', async failure => {
    getAppById.mockImplementation(async id => {
      if (id === 'demo-app') return { id, repoPath: '/repo' };
      if (failure === 'app-read-failed') throw new Error('unreadable');
      if (failure === 'missing-app') return null;
      return { id, repoPath: failure === 'missing-path' ? undefined : '/other' };
    });
    readGitCommonDirectory.mockImplementation(async path => !path
      || path === (failure === 'unreadable-target' ? '/repo' : failure === 'unreadable-candidate' ? '/other' : '') ? null : `${path}/.git`);
    queuedTasks([{ status: 'pending', metadata: { app: failure === 'missing-scope' ? undefined : 'other-app', existingBranch: BRANCH } }]);
    expect(await run()).toMatchObject({ skipReason: REPO_STATE_SKIPS.GATE_UNREADABLE });
    expect(retireInventoriedCheckout).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  it.each([[], ['Branch preserved by ordinary cleanup']])('settles a merged, absent checkout cleanup handoff without a backup receipt despite warnings %j', async cleanupWarnings => {
    const state = { ...agentState({ reviewLoopMergeTarget: { url: 'https://github.com/example/repo/pull/7' },
      repoStateVerification: { status: 'pending' } }), result: { success: false, cleanupPending: true } };
    expect(await run({ success: false, agentState: state, cleanupWarnings })).toMatchObject({ verified: true, skipReason: null });
    expect(updateTask).toHaveBeenLastCalledWith('task-1', expect.objectContaining({ status: 'completed' }), 'user', {
      expectedStatus: 'in_progress', expectedMetadata: { deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-1' },
    });
    expect(recordCleanupOutcome).toHaveBeenLastCalledWith('agent-1', {
      status: 'verified', reason: 'already-absent-merged', branch: BRANCH, path: WORKTREE,
      prUrl: 'https://github.com/example/repo/pull/7', committedIntegrationVerified: true,
    });
    expect(recordRepoStateVerification).toHaveBeenLastCalledWith('agent-1', expect.objectContaining({ status: 'completed' }));
    expect(findMissingCheckoutPreservation).not.toHaveBeenCalled();
    expect(retireInventoriedCheckout).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  it('settles captured merged delivery even when the original task did not request opening a PR', async () => {
    const captured = { version: 1, agentId: 'agent-1', startedAt: CREATED_AT, capturedAt: CREATED_AT,
      repoPath: '/repo', branch: BRANCH, path: WORKTREE, head: HEAD, incarnation: { pointer: { dev: '1', ino: '2', birthtimeNs: '3' } } };
    const state = { ...agentState({ completedCheckouts: [captured], repoStateVerification: { status: 'pending' } }),
      id: 'agent-1', taskId: 'task-1', status: 'completed', completedAt: CREATED_AT, result: { success: false, cleanupPending: true } };
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://github.com/example/repo/pull/7', detail: 'MERGED' });
    expect(await run({ task: task({ openPR: 'false' }), prExpected: false, success: false, agentState: state }))
      .toMatchObject({ verified: true });
    expect(readRetirementForgeEvidence).toHaveBeenCalledWith('/repo', BRANCH, 'https://github.com/example/repo/pull/7',
      expect.objectContaining({ exactDeliveredHead: HEAD }));
    expect(updateTask).toHaveBeenLastCalledWith('task-1', expect.objectContaining({ status: 'completed' }), 'user', expect.any(Object));
    expect(retireInventoriedCheckout).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  it.each(['receipt', 'archive', 'missing', 'receipt-raced', 'unrelated-head'])(
    'settles a moved captured head only with its same-generation retirement receipt: %s', async scenario => {
      const captured = { version: 1, agentId: 'agent-1', startedAt: CREATED_AT, capturedAt: CREATED_AT,
        repoPath: '/repo', branch: BRANCH, path: WORKTREE, head: '4'.repeat(40),
        incarnation: { pointer: { dev: '1', ino: '2', birthtimeNs: '3' } } };
      const state = { ...agentState({ completedCheckouts: [captured], repoStateVerification: { status: 'pending' },
        reviewLoopMergeTarget: { url: 'https://github.com/example/repo/pull/7' } }),
      id: 'agent-1', taskId: 'task-1', status: 'completed', completedAt: CREATED_AT,
      result: { success: false, cleanupPending: true } };
      const recheck = vi.fn(async () => scenario !== 'receipt-raced');
      findMissingCheckoutPreservation.mockResolvedValue(scenario === 'missing' ? null : {
        kind: scenario === 'archive' ? 'archive' : 'service-retirement-receipt', recheck,
      });
      if (scenario === 'unrelated-head') execGit.mockImplementation(async args => ({
        exitCode: args[0] === 'merge-base' && args[2] === captured.head ? 1 : 0, stdout: '',
      }));
      const result = await run({ success: false, agentState: state });
      if (scenario === 'receipt') {
        expect(result).toMatchObject({ verified: true });
        expect(recheck).toHaveBeenCalledOnce();
        expect(updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'completed' }), 'user', expect.any(Object));
      } else {
        expect(result).toMatchObject({ verified: false, skipReason: scenario === 'receipt-raced'
          ? 'absent-checkout-settlement-unverified' : 'absent-checkout-integration-unverified' });
        expect(updateTask).not.toHaveBeenCalled();
        expect(recordCleanupOutcome).not.toHaveBeenCalledWith('agent-1', expect.objectContaining({ status: 'verified' }));
      }
      expect(retireInventoriedCheckout).not.toHaveBeenCalled();
    });

  it.each(['contained', 'not-contained', 'lookup-unavailable'])('settles an unpublished no-change checkout only when its captured head is in the default branch: %s', async scenario => {
    const captured = { version: 1, agentId: 'agent-1', startedAt: CREATED_AT, capturedAt: CREATED_AT,
      repoPath: '/repo', branch: BRANCH, path: WORKTREE, head: HEAD, incarnation: { pointer: { dev: '1', ino: '2', birthtimeNs: '3' } } };
    const state = { ...agentState({ completedCheckouts: [captured], repoStateVerification: { status: 'pending' } }),
      id: 'agent-1', taskId: 'task-1', status: 'completed', completedAt: CREATED_AT, result: { success: false, cleanupPending: true } };
    findPullRequestForBranch.mockResolvedValue(scenario === 'lookup-unavailable' ? { status: 'unavailable' } : { status: 'none', url: null, detail: null });
    execGit.mockImplementation(async args => ({ exitCode: args[0] === 'merge-base' && args[2] === HEAD
      && args[3] === 'refs/remotes/origin/main' && scenario !== 'not-contained' ? 0 : 1, stdout: '' }));
    const result = await run({ success: false, agentState: state });
    if (scenario === 'contained') {
      expect(result).toMatchObject({ verified: true, skipReason: null });
      expect(recordCleanupOutcome).toHaveBeenLastCalledWith('agent-1', expect.objectContaining({
        status: 'verified', reason: 'already-absent-integrated', committedIntegrationVerified: true }));
      expect(updateTask).toHaveBeenLastCalledWith('task-1', expect.objectContaining({ status: 'completed' }), 'user', expect.any(Object));
    } else {
      expect(result).toMatchObject({ verified: false, skipReason: 'absent-checkout-integration-unverified' });
      expect(updateTask).not.toHaveBeenCalled();
    }
    expect(readRetirementForgeEvidence).not.toHaveBeenCalled();
    expect(retireInventoriedCheckout).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  it.each(['wrong-head', 'foreign-repository', 'uncaptured', 'ambiguous', 'open', 'unavailable'])('retains an unrequested-PR handoff when captured delivery is %s', async failure => {
    const captured = { version: 1, agentId: 'agent-1', startedAt: CREATED_AT, capturedAt: CREATED_AT,
      repoPath: '/repo', branch: BRANCH, path: WORKTREE, head: HEAD, incarnation: { pointer: { dev: '1', ino: '2', birthtimeNs: '3' } } };
    if (failure === 'foreign-repository') captured.repoPath = '/other-instance';
    if (failure === 'wrong-head') captured.head = 'f'.repeat(40);
    const completedCheckouts = failure === 'uncaptured' ? [] : failure === 'ambiguous' ? [captured, { ...captured }] : [captured];
    const state = { ...agentState({ completedCheckouts, repoStateVerification: { status: 'pending' } }),
      id: 'agent-1', taskId: 'task-1', status: 'completed', completedAt: CREATED_AT, result: { success: false, cleanupPending: true } };
    findPullRequestForBranch.mockResolvedValue(failure === 'unavailable' ? { status: 'unavailable' }
      : { status: 'found', url: 'https://github.com/example/repo/pull/7', detail: failure === 'open' ? 'OPEN' : 'MERGED' });
    expect(await run({ task: task({ openPR: false }), prExpected: false, success: false, agentState: state }))
      .toMatchObject({ verified: false, skipReason: 'absent-checkout-integration-unverified' });
    expect(updateTask).not.toHaveBeenCalled();
    expect(retireInventoriedCheckout).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  it.each(['unavailable', 'unmerged', 'not-integrated'])('keeps absent checkout delivery unverified when merge proof is %s', async scenario => {
    if (scenario === 'unavailable') readRetirementForgeEvidence.mockRejectedValue(new Error('forge unavailable'));
    if (scenario === 'unmerged') getPullRequestState.mockResolvedValueOnce({ status: 'known', state: 'OPEN' });
    if (scenario === 'not-integrated') execGit.mockResolvedValue({ exitCode: 1, stdout: '' });
    expect(await run({ agentState: agentState({ reviewLoopMergeTarget: { url: 'https://github.com/example/repo/pull/7' } }) }))
      .toMatchObject({ verified: false, skipReason: 'absent-checkout-integration-unverified' });
    expect(recordCleanupOutcome).not.toHaveBeenCalledWith('agent-1', expect.objectContaining({ status: 'verified' }));
    expect(addTask).not.toHaveBeenCalled();
  });

  it.each(['write-refused', 'checkout-reappeared', 'ref-reappeared', 'owner-changed'])('does not settle absent checkout delivery when %s', async scenario => {
    if (scenario === 'write-refused') recordCleanupOutcome.mockResolvedValueOnce(false);
    if (scenario === 'checkout-reappeared') readCheckoutPathPresence.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    if (scenario === 'ref-reappeared') readLocalBranchPresence.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    if (scenario === 'owner-changed') readClaimOwnershipAgents.mockResolvedValueOnce([]).mockResolvedValueOnce(null);
    const state = { ...agentState({ reviewLoopMergeTarget: { url: 'https://github.com/example/repo/pull/7' } }),
      result: { success: false, cleanupPending: true } };
    expect(await run({ success: false, agentState: state })).toMatchObject({ verified: false, skipReason: 'absent-checkout-settlement-unverified' });
    expect(updateTask).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
    expect(retireInventoriedCheckout).not.toHaveBeenCalled();
  });

  it.each([['broken leaf symlink', true], ['unreadable EACCES leaf', null]])('never treats %s as absent or verified cleanup', async (_name, presence) => {
    readCheckoutPathPresence.mockResolvedValue(presence);
    const result = await run();
    expect(result.verified).toBe(false);
    expect(result.observed?.worktreePresent).toBe(presence);
    expect(recordCleanupOutcome).not.toHaveBeenCalledWith('agent-1', expect.objectContaining({ status: 'verified' }));
    expect(addTask).not.toHaveBeenCalled();
  });

  it('keeps a reused branch with a different checkout out of recovery across owner completion', async () => {
    listWorktrees.mockResolvedValue([{ ...RELEASE, path: '/repo/new-owner' }]);
    readClaimOwnershipAgents.mockResolvedValue([{ id: 'new-owner', status: 'running' }]);
    for (let i = 0; i < 70; i++) expect(await run()).toMatchObject({ skipReason: 'checkout-incarnation-changed', recoveryTaskId: null });
    readClaimOwnershipAgents.mockResolvedValue([{ id: 'new-owner', status: 'completed', result: { success: true } }]);
    expect(await run()).toMatchObject({ skipReason: 'checkout-incarnation-changed', recoveryTaskId: null });
    expect(addTask).not.toHaveBeenCalled();
    expect(prepareInventoriedCheckoutRetirement).not.toHaveBeenCalled();
  });

  it('retains a recreated same-path checkout despite identical branch and head', async () => {
    listWorktrees.mockResolvedValue([RELEASE]);
    readCompletedCheckoutIdentity.mockResolvedValue({ head: HEAD, incarnation: { pointer: { ino: 'new' } } });
    expect(await run({ agentState: agentState({ completedCheckouts: [{ ...RELEASE, incarnation: { pointer: { ino: 'old' } } }] }) })).toMatchObject({ skipReason: 'checkout-incarnation-changed' });
    expect(addTask).not.toHaveBeenCalled();
  });

  it('does not associate a stored foreign-repository PR number with this repository', async () => {
    localBranch(true);
    existsSync.mockReturnValue(true);
    await run({ agentState: agentState({ reviewLoopMergeTarget: { url: 'https://github.com/foreign/repo/pull/7' } }) });
    expect(getPullRequestState).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  it('files nothing when the worktree, branch and PR all landed', async () => {
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://github.com/example/repo/pull/1', detail: 'MERGED' });

    const result = await run();

    expect(result.verified).toBe(true);
    expect(result.skipReason).toBeNull();
    expect(result.issues).toEqual([]);
    expect(addTask).not.toHaveBeenCalled();
    expect(addNotification).not.toHaveBeenCalled();
  });

  it('reads the PR state from the list call rather than a second forge round trip', async () => {
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://github.com/example/repo/pull/1', detail: 'merged' });
    localBranch(true);
    const result = await run();
    expect(result.observed.prState).toBe('MERGED');
    expect(findPullRequestForBranch).toHaveBeenCalledTimes(1);
  });
});

describe('verifyAgentRepoState — divergent runs', () => {
  it.each([
    ['without a continuation proof', null],
    ['after the continuation was issued', { version: 1, continuationIssued: true }],
  ])('rechecks a selected cleanup owner %s without a new task', async (_scenario, proof) => {
    const pending = { ...task(), status: 'in_progress', metadata: { ...task().metadata,
      deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-1' } };
    const owner = { ...agentState(), id: 'agent-1', taskId: pending.id, status: 'completed',
      result: manualCleanupResult(), metadata: { ...agentState().metadata,
        checkoutCapture: { status: 'captured' }, completionCleanup: completedCleanup(), repoStateVerification: { status: 'pending' },
        ...(proof && { swarmCleanupDelivery: proof }) } };
    getTaskById.mockResolvedValue(pending);
    getAgentRecord.mockResolvedValue(owner);
    existsSync.mockReturnValue(true);
    localBranch(true);
    listWorktrees.mockResolvedValue([RELEASE]);
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://github.com/example/repo/pull/1', detail: 'MERGED' });
    prepareInventoriedCheckoutRetirement.mockResolvedValue({ ok: true, review: { ...review(), comparison: { disposition: 'integrated', localPatch: '', difference: '' } } });
    retireInventoriedCheckout.mockImplementation(async (_input, options) => { await options.beforeMutation(); return { ok: true, branchDeleted: true }; });

    expect(await recheckAgentCleanup(owner.id, pending.id)).toMatchObject({ ok: true, verified: true });
    expect(retireInventoriedCheckout).toHaveBeenCalledOnce();
    expect(assertAutomaticRetirementAllowed).not.toHaveBeenCalled();
    expect(updateTask).toHaveBeenCalledWith(pending.id, expect.objectContaining({ status: 'completed' }), 'user',
      expect.objectContaining({ suppressCompletionWake: true,
        recoveryOwner: { id: owner.id, startedAt: owner.startedAt, requireInactive: true } }));
    expect(addTask).not.toHaveBeenCalled();
    expect(releaseRetryHold).not.toHaveBeenCalled();
  });

  it.each([
    ['unattributed recovery', { deliveryRecoveryOwned: undefined }, {}],
    ['unowned recovery', { deliveryRecoveryOwned: false }, {}],
    ['missing execution verdict', { executionSuccess: undefined }, {}],
    ['failed execution', { executionSuccess: false }, {}],
    ['failed validation', { validationPassed: false }, {}],
    ['wrong outcome', { taskOutcome: { status: 'blocked', recovery: { mode: 'cleanup' } } }, {}],
    ['missing recovery mode', { taskOutcome: { status: 'incomplete' } }, {}],
    ['different recovery mode', { taskOutcome: { status: 'incomplete', recovery: { mode: 'retry' } } }, {}],
    ['result interruption', { executionInterruption: { reason: 'stopped' } }, {}],
    ['metadata interruption', {}, { executionInterruption: { reason: 'stopped' } }],
    ['metadata blocker', {}, { blocker: { reason: 'manual decision' } }],
  ])('retains the task and checkout for %s', async (_name, resultPatch, metadataPatch) => {
    const pending = { ...task(), status: 'in_progress', metadata: { ...task().metadata,
      deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-1' } };
    const owner = { ...agentState(), id: 'agent-1', taskId: pending.id, status: 'completed',
      result: { ...manualCleanupResult(), ...resultPatch }, metadata: { ...agentState().metadata, ...metadataPatch,
        checkoutCapture: { status: 'captured' }, completionCleanup: completedCleanup(), repoStateVerification: { status: 'pending' } } };
    getTaskById.mockResolvedValue(pending);
    getAgentRecord.mockResolvedValue(owner);

    expect(await recheckAgentCleanup(owner.id, pending.id)).toEqual({ ok: true, verified: false, reasons: ['cleanup-provenance-unverified'] });
    expect(retireInventoriedCheckout).not.toHaveBeenCalled();
    expect(recordRepoStateVerification).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  it.each([undefined, false])('retains a cleanup-held task when its swarm continuation is unissued (%s)', async issued => {
    const pending = { ...task(), status: 'in_progress', metadata: { ...task().metadata,
      deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-1' } };
    const owner = { ...agentState(), id: 'agent-1', taskId: pending.id, status: 'completed',
      result: manualCleanupResult(), metadata: { ...agentState().metadata,
        checkoutCapture: { status: 'captured' }, completionCleanup: completedCleanup(), repoStateVerification: { status: 'pending' },
        swarmCleanupDelivery: { version: 1, continuationIssued: issued } } };
    getTaskById.mockResolvedValue(pending);
    getAgentRecord.mockResolvedValue(owner);

    expect(await recheckAgentCleanup(owner.id, pending.id)).toEqual({ ok: true, verified: false, reasons: ['swarm-continuation-pending'] });
    expect(retireInventoriedCheckout).not.toHaveBeenCalled();
    expect(recordRepoStateVerification).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  it.each(['retirement', 'settlement'])('rechecks a newly recorded swarm continuation before %s', async boundary => {
    const pending = { ...task(), status: 'in_progress', metadata: { ...task().metadata,
      deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-1' } };
    const owner = { ...agentState(), id: 'agent-1', taskId: pending.id, status: 'completed',
      result: manualCleanupResult(), metadata: { ...agentState().metadata,
        checkoutCapture: { status: 'captured' }, completionCleanup: completedCleanup(), repoStateVerification: { status: 'pending' } } };
    getTaskById.mockResolvedValue(pending);
    getAgentRecord.mockResolvedValue(owner);
    existsSync.mockReturnValue(true);
    localBranch(true);
    listWorktrees.mockResolvedValue([RELEASE]);
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://github.com/example/repo/pull/1', detail: 'MERGED' });
    prepareInventoriedCheckoutRetirement.mockResolvedValue({ ok: true, review: { ...review(), comparison: { disposition: 'integrated', localPatch: '', difference: '' } } });
    let removed = false;
    retireInventoriedCheckout.mockImplementation(async (_input, options) => {
      if (boundary === 'retirement') owner.metadata.swarmCleanupDelivery = { version: 1 };
      await options.beforeMutation();
      removed = true;
      return { ok: true, branchDeleted: true };
    });
    if (boundary === 'settlement') recordCompletionCleanup.mockImplementationOnce(async () => {
      owner.metadata.swarmCleanupDelivery = { version: 1 };
      return true;
    });

    expect(await recheckAgentCleanup(owner.id, pending.id)).toMatchObject({ ok: true, verified: false, reasons: ['swarm-continuation-pending'] });
    expect(removed).toBe(boundary === 'settlement');
    expect(updateTask).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  it('rechecks delivery provenance immediately before checkout retirement', async () => {
    const pending = { ...task(), status: 'in_progress', metadata: { ...task().metadata,
      deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-1' } };
    const owner = { ...agentState(), id: 'agent-1', taskId: pending.id, status: 'completed',
      result: manualCleanupResult(), metadata: { ...agentState().metadata,
        checkoutCapture: { status: 'captured' }, completionCleanup: completedCleanup(), repoStateVerification: { status: 'pending' } } };
    getTaskById.mockResolvedValue(pending);
    getAgentRecord.mockResolvedValue(owner);
    existsSync.mockReturnValue(true);
    localBranch(true);
    listWorktrees.mockResolvedValue([RELEASE]);
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://github.com/example/repo/pull/1', detail: 'MERGED' });
    prepareInventoriedCheckoutRetirement.mockResolvedValue({ ok: true, review: { ...review(), comparison: { disposition: 'integrated', localPatch: '', difference: '' } } });
    let removed = false;
    retireInventoriedCheckout.mockImplementation(async (_input, options) => {
      owner.result.executionSuccess = false;
      await options.beforeMutation();
      removed = true;
      return { ok: true, branchDeleted: true };
    });

    expect(await recheckAgentCleanup(owner.id, pending.id)).toMatchObject({ ok: true, verified: false, reasons: ['cleanup-provenance-unverified'] });
    expect(removed).toBe(false);
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('rechecks delivery provenance before completing the task', async () => {
    const pending = { ...task(), status: 'in_progress', metadata: { ...task().metadata,
      deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-1' } };
    const owner = { ...agentState(), id: 'agent-1', taskId: pending.id, status: 'completed',
      result: manualCleanupResult(), metadata: { ...agentState().metadata,
        checkoutCapture: { status: 'captured' }, completionCleanup: completedCleanup(), repoStateVerification: { status: 'pending' } } };
    getTaskById.mockResolvedValue(pending);
    getAgentRecord.mockResolvedValue(owner);
    existsSync.mockReturnValue(true);
    localBranch(true);
    listWorktrees.mockResolvedValue([RELEASE]);
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://github.com/example/repo/pull/1', detail: 'MERGED' });
    prepareInventoriedCheckoutRetirement.mockResolvedValue({ ok: true, review: { ...review(), comparison: { disposition: 'integrated', localPatch: '', difference: '' } } });
    retireInventoriedCheckout.mockImplementation(async (_input, options) => { await options.beforeMutation(); return { ok: true, branchDeleted: true }; });
    recordCompletionCleanup.mockImplementationOnce(async () => { owner.metadata.blocker = { reason: 'manual decision' }; return true; });

    expect(await recheckAgentCleanup(owner.id, pending.id)).toMatchObject({ ok: true, verified: false, reasons: ['cleanup-provenance-unverified'] });
    expect(retireInventoriedCheckout).toHaveBeenCalledOnce();
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('requires a captured checkout before retiring or completing a manual recheck', async () => {
    const pending = { ...task(), status: 'in_progress', metadata: { ...task().metadata,
      deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-1' } };
    const owner = { ...agentState(), id: 'agent-1', taskId: pending.id, status: 'completed',
      result: manualCleanupResult(), metadata: { ...agentState().metadata,
        completionCleanup: completedCleanup(), repoStateVerification: { status: 'pending' } } };
    getTaskById.mockResolvedValue(pending);
    getAgentRecord.mockResolvedValue(owner);
    expect(await recheckAgentCleanup(owner.id, pending.id)).toMatchObject({ ok: true, verified: false, reasons: ['checkout-capture-unverified'] });
    expect(retireInventoriedCheckout).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('repairs a pending capture before applying the captured-checkout gate', async () => {
    const pending = { ...task(), status: 'in_progress', metadata: { ...task().metadata,
      deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-1' } };
    const owner = { ...agentState(), id: 'agent-1', taskId: pending.id, status: 'completed',
      result: manualCleanupResult(), metadata: { ...agentState().metadata,
        checkoutCapture: { status: 'pending' }, completionCleanup: completedCleanup(), repoStateVerification: { status: 'pending' } } };
    getTaskById.mockResolvedValue(pending);
    getAgentRecord.mockResolvedValue(owner);
    retryCompletionCheckoutCapture.mockImplementationOnce(async () => { owner.metadata.checkoutCapture.status = 'captured'; return true; });
    existsSync.mockReturnValue(true);
    localBranch(true);
    listWorktrees.mockResolvedValue([RELEASE]);
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://github.com/example/repo/pull/1', detail: 'MERGED' });
    prepareInventoriedCheckoutRetirement.mockResolvedValue({ ok: true, review: { ...review(), comparison: { disposition: 'integrated', localPatch: '', difference: '' } } });
    retireInventoriedCheckout.mockImplementation(async (_input, options) => { await options.beforeMutation(); return { ok: true, branchDeleted: true }; });

    expect(await recheckAgentCleanup(owner.id, pending.id)).toMatchObject({ ok: true, verified: true });
    expect(retryCompletionCheckoutCapture).toHaveBeenCalledWith(owner.id);
    expect(retireInventoriedCheckout).toHaveBeenCalledOnce();
    expect(updateTask).toHaveBeenCalledWith(pending.id, expect.objectContaining({ status: 'completed' }), 'user', expect.any(Object));
  });

  describe('completion stages held on repository verification (#14128)', () => {
    const captured = { version: 1, agentId: 'agent-1', startedAt: CREATED_AT, capturedAt: CREATED_AT,
      repoPath: '/repo', branch: BRANCH, path: WORKTREE, head: HEAD, incarnation: { pointer: { dev: '1', ino: '2', birthtimeNs: '3' } } };
    const heldOwner = stagePatch => {
      const pending = { ...task(), status: 'in_progress', metadata: { ...task().metadata,
        deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-1' } };
      const receipt = completedCleanup();
      receipt.status = 'pending';
      Object.assign(receipt.stages, stagePatch);
      const owner = { ...agentState(), id: 'agent-1', taskId: pending.id, status: 'completed', completedAt: CREATED_AT,
        result: manualCleanupResult(), metadata: { ...agentState().metadata, completedCheckouts: [captured],
          checkoutCapture: { status: 'captured' }, completionCleanup: receipt, repoStateVerification: { status: 'pending' } } };
      getTaskById.mockResolvedValue(pending);
      getAgentRecord.mockResolvedValue(owner);
      existsSync.mockReturnValue(true);
      localBranch(true);
      listWorktrees.mockResolvedValue([RELEASE]);
      readCompletedCheckoutIdentity.mockResolvedValue(captured);
      findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://github.com/example/repo/pull/1', detail: 'MERGED' });
      prepareInventoriedCheckoutRetirement.mockResolvedValue({ ok: true, review: { ...review(), comparison: { disposition: 'integrated', localPatch: '', difference: '' } } });
      return { pending, owner };
    };
    const expectNoSettlementOrDispatch = () => {
      expect(updateTask).not.toHaveBeenCalled();
      expect(addTask).not.toHaveBeenCalled();
      expect(replayAgentCompletionCleanup).not.toHaveBeenCalled();
      expect(releaseRetryHold).not.toHaveBeenCalled();
      expect(recordRepoStateVerification).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: 'completed' }));
    };

    it.each([
      ['pipeline', 'checkout-retirement-pending'], ['creative', 'checkout-retirement-pending'], ['pipeline', 'checkout-capture-pending'],
    ])('retires the checkout for a %s stage held on %s and leaves the task to the completion lifecycle', async (key, reason) => {
      const { pending, owner } = heldOwner({ [key]: { status: 'held', retryable: true, reason } });
      retireInventoriedCheckout.mockImplementation(async (_input, options) => { await options.beforeMutation(); return { ok: true, branchDeleted: true }; });

      expect(await recheckAgentCleanup(owner.id, pending.id)).toEqual({ ok: true, verified: false, reasons: ['completion-handoff-pending'] });
      expect(retireInventoriedCheckout).toHaveBeenCalledOnce();
      expect(recordCompletionCleanup).toHaveBeenCalledWith(owner.id, owner.startedAt, { stages: { worktree: { status: 'done', retryable: false,
        value: [], verifiedBy: 'repository-state-verification', taskSettlement: 'after-completion-stages' } } });
      expect(recordRepoStateVerification).toHaveBeenCalledWith(owner.id, expect.objectContaining({ status: 'pending', reasons: ['completion-handoff-pending'] }));
      expectNoSettlementOrDispatch();
    });

    it('settles the task in the normal verification pass after the held stages finish', async () => {
      const { pending, owner } = heldOwner({ pipeline: { status: 'held', retryable: true, reason: 'checkout-retirement-pending' } });
      retireInventoriedCheckout.mockImplementation(async (_input, options) => { await options.beforeMutation(); return { ok: true, branchDeleted: true }; });
      await recheckAgentCleanup(owner.id, pending.id);
      expect(updateTask).not.toHaveBeenCalled();
      // The completion replay advanced its chain from the deferred receipt; the
      // retired checkout is now absent and only task settlement remains.
      owner.metadata.completionCleanup = { ...completedCleanup(), stages: { ...completedCleanup().stages,
        worktree: { status: 'done', verifiedBy: 'repository-state-verification', taskSettlement: 'after-completion-stages' } } };
      localBranch(false);
      existsSync.mockReturnValue(false);
      listWorktrees.mockResolvedValue([]);
      findMissingCheckoutPreservation.mockResolvedValue({ kind: 'service-retirement-receipt', recheck: vi.fn(async () => true) });
      expect(await verifyAgentRepoState({ agentId: owner.id, agentState: owner, task: pending, success: false, prExpected: true }))
        .toMatchObject({ verified: true });
      expect(updateTask).toHaveBeenCalledOnce();
      expect(updateTask).toHaveBeenCalledWith(pending.id, expect.objectContaining({ status: 'completed' }), 'user',
        expect.objectContaining({ expectedStatus: 'in_progress' }));
      expect(recordRepoStateVerification).toHaveBeenLastCalledWith(owner.id, expect.objectContaining({ status: 'completed' }));
      expect(retireInventoriedCheckout).toHaveBeenCalledOnce();
      expect(addTask).not.toHaveBeenCalled();
    });

    it.each([
      ['a failed chain hand-off', { pipeline: { status: 'failed', retryable: false, reason: 'pipeline-write-unverified' } }],
      ['a running chain hand-off', { creative: { status: 'running', retryable: false } }],
      ['an abandoned chain hand-off', { pipeline: { status: 'abandoned', reason: 'external-handoff-unverified' } }],
      ['a chain hold with another reason', { pipeline: { status: 'held', reason: 'completion-sentinel-generation-pending' } }],
      ['an external hand-off held on capture', { jira: { status: 'held', retryable: true, reason: 'checkout-capture-pending' } }],
      ['a held worktree stage', { pipeline: { status: 'held', reason: 'checkout-retirement-pending' }, worktree: { status: 'held', value: ['warning'] } }],
      ['a held completion signal', { sentinel: { status: 'held' } }],
    ])('refuses the recheck for %s', async (_name, stagePatch) => {
      const { pending, owner } = heldOwner(stagePatch);
      expect(await recheckAgentCleanup(owner.id, pending.id)).toEqual({ ok: true, verified: false, reasons: ['completion-stages-pending'] });
      expect(retireInventoriedCheckout).not.toHaveBeenCalled();
      expect(recordCompletionCleanup).not.toHaveBeenCalled();
      expect(recordRepoStateVerification).not.toHaveBeenCalled();
      expectNoSettlementOrDispatch();
    });

    it('retains the checkout if a held stage starts running during the recheck', async () => {
      const { pending, owner } = heldOwner({ pipeline: { status: 'held', retryable: true, reason: 'checkout-retirement-pending' } });
      let removed = false;
      retireInventoriedCheckout.mockImplementation(async (_input, options) => {
        owner.metadata.completionCleanup.stages.pipeline = { status: 'running', retryable: true };
        await options.beforeMutation();
        removed = true;
        return { ok: true, branchDeleted: true };
      });
      expect(await recheckAgentCleanup(owner.id, pending.id)).toMatchObject({ ok: true, verified: false, reasons: ['completion-stages-pending'] });
      expect(removed).toBe(false);
      expect(recordCompletionCleanup).not.toHaveBeenCalled();
      expectNoSettlementOrDispatch();
    });

    it('does not settle a held run even if its stages finish concurrently', async () => {
      const { pending, owner } = heldOwner({ pipeline: { status: 'held', retryable: true, reason: 'checkout-retirement-pending' } });
      retireInventoriedCheckout.mockImplementation(async (_input, options) => {
        owner.metadata.completionCleanup = completedCleanup();
        await options.beforeMutation();
        return { ok: true, branchDeleted: true };
      });
      expect(await recheckAgentCleanup(owner.id, pending.id)).toEqual({ ok: true, verified: false, reasons: ['completion-handoff-pending'] });
      expectNoSettlementOrDispatch();
    });

    it('refuses a held run whose task owner changes during retirement', async () => {
      const { pending, owner } = heldOwner({ pipeline: { status: 'held', retryable: true, reason: 'checkout-retirement-pending' } });
      let removed = false;
      retireInventoriedCheckout.mockImplementation(async (_input, options) => {
        getTaskById.mockResolvedValue({ ...pending, metadata: { ...pending.metadata, deliveryRecoveryAgentId: 'agent-2' } });
        await options.beforeMutation();
        removed = true;
        return { ok: true, branchDeleted: true };
      });
      expect(await recheckAgentCleanup(owner.id, pending.id)).toEqual({ ok: false, reason: 'cleanup-owner-changed' });
      expect(removed).toBe(false);
      expect(recordCompletionCleanup).not.toHaveBeenCalled();
      expectNoSettlementOrDispatch();
    });
  });

  it('retains the task if another completion stage changes while cleanup settles', async () => {
    const pending = { ...task(), status: 'in_progress', metadata: { ...task().metadata,
      deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-1' } };
    const owner = { ...agentState(), id: 'agent-1', taskId: pending.id, status: 'completed',
      result: manualCleanupResult(), metadata: { ...agentState().metadata,
        checkoutCapture: { status: 'captured' }, completionCleanup: completedCleanup(), repoStateVerification: { status: 'pending' } } };
    getTaskById.mockResolvedValue(pending);
    getAgentRecord.mockResolvedValue(owner);
    existsSync.mockReturnValue(true);
    localBranch(true);
    listWorktrees.mockResolvedValue([RELEASE]);
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://github.com/example/repo/pull/1', detail: 'MERGED' });
    prepareInventoriedCheckoutRetirement.mockResolvedValue({ ok: true, review: { ...review(), comparison: { disposition: 'integrated', localPatch: '', difference: '' } } });
    retireInventoriedCheckout.mockImplementation(async (_input, options) => { await options.beforeMutation(); return { ok: true, branchDeleted: true }; });
    recordCompletionCleanup.mockImplementationOnce(async () => {
      owner.metadata.completionCleanup.stages.pipeline = { status: 'held' };
      return true;
    });
    expect(await recheckAgentCleanup(owner.id, pending.id)).toMatchObject({ ok: true, verified: false, reasons: ['completion-stages-pending'] });
    expect(updateTask).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  it('explains when an intentionally open PR retains its checkout', async () => {
    const pending = { ...task({ prCompletion: 'leave-open' }), status: 'in_progress',
      metadata: { ...task({ prCompletion: 'leave-open' }).metadata, deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-1' } };
    const owner = { ...agentState(), id: 'agent-1', taskId: pending.id, status: 'completed',
      result: manualCleanupResult(), metadata: { ...agentState().metadata,
        checkoutCapture: { status: 'captured' }, completionCleanup: completedCleanup(), repoStateVerification: { status: 'pending' } } };
    getTaskById.mockResolvedValue(pending);
    getAgentRecord.mockResolvedValue(owner);
    existsSync.mockReturnValue(true);
    localBranch(true);
    listWorktrees.mockResolvedValue([RELEASE]);
    expect(await recheckAgentCleanup(owner.id, pending.id)).toMatchObject({ ok: true, verified: false, reasons: ['leave-open-cleanup-unsupported'] });
    expect(retireInventoriedCheckout).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('does not replay completion or refill from events emitted by a partial manual cleanup', async () => {
    const branches = ['claim/issue-1', 'claim/issue-2'];
    const captures = branches.map((branch, index) => ({ version: 1, agentId: 'agent-swarm', startedAt: CREATED_AT,
      capturedAt: CREATED_AT, repoPath: '/repo', path: `/tree/${index}`, branch, head: HEAD,
      incarnation: { pointer: { dev: '1', ino: String(index + 2), birthtimeNs: '3' } } }));
    const pending = { ...task({ claimFlow: true, analysisType: 'claim-issue' }), id: 'task-swarm', status: 'in_progress',
      metadata: { ...task({ claimFlow: true, analysisType: 'claim-issue' }).metadata,
        deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-swarm' } };
    const owner = { id: 'agent-swarm', taskId: pending.id, status: 'completed', startedAt: CREATED_AT,
      result: manualCleanupResult(), metadata: { isWorktree: false, workspacePath: '/repo',
        configClaimFlow: true, claimBranches: branches, completedCheckouts: captures, checkoutCapture: { status: 'captured' }, completionCleanup: completedCleanup(),
        repoStateVerification: { status: 'pending' } } };
    getTaskById.mockResolvedValue(pending);
    getAgentRecord.mockImplementation(async id => id === 'unrelated-owner' ? null : owner);
    readBranchCompletionPolicies.mockResolvedValue([owner]);
    listWorktrees.mockResolvedValue(captures.map(row => ({ branch: `refs/heads/${row.branch}`, path: row.path, head: row.head })));
    readCompletedCheckoutIdentity.mockImplementation(async ({ branch }) => captures.find(row => row.branch === branch));
    readCheckoutPathPresence.mockResolvedValue(true);
    localBranch(true);
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://github.com/example/repo/pull/1', detail: 'MERGED' });
    recordBranchReconcileOutcome.mockImplementation(async (_app, input) => ({ retirementObligations:
      input.retirementObligations?.map(row => ({ ...row, createdAt: CREATED_AT })) || [] }));
    const seenCapture = vi.fn(), seenRetirement = vi.fn();
    let startedPreview, releasePreview;
    const previewStarted = new Promise(resolve => { startedPreview = resolve; });
    const previewRelease = new Promise(resolve => { releasePreview = resolve; });
    cosEvents.on('agent:checkout-captured', seenCapture);
    cosEvents.on('checkout:retired', seenRetirement);
    const unbind = bindCompletionRetirementEvents(cosEvents);
    try {
      prepareInventoriedCheckoutRetirement.mockImplementation(async ({ release }) => {
        cosEvents.emit('agent:checkout-captured', { agentId: 'another-owner' });
        if (release.branch === branches[0]) { startedPreview(); await previewRelease; }
        return release.branch === branches[0]
          ? { ok: true, review: { digest: 'a'.repeat(64), forge: { prHead: HEAD },
            comparison: { disposition: 'integrated', localPatch: '', difference: '' } } }
          : { ok: false, reason: 'worktree-dirty' };
      });
      retireInventoriedCheckout.mockImplementation(async ({ release }, options) => {
        await options.beforeMutation();
        cosEvents.emit('checkout:retired', { appId: 'demo-app', ...release, checkoutIdentity: 'a'.repeat(64) });
        return { ok: true, branchDeleted: true };
      });
      const checking = recheckAgentCleanup(owner.id, pending.id);
      await previewStarted;
      // A separate capture while this request is in flight still reaches normal replay.
      const listener = cosEvents.listeners('agent:checkout-captured').find(fn => fn !== seenCapture);
      await listener({ agentId: 'unrelated-owner' });
      expect(getAgentRecord).toHaveBeenCalledWith('unrelated-owner');
      releasePreview();
      const result = await checking;
      expect(result).toMatchObject({ ok: true, verified: false, reasons: ['worktree-dirty'] });
      expect(seenCapture).toHaveBeenCalled();
      expect(seenRetirement).toHaveBeenCalledOnce();
      expect(replayAgentCompletionCleanup).not.toHaveBeenCalled();
      expect(recordSwarmCleanupDelivery).not.toHaveBeenCalled();
      expect(addTask).not.toHaveBeenCalled();
      expect(updateTask).not.toHaveBeenCalled();

    } finally {
      releasePreview();
      unbind();
      cosEvents.off('agent:checkout-captured', seenCapture);
      cosEvents.off('checkout:retired', seenRetirement);
    }
  });

  it('does not wake a delivery parent for a cleanup-only completion event', async () => {
    const events = new EventEmitter();
    const unbind = bindCompletionRetirementEvents(events);
    const completed = { id: 'follow-up', status: 'completed', metadata: { reviewLoopFollowUp: 'true',
      sourceAgentId: 'parent-agent', sourceTaskId: 'parent-task' } };
    try {
      const listener = events.listeners('tasks:changed')[0];
      await listener({ task: completed, suppressCompletionWake: true });
      expect(getAgentRecord).not.toHaveBeenCalled();
      await listener({ task: completed });
      expect(getAgentRecord).toHaveBeenCalledWith('parent-agent');
    } finally { unbind(); }
  });

  it('refuses a stale owner and retains a checkout if its task changes during recheck', async () => {
    const pending = { ...task(), status: 'in_progress', metadata: { ...task().metadata,
      deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-1' } };
    const owner = { ...agentState(), id: 'agent-1', taskId: pending.id, status: 'completed',
      result: manualCleanupResult(), metadata: { ...agentState().metadata,
        checkoutCapture: { status: 'captured' }, completionCleanup: completedCleanup(), repoStateVerification: { status: 'pending' } } };
    getAgentRecord.mockResolvedValue(owner);
    getTaskById.mockResolvedValueOnce(null);
    expect(await recheckAgentCleanup(owner.id, pending.id)).toEqual({ ok: false, reason: 'cleanup-owner-changed' });
    getTaskById.mockResolvedValue(pending);
    existsSync.mockReturnValue(true);
    localBranch(true);
    listWorktrees.mockResolvedValue([RELEASE]);
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://github.com/example/repo/pull/1', detail: 'MERGED' });
    prepareInventoriedCheckoutRetirement.mockResolvedValue({ ok: true, review: { ...review(), comparison: { disposition: 'integrated', localPatch: '', difference: '' } } });
    let removed = false;
    retireInventoriedCheckout.mockImplementation(async (_input, options) => {
      getTaskById.mockResolvedValue(null);
      await options.beforeMutation();
      removed = true;
      return { ok: true, branchDeleted: true };
    });
    expect(await recheckAgentCleanup(owner.id, pending.id)).toMatchObject({ ok: false, reason: 'cleanup-owner-changed' });
    expect(removed).toBe(false);
    expect(updateTask).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  it('refuses a task changed between the first owner check and verification', async () => {
    const pending = { ...task(), status: 'in_progress', metadata: { ...task().metadata,
      deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-1' } };
    const owner = { ...agentState(), id: 'agent-1', taskId: pending.id, status: 'completed',
      result: manualCleanupResult(), metadata: { ...agentState().metadata,
        checkoutCapture: { status: 'captured' }, completionCleanup: completedCleanup(), repoStateVerification: { status: 'pending' } } };
    getAgentRecord.mockResolvedValue(owner);
    getTaskById.mockResolvedValueOnce(pending).mockResolvedValueOnce(pending)
      .mockResolvedValueOnce({ ...pending, description: 'Changed by the operator' });
    expect(await recheckAgentCleanup(owner.id, pending.id)).toEqual({ ok: false, reason: 'cleanup-owner-changed' });
    expect(retireInventoriedCheckout).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  it('does not create an agent task when a manual cleanup recheck needs review', async () => {
    const pending = { ...task(), status: 'in_progress', metadata: { ...task().metadata,
      deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-1' } };
    const owner = { ...agentState(), id: 'agent-1', taskId: pending.id, status: 'completed',
      result: manualCleanupResult(), metadata: { ...agentState().metadata,
        checkoutCapture: { status: 'captured' }, completionCleanup: completedCleanup(), repoStateVerification: { status: 'pending' } } };
    getTaskById.mockResolvedValue(pending);
    getAgentRecord.mockResolvedValue(owner);
    existsSync.mockReturnValue(true);
    localBranch(true);
    listWorktrees.mockResolvedValue([RELEASE]);
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://github.com/example/repo/pull/1', detail: 'MERGED' });
    prepareInventoriedCheckoutRetirement.mockResolvedValue({ ok: true, review: review() });
    expect(await recheckAgentCleanup(owner.id, pending.id)).toMatchObject({ ok: true, verified: false, reasons: ['cleanup-review-required'] });
    expect(addTask).not.toHaveBeenCalled();
    expect(retireInventoriedCheckout).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
  });

  it.each(['task', 'registration'])('retires a resumed claim with openPR disabled using its %s contract', async contract => {
    const pending = { ...task({ openPR: false, ...(contract === 'task' ? { claimFlow: true } : {}) }), status: 'in_progress' };
    pending.metadata = { ...pending.metadata, deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-1' };
    getTaskById.mockResolvedValue(pending);
    const state = { ...agentState(contract === 'registration' ? { configClaimFlow: true } : {}),
      result: { success: false, executionSuccess: true, cleanupPending: true } };
    existsSync.mockReturnValue(true);
    localBranch(true);
    listWorktrees.mockResolvedValue([RELEASE]);
    prepareInventoriedCheckoutRetirement.mockResolvedValue({ ok: true, review: { ...review(), comparison: { disposition: 'integrated', localPatch: '', difference: '' } } });
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://github.com/example/repo/pull/1', detail: 'MERGED' });

    expect(await run({ task: pending, agentState: state, success: false, prExpected: false })).toMatchObject({ verified: true });
    expect(retireInventoriedCheckout).toHaveBeenCalledWith(expect.objectContaining({
      release: RELEASE, review: { prUrl: 'https://github.com/example/repo/pull/1', digest: 'a'.repeat(64), acceptSuperseded: false },
    }), expect.objectContaining({ beforeMutation: expect.any(Function) }));
    expect(updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'completed' }), 'user', expect.any(Object));
    expect(releaseRetryHold).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  it('keeps an unreadable claim PR pending instead of treating the skipped lookup as no delivery', async () => {
    const pending = { ...task({ openPR: false, claimFlow: true }), status: 'in_progress' };
    pending.metadata = { ...pending.metadata, deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-1' };
    getTaskById.mockResolvedValue(pending);
    localBranch(true);
    findPullRequestForBranch.mockResolvedValue({ status: 'unavailable' });
    const result = await run({ task: pending, prExpected: false, success: false,
      agentState: { ...agentState(), result: { cleanupPending: true } } });
    expect(result).toMatchObject({ verified: false, skipReason: 'cleanup-delivery-unverified', observed: { unreadable: ['pull-request'] } });
    expect(retireInventoriedCheckout).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    expect(releaseRetryHold).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  it('retires a clean merged branch deterministically instead of queuing an agent', async () => {
    existsSync.mockReturnValue(true);
    localBranch(true);
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://github.com/example/repo/pull/1', detail: 'MERGED' });
    listWorktrees.mockResolvedValue([RELEASE]);
    prepareInventoriedCheckoutRetirement.mockResolvedValue({ ok: true, review: { ...review(), comparison: { disposition: 'integrated', localPatch: '', difference: '' } } });

    const result = await run();

    expect(result).toMatchObject({ verified: true, recoveryTaskId: null });
    expect(retireInventoriedCheckout).toHaveBeenCalledWith(expect.objectContaining({ review: expect.objectContaining({ acceptSuperseded: false }) }), expect.objectContaining({ beforeMutation: expect.any(Function) }));
    expect(addTask).not.toHaveBeenCalled();
    expect(recordCleanupOutcome).toHaveBeenCalledWith('agent-1', expect.objectContaining({ status: 'verified', reason: 'retirement-receipt-verified' }));
  });

  describe('app scope for retirement (#13405)', () => {
    const mergedLeftover = () => {
      existsSync.mockReturnValue(true);
      localBranch(true);
      listWorktrees.mockResolvedValue([{ ...RELEASE, branch: `refs/heads/${BRANCH}` }]);
      findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://github.com/example/repo/pull/1', detail: 'MERGED' });
      prepareInventoriedCheckoutRetirement.mockResolvedValue({ ok: true, review: { ...review(), comparison: { disposition: 'integrated', localPatch: '', difference: '' } } });
    };
    const appless = () => run({ task: task({ app: undefined, appName: undefined }) });

    it('resolves the one managed app from the trusted repository for an app-less task', async () => {
      mergedLeftover();
      resolveRetirementApp.mockResolvedValue({ app: { id: 'repo-app', repoPath: '/repo' } });
      expect(await appless()).toMatchObject({ verified: true, recoveryTaskId: null });
      expect(resolveRetirementApp).toHaveBeenCalledWith('/repo');
      expect(recordBranchReconcileOutcome).toHaveBeenCalledWith('repo-app', expect.objectContaining({
        retirementObligations: [{ ...RELEASE, reason: 'retirement-review-pending' }],
      }));
      expect(prepareInventoriedCheckoutRetirement).toHaveBeenCalledWith(expect.objectContaining({ appId: 'repo-app' }));
      expect(retireInventoriedCheckout).toHaveBeenCalledWith(expect.objectContaining({ appId: 'repo-app' }), expect.any(Object));
    });

    it('carries a resolved app scope through cognitive retirement dispatch and its server binding', async () => {
      mergedLeftover();
      resolveRetirementApp.mockResolvedValue({ app: { id: 'repo-app', repoPath: '/repo' } });
      prepareInventoriedCheckoutRetirement.mockResolvedValue({ ok: true, review: review() });
      expect(await appless()).toMatchObject({ verified: false, recoveryTaskId: 'task-recovery-1' });
      expect(addTask).toHaveBeenCalledWith(expect.objectContaining({ app: 'repo-app',
        metadata: expect.objectContaining({ retirementReview: { appId: 'repo-app', release: RELEASE, createdAt: CREATED_AT } }),
      }), 'internal');
      expect(recordRepoStateRecovery).toHaveBeenCalledWith('agent-1', expect.objectContaining({
        retirementReview: { appId: 'repo-app', release: RELEASE, createdAt: CREATED_AT },
      }), { claimRun: true });
    });

    it.each(['retirement-app-ambiguous', 'retirement-app-unavailable'])('retains an app-less task whose repository scope is %s', async reason => {
      mergedLeftover();
      resolveRetirementApp.mockResolvedValue({ reason });
      expect(await appless()).toMatchObject({ verified: false, skipReason: reason });
      expect(recordBranchReconcileOutcome).not.toHaveBeenCalled();
      expect(prepareInventoriedCheckoutRetirement).not.toHaveBeenCalled();
      expect(retireInventoriedCheckout).not.toHaveBeenCalled();
    });

    it.each([
      ['missing', null],
      ['mismatched', { id: 'demo-app', repoPath: '/other' }],
    ])('never falls through to another app when the named app is %s', async (_name, app) => {
      mergedLeftover();
      getAppById.mockResolvedValue(app);
      resolveRetirementApp.mockResolvedValue({ app: { id: 'repo-app', repoPath: '/repo' } });
      expect(await run()).toMatchObject({ verified: false, skipReason: 'retirement-app-unavailable' });
      expect(resolveRetirementApp).not.toHaveBeenCalled();
      expect(recordBranchReconcileOutcome).not.toHaveBeenCalled();
      expect(retireInventoriedCheckout).not.toHaveBeenCalled();
    });
  });

  it('files ONE recovery task for a leftover worktree and branch after a merged PR', async () => {
    // The reported failure shape: the agent merged its own PR (branch gone on the
    // forge) but its local branch and worktree survived cleanup silently.
    existsSync.mockReturnValue(true);
    localBranch(true);
    listWorktrees.mockResolvedValue([{ ...RELEASE, branch: `refs/heads/${BRANCH}` }]);
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://github.com/example/repo/pull/1', detail: 'MERGED' });

    const result = await run();

    expect(result.verified).toBe(false);
    expect(result.issues.map(i => i.code)).toEqual([
      REPO_STATE_ISSUES.WORKTREE_PRESENT,
      REPO_STATE_ISSUES.LOCAL_BRANCH_PRESENT,
    ]);
    expect(addTask).toHaveBeenCalledTimes(1);
    const [payload, kind] = addTask.mock.calls[0];
    expect(kind).toBe('internal');
    expect(payload.description).toContain(BRANCH);
    expect(payload.isRecovery).toBe(true);
    expect(payload.metadata.recoveryOrigin).toMatchObject({ subsystem: 'repository-cleanup', attempt: 1, noProgress: false });
    expect(payload.metadata.recoveryOrigin.observation).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.app).toBe('demo-app');
    // The recovery agent must not run in a worktree of its own — it is cleaning
    // worktrees up.
    expect(payload.useWorktree).toBe(false);
    // Remediation must be actionable without re-diagnosing, and must forbid
    // deleting unmerged work or touching a sibling agent's branch.
    expect(payload.context).toContain(`Keep the retained worktree ${WORKTREE}`);
    expect(payload.context).toContain('/api/cos/schedule/branch-reconcile/checkouts/review');
    expect(payload.context).toContain('/api/cos/schedule/branch-reconcile/checkouts/retire');
    expect(payload.context).toContain('FULL returned review.comparison.localPatch and difference');
    expect(payload.context).toContain('"digest":"<review.digest>"');
    expect(payload.context).toContain('ok:true and branchDeleted:true');
    expect(payload.context).not.toMatch(/git (?:worktree (?:remove|unlock|prune)|branch -[dD]|push[^\n]*--delete)|--remove-source-branch/);
    expect(payload.metadata.retirementReview).toEqual({ appId: 'demo-app', release: RELEASE, createdAt: CREATED_AT });
    expect(recordRepoStateRecovery).toHaveBeenCalledWith('agent-1', { taskId: 'task-recovery-1', branch: BRANCH,
      repoPath: '/repo', retirementReview: payload.metadata.retirementReview }, { claimRun: true });
    expect(recordBranchReconcileOutcome).toHaveBeenCalledWith('demo-app', expect.objectContaining({
      retirementObligations: [{ ...RELEASE, reason: 'retirement-review-pending' }],
    }));
    expect(recordBranchReconcileOutcome.mock.invocationCallOrder[0]).toBeLessThan(prepareInventoriedCheckoutRetirement.mock.invocationCallOrder[0]);
    expect(prepareInventoriedCheckoutRetirement.mock.invocationCallOrder[0]).toBeLessThan(addTask.mock.invocationCallOrder[0]);
    expect(payload.context).toContain(`touch ONLY ${BRANCH}`);
    expect(ensureTaskThread).not.toHaveBeenCalled();
  });

  it('retains a recovery successor divergence without starting another lineage', async () => {
    existsSync.mockReturnValue(true);
    localBranch(true);
    listWorktrees.mockResolvedValue([{ ...RELEASE, branch: `refs/heads/${BRANCH}` }]);
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://github.com/example/repo/pull/1', detail: 'MERGED' });
    const result = await run({ task: task({ recoveryOrigin: { subsystem: 'repository-cleanup', parentAgentId: 'original' } }) });
    expect(result).toMatchObject({ verified: false, skipReason: 'cleanup-successor-review-unresolved' });
    expect(addTask).not.toHaveBeenCalled();
    expect(recordCleanupOutcome).toHaveBeenCalledWith('agent-1', expect.objectContaining({ status: 'blocked', reason: 'cleanup-successor-review-unresolved' }));
  });

  it('retains a refused preview obligation and retries fresh evidence without dispatching unsafe cleanup', async () => {
    existsSync.mockReturnValue(true);
    localBranch(true);
    listWorktrees.mockResolvedValue([{ ...RELEASE, branch: `refs/heads/${BRANCH}` }]);
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://github.com/example/repo/pull/1', detail: 'MERGED' });
    prepareInventoriedCheckoutRetirement.mockResolvedValue({ ok: false, reason: 'active-agent-owner' });
    expect(await run()).toMatchObject({ verified: false, skipReason: 'active-agent-owner', recoveryTaskId: null });
    expect(addTask).not.toHaveBeenCalled();
    expect(recordBranchReconcileOutcome).toHaveBeenCalledWith('demo-app', expect.objectContaining({ reason: 'active-agent-owner' }));
    // The gate declining to retire is its designed outcome: reported at info, never warn.
    expect(emitLog).toHaveBeenCalledWith('info', expect.stringContaining('Repo-state retirement retained'), expect.any(Object));
    expect(emitLog).not.toHaveBeenCalledWith('warn', expect.stringContaining('Repo-state retirement retained'), expect.anything());
    prepareInventoriedCheckoutRetirement.mockResolvedValue({ ok: true, review: { ...review(), digest: 'b'.repeat(64) } });
    expect(await run()).toMatchObject({ verified: false, recoveryTaskId: 'task-recovery-1' });
    // The recovery task is the investigation, so the divergence itself is logged at info.
    expect(emitLog).toHaveBeenCalledWith('info', expect.stringContaining('Repo state diverged'), expect.any(Object));
    expect(emitLog).not.toHaveBeenCalledWith('warn', expect.stringContaining('Repo state diverged'), expect.anything());
    expect(prepareInventoriedCheckoutRetirement).toHaveBeenCalledTimes(2);
  });

  it.each(['locked', 'persistence-failed', 'obligation-missing', 'inventory-missing'])('preserves %s cleanup without shell fallback', async cause => {
    existsSync.mockReturnValue(true);
    localBranch(true);
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://github.com/example/repo/pull/1', detail: 'MERGED' });
    listWorktrees.mockResolvedValue(cause === 'inventory-missing' ? [] : [{ ...RELEASE, locked: cause === 'locked', branch: `refs/heads/${BRANCH}` }]);
    if (cause === 'persistence-failed') recordBranchReconcileOutcome.mockRejectedValue(new Error('write refused'));
    if (cause === 'obligation-missing') recordBranchReconcileOutcome.mockResolvedValue({});
    const result = await run();
    expect(result.verified).toBe(false);
    expect(result.skipReason).toMatch(/^retirement-/);
    expect(prepareInventoriedCheckoutRetirement).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  it('finds a worktree git still tracks even when the directory is gone', async () => {
    listWorktrees.mockResolvedValue([{ path: WORKTREE, branch: `refs/heads/${BRANCH}` }]);
    const result = await run({ prExpected: false });
    expect(result.issues.map(i => i.code)).toEqual([REPO_STATE_ISSUES.WORKTREE_PRESENT]);
  });

  it('holds an orphan OPEN PR waiting for CI through 70 scans without cognitive work', async () => {
    localBranch(true);
    hasBranchMergeEvidence.mockResolvedValue(false);
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://github.com/example/repo/pull/9', detail: 'OPEN', autoMergeEnabled: true, headRefOid: HEAD });
    for (let i = 0; i < 70; i++) expect(await run()).toMatchObject({ verified: false, skipReason: 'delivery-ci-or-review-pending', recoveryTaskId: null });
    expect(addTask).not.toHaveBeenCalled();
    expect(reserveRepoCleanupRecovery).not.toHaveBeenCalled();
  });

  it.each(['CONFLICTING', 'FAILURE'])('admits genuine exact-head code repair after %s evidence', async failure => {
    localBranch(true);
    hasBranchMergeEvidence.mockResolvedValue(false);
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://github.com/example/repo/pull/9', detail: 'OPEN', headRefOid: HEAD });
    execGh.mockResolvedValue(openView(failure === 'CONFLICTING' ? { mergeable: failure } : { statusCheckRollup: [{ name: 'CI', conclusion: failure }] }));
    inspectOrQueueCompletedReview.mockResolvedValue({ disposition: 'queued-review', reason: 'code-repair-queued', taskId: 'review-1' });
    expect(await run()).toMatchObject({ recoveryTaskId: 'review-1' });
    expect(inspectOrQueueCompletedReview).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-1', branch: BRANCH, headSha: HEAD, worktreePath: WORKTREE, repairEvidence: expect.objectContaining({ head: HEAD }) }));
    expect(addTask).not.toHaveBeenCalled();
  });

  it('does not send changed/unpublished head or malformed forge data to code recovery', async () => {
    localBranch(true);
    hasBranchMergeEvidence.mockResolvedValue(false);
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://github.com/example/repo/pull/9', detail: 'OPEN' });
    execGh.mockResolvedValue(openView({ headRefOid: '3'.repeat(40), mergeable: 'CONFLICTING' }));
    expect(await run()).toMatchObject({ skipReason: 'delivery-head-unverified', recoveryTaskId: null });
    expect(addTask).not.toHaveBeenCalled();
  });

  it('reports an unmerged PR the agent left open', async () => {
    localBranch(true);
    hasBranchMergeEvidence.mockResolvedValue(false);
    listRemoteHeads.mockResolvedValue(new Map([[BRANCH, 'abc123']]));
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://github.com/example/repo/pull/9', detail: 'OPEN' });

    const result = await run();

    expect(result.issues.map(i => i.code)).toEqual([
      REPO_STATE_ISSUES.LOCAL_BRANCH_PRESENT,
      REPO_STATE_ISSUES.REMOTE_BRANCH_PRESENT,
      REPO_STATE_ISSUES.BRANCH_UNMERGED,
      REPO_STATE_ISSUES.PR_UNMERGED,
    ]);
    expect(result.skipReason).toBe('delivery-ci-or-review-pending');
    expect(addTask).not.toHaveBeenCalled();
  });

  it('does not re-file when a recovery task for the branch already exists', async () => {
    existsSync.mockReturnValue(true);
    addTask.mockResolvedValue({ id: 'task-recovery-1', duplicate: true });

    const result = await run({ prExpected: false });

    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.recoveryTaskId).toBeNull();
  });

  it('does not create a Brain recovery thread for routine retained content', async () => {
    existsSync.mockReturnValue(true);
    await run({ prExpected: false });

    expect(ensureTaskThread).not.toHaveBeenCalled();
  });
});

describe('verifyAgentRepoState — never fires', () => {
  it('is off for an app with verifyRepoStateOnCompletion: false', async () => {
    getAppById.mockResolvedValue({ id: 'demo-app', verifyRepoStateOnCompletion: false });
    existsSync.mockReturnValue(true);

    const result = await run();

    expect(result.skipReason).toBe(REPO_STATE_SKIPS.DISABLED);
    expect(addTask).not.toHaveBeenCalled();
    // The switch must short-circuit the probes too, not just the reporting.
    expect(listWorktrees).not.toHaveBeenCalled();
    expect(findPullRequestForBranch).not.toHaveBeenCalled();
  });

  it('leaves a FAILED run alone so its retry can resume from the preserved branch', async () => {
    existsSync.mockReturnValue(true);
    const result = await run({ success: false });
    expect(result.skipReason).toBe(REPO_STATE_SKIPS.FAILED_RUN);
    expect(addTask).not.toHaveBeenCalled();
  });

  it('defers while a review-loop follow-up still owns the branch', async () => {
    queuedTasks([{ status: 'pending', metadata: { app: 'demo-app', reviewLoopFollowUp: true, reviewLoopPRBranch: BRANCH } }]);
    existsSync.mockReturnValue(true);

    const result = await run({ task: task({ prCompletion: 'review-then-merge' }) });

    expect(result.skipReason).toBe(REPO_STATE_SKIPS.FOLLOW_UP_PENDING);
    expect(addTask).not.toHaveBeenCalled();
  });

  it('defers while a retry holds the branch as its resume pointer', async () => {
    queuedTasks([{ status: 'pending', metadata: { app: 'demo-app', existingBranch: BRANCH } }]);
    existsSync.mockReturnValue(true);
    const result = await run();
    expect(result.skipReason).toBe(REPO_STATE_SKIPS.FOLLOW_UP_PENDING);
  });

  it('defers while pr-watcher still holds the PR for a deterministic merge', async () => {
    // The merge-on-green GitHub path never spawns a follow-up TASK — it queues the
    // PR on the app record for the next watcher tick. Reading only the task queue
    // would call every one of those branches leaked.
    readPendingMergePrs.mockReturnValue([{ prBranch: BRANCH, prUrl: 'https://github.com/example/repo/pull/2' }]);
    existsSync.mockReturnValue(true);

    const result = await run();

    expect(result.skipReason).toBe(REPO_STATE_SKIPS.FOLLOW_UP_PENDING);
    expect(addTask).not.toHaveBeenCalled();
  });

  it('stands down when cleanup already raised a warning (it files its own recovery)', async () => {
    const result = await run({
      cleanupWarnings: ['Auto-merge failed for branch cos/task-x/agent-1 — branch preserved for manual recovery'],
    });
    expect(result.skipReason).toBe(REPO_STATE_SKIPS.CLEANUP_WARNED);
    expect(addTask).not.toHaveBeenCalled();
  });

  it('ignores a non-worktree run without reading the app record', async () => {
    const result = await run({ agentState: agentState({ isWorktree: false }) });
    expect(result.skipReason).toBe(REPO_STATE_SKIPS.NOT_WORKTREE);
    expect(getAppById).not.toHaveBeenCalled();
    expect(getAllTasks).not.toHaveBeenCalled();
  });

  it('reports probe-incomplete, not "clean", when git could not be asked at all', async () => {
    // A firewalled host must not manufacture a recovery agent per run — and must
    // not be logged as a verified-clean repo either.
    listWorktrees.mockRejectedValue(new Error('not a git repository'));
    execGit.mockRejectedValue(new Error('git unavailable'));
    listRemoteHeads.mockResolvedValue(null);
    findPullRequestForBranch.mockResolvedValue({ status: 'unavailable', url: null, detail: null });

    const result = await run();

    expect(result.skipReason).toBe('checkout-inventory-unavailable');
    expect(result.verified).toBe(false);
    expect(addTask).not.toHaveBeenCalled();
  });

  it('reports probe-incomplete when only SOME probes were unreadable', async () => {
    // The partial case is the dangerous one: worktree and branch both read clean,
    // so nothing diverged — but the forge never answered, so the PR could be
    // sitting open. Calling that "verified" is the absent-vs-empty conflation.
    findPullRequestForBranch.mockResolvedValue({ status: 'unavailable', url: null, detail: null });

    const result = await run();

    expect(result.skipReason).toBe('absent-checkout-integration-unverified');
    expect(addTask).not.toHaveBeenCalled();
  });

  it('still reports a divergence it COULD read alongside one it could not', async () => {
    // Partial knowledge does not suppress a finding — what was readable is fact.
    existsSync.mockReturnValue(true);
    findPullRequestForBranch.mockResolvedValue({ status: 'unavailable', url: null, detail: null });

    const result = await run();

    expect(result.issues.map(i => i.code)).toContain(REPO_STATE_ISSUES.WORKTREE_PRESENT);
    expect(addTask).not.toHaveBeenCalled();
  });

  it('fails closed when the app record cannot be read', async () => {
    // A transient apps.json failure must not override an explicit per-app opt-out.
    getAppById.mockRejectedValue(new Error('apps.json unreadable'));
    existsSync.mockReturnValue(true);

    const result = await run();

    expect(result.skipReason).toBe(REPO_STATE_SKIPS.GATE_UNREADABLE);
    expect(addTask).not.toHaveBeenCalled();
  });

  it('fails closed when the task queue cannot be read', async () => {
    // "Could not read the queue" must never become "nobody owns this branch" — a
    // follow-up queued to land it would get a recovery task filed against it.
    getAllTasks.mockRejectedValue(new Error('tasks file unreadable'));
    existsSync.mockReturnValue(true);

    const result = await run();

    expect(result.skipReason).toBe(REPO_STATE_SKIPS.GATE_UNREADABLE);
    expect(addTask).not.toHaveBeenCalled();
  });

  it('defers while a CHALLENGED task still holds the branch', async () => {
    // `challenged` is a parked-for-dispute status, not a terminal one: the task
    // keeps its branch and resumes on it.
    queuedTasks([{ status: 'challenged', metadata: { app: 'demo-app', existingBranch: BRANCH } }]);
    existsSync.mockReturnValue(true);

    const result = await run();

    expect(result.skipReason).toBe(REPO_STATE_SKIPS.FOLLOW_UP_PENDING);
    expect(addTask).not.toHaveBeenCalled();
  });

  it('reports an unmerged GitLab merge request', async () => {
    // GitLab is probed too — leaving it unasked would silently pass an open MR as
    // a clean repo. States come back lowercase from glab.
    localBranch(true);
    resolveForgeForRepo.mockResolvedValue({ cli: 'glab', env: null });
    findMergeRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://gitlab.example.com/mr/4', number: 4, detail: 'opened' });

    const result = await run();

    expect(findPullRequestForBranch).not.toHaveBeenCalled();
    expect(result.issues.map(i => i.code)).toContain(REPO_STATE_ISSUES.PR_UNMERGED);
    expect(addTask).not.toHaveBeenCalled();
    expect(result.verified).toBe(false);
  });

  it('does not claim unmerged work when the merge check could not be answered', async () => {
    // `hasBranchMergeEvidence` fails CLOSED (`false`, not a throw) when it cannot read
    // a ref — right for its original caller, inverted into a false finding here.
    // An unresolvable ref must read as unknown, not as "carries unmerged commits".
    readLocalBranchPresence.mockResolvedValue(true);
    execGit.mockImplementation((args) => {
      if (args[0] === 'show-ref') return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      // rev-parse --verify fails => the ref could not be resolved
      return Promise.resolve({ exitCode: 128, stdout: '', stderr: 'bad revision' });
    });
    hasBranchMergeEvidence.mockResolvedValue(false);

    const result = await run({ prExpected: false });

    expect(hasBranchMergeEvidence).not.toHaveBeenCalled();
    expect(result.observed.branchMerged).toBeNull();
    expect(result.issues.map(i => i.code)).not.toContain(REPO_STATE_ISSUES.BRANCH_UNMERGED);
    expect(result.observed.unreadable).toContain('branch-merged');
  });

  it('does not report a MERGED GitLab merge request', async () => {
    resolveForgeForRepo.mockResolvedValue({ cli: 'glab', env: null });
    findMergeRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://gitlab.example.com/mr/4', detail: 'merged' });
    const result = await run();
    expect(result.verified).toBe(true);
    expect(result.skipReason).toBeNull();
  });
});

// A gate that returns a skip without recording it leaves the cleanup ledger
// silent about a held branch; one that records a different reason than it
// returns makes the Agent card and the completion audit disagree.
describe('verifyAgentRepoState — every hold records the reason it returns', () => {
  const merged = () => findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://github.com/example/repo/pull/1', detail: 'MERGED' });
  it.each([
    ['ownership-unreadable', REPO_STATE_SKIPS.GATE_UNREADABLE, {}, () => getAllTasks.mockRejectedValue(new Error('tasks file unreadable'))],
    ['checkout-inventory-unavailable', 'checkout-inventory-unavailable', {}, () => listWorktrees.mockRejectedValue(new Error('not a git repository'))],
    ['checkout-incarnation-changed', 'checkout-incarnation-changed', {}, () => listWorktrees.mockResolvedValue([{ ...RELEASE, path: '/repo/new-owner' }])],
    ['claim-ownership-unreadable', 'claim-ownership-unreadable', { owners: [] }, () => readClaimOwnershipAgents.mockRejectedValue(new Error('agents unreadable'))],
    ['probe-incomplete', REPO_STATE_SKIPS.PROBE_INCOMPLETE, {}, () => readLocalBranchPresence.mockRejectedValue(new Error('git crashed'))],
    ['probe-incomplete', REPO_STATE_SKIPS.PROBE_INCOMPLETE, {}, () => readCheckoutPathPresence.mockResolvedValue(null)],
    ['deterministic-cleanup-pending', 'deterministic-cleanup-pending', {}, () => existsSync.mockReturnValue(true), { prExpected: false }],
    ['delivery-evidence-unavailable', 'delivery-evidence-unavailable', {}, () => { localBranch(true); hasBranchMergeEvidence.mockResolvedValue(false); }, { prExpected: false }],
    ['delivery-ci-or-review-pending', 'delivery-ci-or-review-pending', {}, () => {
      localBranch(true); hasBranchMergeEvidence.mockResolvedValue(false);
      findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://github.com/example/repo/pull/9', detail: 'OPEN', headRefOid: HEAD });
    }],
    ['active-agent-owner', 'active-agent-owner', {}, () => {
      existsSync.mockReturnValue(true); localBranch(true); merged();
      listWorktrees.mockResolvedValue([RELEASE]);
      prepareInventoriedCheckoutRetirement.mockResolvedValue({ ok: false, reason: 'active-agent-owner' });
    }],
    ['retirement-outcome-uncertain', 'retirement-outcome-uncertain', {}, () => {
      existsSync.mockReturnValue(true); localBranch(true); merged();
      listWorktrees.mockResolvedValue([RELEASE]);
      prepareInventoriedCheckoutRetirement.mockResolvedValue({ ok: true, review: { ...review(), comparison: { disposition: 'integrated', localPatch: '', difference: '' } } });
      retireInventoriedCheckout.mockRejectedValue(new Error('archive write failed'));
    }],
  ])('records %s and returns %s', async (reason, skipReason, extra, arrange, overrides = {}) => {
    arrange();
    const result = await run(overrides);
    expect(result).toMatchObject({ verified: false, skipReason, recoveryTaskId: null });
    expect(recordCleanupOutcome).toHaveBeenLastCalledWith('agent-1', { status: 'blocked', reason, branch: BRANCH, path: WORKTREE, ...extra });
    expect(addTask).not.toHaveBeenCalled();
  });

  it('records the queued completed-review as pending under the task it returns', async () => {
    localBranch(true);
    hasBranchMergeEvidence.mockResolvedValue(false);
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://github.com/example/repo/pull/9', detail: 'OPEN', headRefOid: HEAD });
    execGh.mockResolvedValue(openView({ mergeable: 'CONFLICTING' }));
    inspectOrQueueCompletedReview.mockResolvedValue({ disposition: 'queued-review', reason: 'code-repair-queued', taskId: 'review-1' });
    expect(await run()).toMatchObject({ verified: false, skipReason: 'code-repair-queued', recoveryTaskId: 'review-1' });
    expect(recordCleanupOutcome).toHaveBeenLastCalledWith('agent-1', { status: 'pending', reason: 'code-repair-queued', branch: BRANCH, path: WORKTREE, taskId: 'review-1' });
  });

  it.each([false, true])('records each held claim branch under the reason it returns (pinned=%s)', async pinned => {
    readClaimOwnershipAgents.mockRejectedValue(new Error('agents unreadable'));
    const state = agentState({ isWorktree: false, worktreeBranch: null, workspacePath: '/repo', claimPicksOwnBranch: !pinned,
      ...(pinned ? { claimBranch: 'claim/issue-11' } : {}), claimBranches: ['claim/issue-11'] });
    expect((await run({ agentState: state })).branches).toEqual([{ branch: 'claim/issue-11', verified: false, skipReason: 'claim-ownership-unreadable', issues: [], recoveryTaskId: null }]);
    expect(recordCleanupOutcome).toHaveBeenLastCalledWith('agent-1', { branch: 'claim/issue-11', status: 'blocked', reason: 'claim-ownership-unreadable', owners: [] });

    readClaimOwnershipAgents.mockResolvedValue([]);
    localBranch(true);
    expect((await run({ agentState: state })).branches).toEqual([{ branch: 'claim/issue-11', verified: false, skipReason: 'claim-checkout-identity-unverified', issues: [], recoveryTaskId: null }]);
    expect(recordCleanupOutcome).toHaveBeenLastCalledWith('agent-1', { branch: 'claim/issue-11', status: 'blocked', reason: 'claim-checkout-identity-unverified' });
  });

  it('settles a receipt-less swarm branch from delivery evidence once its checkout and ref are gone', async () => {
    listWorktrees.mockResolvedValue([{ path: '/repo', branch: 'main', head: HEAD }]);
    const state = agentState({ isWorktree: false, worktreeBranch: null, workspacePath: '/repo', claimPicksOwnBranch: true, claimBranches: ['claim/issue-11'] });
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://github.com/example/repo/pull/11', detail: 'MERGED' });
    expect((await run({ agentState: state })).branches).toEqual([expect.objectContaining({ branch: 'claim/issue-11', verified: true, skipReason: null })]);
    expect(recordCleanupOutcome).toHaveBeenLastCalledWith('agent-1', expect.objectContaining({ branch: 'claim/issue-11', path: null, status: 'verified', reason: 'already-absent-merged' }));
    // A holder or an unreadable ref keeps the identity hold.
    listWorktrees.mockResolvedValue([{ ...RELEASE, branch: 'refs/heads/claim/issue-11' }]);
    expect((await run({ agentState: state })).branches[0].skipReason).toBe('claim-checkout-identity-unverified');
    listWorktrees.mockResolvedValue([]);
    readLocalBranchPresence.mockResolvedValue(null);
    expect((await run({ agentState: state })).branches[0].skipReason).toBe('claim-checkout-identity-unverified');
    expect(retireInventoriedCheckout).not.toHaveBeenCalled();
  });
});

describe('remediation coverage', () => {
  it('has a remediation for every issue code', () => {
    // The map is what makes "a new check must say what to do about it" real — the
    // switch-with-default it replaced silently accepted a new code.
    expect(Object.keys(REPO_STATE_REMEDIATIONS).sort()).toEqual(Object.values(REPO_STATE_ISSUES).sort());
  });

  it('renders each remediation from the branch, worktree and PR in hand', () => {
    const ctx = { branchName: BRANCH, base: 'main', prUrl: 'https://github.com/example/repo/pull/1', worktreePath: WORKTREE };
    for (const [code, render] of Object.entries(REPO_STATE_REMEDIATIONS)) {
      const text = render(ctx);
      expect(text, code).toBeTypeOf('string');
      expect(text.length, code).toBeGreaterThan(20);
    }
  });
});

it.each(['draft', 'leave-open'])('reports divergence without cleanup or recovery for %s delivery', async prCompletion => {
  existsSync.mockReturnValue(true);
  listWorktrees.mockResolvedValue([{ path: WORKTREE, branch: BRANCH }]);
  const result = await run({ task: task({ prCompletion }) });
  expect(result.verified).toBe(false);
  expect(result.issues.length).toBeGreaterThan(0);
  expect(result.recoveryTaskId).toBeNull();
  expect(addTask).not.toHaveBeenCalled();
  expect(cleanupMerged).not.toHaveBeenCalled();
});

describe('claim-swarm completion', () => {
  it.each(['released', 'pathless-hold', 'still-bound', 'seeded', 'ref-present', 'foreign-capture'])('settles only artifact-free released selections: %s', async scenario => {
    const selected = 'claim/issue-10';
    const delivered = 'claim/issue-11';
    const captured = { version: 1, agentId: 'agent-1', startedAt: CREATED_AT, capturedAt: CREATED_AT,
      repoPath: scenario === 'foreign-capture' ? '/foreign' : '/repo', branch: delivered, path: WORKTREE, head: HEAD,
      incarnation: { pointer: { dev: '1', ino: '2', birthtimeNs: '3' } } };
    const state = { ...agentState({ isWorktree: false, worktreeBranch: null, workspacePath: '/repo',
      claimBranches: scenario === 'still-bound' ? [selected, delivered] : [delivered],
      claimReleasedBranches: [selected], checkoutCapture: { status: 'captured' }, completedCheckouts: [captured],
      checkoutSeeds: scenario === 'seeded' ? [{ branch: selected }] : [],
      cleanupOutcomes: scenario === 'pathless-hold' ? { old: { branch: selected, status: 'blocked', reason: 'claim-owner-active' } } : {} }),
      id: 'agent-1', taskId: 'task-1', status: 'completed', completedAt: CREATED_AT };
    if (scenario === 'ref-present') readLocalBranchPresence.mockResolvedValue(true);
    findPullRequestForBranch.mockImplementation(async branch => branch === delivered
      ? { status: 'found', url: 'https://github.com/example/repo/pull/11', detail: 'MERGED' }
      : { status: 'none', url: null, detail: null });
    const result = await run({ agentState: state });
    expect(result.verified).toBe(['released', 'pathless-hold'].includes(scenario));
    const released = recordCleanupOutcome.mock.calls.some(([, row]) => row.branch === selected
      && row.reason === 'released-selection-no-local-artifacts');
    expect(released).toBe(['released', 'pathless-hold'].includes(scenario));
    expect(retireInventoriedCheckout).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  it('retains each missing claim checkout without spawning bookkeeping agents', async () => {
    const branches = ['claim/issue-11', 'claim/issue-12'];
    findPullRequestForBranch.mockImplementation(async branch => ({ status: 'found', detail: 'OPEN', number: branches.indexOf(branch) + 11,
      url: `https://github.com/example/repo/pull/${branches.indexOf(branch) + 11}` }));
    const state = agentState({ isWorktree: false, worktreeBranch: null, workspacePath: '/repo', claimPicksOwnBranch: true,
      claimBranches: [branches[0]], claimReleasedBranches: branches });
    const result = await run({ agentState: state });
    expect(result.branches.map(item => item.branch)).toEqual(branches);
    expect(addTask).not.toHaveBeenCalled();
    for (const branch of branches) expect(recordCleanupOutcome).toHaveBeenCalledWith('agent-1', expect.objectContaining({ branch, status: 'blocked' }));
    expect(cleanupMerged).not.toHaveBeenCalled();
  });
  // #12769: "Cleanup blocked: claim-owner-ambiguous" named no run, so nobody
  // could tell which live run to look at.
  it('names the live runs that keep a swarm checkout ambiguous', async () => {
    const pending = (id) => ({ id, status: 'running', workspacePath: '/repo',
      metadata: { sourceWorkspace: '/repo', claimBranch: `claim/issue-${id.length}`, claimPicksOwnBranch: false, claimSelectionPending: true } });
    readClaimOwnershipAgents.mockResolvedValue([pending('agent-a'), pending('agent-bb'),
      { id: 'agent-done', status: 'completed', metadata: { sourceWorkspace: '/repo', claimSelectionPending: true } }]);
    const state = agentState({ isWorktree: false, worktreeBranch: null, workspacePath: '/repo', claimPicksOwnBranch: true,
      claimBranches: ['claim/issue-11'] });
    await run({ agentState: state });
    expect(recordCleanupOutcome).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      branch: 'claim/issue-11', status: 'blocked', reason: 'claim-owner-ambiguous', owners: ['agent-a', 'agent-bb'] }));
  });
  it('scans claim holds for a completed claim checkout, not an unrelated worktree', async () => {
    const events = new EventEmitter();
    const unbind = bindCompletionRetirementEvents(events);
    try {
      await events.listeners('agent:completed')[0]({ id: 'unrelated', metadata: { isWorktree: true,
        workspacePath: '/repo/data/cos/worktrees/agent-unrelated', worktreeBranch: 'cos/task/unrelated' } });
      expect(readBranchCompletionPolicies).not.toHaveBeenCalled();
      await events.listeners('agent:completed')[0]({ id: 'claim-owner', metadata: { isWorktree: true,
        workspacePath: '/repo/data/cos/worktrees/claim-example', worktreeBranch: 'claim/issue-11' } });
    } finally { unbind(); }
    expect(readBranchCompletionPolicies).toHaveBeenCalledOnce();
  });
  it.each(['bound-elsewhere', 'bound-here', 'completed', 'pending-only-completed', 'racing-bind'])('rechecks the recorded hold when its picker changes ownership: %s', async scenario => {
    const branch = 'claim/issue-11';
    const capture = { version: 1, agentId: 'agent-1', startedAt: CREATED_AT, capturedAt: CREATED_AT,
      repoPath: '/repo', branch, path: WORKTREE, head: HEAD,
      incarnation: { pointer: { dev: '1', ino: '2', birthtimeNs: '3' } } };
    const state = { ...agentState({ isWorktree: false, worktreeBranch: null, workspacePath: '/repo',
      claimBranches: [branch], completedCheckouts: [capture], checkoutCapture: { status: 'captured' },
      repoStateVerification: { status: 'pending' }, completionCleanup: { status: 'completed' } }),
    id: 'agent-1', taskId: 'task-1', status: 'completed', completedAt: CREATED_AT, result: { success: false, cleanupPending: true } };
    const owner = { id: 'picker', status: 'running', workspacePath: '/repo', metadata:
      scenario === 'pending-only-completed' ? { claimSelectionPending: true } : { claimPicksOwnBranch: true } };
    const pendingTask = { ...task(), status: 'in_progress', metadata: { ...task().metadata,
      deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: state.id } };
    getTaskById.mockResolvedValue(pendingTask);
    getAgentRecord.mockResolvedValue(state);
    readBranchCompletionPolicies.mockResolvedValue([state]);
    readClaimOwnershipAgents.mockImplementation(async () => [owner]);
    recordCleanupOutcome.mockImplementation(async (_id, row) => {
      state.metadata.cleanupOutcomes = { [row.branch]: row };
      return true;
    });
    listWorktrees.mockResolvedValue([{ ...RELEASE, branch }]);
    readCompletedCheckoutIdentity.mockResolvedValue(capture);
    recordBranchReconcileOutcome.mockImplementation(async (_app, input) => ({
      retirementObligations: input.retirementObligations?.map(row => ({ ...row, createdAt: CREATED_AT })) || [],
    }));
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://github.com/example/repo/pull/11', detail: 'MERGED' });
    prepareInventoriedCheckoutRetirement.mockResolvedValue({ ok: true, review: { digest: 'a'.repeat(64),
      forge: { prHead: HEAD }, comparison: { disposition: 'integrated', localPatch: '', difference: '' } } });
    existsSync.mockReturnValue(true);
    localBranch(true);
    const events = new EventEmitter();
    const unbind = bindCompletionRetirementEvents(events);
    try {
      let releaseOwnerRead;
      let readStarted;
      const entered = new Promise(resolve => { readStarted = resolve; });
      if (scenario === 'racing-bind') readClaimOwnershipAgents.mockImplementationOnce(() => {
        readStarted();
        return new Promise(resolve => { releaseOwnerRead = resolve; });
      });
      const initial = run({ agentState: state, task: pendingTask, success: false });
      if (scenario === 'racing-bind') await entered;
      else {
        expect((await initial).branches[0].skipReason).toBe('claim-owner-ambiguous');
        expect(state.metadata.cleanupOutcomes[branch].owners).toEqual(['picker']);
        expect(state.metadata.cleanupOutcomes[branch].path).toBe(WORKTREE);
      }
      const previousOwner = structuredClone(owner);
      if (scenario === 'completed' || scenario === 'pending-only-completed') owner.status = 'completed';
      else owner.metadata.claimBranches = [scenario === 'bound-here' ? branch : 'claim/issue-12'];
      const completed = scenario === 'completed' || scenario === 'pending-only-completed';
      const event = completed ? 'agent:completed' : 'claim:ownership-changed';
      const wake = events.listeners(event)[0](completed ? owner : { agentId: owner.id });
      if (scenario === 'racing-bind') {
        releaseOwnerRead([previousOwner]);
        expect((await initial).branches[0].skipReason).toBe('claim-owner-ambiguous');
      }
      await wake;
    } finally { unbind(); }
    if (scenario === 'bound-here') {
      expect(state.metadata.cleanupOutcomes[branch]).toMatchObject({ status: 'blocked', reason: 'claim-owner-active', owners: ['picker'] });
      expect(retireInventoriedCheckout).not.toHaveBeenCalled();
      expect(updateTask).not.toHaveBeenCalled();
    } else {
      expect(state.metadata.cleanupOutcomes[branch]).toMatchObject({ status: 'verified', reason: 'retirement-receipt-verified' });
      expect(retireInventoriedCheckout).toHaveBeenCalledOnce();
      expect(updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'completed' }), expect.anything(), expect.anything());
    }
  });
  it('does not infer branches from output or override manual handoffs and failed retries', async () => {
    const state = agentState({ isWorktree: false, worktreeBranch: null, claimPicksOwnBranch: true, claimBranches: ['claim/issue-11'] });
    findPullRequestForBranch.mockResolvedValue({ status: 'found', detail: 'OPEN', url: 'https://github.com/example/repo/pull/11' });
    await run({ agentState: state, task: task({ prCompletion: 'leave-open' }) });
    await run({ agentState: state, success: false });
    await run({ agentState: { ...state, metadata: { ...state.metadata, claimBranches: [] }, output: 'claim/issue-22' } });
    expect(addTask).not.toHaveBeenCalled();
    expect(cleanupMerged).not.toHaveBeenCalled();
  });
});


describe('durable completion replay', () => {
  it('filters ineligible receipts before the replay bound and continues after a receipt write fails', async () => {
    const receipt = id => ({ id, status: 'completed', result: { success: false, executionSuccess: true,
      cleanupPending: true, deliveryRecoveryOwned: true,
      taskOutcome: { status: 'incomplete', recovery: { mode: 'cleanup' } } },
    metadata: { checkoutCapture: { status: 'captured' }, repoStateVerification: { status: 'completed' },
      cleanupOutcome: { status: 'verified', unresolved: 0, committedIntegrationVerified: true },
      completionCleanup: { version: 1, status: 'completed', stages: Object.fromEntries(
        ['sentinel', 'jira', 'notification', 'pipeline', 'creative', 'report', 'worktree'].map(key => [key, { status: 'done' }])) } } });
    const ineligible = Array.from({ length: 12 }, (_, index) => {
      const row = receipt(`ineligible-${index}`);
      if (index % 3 === 0) row.result.executionSuccess = false;
      if (index % 3 === 1) row.metadata.cleanupOutcome.unresolved = 1;
      if (index % 3 === 2) row.metadata.completionCleanup.stages.worktree.status = 'held';
      return row;
    });
    const settled = receipt('settled-run-projection');
    settled.result.deferredDeliveryOutcome = settled.result.taskOutcome;
    settled.result.taskOutcome = { status: 'completed' };
    settled.result.success = true;
    settled.result.cleanupPending = false;
    const tracking = await import('./agentRunTracking.js');
    const needsRun = vi.spyOn(tracking, 'agentRunDeliveryNeedsReconciliation')
      .mockImplementation(async agent => agent.id === settled.id);
    const alreadyRepaired = Array.from({ length: 12 }, (_, index) => ({ ...settled, id: `repaired-${index}` }));
    readBranchCompletionPolicies.mockResolvedValue([...ineligible, receipt('write-failed'), receipt('settle-next'), ...alreadyRepaired, settled]);
    recordRepoStateVerification.mockRejectedValueOnce(new Error('fixture receipt write failed'));
    expect(await sweepRepoStateVerifications()).toMatchObject({ checked: 0 });
    expect(recordRepoStateVerification.mock.calls).toEqual([
      ['write-failed', { status: 'completed' }], ['settle-next', { status: 'completed' }],
      ['settled-run-projection', { status: 'completed' }],
    ]);
    expect(needsRun).toHaveBeenCalledTimes(13);
    needsRun.mockRestore();
    expect(emitLog).toHaveBeenCalledWith('warn', expect.stringContaining('Deferred delivery settlement retained'));
    expect(addTask).not.toHaveBeenCalled();
  });

  it.each(['absent', 'present', 'registered', 'ref-present', 'unreadable', 'human-hold'])('repairs only proven absent released-selection ledger rows after restart: %s', async scenario => {
    const branch = 'claim/issue-10';
    const path = '/repo/wt/released-selection';
    const state = { ...agentState({ isWorktree: false, sourceWorkspace: '/repo', claimBranches: ['claim/issue-11'],
      claimReleasedBranches: [branch], repoStateVerification: { status: 'completed' },
      completionCleanup: { status: 'completed', replayAttempts: 5 }, cleanupOutcomes: {
        released: { branch, status: 'verified', reason: 'released-selection-no-local-artifacts' },
        old: { branch, path, status: 'blocked', reason: scenario === 'human-hold' ? 'operator-hold' : 'absent-checkout-integration-unverified' },
      } }), id: 'agent-1', taskId: 'task-1', status: 'completed' };
    readBranchCompletionPolicies.mockResolvedValue([state]);
    if (scenario === 'present') readCheckoutPathPresence.mockResolvedValue(true);
    if (scenario === 'registered') listWorktrees.mockResolvedValue([{ path, branch: 'some-other-branch' }]);
    if (scenario === 'ref-present') readLocalBranchPresence.mockResolvedValue(true);
    if (scenario === 'unreadable') readCheckoutPathPresence.mockResolvedValue(null);
    expect(await sweepRepoStateVerifications()).toMatchObject({ checked: 0 });
    if (scenario === 'absent') expect(recordCleanupOutcome).toHaveBeenCalledWith('agent-1', {
      branch, path, status: 'verified', reason: 'released-selection-no-local-artifacts',
    });
    else expect(recordCleanupOutcome).not.toHaveBeenCalled();
    expect(recordRepoStateVerification).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    expect(replayAgentCompletionCleanup).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
    expect(retireInventoriedCheckout).not.toHaveBeenCalled();
  });

  it('continues pending completion audits when an obsolete ledger write fails', async () => {
    const branch = 'claim/issue-10';
    const legacy = { ...agentState({ isWorktree: false, claimBranches: [], claimReleasedBranches: [branch],
      repoStateVerification: { status: 'completed' }, cleanupOutcomes: {
        released: { branch, status: 'verified', reason: 'released-selection-no-local-artifacts' },
        old: { branch, path: '/repo/wt/released', status: 'blocked', reason: 'absent-checkout-integration-unverified' },
      } }), id: 'agent-legacy', status: 'completed' };
    readBranchCompletionPolicies.mockResolvedValue([legacy, archived()]);
    recordCleanupOutcome.mockRejectedValueOnce(new Error('fixture ledger write failed'));
    getTaskById.mockResolvedValue(task());
    findPullRequestForBranch.mockResolvedValue({ status: 'found', detail: 'MERGED', url: 'https://github.com/example/repo/pull/7' });
    expect(await sweepRepoStateVerifications()).toMatchObject({ checked: 1 });
    expect(recordRepoStateVerification).toHaveBeenCalledWith('agent-1', expect.objectContaining({ status: 'completed' }));
    expect(emitLog).toHaveBeenCalledWith('warn', expect.stringContaining('Released-selection ledger repair deferred'));
    expect(addTask).not.toHaveBeenCalled();
  });

  const archived = () => ({ ...agentState(), id: 'agent-1', taskId: 'task-1', status: 'completed', result: { success: true },
    metadata: { ...agentState().metadata, repoStateVerification: { status: 'pending' } } });
  it('resumes a persisted pending audit after restart and settles clean completion', async () => {
    readBranchCompletionPolicies.mockResolvedValue([archived()]);
    getTaskById.mockResolvedValue(task());
    findPullRequestForBranch.mockResolvedValue({ status: 'found', detail: 'MERGED', url: 'https://github.com/example/repo/pull/7' });
    expect(await sweepRepoStateVerifications()).toMatchObject({ checked: 1 });
    expect(recordRepoStateVerification).toHaveBeenCalledWith('agent-1', expect.objectContaining({ status: 'completed' }));
    expect(addTask).not.toHaveBeenCalled();
  });
  it('retains a failed publication outbox while continuing unrelated completion recovery', async () => {
    recoverReleaseSynchronizationHandoffs.mockRejectedValueOnce(new Error('synthetic malformed outbox'));
    readBranchCompletionPolicies.mockResolvedValue([archived()]);
    getTaskById.mockResolvedValue(task());
    findPullRequestForBranch.mockResolvedValue({ status: 'found', detail: 'MERGED', url: 'https://github.com/example/repo/pull/7' });
    expect(await sweepRepoStateVerifications()).toMatchObject({ checked: 1 });
    expect(recordRepoStateVerification).toHaveBeenCalledWith('agent-1', expect.objectContaining({ status: 'completed' }));
    expect(emitLog).toHaveBeenCalledWith('warn', expect.stringContaining('Release synchronization handoffs retained'));
  });
  it('backs off repeated machine recovery across restarts without creating tasks', async () => {
    const prior = archived();
    prior.metadata.completionCleanup = { replayAttempts: 5, retryAt: new Date(Date.now() + 60_000).toISOString() };
    readBranchCompletionPolicies.mockResolvedValue([prior]);
    expect(await sweepRepoStateVerifications()).toMatchObject({ checked: 0 });
    prior.metadata.completionCleanup.retryAt = new Date(Date.now() - 1).toISOString();
    getTaskById.mockResolvedValue(task());
    expect(await sweepRepoStateVerifications()).toMatchObject({ checked: 1 });
    const { recordCompletionCleanup } = await import('./cosAgentLifecycle.js');
    expect(recordCompletionCleanup).toHaveBeenCalledWith('agent-1', prior.startedAt, expect.objectContaining({ replayAttempts: 6, retryAt: expect.any(String) }));
    expect(addTask).not.toHaveBeenCalled();
  });

  it('rechecks an ownership hold once after restart even when its prior retry is backed off', async () => {
    const prior = archived();
    prior.metadata.repoStateVerification.reasons = ['claim-owner-ambiguous'];
    prior.metadata.completionCleanup = { status: 'completed', replayAttempts: 5, retryAt: new Date(Date.now() + 60_000).toISOString() };
    readBranchCompletionPolicies.mockResolvedValue([prior]);
    getTaskById.mockResolvedValue(task());
    expect(await sweepRepoStateVerifications()).toMatchObject({ checked: 0 });
    expect(await resumeDeferredRepoStateVerifications(async () => null)).toMatchObject({ checked: 1, pendingAtStart: 1 });
    expect(recordCompletionCleanup).toHaveBeenCalledWith('agent-1', prior.startedAt, expect.objectContaining({ replayAttempts: 6 }));
    expect(retireInventoriedCheckout).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  it('keeps missing policy pending with an updated retry time rather than granting authority or starving other audits', async () => {
    getTaskById.mockResolvedValue(null);
    readBranchCompletionPolicies.mockResolvedValue([archived()]);
    await sweepRepoStateVerifications();
    expect(recordRepoStateVerification).toHaveBeenCalledWith('agent-1', expect.objectContaining({ status: 'pending', reasons: ['task-unavailable'], checkedAt: expect.any(String) }));
    expect(addTask).not.toHaveBeenCalled();
  });
  it('replays only unissued swarm-cleanup continuations after restart', async () => {
    const swarm = (id, continuationIssued) => ({ id, taskId: `task-${id}`, status: 'completed', result: { success: true },
      metadata: { swarmCleanupDelivery: { version: 1, continuationIssued } } });
    const rows = [swarm('swarm-due', false), swarm('swarm-issued', true)];
    readBranchCompletionPolicies.mockResolvedValue(rows);
    getAgentRecord.mockImplementation(async id => rows.find(row => row.id === id) || null);
    const contract = await import('./swarmCleanupDelivery.js');
    const matches = vi.spyOn(contract, 'cleanupRefillSourceMatches').mockReturnValue(true);
    const emitted = vi.spyOn(cosEvents, 'emit');
    try {
      expect(await sweepRepoStateVerifications()).toMatchObject({ checked: 0 });
      expect(recordSwarmCleanupContinuationAttempt.mock.calls).toEqual([['swarm-due']]);
      expect(emitted).toHaveBeenCalledWith('swarm:cleanup-delivery-verified', { agentId: 'swarm-due' });
      expect(emitted).not.toHaveBeenCalledWith('swarm:cleanup-delivery-verified', { agentId: 'swarm-issued' });
    } finally { emitted.mockRestore(); matches.mockRestore(); }
  });

  it('acknowledges refill fences only for issued continuations whose admission settled', async () => {
    const issued = id => ({ id, status: 'completed', result: { success: true },
      metadata: { swarmCleanupDelivery: { version: 1, continuationIssued: true } } });
    readBranchCompletionPolicies.mockResolvedValue([issued('unmarked'), issued('preparing'), issued('admitted'), issued('unknown-handoff'),
      { id: 'not-issued', status: 'completed', result: { success: true }, metadata: {} }]);
    loadSchedule.mockResolvedValue({
      swarmCleanupRefillPending: { unmarked: { id: 'h1', sourceMarked: false }, preparing: { id: 'h2', sourceMarked: true },
        admitted: { id: 'h3', sourceMarked: true }, 'unknown-handoff': { id: 'h4', sourceMarked: true },
        'not-issued': { id: 'h5', sourceMarked: false } },
      onDemandHandoffs: { h2: { status: 'preparing' }, h3: { status: 'admitted' } },
    });
    await sweepRepoStateVerifications();
    expect(acknowledgeSwarmCleanupRefill.mock.calls).toEqual([['unmarked'], ['admitted']]);
  });

  it('bounds deferred delivery settlements to one recovery batch per sweep', async () => {
    const receipt = id => ({ id, status: 'completed', result: { success: false, executionSuccess: true,
      cleanupPending: true, deliveryRecoveryOwned: true,
      taskOutcome: { status: 'incomplete', recovery: { mode: 'cleanup' } } },
    metadata: { checkoutCapture: { status: 'captured' }, repoStateVerification: { status: 'completed' },
      cleanupOutcome: { status: 'verified', unresolved: 0, committedIntegrationVerified: true },
      completionCleanup: { version: 1, status: 'completed', stages: Object.fromEntries(
        ['sentinel', 'jira', 'notification', 'pipeline', 'creative', 'report', 'worktree'].map(key => [key, { status: 'done' }])) } } });
    readBranchCompletionPolicies.mockResolvedValue(Array.from({ length: 12 }, (_, index) => receipt(`receipt-${index}`)));
    await sweepRepoStateVerifications();
    expect(recordRepoStateVerification).toHaveBeenCalledTimes(10);
  });

  it('skips a backed-off audit on recheck unless a claim owner holds it', async () => {
    const prior = archived();
    prior.metadata.repoStateVerification.reasons = ['task-unavailable'];
    prior.metadata.completionCleanup = { replayAttempts: 5, retryAt: new Date(Date.now() + 60_000).toISOString() };
    readBranchCompletionPolicies.mockResolvedValue([prior]);
    expect(await resumeDeferredRepoStateVerifications(async () => null)).toMatchObject({ checked: 0, pendingAtStart: 0 });
    expect(recordCompletionCleanup).not.toHaveBeenCalled();
  });

  it('records a physically verified retirement and does not count or replay the settled run', async () => {
    const fresh = archived();
    fresh.metadata.completionCleanup = { status: 'completed' };
    fresh.metadata.checkoutCapture = { status: 'retired' };
    fresh.metadata.repoStateVerification = { status: 'pending', physicalRetirementVerified: true };
    readBranchCompletionPolicies.mockResolvedValue([archived()]);
    getAgentRecord.mockResolvedValue(fresh);
    recordRepoStateVerification.mockImplementation(async (_id, verification) => {
      fresh.metadata.repoStateVerification = { ...verification, status: 'completed' };
      return true;
    });
    expect(await sweepRepoStateVerifications()).toMatchObject({ checked: 0, pendingAtStart: 1 });
    expect(recordRepoStateVerification).toHaveBeenCalledWith('agent-1', { status: 'pending', physicalRetirementVerified: true });
    expect(recordCompletionCleanup).not.toHaveBeenCalled();
    expect(replayAgentCompletionCleanup).not.toHaveBeenCalled();
  });

  it.each([[undefined, 60_000], [9, 30 * 60_000]])('backs off replay attempt after %s prior attempts by %i ms', async (replayAttempts, delay) => {
    const prior = archived();
    if (replayAttempts !== undefined) prior.metadata.completionCleanup = { replayAttempts };
    readBranchCompletionPolicies.mockResolvedValue([prior]);
    getTaskById.mockResolvedValue(task());
    await sweepRepoStateVerifications();
    const [, , attempt] = recordCompletionCleanup.mock.calls.find(([, , patch]) => patch.retryAt);
    const waited = Date.parse(attempt.retryAt) - Date.parse(attempt.lastAttemptAt);
    expect(waited).toBeGreaterThanOrEqual(delay);
    expect(waited).toBeLessThan(delay + 1_000);
  });

  it('replays completion cleanup before and after re-verifying a pending audit', async () => {
    const fresh = archived();
    readBranchCompletionPolicies.mockResolvedValue([archived()]);
    getAgentRecord.mockResolvedValue(fresh);
    getTaskById.mockResolvedValue(task());
    findPullRequestForBranch.mockResolvedValue({ status: 'found', detail: 'MERGED', url: 'https://github.com/example/repo/pull/7' });
    expect(await sweepRepoStateVerifications()).toMatchObject({ checked: 1 });
    expect(replayAgentCompletionCleanup).toHaveBeenCalledTimes(2);
    const verified = recordRepoStateVerification.mock.invocationCallOrder.at(-1);
    expect(replayAgentCompletionCleanup.mock.invocationCallOrder[0]).toBeLessThan(verified);
    expect(replayAgentCompletionCleanup.mock.invocationCallOrder[1]).toBeGreaterThan(verified);
  });

  // An unreadable task store is not proof the task is gone, so only a definite
  // absence may replay the released-completion retirement and keep its reason.
  it.each([['unreadable', 'task-unavailable'], ['absent', 'original-result-preserved']])('records why a taskless pending audit stays pending: %s task', async (scenario, expected) => {
    const prior = archived();
    prior.result = { ...prior.result, cleanupPending: true };
    prior.metadata.repoStateVerification = { status: 'completed' };
    prior.metadata.completionCleanup = { status: 'pending' };
    readBranchCompletionPolicies.mockResolvedValue([prior]);
    getAgentRecord.mockResolvedValue(prior);
    getTaskById.mockResolvedValue(null);
    // Only the sweep's own read fails; a later read must not rescue the audit.
    if (scenario === 'unreadable') getTaskById.mockRejectedValueOnce(new Error('fixture task store unreadable'));
    expect(await sweepRepoStateVerifications()).toMatchObject({ checked: 1 });
    const pending = recordRepoStateVerification.mock.calls.find(([id, verification]) => id === 'agent-1' && verification.status === 'pending');
    expect(pending?.[1].reasons).toEqual([expected]);
  });

  it('uses the exact successor result without creating an unrelated generic recovery task', async () => {
    localBranch(true);
    execGh.mockResolvedValue(openView({ number: 7, mergeable: 'CONFLICTING' }));
    findPullRequestForBranch.mockResolvedValue({ status: 'found', detail: 'OPEN', url: 'https://github.com/example/repo/pull/7' });
    inspectOrQueueCompletedReview.mockResolvedValue({ disposition: 'join-existing', reason: 'review-successor-exists', taskId: 'existing' });
    expect(await run()).toMatchObject({ skipReason: 'review-successor-exists' });
    expect(addTask).not.toHaveBeenCalled();
    expect(recordRepoStateRecovery).not.toHaveBeenCalled();
  });
});


describe('completion after its originating task was removed', () => {
  const fixture = () => {
    const original = { ...task(), taskType: 'user', metadata: { ...task().metadata,
      claimedBy: 'dispatcher', claimedAt: CREATED_AT, lastSpawnedAt: CREATED_AT, totalSpawnCount: 1 } };
    const captured = { version: 1, agentId: 'agent-1', repoPath: '/repo', branch: BRANCH, path: WORKTREE,
      head: HEAD, startedAt: CREATED_AT, capturedAt: CREATED_AT,
      incarnation: { pointer: { dev: '1', ino: '2', birthtimeNs: '3' } } };
    const state = { ...agentState({ instanceId: 'fixture-local', completedCheckouts: [captured],
      reviewLoopMergeTarget: { url: 'https://github.com/example/repo/pull/7' },
      repoStateVerification: { status: 'pending' },
      completionTaskDispatch: { taskId: 'task-1', taskType: 'user', expected:
        ['claimedBy', 'claimedAt', 'lastSpawnedAt', 'totalSpawnCount'].map(key => [key, original.metadata[key]]) },
      completionCleanup: { version: 1, status: 'pending', replay: { version: 1, kind: 'replay', bytes: 123, sha256: 'a'.repeat(64) } }
    }), id: 'agent-1', taskId: 'task-1', status: 'completed', completedAt: CREATED_AT,
      result: { success: false, executionSuccess: true, cleanupPending: true } };
    getTaskById.mockResolvedValue(null);
    getAgentRecord.mockResolvedValue(state);
    readCompletionData.mockResolvedValue({ task: original });
    localBranch(false);
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://github.com/example/repo/pull/7',
      detail: { state: 'MERGED', number: 7 } });
    settleAbsentTaskCompletion.mockResolvedValue(true);
    return { state, original, captured };
  };

  it('verifies the exact retired run immediately without recreating the task or replaying external handoffs', async () => {
    const { state } = fixture();
    const result = await resumeAgentCompletionRetirement('agent-1');
    expect(result).toMatchObject({ verified: true });
    expect(settleAbsentTaskCompletion).toHaveBeenCalledWith('agent-1', state);
    expect(state.result).toEqual({ success: false, executionSuccess: true, cleanupPending: true });
    expect(updateTask).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
    expect(replayAgentCompletionCleanup).not.toHaveBeenCalled();
    expect(retireInventoriedCheckout).not.toHaveBeenCalled();
  });

  it.each(['merged', 'open', 'missing', 'missing-unintegrated', 'unreadable', 'unreadable-integration'])('restores the exact removed task PR expectation without a saved URL: %s', async mode => {
    const { state, original } = fixture();
    delete state.metadata.reviewLoopMergeTarget;
    original.metadata.prCompletion = 'review-then-merge';
    findPullRequestForBranch.mockResolvedValue(mode === 'unreadable' ? { status: 'unavailable' }
      : mode.startsWith('missing') ? { status: 'none' }
        : { status: 'found', url: 'https://github.com/example/repo/pull/7', detail: mode === 'open' ? 'OPEN' : 'MERGED' });
    if (mode === 'unreadable-integration') readRetirementForgeEvidence.mockRejectedValue(new Error('forge unavailable'));
    // A no-change run never opens a PR; its captured head already in the
    // default branch is the delivery proof. Unique local commits are not.
    if (mode === 'missing-unintegrated') execGit.mockImplementation(async args => ({ exitCode: args[0] === 'merge-base' ? 1 : 0, stdout: '', stderr: '' }));
    const result = await resumeAgentCompletionRetirement('agent-1');
    expect(findPullRequestForBranch).toHaveBeenCalledWith(BRANCH, expect.objectContaining({ cwd: '/repo' }));
    const settles = mode === 'merged' || mode === 'missing';
    expect(result.verified).toBe(settles);
    if (settles) expect(settleAbsentTaskCompletion).toHaveBeenCalledWith('agent-1', state);
    else expect(settleAbsentTaskCompletion).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
    expect(replayAgentCompletionCleanup).not.toHaveBeenCalled();
    expect(retireInventoriedCheckout).not.toHaveBeenCalled();
  });

  it.each(['verified', 'unreadable-task', 'ambiguous-replay'])('sweeps a removed originating task through the existing absence proof: %s', async mode => {
    const { state } = fixture();
    readBranchCompletionPolicies.mockResolvedValue([state]);
    if (mode === 'unreadable-task') getTaskById.mockRejectedValue(new Error('task read unavailable'));
    if (mode === 'ambiguous-replay') readCompletionData.mockRejectedValue(new Error('completion-data-changed'));
    await sweepRepoStateVerifications();
    if (mode === 'verified') {
      expect(settleAbsentTaskCompletion).toHaveBeenCalledWith('agent-1', state);
      expect(recordRepoStateVerification.mock.calls.some(([, value]) => value.reasons?.includes('task-unavailable'))).toBe(false);
    } else {
      expect(settleAbsentTaskCompletion).not.toHaveBeenCalled();
      expect(recordRepoStateVerification).toHaveBeenCalledWith('agent-1', expect.objectContaining({ status: 'pending' }));
    }
    expect(replayAgentCompletionCleanup).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    expect(retireInventoriedCheckout).not.toHaveBeenCalled();
  });

  it.each(['verified', 'other-dispatch', 'other-run', 'duplicate-dispatch', 'missing-handoff', 'missing-replay', 'surviving-checkout'])('settles a pre-dispatch replay only through its exact durable handoff: %s', async mode => {
    const { state, original } = fixture();
    state.metadata.completionCleanup.taskHandoff = { version: 1, taskId: state.taskId,
      taskType: 'user', startedAt: state.startedAt,
      expected: state.metadata.completionTaskDispatch.expected.map(([key, value]) =>
        [key, key === 'totalSpawnCount' ? String(value) : value]) };
    readCompletionData.mockResolvedValue({ task: { ...original, metadata: {
      ...original.metadata, claimedAt: 'earlier-lease', lastSpawnedAt: undefined, totalSpawnCount: undefined } } });
    if (mode === 'other-dispatch') state.metadata.completionCleanup.taskHandoff.expected[1][1] = 'another-dispatch';
    if (mode === 'other-run') state.metadata.completionCleanup.taskHandoff.startedAt = 'another-run';
    if (mode === 'duplicate-dispatch') state.metadata.completionCleanup.taskHandoff.expected.push(['claimedAt', CREATED_AT]);
    if (mode === 'missing-handoff') delete state.metadata.completionCleanup.taskHandoff;
    if (mode === 'missing-replay') readCompletionData.mockRejectedValue(new Error('completion-data-changed'));
    if (mode === 'surviving-checkout') readCheckoutPathPresence.mockResolvedValue(true);
    const result = await resumeAgentCompletionRetirement('agent-1');
    expect(result.verified).toBe(mode === 'verified');
    if (mode === 'verified') expect(settleAbsentTaskCompletion).toHaveBeenCalledWith('agent-1', state);
    else expect(settleAbsentTaskCompletion).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
    expect(replayAgentCompletionCleanup).not.toHaveBeenCalled();
    expect(retireInventoriedCheckout).not.toHaveBeenCalled();
  });

  it('keeps merged absent work pending when its completion settlement races', async () => {
    fixture();
    settleAbsentTaskCompletion.mockResolvedValue(false);
    expect(await resumeAgentCompletionRetirement('agent-1')).toMatchObject({ verified: false,
      skipReason: 'cleanup-receipt-settlement-unverified' });
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('does not settle another instance, ambiguous captures or a corrupt immutable replay', async () => {
    for (const kind of ['instance', 'capture', 'replay', 'dispatch']) {
      const { state, captured } = fixture();
      if (kind === 'instance') state.metadata.instanceId = 'another-install';
      if (kind === 'capture') state.metadata.completedCheckouts.push({ ...captured, head: 'f'.repeat(40) });
      if (kind === 'dispatch') state.metadata.completionTaskDispatch.expected = [];
      if (kind === 'replay') readCompletionData.mockRejectedValue(new Error('completion-data-changed'));
      expect(await resumeAgentCompletionRetirement('agent-1')).toMatchObject({ verified: false,
        skipReason: 'cleanup-task-unavailable' });
    }
    expect(settleAbsentTaskCompletion).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  it('never removes a surviving checkout using a deleted task snapshot', async () => {
    fixture();
    readCheckoutPathPresence.mockResolvedValue(true);
    expect(await resumeAgentCompletionRetirement('agent-1')).toMatchObject({ verified: false });
    expect(retireInventoriedCheckout).not.toHaveBeenCalled();
    expect(inspectOrQueueCompletedReview).not.toHaveBeenCalled();
    expect(settleAbsentTaskCompletion).not.toHaveBeenCalled();
  });
});

/** A cleanup transfer must not strand the only physical captures on an older
 * coordinator, or spend another dispatch merely to find them again. */
describe('historical captured swarm reconciliation', () => {
  function episode({ parked = true } = {}) {
    const outcome = { status: 'incomplete', recovery: { mode: 'cleanup' } };
    const branches = ['claim/issue-41', 'claim/issue-42', 'claim/issue-43'];
    const scope = { id: 'historical-task', taskType: 'internal', description: 'Complete selected claims', priority: 'MEDIUM',
      metadata: { app: 'demo-app', analysisType: 'claim-issue', claimFlow: true, swarmCount: 3, prCompletion: 'merge-on-green' } };
    const agents = [0, 1, 2].map(index => {
      const id = `historical-${index}`, start = `2026-01-01T00:0${index * 2}:00.000Z`;
      const expected = [['claimedBy', 'fixture-local'], ['claimedAt', start], ['lastSpawnedAt', start], ['totalSpawnCount', index + 1]];
      return { id, taskId: scope.id, status: 'completed', startedAt: start, completedAt: `2026-01-01T00:0${index * 2 + 1}:00.000Z`,
        result: { success: false, executionSuccess: true, deliveryRecoveryOwned: true, cleanupPending: true, taskOutcome: outcome },
        metadata: { instanceId: 'fixture-local', taskApp: 'demo-app', taskAnalysisType: 'claim-issue', configClaimFlow: true,
          isWorktree: false, workspacePath: '/repo', claimBranches: index ? [] : branches, claimReleasedBranches: [],
          checkoutCapture: { status: 'captured' }, completedCheckouts: [],
          completionTaskDispatch: { taskId: scope.id, taskType: 'internal', expected },
          completionCleanup: { version: 1, status: 'pending', replay: { fixture: id } },
          repoStateVerification: index < 2 ? { status: 'completed', reasons: ['cleanup-transferred-to-recovery'] } : { status: 'pending' },
        } };
    });
    const source = agents[0], latest = agents[2];
    source.metadata.completedCheckouts = branches.map((branch, index) => ({ version: 1, agentId: source.id, startedAt: source.startedAt,
      capturedAt: source.completedAt, repoPath: '/repo', path: `/tree/${index}`, branch, head: HEAD,
      incarnation: { pointer: { dev: '1', ino: String(index + 2), birthtimeNs: '3' },
        gitdir: { path: `/repo/.git/worktrees/${index}`, dev: '1', ino: String(index + 5), birthtimeNs: '3' } } }));
    const currentTask = { ...scope, status: 'blocked', metadata: { ...scope.metadata,
      lastSpawnedAt: latest.startedAt, totalSpawnCount: '3', failureCount: '2', spawnFailedCount: '1',
      blockedCategory: 'task-recovery-exhausted', deliveryDecisionAgentId: latest.id,
      deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: latest.id, taskOutcome: outcome } };
    const replays = agents.map((row, index) => ({ task: { ...scope, metadata: { ...scope.metadata,
      ...(index ? Object.fromEntries(agents[index - 1].metadata.completionTaskDispatch.expected) : {}) } } }));
    getTaskById.mockImplementation(async () => structuredClone(currentTask));
    getAgentRecord.mockImplementation(async id => structuredClone(agents.find(row => row.id === id)));
    readBranchCompletionPolicies.mockImplementation(async () => structuredClone(agents));
    readCompletionData.mockImplementation(async row => structuredClone(replays[agents.findIndex(agent => agent.id === row.id)]));
    listWorktrees.mockResolvedValue(source.metadata.completedCheckouts.map(row => ({ branch: `refs/heads/${row.branch}`, path: row.path, head: row.head })));
    readCompletedCheckoutIdentity.mockImplementation(async ({ branch }) => structuredClone(source.metadata.completedCheckouts.find(row => row.branch === branch)));
    readCheckoutPathPresence.mockResolvedValue(true);
    localBranch(true);
    verifyCleanupClaimDisposition.mockResolvedValue({ status: 'verified', issues: branches.map((branch, index) => ({
      issue: 41 + index, disposition: parked && index === 2 ? 'operator-blocked' : 'merged-pr' })) });
    findPullRequestForBranch.mockImplementation(async branch => parked && branch === branches[2]
      ? { status: 'none', url: null, detail: null }
      : { status: 'found', number: 41 + branches.indexOf(branch), url: `https://github.com/example/repo/pull/${41 + branches.indexOf(branch)}`, detail: 'MERGED' });
    recordBranchReconcileOutcome.mockImplementation(async (_app, input) => ({
      retirementObligations: input.retirementObligations?.map(row => ({ ...row, createdAt: CREATED_AT })) || [],
    }));
    prepareInventoriedCheckoutRetirement.mockImplementation(async ({ release }) => ({ ok: true,
      review: { digest: 'a'.repeat(64), forge: { prHead: release.head }, comparison: { disposition: 'integrated', localPatch: '', difference: '' } } }));
    retireInventoriedCheckout.mockImplementation(async (_input, options) => {
      await options.beforeMutation();
      return { ok: true, branchDeleted: true, archiveDir: null };
    });
    recordHistoricalCleanupReconciliation.mockImplementation(async (id, _expected, patch) => {
      const row = agents.find(row => row.id === id);
      row.metadata.historicalCleanupReconciliation = { ...row.metadata.historicalCleanupReconciliation, ...patch };
      return true;
    });
    return { source, latest, agents, currentTask, replays, branches, run: () => run({ agentId: latest.id, agentState: structuredClone(latest),
      task: structuredClone(currentTask), success: false }) };
  }

  it('resumes the original generations after restart, preserves parked work and every charged outcome', async () => {
    const fixture = episode();
    const original = structuredClone(fixture.agents), taskBefore = structuredClone(fixture.currentTask);
    for (let restart = 0; restart < 2; restart++) {
      const result = await fixture.run();
      expect(result).toMatchObject({ verified: false, historicalCleanup: true, branches: [
        { branch: 'claim/issue-41', verified: true }, { branch: 'claim/issue-42', verified: true },
        { branch: 'claim/issue-43', verified: false, skipReason: 'cleanup-delivery-unverified' },
      ] });
    }
    expect(retireInventoriedCheckout).toHaveBeenCalledTimes(4);
    expect(retireInventoriedCheckout.mock.calls.every(([input]) => input.release.branch !== fixture.branches[2])).toBe(true);
    expect(fixture.agents.slice(0, 2)).toEqual(original.slice(0, 2));
    expect(fixture.latest.result).toEqual(original[2].result);
    expect(fixture.currentTask).toEqual(taskBefore);
    expect(fixture.latest.metadata.historicalCleanupReconciliation).toMatchObject({ status: 'held', sourceAgentId: fixture.source.id });
    expect(addTask).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    expect(recordCleanupOutcome).not.toHaveBeenCalled();
    expect(recordRepoStateVerification).not.toHaveBeenCalled();
  });

  it.each(['instance', 'other-task', 'duplicate-source', 'reset', 'missing-replay', 'missing-capture', 'active-owner', 'tracker', 'task-race', 'owner-race', 'generation-race'])(
    'holds unsafe historical reconciliation: %s', async scenario => {
      const f = episode();
      if (scenario === 'instance') f.source.metadata.instanceId = 'other-instance';
      if (scenario === 'other-task') f.source.taskId = 'other-task';
      if (scenario === 'duplicate-source') f.agents.push({ ...structuredClone(f.source), id: 'duplicate-source' });
      if (scenario === 'reset') f.replays[1].task.metadata.totalSpawnCount = 0;
      if (scenario === 'missing-replay') f.replays[1] = null;
      if (scenario === 'missing-capture') f.source.metadata.completedCheckouts.pop();
      if (scenario === 'active-owner') readClaimOwnershipAgents.mockResolvedValue([{ id: 'new-owner', status: 'running', taskId: f.currentTask.id }]);
      if (scenario === 'tracker') verifyCleanupClaimDisposition.mockResolvedValue({ status: 'unverified' });
      if (scenario.endsWith('-race')) prepareInventoriedCheckoutRetirement.mockImplementation(async ({ release }) => {
        if (scenario === 'task-race') f.currentTask.description = 'Operator changed scope';
        if (scenario === 'owner-race') readClaimOwnershipAgents.mockResolvedValue([{ id: 'new-owner', status: 'running', taskId: f.currentTask.id }]);
        if (scenario === 'generation-race') readCompletedCheckoutIdentity.mockResolvedValue(null);
        return { ok: true, review: { digest: 'a'.repeat(64), forge: { prHead: release.head },
          comparison: { disposition: 'integrated', localPatch: '', difference: '' } } };
      });
      const removed = vi.fn();
      retireInventoriedCheckout.mockImplementation(async (_input, options) => { await options.beforeMutation(); removed(); return { ok: true, branchDeleted: true }; });
      const result = await f.run();
      expect(result.verified).toBe(false);
      expect(removed).not.toHaveBeenCalled();
      expect(updateTask).not.toHaveBeenCalled();
      expect(addTask).not.toHaveBeenCalled();
      expect(f.latest.metadata.historicalCleanupReconciliation.status).toBe('held');
    });

  it.each(['same-epoch', 'reset-epoch'])('requires the recorded dispatch episode when one exists: %s', async scenario => {
    const f = episode();
    const epoch = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const entries = f.agents.map(row => {
      Object.assign(row.metadata.completionTaskDispatch, { spawnBudgetEpoch: epoch, spawnBudgetStartedAt: row.startedAt });
      return { agentId: row.id, startedAt: row.startedAt, ...Object.fromEntries(row.metadata.completionTaskDispatch.expected) };
    });
    f.currentTask.metadata.spawnBudgetProof = { version: 1, epoch, baseline: 0, history: entries.slice(0, -1), dispatch: entries.at(-1) };
    if (scenario === 'reset-epoch') f.currentTask.metadata.spawnBudgetProof.epoch = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const result = await f.run();
    if (scenario === 'same-epoch') expect(result.branches).toHaveLength(3);
    else expect(result.skipReason).toBe('historical-cleanup-episode-reset-or-ambiguous');
    expect(retireInventoriedCheckout).toHaveBeenCalledTimes(scenario === 'same-epoch' ? 2 : 0);
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('settles only after every branch verifies, using the latest owner and unchanged retry budgets', async () => {
    const f = episode({ parked: false });
    expect(await f.run()).toMatchObject({ verified: true, historicalCleanup: true });
    expect(retireInventoriedCheckout).toHaveBeenCalledTimes(3);
    expect(updateTask).toHaveBeenCalledWith(f.currentTask.id, expect.objectContaining({ status: 'completed' }), 'internal', {
      expectedStatus: 'blocked', expectedTask: { description: f.currentTask.description, priority: f.currentTask.priority, metadata: f.currentTask.metadata },
      recoveryOwner: { id: f.latest.id, startedAt: f.latest.startedAt, requireInactive: true }, preserveRetryBudget: true,
    });
    expect(f.latest.metadata.historicalCleanupReconciliation.status).toBe('verified');
    expect(f.agents.every(row => row.result.success === false)).toBe(true);
  });
});
