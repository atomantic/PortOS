import { describe, it, expect, vi } from 'vitest';

const loadState = vi.hoisted(() => vi.fn());
const hasActiveTaskOwner = vi.hoisted(() => vi.fn());
const validCleanupRefillSource = vi.hoisted(() => vi.fn());

vi.mock('./cosEvents.js', () => ({ cosEvents: { emit: vi.fn(), on: vi.fn() }, emitLog: vi.fn() }));
vi.mock('./cosState.js', () => ({ loadState }));
vi.mock('./agentState.js', () => ({ hasActiveTaskOwner }));
vi.mock('./cosTaskStore.js', () => ({ getTaskById: vi.fn(), updateTask: vi.fn() }));
vi.mock('./toolStateMachine.js', () => ({
  createToolExecution: vi.fn(), startExecution: vi.fn(), completeExecution: vi.fn(), errorExecution: vi.fn(),
}));
vi.mock('./executionLanes.js', () => ({ determineLane: vi.fn(), acquire: vi.fn(), release: vi.fn() }));
vi.mock('./agentPromptBuilder.js', () => ({ getAppWorkspace: vi.fn() }));
vi.mock('./instanceIdentity.js', () => ({ ensureInstanceId: vi.fn() }));
vi.mock('./appActivity.js', () => ({ releaseAppReviewMarker: vi.fn() }));
vi.mock('./swarmCleanupDelivery.js', () => ({ validCleanupRefillSource }));

import { prepareAgentSpawn, createAgentSpawnContext } from './agentSpawnPreparation.js';
import { cosEvents, emitLog } from './cosEvents.js';
import { getTaskById, updateTask } from './cosTaskStore.js';
import { acquire, release } from './executionLanes.js';
import { releaseAppReviewMarker } from './appActivity.js';
import { createToolExecution } from './toolStateMachine.js';
import { ensureInstanceId } from './instanceIdentity.js';

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
    acquire.mockReturnValue({ success: true });
    createToolExecution.mockReturnValue({ id: 'execution' });
    getTaskById.mockResolvedValue(task);
    validCleanupRefillSource.mockResolvedValue(false);
    const context = createAgentSpawnContext(task);
    context.cleanupOnError = vi.fn(async () => {});
    expect(await prepareAgentSpawn(task, context)).toBeNull();
    expect(validCleanupRefillSource).toHaveBeenCalledWith('agent-source', 'claim-issue', 'app');
    expect(context.cleanupOnError).toHaveBeenCalledWith('cleanup delivery source unavailable');
  });
});

describe('createAgentSpawnContext — failed bookkeeping writes', () => {
  it('logs a rejected block write and still cleans up and emits agent:error', async () => {
    updateTask.mockReset().mockRejectedValue(new Error('store down'));
    releaseAppReviewMarker.mockResolvedValue(); emitLog.mockClear(); release.mockClear(); cosEvents.emit.mockClear();
    const context = createAgentSpawnContext({ id: 'task-9', taskType: 'user', metadata: {} });
    Object.assign(context, { laneAcquired: true, agentId: 'agent-9', claimAcquired: true });

    expect(await context.blockAndBail({ reason: 'no provider', category: 'config' })).toBeNull();

    expect(emitLog).toHaveBeenCalledWith('warn', expect.stringContaining('Failed to persist blocked state for task task-9: store down'), { taskId: 'task-9' });
    expect(emitLog).toHaveBeenCalledWith('warn', expect.stringContaining('Failed to release claim for task task-9: store down'), { taskId: 'task-9' });
    expect(release).toHaveBeenCalledWith('agent-9');
    expect(cosEvents.emit).toHaveBeenCalledWith('agent:error', expect.objectContaining({ taskId: 'task-9' }));
  });
});
