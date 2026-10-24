import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ threads: [], tasks: new Map(), beforeUpdate: null }));
vi.mock('./brainStorage.js', () => ({
  getThreads: async () => structuredClone(state.threads),
  updateWith: async (_type, id, update) => {
    const row = state.threads.find(thread => thread.id === id);
    state.beforeUpdate?.(row);
    const patch = await update(row);
    if (!patch) return null;
    Object.assign(row, patch, { updatedAt: '2026-10-25T00:00:00Z' });
    return row;
  },
}));
vi.mock('./cosTaskStore.js', () => ({ getTaskById: async id => state.tasks.get(id) }));
import { reconcileCleanupThreads } from './brainTaskThreads.js';
const fixture = (id, taskPatch = {}, threadPatch = {}) => {
  const title = '[Recovery] Finish incomplete cleanup for branch claim/example';
  state.tasks.set(id, { id, status: 'pending', description: `${title} in Example`,
    metadata: { recoveryOrigin: { subsystem: 'repository-cleanup', parentAgentId: 'original' } }, ...taskPatch });
  state.threads.push({ id, source: 'cos', status: 'open', priority: 'high', title,
    nextAction: 'Let the recovery task finish, then verify the branch and worktree are clean.',
    refs: [{ kind: 'cos.task', id, label: title }], notes: 'Synthetic diagnostic',
    createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z', ...threadPatch });
};
beforeEach(() => { state.threads = []; state.tasks.clear(); state.beforeUpdate = null; });
describe('legacy cleanup obligation reconciliation', () => {
  it('previews, archives recoverably and remains idempotent without completing machine work', async () => {
    fixture('owned');
    expect(await reconcileCleanupThreads()).toEqual({ dryRun: true, candidates: 1, archived: 0 });
    expect(state.threads[0].status).toBe('open');
    expect(await reconcileCleanupThreads({ dryRun: false })).toEqual({ dryRun: false, candidates: 1, archived: 1 });
    expect(state.threads[0]).toMatchObject({ status: 'archived', notes: 'Synthetic diagnostic',
      cleanupReconciliation: { taskId: 'owned', reason: 'machine-owned-obligation' } });
    expect(state.tasks.get('owned').status).toBe('pending');
    expect(await reconcileCleanupThreads({ dryRun: false })).toMatchObject({ candidates: 0, archived: 0 });
  });
  it('preserves personal edits, missing provenance and real decision/credential blockers', async () => {
    fixture('edited', {}, { updatedAt: '2026-10-24T01:00:00Z' });
    fixture('personal', {}, { source: 'manual' });
    fixture('unknown', { metadata: {} });
    fixture('credential', { status: 'blocked', metadata: { blockedCategory: 'provider-config' } });
    fixture('decision', { approvalRequired: true });
    fixture('missing'); state.tasks.delete('missing');
    expect(await reconcileCleanupThreads({ dryRun: false })).toMatchObject({ candidates: 0, archived: 0 });
    expect(state.threads.every(row => row.status === 'open')).toBe(true);
  });
  it('archives exact warning-producer and timed machine holds while preserving exhausted decisions', async () => {
    fixture('timed', { status: 'blocked', metadata: { blockedCategory: 'worktree-busy', recoveryOrigin: { subsystem: 'repository-cleanup', parentAgentId: 'original' } } });
    fixture('exhausted', { status: 'blocked', metadata: { blockedCategory: 'task-recovery-exhausted' } });
    const title = 'Agent cleanup issue: Example';
    fixture('warning', { description: '[Recovery] Investigate and retry failed PR for branch claim/example in Example',
      metadata: { isRecovery: true, context: 'An agent pushed branch "claim/example" to /synthetic but automated PR creation failed. Original agent: original, original task: Example.' } }, { title, nextAction: 'Let the recovery task resolve the cleanup warning, then verify the worktree.',
      refs: [{ kind: 'cos.task', id: 'warning', label: title }] });
    expect(await reconcileCleanupThreads({ dryRun: false })).toMatchObject({ candidates: 2, archived: 2 });
    expect(state.threads.find(row => row.id === 'exhausted').status).toBe('open');
  });

  it('rechecks a personal edit inside the serialized update', async () => {
    fixture('race');
    state.beforeUpdate = row => { row.updatedAt = '2026-10-24T02:00:00Z'; row.notes = 'My own next step'; };
    expect(await reconcileCleanupThreads({ dryRun: false })).toMatchObject({ candidates: 1, archived: 0 });
    expect(state.threads[0].notes).toBe('My own next step');
  });
});
