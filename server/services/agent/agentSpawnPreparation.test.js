import { describe, it, expect, vi, afterEach } from 'vitest';

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
import { MAX_TOTAL_SPAWNS } from '../../lib/cos/cosValidation.js';
import { clearBehindPeer, recordBehindPeerSweep, trackBehindPeerSweep } from '../cos/cosBehindPeerHold.js';
import { buildClaim } from '../cos/cosTaskClaim.js';

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

// A full-sync peer on an older cosTasks schema never sees a claim made here, so
// this install leaves the tasks that peer holds to it (#16871). The sweep that
// records what the peer holds is covered in cosTasksSync.test.js.
describe('prepareAgentSpawn — tasks left to a behind-schema peer (#16871)', () => {
  const BEHIND = 'behind-peer';
  const arrange = (task) => {
    loadState.mockResolvedValue({ agents: {} }); hasActiveTaskOwner.mockReturnValue(false);
    ensureInstanceId.mockResolvedValue('local'); getTaskById.mockReset().mockResolvedValue(task);
    updateTask.mockReset().mockResolvedValue(task);
    const context = createAgentSpawnContext(task); context.cleanupOnError = vi.fn(async () => {});
    return context;
  };
  const pendingTask = (id, metadata = {}) => ({ id, taskType: 'user', status: 'pending', metadata });
  const holdForPeer = (...ids) => recordBehindPeerSweep(BEHIND, ids.map((id) => ({ id, status: 'pending' })));

  afterEach(() => { clearBehindPeer(BEHIND); vi.restoreAllMocks(); });

  it('leaves an unpinned task the peer holds pending and unclaimed, and says why on stdout', async () => {
    holdForPeer('task-shared');
    const context = arrange(pendingTask('task-shared'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await prepareAgentSpawn(context.task, context)).toBeNull();

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^⏸️ Task task-shared stays pending: left to peer instance behind-peer/));
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    // Refused before the budget, settlement and claim steps: a held task is not
    // blocked at the spawn cap or settled here on the peer's behalf.
    expect(getTaskById).not.toHaveBeenCalled();
    expect(context.cleanupOnError).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    expect(context.claimAcquired).toBe(false);
  });

  it.each([
    ['a task the peer does not hold', pendingTask('task-created-here')],
    ['a held task pinned to this install', pendingTask('task-shared', { targetInstanceId: 'local' })],
  ])('dispatches %s during the window', async (_label, task) => {
    holdForPeer('task-shared');
    const context = arrange(task);
    expect(await prepareAgentSpawn(task, context)).toBe(context);
    expect(context.claimAcquired).toBe(true);
  });

  it('yields when the sweep that reveals the peer lands during dispatch', async () => {
    const task = pendingTask('task-shared');
    const context = arrange(task);
    getTaskById.mockResolvedValueOnce(task).mockImplementationOnce(async () => { holdForPeer('task-shared'); return task; });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await prepareAgentSpawn(task, context)).toBeNull();

    expect(context.cleanupOnError).toHaveBeenCalledWith('left to a behind-schema peer');
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('still reports the peer\'s own claim on a held task as the claim it is', async () => {
    holdForPeer('task-shared');
    const context = arrange(pendingTask('task-shared', buildClaim(BEHIND)));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await prepareAgentSpawn(context.task, context)).toBeNull();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('🔒 Task task-shared is claimed by instance behind-peer (live lease)'));
  });

  // Last in this block: the wait is once per process, so it is spent after this.
  it('learns which peers are behind before the first dispatch of a fresh process', async () => {
    const sweep = vi.fn(async () => { await new Promise((resolve) => setImmediate(resolve)); holdForPeer('task-shared'); });
    trackBehindPeerSweep(sweep);
    const context = arrange(pendingTask('task-shared'));
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await prepareAgentSpawn(context.task, context)).toBeNull();

    expect(sweep).toHaveBeenCalledTimes(1);
    // Refused at the first check, before any task read: the sweep was awaited, not raced.
    expect(getTaskById).not.toHaveBeenCalled();
    expect(context.claimAcquired).toBe(false);
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
