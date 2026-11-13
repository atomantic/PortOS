import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';
import { materializeGitRepo } from '../lib/gitTestRepo.js';
import { execGit } from '../lib/execGit.js';

vi.mock('../lib/paths.js', async original => makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('portos-retirement-completion-') }));
afterAll(cleanupTempDataRoots);
const store = vi.hoisted(() => ({ task: null, parent: null, agent: null, app: null, owners: [] }));
vi.mock('./apps.js', () => ({ getAppById: vi.fn(async id => id === store.app.id ? store.app : null) }));
vi.mock('./branchReconcileOutcome.js', () => ({ getBranchReconcileOutcome: vi.fn(() => { throw new Error('Receipt store must not be read'); }) }));
vi.mock('./cosTaskStore.js', () => ({
  getTaskById: vi.fn(async id => id === store.task?.id ? structuredClone(store.task) : null),
  updateTask: vi.fn(async (_id, patch) => {
    store.task = { ...store.task, ...patch, metadata: { ...store.task.metadata, ...patch.metadata } };
    return store.task;
  }),
}));
vi.mock('./cosState.js', async original => ({ ...await original(), loadState: vi.fn(async () => ({ agents: {} })), readAgentsStateForSafetyCheck: async () => ({ trusted: true, agents: {} }) }));
vi.mock('./instanceIdentity.js', () => ({ ensureInstanceId: vi.fn(async () => 'example-instance') }));
vi.mock('./cosClaimOwnership.js', async original => ({
  ...await original(), readClaimOwnershipAgents: vi.fn(async () => store.owners),
}));
vi.mock('./branchCompletionPolicy.js', async original => ({
  ...await original(), readBranchCompletionPolicies: vi.fn(async () => []),
}));
vi.mock('./cosAgentLifecycle.js', () => ({
  getAgent: vi.fn(async () => store.agent),
  getAgentRecord: vi.fn(async id => id === store.parent?.id ? store.parent : store.agent),
  updateAgent: vi.fn(async (_id, patch) => {
    store.agent.metadata = { ...store.agent.metadata, ...patch.metadata };
    return store.agent;
  }),
  completeAgent: vi.fn(async (_id, result) => { store.agent.status = 'completed'; store.agent.result = result; return store.agent; }),
  recordCleanupOutcome: vi.fn(async (_id, outcome) => { store.agent.metadata.cleanupOutcome = outcome; return true; }),
}));
vi.mock('./agentCompletion.js', () => ({ processAgentCompletion: vi.fn(async () => null) }));
vi.mock('./agentCompletionCleanup.js', () => ({ removeCompletionSentinel: vi.fn(async () => {}) }));
vi.mock('./agentRunTracking.js', () => ({ completeAgentRun: vi.fn(async () => null) }));
vi.mock('./codeReview.js', async original => ({ ...await original(), getGoalFidelityConfig: vi.fn(async () => null) }));
vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn(), cosEvents: { emit: vi.fn(), on: vi.fn() } }));

import { PATHS } from '../lib/paths.js';
import { getAppById } from './apps.js';
import { getTaskById, updateTask } from './cosTaskStore.js';
import { completeAgent } from './cosAgentLifecycle.js';
import { evaluateSuccessCriteria, finalizeAgent, retireDeadAgent } from './agentFinalization.js';
import { prepareAgentSpawn } from './agentSpawnPreparation.js';
import { settleRetirementReviewRun } from './branchReconcileCompletion.js';
import { readCheckoutPathPresence, readLocalBranchPresence } from './repoCleanupObservation.js';

vi.mock('./repoCleanupObservation.js', async original => {
  const actual = await original();
  return { ...actual, readCheckoutPathPresence: vi.fn(actual.readCheckoutPathPresence), readLocalBranchPresence: vi.fn(actual.readLocalBranchPresence) };
});

const realObservation = await vi.importActual('./repoCleanupObservation.js');

let scratch;
let repo;
let release;
let target;
let startedAt;
let originalHead;

beforeEach(async () => {
  vi.clearAllMocks();
  getAppById.mockImplementation(async id => id === store.app.id ? store.app : null);
  readCheckoutPathPresence.mockReset().mockImplementation(realObservation.readCheckoutPathPresence);
  readLocalBranchPresence.mockReset().mockImplementation(realObservation.readLocalBranchPresence);
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = realpathSync(await mkdtemp(join(tmpdir(), 'portos-retirement-flow-')));
  repo = join(scratch, 'repo');
  await mkdir(repo);
  await materializeGitRepo(repo, { identity: { email: 'test@example.com', name: 'Test' } });
  const path = join(scratch, 'checkout');
  const branch = 'fix/cleanup-example';
  await execGit(['worktree', 'add', '-b', branch, path, 'main'], repo);
  originalHead = (await execGit(['rev-parse', 'HEAD'], repo)).stdout.trim();
  release = { branch, path, head: originalHead };
  Object.assign(store, { app: { id: 'example-app', repoPath: repo }, owners: [] });
  target = { appId: store.app.id, release };
  startedAt = Date.now();
  store.task = { id: 'sys-receipt-example', taskType: 'internal', status: 'in_progress', description: 'Finish exact cleanup', priority: 'HIGH',
    metadata: { app: store.app.id, isRecovery: true, useWorktree: false, totalSpawnCount: 2, failureCount: 1,
      recoveryOrigin: { subsystem: 'repository-cleanup', parentAgentId: 'example-parent', parentTaskId: 'sys-original', observation: 'b'.repeat(64) },
      retirementReview: target } };
  store.parent = { id: 'example-parent', taskId: 'sys-original', status: 'completed', startedAt: new Date(startedAt - 2000).toISOString(),
    completedAt: new Date(startedAt - 1).toISOString(), metadata: {
    // No retirement backlink or completed-checkout receipt.
  } };
  store.agent = { id: 'example-recovery', taskId: store.task.id, startedAt: new Date(startedAt).toISOString(), status: 'running',
    metadata: { workspacePath: repo, ...store.task.metadata } };
});
afterAll(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }); });

// Simulate cleanup completed outside PortOS: Git, with no receipt or parent backlink.
async function retire() {
  await execGit(['worktree', 'remove', release.path], repo);
  await execGit(['branch', '-d', release.branch], repo);
}

async function finish(report, mode = 'direct') {
  const envelope = { summary: 'Exact retirement finished.', taskOutcome: { status: report, reason: 'Service retirement complete.' } };
  if (mode === 'recovered') {
    await mkdir(PATHS.cosAgents, { recursive: true });
    await writeFile(join(repo, `.agent-done-${store.agent.id}`), JSON.stringify(envelope));
    return retireDeadAgent({ agent: store.agent, task: store.task, success: true, exitCode: 0, duration: 1 });
  }
  return finalizeAgent({ agentId: store.agent.id, task: store.task, success: true, exitCode: 0, duration: 1,
    workspacePath: repo, startedAt, finalSummary: JSON.stringify(envelope), outputBuffer: '', recovery: mode === 'runner' });
}

describe('cleanup-only recovery public completion flow', () => {
  it.each(['direct', 'runner'])('settles %s completion from Git absence without a receipt or new commit', async mode => {
    await retire();
    store.parent.metadata = {};
    await finish('no-action-needed', mode);
    expect(store.agent.result).toMatchObject({ success: true, validationPassed: true, taskOutcome: { status: 'no-action-needed' } });
    expect(store.task.status).toBe('completed');
    expect(await settleRetirementReviewRun(store.agent)).toEqual({ verified: true });
    expect(store.agent.metadata.cleanupOutcome).toMatchObject({ status: 'verified', reason: 'cleanup-local-target-absent' });
    expect(completeAgent).toHaveBeenCalledOnce();
    expect((await execGit(['rev-parse', 'HEAD'], repo)).stdout.trim()).toBe(originalHead);
    expect(store.task.metadata).toMatchObject({ totalSpawnCount: 2, failureCount: 1 });
  });

  it('records the same cleanup verdict when recovering an interrupted run', async () => {
    await retire();
    await finish('no-action-needed', 'recovered');
    // processAgentCompletion is doubled here; its downstream task update is outside this assertion.
    expect(store.agent.result).toMatchObject({ success: true, validationPassed: true, taskOutcome: { status: 'no-action-needed' } });
    expect(await settleRetirementReviewRun(store.agent)).toEqual({ verified: true });
  });

  it('settles an already-removed queued retry before spawn-budget rejection without rewriting its failed run', async () => {
    await retire();
    const failedRun = { success: false, validationPassed: false, taskOutcome: { status: 'incomplete', reason: 'Delivery checks did not pass.' } };
    store.agent.result = structuredClone(failedRun);
    store.agent.status = 'completed';
    store.task.status = 'pending';
    store.task.metadata.totalSpawnCount = 999;
    expect(await prepareAgentSpawn(store.task)).toBeNull();
    expect(store.task.status).toBe('completed');
    expect(store.task.metadata).toMatchObject({ totalSpawnCount: 999, failureCount: 1, retirementCompletion: { status: 'verified' } });
    expect(store.agent.result).toEqual(failedRun);
    expect(updateTask).toHaveBeenCalledOnce();
    expect(updateTask).toHaveBeenCalledWith(store.task.id, expect.any(Object), 'internal', expect.objectContaining({
      expectedStatus: 'pending', expectedTask: expect.any(Object), recoveryOwner: { requireInactive: true },
    }));
  });

  it.each(['checkout', 'local-ref', 'unreadable-checkout', 'unreadable-ref', 'review-hold', 'missing-app', 'unreadable-app', 'parent-handoff', 'parent-review-hold', 'missing-parent', 'parent-task-mismatch'])('keeps %s unresolved despite a success summary', async fault => {
    await retire();
    if (fault === 'checkout') await mkdir(release.path);
    if (fault === 'local-ref') await execGit(['branch', release.branch, originalHead], repo);
    if (fault === 'unreadable-checkout') readCheckoutPathPresence.mockResolvedValue(null);
    if (fault === 'unreadable-ref') readLocalBranchPresence.mockResolvedValue(null);
    if (fault === 'parent-handoff') store.parent.metadata.prCompletionPolicy = 'leave-open';
    if (fault === 'parent-review-hold') store.parent.metadata.reviewLoopLeaveOpen = true;
    if (fault === 'parent-task-mismatch') store.parent.taskId = 'unrelated-task';
    if (fault === 'missing-parent') store.parent = null;
    if (fault === 'review-hold') store.task.metadata.reviewLoopLeaveOpen = true;
    if (fault === 'unreadable-app') getAppById.mockRejectedValue(new Error('unreadable'));
    if (fault === 'missing-app') store.task.metadata.retirementReview.appId = 'missing';
    await finish('completed');
    expect(store.agent.result).toMatchObject({ success: false, validationPassed: false, taskOutcome: { status: 'incomplete' } });
    expect(store.task.status).not.toBe('completed');
    expect(await settleRetirementReviewRun(store.agent)).toEqual({ verified: false });
    expect(store.agent.metadata.cleanupOutcome.status).toBe('blocked');
  });

  it('leaves a queued recovery with newly-added delivery work for a fresh dequeue', async () => {
    await retire();
    store.task.status = 'pending';
    const queued = structuredClone(store.task);
    store.task.metadata.recoveryMergeTarget = { branch: release.branch, url: 'https://github.com/example/repo/pull/1' };
    expect(await prepareAgentSpawn(queued)).toBeNull();
    expect(updateTask).not.toHaveBeenCalled();
    expect(store.task.status).toBe('pending');
  });

  it('does not spawn after the fenced task update loses to a concurrent edit', async () => {
    await retire();
    store.task.status = 'pending';
    updateTask.mockResolvedValueOnce({ statusChanged: true, task: { status: 'blocked' } });
    expect(await prepareAgentSpawn(store.task)).toBeNull();
    expect(store.task.status).toBe('pending');
    expect(completeAgent).not.toHaveBeenCalled();
  });

  it('keeps delivery repair on its applicable commit gates', async () => {
    await retire();
    store.task.metadata.recoveryMergeTarget = { branch: release.branch, url: 'https://github.com/example/repo/pull/1' };
    expect(await evaluateSuccessCriteria({ task: store.task, workspacePath: repo, startedAt: Date.now() + 1000, success: true })).toBe(false);
  });
});
