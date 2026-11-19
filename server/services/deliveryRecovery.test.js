import { describe, it, expect, vi } from 'vitest';
import { recoverLegacyDeliveryBlocks } from './deliveryRecovery.js';

const outcome = { status: 'incomplete', reason: 'Retained work needs its remaining validation.' };
const startedAt = '2026-10-23T00:00:00Z';
// What a dispatch binds onto its agent. The block released the task's claim, so
// its spawn stamp and count are what still tie it to that dispatch.
const receipt = (count, lastSpawnedAt = 'spawn') => ({ taskId: 'task-example', taskType: 'internal',
  expected: [['claimedBy', 'local'], ['claimedAt', 'claim'], ['lastSpawnedAt', lastSpawnedAt], ['totalSpawnCount', count]] });
const task = { id: 'task-example', taskType: 'internal', status: 'blocked', metadata: {
  blockedCategory: 'task-incomplete', blockedAt: '2026-10-23T00:00:00Z', taskOutcome: outcome, failureCount: 1, totalSpawnCount: 2,
  lastSpawnedAt: 'spawn',
} };
const owner = { id: 'agent-example', taskId: task.id, status: 'completed', startedAt,
  result: { taskOutcome: outcome }, metadata: { worktreeBranch: 'fix/example', completionTaskDispatch: receipt(2) } };
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
    const deps = setup([{ ...task, metadata: { ...task.metadata, totalSpawnCount: 999 } }]);
    const exhaustedOwner = { ...owner, metadata: { ...owner.metadata, completionTaskDispatch: receipt(999) } };
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

  it.each([
    ['has no dispatch receipt', { ...owner, metadata: { worktreeBranch: 'fix/example' } }, task],
    ['was superseded by a later dispatch', owner, { ...task, metadata: { ...task.metadata, lastSpawnedAt: 'later-spawn', totalSpawnCount: 3 } }],
    ['dispatched before a budget reset', owner, { ...task, metadata: { ...task.metadata, totalSpawnCount: undefined } }],
    ['holds a receipt for another task', { ...owner, metadata: { ...owner.metadata, completionTaskDispatch: { ...receipt(2), taskId: 'task-other' } } }, task],
    ['holds a receipt with a duplicated field', { ...owner, metadata: { ...owner.metadata,
      completionTaskDispatch: { ...receipt(2), expected: [...receipt(2).expected, ['totalSpawnCount', 2]] } } }, task],
  ])('holds delivery when the completed owner %s', async (_label, candidate, blocked) => {
    const deps = setup([blocked]);
    expect(await recoverLegacyDeliveryBlocks([candidate], deps)).toEqual({ recovered: 0 });
    expect(deps.update).not.toHaveBeenCalled();
    expect(deps.release).not.toHaveBeenCalled();
  });
});
