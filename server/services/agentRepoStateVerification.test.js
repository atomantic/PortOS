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
vi.mock('./repoCleanupRecovery.js', () => ({ inspectOrQueueCompletedReview: vi.fn(async () => ({ disposition: 'held', reason: 'delivery-ci-or-review-pending' })) }));
vi.mock('./repoCleanupObservation.js', async original => ({ ...await original(), readCheckoutPathPresence: vi.fn(async () => false), readLocalBranchPresence: vi.fn(async () => false) }));
vi.mock('../lib/gitRemote.js', () => ({ getOriginInfo: vi.fn(async () => ({ host: 'github.com', fullName: 'example/repo', isGithub: true })) }));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: vi.fn(async () => ({})) }));
vi.mock('./heldCheckoutReview.js', () => ({ readRetirementForgeEvidence: vi.fn(async () => ({ prHead: '1'.repeat(40), defaultHead: '2'.repeat(40) })) }));
vi.mock('./completedCheckoutEvidence.js', () => ({ readCompletedCheckoutIdentity: vi.fn() }));
vi.mock('./cos.js', () => ({}));
vi.mock('./cosAgentLifecycle.js', () => ({ reserveRepoCleanupRecovery: vi.fn(async () => ({ admitted: true, attempt: 1 })), recordRepoCleanupRecovery: vi.fn(async () => true), recordCleanupOutcome: vi.fn(async () => true), updateAgent: vi.fn().mockResolvedValue({}), recordRepoStateRecovery: vi.fn().mockResolvedValue(true), recordRepoStateVerification: vi.fn().mockResolvedValue(true) }));
vi.mock('./cosClaimOwnership.js', () => ({ readClaimOwnershipAgents: vi.fn().mockResolvedValue([]), withClaimOwnershipLock: fn => fn() }));
vi.mock('./taskSchedule.js', () => ({ recordBranchReconcileOutcome: vi.fn().mockResolvedValue({}) }));
vi.mock('./heldCheckoutRecovery.js', () => ({
  findMissingCheckoutPreservation: vi.fn(async () => null),
  retireInventoriedCheckout: vi.fn(async () => ({ ok: true, archiveDir: '/private/archive', branchDeleted: true })),
  prepareInventoriedCheckoutRetirement: vi.fn().mockResolvedValue({ ok: true, review: { digest: 'a'.repeat(64) } }),
}));
vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn() }));
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
vi.mock('./notifications.js', () => ({
  addNotification: vi.fn().mockResolvedValue({}),
  exists: vi.fn().mockResolvedValue(false),
  NOTIFICATION_TYPES: { AGENT_WARNING: 'agent_warning' },
  PRIORITY_LEVELS: { HIGH: 'high' },
}));
vi.mock('./brainTaskThreads.js', () => ({ ensureTaskThread: vi.fn().mockResolvedValue({}) }));
vi.mock('../lib/execGit.js', () => ({ execGit: vi.fn() }));
vi.mock('fs', () => ({ existsSync: vi.fn().mockReturnValue(false) }));

import { inspectOrQueueCompletedReview } from './repoCleanupRecovery.js';
import { readLocalBranchPresence, readCheckoutPathPresence } from './repoCleanupObservation.js';
import { readCompletedCheckoutIdentity } from './completedCheckoutEvidence.js';
import { readClaimOwnershipAgents } from './cosClaimOwnership.js';
import { recordCleanupOutcome, reserveRepoCleanupRecovery, recordRepoStateRecovery, recordRepoStateVerification } from './cosAgentLifecycle.js';
import { verifyAgentRepoState, sweepRepoStateVerifications, REPO_STATE_REMEDIATIONS } from './agentRepoStateVerification.js';
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
  findMissingCheckoutPreservation.mockResolvedValue(null);
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
  addTask.mockResolvedValue({ id: 'task-recovery-1' });
  localBranch(false);
});

describe('verifyAgentRepoState — clean runs', () => {
  it('retires the old verification owner after an explicit retry without touching Git', async () => {
    getTaskById.mockResolvedValue({ ...task(), status: 'pending' });
    const state = { ...agentState({ repoStateVerification: { status: 'pending' } }), result: { cleanupPending: true } };
    expect(await run({ success: false, agentState: state })).toMatchObject({ skipReason: 'cleanup-owner-changed' });
    expect(retireInventoriedCheckout).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    expect(recordRepoStateVerification).toHaveBeenLastCalledWith('agent-1', { status: 'completed', reasons: ['cleanup-owner-changed'] });
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
    localBranch(true);
    existsSync.mockReturnValue(true);
    findPullRequestForBranch.mockResolvedValue({ status: 'found', detail: prState, url: 'https://github.com/example/repo/pull/7' });
    const state = { ...agentState(), result: { success: false, cleanupPending: true } };
    expect(await run({ success: false, agentState: state })).toMatchObject({ skipReason: 'cleanup-transferred-to-recovery' });
    expect(releaseRetryHold).toHaveBeenCalledOnce();
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

  it('settles only the cleanup handoff owned by this run after archive and integration proof', async () => {
    const completed = { version: 1, agentId: 'agent-1', repoPath: '/repo', branch: BRANCH, path: WORKTREE, head: HEAD,
      startedAt: CREATED_AT, capturedAt: CREATED_AT };
    const state = { ...agentState({ completedCheckouts: [completed],
      reviewLoopMergeTarget: { url: 'https://github.com/example/repo/pull/7' }, repoStateVerification: { status: 'pending' } }),
      result: { success: false, cleanupPending: true } };
    await run({ success: false, agentState: state });
    expect(updateTask).not.toHaveBeenCalled();
    findMissingCheckoutPreservation.mockResolvedValue({ archiveDir: '/example/archive', evidenceDigest: 'a'.repeat(64), recheck: async () => true });
    expect(await run({ success: false, agentState: state })).toMatchObject({ verified: true });
    expect(updateTask).toHaveBeenLastCalledWith('task-1', expect.objectContaining({ status: 'completed' }), 'user', {
      expectedStatus: 'in_progress', expectedMetadata: { deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-1' },
    });
    expect(addTask).not.toHaveBeenCalled();
  });

  it('settles an absent completed checkout from verified original-generation archive evidence without deleting or queueing work', async () => {
    const completed = { version: 1, agentId: 'agent-1', repoPath: '/repo', branch: BRANCH, path: WORKTREE, head: HEAD,
      startedAt: CREATED_AT, capturedAt: CREATED_AT };
    const state = agentState({ completedCheckouts: [completed], reviewLoopMergeTarget: { url: 'https://github.com/example/repo/pull/7' }, repoStateVerification: { status: 'pending' } });
    const recheck = vi.fn(async () => true);
    findMissingCheckoutPreservation.mockResolvedValue({ archiveDir: '/example/archive', evidenceDigest: 'a'.repeat(64), recheck });
    expect(await run({ agentState: state })).toMatchObject({ verified: true, skipReason: null });
    expect(findMissingCheckoutPreservation).toHaveBeenCalledWith({ repoPath: '/repo', release: { ...RELEASE, createdAt: CREATED_AT } });
    expect(recordCleanupOutcome).toHaveBeenLastCalledWith('agent-1', expect.objectContaining({
      status: 'verified', reason: 'already-absent-preservation-verified', head: HEAD,
      preservation: expect.objectContaining({ capturedAt: CREATED_AT, evidenceDigest: 'a'.repeat(64) }),
    }));
    expect(recordRepoStateVerification).toHaveBeenLastCalledWith('agent-1', expect.objectContaining({ status: 'completed' }));
    expect(addTask).not.toHaveBeenCalled();
    expect(retireInventoriedCheckout).not.toHaveBeenCalled();
    recordCleanupOutcome.mockResolvedValueOnce(false);
    expect(await run({ agentState: state })).toMatchObject({ verified: false, skipReason: 'already-absent-preservation-unverified' });
    recheck.mockResolvedValue(false);
    expect(await run({ agentState: state })).toMatchObject({ verified: false, skipReason: 'already-absent-preservation-unverified' });
    findMissingCheckoutPreservation.mockResolvedValue(null);
    expect(await run({ agentState: state })).toMatchObject({ verified: false, skipReason: 'already-absent-preservation-unverified' });
  });

  it.each([['broken leaf symlink', true], ['unreadable EACCES leaf', null]])('never treats %s as absent or verified cleanup', async (_name, presence) => {
    readCheckoutPathPresence.mockResolvedValue(presence);
    const result = await run();
    expect(result.verified).toBe(false);
    expect(result.observed?.worktreePresent).toBe(presence);
    expect(result.skipReason).not.toBe('already-absent-preservation-unverified');
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

  it('keeps missing checkout/ref integration separate from unavailable private content preservation', async () => {
    const state = agentState({ reviewLoopMergeTarget: { url: 'https://github.com/example/repo/pull/7' } });
    for (let i = 0; i < 70; i++) expect(await run({ agentState: state })).toMatchObject({ verified: false, skipReason: 'already-absent-preservation-unverified' });
    expect(recordCleanupOutcome).toHaveBeenLastCalledWith('agent-1', expect.objectContaining({ status: 'already-absent', committedIntegrationVerified: true }));
    expect(addTask).not.toHaveBeenCalled();
    expect(retireInventoriedCheckout).not.toHaveBeenCalled();
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

    expect(result.verified).toBe(false);
    expect(result.skipReason).toBe('already-absent-preservation-unverified');
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
    expect(kind).toBe('user');
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
    expect(payload.context).toContain('archiveDir and branchDeleted:true');
    expect(payload.context).not.toMatch(/git (?:worktree (?:remove|unlock|prune)|branch -[dD]|push[^\n]*--delete)|--remove-source-branch/);
    expect(payload.metadata.retirementReview).toEqual({ appId: 'demo-app', release: RELEASE, createdAt: CREATED_AT });
    expect(recordBranchReconcileOutcome).toHaveBeenCalledWith('demo-app', expect.objectContaining({
      retirementObligations: [{ ...RELEASE, reason: 'retirement-review-pending' }],
    }));
    expect(recordBranchReconcileOutcome.mock.invocationCallOrder[0]).toBeLessThan(prepareInventoriedCheckoutRetirement.mock.invocationCallOrder[0]);
    expect(prepareInventoriedCheckoutRetirement.mock.invocationCallOrder[0]).toBeLessThan(addTask.mock.invocationCallOrder[0]);
    expect(payload.context).toContain(`touch ONLY ${BRANCH}`);
    expect(ensureTaskThread).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-recovery-1', priority: 'high',
    }));
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
    queuedTasks([{ status: 'pending', metadata: { reviewLoopFollowUp: true, reviewLoopPRBranch: BRANCH } }]);
    existsSync.mockReturnValue(true);

    const result = await run({ task: task({ prCompletion: 'review-then-merge' }) });

    expect(result.skipReason).toBe(REPO_STATE_SKIPS.FOLLOW_UP_PENDING);
    expect(addTask).not.toHaveBeenCalled();
  });

  it('defers while a retry holds the branch as its resume pointer', async () => {
    queuedTasks([{ status: 'pending', metadata: { existingBranch: BRANCH } }]);
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
    queuedTasks([{ status: 'challenged', metadata: { existingBranch: BRANCH } }]);
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
    expect(result.verified).toBe(false);
    expect(result.skipReason).toBe('already-absent-preservation-unverified');
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

  it('records each held swarm branch under the reason it returns', async () => {
    readClaimOwnershipAgents.mockRejectedValue(new Error('agents unreadable'));
    const state = agentState({ isWorktree: false, worktreeBranch: null, workspacePath: '/repo', claimPicksOwnBranch: true, claimBranches: ['claim/issue-11'] });
    expect((await run({ agentState: state })).branches).toEqual([{ branch: 'claim/issue-11', verified: false, skipReason: 'claim-ownership-unreadable', issues: [], recoveryTaskId: null }]);
    expect(recordCleanupOutcome).toHaveBeenLastCalledWith('agent-1', { branch: 'claim/issue-11', status: 'blocked', reason: 'claim-ownership-unreadable', owners: [] });

    readClaimOwnershipAgents.mockResolvedValue([]);
    localBranch(true);
    expect((await run({ agentState: state })).branches).toEqual([{ branch: 'claim/issue-11', verified: false, skipReason: 'claim-checkout-identity-unverified', issues: [], recoveryTaskId: null }]);
    expect(recordCleanupOutcome).toHaveBeenLastCalledWith('agent-1', { branch: 'claim/issue-11', status: 'blocked', reason: 'claim-checkout-identity-unverified' });
  });

  it('settles a receipt-less swarm branch from delivery evidence once its checkout and ref are gone', async () => {
    const state = agentState({ isWorktree: false, worktreeBranch: null, workspacePath: '/repo', claimPicksOwnBranch: true, claimBranches: ['claim/issue-11'] });
    findPullRequestForBranch.mockResolvedValue({ status: 'found', url: 'https://github.com/example/repo/pull/11', detail: 'MERGED' });
    expect((await run({ agentState: state })).branches).toEqual([expect.objectContaining({ branch: 'claim/issue-11', skipReason: 'already-absent-preservation-unverified' })]);
    expect(recordCleanupOutcome).toHaveBeenLastCalledWith('agent-1', expect.objectContaining({ branch: 'claim/issue-11', path: null, status: 'already-absent' }));
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
  const archived = () => ({ ...agentState(), id: 'agent-1', taskId: 'task-1', status: 'completed', result: { success: true },
    metadata: { ...agentState().metadata, repoStateVerification: { status: 'pending' } } });
  it('resumes a persisted pending audit after restart and settles clean completion', async () => {
    readBranchCompletionPolicies.mockResolvedValue([archived()]);
    getTaskById.mockResolvedValue(task());
    findPullRequestForBranch.mockResolvedValue({ status: 'found', detail: 'MERGED', url: 'https://github.com/example/repo/pull/7' });
    expect(await sweepRepoStateVerifications()).toMatchObject({ checked: 1 });
    expect(recordRepoStateVerification).toHaveBeenCalledWith('agent-1', expect.objectContaining({ status: 'pending' }));
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
