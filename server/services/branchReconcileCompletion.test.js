import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./apps.js', () => ({ getAppById: vi.fn() }));
vi.mock('./cosTaskStore.js', () => ({ getTaskById: vi.fn() }));
vi.mock('./agentState.js', () => ({ getActiveAgentIds: vi.fn(() => new Set(['active'])) }));
vi.mock('./cosClaimOwnership.js', () => ({ readClaimOwnershipAgents: vi.fn() }));
vi.mock('./branchReconcile.js', () => ({
  reconcile: vi.fn(), buildActiveOwnerIds: vi.fn(() => new Set(['active'])),
  describeIdleReconcilePark: vi.fn(() => ({ counts: null, skipCauses: null }))
}));
vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn() }));
vi.mock('./prWatcher.js', () => ({ readPendingMergePrs: vi.fn(() => [{ prBranch: 'claim/queued' }]) }));
import { getAppById } from './apps.js';
import { getTaskById } from './cosTaskStore.js';
import { readClaimOwnershipAgents } from './cosClaimOwnership.js';
import { reconcile } from './branchReconcile.js';
import { settleBranchReconcileRun } from './branchReconcileCompletion.js';

const agent = { taskId: 'task-example', metadata: { taskAnalysisType: 'branch-reconcile', taskApp: 'example' } };
describe('branch reconciliation completion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getTaskById.mockResolvedValue({ metadata: { perpetual: false } });
    getAppById.mockResolvedValue({ id: 'example', repoPath: '/example/repo', forgeAccount: 'example-account' });
    readClaimOwnershipAgents.mockResolvedValue([]);
    reconcile.mockResolvedValue({ cleaned: ['merged'], reapedSuperseded: ['superseded'], inFlight: [], skipped: [] });
  });
  it('settles a non-perpetual run immediately using fresh ownership and its target account', async () => {
    expect(await settleBranchReconcileRun(agent)).toMatchObject({ cleaned: ['merged'], reapedSuperseded: ['superseded'] });
    expect(reconcile).toHaveBeenCalledWith('/example/repo', {
      cleanup: true, pendingMergeBranches: new Set(['claim/queued']), activeAgentIds: new Set(['active']),
      claimOwners: { agents: [], readAgents: readClaimOwnershipAgents }, forgeAccount: 'example-account'
    });
  });
  it('cleans verified work even when the coordinator failed after making progress', async () => {
    await settleBranchReconcileRun({ ...agent, result: { success: false } });
    expect(reconcile).toHaveBeenCalledOnce();
  });
  it('preserves a disabled cleanup action and missing task policy', async () => {
    getTaskById.mockResolvedValueOnce({ metadata: { cleanupMerged: false } }).mockResolvedValueOnce(null);
    await settleBranchReconcileRun(agent);
    await settleBranchReconcileRun(agent);
    expect(reconcile).not.toHaveBeenCalled();
  });
  it('fails closed on unreadable ownership or a missing target', async () => {
    readClaimOwnershipAgents.mockRejectedValueOnce(new Error('unreadable'));
    await expect(settleBranchReconcileRun(agent)).rejects.toThrow('unreadable');
    getAppById.mockResolvedValueOnce(null);
    await expect(settleBranchReconcileRun(agent)).rejects.toThrow('target unavailable');
    expect(reconcile).not.toHaveBeenCalled();
  });
  it('ignores other completed task types', async () => {
    await settleBranchReconcileRun({ metadata: { taskAnalysisType: 'claim-issue' } });
    expect(getTaskById).not.toHaveBeenCalled();
  });
});
