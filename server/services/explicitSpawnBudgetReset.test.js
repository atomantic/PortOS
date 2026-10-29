import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ state: null, pointer: null }));
vi.mock('./cosState.js', () => ({ readAgentsStateForSafetyCheck: async () => fixture.state }));
vi.mock('./agentWorktreeCleanup.js', () => ({ resolveTaskResumePatch: async () => fixture.pointer }));
import { prepareExplicitOrphanBudgetReset } from './explicitSpawnBudgetReset.js';

const task = { id: 'task-example', status: 'in_progress', taskType: 'user', metadata: { totalSpawnCount: '1' } };
const owner = { id: 'agent-example', taskId: task.id, status: 'completed', startedAt: '2026-01-01T00:00:00.000Z',
  metadata: { isWorktree: true, workspacePath: '/fixture/worktree', worktreeBranch: 'fix/example' } };
beforeEach(() => {
  fixture.state = { trusted: true, agents: { [owner.id]: structuredClone(owner) } };
  fixture.pointer = { existingBranch: 'fix/example', resumeWorktreePath: '/fixture/worktree', resumedFromAgentId: owner.id };
});

describe('explicit orphan budget reset preparation', () => {
  it('keeps the unique stopped owner and retained checkout as the resume target', async () => {
    expect(await prepareExplicitOrphanBudgetReset(task)).toEqual({ owner, pointer: fixture.pointer });
    expect(await prepareExplicitOrphanBudgetReset({ ...task, status: 'blocked', metadata: { ...task.metadata, blockedCategory: 'task-incomplete' } }))
      .toEqual({ owner, pointer: fixture.pointer });
  });
  it.each(['unreadable', 'active', 'ambiguous', 'checkout', 'cleanup'])('holds %s evidence without making a retry decision', async condition => {
    let current = task;
    if (condition === 'unreadable') fixture.state.trusted = false;
    if (condition === 'active') fixture.state.agents.live = { id: 'live', taskId: task.id, status: 'running' };
    if (condition === 'ambiguous') fixture.state.agents.other = { ...owner, id: 'other' };
    if (condition === 'checkout') fixture.pointer = {};
    if (condition === 'cleanup') current = { ...task, metadata: { ...task.metadata, deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: owner.id } };
    expect(await prepareExplicitOrphanBudgetReset(current)).toEqual({ error: expect.any(String) });
  });
  it.each(['runtime-verification', 'internal-dependency', 'internal-dependency-unverified', 'agent-paused', 'task-approval', 'user-terminated'])
    ('does not bypass the %s prerequisite', async blockedCategory => {
      expect(await prepareExplicitOrphanBudgetReset({ ...task, status: 'blocked', metadata: { ...task.metadata, blockedCategory } }))
        .toEqual({ error: expect.any(String) });
    });
  it('does not override release synchronization or a user blocker', async () => {
    for (const metadata of [{ releaseSynchronization: { version: 1 } }, { blocker: 'Operator decision' }]) {
      expect(await prepareExplicitOrphanBudgetReset({ ...task, status: 'blocked', metadata })).toEqual({ error: expect.any(String) });
    }
  });
});
