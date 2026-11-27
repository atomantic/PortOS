import { beforeEach, describe, expect, it, vi } from 'vitest';

const getTaskById = vi.hoisted(() => vi.fn());
const updateTask = vi.hoisted(() => vi.fn());
const updateAgent = vi.hoisted(() => vi.fn());
const readAgentsStateForSafetyCheck = vi.hoisted(() => vi.fn());
vi.mock('../cos/cosTaskStore.js', () => ({ getTaskById, updateTask }));
vi.mock('../cos/cosAgentLifecycle.js', () => ({ updateAgent }));
vi.mock('../cos/cosState.js', () => ({ readAgentsStateForSafetyCheck }));

import { bindCompletionTaskDispatch, prepareCompletionTaskHandoff, recoverCompletionTaskHandoff } from './agentCompletionTaskHandoff.js';
import { activeAgents, runnerAgents } from './agentState.js';

const agent = { id: 'agent-a', taskId: 'task-a', status: 'running', startedAt: 'start-a', result: { cleanupPending: true, taskOutcome: 'done' },
  metadata: { completionTaskDispatch: { taskId: 'task-a', taskType: 'user', expected: [
    ['claimedBy', 'instance-a'], ['claimedAt', 'claim-a'], ['lastSpawnedAt', 'spawn-a'], ['totalSpawnCount', 2],
  ] }, completionCleanup: { taskHandoff: { version: 1, taskId: 'task-a', taskType: 'user', startedAt: 'start-a', expected: [
    ['claimedBy', 'instance-a'], ['claimedAt', 'claim-a'], ['lastSpawnedAt', 'spawn-a'], ['totalSpawnCount', 2],
    ['updatedAt', null], ['deliveryRecovery', null], ['deliveryRecoveryAgentId', null],
  ], metadataPatch: [{ key: 'followUp', value: 'saved' }] } } } };
const task = () => ({ id: 'task-a', taskType: 'user', status: 'in_progress', metadata: {
  claimedBy: 'instance-a', claimedAt: 'claim-a', lastSpawnedAt: 'spawn-a', totalSpawnCount: '2',
} });

beforeEach(() => {
  vi.clearAllMocks(); activeAgents.clear(); runnerAgents.clear();
  getTaskById.mockResolvedValue(task());
  updateTask.mockResolvedValue({ id: 'task-a', metadata: { deliveryRecovery: 'cleanup' } });
  updateAgent.mockResolvedValue({ status: 'running' });
  readAgentsStateForSafetyCheck.mockResolvedValue({ trusted: true, agents: {} });
});

describe('recoverCompletionTaskHandoff', () => {
  it('returns an already recorded recovery for this agent unchanged', async () => {
    const current = { ...task(), metadata: { deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: agent.id } };
    getTaskById.mockResolvedValue(current);
    expect(await recoverCompletionTaskHandoff(agent)).toBe(current);
    expect(updateTask).not.toHaveBeenCalled();
  });

  it.each([
    ['another persisted running owner', () => readAgentsStateForSafetyCheck.mockResolvedValue({ trusted: true, agents: { other: { id: 'other', taskId: 'task-a', status: 'running' } } }), agent],
    ['another live in-memory owner', () => activeAgents.set('other', { id: 'other', taskId: 'task-a' }), agent],
    ['an untrusted agent state', () => readAgentsStateForSafetyCheck.mockResolvedValue({ trusted: false, agents: {} }), agent],
    ['a task no longer in progress', () => getTaskById.mockResolvedValue({ ...task(), status: 'pending' }), agent],
    ['a changed dispatch stamp', () => getTaskById.mockResolvedValue({ ...task(), metadata: { ...task().metadata, lastSpawnedAt: 'new-spawn' } }), agent],
    ['a different recorded run start time', () => {}, { ...agent, startedAt: 'newer-start' }],
  ])('does not write when fenced by %s', async (_name, arrange, targetAgent) => {
    arrange();
    expect(await recoverCompletionTaskHandoff(targetAgent)).toBeNull();
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('refuses a competing runner owner and replays the saved metadata patch otherwise', async () => {
    runnerAgents.set('other', { id: 'other', taskId: 'task-a' });
    expect(await recoverCompletionTaskHandoff(agent)).toBeNull();
    expect(updateTask).not.toHaveBeenCalled();
    runnerAgents.clear();
    const current = task(); getTaskById.mockResolvedValue(current);
    await recoverCompletionTaskHandoff(agent);
    expect(updateTask).toHaveBeenCalledWith('task-a', expect.objectContaining({ metadata: expect.objectContaining({
      followUp: 'saved', deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-a', taskOutcome: 'done',
    }) }), 'user', expect.objectContaining({ expectedStatus: 'in_progress' }));
  });
});

describe('completion dispatch handoff preparation', () => {
  it('binds only tasks with all required dispatch fields', async () => {
    for (const metadata of [{ claimedBy: 'instance-a', totalSpawnCount: 2 }, { lastSpawnedAt: 'stamp', totalSpawnCount: 2 }, { lastSpawnedAt: 'stamp', claimedBy: 'instance-a' }]) {
      expect(await bindCompletionTaskDispatch('agent-a', { id: 'task-a', status: 'in_progress', metadata })).toBe(false);
    }
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it('refuses a non-running agent and a task whose dispatch fields drifted', async () => {
    expect(await prepareCompletionTaskHandoff({ ...agent, status: 'completed' })).toBe(false);
    getTaskById.mockResolvedValue({ ...task(), metadata: { ...task().metadata, claimedBy: 'other' } });
    expect(await prepareCompletionTaskHandoff(agent)).toBe(false);
    expect(updateAgent).not.toHaveBeenCalled();
  });
});
