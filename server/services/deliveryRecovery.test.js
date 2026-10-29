import { describe, it, expect, vi } from 'vitest';
import { recoverLegacyDeliveryBlocks } from './deliveryRecovery.js';

const outcome = { status: 'incomplete', reason: 'Retained work needs its remaining validation.' };
const epoch = '11111111-1111-4111-8111-111111111111';
const startedAt = '2026-10-23T00:00:00Z';
const evidence = count => {
  const dispatch = { agentId: 'agent-example', startedAt, claimedBy: 'local', claimedAt: 'claim', lastSpawnedAt: 'spawn', totalSpawnCount: count };
  return { proof: { version: 1, epoch, baseline: count - 1, dispatch }, receipt: { taskId: 'task-example', taskType: 'internal', spawnBudgetEpoch: epoch, spawnBudgetStartedAt: startedAt,
    expected: ['claimedBy', 'claimedAt', 'lastSpawnedAt', 'totalSpawnCount'].map(key => [key, dispatch[key]]) } };
};
const task = { id: 'task-example', taskType: 'internal', status: 'blocked', metadata: {
  blockedCategory: 'task-incomplete', blockedAt: '2026-10-23T00:00:00Z', taskOutcome: outcome, failureCount: 1, totalSpawnCount: 2,
  spawnBudgetProof: evidence(2).proof,
} };
const owner = { id: 'agent-example', taskId: task.id, status: 'completed', startedAt,
  result: { taskOutcome: outcome }, metadata: { worktreeBranch: 'fix/example', completionTaskDispatch: evidence(2).receipt } };
const setup = (tasks = [task]) => ({ readTasks: vi.fn(async () => tasks),
  update: vi.fn(async (_id, patch) => ({ status: patch.status || 'in_progress' })), release: vi.fn(async () => ({})) });

describe('legacy delivery recovery', () => {
  it('charges the existing retry budget under an owner fence before releasing the preserved checkout', async () => {
    const deps = setup();
    expect(await recoverLegacyDeliveryBlocks([owner], deps)).toEqual({ recovered: 1 });
    expect(deps.update).toHaveBeenCalledTimes(1);
    expect(deps.update.mock.calls[0][1].metadata).toMatchObject({ failureCount: 2, totalSpawnCount: 2, retryPendingCleanup: owner.id });
    expect(deps.update.mock.calls[0][3]).toMatchObject({ expectedTask: { metadata: task.metadata }, preserveRetryBudget: true });
    expect(deps.release).toHaveBeenCalledWith({ agentId: owner.id, task, success: false, agentMetadata: owner.metadata });
  });

  it('keeps manual holds, live owners, safety refusals, and changed snapshots untouched', async () => {
    for (const [changedTask, agents] of [
      [{ ...task, metadata: { ...task.metadata, blocker: 'Operator hold' } }, [owner]],
      [task, [owner, { ...owner, id: 'agent-live', status: 'running' }]],
      [task, [{ ...owner, metadata: { ...owner.metadata, executionInterruption: { category: 'content-refusal' } } }]],
      [task, [{ ...owner, result: { taskOutcome: { ...outcome, reason: 'Different attempt' } } }]],
    ]) {
      const deps = setup([changedTask]);
      expect(await recoverLegacyDeliveryBlocks(agents, deps)).toEqual({ recovered: 0 });
      expect(deps.update).not.toHaveBeenCalled();
    }
    const deps = setup();
    deps.update.mockResolvedValue({ statusChanged: true });
    expect(await recoverLegacyDeliveryBlocks([owner], deps)).toEqual({ recovered: 0 });
    expect(deps.release).not.toHaveBeenCalled();
  });

  it('stops exhausted tasks with choices and never resets spawn budgets', async () => {
    const deps = setup([{ ...task, metadata: { ...task.metadata, totalSpawnCount: 999, spawnBudgetProof: evidence(999).proof } }]);
    const exhaustedOwner = { ...owner, metadata: { ...owner.metadata, completionTaskDispatch: evidence(999).receipt } };
    await recoverLegacyDeliveryBlocks([exhaustedOwner], deps);
    expect(deps.update.mock.calls[0][1]).toMatchObject({ status: 'blocked', metadata: {
      totalSpawnCount: 999, blockedCategory: 'task-recovery-exhausted', blockedReason: expect.stringContaining('Options:'),
    } });
    expect(deps.release).not.toHaveBeenCalled();
  });

  it('does not requeue or release a checkout when the owner receipt exceeds the retained budget', async () => {
    const deps = setup([{ ...task, metadata: { ...task.metadata, totalSpawnCount: '1' } }]);
    expect(await recoverLegacyDeliveryBlocks([owner], deps)).toEqual({ recovered: 0 });
    expect(deps.update).not.toHaveBeenCalled();
    expect(deps.release).not.toHaveBeenCalled();
  });

  it('holds legacy delivery when the current episode proof is missing', async () => {
    const { spawnBudgetProof, ...metadata } = task.metadata;
    expect(spawnBudgetProof).toBeDefined();
    const deps = setup([{ ...task, metadata }]);
    expect(await recoverLegacyDeliveryBlocks([owner], deps)).toEqual({ recovered: 0 });
    expect(deps.update).not.toHaveBeenCalled();
    expect(deps.release).not.toHaveBeenCalled();
  });
});
