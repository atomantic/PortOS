import { retirementCheckoutIdentityFromPointer } from '../lib/retirementCheckoutObservation.js';
vi.mock('./instanceIdentity.js', () => ({ getInstanceId: vi.fn(async () => 'fixture-local'), UNKNOWN_INSTANCE_ID: 'unknown' }));
vi.mock('../lib/gitRepositoryIdentity.js', () => ({ readGitCommonDirectory: vi.fn(async () => '/repo/.git') }));
import { EventEmitter } from 'node:events';
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

vi.mock('./agentWorktreeCleanup.js', () => ({ releaseRetryHold: vi.fn(async () => ({})) }));
vi.mock('./releaseSynchronization.js', () => ({ recoverReleaseSynchronizationHandoffs: vi.fn(async () => {}) }));
import { recoverReleaseSynchronizationHandoffs } from './releaseSynchronization.js';
vi.mock('./repoCleanupRecovery.js', () => ({ inspectOrQueueCompletedReview: vi.fn(async () => ({ disposition: 'held', reason: 'delivery-ci-or-review-pending' })) }));
vi.mock('./repoCleanupObservation.js', async original => ({ ...await original(), readCheckoutPathPresence: vi.fn(async () => false), readLocalBranchPresence: vi.fn(async () => false) }));
vi.mock('../lib/gitRemote.js', () => ({ getOriginInfo: vi.fn(async () => ({ host: 'github.com', fullName: 'example/repo', isGithub: true })) }));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: vi.fn(async () => ({})) }));
vi.mock('./heldCheckoutReview.js', () => ({ readRetirementForgeEvidence: vi.fn(async () => ({ prHead: '1'.repeat(40), mergeCommit: '3'.repeat(40), defaultHead: '2'.repeat(40) })) }));
vi.mock('./completedCheckoutEvidence.js', async original => ({ ...await original(), readCompletedCheckoutIdentity: vi.fn() }));
vi.mock('./cos.js', () => ({}));
vi.mock('./agentCompletionData.js', () => ({ readCompletionData: vi.fn() }));
vi.mock('./agentCompletionCleanup.js', () => ({ replayAgentCompletionCleanup: vi.fn(async () => {}) }));
vi.mock('./cosAgentLifecycle.js', async original => ({ isSettleableCompletionReceipt: (await original()).isSettleableCompletionReceipt, recordSuccessorCheckoutRetirement: vi.fn(async () => true), settleAbsentTaskCompletion: vi.fn(async () => true), retryCompletionCheckoutCapture: vi.fn(async () => false), reserveRepoCleanupRecovery: vi.fn(async () => ({ admitted: true, attempt: 1 })), recordRepoCleanupRecovery: vi.fn(async () => true), recordCleanupOutcome: vi.fn(async () => true), updateAgent: vi.fn().mockResolvedValue({}), recordRepoStateRecovery: vi.fn().mockResolvedValue(true), recordRepoStateVerification: vi.fn().mockResolvedValue(true), getAgentRecord: vi.fn(async () => null), recordCompletionCleanup: vi.fn(async () => true) }));
vi.mock('./cosClaimOwnership.js', () => ({ readClaimOwnershipAgents: vi.fn().mockResolvedValue([]), withClaimOwnershipLock: fn => fn() }));
vi.mock('./taskSchedule.js', () => ({ recordBranchReconcileOutcome: vi.fn().mockResolvedValue({}) }));
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

import { inspectOrQueueCompletedReview } from './repoCleanupRecovery.js';
import { readLocalBranchPresence, readCheckoutPathPresence } from './repoCleanupObservation.js';
import { readRetirementForgeEvidence } from './heldCheckoutReview.js';
import { readCompletedCheckoutIdentity } from './completedCheckoutEvidence.js';
import { readClaimOwnershipAgents } from './cosClaimOwnership.js';
import { retryCompletionCheckoutCapture, getAgentRecord, recordCleanupOutcome, reserveRepoCleanupRecovery, recordRepoStateRecovery, recordRepoStateVerification } from './cosAgentLifecycle.js';
import { readCompletionData } from './agentCompletionData.js';
import { recordSuccessorCheckoutRetirement, settleAbsentTaskCompletion } from './cosAgentLifecycle.js';
import { replayAgentCompletionCleanup } from './agentCompletionCleanup.js';
import { resumeAgentCompletionRetirement, verifyAgentRepoState, sweepRepoStateVerifications, bindCompletionRetirementEvents, REPO_STATE_REMEDIATIONS } from './agentRepoStateVerification.js';
import { readBranchCompletionPolicies } from './branchCompletionPolicy.js';
import { releaseRetryHold } from './agentWorktreeCleanup.js';
import { getTaskById, updateTask } from './cosTaskStore.js';
import { recordBranchReconcileOutcome } from './taskSchedule.js';
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
import { emitLog } from './cosEvents.js';
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
const openView = (patch = {}) => JSON.stringify({ number: 9, state: 'OPEN', isDraft: false, isCrossRepository: false, headRefName: BRANCH, headRefOid: HEAD, mergeable: 'MERGEABLE', reviewDecision: '', statusCheckRollup: [{ name: 'CI', status: 'QUEUED' }], ...patch });

/** The `{user, cos}` shape `getAllTasks` really returns. Follow-ups land in `cos`. */
const queuedTasks = (tasks) => getAllTasks.mockResolvedValue({ user: { tasks: [] }, cos: { tasks } });

const observeCompletedTask = async task => {
  const events = new EventEmitter();
  const unbind = bindCompletionRetirementEvents(events);
  try { return await events.listeners('tasks:changed')[0]({ task }); }
  finally { unbind(); }
};

const run = (overrides = {}) => verifyAgentRepoState({
  agentId: 'agent-1',
  task: task(),
  agentState: agentState(),
  success: true,
  prExpected: true,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
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
  retireInventoriedCheckout.mockResolvedValue({ ok: true, archiveDir: '/private/archive', branchDeleted: true });
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
        : { archiveDir: null, evidenceDigest: 'a'.repeat(64), recheck: async () => scenario !== 'receipt-raced' });
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
    readBranchCompletionPolicies.mockResolvedValue([...ineligible, receipt('write-failed'), receipt('settle-next')]);
    recordRepoStateVerification.mockRejectedValueOnce(new Error('fixture receipt write failed'));
    expect(await sweepRepoStateVerifications()).toMatchObject({ checked: 0 });
    expect(recordRepoStateVerification.mock.calls).toEqual([
      ['write-failed', { status: 'completed' }], ['settle-next', { status: 'completed' }],
    ]);
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

  it('keeps missing policy pending with an updated retry time rather than granting authority or starving other audits', async () => {
    getTaskById.mockResolvedValue(null);
    readBranchCompletionPolicies.mockResolvedValue([archived()]);
    await sweepRepoStateVerifications();
    expect(recordRepoStateVerification).toHaveBeenCalledWith('agent-1', expect.objectContaining({ status: 'pending', reasons: ['task-unavailable'], checkedAt: expect.any(String) }));
    expect(addTask).not.toHaveBeenCalled();
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

  it.each(['merged', 'open', 'missing', 'unreadable', 'unreadable-integration'])('restores the exact removed task PR expectation without a saved URL: %s', async mode => {
    const { state, original } = fixture();
    delete state.metadata.reviewLoopMergeTarget;
    original.metadata.prCompletion = 'review-then-merge';
    findPullRequestForBranch.mockResolvedValue(mode === 'unreadable' ? { status: 'unavailable' }
      : mode === 'missing' ? { status: 'none' }
        : { status: 'found', url: 'https://github.com/example/repo/pull/7', detail: mode === 'open' ? 'OPEN' : 'MERGED' });
    if (mode === 'unreadable-integration') readRetirementForgeEvidence.mockRejectedValue(new Error('forge unavailable'));
    const result = await resumeAgentCompletionRetirement('agent-1');
    expect(findPullRequestForBranch).toHaveBeenCalledWith(BRANCH, expect.objectContaining({ cwd: '/repo' }));
    expect(result.verified).toBe(mode === 'merged');
    if (mode === 'merged') expect(settleAbsentTaskCompletion).toHaveBeenCalledWith('agent-1', state);
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
