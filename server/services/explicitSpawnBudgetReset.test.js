import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ state: null, pointer: null }));
vi.mock('./cos/cosState.js', () => ({ readAgentsStateForSafetyCheck: async () => fixture.state }));
vi.mock('./agent/agentWorktreeCleanup.js', () => ({ resolveTaskResumePatch: async () => fixture.pointer }));
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
  // Completed runs are archived out of live state after a day, so an old block has none left.
  describe('no stopped run left in live state', () => {
    const capped = { ...task, status: 'blocked', metadata: { blockedCategory: 'max-spawns', totalSpawnCount: 5 } };
    beforeEach(() => { fixture.state.agents = {}; });

    it('restarts a blocked task clean, with no owner and no resume pointer', async () => {
      expect(await prepareExplicitOrphanBudgetReset(capped)).toEqual({ owner: null, pointer: null });
    });
    it('holds an in_progress task, whose checkout only the archived run could identify', async () => {
      expect(await prepareExplicitOrphanBudgetReset(task)).toEqual({
        error: 'No stopped run of this task is left in agent history; inspect its checkout before retrying' });
    });
    it('still refuses a blocked task while an agent owns it', async () => {
      fixture.state.agents.live = { id: 'live', taskId: task.id, status: 'paused' };
      expect(await prepareExplicitOrphanBudgetReset(capped)).toEqual({ error: 'An agent still owns this task' });
    });
  });

  // A task at its spawn cap has a stopped run per spawn. Only the receipt of the
  // run that dispatched it last still matches the task, so that one is resumed.
  describe('several stopped runs', () => {
    const exhausted = { id: task.id, status: 'blocked', taskType: 'user',
      metadata: { blockedCategory: 'max-spawns', totalSpawnCount: 5, lastSpawnedAt: '2026-01-05T00:00:00.000Z' } };
    const run = (id, count, lastSpawnedAt) => ({ ...owner, id, metadata: { ...owner.metadata,
      completionTaskDispatch: { taskId: task.id, taskType: 'user',
        expected: [['claimedBy', 'local'], ['claimedAt', lastSpawnedAt], ['lastSpawnedAt', lastSpawnedAt], ['totalSpawnCount', count]] } } });
    const earlier = run('agent-fourth', 4, '2026-01-04T00:00:00.000Z');
    const latest = run('agent-fifth', 5, '2026-01-05T00:00:00.000Z');

    it('resumes the run that dispatched the task last', async () => {
      fixture.state.agents = { [earlier.id]: earlier, [latest.id]: latest, legacy: { ...owner, id: 'legacy' } };
      fixture.pointer = { existingBranch: 'fix/example', resumeWorktreePath: '/fixture/worktree', resumedFromAgentId: latest.id };
      expect(await prepareExplicitOrphanBudgetReset(exhausted)).toEqual({ owner: latest, pointer: fixture.pointer });
    });

    it.each([
      ['none of them is the latest dispatch', { [earlier.id]: earlier, legacy: { ...owner, id: 'legacy' } }],
      ['two of them claim the latest dispatch', { [latest.id]: latest, twin: { ...latest, id: 'twin' } }],
    ])('holds when %s', async (_label, agents) => {
      fixture.state.agents = agents;
      expect(await prepareExplicitOrphanBudgetReset(exhausted)).toEqual({ error: expect.stringContaining('ambiguous') });
    });
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
