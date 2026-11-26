import { describe, it, expect, vi } from 'vitest';

const loadState = vi.hoisted(() => vi.fn());
const hasActiveTaskOwner = vi.hoisted(() => vi.fn());
const validCleanupRefillSource = vi.hoisted(() => vi.fn());

vi.mock('../cos/cosEvents.js', () => ({ cosEvents: { emit: vi.fn(), on: vi.fn() }, emitLog: vi.fn() }));
vi.mock('../cos/cosState.js', () => ({ loadState }));
vi.mock('./agentState.js', () => ({ hasActiveTaskOwner }));
vi.mock('../cos/cosTaskStore.js', () => ({ getTaskById: vi.fn(), updateTask: vi.fn() }));
vi.mock('./agentPromptBuilder.js', () => ({ getAppWorkspace: vi.fn() }));
vi.mock('../instanceIdentity.js', () => ({ ensureInstanceId: vi.fn() }));
vi.mock('../appActivity.js', () => ({ releaseAppReviewMarker: vi.fn() }));
vi.mock('../swarmCleanupDelivery.js', () => ({ validCleanupRefillSource }));
const removeWorktreeAtPath = vi.hoisted(() => vi.fn(async () => ({ removed: true })));
vi.mock('../worktreeManager.js', () => ({ removeWorktreeAtPath }));

import { prepareAgentSpawn, createAgentSpawnContext } from './agentSpawnPreparation.js';
import { cosEvents, emitLog } from '../cos/cosEvents.js';
import { getTaskById, updateTask } from '../cos/cosTaskStore.js';
import { releaseAppReviewMarker } from '../appActivity.js';
import { ensureInstanceId } from '../instanceIdentity.js';
import { MAX_TOTAL_SPAWNS } from '../../lib/cos/cosTaskMetadata.js';

describe('prepareAgentSpawn — duplicate dispatch', () => {
  it('skips a task another run already owns and reports the skip on stdout, not stderr', async () => {
    loadState.mockResolvedValue({ agents: {} });
    hasActiveTaskOwner.mockReturnValue(true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await prepareAgentSpawn({ id: 'task-1', taskType: 'user' })).toBeNull();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('Task task-1 already has an active owner'));
    expect(warn).not.toHaveBeenCalled();
  });

  it('holds a queued swarm successor if its source changes before spawn', async () => {
    const task = { id: 'sys-swarm-refill-agent-source', taskType: 'internal', metadata: {
      app: 'app', analysisType: 'claim-issue', cleanupRefillSource: 'agent-source',
    } };
    loadState.mockResolvedValue({ agents: {} });
    hasActiveTaskOwner.mockReturnValue(false);
    ensureInstanceId.mockResolvedValue('local');
    getTaskById.mockResolvedValue(task);
    validCleanupRefillSource.mockResolvedValue(false);
    const context = createAgentSpawnContext(task);
    context.cleanupOnError = vi.fn(async () => {});
    expect(await prepareAgentSpawn(task, context)).toBeNull();
    expect(validCleanupRefillSource).toHaveBeenCalledWith('agent-source', 'claim-issue', 'app');
    expect(context.cleanupOnError).toHaveBeenCalledWith('cleanup delivery source unavailable');
  });

  // The spawn budget is the count alone: a task below the cap dispatches with no
  // other evidence of its earlier runs.
  it.each([
    ['with prior spawns', { totalSpawnCount: String(MAX_TOTAL_SPAWNS - 1), lastSpawnedAt: '2026-01-01T00:00:00.000Z' }],
    ['that has never been dispatched', {}],
  ])('admits a pending task below the spawn cap %s', async (_label, metadata) => {
    const task = { id: 'task-below-cap', taskType: 'user', status: 'pending', metadata };
    loadState.mockResolvedValue({ agents: {} }); hasActiveTaskOwner.mockReturnValue(false);
    ensureInstanceId.mockResolvedValue('local'); getTaskById.mockResolvedValue(task);
    updateTask.mockResolvedValue(task);
    const context = createAgentSpawnContext(task); context.cleanupOnError = vi.fn(async () => {});
    context.blockAndBail = vi.fn(async () => null);
    expect(await prepareAgentSpawn(task, context)).toBe(context);
    expect(context.claimAcquired).toBe(true);
    expect(context.instanceId).toBe('local');
    expect(context.cleanupOnError).not.toHaveBeenCalled();
    expect(context.blockAndBail).not.toHaveBeenCalled();
  });

  it('blocks a task at the spawn cap before claiming it', async () => {
    const task = { id: 'task-at-cap', taskType: 'user', status: 'pending', metadata: { totalSpawnCount: String(MAX_TOTAL_SPAWNS) } };
    loadState.mockResolvedValue({ agents: {} }); hasActiveTaskOwner.mockReturnValue(false);
    ensureInstanceId.mockResolvedValue('local'); getTaskById.mockResolvedValue(task);
    updateTask.mockClear();
    const context = createAgentSpawnContext(task); context.cleanupOnError = vi.fn(async () => {});
    context.blockAndBail = vi.fn(async () => null);
    expect(await prepareAgentSpawn(task, context)).toBeNull();
    expect(context.blockAndBail).toHaveBeenCalledWith({
      reason: `Max total spawns exceeded (${MAX_TOTAL_SPAWNS}/${MAX_TOTAL_SPAWNS})`, category: 'max-spawns', emit: 'none' });
    expect(context.claimAcquired).toBe(false);
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('reports a claim write failure while leaving the task queued', async () => {
    const task = { id: 'sys-release', taskType: 'internal', status: 'pending', metadata: {} };
    loadState.mockResolvedValue({ agents: {} }); hasActiveTaskOwner.mockReturnValue(false);
    ensureInstanceId.mockResolvedValue('local'); getTaskById.mockResolvedValue(task);
    
    updateTask.mockRejectedValueOnce(new Error('store unavailable')); emitLog.mockClear();
    const context = createAgentSpawnContext(task); context.cleanupOnError = vi.fn(async () => {});
    expect(await prepareAgentSpawn(task, context)).toBeNull();
    expect(emitLog).toHaveBeenCalledWith('warn', 'Holding task sys-release: claim write failed: store unavailable', { taskId: 'sys-release' });
    expect(context.cleanupOnError).toHaveBeenCalledWith('task or claim changed during dispatch');
    expect(context.claimAcquired).toBe(false);
  });

  it('reports a failed second task read before trying the claim', async () => {
    const task = { id: 'sys-release', taskType: 'internal', status: 'pending', metadata: {} };
    loadState.mockResolvedValue({ agents: {} }); hasActiveTaskOwner.mockReturnValue(false);
    ensureInstanceId.mockResolvedValue('local'); getTaskById.mockResolvedValueOnce(task).mockRejectedValueOnce(new Error('read failed'));
    
    updateTask.mockClear(); emitLog.mockClear();
    const context = createAgentSpawnContext(task); context.cleanupOnError = vi.fn(async () => {});
    expect(await prepareAgentSpawn(task, context)).toBeNull();
    expect(emitLog).toHaveBeenCalledWith('warn', 'Holding task sys-release: task state could not be read', { taskId: 'sys-release' });
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('holds when the first task read fails', async () => {
    const task = { id: 'sys-release', taskType: 'internal', status: 'pending', metadata: {} };
    loadState.mockResolvedValue({ agents: {} }); hasActiveTaskOwner.mockReturnValue(false);
    ensureInstanceId.mockResolvedValue('local'); getTaskById.mockRejectedValueOnce(new Error('read failed'));
    const context = createAgentSpawnContext(task); context.cleanupOnError = vi.fn(async () => {});
    expect(await prepareAgentSpawn(task, context)).toBeNull();
    expect(updateTask).not.toHaveBeenCalled();
    expect(context.cleanupOnError).toHaveBeenCalledWith('task state unavailable');
  });

  it.each([
    ['status', { status: 'in_progress', metadata: {} }],
    ['metadata', { status: 'pending', metadata: { changed: true } }],
  ])('holds when task %s changes between reads', async (_field, changed) => {
    const task = { id: 'sys-release', taskType: 'internal', status: 'pending', metadata: {} };
    loadState.mockResolvedValue({ agents: {} }); hasActiveTaskOwner.mockReturnValue(false);
    ensureInstanceId.mockResolvedValue('local');
    getTaskById.mockReset().mockResolvedValueOnce(task).mockResolvedValueOnce({ ...task, ...changed });
    updateTask.mockClear();
    const context = createAgentSpawnContext(task); context.cleanupOnError = vi.fn(async () => {});
    expect(await prepareAgentSpawn(task, context)).toBeNull();
    expect(updateTask).not.toHaveBeenCalled();
    expect(context.cleanupOnError).toHaveBeenCalledWith('task changed after spawn budget verification');
  });

  it.each([
    ['an error result', { error: 'claim refused' }],
    ['a changed status result', { statusChanged: true }],
  ])('holds when the claim store returns %s', async (_label, result) => {
    const task = { id: 'sys-release', taskType: 'internal', status: 'pending', metadata: {} };
    loadState.mockResolvedValue({ agents: {} }); hasActiveTaskOwner.mockReturnValue(false);
    ensureInstanceId.mockResolvedValue('local'); getTaskById.mockResolvedValue(task);
    updateTask.mockReset().mockResolvedValue(result);
    const context = createAgentSpawnContext(task); context.cleanupOnError = vi.fn(async () => {});
    expect(await prepareAgentSpawn(task, context)).toBeNull();
    expect(context.claimAcquired).toBe(false);
    expect(context.cleanupOnError).toHaveBeenCalledWith('task or claim changed during dispatch');
    expect(context.setupCatchArmed).toBe(false);
  });

  it('cleans up even when a claim write rejects without an Error', async () => {
    const task = { id: 'sys-release', taskType: 'internal', status: 'pending', metadata: {} };
    loadState.mockResolvedValue({ agents: {} }); hasActiveTaskOwner.mockReturnValue(false);
    ensureInstanceId.mockResolvedValue('local'); getTaskById.mockResolvedValue(task);
    
    updateTask.mockRejectedValueOnce(null); emitLog.mockClear();
    const context = createAgentSpawnContext(task); context.cleanupOnError = vi.fn(async () => {});
    expect(await prepareAgentSpawn(task, context)).toBeNull();
    expect(emitLog).toHaveBeenCalledWith('warn', 'Holding task sys-release: claim write failed: null', { taskId: 'sys-release' });
    expect(context.cleanupOnError).toHaveBeenCalledWith('task or claim changed during dispatch');
  });
});

// Federation spawn guards. Each test drives the real guard (cosTaskClaim,
// taskRetryHold are unmocked) and asserts no claim write happens, so bypassing a
// guard turns the test red.
describe('prepareAgentSpawn — federation spawn guards', () => {
  const future = () => new Date(Date.now() + 60_000).toISOString();
  const setup = (task, reads) => {
    loadState.mockResolvedValue({ agents: {} }); hasActiveTaskOwner.mockReturnValue(false);
    ensureInstanceId.mockResolvedValue('local');
    getTaskById.mockReset();
    for (const r of reads) getTaskById.mockResolvedValueOnce(r);
    getTaskById.mockResolvedValue(reads[reads.length - 1]);
    updateTask.mockReset().mockResolvedValue({ metadata: {} });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const context = createAgentSpawnContext(task);
    context.cleanupOnError = vi.fn(async () => {});
    return context;
  };
  const base = { id: 'task-fed', taskType: 'user', status: 'pending' };

  it('skips a task pinned to another instance before any task read', async () => {
    const task = { ...base, metadata: { targetInstanceId: 'peer' } };
    const context = setup(task, [task]);
    expect(await prepareAgentSpawn(task, context)).toBeNull();
    expect(getTaskById).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('skips a task under another instance\'s live lease before any task read', async () => {
    const task = { ...base, metadata: { claimedBy: 'peer', leaseExpiresAt: future() } };
    const context = setup(task, [task]);
    expect(await prepareAgentSpawn(task, context)).toBeNull();
    expect(getTaskById).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
  });

  // The in-memory task is clean but the persisted record (both reads, so the
  // changed-task hold doesn't fire first) carries the competing state.
  it.each([
    ['pinned to another instance', { targetInstanceId: 'peer' }, 'assigned to another instance'],
    ['claimed by a peer during dispatch', { claimedBy: 'peer', leaseExpiresAt: future() }, 'claimed by another instance'],
    ['held for its retry pointer', { retryPendingCleanup: 'agent-old' }, 'retry held pending cleanup'],
  ])('yields without claiming when the fresh record is %s', async (_label, metadata, reason) => {
    const persisted = { ...base, metadata };
    const task = { ...base, metadata: {} };
    const context = setup(task, [persisted, persisted]);
    expect(await prepareAgentSpawn(task, context)).toBeNull();
    expect(context.cleanupOnError).toHaveBeenCalledWith(reason);
    expect(updateTask).not.toHaveBeenCalled();
    expect(context.claimAcquired).toBe(false);
  });

  it('claims with the fresh record as the expected state when no guard trips', async () => {
    const persisted = { ...base, metadata: { note: 'x' } };
    const task = { ...base, metadata: {} };
    const context = setup(task, [persisted, persisted]);
    expect(await prepareAgentSpawn(task, context)).toBe(context);
    expect(updateTask).toHaveBeenCalledWith('task-fed', { metadata: expect.objectContaining({ claimedBy: 'local' }) }, 'user',
      expect.objectContaining({ expectedStatus: 'pending', expectedTask: expect.objectContaining({ metadata: persisted.metadata }) }));
    expect(context.claimAcquired).toBe(true);
  });
});

describe('createAgentSpawnContext — cleanupOnError claim release', () => {
  it('releases the acquired claim via buildRelease and skips the write when none was acquired', async () => {
    releaseAppReviewMarker.mockResolvedValue();
    updateTask.mockReset().mockResolvedValue({});
    const context = createAgentSpawnContext({ id: 'task-rel', taskType: 'user', metadata: {} });
    await context.cleanupOnError('boom');
    expect(updateTask).not.toHaveBeenCalled();

    context.claimAcquired = true;
    await context.cleanupOnError('boom');
    expect(updateTask).toHaveBeenCalledWith('task-rel',
      { metadata: { claimedBy: undefined, claimedAt: undefined, leaseExpiresAt: undefined } }, 'user');
  });
});

describe('createAgentSpawnContext — failed bookkeeping writes', () => {
  it('logs a rejected block write and still cleans up and emits agent:error', async () => {
    updateTask.mockReset().mockRejectedValue(new Error('store down'));
    releaseAppReviewMarker.mockResolvedValue(); emitLog.mockClear(); cosEvents.emit.mockClear();
    const context = createAgentSpawnContext({ id: 'task-9', taskType: 'user', metadata: {} });
    Object.assign(context, { agentId: 'agent-9', claimAcquired: true });

    expect(await context.blockAndBail({ reason: 'no provider', category: 'config' })).toBeNull();

    expect(emitLog).toHaveBeenCalledWith('warn', expect.stringContaining('Failed to persist blocked state for task task-9: store down'), { taskId: 'task-9' });
    expect(emitLog).toHaveBeenCalledWith('warn', expect.stringContaining('Failed to release claim for task task-9: store down'), { taskId: 'task-9' });
    expect(cosEvents.emit).toHaveBeenCalledWith('agent:error', expect.objectContaining({ taskId: 'task-9' }));
  });

  it('records why an unpersisted hold leaves the task pending (#16177)', async () => {
    updateTask.mockReset().mockResolvedValue({}); releaseAppReviewMarker.mockResolvedValue(); emitLog.mockClear();
    const context = createAgentSpawnContext({ id: 'task-10', taskType: 'internal', status: 'pending', metadata: {} });
    Object.assign(context, { agentId: 'agent-10' });

    expect(await context.blockAndBail({ reason: 'release-promotion-active: a pull request targeting the release branch is still open', persist: false })).toBeNull();

    expect(emitLog).toHaveBeenCalledWith('info',
      '⏸️ Task task-10 stays pending: release-promotion-active: a pull request targeting the release branch is still open', { taskId: 'task-10' });
    expect(updateTask).not.toHaveBeenCalled();
  });
});

describe('cleanupOnError — a server-provisioned claim checkout (#15517)', () => {
  it('removes the unused claim directory and its fresh branch by path, once', async () => {
    const context = createAgentSpawnContext({ id: 'task-claim', taskType: 'user', metadata: {} });
    context.agentId = 'agent-claim';
    context.spawnClaimCheckout = { repoPath: '/repos/example', worktreePath: '/worktrees/claim-example-issue-42', branchName: 'claim/issue-42', baseBranch: 'main' };
    await context.cleanupOnError('spawn failed');
    await context.cleanupOnError('spawn failed again');
    expect(removeWorktreeAtPath).toHaveBeenCalledTimes(1);
    expect(removeWorktreeAtPath).toHaveBeenCalledWith('/repos/example', '/worktrees/claim-example-issue-42',
      { branchName: 'claim/issue-42', deleteBranch: true, force: true });
  });
});
