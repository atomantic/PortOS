/**
 * Tests for cosTaskStore.js — task CRUD + queue persistence extracted from
 * cos.js. Two layers:
 *
 * 1. Behavioral tests with the file/state/event deps mocked (in-memory file
 *    map) — exercise the real read/write round-trip, dedup, ID generation,
 *    metadata normalization, and the `tasks:changed` emissions.
 * 2. Source-level regression guards (moved here from cos.test.js when addTask
 *    was extracted) that pin the first-line dedup + per-app dedup scope.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync as realReadFileSync } from 'node:fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { removeByMetadata } from './notifications.js';
import * as repository from './cosTaskRepository.js';
const actualRepository = await vi.importActual('./cosTaskRepository.js');
import { planListSave } from '../lib/cosTaskRows.js';

vi.mock('./prWatcher.js', () => ({ persistPrWatcherState: vi.fn(async () => ({})) }));
import { persistPrWatcherState } from './prWatcher.js';
import { LEGACY_FORGE_MAINTENANCE_REASON } from '../lib/forgeMaintenanceTasks.js';

vi.mock('./notifications.js', () => ({ removeByMetadata: vi.fn().mockResolvedValue(1) }));

const mock = vi.hoisted(() => ({
  // When set, the next repository write rejects with it (a save that dies before commit).
  writeFailure: null,
  // Called with the source after each committed write; a truthy return clears it.
  afterWrite: null,
  // Counts real working-set loads so the cache tests can prove a hit did no work.
  loads: 0,
  state: null,
  events: [],
  // Controls the mocked codeReview.js for resolveTaskChallengeWithRecheck (#2471).
  review: { ok: true, findings: 'No findings.' },
  reviewDefaults: { lmstudioModel: 'default-lmstudio', ollamaModel: 'default-ollama' },
  reviewCalls: [],
  // Captures cross-peer LI execution verdicts consumed by mergePeerTasks (#2779).
  liVerdicts: []
}));

// The real in-memory repository, wrapped so tests can count loads, fail a save,
// or run a hook right after a committed write (the old file-write seams).
vi.mock('./cosTaskRepository.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadTaskWorkingSet: vi.fn(async (...args) => { mock.loads += 1; return actual.loadTaskWorkingSet(...args); }),
    applyTaskListSave: vi.fn(async (source, plan) => {
      if (mock.writeFailure) throw mock.writeFailure;
      const version = await actual.applyTaskListSave(source, plan);
      if (mock.afterWrite && await mock.afterWrite(source)) mock.afterWrite = null;
      return version;
    }),
  };
});

vi.mock('./cosState.js', async () => ({
  loadState: vi.fn(async () => mock.state),
  readAgentsStateForSafetyCheck: vi.fn(async () => ({ trusted: true, agents: mock.state.agents })),
  withStateLock: (await import('../lib/fileWriteQueue.js')).createFileWriteQueue(),
}));

vi.mock('./cos.js', () => ({
  isRunning: vi.fn(() => false),
}));
vi.mock('./cosAgentLifecycle.js', () => ({
  getAgentRecord: vi.fn(),
}));

vi.mock('./cosEvents.js', async () => {
  const { EventEmitter } = await import('node:events');
  const events = new EventEmitter();
  const emit = events.emit.bind(events);
  events.emit = (name, payload) => { mock.events.push({ name, payload }); return emit(name, payload); };
  return { emitLog: vi.fn(), cosEvents: events };
});

vi.mock('./codeReview.js', () => ({
  runLocalCodeReview: vi.fn(async (opts) => { mock.reviewCalls.push(opts); return mock.review; }),
  getCodeReviewDefaults: vi.fn(async () => mock.reviewDefaults)
}));

// The LI cross-peer verdict consumer (#2779). Mocked so mergePeerTasks's post-lock
// consume never touches the real li-outcomes store, and so the tests can assert which
// verdicts were consumed. The key literal MUST mirror layeredIntelligenceOutcomes.js's
// LI_EXECUTION_VERDICT_KEY (a stamp/consume metadata contract).
vi.mock('./layeredIntelligenceOutcomes.js', () => ({
  LI_EXECUTION_VERDICT_KEY: 'liExecution',
  recordProposalExecutionFromVerdict: vi.fn(async (verdict) => { mock.liVerdicts.push(verdict); return true; })
}));

import {
  firstLine,
  getUserTasks,
  getCosTasks,
  getAllTasks,
  getTaskView,
  getPendingTaskIds,
  getCosApprovalView,
  getTaskDiagnostics,
  getTasks,
  getTaskById,
  addTask,
  updateTask,
  reviveBlockedTask,
  deleteTask,
  reorderTasks,
  approveTask,
  mergePeerTasks,
  challengeTask,
  resolveTaskChallenge,
  resolveTaskChallengeWithRecheck,
  blockedFailureAgeMs,
  isReapableBlockedFailure,
  isReapableInvestigation,
  sweepResolvedFailureTasks,
  findTaskWithSource,
  reconcileLegacyForgeMaintenanceTasks,
  DEFAULT_FAILURE_TASK_MAX_AGE_MS,
  __resetTaskCache
} from './cosTaskStore.js';
import { aggregateAutoFixDiagnostics, getAutoFixMetrics } from './autoFixMetrics.js';
import { PRIORITY_VALUES, generateTasksMarkdown, parseTasksMarkdown } from '../lib/taskParser.js';
import { getTaskPrompt, getTaskContextNote } from '../lib/cosTaskPrompt.js';
import { AGENT_PAUSED_CATEGORY, PAUSE_METADATA_KEYS, registerPauseReleaseAdapter, __resetPauseReleaseAdapter } from '../lib/taskPauseHold.js';
import { MAX_TOTAL_SPAWNS } from '../lib/cosValidation.js';
import { activeAgents, runnerAgents } from './agentState.js';

const baseState = () => ({ agents: {} });

// Test-side access to what is stored, bypassing the store's cache and the
// failure/after-write hooks above (they wrap only the store's own saves).
const seed = async (source, tasks) => {
  const { rows, version } = await actualRepository.loadTaskWorkingSet(source);
  const plan = planListSave({ previous: rows, next: tasks, source });
  await actualRepository.applyTaskListSave(source, { ...plan, expectedVersions: { [source]: version } });
  __resetTaskCache();
};
const stored = async (source) => (await actualRepository.loadTaskWorkingSet(source)).rows.map((row) => row.task);

beforeEach(() => {
  mock.writeFailure = null;
  mock.afterWrite = null;
  mock.loads = 0;
  // Both the repository's backend and the store's cache are module-level state;
  // a leftover entry from the previous test would answer for tasks it never created.
  actualRepository.__resetCosTaskRepository();
  __resetTaskCache();
  mock.state = baseState();
  mock.events = [];
  mock.review = { ok: true, findings: 'No findings.' };
  mock.reviewDefaults = { lmstudioModel: 'default-lmstudio', ollamaModel: 'default-ollama' };
  mock.reviewCalls = [];
});

it('reconciles a stopped stale completion only against its latest episode dispatch, without resuming it', async () => {
  const { reconcileSpawnBudget } = await import('./spawnBudgetReconciliation.js');
  const fresh = await addTask({ id: 'sys-proof', description: 'Proof fixture' }, 'internal');
  const claim = (count, at) => ({ status: 'in_progress', metadata: { totalSpawnCount: count,
    claimedBy: 'instance-example', claimedAt: at, lastSpawnedAt: at } });
  mock.state.agents['agent-first'] = { id: 'agent-first', taskId: fresh.id, status: 'running', startedAt: '2026-01-01T00:00:00.000Z' };
  await updateTask(fresh.id, claim(1, '2026-01-01T00:00:00.000Z'), 'internal',
    { spawnBudgetOperation: { kind: 'dispatch', agentId: 'agent-first', startedAt: '2026-01-01T00:00:00.000Z' } });
  await updateTask(fresh.id, { status: 'pending' }, 'internal');
  mock.state.agents['agent-first'].status = 'completed';
  mock.state.agents['agent-second'] = { id: 'agent-second', taskId: fresh.id, status: 'running', startedAt: '2026-01-02T00:00:00.000Z' };
  const latest = await updateTask(fresh.id, claim(2, '2026-01-02T00:00:00.000Z'), 'internal',
    { spawnBudgetOperation: { kind: 'dispatch', agentId: 'agent-second', startedAt: '2026-01-02T00:00:00.000Z' } });
  const proof = latest.metadata.spawnBudgetProof;
  const expected = ['claimedBy', 'claimedAt', 'lastSpawnedAt', 'totalSpawnCount'].map(key => [key, latest.metadata[key]]);
  mock.state.agents['agent-second'] = { id: 'agent-second', taskId: fresh.id, status: 'running', startedAt: '2026-01-02T00:00:00.000Z',
    metadata: { completionTaskDispatch: { taskId: fresh.id, taskType: 'internal', expected, spawnBudgetEpoch: proof.epoch,
      spawnBudgetStartedAt: '2026-01-02T00:00:00.000Z' } } };
  // Completion of the second run replays the first dispatch's count, through
  // the same trusted completion operation used by finalization.
  const blocked = await updateTask(fresh.id, { status: 'blocked', metadata: { totalSpawnCount: 1, failureCount: 3 } }, 'internal',
    { expectedStatus: 'in_progress', spawnBudgetOperation: { kind: 'completion', agentId: 'agent-second', epoch: proof.epoch } });
  expect(Number(blocked.metadata.totalSpawnCount)).toBe(1);
  mock.state.agents['agent-second'].status = 'completed';
  const corrupted = structuredClone(blocked);
  corrupted.metadata.spawnBudgetProof.baseline = 1;
  await seed('internal', [corrupted]);
  const corruptSnapshot = await getTaskById(fresh.id);
  expect(await reconcileSpawnBudget(fresh.id)).toEqual({ reconciled: false, reason: 'episode-unverified' });
  expect(await getTaskById(fresh.id)).toEqual(corruptSnapshot);
  await seed('internal', [blocked]);
  const dispatchReceipt = mock.state.agents['agent-second'].metadata.completionTaskDispatch;
  dispatchReceipt.expected = dispatchReceipt.expected.map(([key, value]) => [key, key === 'totalSpawnCount' ? '3' : value]);
  expect(await reconcileSpawnBudget(fresh.id)).toEqual({ reconciled: false, reason: 'dispatch-receipt-conflict' });
  dispatchReceipt.expected = dispatchReceipt.expected.map(([key, value]) => [key, key === 'totalSpawnCount' ? '2' : value]);
  mock.writeFailure = new Error('reconciliation interrupted');
  await expect(reconcileSpawnBudget(fresh.id)).rejects.toThrow('reconciliation interrupted');
  mock.writeFailure = null;
  expect(Number((await getTaskById(fresh.id)).metadata.totalSpawnCount)).toBe(1);
  mock.state.agents['agent-other'] = { id: 'agent-other', taskId: fresh.id, status: 'running' };
  expect(await reconcileSpawnBudget(fresh.id)).toEqual({ reconciled: false, reason: 'task-or-owner-changed' });
  delete mock.state.agents['agent-other'];
  const { readAgentsStateForSafetyCheck } = await import('./cosState.js');
  vi.mocked(readAgentsStateForSafetyCheck).mockImplementationOnce(async () => {
    await updateTask(fresh.id, { description: 'Concurrent edit' }, 'internal');
    return { trusted: true, agents: mock.state.agents };
  });
  expect(await reconcileSpawnBudget(fresh.id)).toEqual({ reconciled: false, reason: 'task-or-owner-changed' });
  expect(Number((await getTaskById(fresh.id)).metadata.totalSpawnCount)).toBe(1);
  vi.mocked(readAgentsStateForSafetyCheck).mockImplementationOnce(async () => ({ trusted: true, agents: structuredClone(mock.state.agents) }));
  vi.mocked(readAgentsStateForSafetyCheck).mockImplementationOnce(async () => {
    mock.state.agents['agent-second'].metadata.completionTaskDispatch.spawnBudgetEpoch = 'changed';
    return { trusted: true, agents: mock.state.agents };
  });
  expect(await reconcileSpawnBudget(fresh.id)).toEqual({ reconciled: false, reason: 'task-or-owner-changed' });
  expect(Number((await getTaskById(fresh.id)).metadata.totalSpawnCount)).toBe(1);
  mock.state.agents['agent-second'].metadata.completionTaskDispatch.spawnBudgetEpoch = proof.epoch;
  const { retryTasksResolvedByInvestigation } = await import('./investigationRetry.js');
  expect(await retryTasksResolvedByInvestigation({ id: 'sys-investigation', status: 'completed',
    metadata: { isInvestigation: true, affectedTasks: [fresh.id] } })).toEqual({ retried: [],
    skipped: [{ taskId: fresh.id, reason: 'spawn-budget-reconciled-held' }] });
  expect(await getTaskById(fresh.id)).toMatchObject({ status: 'blocked', metadata: { totalSpawnCount: '2', failureCount: '3' } });
  expect(await reconcileSpawnBudget(fresh.id)).toEqual({ reconciled: false, reason: 'already-reconciled' });
  expect(mock.events.filter(event => event.payload?.action === 'unblocked')).toHaveLength(0);
  const corrected = await getTaskById(fresh.id);
  await seed('internal', [{ ...corrected, metadata: { ...corrected.metadata, totalSpawnCount: '1' } }]);
  mock.state.agents['agent-second'].status = 'running';
  expect(await reconcileSpawnBudget(fresh.id)).toEqual({ reconciled: false, reason: 'dispatch-receipt-unverified' });
  expect((await getTaskById(fresh.id)).metadata.totalSpawnCount).toBe('1');
  mock.state.agents['agent-second'].status = 'completed';
  const reset = await reviveBlockedTask(fresh.id, {}, 'internal');
  expect(reset.metadata.spawnBudgetProof.epoch).not.toBe(proof.epoch);
  expect(await reconcileSpawnBudget(fresh.id)).toEqual({ reconciled: false, reason: 'episode-unverified' });
});

it('holds a legacy stopped task whose episode cannot be proven', async () => {
  const { reconcileSpawnBudget } = await import('./spawnBudgetReconciliation.js');
  await addTask({ id: 'sys-legacy-proof', description: 'Legacy example', metadata: {
    totalSpawnCount: 1, failureCount: 2, lastSpawnedAt: '2026-01-01T00:00:00.000Z',
  } }, 'internal');
  await updateTask('sys-legacy-proof', { status: 'blocked' }, 'internal');
  const before = await getTaskById('sys-legacy-proof');
  expect(await reconcileSpawnBudget(before.id)).toEqual({ reconciled: false, reason: 'episode-unverified' });
  expect(await getTaskById(before.id)).toEqual(before);
});

it('resets a pending spawn budget only while the captured task and owner remain unchanged', async () => {
  await seed('user', [{ id: 'task-reset-proof', status: 'pending', priority: 'MEDIUM', description: 'Retained work', metadata: {
    totalSpawnCount: '2', failureCount: '3', lastSpawnedAt: '2026-01-01T00:00:00.000Z',
  } }]);
  const task = await getTaskById('task-reset-proof');
  const options = { expectedStatus: 'pending', expectedTask: { description: task.description, priority: task.priority, metadata: task.metadata },
    recoveryOwner: { id: 'explicit-spawn-budget-reset', startedAt: null, requireInactive: true },
    spawnBudgetOperation: { kind: 'reset', requireInactive: true } };
  mock.state.agents['agent-live'] = { id: 'agent-live', taskId: task.id, status: 'running' };
  expect(await updateTask(task.id, { metadata: { totalSpawnCount: undefined } }, 'user', options)).toMatchObject({ statusChanged: true });
  expect(await getTaskById(task.id)).toEqual(task);
  delete mock.state.agents['agent-live'];
  await updateTask(task.id, { metadata: { claimedBy: 'peer', leaseExpiresAt: '2999-01-01T00:00:00.000Z' } }, 'user');
  const leased = await getTaskById(task.id);
  expect(await updateTask(task.id, { metadata: { totalSpawnCount: undefined } }, 'user', {
    ...options, expectedTask: { description: leased.description, priority: leased.priority, metadata: leased.metadata },
  })).toMatchObject({ statusChanged: true });
  await updateTask(task.id, { metadata: { claimedBy: undefined, leaseExpiresAt: undefined } }, 'user');
  await updateTask(task.id, { description: 'Concurrent edit' }, 'user');
  expect(await updateTask(task.id, { metadata: { totalSpawnCount: undefined } }, 'user', options)).toMatchObject({ statusChanged: true });
  const current = await getTaskById(task.id);
  const saved = await updateTask(task.id, { metadata: { totalSpawnCount: undefined } }, 'user', {
    ...options, expectedTask: { description: current.description, priority: current.priority, metadata: current.metadata },
  });
  expect(saved.status).toBe('pending');
  expect(saved.metadata).toMatchObject({ failureCount: '3', spawnBudgetProof: { baseline: 0, dispatch: null } });
  expect(saved.metadata.totalSpawnCount).toBeUndefined();
});

it('requeues an explicitly reset orphan with its retained checkout and failure count under the owner fence', async () => {
  await seed('user', [{ id: 'task-reset-orphan', status: 'in_progress', priority: 'MEDIUM', description: 'Interrupted work', metadata: {
    totalSpawnCount: '2', failureCount: '3', lastSpawnedAt: '2026-01-01T00:00:00.000Z',
  } }]);
  const task = await getTaskById('task-reset-orphan');
  mock.state.agents['agent-original'] = { id: 'agent-original', taskId: task.id, status: 'completed', startedAt: 'start', metadata: { isWorktree: true } };
  const options = { expectedStatus: 'in_progress', expectedTask: { description: task.description, priority: task.priority, metadata: task.metadata },
    recoveryOwner: { id: 'agent-original', startedAt: 'start', requireInactive: true, requireRegistered: true, expectedOwnerMetadata: { isWorktree: true } },
    spawnBudgetOperation: { kind: 'reset', requireInactive: true }, suppressDequeue: true };
  mock.state.agents['agent-other'] = { id: 'agent-other', taskId: task.id, status: 'running' };
  const patch = { status: 'pending', metadata: { totalSpawnCount: undefined, existingBranch: 'fix/example',
    resumeWorktreePath: '/fixture/worktree', resumedFromAgentId: 'agent-original' } };
  expect(await updateTask(task.id, patch, 'user', options)).toMatchObject({ statusChanged: true });
  delete mock.state.agents['agent-other'];
  mock.state.agents['agent-original'].metadata.isWorktree = false;
  expect(await updateTask(task.id, patch, 'user', options)).toMatchObject({ statusChanged: true });
  delete mock.state.agents['agent-original'];
  expect(await updateTask(task.id, patch, 'user', options)).toMatchObject({ statusChanged: true });
  mock.state.agents['agent-original'] = { id: 'agent-original', taskId: task.id, status: 'completed', startedAt: 'start', metadata: { isWorktree: true } };
  const saved = await updateTask(task.id, patch, 'user', options);
  expect(saved).toMatchObject({ status: 'pending', metadata: { failureCount: '3', existingBranch: 'fix/example',
    resumeWorktreePath: '/fixture/worktree', resumedFromAgentId: 'agent-original', spawnBudgetProof: { baseline: 0, dispatch: null } } });
  expect(saved.metadata.totalSpawnCount).toBeUndefined();
  expect(mock.events.at(-1).payload.suppressDequeue).toBe(true);
});

it('preserves failure history when an explicitly reset blocked task is requeued', async () => {
  await seed('user', [{ id: 'task-reset-blocked', status: 'blocked', priority: 'MEDIUM', description: 'Blocked work', metadata: {
    totalSpawnCount: '2', failureCount: '3', lastErrorCategory: 'test-failure', lastFailureAt: '2026-01-01T00:00:00.000Z',
    blockedCategory: 'task-incomplete',
  } }]);
  const task = await getTaskById('task-reset-blocked');
  mock.state.agents['agent-original'] = { id: 'agent-original', taskId: task.id, status: 'completed', startedAt: 'start' };
  const saved = await updateTask(task.id, { status: 'pending', metadata: { totalSpawnCount: undefined, existingBranch: 'fix/example',
    resumedFromAgentId: 'agent-original' } }, 'user', {
    expectedStatus: 'blocked', expectedTask: { description: task.description, priority: task.priority, metadata: task.metadata },
    recoveryOwner: { id: 'agent-original', startedAt: 'start', requireInactive: true },
    spawnBudgetOperation: { kind: 'reset', requireInactive: true }, suppressDequeue: true, preserveRetryBudget: true,
  });
  expect(saved).toMatchObject({ status: 'pending', metadata: { failureCount: '3', lastErrorCategory: 'test-failure',
    lastFailureAt: '2026-01-01T00:00:00.000Z', existingBranch: 'fix/example', resumedFromAgentId: 'agent-original' } });
  expect(saved.metadata.totalSpawnCount).toBeUndefined();
});

it('holds a reconciled spawn budget until an explicit reset, even against stale metadata', async () => {
  const task = await addTask({ id: 'sys-reconcile-hold', description: 'Reconcile fixture' }, 'internal');
  const reconciled = await updateTask(task.id, { metadata: { totalSpawnCount: 2 } }, 'internal',
    { spawnBudgetOperation: { kind: 'reconcile' } });
  expect(reconciled.metadata.spawnBudgetReconciledHold).toBe('true');
  const stale = await updateTask(task.id, { metadata: { ...task.metadata, spawnBudgetReconciledHold: undefined } }, 'internal');
  expect(stale.metadata.spawnBudgetReconciledHold).toBe('true');
  const reset = await updateTask(task.id, { metadata: { totalSpawnCount: undefined } }, 'internal',
    { spawnBudgetOperation: { kind: 'reset' } });
  expect(reset.metadata.spawnBudgetReconciledHold).toBeUndefined();
});

describe('in-memory runner agents count as competing task owners', () => {
  afterEach(() => { activeAgents.clear(); runnerAgents.clear(); });

  it('refuses an inactive-required recovery while the owner itself still runs in memory', async () => {
    await seed('user', [{ id: 'task-inactive-mem', status: 'pending', priority: 'MEDIUM', description: 'Work', metadata: {} }]);
    const options = { recoveryOwner: { id: 'agent-owner', startedAt: null, requireInactive: true } };
    runnerAgents.set('agent-owner', { taskId: 'task-inactive-mem' });
    expect(await updateTask('task-inactive-mem', { description: 'Edit' }, 'user', options)).toMatchObject({ statusChanged: true });
    runnerAgents.clear();
    activeAgents.set('agent-owner', { task: { id: 'task-inactive-mem' } });
    expect(await updateTask('task-inactive-mem', { description: 'Edit' }, 'user', options)).toMatchObject({ statusChanged: true });
    activeAgents.clear();
    expect(await updateTask('task-inactive-mem', { description: 'Edit' }, 'user', options)).toMatchObject({ description: 'Edit' });
  });

  it('refuses a recovery-owner write while another in-memory runner holds the task', async () => {
    await seed('user', [{ id: 'task-competing-mem', status: 'pending', priority: 'MEDIUM', description: 'Work', metadata: {} }]);
    const options = { recoveryOwner: { id: 'agent-owner', startedAt: 'start' } };
    runnerAgents.set('agent-owner', { taskId: 'task-competing-mem' });
    runnerAgents.set('agent-other', { task: { id: 'task-competing-mem' } });
    expect(await updateTask('task-competing-mem', { description: 'Edit' }, 'user', options)).toMatchObject({ statusChanged: true });
    runnerAgents.delete('agent-other');
    expect(await updateTask('task-competing-mem', { description: 'Edit' }, 'user', options)).toMatchObject({ description: 'Edit' });
  });

  it('refuses dispatch and completion proofs while another in-memory runner holds the task', async () => {
    const task = await addTask({ id: 'sys-proof-mem', description: 'Proof fixture' }, 'internal');
    const at = '2026-01-01T00:00:00.000Z';
    const claim = { status: 'in_progress', metadata: { totalSpawnCount: 1, claimedBy: 'instance-example', claimedAt: at, lastSpawnedAt: at } };
    const dispatch = { spawnBudgetOperation: { kind: 'dispatch', agentId: 'agent-first', startedAt: at } };
    mock.state.agents['agent-first'] = { id: 'agent-first', taskId: task.id, status: 'running', startedAt: at };
    runnerAgents.set('agent-first', { taskId: task.id });
    runnerAgents.set('agent-other', { taskId: task.id });
    expect(await updateTask(task.id, claim, 'internal', dispatch)).toEqual({ error: 'Cannot establish spawn budget dispatch proof' });
    runnerAgents.delete('agent-other');
    const latest = await updateTask(task.id, claim, 'internal', dispatch);
    const proof = latest.metadata.spawnBudgetProof;
    mock.state.agents['agent-first'].metadata = { completionTaskDispatch: { taskId: task.id, taskType: 'internal', spawnBudgetEpoch: proof.epoch,
      spawnBudgetStartedAt: at, expected: ['claimedBy', 'claimedAt', 'lastSpawnedAt', 'totalSpawnCount'].map(key => [key, latest.metadata[key]]) } };
    const completion = { expectedStatus: 'in_progress', spawnBudgetOperation: { kind: 'completion', agentId: 'agent-first', epoch: proof.epoch } };
    activeAgents.set('agent-other', { task: { id: task.id } });
    expect(await updateTask(task.id, { status: 'completed' }, 'internal', completion)).toMatchObject({ statusChanged: true, task: { status: 'in_progress' } });
    activeAgents.clear();
    expect(await updateTask(task.id, { status: 'completed' }, 'internal', completion)).toMatchObject({ status: 'completed' });
  });
});

it('wakes the exact local parent from a persisted completed-follow-up edit', async () => {
  const { cosEvents } = await import('./cosEvents.js');
  const { getAgentRecord } = await import('./cosAgentLifecycle.js');
  const identity = await import('./instanceIdentity.js');
  const instanceId = 'fixture-local';
  const localIdentity = vi.spyOn(identity, 'getInstanceId').mockResolvedValue(instanceId);
  const { bindCompletionRetirementEvents } = await import('./agentRepoStateVerification.js');
  getAgentRecord.mockClear();
  getAgentRecord.mockResolvedValue({ id: 'original-agent', taskId: 'original-task', status: 'completed',
    metadata: { instanceId } });
  await seed('internal', [{ id: 'sys-delivery', description: 'Completed delivery', status: 'completed', priority: 'MEDIUM',
    metadata: { reviewLoopFollowUp: true, sourceAgentId: 'original-agent', sourceTaskId: 'original-task' } }]);
  const unbind = bindCompletionRetirementEvents(cosEvents);
  try {
    await updateTask('sys-delivery', { priority: 'MEDIUM' }, 'internal');
    // The listener binds the parent, then the real resume entry reads it again.
    // This completed no-cleanup record then safely stands down.
    await vi.waitFor(() => expect(getAgentRecord).toHaveBeenCalledTimes(2));
    expect(getAgentRecord.mock.calls).toEqual([['original-agent'], ['original-agent']]);
    expect((await getTaskById('sys-delivery')).status).toBe('completed');
  } finally { unbind(); localIdentity.mockRestore(); }
});

describe('forge maintenance queue recovery', () => {
  const queue = async (id, metadata, status = 'pending') => {
    await addTask({ id, description: `Maintenance ${id}`, priority: 'LOW', status: 'pending', metadata }, 'internal', { raw: true });
    if (status !== 'pending') await updateTask(id, { status }, 'internal');
  };
  const block = { blockedCategory: 'provider-config', blockedReason: LEGACY_FORGE_MAINTENANCE_REASON };

  it('recovers screened refusals and retires unscreened prompts without authorizing them', async () => {
    await queue('sys-screened', { analysisType: 'pr-watcher', forgeMaintenanceVersion: 1, ...block }, 'blocked');
    await queue('sys-old-pr', { analysisType: 'pr-watcher', app: 'example', ...block }, 'blocked');
    await queue('sys-old-issue', { analysisType: 'issue-reconcile' });
    const result = await reconcileLegacyForgeMaintenanceTasks({ instanceId: 'local' });
    expect(result).toEqual({ recovered: 1, retired: 2 });
    const tasks = (await getCosTasks()).tasks;
    expect(tasks.find(t => t.id === 'sys-screened')).toMatchObject({ status: 'pending', metadata: { forgeMaintenanceVersion: '1' } });
    expect(tasks.find(t => t.id === 'sys-screened').metadata.blockedReason).toBeUndefined();
    for (const id of ['sys-old-pr', 'sys-old-issue']) {
      expect(tasks.find(t => t.id === id)).toMatchObject({ status: 'completed', metadata: { resolution: 'superseded' } });
      expect(tasks.find(t => t.id === id).metadata.forgeMaintenanceVersion).toBeUndefined();
    }
    expect(persistPrWatcherState).toHaveBeenCalledWith('example', { activityByPr: {} });
    expect(await reconcileLegacyForgeMaintenanceTasks({ instanceId: 'local' })).toEqual({ recovered: 0, retired: 0 });
  });

  it('preserves active owners, user holds, other configuration failures, and future versions', async () => {
    mock.state.agents = { running: { taskId: 'sys-owned', status: 'running' } };
    await queue('sys-owned', { analysisType: 'pr-watcher' });
    await queue('sys-running', { analysisType: 'issue-reconcile' }, 'in_progress');
    await queue('sys-stopped', { analysisType: 'pr-watcher', blockedCategory: 'user-terminated' }, 'blocked');
    await queue('sys-config', { analysisType: 'pr-watcher', ...block, blockedReason: 'Provider unavailable' }, 'blocked');
    await queue('sys-future', { analysisType: 'pr-watcher', forgeMaintenanceVersion: 2 });
    await queue('sys-current', { analysisType: 'pr-watcher', forgeMaintenanceVersion: 1 });
    await queue('sys-peer', { analysisType: 'pr-watcher', targetInstanceId: 'peer' });
    const before = (await getCosTasks()).tasks;
    expect(await reconcileLegacyForgeMaintenanceTasks({ instanceId: 'local' })).toEqual({ recovered: 0, retired: 0 });
    expect((await getCosTasks()).tasks).toEqual(before);
  });
});

describe('cosTaskStore.firstLine', () => {
  it('returns the first non-empty trimmed line', () => {
    expect(firstLine('hello\nworld')).toBe('hello');
    expect(firstLine('\n\n  first  \nsecond')).toBe('first');
    expect(firstLine('single')).toBe('single');
  });

  it('returns empty string for null/undefined/empty input', () => {
    expect(firstLine(null)).toBe('');
    expect(firstLine(undefined)).toBe('');
    expect(firstLine('')).toBe('');
    expect(firstLine('\n\n\n')).toBe('');
  });
});

describe('cosTaskStore.updateTask expectedStatus', () => {
  it('keeps extended Deep retry cleanup owned and preserves its retained branch', async () => {
    await addTask({ id: 'sys-deep-cleanup', description: 'Deep audit' }, 'internal');
    await updateTask('sys-deep-cleanup', { status: 'in_progress', metadata: {
      auditDepth: 'deep', auditWorkflow: 'extended-v1', retryPendingCleanup: 'agent-current',
      existingBranch: 'cos/retained', resumedFromAgentId: 'agent-current', resumeWorktreePath: '/fixture/retained',
    } }, 'internal');
    expect(isReapableBlockedFailure(await getTaskById('sys-deep-cleanup'))).toBe(false);
    expect(await reviveBlockedTask('sys-deep-cleanup', {}, 'internal')).toMatchObject({ error: expect.stringContaining('cleanup') });
    const patch = { status: 'blocked', metadata: { retryPendingCleanup: undefined, blockedCategory: 'deep-audit-partial', existingBranch: 'cos/retained' } };
    expect(await updateTask('sys-deep-cleanup', patch, 'internal', {
      expectedStatus: 'in_progress', expectedMetadata: { retryPendingCleanup: 'agent-old' },
    })).toMatchObject({ statusChanged: true });
    expect((await getTaskById('sys-deep-cleanup')).metadata.retryPendingCleanup).toBe('agent-current');
    await updateTask('sys-deep-cleanup', patch, 'internal', {
      expectedStatus: 'in_progress', expectedMetadata: { retryPendingCleanup: 'agent-current' },
    });
    const resumed = await reviveBlockedTask('sys-deep-cleanup', {}, 'internal');
    expect(resumed).toMatchObject({ status: 'pending', metadata: {
      existingBranch: 'cos/retained', resumedFromAgentId: 'agent-current', resumeWorktreePath: '/fixture/retained',
    } });
  });

  it('releases an extended Deep retry through the real persisted adapter, preserving the branch', async () => {
    const { releaseRetryHold } = await import('./agentWorktreeCleanup.js');
    await addTask({ id: 'sys-extended-retry', description: 'Example audit' }, 'internal');
    const task = await updateTask('sys-extended-retry', { status: 'in_progress', metadata: {
      auditDepth: 'deep', auditWorkflow: 'extended-v1', retryPendingCleanup: 'agent-owner',
      retryPendingSince: '2026-01-01T00:00:00.000Z', existingBranch: 'cos/retained',
    } }, 'internal');
    expect(await updateTask(task.id, { status: 'pending', metadata: { retryPendingCleanup: undefined } }, 'internal'))
      .toMatchObject({ error: expect.stringContaining('cleanup') });
    const patch = { status: 'pending', metadata: { retryPendingCleanup: undefined } };
    expect(await updateTask(task.id, patch, 'internal', {
      expectedStatus: 'in_progress', expectedMetadata: { retryPendingCleanup: 'agent-stale' },
    })).toMatchObject({ statusChanged: true });
    await releaseRetryHold({ agentId: 'agent-owner', task: { ...task, taskType: 'internal' }, success: false, agentMetadata: {} });
    const persisted = await getTaskById(task.id);
    expect(persisted).toMatchObject({ status: 'pending', metadata: { existingBranch: 'cos/retained', auditWorkflow: 'extended-v1' } });
    expect(persisted.metadata).not.toHaveProperty('retryPendingCleanup');
    expect(persisted.metadata).not.toHaveProperty('retryPendingSince');
    expect(mock.events).toContainEqual(expect.objectContaining({ name: 'tasks:changed', payload: expect.objectContaining({ action: 'requeued' }) }));
  });

  it('does not apply a stale terminal update after a task has been claimed', async () => {
    const task = await addTask({ id: 'sys-rl-cas', description: 'Resolve a PR' }, 'internal');
    await updateTask(task.id, { status: 'in_progress' }, 'internal');
    mock.events = [];

    const result = await updateTask(task.id, {
      status: 'completed', metadata: { reviewLoopRetiredReason: 'pull-request-merged-before-follow-up' },
    }, 'internal', { expectedStatus: 'pending' });

    expect(result).toMatchObject({ statusChanged: true, task: { status: 'in_progress' } });
    expect((await getTaskById(task.id)).status).toBe('in_progress');
    expect(mock.events).toEqual([]);
  });
});

describe('cosTaskStore.getUserTasks / getCosTasks', () => {
  it('returns an empty result for an empty queue', async () => {
    const result = await getUserTasks();
    expect(result.tasks).toEqual([]);
    expect(result.type).toBe('user');
  });

  it('returns an added user task in stored form', async () => {
    await addTask({ description: 'do a thing', priority: 'HIGH' }, 'user');
    const result = await getUserTasks();
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].description).toBe('do a thing');
    expect(result.tasks[0].priority).toBe('HIGH');
  });

  it('round-trips explicit Standard across task persistence and retry without adding a default tier', async () => {
    const created = await addTask({ description: 'Explicit execution request', provider: 'codex', executionOptions: { serviceTier: 'standard' } }, 'user');
    __resetTaskCache();
    expect((await getTaskById(created.id)).metadata.executionOptions).toEqual({ serviceTier: 'standard' });
    await updateTask(created.id, { status: 'pending', metadata: { retryCount: 1 } }, 'user');
    __resetTaskCache();
    expect((await getTaskById(created.id)).metadata.executionOptions).toEqual({ serviceTier: 'standard' });
    const ordinary = await addTask({ description: 'Existing default behavior' }, 'user');
    expect(ordinary.metadata).not.toHaveProperty('executionOptions');
  });

  it('retains an inbox account binding through normal task intake and a fresh persisted read', async () => {
    const binding = { accountId: 'inbox-b', host: 'github.com', login: 'inbox-user', origin: 'user' };
    const created = await addTask({ description: 'Resolve an example inbox thread', metadata: {
      githubNotificationAccount: binding,
      githubNotificationResolve: { accountId: binding.accountId, host: binding.host, threadId: '123' },
    } }, 'user');
    expect((await stored('user')).find(task => task.id === created.id).metadata.githubNotificationAccount).toEqual(binding);
    __resetTaskCache();
    expect((await getTaskById(created.id)).metadata.githubNotificationAccount).toEqual(binding);
  });

  it('surfaces autoApproved + awaitingApproval buckets for internal tasks', async () => {
    await addTask({ description: 'auto sys', approvalRequired: false }, 'internal');
    await addTask({ description: 'needs approval', approvalRequired: true }, 'internal');
    const result = await getCosTasks();
    expect(result.type).toBe('internal');
    expect(result.autoApproved.some(t => t.description === 'auto sys')).toBe(true);
    expect(result.awaitingApproval.some(t => t.description === 'needs approval')).toBe(true);
  });
});

// Working-set cache (#3497). The daemon's evaluation tick re-reads both queues
// many times a minute; these pin that an unchanged queue is loaded once, that
// every invalidation signal fires, and that a cached read can never leak a
// caller's in-place mutations into the next reader.
describe('cosTaskStore working-set cache (#3497)', () => {
  const gate = () => Promise.withResolvers();
  const task = (n, extra = {}) => ({ id: `task-example-${String(n).padStart(4, '0')}`, description: `Example task ${n}`, status: 'pending', priority: 'MEDIUM', priorityValue: 2, approvalRequired: false, autoApproved: true, metadata: {}, ...extra });

  it('reads telemetry without cloning prompts and keeps metrics fresh after task writes and out-of-band changes', async () => {
    const now = Date.parse('2026-07-09T12:00:00Z');
    expect(await getTaskDiagnostics()).toEqual([]);
    const tasks = Array.from({ length: 300 }, (_, index) => task(index, {
      metadata: {
        prompt: 'Example prompt. '.repeat(512),
        updatedAt: '2026-07-09T11:00:00Z',
        ...(index % 30 === 0 ? { diagnostics: { tier: 1, category: 'config', observedAt: '2026-07-09T10:00:00Z' } } : {})
      }
    }));
    await seed('user', tasks.slice(0, 150));
    await seed('internal', tasks.slice(150));
    const { user, cos } = await getAllTasks();
    const expected = aggregateAutoFixDiagnostics([...user.tasks, ...cos.tasks], { now });
    const clone = vi.spyOn(globalThis, 'structuredClone');
    expect(await getAutoFixMetrics({ now })).toEqual(expected);
    const projectedBytes = JSON.stringify(clone.mock.calls[0][0]).length;
    expect(projectedBytes).toBeLessThan(JSON.stringify([...user.tasks, ...cos.tasks]).length / 100);
    expect(clone.mock.calls[0][0]).toHaveLength(10);
    const loads = mock.loads;
    const projection = await getTaskDiagnostics();
    projection[0].metadata.diagnostics.tier = 99;
    expect(await getAutoFixMetrics({ now })).toEqual(expected);
    expect(mock.loads).toBe(loads);
    clone.mockRestore();

    await updateTask('task-example-0000', { status: 'completed' }, 'user');
    expect((await getAutoFixMetrics({ now })).overall.resolved).toBe(1);
    await seed('internal', (await stored('internal')).map((t, i) => (i === 0 ? { ...t, status: 'completed' } : t)));
    expect((await getAutoFixMetrics({ now })).overall.resolved).toBe(2);
    await seed('user', []);
    expect((await getAutoFixMetrics({ now })).total).toBe(5);
    await seed('internal', []);
    expect((await getAutoFixMetrics({ now })).total).toBe(0);
  });

  it('projects pending IDs without cloning task payloads and refreshes after writes and out-of-band changes', async () => {
    expect(await getPendingTaskIds()).toEqual([]);
    const user = await addTask({ description: 'Example user task' }, 'user');
    const internal = await addTask({ description: 'Example internal task' }, 'internal');
    const clone = vi.spyOn(globalThis, 'structuredClone');
    const ids = await getPendingTaskIds();
    expect(ids).toEqual([user.id, internal.id]);
    ids.push('caller-only');
    const loads = mock.loads;
    expect(await getPendingTaskIds()).toEqual([user.id, internal.id]);
    expect(mock.loads).toBe(loads);
    expect(clone).not.toHaveBeenCalled();
    clone.mockRestore();

    await updateTask(user.id, { status: 'completed' }, 'user');
    expect(await getPendingTaskIds()).toEqual([internal.id]);
    await seed('internal', (await stored('internal')).map((t) => ({ ...t, status: 'completed' })));
    expect(await getPendingTaskIds()).toEqual([]);
    await seed('user', []);
    expect(await getPendingTaskIds()).toEqual([]);
  });

  it('projects approval state without cloning the queue and refreshes after writes', async () => {
    expect(await getCosApprovalView()).toEqual({ awaitingApproval: [], autoApprovedCount: 0 });
    await addTask({ description: 'auto sys', approvalRequired: false }, 'internal');
    await addTask({ description: 'needs approval', approvalRequired: true }, 'internal');
    await addTask({ description: 'also needs approval', approvalRequired: true }, 'internal');

    const expectedFirst = (await getCosTasks()).awaitingApproval[0].id;
    const clone = vi.spyOn(globalThis, 'structuredClone');
    let view;
    let clonedPayload;
    try { view = await getCosApprovalView({ limit: 1 }); clonedPayload = clone.mock.calls[0]?.[0]; } finally { clone.mockRestore(); }
    expect(view.autoApprovedCount).toBe(1);
    expect(view.awaitingApproval.map(t => t.id)).toEqual([expectedFirst]);
    // Only the returned page is cloned, never the whole queue.
    expect(clonedPayload).toHaveLength(1);

    view.awaitingApproval[0].description = 'caller edit';
    expect((await getCosApprovalView()).awaitingApproval[0].description).toBe('needs approval');

    await addTask({ description: 'third approval', approvalRequired: true }, 'internal');
    expect((await getCosApprovalView({ limit: 10 })).awaitingApproval).toHaveLength(3);
  });

  it('serves a cached working set while the queue version is unchanged', async () => {
    await addTask({ description: 'cached thing' }, 'user');
    __resetTaskCache();
    mock.loads = 0;

    const first = await getUserTasks();
    expect(mock.loads).toBe(1);

    const second = await getUserTasks();
    expect(mock.loads).toBe(1); // no reload — the queue did not change
    expect(second.tasks).toEqual(first.tasks);
  });

  it('keeps its cache current across the store\'s own writes without reloading', async () => {
    await addTask({ description: 'original' }, 'user');
    const created = (await getUserTasks()).tasks[0];
    mock.loads = 0;

    await updateTask(created.id, { description: 'rewritten' }, 'user');
    await addTask({ description: 'second' }, 'user');
    expect((await getUserTasks()).tasks.map((t) => t.description).sort()).toEqual(['rewritten', 'second']);
    expect(mock.loads).toBe(0);
  });

  it('coalesces concurrent task views after cold and out-of-band changed queues', async () => {
    await addTask({ description: 'user task' }, 'user');
    await addTask({ description: 'internal task' }, 'internal');
    __resetTaskCache();
    mock.loads = 0;

    const views = await Promise.all(Array.from({ length: 24 }, () => getTaskView({ kind: 'bare' })));
    expect(mock.loads).toBe(2);
    views[0].user.tasks[0].description = 'caller mutation';
    expect(views[1].user.tasks[0].description).toBe('user task');

    await seed('user', (await stored('user')).map((t) => ({ ...t, description: 'edited task' })));
    mock.loads = 0;
    const changed = await Promise.all(Array.from({ length: 24 }, () => getTaskView({ kind: 'bare' })));
    expect(mock.loads).toBe(2);
    expect(changed.every(view => view.user.tasks[0].description === 'edited task')).toBe(true);
  });

  it('retries shared load failures on the next task view request', async () => {
    await addTask({ description: 'readable again' }, 'user');
    __resetTaskCache();
    vi.mocked(repository.loadTaskWorkingSet).mockClear().mockRejectedValueOnce(new Error('temporary read failure'));
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => getUserTasks()));
    expect(attempts.every(result => result.status === 'rejected' && result.reason.message === 'temporary read failure')).toBe(true);
    expect(repository.loadTaskWorkingSet).toHaveBeenCalledTimes(1);
    expect((await getUserTasks()).tasks[0].description).toBe('readable again');
    expect(repository.loadTaskWorkingSet).toHaveBeenCalledTimes(2);
  });

  it('preserves an out-of-band change when an update starts after an older read captured the queue', async () => {
    const created = await addTask({ description: 'original', metadata: { context: 'before edit' } }, 'user');
    __resetTaskCache();
    const older = await actualRepository.loadTaskWorkingSet('user');
    const reading = gate();
    const finishRead = gate();
    vi.mocked(repository.loadTaskWorkingSet).mockImplementationOnce(async () => {
      reading.resolve();
      await finishRead.promise;
      return older;
    });
    const olderRead = getUserTasks();
    await reading.promise;
    await seed('user', older.rows.map((row) => ({ ...row.task, metadata: { ...row.task.metadata, context: 'external edit' } })));

    const update = updateTask(created.id, { description: 'API edit' }, 'user');
    // Releasing the old read must not make a newer update overwrite the other writer.
    finishRead.resolve();
    expect((await olderRead).tasks[0].metadata.context).toBe('before edit');
    expect((await update).metadata.context).toBe('external edit');
    expect((await getUserTasks()).tasks[0]).toMatchObject({
      description: 'API edit', metadata: { context: 'external edit' }
    });
  });

  it('keeps a read overlapping a write from capturing or poisoning post-write readers', async () => {
    const created = await addTask({ description: 'original' }, 'user');
    await getUserTasks();
    const before = await actualRepository.loadTaskWorkingSet('user');
    const writing = gate();
    const finishWrite = gate();
    vi.mocked(repository.applyTaskListSave).mockImplementationOnce(async (source, plan) => {
      writing.resolve();
      await finishWrite.promise;
      return actualRepository.applyTaskListSave(source, plan);
    });
    const write = updateTask(created.id, { description: 'REWRITTN' }, 'user');
    await writing.promise;

    // A reader that misses the cache while the write is still uncommitted loads the old rows.
    __resetTaskCache();
    const reading = gate();
    const finishRead = gate();
    vi.mocked(repository.loadTaskWorkingSet).mockImplementationOnce(async () => {
      reading.resolve();
      await finishRead.promise;
      return before;
    });
    const overlappingRead = getUserTasks();
    await reading.promise;
    finishWrite.resolve();
    await write;
    // Post-write readers must neither join the old load nor consume its eventual snapshot.
    expect((await getUserTasks()).tasks[0].description).toBe('REWRITTN');
    finishRead.resolve();
    expect((await overlappingRead).tasks[0].description).toBe('original');
    expect((await getUserTasks()).tasks[0].description).toBe('REWRITTN');
  });

  it('reloads after an out-of-band write bumps the queue version', async () => {
    await addTask({ description: 'first' }, 'user');
    await getUserTasks();
    mock.loads = 0;

    await seed('user', (await stored('user')).map((t) => ({ ...t, description: 'edited outside the store' })));
    mock.loads = 0;

    const after = await getUserTasks();
    expect(mock.loads).toBe(1);
    expect(after.tasks[0].description).toBe('edited outside the store');
  });

  it('invalidates on deleteTask so the removed task never comes back cached', async () => {
    const created = await addTask({ description: 'doomed' }, 'user');
    expect((await getUserTasks()).tasks).toHaveLength(1);

    await deleteTask(created.id, 'user');
    expect((await getUserTasks()).tasks).toHaveLength(0);
  });

  it('invalidates on mergePeerTasks so a merged peer task is visible immediately', async () => {
    await addTask({ description: 'local one', id: 'task-local' }, 'user');
    await getUserTasks();

    await mergePeerTasks('user', [{
      id: 'task-remote',
      description: 'remote one',
      status: 'pending',
      priority: 'MEDIUM',
      metadata: { updatedAt: new Date(Date.now()).toISOString() }
    }]);

    const after = await getUserTasks();
    expect(after.tasks.some(t => t.id === 'task-remote')).toBe(true);
  });

  it('hands every reader its own copy, so mutating one result cannot poison the cache', async () => {
    await addTask({ description: 'pristine' }, 'user');

    const first = await getUserTasks();
    first.tasks[0].description = 'mutated in place';
    first.tasks[0].metadata.injected = 'nope';
    first.tasks.push({ id: 'task-ghost' });

    const second = await getUserTasks();
    expect(second.tasks).toHaveLength(1);
    expect(second.tasks[0].description).toBe('pristine');
    expect(second.tasks[0].metadata.injected).toBeUndefined();
  });
});

// Bounded task views (#9677). The HTTP queue/bare/completed/window reads select
// from the parsed snapshot BEFORE cloning, so archived prompt bodies are never
// copied for a response that does not carry them. Each view is checked against a
// projection of the raw getAllTasks() truth (the contract the route used to build
// itself) plus the instrumented size of what was actually cloned.
describe('cosTaskStore.getTaskView (#9677)', () => {
  const PROMPT = Array(400).fill('Archived prompt body.').join(' ');
  const row = (type, n, status, extra = {}) => ({
    id: `task-${type}-${String(n).padStart(4, '0')}`, description: `Example ${type} task ${n}`, status, priority: 'MEDIUM',
    metadata: { prompt: status === 'completed' ? PROMPT : 'Open prompt.' }, ...extra
  });
  const seedViews = async (completedPerSource = 60) => {
    const completed = (type) => Array.from({ length: completedPerSource }, (_, n) => row(type, n, 'completed'));
    await seed('user', [
      row('user', 1000, 'pending'), ...completed('user'), row('user', 1001, 'in_progress'), row('user', 1002, 'blocked'),
    ]);
    await seed('internal', [
      row('cos', 1000, 'pending', { approvalRequired: false, autoApproved: true }), ...completed('cos'),
      row('cos', 1001, 'pending', { approvalRequired: true, autoApproved: false }),
    ]);
  };
  const desc = (a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  const withSpy = async (fn) => {
    const clone = vi.spyOn(globalThis, 'structuredClone');
    try {
      const result = await fn();
      const cloned = clone.mock.calls.reduce((sum, [value]) => sum + JSON.stringify(value).length, 0);
      return { result, cloned };
    } finally { clone.mockRestore(); }
  };

  it('bare view equals the raw store minus completed rows beyond the first page, and clones only the open queue', async () => {
    await seedViews();
    const raw = await getAllTasks();
    const { result, cloned } = await withSpy(() => getTaskView({ kind: 'bare' }));
    for (const key of ['user', 'cos']) {
      const all = raw[key];
      const open = all.tasks.filter(t => t.status !== 'completed');
      const page = all.tasks.filter(t => t.status === 'completed').sort(desc).slice(0, 25);
      expect(result[key]).toEqual({
        ...all, tasks: [...open, ...page], completedCount: 60, completedNextCursor: page[24].id,
        grouped: { ...all.grouped, completed: [] },
        ...(key === 'cos' ? { autoApproved: all.autoApproved, awaitingApproval: all.awaitingApproval } : {}),
      });
    }
    // The completed page is read straight from the table; only the few open rows are cloned.
    expect(cloned).toBeLessThan(JSON.stringify(raw).length * 0.05);
  });

  it('queue view clones no completed prompt unless one is selected, then exactly that row', async () => {
    await seedViews();
    const raw = await getAllTasks();
    const queue = await withSpy(() => getTaskView({ kind: 'queue' }));
    expect(queue.result.user.tasks.map(t => t.id)).toEqual(['task-user-1000', 'task-user-1001', 'task-user-1002']);
    expect(queue.result.user.completedCount).toBe(60);
    expect(queue.result.user.grouped.completed).toEqual([]);
    expect(queue.result.cos.awaitingApproval.map(t => t.id)).toEqual(['task-cos-1001']);
    expect(queue.cloned).toBeLessThan(JSON.stringify(raw.user.tasks.slice(0, 4)).length * 4);
    expect(JSON.stringify(queue.result)).not.toContain('Archived prompt body');

    const picked = await getTaskView({ kind: 'queue', selected: 'task-user-0007' });
    // Queue order is kept: the selected completed row stays where the queue puts it.
    expect(picked.user.tasks.map(t => t.id)).toEqual(raw.user.tasks.filter(t => t.status !== 'completed' || t.id === 'task-user-0007').map(t => t.id));
    expect(picked.user.grouped.completed.map(t => t.id)).toEqual(['task-user-0007']);
    expect(picked.user.tasks.find(t => t.id === 'task-user-0007')).toEqual(raw.user.tasks.find(t => t.id === 'task-user-0007'));
    expect(picked.cos.tasks.every(t => t.status !== 'completed')).toBe(true);
  });

  it('completed view reads one source, pages by cursor, and clones nothing from the cache', async () => {
    await seedViews();
    const raw = await getAllTasks();
    const expectedIds = raw.cos.tasks.filter(t => t.status === 'completed').sort(desc).map(t => t.id);
    const first = await withSpy(() => getTaskView({ kind: 'completed', source: 'internal', limit: 10 }));
    expect(first.result.items.map(t => t.id)).toEqual(expectedIds.slice(0, 10));
    expect(first.result).toMatchObject({ total: 60, nextCursor: expectedIds[9] });
    expect(first.cloned).toBe(0);
    const next = await getTaskView({ kind: 'completed', source: 'internal', limit: 10, cursor: first.result.nextCursor });
    expect(next.items.map(t => t.id)).toEqual(expectedIds.slice(10, 20));
    const tail = await getTaskView({ kind: 'completed', source: 'user', limit: 100, cursor: 'task-user-0003' });
    expect(tail).toMatchObject({ total: 60, nextCursor: null });
    expect(tail.items.map(t => t.id)).toEqual(['task-user-0002', 'task-user-0001', 'task-user-0000']);
  });

  it('serves completed history older than the working set by page, count and selection', async () => {
    await seedViews(130);
    // Undated completed tasks count as oldest: the working set keeps the newest 100 by id.
    const { user } = await getAllTasks();
    expect(user.tasks.filter(t => t.status === 'completed')).toHaveLength(100);
    expect(user.tasks.some(t => t.id === 'task-user-0000')).toBe(false);

    const oldest = await getTaskView({ kind: 'completed', source: 'user', limit: 100, cursor: 'task-user-0030' });
    expect(oldest.items.map(t => t.id)).toEqual(Array.from({ length: 30 }, (_, n) => `task-user-${String(29 - n).padStart(4, '0')}`));
    expect(oldest.total).toBe(130);
    expect(oldest.items[0].metadata.prompt).toBe(PROMPT);

    const picked = await getTaskView({ kind: 'queue', selected: 'task-user-0002' });
    expect(picked.user.completedCount).toBe(130);
    expect(picked.user.tasks.find(t => t.id === 'task-user-0002')).toMatchObject({ status: 'completed', metadata: { prompt: PROMPT } });
    expect((await getTaskView({ kind: 'bare' })).user.completedNextCursor).toBe('task-user-0105');
  });

  it('window view slices the working set in queue order with true totals and scalar metadata only', async () => {
    await seedViews();
    const raw = await getAllTasks();
    const { result, cloned } = await withSpy(() => getTaskView({ kind: 'window', offset: 2, limit: 3 }));
    expect(result.user).toEqual({ type: 'user', tasks: raw.user.tasks.slice(2, 5) });
    expect(result.cos.tasks).toEqual(raw.cos.tasks.slice(2, 5));
    expect(result.totals).toEqual({ user: raw.user.tasks.length, cos: raw.cos.tasks.length });
    expect(cloned).toBeLessThan(JSON.stringify(raw).length / 10);
  });

  it('empty queues keep the getUserTasks/getCosTasks shape', async () => {
    const raw = await getAllTasks();
    const bare = await getTaskView({ kind: 'bare' });
    expect(bare.user).toMatchObject({ tasks: [], type: 'user', completedCount: 0, completedNextCursor: null });
    expect(bare.cos.autoApproved).toEqual([]);
    expect(raw.cos.autoApproved).toEqual([]);
    expect((await getTaskView({ kind: 'queue' })).cos.completedCount).toBe(0);
    expect(await getTaskView({ kind: 'completed', source: 'user', limit: 5 })).toEqual({ items: [], total: 0, nextCursor: null });
    expect((await getTaskView({ kind: 'window', offset: 0, limit: 5 })).totals).toEqual({ user: 0, cos: 0 });
  });

  it('never leaks the cache: caller mutation, internal writes and out-of-band changes', async () => {
    await seedViews(30);
    const first = await getTaskView({ kind: 'bare' });
    first.user.tasks[0].description = 'mutated in place';
    first.user.tasks.push({ id: 'ghost' });
    first.user.grouped.pending.length = 0;
    const page = await getTaskView({ kind: 'completed', source: 'user', limit: 5 });
    page.items[0].metadata.prompt = 'poisoned';

    const again = await getTaskView({ kind: 'bare' });
    expect(again.user.tasks.find(t => t.id === 'ghost')).toBeUndefined();
    expect(again.user.tasks[0].description).toBe('Example user task 1000');
    expect(again.user.grouped.pending).toHaveLength(1);
    expect((await getTaskView({ kind: 'completed', source: 'user', limit: 5 })).items[0].metadata.prompt).toBe(PROMPT);

    // Internal write: the derived partitions drop with the snapshot.
    await updateTask('task-user-1000', { status: 'completed' }, 'user');
    const written = await getTaskView({ kind: 'queue' });
    expect(written.user.tasks.map(t => t.id)).toEqual(['task-user-1001', 'task-user-1002']);
    expect(written.user.completedCount).toBe(31);

    // Out-of-band change (another writer flips a status): the version bump drops the snapshot.
    await seed('user', (await stored('user')).map(t => (t.id === 'task-user-1001' ? { ...t, status: 'completed' } : t)));
    const external = await getTaskView({ kind: 'queue' });
    expect(external.user.tasks.map(t => t.id)).toEqual(['task-user-1002']);
    expect(external.user.completedCount).toBe(32);
  });
});

describe('cosTaskStore.getAllTasks / getTasks / getTaskById', () => {
  it('getTasks aliases getUserTasks', () => {
    expect(getTasks).toBe(getUserTasks);
  });

  it('getAllTasks merges user + internal sources', async () => {
    await addTask({ description: 'u1' }, 'user');
    await addTask({ description: 's1', approvalRequired: false }, 'internal');
    const all = await getAllTasks();
    expect(all.user.tasks).toHaveLength(1);
    expect(all.cos.tasks).toHaveLength(1);
  });

  it('getTaskById finds a user task and tags taskType', async () => {
    const created = await addTask({ description: 'find me', id: 'task-find' }, 'user');
    const found = await getTaskById(created.id);
    expect(found.id).toBe(created.id);
    expect(found.taskType).toBe('user');
  });

  it('getTaskById finds an internal task and tags taskType', async () => {
    const created = await addTask({ description: 'sys task', id: 'sys-task', approvalRequired: false }, 'internal');
    const found = await getTaskById(created.id);
    expect(found.taskType).toBe('internal');
  });

  it('looks up one task without cloning either backlog, and isolates returned metadata', async () => {
    const tasks = Array.from({ length: 1000 }, (_, index) => ({
      id: `task-${index}`, description: `Example task ${index}`, status: 'pending',
      priority: 'MEDIUM', metadata: { prompt: 'Example prompt', reviewers: ['codex'] }
    }));
    await seed('user', tasks);
    mock.loads = 0;
    const clone = vi.spyOn(globalThis, 'structuredClone');
    const found = await getTaskById('task-999');
    expect(clone.mock.calls.map(([value]) => value.id)).toEqual(['task-999']);
    clone.mockRestore();
    found.metadata.reviewers.push('changed');
    expect((await getTaskById('task-999')).metadata.reviewers).toEqual(['codex']);
    expect(mock.loads).toBe(1);
  });

  it('prefers the user queue when both queues hold the id, and falls back to the internal one', async () => {
    const task = { id: 'sys-legacy', description: 'first', status: 'pending', priority: 'HIGH', metadata: {} };
    await seed('user', [task]);
    await seed('internal', [{ ...task, description: 'internal' }]);
    expect(await getTaskById(task.id)).toMatchObject({ description: 'first', taskType: 'user' });
    await deleteTask(task.id, 'user');
    expect(await getTaskById(task.id)).toMatchObject({ description: 'internal', taskType: 'internal' });
  });

  it('invalidates the ID index after store mutations, out-of-band changes, and deletion', async () => {
    await addTask({ id: 'task-index', description: 'before' }, 'user');
    expect((await getTaskById('task-index')).description).toBe('before');
    await updateTask('task-index', { description: 'after' }, 'user');
    expect((await getTaskById('task-index')).description).toBe('after');
    await seed('user', (await stored('user')).map((t) => ({ ...t, description: 'external' })));
    expect((await getTaskById('task-index')).description).toBe('external');
    await deleteTask('task-index', 'user');
    expect(await getTaskById('task-index')).toBeNull();
  });

  it('getTaskById returns null when no source has the id', async () => {
    expect(await getTaskById('nope')).toBeNull();
  });
});

describe('cosTaskStore.addTask', () => {
  it('generates a prefixed id, default MEDIUM priority, and emits tasks:changed', async () => {
    const task = await addTask({ description: 'plain' }, 'user');
    expect(task.id.startsWith('task-')).toBe(true);
    expect(task.priority).toBe('MEDIUM');
    expect(task.priorityValue).toBe(PRIORITY_VALUES.MEDIUM);
    expect(task.status).toBe('pending');
    expect(mock.events.some(e => e.name === 'tasks:changed' && e.payload.action === 'added' && e.payload.type === 'user')).toBe(true);
  });

  it('keeps the existing task list intact and surfaces the error when the save fails', async () => {
    await addTask({ description: 'survivor', id: 'task-survivor' }, 'user');
    mock.writeFailure = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    await expect(addTask({ description: 'lost write', id: 'task-lost' }, 'user')).rejects.toThrow('ENOSPC');
    mock.writeFailure = null;
    expect((await getUserTasks()).tasks.map(t => t.id)).toEqual(['task-survivor']);
  });

  it('persists the no-change success marker for an autonomous audit', async () => {
    const created = await addTask({
      description: 'Audit shipped catalogs',
      id: 'catalog-audit-task',
      autonomousJob: true,
      jobId: 'job-refresh-cli-provider-catalogs',
      noChangeSuccess: true,
    }, 'internal');

    expect(created.metadata.noChangeSuccess).toBe(true);
    const reloaded = (await getTaskById(created.id)).metadata.noChangeSuccess;
    expect(reloaded === true || reloaded === 'true').toBe(true);
  });

  it('preserves a trusted metadata seed for replacement task contracts', async () => {
    const issueWatcher = {
      repoFullName: 'example/example',
      issueComments: [],
      pullRequests: [{ number: 7, headSha: 'a'.repeat(40) }],
    };
    const created = await addTask({
      id: 'task-metadata-seed',
      description: 'resume issue watcher',
      metadata: { analysisType: 'issue-watcher', issueWatcher },
    }, 'internal');

    expect(created.metadata).toMatchObject({ analysisType: 'issue-watcher', issueWatcher });
    expect((await getTaskById(created.id)).metadata).toMatchObject({ analysisType: 'issue-watcher', issueWatcher });
  });

  it('marks explicitly dispatched tasks so the scheduler does not race their spawn', async () => {
    const task = await addTask({ description: 'run this now' }, 'internal', { suppressDequeue: true });
    const change = mock.events.find(e => e.name === 'tasks:changed' && e.payload.task?.id === task.id);

    expect(change.payload).toMatchObject({
      type: 'internal',
      action: 'added',
      suppressDequeue: true
    });
  });

  describe('targeted instance pin (#4520)', () => {
    it('persists targetInstanceId and round-trips it through markdown', async () => {
      const created = await addTask({ description: 'gpu work', id: 'task-pin', targetInstanceId: 'instance-bbbb' }, 'user');
      expect(created.metadata.targetInstanceId).toBe('instance-bbbb');
      expect((await getTaskById('task-pin')).metadata.targetInstanceId).toBe('instance-bbbb');
    });

    it('omits the key entirely when unpinned, so the default stays opportunistic', async () => {
      const created = await addTask({ description: 'anywhere', id: 'task-nopin' }, 'user');
      expect('targetInstanceId' in created.metadata).toBe(false);
    });

    it('treats a blank pin as unpinned rather than a target nothing can match', async () => {
      const created = await addTask({ description: 'blank', id: 'task-blankpin', targetInstanceId: '   ' }, 'user');
      expect('targetInstanceId' in created.metadata).toBe(false);
    });

    it('clears the pin when an update passes it as undefined', async () => {
      await addTask({ description: 'repin', id: 'task-repin', targetInstanceId: 'instance-bbbb' }, 'user');
      const cleared = await updateTask('task-repin', { metadata: { targetInstanceId: undefined } }, 'user');
      expect('targetInstanceId' in cleared.metadata).toBe(false);
      expect((await getTaskById('task-repin')).metadata.targetInstanceId).toBeUndefined();
    });
  });

  describe('prompt / context split (#4153)', () => {
    const AGENT_BODY = 'Improve Example App\n\n## Phase 1\nRead PLAN.md.';

    it('routes a multi-line context payload to metadata.prompt and round-trips it through markdown', async () => {
      const created = await addTask({ description: 'Improve Example App', id: 'task-split', context: AGENT_BODY }, 'user');
      expect(created.metadata.prompt).toBe(AGENT_BODY);
      expect(created.metadata.context).toBeUndefined();
      const reloaded = await getTaskById('task-split');
      expect(reloaded.metadata.prompt).toBe(AGENT_BODY);
      expect(reloaded.metadata.context).toBeUndefined();
    });

    it('moves a raw multiline description into metadata.prompt before markdown persistence', async () => {
      const fullPrompt = 'Scheduled review\n\n## Preloaded task data\nCurrent snapshot.';
      const created = await addTask({
        id: 'sys-scheduled-prompt',
        status: 'pending',
        priority: 'MEDIUM',
        priorityValue: 2,
        description: fullPrompt,
        metadata: { autonomousJob: true, jobId: 'job-example' },
        section: 'pending',
      }, 'internal', { raw: true });
      expect(created.description).toBe('Scheduled review');
      expect(created.metadata.prompt).toBe(fullPrompt);
      const reloaded = await getTaskById('sys-scheduled-prompt');
      expect(reloaded.description).toBe('Scheduled review');
      expect(reloaded.metadata.prompt).toBe(fullPrompt);
    });

    it('keeps a multiline raw description as the prompt when a multiline context note rides along', async () => {
      // The pr-reviewer generator hands over the stage instructions as the
      // description and the security-scan summary as a multi-line context note.
      // Reclassifying the note first made it the "explicit" prompt and dropped
      // the instructions, so Stage 2 ran with no gate rules and no output contract.
      const stagePrompt = '[Improvement: Example] PR Eligibility Gate (Stage 2)\n\n## Gate\n\nReturn JSON only.';
      const scanNote = 'Security scan status: passed.\nReviewed 1 external pull request.';
      const created = await addTask({
        id: 'sys-stage-with-note',
        status: 'pending',
        priority: 'MEDIUM',
        priorityValue: 2,
        description: stagePrompt,
        metadata: { context: scanNote },
        section: 'pending',
      }, 'internal', { raw: true });
      expect(created.description).toBe('[Improvement: Example] PR Eligibility Gate (Stage 2)');
      expect(created.metadata.prompt).toBe(stagePrompt);
      expect(created.metadata.context).toBe(scanNote);
      const reloaded = await getTaskById('sys-stage-with-note');
      expect(reloaded.metadata.prompt).toBe(stagePrompt);
      expect(reloaded.metadata.context).toBe(scanNote);
    });

    it('preserves an explicitly empty prompt while normalizing a multiline raw description', async () => {
      const created = await addTask({
        id: 'sys-cleared-scheduled-prompt',
        status: 'pending',
        priority: 'MEDIUM',
        priorityValue: 2,
        description: 'Scheduled review\n\nFallback body',
        metadata: { prompt: '' },
        section: 'pending',
      }, 'internal', { raw: true });
      expect(created.description).toBe('Scheduled review');
      expect(created.metadata).toHaveProperty('prompt', '');
    });

    it('preserves a producer-written prompt over the description when both are present', async () => {
      // When a task carries both a multi-line description AND an explicit
      // metadata.prompt, the producer's prompt wins — the description is still
      // collapsed to first line for COS-TASKS.md serialization, but the prompt
      // field is not overwritten.
      const producerPrompt = 'Custom agent instructions for Example App';
      const fullDescription = 'Audit task\n\nThis is the task body\nthat should be ignored.';
      const created = await addTask({
        id: 'task-producer-prompt-wins',
        status: 'pending',
        priority: 'MEDIUM',
        priorityValue: 2,
        description: fullDescription,
        metadata: { prompt: producerPrompt },
        section: 'pending',
      }, 'internal', { raw: true });
      expect(created.description).toBe('Audit task');
      expect(created.metadata.prompt).toBe(producerPrompt);
      const reloaded = await getTaskById('task-producer-prompt-wins');
      expect(reloaded.description).toBe('Audit task');
      expect(reloaded.metadata.prompt).toBe(producerPrompt);
    });

    it('leaves a one-line human note on metadata.context', async () => {
      const created = await addTask({ description: 'job', id: 'task-note', context: 'Manually triggered job: nightly' }, 'user');
      expect(created.metadata.context).toBe('Manually triggered job: nightly');
      expect(created.metadata.prompt).toBeUndefined();
    });

    it('preserves autonomous-job markers for manual triggers', async () => {
      const created = await addTask({
        description: 'manual scheduled job',
        id: 'task-manual-job',
        autonomousJob: true,
        jobId: 'job-example'
      }, 'internal');

      expect(created.metadata).toMatchObject({ autonomousJob: true, jobId: 'job-example' });
      const reloaded = await getTaskById('task-manual-job');
      expect(reloaded.metadata.autonomousJob === true || reloaded.metadata.autonomousJob === 'true').toBe(true);
      expect(reloaded.metadata.jobId).toBe('job-example');
    });

    it('round-trips OpenCode Ollama generation controls, including thinking off', async () => {
      const created = await addTask({
        description: 'local task', id: 'task-opencode', effort: 'high', temperature: 0.25, thinking: false,
      }, 'user');
      expect(created.metadata).toMatchObject({ effort: 'high', temperature: 0.25, thinking: false });
      const reloaded = await getTaskById('task-opencode');
      expect(reloaded.metadata).toMatchObject({ effort: 'high', temperature: '0.25', thinking: 'false' });
    });

    it('accepts an explicit prompt alongside a note and never re-classifies it', async () => {
      const created = await addTask(
        { description: 'claim', id: 'task-explicit', prompt: AGENT_BODY, context: 'one-line note' },
        'user'
      );
      expect(created.metadata.prompt).toBe(AGENT_BODY);
      expect(created.metadata.context).toBe('one-line note');
    });

    it('preserves an explicitly cleared prompt alongside a note', async () => {
      const created = await addTask(
        { description: 'claim', id: 'task-empty-prompt', prompt: '', context: 'one-line note' },
        'user'
      );
      expect(created.metadata).toHaveProperty('prompt', '');
      expect(created.metadata.context).toBe('one-line note');

      const reloaded = await getTaskById('task-empty-prompt');
      expect(reloaded.metadata).toHaveProperty('prompt', '');
      expect(reloaded.metadata.context).toBe('one-line note');
    });

    // The generator, the reference-watch filer and the repo-study filer all queue
    // pre-built (raw) tasks carrying the same multi-thousand-character body.
    it('classifies a raw pre-built task too, without mutating the caller object', async () => {
      const raw = {
        id: 'sys-raw',
        status: 'pending',
        priority: 'LOW',
        priorityValue: 1,
        description: 'Improve Example App',
        autoApproved: true,
        metadata: { context: AGENT_BODY, app: 'a1' },
        section: 'pending',
      };
      const created = await addTask(raw, 'internal', { raw: true });
      expect(created.metadata.prompt).toBe(AGENT_BODY);
      expect(created.metadata.context).toBeUndefined();
      expect(created.metadata.app).toBe('a1');
      expect(raw.metadata.context).toBe(AGENT_BODY); // caller's object untouched
    });

    // The task editor's textarea is seeded from the NOTE; re-classifying a
    // multi-line edit of it would silently overwrite the task's real prompt.
    it('does NOT re-classify on update — a multi-line note edit stays a note', async () => {
      await addTask({ description: 'claim', id: 'task-edit', prompt: AGENT_BODY, context: 'note' }, 'user');
      const updated = await updateTask('task-edit', { context: 'note\nsecond line' }, 'user');
      expect(updated.metadata.context).toBe('note\nsecond line');
      expect(updated.metadata.prompt).toBe(AGENT_BODY);
    });

    // The task editor renders the description as an AutoSizeTextarea, so Enter
    // and paste put newlines into the ORDINARY edit path. Before #7240 the
    // update path wrote them straight into the one-line markdown row: the
    // description silently truncated, the body's `  - key: value` lines were
    // scraped into the task's OWN metadata, and a pasted `- [ ] #id | …` row
    // minted a phantom auto-approved task the spawner would run.
    const CORRUPTING_DESCRIPTION = [
      'Fix the login flow',
      'Also update:',
      '  - app: other-app',
      '  - provider: openai',
      '- [ ] #task-999 | HIGH | phantom task',
    ].join('\n');

    it('normalizes a multi-line description on update without corrupting the task file', async () => {
      await addTask(
        { description: 'Fix the login flow', id: 'task-multiline-desc', app: 'my-app', provider: 'claude', context: 'note' },
        'user'
      );
      const updated = await updateTask('task-multiline-desc', { description: CORRUPTING_DESCRIPTION }, 'user');

      // The row stays a one-line record, so the file reparses to exactly one task.
      expect(updated.description).toBe('Fix the login flow');
      const { tasks } = await getUserTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe('task-multiline-desc');

      // The description body no longer re-targets the task's own execution metadata.
      expect(tasks[0].metadata.app).toBe('my-app');
      expect(tasks[0].metadata.provider).toBe('claude');

      // And the submitted text is fully recoverable — nothing silently truncated.
      expect(getTaskPrompt(tasks[0])).toBe(CORRUPTING_DESCRIPTION);
    });

    it('appends a multi-line description edit to the note when the task already has a prompt', async () => {
      await addTask(
        { description: 'claim', id: 'task-desc-with-prompt', prompt: AGENT_BODY, context: 'note' },
        'user'
      );
      const updated = await updateTask('task-desc-with-prompt', { description: CORRUPTING_DESCRIPTION }, 'user');

      // `updateTask` must never overwrite a real prompt (cosTaskPrompt.js contract).
      expect(updated.metadata.prompt).toBe(AGENT_BODY);
      expect(updated.description).toBe('Fix the login flow');
      const reloaded = await getTaskById('task-desc-with-prompt');
      expect(getTaskContextNote(reloaded)).toBe(`note\n\n(from description)\n${CORRUPTING_DESCRIPTION}`);
      expect((await getUserTasks()).tasks).toHaveLength(1);
    });

    it('does not re-append the same description overflow on a repeated save', async () => {
      await addTask({ description: 'claim', id: 'task-desc-resave', prompt: AGENT_BODY }, 'user');
      await updateTask('task-desc-resave', { description: CORRUPTING_DESCRIPTION }, 'user');
      const again = await updateTask('task-desc-resave', { description: CORRUPTING_DESCRIPTION }, 'user');
      expect(again.metadata.context).toBe(`(from description)\n${CORRUPTING_DESCRIPTION}`);
    });

    it('leaves a single-line description edit untouched', async () => {
      await addTask({ description: 'claim', id: 'task-desc-single', context: 'note' }, 'user');
      const updated = await updateTask('task-desc-single', { description: 'renamed' }, 'user');
      expect(updated.description).toBe('renamed');
      expect(updated.metadata.prompt).toBeUndefined();
      expect(updated.metadata.context).toBe('note');
    });

    it('treats prompt as a legacy direct field on update (edit stamp + clear)', async () => {
      const T0 = Date.parse('2026-08-15T00:00:00.000Z');
      const T1 = Date.parse('2026-08-15T06:00:00.000Z');
      await addTask({ description: 'claim', id: 'task-prompt-edit', prompt: AGENT_BODY }, 'user', { now: T0 });
      const edited = await updateTask('task-prompt-edit', { prompt: 'rewritten\nbody' }, 'user', { now: T1 });
      expect(edited.metadata.prompt).toBe('rewritten\nbody');
      expect(edited.metadata.updatedAt).toBe(new Date(T1).toISOString());
      const cleared = await updateTask('task-prompt-edit', { prompt: '' }, 'user');
      expect(cleared.metadata.prompt).toBe('');
    });
  });

  it('persists structured auto-fix diagnostics into metadata and round-trips them through markdown (#2328)', async () => {
    const diagnostics = {
      triggerEvent: 'AI_PROVIDER_EXECUTION_FAILED',
      target: 'Claude Code CLI (opus)',
      errorType: 'rate-limit',
      category: 'rate-limit',
      tier: 3,
      fixStrategy: 'constrained-agent-retry',
      failureReason: 'HTTP 429 from provider',
    };
    const created = await addTask(
      { description: 'Investigate AI provider failure', approvalRequired: true, diagnostics },
      'internal'
    );
    // Attached to the returned task's metadata (not silently dropped).
    expect(created.metadata.diagnostics).toEqual(diagnostics);
    // Survives the markdown serialize → parse round-trip via the JSON sentinel.
    const { tasks } = await getCosTasks();
    const reloaded = tasks.find(t => t.id === created.id);
    expect(reloaded.metadata.diagnostics).toEqual(diagnostics);
  });

  it('persists the investigation guard markers into metadata and round-trips them through markdown (#2615)', async () => {
    const created = await addTask({
      description: '[Auto] Investigate agent failure: agent exited during startup',
      approvalRequired: true,
      isInvestigation: true,
      investigationFingerprint: 'startup-failure:user:none',
      affectedTasks: ['task-abc']
    }, 'internal');
    expect(created.metadata.isInvestigation).toBe(true);
    expect(created.metadata.investigationFingerprint).toBe('startup-failure:user:none');
    expect(created.metadata.affectedTasks).toEqual(['task-abc']);
    // Survives the markdown serialize → parse round-trip: the colon-bearing
    // fingerprint stays intact (parser splits on the FIRST colon only), the
    // boolean marker comes back as the string 'true' (isTruthyMeta territory),
    // and the affectedTasks array round-trips via the JSON sentinel.
    const { tasks } = await getCosTasks();
    const reloaded = tasks.find(t => t.id === created.id);
    expect(reloaded.metadata.investigationFingerprint).toBe('startup-failure:user:none');
    expect(reloaded.metadata.isInvestigation === true || reloaded.metadata.isInvestigation === 'true').toBe(true);
    expect(reloaded.metadata.affectedTasks).toEqual(['task-abc']);
  });

  it('persists a slashdo workflow as the BARE command name, never a rendered invocation (#3089)', async () => {
    const created = await addTask({ description: 'Plan the widget API', slashdoCommand: 'plan-task' }, 'user');
    expect(created.metadata.slashdoCommand).toBe('plan-task');
    // A literal `/do:plan-task` frozen in at form time would be Claude-only —
    // the provider select defaults to Auto, so the invocation shape must stay
    // unresolved until the scheduler picks one.
    expect(created.description).not.toContain('/do:');
    expect(JSON.stringify(created.metadata)).not.toContain('/do:');

    const { tasks } = await getUserTasks();
    expect(tasks.find(t => t.id === created.id).metadata.slashdoCommand).toBe('plan-task');
  });

  it('normalizes plan-only tasks to the issue-filing, no-delivery posture', async () => {
    const created = await addTask({
      description: 'Plan the widget API',
      planOnly: true,
      slashdoCommand: 'review',
      slashdoArgs: '--label plan',
      createJiraTicket: true,
      useWorktree: true,
      openPR: true,
      simplify: true,
      reviewLoop: true,
      reviewers: ['codex'],
      worktreeChangesExpected: true,
    }, 'user');

    expect(created.metadata).toMatchObject({
      planOnly: true,
      slashdoCommand: 'plan-task',
      slashdoArgs: '--yes',
      readOnly: true,
      noCodeOutput: true,
      useWorktree: false,
      openPR: false,
      simplify: false,
      reviewLoop: false,
      worktreeChangesExpected: false,
    });
    expect(created.metadata.createJiraTicket).toBeUndefined();
    expect(created.metadata.prCompletion).toBeUndefined();
    expect(created.metadata.reviewers).toBeUndefined();

    const { tasks } = await getUserTasks();
    expect(tasks.find(t => t.id === created.id).metadata.slashdoCommand).toBe('plan-task');
  });

  it('persists a pinned claim target through the task markdown round-trip', async () => {
    const created = await addTask({
      description: 'Claim GitHub issue 42 for Example App',
      app: 'example-app',
      claimTarget: '42'
    }, 'user');

    expect(created.metadata.claimTarget).toBe('42');
    const { tasks } = await getUserTasks();
    expect(tasks.find(t => t.id === created.id).metadata.claimTarget).toBe('42');
  });

  it('persists a manual claim swarm count through the task markdown round-trip', async () => {
    const created = await addTask({
      description: 'Claim twelve independent GitHub issues for Example App',
      app: 'example-app',
      swarmCount: 12,
    }, 'user');

    expect(created.metadata.swarmCount).toBe(12);
    const { tasks } = await getUserTasks();
    // Scalar task metadata parses from markdown as text; the lifecycle resolver
    // normalizes it with Number() before applying the bounded thread override.
    expect(Number(tasks.find(t => t.id === created.id).metadata.swarmCount)).toBe(12);
  });

  it('drops an out-of-range manual claim swarm count', async () => {
    const created = await addTask({ description: 'Invalid claim swarm', swarmCount: 13 }, 'user');
    expect(created.metadata.swarmCount).toBeUndefined();
  });

  it('persists malware scan report ownership through the task markdown round-trip', async () => {
    const malwareScan = { linkId: 'a3d2c4e8-810a-4d1a-8ab1-94d3e0a13f8d', reportId: 'b38bdf75-3fe2-498c-9c36-7d512dc078d1' };
    const created = await addTask({ description: 'Malware scan: example/repo', malwareScan }, 'user');
    expect(created.metadata.malwareScan).toEqual(malwareScan);

    const { tasks } = await getUserTasks();
    expect(tasks.find(t => t.id === created.id).metadata.malwareScan).toEqual(malwareScan);
  });

  it('omits slashdo metadata when no workflow is pinned', async () => {
    const created = await addTask({ description: 'ordinary prose task' }, 'user');
    expect(created.metadata.slashdoCommand).toBeUndefined();
    expect(created.metadata.slashdoArgs).toBeUndefined();
  });

  it('omits investigation guard metadata when not supplied', async () => {
    const created = await addTask({ description: 'ordinary task' }, 'user');
    expect(created.metadata.isInvestigation).toBeUndefined();
    expect(created.metadata.investigationFingerprint).toBeUndefined();
  });

  it('persists the whole quota-burn provenance block and omits it for every other task', async () => {
    // `metadata` is an allowlist, so an unlisted key is silently dropped — and a
    // dropped `quotaBurnFamily` makes the queued burn indistinguishable from any
    // other system task at the cooldown gate and the completion continuation.
    // Every field of the block reaches disk together (#6406): mapping them one
    // at a time is how `quotaBurnRequestId` came to reach disk on the raw path
    // only, so the two burn lanes carried different provenance.
    const burn = await addTask(
      {
        description: '[Quota burn: agy] Perf',
        app: 'portos',
        quotaBurnFamily: 'agy',
        quotaBurnLimitingResetAt: 1700000000000,
        quotaBurnStepId: 'step-1',
        quotaBurnRequestId: 'demand-7',
      },
      'internal',
    );
    expect(burn.metadata).toMatchObject({
      quotaBurnFamily: 'agy',
      quotaBurnLimitingResetAt: 1700000000000,
      quotaBurnStepId: 'step-1',
      quotaBurnRequestId: 'demand-7',
    });
    const ordinary = await addTask({ description: 'not a burn' }, 'user');
    expect(ordinary.metadata.quotaBurnFamily).toBeUndefined();
  });

  it('leaves the request id ABSENT on the synchronous custom-job burn lane', async () => {
    // That lane queues the task itself, so there is no on-demand request to name
    // and a synthesized (or null) id would make a join over it silently wrong.
    const burn = await addTask(
      { description: '[Quota burn: agy] Custom job', app: 'portos', quotaBurnFamily: 'agy', quotaBurnStepId: 'step-2' },
      'internal',
    );
    expect(burn.metadata).not.toHaveProperty('quotaBurnRequestId');
    const { tasks } = await getCosTasks();
    expect(tasks.find(t => t.id === burn.id).metadata).not.toHaveProperty('quotaBurnRequestId');
  });

  it('omits diagnostics metadata when none is supplied and ignores a non-object / array value', async () => {
    const created = await addTask({ description: 'no diagnostics here' }, 'user');
    expect(created.metadata.diagnostics).toBeUndefined();
    const bad = await addTask({ description: 'bad diagnostics', diagnostics: 'not-an-object' }, 'user');
    expect(bad.metadata.diagnostics).toBeUndefined();
    const arr = await addTask({ description: 'array diagnostics', diagnostics: ['nope'] }, 'user');
    expect(arr.metadata.diagnostics).toBeUndefined();
  });

  it('rejects a duplicate with the same first-line description and app scope', async () => {
    await addTask({ description: 'dupe me', app: 'portos' }, 'user');
    const second = await addTask({ description: 'dupe me\nextra body', app: 'portos' }, 'user');
    expect(second.duplicate).toBe(true);
    const { tasks } = await getUserTasks();
    expect(tasks).toHaveLength(1);
  });

  it('does NOT treat same description against different apps as a duplicate', async () => {
    await addTask({ description: 'shared', app: 'portos' }, 'user');
    const second = await addTask({ description: 'shared', app: 'bookloom' }, 'user');
    expect(second.duplicate).toBeUndefined();
    const { tasks } = await getUserTasks();
    expect(tasks).toHaveLength(2);
  });

  it('rejects a raw duplicate whose app lives in metadata.app (queue-path improvement tasks)', async () => {
    // Queue-path improvement tasks (prepareManagedAppImprovementTask) arrive
    // pre-built with `raw: true` and carry the app in `metadata.app`, NOT top-level
    // `taskData.app`. Two concurrent queueEligibleImprovementTasks snapshots each add
    // an identical `[Improvement: PortOS] …` task; the second must be rejected as a
    // duplicate (regression for the overlapping-duplicate-runs bug).
    const rawTask = (id) => ({
      id, description: '[Improvement: PortOS] Performance Analysis', status: 'pending',
      priority: 'LOW', priorityValue: PRIORITY_VALUES.LOW, taskType: 'internal', autoApproved: true,
      metadata: { app: 'portos', analysisType: 'performance' }
    });
    const first = await addTask(rawTask('sys-perf-1'), 'internal', { raw: true });
    expect(first.duplicate).toBeUndefined();
    const second = await addTask(rawTask('sys-perf-2'), 'internal', { raw: true });
    expect(second.duplicate).toBe(true);
    const { tasks } = await getCosTasks();
    expect(tasks.filter(t => firstLine(t.description) === '[Improvement: PortOS] Performance Analysis')).toHaveLength(1);
  });

  it('does NOT treat raw tasks with the same description against different metadata.app as duplicates', async () => {
    const rawTask = (id, app) => ({
      id, description: 'shared raw', status: 'pending',
      priority: 'LOW', priorityValue: PRIORITY_VALUES.LOW, taskType: 'internal', autoApproved: true,
      metadata: { app }
    });
    await addTask(rawTask('sys-a', 'portos'), 'internal', { raw: true });
    const second = await addTask(rawTask('sys-b', 'bookloom'), 'internal', { raw: true });
    expect(second.duplicate).toBeUndefined();
    const { tasks } = await getCosTasks();
    expect(tasks.filter(t => firstLine(t.description) === 'shared raw')).toHaveLength(2);
  });

  it('rejects a duplicate of a failure-blocked task (#2614)', async () => {
    // A task blocked by repeated failures still occupies its slot — without
    // this, a persistently-failing scheduled type minted one identical blocked
    // duplicate per cadence tick, forever.
    const first = await addTask({ description: 'keeps failing', app: 'portos', id: 'sys-fail' }, 'internal');
    await updateTask(first.id, { status: 'blocked', metadata: { blockedCategory: 'max-retries' } }, 'internal');
    const second = await addTask({ description: 'keeps failing', app: 'portos' }, 'internal');
    expect(second.duplicate).toBe(true);
    expect(second.id).toBe(first.id);
    const { tasks } = await getCosTasks();
    expect(tasks.filter(t => firstLine(t.description) === 'keeps failing')).toHaveLength(1);
  });

  it('rejects a duplicate of a user-terminated blocked task (#2614)', async () => {
    const first = await addTask({ description: 'killed on purpose', app: 'portos', id: 'sys-killed' }, 'internal');
    await updateTask(first.id, { status: 'blocked', metadata: { blockedCategory: 'user-terminated' } }, 'internal');
    const second = await addTask({ description: 'killed on purpose', app: 'portos' }, 'internal');
    expect(second.duplicate).toBe(true);
  });

  it.each(['blocked', 'completed'])('emits tasks:changed action "unblocked" on a %s → pending flip (#2614, #12058)', async (status) => {
    // cos.init re-runs the dequeue on 'unblocked' (like 'approved') so a
    // revived task spawns without waiting for an unrelated event or timer.
    const task = await addTask({ description: 'revive me', app: 'portos', id: 'sys-revive' }, 'internal');
    await updateTask(task.id, { status, metadata: { blockedCategory: 'max-retries' } }, 'internal');
    mock.events.length = 0;
    await updateTask(task.id, { status: 'pending' }, 'internal');
    const evt = mock.events.find(e => e.name === 'tasks:changed');
    expect(evt.payload.action).toBe('unblocked');
    // A non-status edit still emits the plain 'updated' action.
    mock.events.length = 0;
    await updateTask(task.id, { priority: 'HIGH' }, 'internal');
    expect(mock.events.find(e => e.name === 'tasks:changed').payload.action).toBe('updated');
  });

  it('atomically resumes one completed coordinator and preserves its lifetime spawn budget', async () => {
    const task = await addTask({ id: 'sys-rl-owner', description: 'Review existing PR', metadata: {
      app: 'example', reviewLoopFollowUp: true, reviewLoopPRBranch: 'feature', totalSpawnCount: '2',
    } }, 'internal', { raw: true });
    await updateTask(task.id, { status: 'completed' }, 'internal');
    const current = await getTaskById(task.id);
    const resume = () => updateTask(task.id, { status: 'pending' }, 'internal', {
      expectedStatus: 'completed', expectedMetadata: { totalSpawnCount: current.metadata.totalSpawnCount },
    });
    const results = await Promise.all([resume(), resume()]);
    expect(results.filter(result => result.statusChanged)).toHaveLength(1);
    const resumed = await getTaskById(task.id);
    expect(resumed).toMatchObject({ status: 'pending', metadata: { totalSpawnCount: '2', reviewLoopPRBranch: 'feature' } });
  });

  it('preserves charged failure history when the original cleanup owner settles an exhausted task', async () => {
    const task = await addTask({ id: 'sys-exhausted-cleanup', description: 'Retire verified delivery', metadata: {
      totalSpawnCount: '3', failureCount: '3', lastErrorCategory: 'task-incomplete', lastFailureAt: '2026-03-01T00:00:00Z',
    } }, 'internal', { raw: true });
    await updateTask(task.id, { status: 'blocked', metadata: { blockedCategory: 'task-recovery-exhausted',
      deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'completed-owner' } }, 'internal');
    const current = await getTaskById(task.id);
    const options = { expectedStatus: 'blocked', expectedTask: { description: current.description, priority: current.priority, metadata: current.metadata },
      recoveryOwner: { id: 'completed-owner', startedAt: '2026-03-01T00:00:00Z' }, preserveRetryBudget: true };
    const finish = () => updateTask(task.id, { status: 'completed', metadata: { deliveryRecovery: undefined,
      deliveryRecoveryAgentId: undefined, taskOutcome: { status: 'completed', reason: 'Verified retirement receipt' } } }, 'internal', options);
    const results = await Promise.all([finish(), finish()]);
    expect(results.filter(result => result.statusChanged)).toHaveLength(1);
    expect(await getTaskById(task.id)).toMatchObject({ status: 'completed', metadata: {
      totalSpawnCount: '3', failureCount: '3', lastErrorCategory: 'task-incomplete', lastFailureAt: '2026-03-01T00:00:00Z',
    } });
    expect((await getTaskById(task.id)).metadata.deliveryRecovery).toBeUndefined();
  });

  it('emits tasks:changed action "requeued" on an in_progress → pending flip (#3373)', async () => {
    // The retry-hold release and the orphan sweep both requeue this way, long
    // after the completion dequeue ran — without a wake signal the retry would
    // idle until an unrelated event or timer fired.
    const task = await addTask({ description: 'requeue me', app: 'portos', id: 'sys-requeue' }, 'internal');
    await updateTask(task.id, { status: 'in_progress' }, 'internal');
    mock.events.length = 0;
    await updateTask(task.id, { status: 'pending', metadata: { retryPendingCleanup: undefined } }, 'internal');
    expect(mock.events.find(e => e.name === 'tasks:changed').payload.action).toBe('requeued');
  });

  // The hold clear has to actually leave the disk: a `null` would serialize as
  // the string "null" and read back as a live marker on the next boot.
  it('drops undefined metadata keys entirely rather than persisting them (#3373)', async () => {
    const task = await addTask({ description: 'clear my marker', app: 'portos', id: 'sys-marker' }, 'internal');
    await updateTask(task.id, { status: 'in_progress', metadata: { retryPendingCleanup: true } }, 'internal');
    await updateTask(task.id, { status: 'pending', metadata: { retryPendingCleanup: undefined } }, 'internal');
    const { tasks } = await getCosTasks();
    const stored = tasks.find(t => t.id === task.id);
    expect(stored.status).toBe('pending');
    expect('retryPendingCleanup' in stored.metadata).toBe(false);
  });

  // A hold only means anything on an in_progress task waiting for its cleanup. Any
  // other status retires it, so a late cleanup (or the orphan sweep) can never act
  // on a marker left behind on a task that has since gone blocked or completed.
  it('strips a retry hold when the task leaves in_progress (#3373)', async () => {
    const task = await addTask({ description: 'hold retired', app: 'portos', id: 'sys-hold' }, 'internal');
    await updateTask(task.id, { status: 'in_progress', metadata: { retryPendingCleanup: 'agent-x', retryPendingSince: new Date().toISOString() } }, 'internal');
    const blocked = await updateTask(task.id, { status: 'blocked', metadata: { blockedCategory: 'user-terminated' } }, 'internal');
    expect(blocked.metadata.retryPendingCleanup).toBeUndefined();
    expect(blocked.metadata.retryPendingSince).toBeUndefined();
  });

  it('reviveBlockedTask flips to pending with a FRESH retry budget (#2614)', async () => {
    // A revived task must behave like a fresh one: without clearing the
    // spawn/orphan budgets it would immediately re-block on the exhausted
    // budget it blocked with. The reset also wins over caller metadata that
    // carries a stale budget forward (pipeline hand-offs spread the prior
    // stage's metadata).
    const task = await addTask({ description: 'budget reset', app: 'portos', id: 'sys-budget' }, 'internal');
    await updateTask(task.id, {
      status: 'blocked',
      metadata: {
        blockedCategory: 'max-spawns', totalSpawnCount: 99, orphanRetryCount: 3,
        lastOrphanedAt: '2026-01-01T00:00:00.000Z', worktreeBusyAttempts: 5
      }
    }, 'internal');
    const revived = await reviveBlockedTask(task.id, { metadata: { totalSpawnCount: 99, fresh: 'yes' } }, 'internal');
    expect(revived.status).toBe('pending');
    expect(revived.metadata.totalSpawnCount).toBeUndefined();
    expect(revived.metadata.orphanRetryCount).toBeUndefined();
    expect(revived.metadata.lastOrphanedAt).toBeUndefined();
    // The branch-busy patience budget is spent by the time a follow-up gives up;
    // leaving it would make the revived task hard-block on the first busy race.
    expect(revived.metadata.worktreeBusyAttempts).toBeUndefined();
    expect(revived.metadata.blockedCategory).toBeUndefined();
    expect(revived.metadata.fresh).toBe('yes');
  });

  it('resolving a blocked task re-opens the slot for an identical task (#2614)', async () => {
    const first = await addTask({ description: 'retry me', app: 'portos', id: 'sys-retry' }, 'internal');
    await updateTask(first.id, { status: 'blocked', metadata: { blockedCategory: 'max-retries' } }, 'internal');
    // Completed no longer occupies the slot...
    await updateTask(first.id, { status: 'completed' }, 'internal');
    const second = await addTask({ description: 'retry me', app: 'portos', id: 'sys-retry-2' }, 'internal');
    expect(second.duplicate).toBeUndefined();
    const { tasks } = await getCosTasks();
    expect(tasks.filter(t => firstLine(t.description) === 'retry me')).toHaveLength(2);
  });

  it('ignoreTaskId excludes one in-flight task from the dedup scan (perpetual drain-on-completion)', async () => {
    // The just-completed perpetual task is still in_progress on disk when the
    // refill re-queues an identical first-line for the same app. Passing its id
    // as ignoreTaskId must let the new task through instead of colliding with it.
    const first = await addTask({ description: 'claim issue', app: 'portos', id: 'sys-old' }, 'internal');
    // Without ignoreTaskId the identical task collides...
    const blocked = await addTask({ description: 'claim issue', app: 'portos' }, 'internal');
    expect(blocked.duplicate).toBe(true);
    // ...but excluding the still-in-flight task lets the refill queue the next one.
    const allowed = await addTask({ description: 'claim issue', app: 'portos' }, 'internal', { raw: false, ignoreTaskId: first.id });
    expect(allowed.duplicate).toBeUndefined();
    const { tasks } = await getCosTasks();
    expect(tasks.filter(t => firstLine(t.description) === 'claim issue')).toHaveLength(2);
  });

  it('persists boolean override flags (true and false) into metadata', async () => {
    const task = await addTask({ description: 'flagged', useWorktree: false, openPR: true, claimFlow: true }, 'user');
    expect(task.metadata.useWorktree).toBe(false);
    expect(task.metadata.openPR).toBe(true);
    expect(task.metadata.claimFlow).toBe(true);
    expect(task.metadata.prCompletion).toBe('review-then-merge');
  });

  it('persists an explicit PR completion policy on new user tasks', async () => {
    const task = await addTask({ description: 'inspect first', useWorktree: true, openPR: true, prCompletion: 'leave-open' }, 'user');
    expect(task.metadata.prCompletion).toBe('leave-open');
  });

  it('persists the non-worktree completion choice', async () => {
    const task = await addTask({ description: 'commit in place', useWorktree: false, whenDone: 'commit-push' }, 'user');
    expect(task.metadata.whenDone).toBe('commit-push');
  });

  it('defaults a worktree USER task to openPR:true when openPR is unspecified', async () => {
    const task = await addTask({ description: 'wt default pr', useWorktree: true }, 'user');
    expect(task.metadata.useWorktree).toBe(true);
    expect(task.metadata.openPR).toBe(true);
  });

  it('does NOT default openPR for a worktree INTERNAL task (automation keeps auto-merge)', async () => {
    const task = await addTask({ description: 'wt internal', useWorktree: true }, 'internal');
    expect(task.metadata.useWorktree).toBe(true);
    expect(task.metadata.openPR).toBeUndefined();
  });

  it('respects an explicit openPR:false on a worktree task (no default override)', async () => {
    const task = await addTask({ description: 'wt no pr', useWorktree: true, openPR: false }, 'user');
    expect(task.metadata.openPR).toBe(false);
  });

  it('does not set openPR for a non-worktree task', async () => {
    const task = await addTask({ description: 'no wt', useWorktree: false }, 'user');
    expect(task.metadata.openPR).toBeUndefined();
  });

  it('persists the throwaway-worktree posture so a non-raw caller can ask for it', async () => {
    // Load-bearing: `useWorktree` + `openPR:false` AUTO-MERGES onto the source
    // workspace's default branch. `discardWorktree` is the only thing standing
    // between an audit-style task and an unreviewed commit landing there, and
    // before this passthrough only the raw path could set it — a non-raw caller
    // silently got the auto-merge default instead.
    const task = await addTask({
      description: 'audit only', useWorktree: true, openPR: false,
      discardWorktree: true, worktreeChangesExpected: false, noCodeOutput: true,
    }, 'internal');
    expect(task.metadata.discardWorktree).toBe(true);
    expect(task.metadata.worktreeChangesExpected).toBe(false);
    expect(task.metadata.noCodeOutput).toBe(true);
  });

  it('leaves the throwaway keys absent when the caller did not ask for them', async () => {
    // Absent means "normal posture"; stamping `false` onto every task would put
    // an opt-in marker on records that never opted in.
    const task = await addTask({ description: 'ordinary', useWorktree: true }, 'internal');
    expect(task.metadata.discardWorktree).toBeUndefined();
    expect(task.metadata.noCodeOutput).toBeUndefined();
    expect(task.metadata.worktreeChangesExpected).toBeUndefined();
  });

  it('raw=true preserves supplied task fields while adding server-owned episode proof', async () => {
    const raw = { id: 'sys-raw', description: 'raw task', status: 'pending', metadata: { context: 'ctx' } };
    const task = await addTask(raw, 'internal', { raw: true });
    expect(task).toMatchObject(raw);
    expect(task.metadata.spawnBudgetProof).toMatchObject({ version: 1, dispatch: null, epoch: expect.any(String) });
    expect(task.description).toBe('raw task');
  });

  it('position:top unshifts the task to the front', async () => {
    await addTask({ description: 'first', id: 'task-a' }, 'user');
    await addTask({ description: 'second', id: 'task-b', position: 'top' }, 'user');
    const { tasks } = await getUserTasks();
    expect(tasks[0].description).toBe('second');
  });

  it('stamps a content-edit timestamp (updatedAt) from the injectable clock (#1714)', async () => {
    const NOW = Date.parse('2026-06-25T12:00:00.000Z');
    const created = await addTask({ description: 'stamped', id: 'task-stamp' }, 'user', { now: NOW });
    expect(created.metadata.updatedAt).toBe(new Date(NOW).toISOString());
  });
});

describe('cosTaskStore.updateTask', () => {
  it('updates status + priority and emits tasks:changed updated', async () => {
    const created = await addTask({ description: 'upd', id: 'task-upd' }, 'user');
    const updated = await updateTask(created.id, { status: 'in_progress', priority: 'critical' }, 'user');
    expect(updated.status).toBe('in_progress');
    expect(updated.priority).toBe('CRITICAL');
    expect(updated.priorityValue).toBe(PRIORITY_VALUES.CRITICAL);
    expect(mock.events.some(e => e.name === 'tasks:changed' && e.payload.action === 'updated')).toBe(true);
  });

  it('clears blocked metadata when transitioning out of blocked', async () => {
    await addTask({ description: 'blk', id: 'task-blk' }, 'user');
    await updateTask('task-blk', { status: 'blocked', metadata: { blockedReason: 'x', blockedCategory: 'y' } }, 'user');
    const reopened = await updateTask('task-blk', { status: 'pending' }, 'user');
    expect(reopened.metadata.blockedReason).toBeUndefined();
    expect(reopened.metadata.blockedCategory).toBeUndefined();
  });

  // The pause hold goes with it, whatever un-blocked the task. `resumeAgent` is only
  // ONE of the paths back to pending — a dedupe revive, an autopilot re-dispatch, a
  // cooldown expiry and a human unblocking it all land here — and every one of them
  // used to leave a running task advertising a live pause, which made the paused
  // agent's own resume read as spent and queue a duplicate.
  it.each(['pending', 'in_progress'])('clears the pause hold when an unrelated path flips it to %s', async (status) => {
    await addTask({ description: 'paused', id: 'task-pz' }, 'user');
    await updateTask('task-pz', {
      status: 'blocked',
      metadata: {
        blockedCategory: AGENT_PAUSED_CATEGORY,
        pausedAt: '2026-08-10T00:00:00.000Z',
        pausedAgentId: 'agent-1',
        resumeWorkspacePath: '/w/agent-1',
        resumeRunId: 'run-1',
      },
    }, 'user');
    const revived = await updateTask('task-pz', { status }, 'user');
    for (const key of PAUSE_METADATA_KEYS) {
      expect(revived.metadata[key]).toBeUndefined();
    }
  });

  // ─── Resuming in place, from ANY door (#3730) ──────────────────────────────
  //
  // Clearing the hold above stops a revived task from advertising a pause it no
  // longer has, but a pause is not only bookkeeping: the run that paused left a
  // branch (usually a whole worktree) behind, and the resumed run has to be POINTED
  // at it or it starts clean and redoes the work. That resolve lived in
  // `resumeAgent`, so the Resume dialog resumed properly while the Tasks-tab status
  // toggle and `reviveBlockedTask` — the shared address for on-demand Run, pipeline
  // advance, Creative Director, manual job trigger and voice dispatch — still spawned
  // a second agent on a clean workspace. These drive each entry point.
  describe('releasing a user pause resumes in place', () => {
    let calls;
    const POINTER = { existingBranch: 'cos/task-p/agent-paused-1', resumeWorktreePath: '/tmp/wt', resumedFromAgentId: 'agent-paused-1' };

    const plantPausedTask = async (id) => {
      await addTask({ description: `paused ${id}`, id }, 'user');
      await updateTask(id, {
        status: 'blocked',
        metadata: {
          blockedCategory: AGENT_PAUSED_CATEGORY,
          blockedReason: 'Paused by user',
          pausedAt: '2026-08-10T00:00:00.000Z',
          pausedAgentId: 'agent-paused-1',
          resumeWorkspacePath: '/tmp/wt',
          resumeRunId: 'run-1',
        },
      }, 'user');
      return id;
    };

    const expectResumedInPlace = (task) => {
      expect(task.status).toBe('pending');
      expect(task.metadata).toMatchObject(POINTER);
      for (const key of [...PAUSE_METADATA_KEYS, 'blockedCategory']) {
        expect(task.metadata[key]).toBeUndefined();
      }
      expect(calls.retired).toEqual([['agent-paused-1', task.id, POINTER.existingBranch]]);
    };

    beforeEach(() => {
      calls = { resolved: [], retired: [], statusAtRetire: [] };
      registerPauseReleaseAdapter({
        resolvePausedTaskResume: async (task) => { calls.resolved.push(task.id); return POINTER; },
        retirePausedAgent: async (agentId, taskId, branchName) => {
          calls.retired.push([agentId, taskId, branchName]);
          calls.statusAtRetire.push((await getTaskById(taskId))?.status);
        },
      });
    });
    afterEach(() => __resetPauseReleaseAdapter());

    it('resumes on the preserved worktree from a bare status flip (the Tasks-tab toggle)', async () => {
      const id = await plantPausedTask('task-pause-toggle');
      expectResumedInPlace(await updateTask(id, { status: 'pending' }, 'user'));
    });

    it('resumes on the preserved worktree from reviveBlockedTask (the five dispatch paths)', async () => {
      const id = await plantPausedTask('task-pause-revive');
      expectResumedInPlace(await reviveBlockedTask(id, { metadata: { context: 'from the dispatcher' } }, 'user'));
    });

    it("keeps the caller's own metadata alongside the pointer", async () => {
      const id = await plantPausedTask('task-pause-overrides');
      const revived = await reviveBlockedTask(id, { metadata: { provider: 'claude', context: 'extra' } }, 'user');
      expect(revived.metadata).toMatchObject({ provider: 'claude', context: 'extra', existingBranch: POINTER.existingBranch });
    });

    // The task must never be `pending` (spawnable) without its pointer, and the
    // retirement — whose `agent:completed` triggers a dequeue — must not run until
    // the pointed task is on disk.
    it('resolves the pointer BEFORE the write and retires the record AFTER it', async () => {
      const id = await plantPausedTask('task-pause-order');
      await updateTask(id, { status: 'pending' }, 'user');
      expect(calls.resolved).toEqual([id]);
      expect(calls.statusAtRetire).toEqual(['pending']);
    });

    it('still un-blocks (clean) when the pointer cannot be resolved', async () => {
      registerPauseReleaseAdapter({
        resolvePausedTaskResume: async () => { throw new Error('git exploded'); },
        retirePausedAgent: async (agentId, taskId, branchName) => calls.retired.push([agentId, taskId, branchName]),
      });
      const id = await plantPausedTask('task-pause-boom');
      const revived = await updateTask(id, { status: 'pending' }, 'user');
      expect(revived.status).toBe('pending');
      expect(revived.metadata.existingBranch).toBeUndefined();
      expect(revived.metadata.pausedAgentId).toBeUndefined();
      expect(calls.retired).toEqual([['agent-paused-1', id, null]]);
    });

    it('leaves a differently-blocked task alone', async () => {
      await addTask({ description: 'not paused', id: 'task-not-paused' }, 'user');
      await updateTask('task-not-paused', { status: 'blocked', metadata: { blockedCategory: 'max-spawns' } }, 'user');
      await reviveBlockedTask('task-not-paused', {}, 'user');
      expect(calls.resolved).toEqual([]);
      expect(calls.retired).toEqual([]);
    });

    // Terminating a paused task is not a resume — nothing to point at, nothing to
    // continue, and the record's retirement belongs to whatever terminated it.
    it('leaves a paused task moving to a terminal status alone', async () => {
      const id = await plantPausedTask('task-pause-terminal');
      await updateTask(id, { status: 'completed' }, 'user');
      expect(calls.resolved).toEqual([]);
      expect(calls.retired).toEqual([]);
    });

    // The bookkeeping names the agent to resolve against and retire. Without it the
    // flip is an ordinary unblock, not a resume.
    it('treats a paused task with no pausedAgentId as an ordinary unblock', async () => {
      await addTask({ description: 'orphan pause', id: 'task-pause-noagent' }, 'user');
      await updateTask('task-pause-noagent', { status: 'blocked', metadata: { blockedCategory: AGENT_PAUSED_CATEGORY } }, 'user');
      const revived = await updateTask('task-pause-noagent', { status: 'pending' }, 'user');
      expect(revived.status).toBe('pending');
      expect(calls.resolved).toEqual([]);
      expect(calls.retired).toEqual([]);
    });
  });

  // The pointer is spent once a task is done or parked for a human: a PERPETUAL
  // task id gets re-queued for unrelated work later, and a stale existingBranch
  // would attach that fresh run to a long-merged branch.
  it('invalidates a completed run cleanup handoff before an explicit retry starts', async () => {
    await addTask({ description: 'cleanup handoff', id: 'task-cleanup-retry' }, 'user');
    await updateTask('task-cleanup-retry', { status: 'in_progress', metadata: {
      deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-old',
    } }, 'user');
    const retried = await updateTask('task-cleanup-retry', { status: 'pending' }, 'user');
    expect(retried.metadata.deliveryRecovery).toBeUndefined();
    expect(retried.metadata.deliveryRecoveryAgentId).toBeUndefined();
  });

  it('drops the resume pointer on a terminal status', async () => {
    await addTask({ description: 'res', id: 'task-res' }, 'user');
    await updateTask('task-res', {
      metadata: { existingBranch: 'cos/b', resumedFromAgentId: 'agent-x', resumeWorktreePath: '/w/agent-x' }
    }, 'user');
    const done = await updateTask('task-res', { status: 'completed' }, 'user');
    expect(done.metadata.existingBranch).toBeUndefined();
    expect(done.metadata.resumedFromAgentId).toBeUndefined();
    expect(done.metadata.resumeWorktreePath).toBeUndefined();
  });

  // ...but an orphan-cooldown block is a TIMED PAUSE that unblockExpiredOrphanCooldowns
  // flips back to pending on its own. Stripping the pointer there means the revived
  // task starts clean and abandons the worktree its dead agent left behind.
  it('keeps the resume pointer through an orphan-cooldown block', async () => {
    await addTask({ description: 'cool', id: 'task-cool' }, 'user');
    await updateTask('task-cool', {
      metadata: { existingBranch: 'cos/b', resumedFromAgentId: 'agent-x', resumeWorktreePath: '/w/agent-x' }
    }, 'user');
    const cooled = await updateTask('task-cool', {
      status: 'blocked',
      metadata: { blockedCategory: 'orphan-cooldown', cooldownUntil: '2026-01-01T00:30:00.000Z' }
    }, 'user');
    expect(cooled.metadata.existingBranch).toBe('cos/b');
    expect(cooled.metadata.resumedFromAgentId).toBe('agent-x');
    expect(cooled.metadata.resumeWorktreePath).toBe('/w/agent-x');
  });

  // A workspace block is a CONFIG pause on the same footing: the app's Repository
  // Path is missing/unreachable, the user fixes it and revives the task. Dropping
  // the pointer there abandons the uncommitted work in the leftover worktree for a
  // problem that had nothing to do with the task.
  it('keeps the resume pointer through an app-unresolved block', async () => {
    await addTask({ description: 'unrouted', id: 'task-unrouted' }, 'user');
    await updateTask('task-unrouted', {
      metadata: { existingBranch: 'cos/b', resumedFromAgentId: 'agent-x', resumeWorktreePath: '/w/agent-x' }
    }, 'user');
    const blocked = await updateTask('task-unrouted', {
      status: 'blocked',
      metadata: { blockedCategory: 'app-unresolved' }
    }, 'user');
    expect(blocked.metadata.existingBranch).toBe('cos/b');
    expect(blocked.metadata.resumeWorktreePath).toBe('/w/agent-x');
  });

  // Same for a permanent provider-config block (#6193): the resolved provider is
  // `api`-type and has no file-writing harness, so the task waits for the user to
  // add a CLI provider. Dropping the pointer means the revived task starts on a
  // fresh branch and orphans the worktree its dead agent left behind.
  it('keeps the resume pointer through a provider-config block', async () => {
    await addTask({ description: 'unrunnable provider', id: 'task-provider-config' }, 'user');
    await updateTask('task-provider-config', {
      metadata: { existingBranch: 'cos/b', resumedFromAgentId: 'agent-x', resumeWorktreePath: '/w/agent-x' }
    }, 'user');
    const blocked = await updateTask('task-provider-config', {
      status: 'blocked',
      metadata: { blockedCategory: 'provider-config' }
    }, 'user');
    expect(blocked.metadata.existingBranch).toBe('cos/b');
    expect(blocked.metadata.resumedFromAgentId).toBe('agent-x');
    expect(blocked.metadata.resumeWorktreePath).toBe('/w/agent-x');
  });

  // An `existingBranch` with no `resumedFromAgentId` beside it was never written
  // by the resume mechanism — it is the task's OWN configuration. A merge
  // follow-up is the producer: it exists to land the PR on that branch. Stripping
  // that copy meant re-running a blocked follow-up cut a worktree fresh off the
  // default branch, so any fix-and-push landed on a branch the PR never heard of.
  it('keeps a self-configured branch pointer through a terminal block', async () => {
    await addTask({ description: 'merge PR 1', id: 'sys-rl-keep' }, 'internal');
    await updateTask('sys-rl-keep', {
      metadata: { existingBranch: 'cos/task-1/agent-1', reviewLoopFollowUp: true, reviewLoopPRUrl: 'https://github.com/o/r/pull/1' }
    }, 'internal');
    const blocked = await updateTask('sys-rl-keep', {
      status: 'blocked',
      metadata: { blockedCategory: 'worktree-failed' }
    }, 'internal');
    expect(blocked.metadata.existingBranch).toBe('cos/task-1/agent-1');
  });

  // ...but once the resume mechanism has stamped its marker, the whole pointer is
  // the resume's and goes with it — the tree the dead run left behind is gone by
  // the time anyone re-runs the task.
  it('drops the branch pointer once resumedFromAgentId marks it as the resume’s', async () => {
    await addTask({ description: 'merge PR 2', id: 'sys-rl-halfkeep' }, 'internal');
    await updateTask('sys-rl-halfkeep', {
      metadata: {
        existingBranch: 'cos/task-2/agent-2', reviewLoopFollowUp: true,
        resumedFromAgentId: 'agent-2', resumeWorktreePath: '/w/agent-2'
      }
    }, 'internal');
    const done = await updateTask('sys-rl-halfkeep', { status: 'completed' }, 'internal');
    expect(done.metadata.existingBranch).toBeUndefined();
    expect(done.metadata.resumedFromAgentId).toBeUndefined();
    expect(done.metadata.resumeWorktreePath).toBeUndefined();
  });

  it('keeps a review-loop target after clearing its legacy retry duplicate', async () => {
    await addTask({ description: 'merge PR canonical', id: 'sys-rl-canonical' }, 'internal');
    await updateTask('sys-rl-canonical', {
      metadata: {
        existingBranch: 'cos/task-4/agent-old',
        resumedFromAgentId: 'agent-old',
        resumeWorktreePath: '/w/agent-old',
        reviewLoopFollowUp: true,
        reviewLoopPRBranch: 'cos/task-4/agent-pr',
      }
    }, 'internal');
    const done = await updateTask('sys-rl-canonical', { status: 'completed' }, 'internal');
    expect(done.metadata.existingBranch).toBeUndefined();
    expect(done.metadata.reviewLoopPRBranch).toBe('cos/task-4/agent-pr');
  });

  // `worktree-busy` joins the pause categories: the cooldown sweeper revives it,
  // and the revived attempt must still attach to the PR branch.
  it('keeps the pointer through a worktree-busy cooldown block', async () => {
    await addTask({ description: 'merge PR 3', id: 'sys-rl-busy' }, 'internal');
    await updateTask('sys-rl-busy', {
      metadata: { existingBranch: 'cos/task-3/agent-3', resumedFromAgentId: 'agent-3', reviewLoopFollowUp: true }
    }, 'internal');
    const cooled = await updateTask('sys-rl-busy', {
      status: 'blocked',
      metadata: { blockedCategory: 'worktree-busy', cooldownUntil: '2026-01-01T00:02:00.000Z' }
    }, 'internal');
    expect(cooled.metadata.existingBranch).toBe('cos/task-3/agent-3');
  });

  // ─── Transition edges the extraction must preserve (#6620) ────────────────
  //
  // `writeTaskUpdate` reads ONE status-transition descriptor and every lifecycle
  // rule below keys off a field of it. These pin the edges at the `updateTask`
  // boundary so the descriptor cannot silently answer a question differently
  // from the hand-written predicate it replaced.

  // The blocked clear is not just the reason text: the FAILURE COUNTERS go with
  // it. A revived task that kept `failureCount` at the budget it blocked with
  // re-blocks on its first attempt, which is precisely the retry this revive is.
  it('clears the failure counters along with the blocked reason on a revive (#6620)', async () => {
    await addTask({ description: 'counters', id: 'task-counters' }, 'user');
    await updateTask('task-counters', {
      status: 'blocked',
      metadata: {
        blocker: 'agent-9', blockedReason: 'kept failing', blockedCategory: 'max-retries',
        blockedAt: '2026-01-01T00:00:00.000Z', failureCount: 3,
        lastErrorCategory: 'timeout', lastFailureAt: '2026-01-01T00:00:00.000Z'
      }
    }, 'user');
    const revived = await updateTask('task-counters', { status: 'pending' }, 'user');
    for (const key of ['blocker', 'blockedReason', 'blockedCategory', 'blockedAt', 'failureCount', 'lastErrorCategory', 'lastFailureAt']) {
      expect(revived.metadata[key]).toBeUndefined();
    }
  });

  it('keeps the charged recovery budget durable if completion stops immediately after the recovery write', async () => {
    const { recoverLegacyDeliveryBlocks } = await import('./deliveryRecovery.js');
    const outcome = { status: 'incomplete', reason: 'Remaining delivery validation.' };
    await addTask({ description: 'recover charged delivery', id: 'task-delivery-budget' }, 'user');
    const dispatch = (count, at, agentId) => {
      mock.state.agents[agentId] = { id: agentId, taskId: 'task-delivery-budget', status: 'running', startedAt: at };
      return updateTask('task-delivery-budget', { status: 'in_progress', metadata: {
        totalSpawnCount: count, claimedBy: 'fixture-instance', claimedAt: at, lastSpawnedAt: at,
      } }, 'user', { spawnBudgetOperation: { kind: 'dispatch', agentId, startedAt: at } });
    };
    await dispatch(1, '2026-10-22T00:00:00.000Z', 'agent-first');
    mock.state.agents['agent-first'].status = 'completed';
    await updateTask('task-delivery-budget', { status: 'pending' }, 'user');
    const latest = await dispatch(2, '2026-10-23T00:00:00.000Z', 'agent-delivery-budget');
    await updateTask('task-delivery-budget', { status: 'blocked', metadata: {
      blockedCategory: 'task-incomplete', blockedAt: '2026-10-23T00:00:00.000Z', failureCount: 1, taskOutcome: outcome,
    } }, 'user');
    const task = await getTaskById('task-delivery-budget');
    const owner = { id: 'agent-delivery-budget', taskId: task.id, status: 'completed', startedAt: '2026-10-23T00:00:00.000Z',
      result: { taskOutcome: outcome }, metadata: { completionTaskDispatch: { taskId: task.id, taskType: 'user',
        spawnBudgetEpoch: latest.metadata.spawnBudgetProof.epoch, spawnBudgetStartedAt: latest.metadata.spawnBudgetProof.dispatch.startedAt,
        expected: ['claimedBy', 'claimedAt', 'lastSpawnedAt', 'totalSpawnCount'].map(key => [key, latest.metadata[key]]) } } };
    mock.state.agents[owner.id] = owner;
    mock.afterWrite = () => { throw new Error('interrupted after committed recovery transition'); };
    const release = vi.fn();
    await expect(recoverLegacyDeliveryBlocks([owner], { readTasks: async () => [task], update: updateTask, release })).rejects.toThrow('interrupted after committed recovery transition');
    const saved = (await stored('user')).find(row => row.id === task.id);
    expect(saved.status).toBe('in_progress');
    expect(Number(saved.metadata.failureCount)).toBe(2);
    expect(Number(saved.metadata.totalSpawnCount)).toBe(2);
    expect(saved.metadata.retryPendingCleanup).toBe(owner.id);
    expect(saved.metadata.legacyDeliveryRecovery).toBe(owner.id);
    expect(release).not.toHaveBeenCalled();
  });

  it.each(['manual-blocker', 'new-owner'])('preserves a %s arriving after delivery recovery reads its task', async race => {
    const { recoverLegacyDeliveryBlocks } = await import('./deliveryRecovery.js');
    const outcome = { status: 'incomplete', reason: 'Remaining delivery validation.' };
    await addTask({ description: 'recover ownership', id: 'task-delivery-owner' }, 'user');
    mock.state.agents['agent-delivery-owner'] = { id: 'agent-delivery-owner', taskId: 'task-delivery-owner', status: 'running',
      startedAt: '2026-10-23T00:00:00.000Z' };
    const latest = await updateTask('task-delivery-owner', { status: 'in_progress', metadata: {
      totalSpawnCount: 1, claimedBy: 'fixture-instance', claimedAt: '2026-10-23T00:00:00.000Z',
      lastSpawnedAt: '2026-10-23T00:00:00.000Z',
    } }, 'user', { spawnBudgetOperation: { kind: 'dispatch', agentId: 'agent-delivery-owner', startedAt: '2026-10-23T00:00:00.000Z' } });
    await updateTask('task-delivery-owner', { status: 'blocked', metadata: {
      blockedCategory: 'task-incomplete', blockedAt: '2026-10-23T00:00:00.000Z', failureCount: 1, taskOutcome: outcome,
    } }, 'user');
    const task = await getTaskById('task-delivery-owner');
    const owner = { id: 'agent-delivery-owner', taskId: task.id, status: 'completed', startedAt: '2026-10-23T00:00:00.000Z',
      result: { taskOutcome: outcome }, metadata: { completionTaskDispatch: { taskId: task.id, taskType: 'user',
        spawnBudgetEpoch: latest.metadata.spawnBudgetProof.epoch, spawnBudgetStartedAt: latest.metadata.spawnBudgetProof.dispatch.startedAt,
        expected: ['claimedBy', 'claimedAt', 'lastSpawnedAt', 'totalSpawnCount'].map(key => [key, latest.metadata[key]]) } } };
    mock.state.agents[owner.id] = owner;
    if (race === 'manual-blocker') await updateTask(task.id, { metadata: { blocker: 'Operator hold' } }, 'user');
    else mock.state.agents.newOwner = { id: 'newOwner', taskId: task.id, status: 'running' };
    const release = vi.fn();
    const fencedUpdate = vi.fn(updateTask);
    expect(await recoverLegacyDeliveryBlocks([owner], { readTasks: async () => [task], update: fencedUpdate, release })).toEqual({ recovered: 0 });
    expect(fencedUpdate).toHaveBeenCalledOnce();
    expect(fencedUpdate.mock.calls[0][3]).toMatchObject({ expectedStatus: 'blocked', expectedTask: { metadata: task.metadata },
      recoveryOwner: { id: owner.id, startedAt: owner.startedAt } });
    const saved = await getTaskById(task.id);
    expect(saved.status).toBe('blocked');
    if (race === 'manual-blocker') expect(saved.metadata.blocker).toBe('Operator hold');
    expect(saved.metadata.legacyDeliveryRecovery).toBeUndefined();
    expect(release).not.toHaveBeenCalled();
  });

  // A requeue releases the in-flight-only markers in the SAME write that makes
  // the task spawnable again: a retained lease blocks this instance's own retry
  // (and its peer's) for a full lease window, and a retained hold makes the
  // spawn guard decline the very retry the requeue exists to start.
  it('releases both the retry hold and the claim on an in_progress → pending requeue (#6620)', async () => {
    await addTask({ description: 'requeue release', id: 'task-requeue-rel' }, 'user');
    await updateTask('task-requeue-rel', {
      status: 'in_progress',
      metadata: {
        retryPendingCleanup: 'agent-r', retryPendingSince: '2026-01-01T00:00:00.000Z',
        claimedBy: 'instance-a', claimedAt: '2026-01-01T00:00:00.000Z', leaseExpiresAt: '2026-01-01T00:30:00.000Z'
      }
    }, 'user');
    const requeued = await updateTask('task-requeue-rel', { status: 'pending' }, 'user');
    expect(requeued.status).toBe('pending');
    for (const key of ['retryPendingCleanup', 'retryPendingSince', 'claimedBy', 'claimedAt', 'leaseExpiresAt']) {
      expect(requeued.metadata[key]).toBeUndefined();
    }
  });

  // The lease-renewal heartbeat carries NO status, and "no status" is not a
  // transition: it must release neither marker. An absent status collapsing into
  // "not in_progress" would make every ~15min heartbeat retire the running
  // task's own hold and lease.
  it('keeps both the retry hold and the claim on a no-status heartbeat (#6620)', async () => {
    await addTask({ description: 'heartbeat holds', id: 'task-beat-holds' }, 'user');
    await updateTask('task-beat-holds', {
      status: 'in_progress',
      metadata: {
        retryPendingCleanup: 'agent-h', retryPendingSince: '2026-01-01T00:00:00.000Z',
        claimedBy: 'instance-a', claimedAt: '2026-01-01T00:00:00.000Z', leaseExpiresAt: '2026-01-01T00:30:00.000Z'
      }
    }, 'user');
    const renewed = await updateTask('task-beat-holds', {
      metadata: { leaseExpiresAt: '2026-01-01T01:00:00.000Z' }
    }, 'user');
    expect(renewed.metadata.retryPendingCleanup).toBe('agent-h');
    expect(renewed.metadata.retryPendingSince).toBe('2026-01-01T00:00:00.000Z');
    expect(renewed.metadata.claimedBy).toBe('instance-a');
    expect(renewed.metadata.leaseExpiresAt).toBe('2026-01-01T01:00:00.000Z');
  });

  // ORDER between two of the rules, not just each rule. Leaving `blocked` clears
  // `blockedCategory` BEFORE the terminal check reads it, so a paused task that
  // goes straight to `completed` is no longer pause-categorized by the time the
  // resume pointer is evaluated and the pointer drops. Reordering the two would
  // silently strand a spent branch pointer on a completed task.
  it('drops the resume pointer on paused → completed, because the revive clear runs first (#6620)', async () => {
    await addTask({ description: 'paused then done', id: 'task-paused-done' }, 'user');
    await updateTask('task-paused-done', {
      status: 'blocked',
      metadata: {
        blockedCategory: 'orphan-cooldown',
        existingBranch: 'cos/b', resumedFromAgentId: 'agent-x', resumeWorktreePath: '/w/agent-x'
      }
    }, 'user');
    // Still blocked-and-paused: the pointer survives.
    const parked = await getTaskById('task-paused-done');
    expect(parked.metadata.existingBranch).toBe('cos/b');
    const done = await updateTask('task-paused-done', { status: 'completed' }, 'user');
    expect(done.metadata.blockedCategory).toBeUndefined();
    expect(done.metadata.existingBranch).toBeUndefined();
    expect(done.metadata.resumedFromAgentId).toBeUndefined();
    expect(done.metadata.resumeWorktreePath).toBeUndefined();
  });

  it('releases the federation claim/lease when a task leaves in_progress (#1563)', async () => {
    await addTask({ description: 'claimed', id: 'task-claimed' }, 'user');
    // Spawn-time claim: status in_progress carries the claim metadata.
    const claimed = await updateTask('task-claimed', {
      status: 'in_progress',
      metadata: { claimedBy: 'instance-a', claimedAt: '2026-01-01T00:00:00.000Z', leaseExpiresAt: '2026-01-01T00:30:00.000Z' }
    }, 'user');
    expect(claimed.metadata.claimedBy).toBe('instance-a');
    // Completing the task strips the claim so it is freely re-claimable.
    const done = await updateTask('task-claimed', { status: 'completed' }, 'user');
    expect(done.metadata.claimedBy).toBeUndefined();
    expect(done.metadata.claimedAt).toBeUndefined();
    expect(done.metadata.leaseExpiresAt).toBeUndefined();
  });

  it('stamps lastRequeuedAt only on in_progress → pending, and clears it on the next spawn (#3376)', async () => {
    await addTask({ description: 'requeue', id: 'task-requeue' }, 'user');
    // A plain content edit on a pending task is not a requeue.
    const edited = await updateTask('task-requeue', { description: 'requeue edited' }, 'user');
    expect(edited.metadata.lastRequeuedAt).toBeUndefined();

    await updateTask('task-requeue', { status: 'in_progress' }, 'user');
    // The orphan sweep / retry-hold release transition — this one IS a requeue.
    const requeued = await updateTask('task-requeue', { status: 'pending' }, 'user');
    expect(typeof requeued.metadata.lastRequeuedAt).toBe('string');

    // An edit while pending carries the stamp forward untouched…
    const stamp = requeued.metadata.lastRequeuedAt;
    const edit = await updateTask('task-requeue', { description: 'requeue again' }, 'user');
    expect(edit.metadata.lastRequeuedAt).toBe(stamp);
    // …and the next spawn retires it, so a peer's pre-spawn copy can't win on it.
    const respawned = await updateTask('task-requeue', { status: 'in_progress' }, 'user');
    expect(respawned.metadata.lastRequeuedAt).toBeUndefined();
  });

  it('keeps the claim while the task stays in_progress (lease renewal, no status change) (#1563)', async () => {
    await addTask({ description: 'renew', id: 'task-renew' }, 'user');
    await updateTask('task-renew', {
      status: 'in_progress',
      metadata: { claimedBy: 'instance-a', claimedAt: '2026-01-01T00:00:00.000Z', leaseExpiresAt: '2026-01-01T00:30:00.000Z' }
    }, 'user');
    // A heartbeat renewal passes no status — the claim must survive and update.
    const renewed = await updateTask('task-renew', {
      metadata: { claimedBy: 'instance-a', claimedAt: '2026-01-01T00:00:00.000Z', leaseExpiresAt: '2026-01-01T01:00:00.000Z' }
    }, 'user');
    expect(renewed.metadata.claimedBy).toBe('instance-a');
    expect(renewed.metadata.leaseExpiresAt).toBe('2026-01-01T01:00:00.000Z');
  });

  it('bumps updatedAt on a content edit from the injectable clock (#1714)', async () => {
    const T0 = Date.parse('2026-06-25T00:00:00.000Z');
    const T1 = Date.parse('2026-06-25T06:00:00.000Z');
    await addTask({ description: 'edit me', id: 'task-edit' }, 'user', { now: T0 });
    const updated = await updateTask('task-edit', { priority: 'HIGH' }, 'user', { now: T1 });
    expect(updated.metadata.updatedAt).toBe(new Date(T1).toISOString());
  });

  it('does NOT bump updatedAt on a lease-renewal heartbeat that re-includes existing metadata (#1714)', async () => {
    const T0 = Date.parse('2026-06-25T00:00:00.000Z');
    const T1 = Date.parse('2026-06-25T06:00:00.000Z');
    const T2 = Date.parse('2026-06-25T12:00:00.000Z');
    // Task carries real non-claim content (context) so the heartbeat spread below
    // actually re-includes a content key — the shape that broke the naive detector.
    await addTask({ description: 'beat', id: 'task-beat', context: 'working on it' }, 'user', { now: T0 });
    // Claiming the task is a content edit (status change) → stamp advances to T1.
    await updateTask('task-beat', {
      status: 'in_progress',
      metadata: { claimedBy: 'a', claimedAt: '2026-01-01T00:00:00.000Z', leaseExpiresAt: '2026-01-01T00:30:00.000Z' }
    }, 'user', { now: T1 });
    // Real heartbeat shape (cos.js processOrphanedTasks once spread the whole
    // metadata): { ...existing, ...freshLease }. The re-included unchanged keys
    // (context, updatedAt) must NOT count as an edit — else every ~15min heartbeat
    // bumps the stamp and a lease-renewing peer spuriously wins content ties.
    const current = await getTaskById('task-beat');
    const renewed = await updateTask('task-beat', {
      metadata: { ...current.metadata, claimedBy: 'a', claimedAt: '2026-01-01T00:00:00.000Z', leaseExpiresAt: '2026-01-01T01:00:00.000Z' }
    }, 'user', { now: T2 });
    expect(renewed.metadata.leaseExpiresAt).toBe('2026-01-01T01:00:00.000Z');
    expect(renewed.metadata.updatedAt).toBe(new Date(T1).toISOString()); // NOT bumped to T2
  });

  it('DOES bump updatedAt when a spread metadata patch actually changes a non-claim value (#1714)', async () => {
    const T0 = Date.parse('2026-06-25T00:00:00.000Z');
    const T1 = Date.parse('2026-06-25T06:00:00.000Z');
    await addTask({ description: 'meta edit', id: 'task-meta', context: 'old' }, 'user', { now: T0 });
    const current = await getTaskById('task-meta');
    // Same spread shape as the heartbeat, but context genuinely changes → real edit.
    const updated = await updateTask('task-meta', {
      metadata: { ...current.metadata, context: 'new' }
    }, 'user', { now: T1 });
    expect(updated.metadata.context).toBe('new');
    expect(updated.metadata.updatedAt).toBe(new Date(T1).toISOString());
  });

  it('preserves a legacy direct field cleared to empty string (absent-vs-cleared, #1826)', async () => {
    // `context` is a LEGACY_DIRECT_FIELD. Clearing it to "" is an intentional edit
    // and must persist as "" — the `|| undefined` form mapped "" to undefined and
    // the cleanup pass then deleted the key, conflating "cleared" with "absent".
    await addTask({ description: 'ctx', id: 'task-ctx', context: 'original context' }, 'user');
    const updated = await updateTask('task-ctx', { context: '' }, 'user');
    expect(updated.metadata.context).toBe('');
    // And it survives a round-trip through markdown serialization.
    const reloaded = await getTaskById('task-ctx');
    expect(reloaded.metadata.context).toBe('');
  });

  it('still drops a legacy direct field set to null', async () => {
    await addTask({ description: 'ctx2', id: 'task-ctx2', context: 'original' }, 'user');
    const updated = await updateTask('task-ctx2', { context: null }, 'user');
    expect(updated.metadata.context).toBeUndefined();
  });

  it('returns an error object when the task id is absent', async () => {
    await addTask({ description: 'present' }, 'user');
    const result = await updateTask('task-missing', { status: 'completed' }, 'user');
    expect(result.error).toBe('Task not found');
  });
});

describe('cosTaskStore collection selection', () => {
  it.each([
    ['add', () => addTask({ description: 'Unexpected task' }, 'cos')],
    ['update', () => updateTask('sys-example', { description: 'Unexpected edit' }, 'cos')],
    ['delete', () => deleteTask('sys-example', ['user', 'internal'])],
    ['merge', () => mergePeerTasks('cos', [{ id: 'sys-example', description: 'Unexpected peer edit' }])],
  ])('rejects an invalid %s selector without changing either task queue', async (_name, mutate) => {
    await addTask({ description: 'User task', id: 'task-example' });
    await addTask({ description: 'Internal task', id: 'sys-example', approvalRequired: true }, 'internal');
    const before = [await stored('user'), await stored('internal')];
    mock.events = [];

    await expect(mutate()).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });

    expect([await stored('user'), await stored('internal')]).toEqual(before);
    expect(mock.events).toEqual([]);
  });
});

describe('cosTaskStore.deleteTask', () => {
  it('removes the task and emits tasks:changed deleted', async () => {
    const created = await addTask({ description: 'del', id: 'task-del' }, 'user');
    const result = await deleteTask(created.id, 'user');
    expect(result.success).toBe(true);
    const { tasks } = await getUserTasks();
    expect(tasks).toHaveLength(0);
    expect(mock.events.some(e => e.name === 'tasks:changed' && e.payload.action === 'deleted')).toBe(true);
  });

  it('returns an error when the task is absent', async () => {
    await addTask({ description: 'keep' }, 'user');
    expect((await deleteTask('nope', 'user')).error).toBe('Task not found');
  });
});

describe('cosTaskStore.reorderTasks', () => {
  it('reorders by id and appends any not listed', async () => {
    await addTask({ description: 'one', id: 'task-1' }, 'user');
    await addTask({ description: 'two', id: 'task-2' }, 'user');
    await addTask({ description: 'three', id: 'task-3' }, 'user');
    const result = await reorderTasks(['task-3', 'task-1']);
    expect(result.success).toBe(true);
    expect(result.order).toEqual(['task-3', 'task-1', 'task-2']);
    expect(mock.events.some(e => e.name === 'tasks:changed' && e.payload.action === 'reordered')).toBe(true);
  });
});

describe('cosTaskStore.approveTask', () => {
  it('flips approvalRequired→false / autoApproved→true and emits approved', async () => {
    await addTask({ description: 'need approve', id: 'sys-ap', approvalRequired: true }, 'internal');
    const approved = await approveTask('sys-ap');
    expect(approved.approvalRequired).toBe(false);
    expect(approved.autoApproved).toBe(true);
    expect(mock.events.some(e => e.name === 'tasks:changed' && e.payload.action === 'approved')).toBe(true);
  });

  it('bumps the updatedAt LWW stamp on approval (approval is content) (#1714)', async () => {
    const T0 = Date.parse('2026-06-25T00:00:00.000Z');
    const T1 = Date.parse('2026-06-25T06:00:00.000Z');
    await addTask({ description: 'need approve', id: 'sys-ap2', approvalRequired: true }, 'internal', { now: T0 });
    const approved = await approveTask('sys-ap2', { now: T1 });
    expect(approved.metadata.updatedAt).toBe(new Date(T1).toISOString());
    expect(removeByMetadata).toHaveBeenCalledWith('taskId', 'sys-ap2');
  });

  it('rejects a task that does not require approval', async () => {
    await addTask({ description: 'auto', id: 'sys-auto', approvalRequired: false }, 'internal');
    expect((await approveTask('sys-auto')).error).toBe('Task does not require approval');
  });

  it('returns an error when the task is in neither queue', async () => {
    expect((await approveTask('sys-x')).error).toBe('Task not found');
  });

  it('releases a USER row that holds for approval, so the hold is not a zombie', async () => {
    // A user row the importer had to RECOVER is withheld from the unattended spawn
    // and keeps that hold (#7300, #7367). Nothing else in the product can clear it:
    // `updateTask` carries the flags through untouched, so without this the row
    // stays pending forever.
    await seed('user', [{ id: 'task-held', description: 'legacy user row', status: 'pending', priority: 'URGENT', approvalRequired: true, autoApproved: false, metadata: { prompt: 'payload' } }]);

    const held = (await getUserTasks()).tasks[0];
    expect(held.approvalRequired).toBe(true);

    const approved = await approveTask('task-held');

    expect(approved.approvalRequired).toBe(false);
    expect(approved.autoApproved).toBe(true);
    expect(approved.metadata.prompt).toBe('payload');
    expect(mock.events.some(e => e.name === 'tasks:changed' && e.payload.action === 'approved' && e.payload.type === 'user')).toBe(true);
    // And the release is persisted: the stored row carries no hold.
    __resetTaskCache();
    expect((await getUserTasks()).tasks[0].approvalRequired).toBe(false);
  });
});

// ─── Source-level regression guards (moved from cos.test.js) ───────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_SRC = realReadFileSync(join(__dirname, 'cosTaskStore.js'), 'utf-8');

describe('working-set cache — no bypass (source guards, #3497)', () => {
  // Everything outside the cache accessors. Any direct repository load or save
  // the rest of the module makes is a bypass by definition.
  const ACCESSOR_START = 'async function readTaskSnapshot';
  const ACCESSOR_END = '/** Test hook: forget every cached working set. */';
  const outsideAccessors = (() => {
    const start = STORE_SRC.indexOf(ACCESSOR_START);
    const end = STORE_SRC.indexOf(ACCESSOR_END);
    if (start === -1 || end <= start) return null; // asserted below, not thrown here
    return (STORE_SRC.slice(0, start) + STORE_SRC.slice(end))
      .split('\n')
      .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*'));
  })();

  it('locates the cache accessors it is guarding', () => {
    // If this fails the guards below are vacuous — the anchors drifted.
    expect(outsideAccessors, `anchors "${ACCESSOR_START}" / "${ACCESSOR_END}" not found in order`).not.toBeNull();
  });

  it('every working-set read goes through the snapshot cache', () => {
    // A read path calling the repository directly still works, but skips the
    // version check, the shared load, and the copy-on-read that keeps a caller's
    // in-place mutations out of the cache.
    const bypasses = outsideAccessors.filter(line => /\b(loadTaskWorkingSet|readTaskListVersion)\(/.test(line));
    expect(bypasses, `direct repository read(s): ${bypasses.join(' | ')}`).toEqual([]);
  });

  it('every list save goes through writeTaskList', () => {
    // A save calling the repository directly leaves the cached working set
    // stale until its version is next checked, and skips the diff that keeps a
    // one-field change a one-row write.
    const bypasses = outsideAccessors.filter(line => /\bapplyTaskListSave\(/.test(line));
    expect(bypasses, `direct applyTaskListSave call(s): ${bypasses.join(' | ')}`).toEqual([]);
  });

  it('writeTaskList persists a row diff, never the whole queue', () => {
    const code = STORE_SRC.split('\n').filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*')).join('\n');
    expect(code).toMatch(/planListSave\(\{ previous: snapshot\.rows, next: tasks, source \}\)/);
    expect(code).not.toMatch(/generateTasksMarkdown|parseTasksMarkdown|atomicWrite/);
  });
});

describe('addTask — first-line dedup (source guards)', () => {
  it('addTask uses firstLine for dedup', () => {
    // addTask's signature destructuring (`{ raw = false } = {}`) confuses a
    // brace-balanced scanner — slice from the declaration to the next top-level
    // function instead.
    const start = STORE_SRC.indexOf('export async function addTask');
    expect(start, 'addTask must exist').toBeGreaterThan(-1);
    const end = STORE_SRC.indexOf('export async function', start + 1);
    const fnBody = STORE_SRC.slice(start, end === -1 ? undefined : end);
    expect(fnBody).toMatch(/firstLine\(taskData\.description\)/);
    expect(fnBody).toMatch(/firstLine\(t\.description\)/);
  });

  it('addTask scopes dedup by metadata.app', () => {
    // Same description against two different apps must NOT trip the duplicate
    // check — the dedup predicate compares the existing task's `metadata?.app`
    // (or null) against the candidate's app, which for raw tasks lives in
    // `taskData.metadata?.app` (top-level `taskData.app` is non-raw only).
    const start = STORE_SRC.indexOf('export async function addTask');
    const end = STORE_SRC.indexOf('export async function', start + 1);
    const fnBody = STORE_SRC.slice(start, end === -1 ? undefined : end);
    expect(fnBody).toMatch(/t\.metadata\?\.app\s*\|\|\s*null/);
    expect(fnBody).toMatch(/taskData\.metadata\?\.app/);
  });
});

// Receiver side of CoS task federation (#1712). Runs the REAL cosTaskMerge
// against the in-memory file map so the read-merge-write round-trip + write-skip
// are covered end-to-end (the merge rules themselves are unit-tested in
// cosTaskMerge.test.js).
describe('cosTaskStore.mergePeerTasks', () => {
  const NOW = Date.parse('2026-06-25T12:00:00.000Z');
  const future = (ms) => new Date(NOW + ms).toISOString();

  it('adopts a remote-only task into the file and emits tasks:changed', async () => {
    await addTask({ description: 'local task', priority: 'LOW', id: 'task-local' }, 'user');
    mock.events = [];
    const remote = [{ id: 'task-remote', taskType: 'user', status: 'pending', priority: 'HIGH', description: 'peer task', metadata: {} }];
    const res = await mergePeerTasks('user', remote, { now: NOW });
    expect(res.changed).toBe(true);
    const after = await getUserTasks();
    expect(after.tasks.map(t => t.id).sort()).toEqual(['task-local', 'task-remote']);
    expect(mock.events.some(e => e.name === 'tasks:changed' && e.payload.action === 'peer-merged')).toBe(true);
  });

  it('is a no-op (no write, no event) when the peer payload changes nothing', async () => {
    await addTask({ description: 'same', priority: 'MEDIUM', id: 'task-same' }, 'user');
    mock.events = [];
    vi.mocked(repository.applyTaskListSave).mockClear();
    const remote = [{ ...(await getTaskById('task-same')), taskType: 'user' }];
    const res = await mergePeerTasks('user', remote, { now: NOW });
    expect(res).toEqual({ changed: false });
    expect(repository.applyTaskListSave).not.toHaveBeenCalled();
    expect(mock.events.some(e => e.name === 'tasks:changed')).toBe(false);
  });

  it('invalidates proof on an older peer payload even when it retained the opaque metadata', async () => {
    await addTask({ id: 'task-legacy-peer', description: 'Peer example' }, 'user');
    mock.state.agents['agent-peer'] = { id: 'agent-peer', taskId: 'task-legacy-peer', status: 'running', startedAt: 'start' };
    const local = await updateTask('task-legacy-peer', { status: 'in_progress', metadata: {
      totalSpawnCount: 1, claimedBy: 'fixture', claimedAt: '2026-01-01T00:00:00.000Z', lastSpawnedAt: '2026-01-01T00:00:00.000Z',
    } }, 'user', { spawnBudgetOperation: { kind: 'dispatch', agentId: 'agent-peer', startedAt: 'start' } });
    expect(local.metadata.spawnBudgetProof).toBeDefined();
    await mergePeerTasks('user', [{ ...local, taskType: 'user' }], { now: NOW, legacySpawnBudget: true });
    const after = await getTaskById(local.id);
    expect(after.status).toBe(local.status);
    expect(Number(after.metadata.totalSpawnCount)).toBe(1);
    expect(after.metadata.spawnBudgetProof).toBeUndefined();
  });

  it('accepts a known same-episode dispatch ancestor but invalidates a concurrent fork', async () => {
    await addTask({ id: 'task-chain', description: 'Chain example' }, 'user');
    const claim = (count, stamp) => ({ status: 'in_progress', metadata: { totalSpawnCount: count,
      claimedBy: 'fixture', claimedAt: stamp, lastSpawnedAt: stamp } });
    mock.state.agents['agent-first'] = { id: 'agent-first', taskId: 'task-chain', status: 'running', startedAt: 'first-start' };
    const first = await updateTask('task-chain', claim(1, 'first'), 'user', { spawnBudgetOperation: { kind: 'dispatch', agentId: 'agent-first', startedAt: 'first-start' } });
    await updateTask('task-chain', { status: 'pending' }, 'user');
    mock.state.agents['agent-first'].status = 'completed';
    mock.state.agents['agent-second'] = { id: 'agent-second', taskId: 'task-chain', status: 'running', startedAt: 'second-start' };
    const second = await updateTask('task-chain', claim(2, 'second'), 'user', { spawnBudgetOperation: { kind: 'dispatch', agentId: 'agent-second', startedAt: 'second-start' } });
    await mergePeerTasks('user', [{ ...first, taskType: 'user' }], { now: NOW });
    expect((await getTaskById('task-chain')).metadata.spawnBudgetProof).toEqual(second.metadata.spawnBudgetProof);
    const fork = structuredClone(second);
    fork.metadata.spawnBudgetProof.dispatch.agentId = 'agent-competing';
    await mergePeerTasks('user', [{ ...fork, taskType: 'user' }], { now: NOW });
    expect((await getTaskById('task-chain')).metadata.spawnBudgetProof).toBeUndefined();
  });

  it("never clobbers the local peer's live claim with a remote pending copy", async () => {
    // Local task is claimed + in_progress (this instance is working it).
    await addTask({ description: 'claimed work', id: 'task-c', priority: 'HIGH' }, 'user');
    await updateTask('task-c', { status: 'in_progress', metadata: { claimedBy: 'instance-A', claimedAt: future(-1000), leaseExpiresAt: future(60_000) } }, 'user');
    // Peer still thinks it's pending + unclaimed.
    const remote = [{ id: 'task-c', taskType: 'user', status: 'pending', priority: 'HIGH', description: 'claimed work', metadata: {} }];
    await mergePeerTasks('user', remote, { now: NOW });
    const after = await getUserTasks();
    const merged = after.tasks.find(t => t.id === 'task-c');
    expect(merged.status).toBe('in_progress');
    expect(merged.metadata.claimedBy).toBe('instance-A');
  });

  it('creates the file when it does not exist yet and the peer has tasks', async () => {
    const remote = [{ id: 'sys-x', taskType: 'internal', status: 'pending', priority: 'MEDIUM', description: 'new', metadata: {} }];
    const res = await mergePeerTasks('internal', remote, { now: NOW });
    expect(res.changed).toBe(true);
    const after = await getCosTasks();
    expect(after.tasks.map(t => t.id)).toContain('sys-x');
  });

  it('adopts a metadata-less remote task through the real markdown generator without throwing', async () => {
    // A cross-version/forked peer may advertise a task with no `metadata` (the
    // wire schema marks it optional). generateTasksMarkdown does
    // Object.entries(metadata) — undefined would throw and fail the whole merge.
    const remote = [{ id: 'task-nometa', taskType: 'user', status: 'pending', priority: 'HIGH', description: 'no metadata here' }];
    const res = await mergePeerTasks('user', remote, { now: NOW });
    expect(res.changed).toBe(true);
    const after = await getUserTasks();
    const adopted = after.tasks.find(t => t.id === 'task-nometa');
    expect(adopted).toBeTruthy();
    expect(adopted.description).toBe('no metadata here');
  });

  describe('LI cross-peer execution verdict consume (#2779)', () => {
    const verdict = { appId: 'app-x', slug: 'add-metrics', scope: 'refactor', success: true, errorCategory: null, validationPassed: null };
    const handoff = (status, extraMeta = {}) => ([{
      id: 'task-handoff',
      taskType: 'internal',
      status,
      priority: 'HIGH',
      description: 'implement LI proposal',
      metadata: { liExecution: verdict, ...extraMeta }
    }]);

    beforeEach(() => { mock.liVerdicts = []; });

    it('derives recordProposalExecution when a terminal hand-off verdict is adopted', async () => {
      // Peer A holds the task in_progress (it filed + handed it off); peer B executed it
      // and its terminal state syncs back carrying the stamped verdict.
      await addTask({ description: 'implement LI proposal', id: 'task-handoff', priority: 'HIGH' }, 'internal');
      await updateTask('task-handoff', { status: 'in_progress' }, 'internal');
      const res = await mergePeerTasks('internal', handoff('completed'), { now: NOW });
      expect(res.changed).toBe(true);
      expect(mock.liVerdicts).toHaveLength(1);
      expect(mock.liVerdicts[0]).toMatchObject({ appId: 'app-x', slug: 'add-metrics', success: true });
    });

    it('re-offers the terminal verdict on EVERY sweep, including a no-op (durability replay, codex P2)', async () => {
      // The consumer owns durable, record-level idempotency, so mergePeerTasks re-offers every
      // terminal verdict each sweep — this catches a verdict a crash (or an old peer that stored
      // the terminal task before upgrading) left unconsumed, which a changed-only consume would
      // miss because the merge produces no change once the task is already terminal locally.
      await addTask({ description: 'implement LI proposal', id: 'task-handoff', priority: 'HIGH' }, 'internal');
      await updateTask('task-handoff', { status: 'completed', metadata: { liExecution: verdict } }, 'internal');
      mock.liVerdicts = [];
      const res = await mergePeerTasks('internal', handoff('completed'), { now: NOW });
      expect(res.changed).toBe(false); // already terminal locally → no file write
      expect(mock.liVerdicts).toHaveLength(1); // …but the verdict is still re-offered
      expect(mock.liVerdicts[0]).toMatchObject({ appId: 'app-x', slug: 'add-metrics' });
    });

    it('ignores a stale verdict on a NON-terminal synced task', async () => {
      // A verdict riding a pending/in_progress task (e.g. a failed attempt that will
      // retry) is not a settled execution — only a terminal adoption is consumed.
      const res = await mergePeerTasks('internal', handoff('in_progress'), { now: NOW });
      expect(res.changed).toBe(true); // task adopted
      expect(mock.liVerdicts).toHaveLength(0);
    });

    it('does not consume a terminal task that carries no verdict', async () => {
      const remote = [{ id: 'plain-done', taskType: 'internal', status: 'completed', priority: 'LOW', description: 'unrelated', metadata: {} }];
      const res = await mergePeerTasks('internal', remote, { now: NOW });
      expect(res.changed).toBe(true);
      expect(mock.liVerdicts).toHaveLength(0);
    });
  });
});

describe('cosTaskStore — stale failure-artifact reaper (#2619)', () => {
  const NOW = Date.parse('2026-06-25T12:00:00.000Z');
  const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

  describe('blockedFailureAgeMs / isReapableBlockedFailure (pure)', () => {
    const blocked = (category, blockedAt) => ({ status: 'blocked', metadata: { blockedCategory: category, blockedAt } });

    it('returns null for a non-blocked task', () => {
      expect(blockedFailureAgeMs({ status: 'pending', metadata: { blockedCategory: 'max-retries', blockedAt: daysAgo(30) } }, NOW)).toBeNull();
    });

    it('returns null when there is no blockedCategory', () => {
      expect(blockedFailureAgeMs({ status: 'blocked', metadata: { blockedAt: daysAgo(30) } }, NOW)).toBeNull();
    });

    it('leaves user-intent / open-decision categories alone', () => {
      // The workspace blocks are an open decision too: the task waits for the
      // user to fix the app's Repository Path, so auto-completing it at 14 days
      // would silently retire work nobody decided to drop.
      // `provider-config` is the same shape: an `api`-only provider can't run an
      // agent, and only the user can fix that — so a 14-day flip to `completed`
      // would report undropped work as done and federate that lie to every peer.
      for (const cat of ['user-terminated', 'agent-paused', 'challenge-escalation', 'app-unresolved', 'workspace-invalid', 'provider-config']) {
        expect(blockedFailureAgeMs(blocked(cat, daysAgo(30)), NOW)).toBeNull();
        expect(isReapableBlockedFailure(blocked(cat, daysAgo(30)), { now: NOW })).toBe(false);
      }
    });

    it('computes age from blockedAt and reaps only past the threshold', () => {
      expect(blockedFailureAgeMs(blocked('max-retries', daysAgo(20)), NOW)).toBe(20 * 24 * 60 * 60 * 1000);
      expect(isReapableBlockedFailure(blocked('max-retries', daysAgo(20)), { now: NOW })).toBe(true);
      expect(isReapableBlockedFailure(blocked('max-retries', daysAgo(10)), { now: NOW })).toBe(false);
    });

    it('falls back to lastFailureAt then updatedAt when blockedAt is absent', () => {
      expect(blockedFailureAgeMs({ status: 'blocked', metadata: { blockedCategory: 'max-spawns', lastFailureAt: daysAgo(20) } }, NOW)).toBe(20 * 24 * 60 * 60 * 1000);
      expect(blockedFailureAgeMs({ status: 'blocked', metadata: { blockedCategory: 'max-spawns', updatedAt: daysAgo(20) } }, NOW)).toBe(20 * 24 * 60 * 60 * 1000);
    });

    it('never reaps an undated block (cannot prove it is old)', () => {
      expect(blockedFailureAgeMs({ status: 'blocked', metadata: { blockedCategory: 'max-retries' } }, NOW)).toBeNull();
      expect(isReapableBlockedFailure({ status: 'blocked', metadata: { blockedCategory: 'max-retries', blockedAt: 'not-a-date' } }, { now: NOW })).toBe(false);
    });
  });

  describe('isReapableInvestigation (pure)', () => {
    const investigation = (overrides = {}) => ({
      status: 'pending',
      description: '[Auto] Investigate agent failure [fp]: boom',
      metadata: { isInvestigation: true, affectedTasks: ['task-a'] },
      ...overrides
    });

    it('reaps when every originating task is completed or gone', () => {
      const byId = new Map([['task-a', { id: 'task-a', status: 'completed' }]]);
      expect(isReapableInvestigation(investigation(), byId)).toBe(true);
      // absent origin (already reaped/deleted) also counts as resolved
      expect(isReapableInvestigation(investigation(), new Map())).toBe(true);
    });

    it('never reaps an in-progress investigation, even when its origins are all completed', () => {
      const byId = new Map([['task-a', { id: 'task-a', status: 'completed' }]]);
      expect(isReapableInvestigation(investigation({ status: 'in_progress' }), byId)).toBe(false);
    });

    it('does not reap while any originating task is still live', () => {
      const byId = new Map([['task-a', { id: 'task-a', status: 'blocked' }]]);
      expect(isReapableInvestigation(investigation(), byId)).toBe(false);
    });

    it('detects investigations by the legacy headline when the marker is absent', () => {
      const legacy = { status: 'pending', description: '[Auto] Investigate agent failure: legacy', metadata: { affectedTasks: ['task-a'] } };
      expect(isReapableInvestigation(legacy, new Map())).toBe(true);
    });

    it('leaves a non-investigation task and an already-completed investigation alone', () => {
      expect(isReapableInvestigation({ status: 'pending', description: 'ordinary', metadata: {} }, new Map())).toBe(false);
      expect(isReapableInvestigation(investigation({ status: 'completed' }), new Map())).toBe(false);
    });

    it('leaves a linkless investigation alone (cannot prove its cause is resolved)', () => {
      expect(isReapableInvestigation(investigation({ metadata: { isInvestigation: true } }), new Map())).toBe(false);
    });
  });

  describe('sweepResolvedFailureTasks (orchestration)', () => {
    it('flips a stale failure-blocked task to completed with an auto-expired marker, not deletion', async () => {
      await addTask({ description: 'failed thing', id: 'task-old', priority: 'HIGH' }, 'user', { now: NOW });
      await updateTask('task-old', { status: 'blocked', metadata: { blockedCategory: 'max-retries', blockedAt: daysAgo(20) } }, 'user', { now: NOW });
      mock.events = [];
      const res = await sweepResolvedFailureTasks({ now: NOW });
      expect(res).toMatchObject({ reaped: 1, staleBlocks: 1, investigations: 0 });
      const after = await getUserTasks();
      const task = after.tasks.find(t => t.id === 'task-old');
      expect(task).toBeTruthy(); // NOT deleted — federation-safe
      expect(task.status).toBe('completed');
      expect(task.metadata.resolution).toBe('auto-expired');
      expect(task.metadata.autoExpiredReason).toBe('stale-failure-block');
      // Leaving-blocked clears the failure metadata (existing updateTask behavior).
      expect(task.metadata.blockedCategory).toBeUndefined();
    });

    it('leaves a fresh failure block and a user-terminated block untouched', async () => {
      await addTask({ description: 'fresh', id: 'task-fresh', priority: 'LOW' }, 'user', { now: NOW });
      await updateTask('task-fresh', { status: 'blocked', metadata: { blockedCategory: 'max-retries', blockedAt: daysAgo(3) } }, 'user', { now: NOW });
      await addTask({ description: 'stopped', id: 'task-stop', priority: 'LOW' }, 'user', { now: NOW });
      await updateTask('task-stop', { status: 'blocked', metadata: { blockedCategory: 'user-terminated', blockedAt: daysAgo(60) } }, 'user', { now: NOW });
      const res = await sweepResolvedFailureTasks({ now: NOW });
      expect(res.reaped).toBe(0);
      const after = await getUserTasks();
      expect(after.tasks.find(t => t.id === 'task-fresh').status).toBe('blocked');
      expect(after.tasks.find(t => t.id === 'task-stop').status).toBe('blocked');
    });

    // A provider-config block never self-revives — it waits for the user to add a
    // CLI provider — so the reaper must leave it alone no matter how old it gets.
    // Flipping it to `completed` with `resolution: 'auto-expired'` would report
    // work nobody dropped as done, and federate that to every peer (#6193).
    it.each(['task-approval', 'task-recovery-exhausted'])('preserves the checkout and human decision for stale %s', async blockedCategory => {
      await addTask({ description: 'delivery decision', id: 'task-decision', priority: 'HIGH' }, 'user', { now: NOW });
      await updateTask('task-decision', { metadata: { existingBranch: 'fix/retained', resumedFromAgentId: 'agent-old', resumeWorktreePath: '/example/retained' } }, 'user', { now: NOW });
      await updateTask('task-decision', { status: 'blocked', metadata: { blockedCategory, blockedAt: daysAgo(90) } }, 'user', { now: NOW });
      expect((await sweepResolvedFailureTasks({ now: NOW })).reaped).toBe(0);
      const retained = await getTaskById('task-decision');
      expect(retained.status).toBe('blocked');
      expect(retained.metadata).toMatchObject({ existingBranch: 'fix/retained', resumedFromAgentId: 'agent-old', resumeWorktreePath: '/example/retained' });
    });

    it('never auto-expires a provider-config block, however stale', async () => {
      await addTask({ description: 'api-only provider pinned', id: 'task-pc-old', priority: 'HIGH' }, 'user', { now: NOW });
      await updateTask('task-pc-old', { status: 'blocked', metadata: { blockedCategory: 'provider-config', blockedAt: daysAgo(90) } }, 'user', { now: NOW });
      const res = await sweepResolvedFailureTasks({ now: NOW });
      expect(res.reaped).toBe(0);
      expect(res.staleBlocks).toBe(0);
      const task = (await getUserTasks()).tasks.find(t => t.id === 'task-pc-old');
      expect(task.status).toBe('blocked');
      expect(task.metadata.blockedCategory).toBe('provider-config');
      expect(task.metadata.resolution).toBeUndefined();
      expect(task.metadata.autoExpiredReason).toBeUndefined();
    });

    it('flips an investigation whose originating task has completed', async () => {
      await addTask({ description: 'origin work', id: 'task-origin', priority: 'HIGH' }, 'user', { now: NOW });
      await updateTask('task-origin', { status: 'completed' }, 'user', { now: NOW });
      await addTask({
        description: '[Auto] Investigate agent failure [fp]: boom',
        id: 'sys-inv',
        isInvestigation: true,
        affectedTasks: ['task-origin']
      }, 'internal', { now: NOW });
      const res = await sweepResolvedFailureTasks({ now: NOW });
      expect(res).toMatchObject({ reaped: 1, investigations: 1 });
      const after = await getCosTasks();
      const inv = after.tasks.find(t => t.id === 'sys-inv');
      expect(inv.status).toBe('completed');
      expect(inv.metadata.autoExpiredReason).toBe('investigation-resolved');
    });

    it('keeps an investigation whose originating task is still blocked', async () => {
      await addTask({ description: 'origin still broken', id: 'task-origin2', priority: 'HIGH' }, 'user', { now: NOW });
      await updateTask('task-origin2', { status: 'blocked', metadata: { blockedCategory: 'max-retries', blockedAt: daysAgo(1) } }, 'user', { now: NOW });
      await addTask({
        description: '[Auto] Investigate agent failure [fp]: boom',
        id: 'sys-inv2',
        isInvestigation: true,
        affectedTasks: ['task-origin2']
      }, 'internal', { now: NOW });
      const res = await sweepResolvedFailureTasks({ now: NOW });
      expect(res.reaped).toBe(0);
      const after = await getCosTasks();
      expect(after.tasks.find(t => t.id === 'sys-inv2').status).toBe('pending');
    });

    it('leaves an in-progress investigation running even after its origin completes', async () => {
      await addTask({ description: 'origin fixed by hand', id: 'task-origin3', priority: 'HIGH' }, 'user', { now: NOW });
      await addTask({
        description: '[Auto] Investigate agent failure [fp]: running',
        id: 'sys-running',
        isInvestigation: true,
        affectedTasks: ['task-origin3']
      }, 'internal', { now: NOW });
      await updateTask('sys-running', { status: 'in_progress' }, 'internal', { now: NOW });
      await updateTask('task-origin3', { status: 'completed' }, 'user', { now: NOW });
      const res = await sweepResolvedFailureTasks({ now: NOW });
      expect(res.reaped).toBe(0);
      const after = await getCosTasks();
      expect(after.tasks.find(t => t.id === 'sys-running').status).toBe('in_progress');
    });

    it('does not auto-expire a target that was revived between the snapshot and its flip', async () => {
      await addTask({ description: 'stale one', id: 'task-race1', priority: 'HIGH' }, 'user', { now: NOW });
      await addTask({ description: 'stale two', id: 'task-race2', priority: 'HIGH' }, 'user', { now: NOW });
      for (const id of ['task-race1', 'task-race2']) {
        await updateTask(id, { status: 'blocked', metadata: { blockedCategory: 'max-retries', blockedAt: daysAgo(20) } }, 'user', { now: NOW });
      }
      // After the first flip lands, the user revives the second target (Resume
      // → in_progress). Its flip was planned from the pre-revive snapshot.
      mock.afterWrite = async (source) => {
        if (source !== 'user') return false;
        // Revive whichever target the sweep has not flipped yet.
        const tasks = await stored('user');
        const target = tasks.find(task => task.status === 'blocked' && task.id.startsWith('task-race'));
        await seed('user', tasks.map(task => (task === target ? { ...task, status: 'in_progress' } : task)));
        return true;
      };
      const res = await sweepResolvedFailureTasks({ now: NOW });
      expect(res).toMatchObject({ reaped: 1, staleBlocks: 1 });
      const after = await getUserTasks();
      const statuses = after.tasks.filter(t => t.id.startsWith('task-race')).map(t => t.status).sort();
      expect(statuses).toEqual(['completed', 'in_progress']);
    });

    it('does not reap an investigation after its completed origin is resumed between flips', async () => {
      await addTask({ description: 'stale failure', id: 'task-race-origin-block', priority: 'HIGH' }, 'user', { now: NOW });
      await updateTask('task-race-origin-block', {
        status: 'blocked', metadata: { blockedCategory: 'max-retries', blockedAt: daysAgo(20) },
      }, 'user', { now: NOW });
      await addTask({ description: 'completed origin', id: 'task-race-origin', priority: 'HIGH' }, 'user', { now: NOW });
      await updateTask('task-race-origin', { status: 'completed' }, 'user', { now: NOW });
      await addTask({
        description: '[Auto] Investigate agent failure [race]: origin was completed',
        id: 'sys-race-origin-investigation',
        isInvestigation: true,
        affectedTasks: ['task-race-origin'],
      }, 'internal', { now: NOW });

      // The first user-queue flip lands before the investigation's planned
      // internal-queue flip. Resume the origin in that gap; the investigation
      // must be checked against this fresh origin state, not the sweep snapshot.
      mock.afterWrite = async (source) => {
        if (source !== 'user') return false;
        const tasks = await stored('user');
        await seed('user', tasks.map(task => (task.id === 'task-race-origin' ? { ...task, status: 'pending' } : task)));
        return true;
      };

      const result = await sweepResolvedFailureTasks({ now: NOW });
      expect(result).toMatchObject({ reaped: 1, staleBlocks: 1, investigations: 0 });
      expect((await getCosTasks()).tasks.find(task => task.id === 'sys-race-origin-investigation').status).toBe('pending');
    });

    it.each([
      ['blockedAt', new Date(NOW).toISOString()],
      ['blockedCategory', 'provider-config'],
    ])('preserves a new blocked episode when %s changes after the reaper snapshot', async (key, value) => {
      for (const id of ['task-episode1', 'task-episode2']) {
        await addTask({ description: `failure episode ${id}`, id, priority: 'HIGH' }, 'user', { now: NOW });
        await updateTask(id, {
          status: 'blocked', metadata: { blockedCategory: 'max-retries', blockedAt: daysAgo(20) },
        }, 'user', { now: NOW });
      }
      mock.afterWrite = async (source) => {
        if (source !== 'user') return false;
        // Model a fresh failure or user-decision hold after the snapshot, with
        // the same status as before. The completed first row stays untouched.
        const tasks = await stored('user');
        const held = tasks.find(task => task.status === 'blocked');
        await seed('user', tasks.map(task => (task === held ? { ...task, metadata: { ...task.metadata, [key]: value } } : task)));
        return true;
      };
      expect(await sweepResolvedFailureTasks({ now: NOW })).toMatchObject({ reaped: 1, staleBlocks: 1 });
      const tasks = (await getUserTasks()).tasks;
      const held = tasks.find(task => task.status === 'blocked');
      expect(held.metadata[key]).toBe(value);
      expect(held.metadata.resolution).toBeUndefined();
    });

    it('bounds the number of flips per sweep to the limit', async () => {
      for (let i = 0; i < 4; i++) {
        await addTask({ description: `old ${i}`, id: `task-b${i}`, priority: 'LOW' }, 'user', { now: NOW });
        await updateTask(`task-b${i}`, { status: 'blocked', metadata: { blockedCategory: 'max-retries', blockedAt: daysAgo(20) } }, 'user', { now: NOW });
      }
      const res = await sweepResolvedFailureTasks({ now: NOW, limit: 2 });
      expect(res.reaped).toBe(2);
      const after = await getUserTasks();
      expect(after.tasks.filter(t => t.status === 'completed')).toHaveLength(2);
      expect(after.tasks.filter(t => t.status === 'blocked')).toHaveLength(2);
    });

    it('is a no-op returning zeroed counts when nothing is reapable', async () => {
      await addTask({ description: 'plain pending', id: 'task-p', priority: 'LOW' }, 'user', { now: NOW });
      const res = await sweepResolvedFailureTasks({ now: NOW });
      expect(res).toEqual({ reaped: 0, staleBlocks: 0, investigations: 0 });
    });

    it('exposes a 14-day default threshold', () => {
      expect(DEFAULT_FAILURE_TASK_MAX_AGE_MS).toBe(14 * 24 * 60 * 60 * 1000);
    });
  });
});

describe('cosTaskStore.challengeTask / resolveTaskChallenge (#2441)', () => {
  async function seedTask(desc = 'work under dispute') {
    const created = await addTask({ description: desc, priority: 'HIGH' }, 'user');
    return created.id;
  }

  it('parks a task in challenged and records the worker case', async () => {
    const id = await seedTask();
    const result = await challengeTask(id, { reason: 'reviewer misread the diff', reviewer: 'ollama' });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('challenged');
    expect(String(result.metadata.challengeCount)).toBe('1');
    expect(result.metadata.challenge.reason).toBe('reviewer misread the diff');
    expect(result.metadata.challenge.reviewer).toBe('ollama');
    expect(mock.events.some(e => e.name === 'task:challenged')).toBe(true);
  });

  it('refuses a second dispute on the same task (bounded to one)', async () => {
    const id = await seedTask();
    await challengeTask(id, { reason: 'first' });
    const second = await challengeTask(id, { reason: 'second' });
    expect(second.code).toBe('CHALLENGE_EXHAUSTED');
  });

  it('refuses a challenge once the shared retry budget is spent (#2471)', async () => {
    const id = await seedTask('out of retries');
    // Burn the total-spawn budget — a fresh challenge would only re-queue into a
    // task agentLifecycle will immediately re-block, so it is refused up front.
    await updateTask(id, { metadata: { totalSpawnCount: MAX_TOTAL_SPAWNS } }, 'user');
    const result = await challengeTask(id, { reason: 'let me back in' });
    expect(result.code).toBe('CHALLENGE_BUDGET_EXHAUSTED');
    expect(result.error).toMatch(/Retry budget exhausted/);
  });

  it('returns NOT_FOUND for an unknown task', async () => {
    const result = await challengeTask('task-nope', { reason: 'x' });
    expect(result.code).toBe('NOT_FOUND');
  });

  it('refuses to challenge a completed task', async () => {
    const id = await seedTask('already done');
    await updateTask(id, { status: 'completed' }, 'user');
    const result = await challengeTask(id, { reason: 'too late' });
    expect(result.code).toBe('CANNOT_CHALLENGE_COMPLETED');
  });

  it('upheld resolution overturns the rejection → pending', async () => {
    const id = await seedTask();
    await challengeTask(id, { reason: 'wrong verdict' });
    const resolved = await resolveTaskChallenge(id, { outcome: 'upheld', resolvedBy: 'user' });
    expect(resolved.status).toBe('pending');
    expect(resolved.metadata.challengeResolution.outcome).toBe('upheld');
  });

  it('escalated resolution blocks the task AND files an approval-required arbitration task', async () => {
    const id = await seedTask('escalate me');
    await challengeTask(id, { reason: 'still disputed', reviewer: 'codex' });
    const resolved = await resolveTaskChallenge(id, { outcome: 'escalated', note: 'need a human' });
    expect(resolved.status).toBe('blocked');
    expect(resolved.metadata.blockedCategory).toBe('challenge-escalation');
    expect(resolved.metadata.challengeResolution.outcome).toBe('escalated');
    // The escalation surfaces to the user as an internal approval-required task.
    const internal = await getCosTasks();
    const arbitration = internal.tasks.find(t => t.description.includes(`Arbitrate disputed rejection on ${id}`));
    expect(arbitration).toBeTruthy();
    expect(arbitration.approvalRequired).toBe(true);
  });

  it('refuses to resolve a task that is not under challenge', async () => {
    const id = await seedTask();
    const result = await resolveTaskChallenge(id, { outcome: 'upheld' });
    expect(result.code).toBe('NOT_CHALLENGED');
  });

  it('rejects an invalid outcome', async () => {
    const id = await seedTask();
    await challengeTask(id, { reason: 'x' });
    const result = await resolveTaskChallenge(id, { outcome: 'bogus' });
    expect(result.code).toBe('INVALID_OUTCOME');
  });
});

describe('cosTaskStore.resolveTaskChallengeWithRecheck (#2471)', () => {
  async function seedChallenged(reviewer = 'ollama') {
    const created = await addTask({ description: 'work under dispute' }, 'user');
    await challengeTask(created.id, { reason: 'reviewer misread the diff', reviewer });
    return created.id;
  }

  it('overturns (→ pending) when the re-check finds nothing blocking', async () => {
    const id = await seedChallenged();
    mock.review = { ok: true, findings: 'No findings.' };
    const resolved = await resolveTaskChallengeWithRecheck(id, { recheck: { backend: 'ollama', diff: 'diff --git a b' } });
    expect(resolved.status).toBe('pending');
    expect(resolved.metadata.challengeResolution.outcome).toBe('upheld');
    expect(resolved.metadata.challengeResolution.note).toContain('ollama');
    // The recheck used the Code Review Defaults model when none was passed.
    expect(mock.reviewCalls[0].model).toBe('default-ollama');
  });

  it('escalates (→ blocked) when the re-check still reports a blocking finding', async () => {
    const id = await seedChallenged('lmstudio');
    mock.review = { ok: true, findings: '## Blocking\n- foo.js:10 still broken' };
    const resolved = await resolveTaskChallengeWithRecheck(id, { recheck: { backend: 'lmstudio', model: 'coder-7b', diff: 'diff' } });
    expect(resolved.status).toBe('blocked');
    expect(resolved.metadata.challengeResolution.outcome).toBe('escalated');
    expect(mock.reviewCalls[0].model).toBe('coder-7b');
  });

  // The model read is keyed off `<backend>Model`, not an ollama-or-lmstudio
  // ternary — that ternary handed a third local backend LM STUDIO's model id.
  it("reads the re-check model from the challenged backend's own scalar", async () => {
    const id = await seedChallenged('mtplx');
    mock.reviewDefaults = { lmstudioModel: 'wrong-model', mtplxModel: 'mtplx-model' };
    mock.review = { ok: true, model: 'mtplx-model', findings: 'No findings.' };
    await resolveTaskChallengeWithRecheck(id, { recheck: { backend: 'mtplx', diff: 'diff' } });
    expect(mock.reviewCalls[0].model).toBe('mtplx-model');
  });

  it('leaves an unconfigured model to the reviewer, which resolves it from the backend', async () => {
    const id = await seedChallenged();
    mock.reviewDefaults = { lmstudioModel: null, ollamaModel: null };
    mock.review = { ok: true, model: 'served-by-the-daemon', findings: 'No findings.' };
    const resolved = await resolveTaskChallengeWithRecheck(id, { recheck: { backend: 'ollama', diff: 'diff' } });
    expect(mock.reviewCalls[0].model).toBeNull();
    expect(resolved.status).toBe('pending');
    // The record names the model that actually produced the verdict, not `null`.
    expect(resolved.metadata.challengeResolution.note).toContain('served-by-the-daemon');
  });

  it('returns RECHECK_NO_MODEL (config problem, not 502) when nothing can name a model', async () => {
    const id = await seedChallenged();
    mock.reviewDefaults = { lmstudioModel: null, ollamaModel: null };
    mock.review = { ok: false, code: 'NO_MODEL', error: 'No model configured for ollama reviewer and ollama is serving no models — set one on the Settings → Code Reviewers page.' };
    const result = await resolveTaskChallengeWithRecheck(id, { recheck: { backend: 'ollama', diff: 'diff' } });
    expect(result.code).toBe('RECHECK_NO_MODEL');
    // Surfaced verbatim: the reviewer's message says WHICH gap it is.
    expect(result.error).toMatch(/No model configured/);
  });

  it('returns RECHECK_FAILED when the reviewer is unreachable', async () => {
    const id = await seedChallenged();
    mock.review = { ok: false, error: 'ollama request failed: ECONNREFUSED' };
    const result = await resolveTaskChallengeWithRecheck(id, { recheck: { backend: 'ollama', diff: 'diff' } });
    expect(result.code).toBe('RECHECK_FAILED');
  });

  it('refuses to re-check a task that is not under challenge', async () => {
    const created = await addTask({ description: 'not disputed' }, 'user');
    const result = await resolveTaskChallengeWithRecheck(created.id, { recheck: { backend: 'ollama', diff: 'diff' } });
    expect(result.code).toBe('NOT_CHALLENGED');
    // No wasted reviewer call for a non-challenged task.
    expect(mock.reviewCalls.length).toBe(0);
  });
});

describe('cosTaskStore — a repaired task is returned exactly as it is persisted (#7239)', () => {
  // The markdown store can only represent five statuses and four priorities, and
  // every write rewrites the whole file. Repairing only inside
  // generateTasksMarkdown would write one thing and hand back another, so every
  // consumer of the return value / `tasks:changed` would read the pre-repair
  // status until something re-read the file.
  it('updateTask returns the parked status, not the unrepresentable one it was given', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const created = await addTask({ description: 'work worth keeping' }, 'user');
    const updated = await updateTask(created.id, { status: 'archived' }, 'user');
    warn.mockRestore();

    expect(updated.status).toBe('blocked');
    expect(updated.metadata.unrepresentableStatus).toBe('archived');
    // And a fresh read of the file agrees with what the call returned.
    expect(await getTaskById(created.id)).toMatchObject({
      status: updated.status,
      metadata: expect.objectContaining({ unrepresentableStatus: 'archived' }),
    });
  });

  it('addTask returns the coerced priority for a producer that bypasses the route schema', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const created = await addTask({ description: 'urgent-ish', priority: 'URGENT' }, 'user');
    warn.mockRestore();

    expect(created.priority).toBe('MEDIUM');
    expect((await getTaskById(created.id)).priority).toBe('MEDIUM');
  });
});

describe('shared development work admission', () => {
  it('admits one new drain after exact delivery proof while retaining the original cleanup task', async () => {
    const { getAgentRecord } = await import('./cosAgentLifecycle.js');
    const identity = await import('./instanceIdentity.js');
    const local = vi.spyOn(identity, 'getInstanceId').mockResolvedValue('fixture-local');
    const start = '2026-01-01T00:00:00.000Z';
    const branches = ['claim/issue-1', 'claim/issue-2'];
    const heads = ['a'.repeat(40), 'b'.repeat(40)];
    const source = { id: 'sys-swarm-original', status: 'in_progress', priority: 'LOW', description: 'Claim next issue', metadata: {
      app: 'example', analysisType: 'claim-issue', perpetual: true, claimFlow: true, swarmCount: 6,
      claimedBy: 'fixture-local', claimedAt: start, lastSpawnedAt: start, totalSpawnCount: 1,
      deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-original',
      taskOutcome: { status: 'incomplete', recovery: { mode: 'cleanup' } },
    } };
    const agent = { id: 'agent-original', taskId: source.id, status: 'completed', startedAt: start, completedAt: '2026-01-01T00:02:00.000Z',
      result: { executionSuccess: true, cleanupPending: true, deliveryRecoveryOwned: true,
        taskOutcome: { status: 'incomplete', recovery: { mode: 'cleanup' } } },
      metadata: { instanceId: 'fixture-local', taskApp: 'example', taskAnalysisType: 'claim-issue', configClaimFlow: true, workspacePath: '/repo', isWorktree: false,
        checkoutCapture: { status: 'captured' }, claimBranches: branches, claimReleasedBranches: [],
        completionTaskDispatch: { taskId: source.id, taskType: 'internal', expected: [
          ['claimedBy', 'fixture-local'], ['claimedAt', start], ['lastSpawnedAt', start], ['totalSpawnCount', 1],
        ] },
        completedCheckouts: branches.map((branch, index) => ({ version: 1, agentId: 'agent-original', startedAt: start,
          capturedAt: '2026-01-01T00:01:00.000Z', repoPath: '/repo', path: `/tree/${index}`, branch, head: heads[index],
          incarnation: { pointer: { dev: '1', ino: '2', birthtimeNs: '3' } } })),
        swarmCleanupDelivery: { version: 1, continuationIssued: true, branches: branches.map((branch, index) => ({ branch, head: heads[index], prUrl: `https://github.com/a/b/pull/${index + 1}` })) },
      } };
    await seed('internal', [source]);
    getAgentRecord.mockResolvedValue(agent);
    const next = id => ({ id, status: 'pending', priority: 'LOW', description: 'Claim next issue', metadata: {
      app: 'example', analysisType: 'claim-issue', perpetual: true, claimFlow: true,
    } });
    try {
      mock.state.agents.rival = { id: 'rival', taskId: source.id, status: 'running' };
      expect(await addTask(next('sys-swarm-raced'), 'internal', { raw: true }))
        .toMatchObject({ id: source.id, duplicate: true });
      delete mock.state.agents.rival;
      const first = await addTask(next('sys-swarm-next'), 'internal', { raw: true });
      expect(first).toMatchObject({ id: 'sys-swarm-next', status: 'pending' });
      expect(await addTask(next('sys-swarm-duplicate'), 'internal', { raw: true }))
        .toMatchObject({ id: 'sys-swarm-next', duplicate: true });
      expect((await getTaskById(source.id))).toMatchObject({ status: 'in_progress', metadata: { deliveryRecovery: 'cleanup' } });
      expect(agent.metadata.completedCheckouts).toHaveLength(2);
    } finally { local.mockRestore(); }
  });

  it('does not release the drain slot for an unverified cleanup claim', async () => {
    const source = { id: 'sys-swarm-held', status: 'in_progress', priority: 'LOW', description: 'Claim next issue', metadata: {
      app: 'example', analysisType: 'claim-issue', perpetual: true, claimFlow: true,
      deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-held',
    } };
    await seed('internal', [source]);
    expect(await addTask({ id: 'swarm-next', status: 'pending', priority: 'LOW', description: source.description,
      metadata: { app: 'example', analysisType: 'claim-issue', perpetual: true, claimFlow: true } }, 'internal', { raw: true }))
      .toMatchObject({ id: source.id, duplicate: true });
  });
  it('matches a manual PR resolution and autonomous follow-up across task files and titles', async () => {
    const metadata = { app: 'example', reviewLoopPRUrl: 'https://github.com/acme/example/pull/42' };
    const manual = await addTask({ description: 'Manual resolve', metadata }, 'user');
    const scheduled = await addTask({ description: 'Scheduled follow-up', metadata }, 'internal');
    expect(scheduled).toMatchObject({ id: manual.id, duplicate: true });
    expect((await getCosTasks()).tasks).toHaveLength(0);
    await updateTask(manual.id, { status: 'completed' }, 'user');
    expect((await addTask({ description: 'New evidence', metadata }, 'internal')).duplicate).not.toBe(true);
  });
  it('persists a perpetual refill while targeted claims are running, without admitting a second drain', async () => {
    const targeted = await addTask({ description: 'Claim example issue', app: 'example', claimFlow: true, claimTarget: '42' }, 'user');
    await updateTask(targeted.id, { status: 'in_progress' }, 'user');
    const refill = await addTask({ description: 'Continue backlog', app: 'example', claimFlow: true }, 'internal');
    expect(refill.duplicate).not.toBe(true);
    expect((await getCosTasks()).tasks).toEqual(expect.arrayContaining([expect.objectContaining({ id: refill.id, status: 'pending' })]));
    expect(await addTask({ description: 'Another backlog continuation', app: 'example', claimFlow: true }, 'internal'))
      .toMatchObject({ id: refill.id, duplicate: true });
  });
  it('lets a manual pinned claim proceed alongside a running untargeted drain, but still blocks true duplicates', async () => {
    const claim = await addTask({ description: 'Claim next', app: 'example', claimFlow: true }, 'internal');
    // A manual claim of a specific issue is not a duplicate of the app's running
    // unpinned batch drain — the operator can hand-pick an issue while it runs.
    const targeted = await addTask({ description: 'Claim 42', app: 'example', claimFlow: true, claimTarget: '42' }, 'user');
    expect(targeted.duplicate).not.toBe(true);
    // But a second manual claim of the SAME issue is still a duplicate...
    expect(await addTask({ description: 'Claim 42 again', app: 'example', claimFlow: true, claimTarget: '42' }, 'user'))
      .toMatchObject({ id: targeted.id, duplicate: true });
    // ...and a second untargeted drain for the same app is still a duplicate too.
    expect(await addTask({ description: 'Claim next again', app: 'example', claimFlow: true }, 'internal'))
      .toMatchObject({ id: claim.id, duplicate: true });
    expect((await addTask({ description: 'Claim 42', app: 'different', claimFlow: true, claimTarget: '42' }, 'user')).duplicate).not.toBe(true);
  });
});


it('creates a fresh extended task rather than reviving a parked historical checkpoint', async () => {
  const legacy = await addTask({ id: 'sys-legacy-audit', description: 'Audit example', status: 'blocked', metadata: { app: 'example', auditDepth: 'deep', deepAuditId: 'historic', blockedCategory: 'deep-audit-partial', existingBranch: 'cos/preserved' } }, 'internal', { raw: true });
  const fresh = await addTask({ id: 'sys-extended-audit', description: 'Audit example', metadata: { app: 'example', auditDepth: 'deep', auditWorkflow: 'extended-v1' } }, 'internal', { raw: true });
  expect(fresh.duplicate).not.toBe(true);
  expect(fresh.id).not.toBe(legacy.id);
  expect((await getTaskById(legacy.id)).metadata).toMatchObject({ deepAuditId: 'historic', existingBranch: 'cos/preserved' });
  expect(await reviveBlockedTask(legacy.id, {}, 'internal')).toMatchObject({ error: expect.stringContaining('read-only') });
  expect((await getTaskById(legacy.id)).status).toBe('blocked');
});


it('preserves custom Deep workflow through projection and non-raw persistence', async () => {
  const { generatedJobTaskFields } = await import('../lib/autonomousJobTask.js');
  const legacy = await addTask({ id: 'sys-old-custom', description: 'Custom deep audit', status: 'blocked', metadata: { app: 'example', auditDepth: 'deep', deepAuditId: 'historic', existingBranch: 'cos/preserved' } }, 'internal', { raw: true });
  const fields = generatedJobTaskFields({ description: 'Custom deep audit', metadata: { app: 'example', auditDepth: 'deep', auditWorkflow: 'extended-v1', provider: 'codex', model: 'gpt-6-astra', effort: 'medium', openPR: true, useWorktree: true } });
  const fresh = await addTask(fields, 'internal');
  expect(fresh.duplicate).not.toBe(true);
  expect((await getTaskById(fresh.id)).metadata).toMatchObject({ auditDepth: 'deep', auditWorkflow: 'extended-v1', provider: 'codex', model: 'gpt-6-astra', effort: 'medium', openPR: 'true', useWorktree: 'true' });
  expect((await getTaskById(legacy.id)).metadata).toMatchObject({ deepAuditId: 'historic', existingBranch: 'cos/preserved' });
  await expect(addTask(generatedJobTaskFields({ metadata: { auditDepth: 'deep', deepAuditId: 'historic' } }), 'internal')).rejects.toThrow('read-only');
});

it('round-trips the server-owned audit disposition contract through persisted task metadata', async () => {
  const created = await addTask({ id: 'sys-audit-disposition-example', description: 'Audit example boundaries',
    metadata: { app: 'example', analysisType: 'security', fileIssues: false, auditDispositionVersion: 1 } }, 'internal', { raw: true });
  const reloaded = await getTaskById(created.id);
  expect(reloaded.metadata).toMatchObject({ analysisType: 'security', auditDispositionVersion: '1', fileIssues: 'false' });
});

// Completed history older than the working set. The queues are rows in one table:
// open tasks and recent/newest completed ones are the working set every poller
// reads; the rest stays reachable by id and by paged history, and must keep working
// for edit, reopen, delete and peer merge without being pulled back wholesale.
describe('cosTaskStore completed history older than the working set', () => {
  const DAY = 86_400_000;
  const CLOCK = Date.parse('2026-10-20T12:00:00Z');
  const id = (n) => `task-example-${String(n).padStart(4, '0')}`;
  const done = (n, ageDays, extra = {}) => ({
    id: id(n), description: `Example task ${n}`, status: 'completed', priority: 'MEDIUM',
    metadata: { updatedAt: new Date(CLOCK - ageDays * DAY).toISOString(), prompt: `Prompt body ${n}.` }, ...extra,
  });
  const pending = (n) => ({ id: id(n), description: `Example task ${n}`, status: 'pending', priority: 'MEDIUM', metadata: {} });
  // 105 completed tasks, ids 1..105, ages 200 days (id 1) to 96 days (id 105): the
  // newest 100 by completion stay in the working set; ids 1..5 are older history.
  const seedHistory = async () => {
    const history = Array.from({ length: 105 }, (_, index) => done(index + 1, 200 - index));
    await seed('user', [pending(900), ...history]);
  };
  const inWorkingSet = async (taskId) => (await getUserTasks()).tasks.some((task) => task.id === taskId);

  it('keeps the oldest completed tasks out of the working set but reachable by id', async () => {
    await seedHistory();
    expect(await inWorkingSet(id(1))).toBe(false);
    expect(await inWorkingSet(id(5))).toBe(false);
    expect(await inWorkingSet(id(6))).toBe(true);
    expect(await getTaskById(id(1))).toMatchObject({ id: id(1), status: 'completed', taskType: 'user', metadata: { prompt: 'Prompt body 1.' } });
    expect(await findTaskWithSource(id(1))).toMatchObject({ source: 'user' });
    expect(await getTaskById(id(999))).toBeNull();
  });

  it('keeps the cached working set bounded when a write completes another task', async () => {
    await seedHistory();
    await getUserTasks();
    await updateTask(id(900), { status: 'completed' }, 'user', { now: CLOCK });
    const completed = (await getUserTasks()).tasks.filter((task) => task.status === 'completed');
    expect(completed).toHaveLength(100);
    expect(await inWorkingSet(id(6))).toBe(false);
    expect(await getTaskById(id(6))).toMatchObject({ id: id(6), status: 'completed' });
  });

  it('reopens an old completed task in place: the edit applies, it joins the working set, no second row appears', async () => {
    await seedHistory();
    const result = await updateTask(id(1), { status: 'pending', description: 'Reopened task' }, 'user', { now: CLOCK });
    expect(result).toMatchObject({ id: id(1), status: 'pending', description: 'Reopened task' });
    expect(await inWorkingSet(id(1))).toBe(true);
    expect((await getTaskView({ kind: 'completed', source: 'user', limit: 200 })).total).toBe(104);
    expect(mock.events.some((e) => e.name === 'tasks:changed' && e.payload.type === 'user')).toBe(true);
  });

  it('leaves an old completed task untouched when its update is refused', async () => {
    await seedHistory();
    expect(await updateTask(id(1), { status: 'pending' }, 'user', { now: CLOCK, expectedStatus: 'blocked' })).toMatchObject({ statusChanged: true });
    expect((await getTaskById(id(1))).status).toBe('completed');
    expect(await updateTask(id(999), { status: 'pending' }, 'user', { now: CLOCK })).toEqual({ error: 'Task not found' });
  });

  it('deletes an old completed task and reports an unknown one as not found', async () => {
    await seedHistory();
    expect(await deleteTask(id(1), 'user')).toEqual({ success: true, taskId: id(1) });
    expect(await getTaskById(id(1))).toBeNull();
    expect((await getTaskView({ kind: 'completed', source: 'user', limit: 200 })).total).toBe(104);
    expect(await deleteTask(id(1), 'user')).toEqual({ error: 'Task not found' });
    expect(mock.events.filter((e) => e.payload?.action === 'deleted')).toHaveLength(1);
  });

  it('does not let a peer overwrite or re-introduce completed history this machine already holds', async () => {
    await seedHistory();
    const wire = (task) => ({ id: task.id, taskType: 'user', status: task.status, priority: task.priority, description: task.description, metadata: task.metadata });
    const res = await mergePeerTasks('user', [wire({ ...done(1, 200), description: 'Peer copy' }), wire(done(2000, 1)), wire(pending(2001))], { now: CLOCK });
    expect(res.changed).toBe(true);
    expect((await getTaskById(id(1))).description).toBe('Example task 1');
    expect(await inWorkingSet(id(1))).toBe(false);
    // A completion this machine has never seen, and a new open task, still arrive.
    expect(await inWorkingSet(id(2000))).toBe(true);
    expect(await inWorkingSet(id(2001))).toBe(true);
  });

  it('mints a unique id when a new task collides with a stored one, in the working set or in history', async () => {
    await seedHistory();
    const inHistory = await addTask({ description: 'Collides with history', id: id(1) }, 'user', { raw: true });
    expect(inHistory.id).toBe(`${id(1)}-dup2`);
    const again = await addTask({ description: 'Collides again', id: id(1) }, 'user', { raw: true });
    expect(again.id).toBe(`${id(1)}-dup3`);
    const live = await addTask({ description: 'Collides with an open task', id: id(900) }, 'user', { raw: true });
    expect(live.id).toBe(`${id(900)}-dup2`);
    expect((await getTaskById(id(1))).description).toBe('Example task 1');
    const ids = (await getUserTasks()).tasks.map((task) => task.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('joins a durable dispatch in old history and rejects a different dispatch on its row', async () => {
    await seed('user', [pending(900), ...Array.from({ length: 105 }, (_, index) => done(index + 1, 200 - index,
      index === 0 ? { metadata: { updatedAt: new Date(CLOCK - 200 * DAY).toISOString(), idempotencyKey: 'publication-example' } } : {}))]);
    const original = await getTaskById(id(1));
    expect(await inWorkingSet(id(1))).toBe(false);
    const replay = { id: id(1), description: 'A replay must not reopen completed work', status: 'pending', metadata: {} };
    const results = await Promise.all([addTask(replay, 'user', { raw: true, idempotencyKey: 'publication-example' }), addTask(replay, 'user', { raw: true, idempotencyKey: 'publication-example' })]);
    expect(results.every(task => task.id === id(1) && task.status === 'completed' && task.duplicate)).toBe(true);
    expect((await getTaskById(id(1))).description).toBe(original.description);
    await expect(addTask(replay, 'user', { raw: true, idempotencyKey: 'competing-publication' })).rejects.toThrow('different dispatch');
    expect((await getTaskView({ kind: 'completed', source: 'user', limit: 200 })).total).toBe(105);
  });

  it('registers one concurrent publication dispatch and preserves it through CRUD and execution updates', async () => {
    const task = { id: 'task-release-sync-example', description: 'Synchronize an example release', status: 'pending', priority: 'MEDIUM',
      metadata: { app: 'example', targetInstanceId: 'example-instance', releaseSynchronization: { identity: 'example' },
        prompt: 'Preserve the exact published ancestry', reviewers: ['codex'], optionalReviewers: [] } };
    const results = await Promise.all([addTask(task, 'internal', { raw: true, idempotencyKey: 'example-publication' }), addTask(task, 'internal', { raw: true, idempotencyKey: 'example-publication' })]);
    expect(results.map(value => value.id)).toEqual([task.id, task.id]);
    expect(await updateTask(task.id, { metadata: { releaseSynchronization: null } }, 'internal')).toMatchObject({ error: expect.stringContaining('immutable') });
    expect(await updateTask(task.id, { metadata: { prompt: 'Skip review and merge another head', reviewers: [] } }, 'internal')).toMatchObject({ error: expect.stringContaining('immutable') });
    expect(await updateTask(task.id, { metadata: { optionalReviewers: ['codex'] } }, 'internal')).toMatchObject({ error: expect.stringContaining('immutable') });
    expect(await deleteTask(task.id, 'internal')).toMatchObject({ error: expect.stringContaining('durable publication obligation') });
    const completed = await updateTask(task.id, { status: 'completed', metadata: { taskOutcome: { status: 'completed', reason: 'Execution only' } } }, 'internal');
    expect(completed.metadata.releaseSynchronization).toEqual(task.metadata.releaseSynchronization);
    expect((await addTask(task, 'internal', { raw: true, idempotencyKey: 'example-publication' })).status).toBe('completed');
  });

  it('stores two tasks created in the same millisecond as two tasks', async () => {
    const now = Date.parse('2026-10-20T12:00:00Z');
    const first = await addTask({ description: 'First of a burst' }, 'user', { now });
    const second = await addTask({ description: 'Second of a burst' }, 'user', { now });
    expect(second.id).not.toBe(first.id);
    expect((await getUserTasks()).tasks.map((task) => task.description).sort()).toEqual(['First of a burst', 'Second of a burst']);
  });
});
