import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./apps.js', () => ({ getAppById: vi.fn() }));
vi.mock('./cosTaskStore.js', () => ({ getTaskById: vi.fn() }));
vi.mock('./agentState.js', () => ({ getActiveAgentIds: vi.fn(() => new Set(['active'])) }));
vi.mock('./cosClaimOwnership.js', () => ({ readClaimOwnershipAgents: vi.fn() }));
vi.mock('./branchReconcile.js', async (importOriginal) => ({
  ...await importOriginal(),
  reconcile: vi.fn(), buildActiveOwnerIds: vi.fn(() => new Set(['active'])),
}));
vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn() }));
vi.mock('./prWatcher.js', () => ({ readPendingMergePrs: vi.fn(() => [{ prBranch: 'claim/queued' }]) }));
import { getAppById } from './apps.js';
import { getTaskById } from './cosTaskStore.js';
import { readClaimOwnershipAgents } from './cosClaimOwnership.js';
import { reconcile } from './branchReconcile.js';
import { emitLog } from './cosEvents.js';
import { settleBranchReconcileRun } from './branchReconcileCompletion.js';

const agent = { taskId: 'task-example', metadata: { taskAnalysisType: 'branch-reconcile', taskApp: 'example' } };
describe('branch reconciliation completion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getTaskById.mockResolvedValue({ metadata: { perpetual: false } });
    getAppById.mockResolvedValue({ id: 'example', repoPath: '/example/repo', forgeAccount: 'example-account' });
    readClaimOwnershipAgents.mockResolvedValue([]);
    reconcile.mockResolvedValue({ cleaned: ['merged'], reapedSuperseded: ['superseded'], inFlight: [], skipped: [], worktreeInventory: [], orphanRemotes: { reported: [] } });
  });
  it('settles a non-perpetual run immediately using fresh ownership and its target account', async () => {
    expect(await settleBranchReconcileRun(agent)).toMatchObject({ cleaned: ['merged'], reapedSuperseded: ['superseded'] });
    expect(reconcile).toHaveBeenCalledWith('/example/repo', {
      cleanup: true, pendingMergeBranches: new Set(['claim/queued']), activeAgentIds: new Set(['active']),
      claimOwners: { agents: [], readAgents: readClaimOwnershipAgents }, forgeAccount: 'example-account'
    });
  });
  it('reports inventory-only protected and detached worktrees plus retained claims', async () => {
    reconcile.mockResolvedValue({
      cleaned: ['claim/issue-42'], inFlight: [], skipped: [],
      worktreeInventory: [
        { branch: 'release', path: '/example/release', reason: 'worktree-locked', locked: true },
        { path: '/example/detached', detached: true, reason: 'checkout-retained' },
      ],
      claimMarkersHeld: [{ branch: 'claim/issue-42', issue: 42, reason: 'claim-reservation-owner-unverified' }],
    });
    await settleBranchReconcileRun(agent);
    expect(emitLog).toHaveBeenLastCalledWith('warn', expect.stringContaining('remaining 3'), expect.objectContaining({
      counts: { heldBranches: 1, heldDetached: 1, heldClaims: 1 },
      skipCauses: { 'worktree-locked': 1, 'checkout-retained': 1, 'claim-reservation-owner-unverified': 1 },
    }));
  });
  it('counts repeated branch and inventory projections once, including actionable branches', async () => {
    reconcile.mockResolvedValue({
      cleaned: [], inFlight: [{ branch: 'fix/active', worktreePath: '/example/active' }],
      skipped: [{ branch: 'fix/held', path: '/example/held', reason: 'worktree-locked' }],
      wip: [{ branch: 'fix/held', worktreePath: '/example/held', liveOwnerReason: 'worktree-locked' }],
      worktreeInventory: [
        { branch: 'fix/active', path: '/example/active', reason: 'checkout-retained' },
        { branch: 'fix/held', path: '/example/held', reason: 'worktree-locked' },
      ],
    });
    await settleBranchReconcileRun(agent);
    expect(emitLog).toHaveBeenLastCalledWith('warn', expect.stringContaining('remaining 2'), expect.objectContaining({
      counts: { heldBranches: 1, heldDetached: 0, heldBackMerged: 1 },
      skipCauses: { 'worktree-locked': 1 },
    }));
  });
  it.each([
    { worktreeInventory: null },
    { orphanRemotes: { remoteUnavailable: true } },
    { forgeUnavailable: true },
    { prStateUnavailable: true },
  ])('warns when the completion scan is incomplete: %j', async (incomplete) => {
    reconcile.mockResolvedValue({ cleaned: [], inFlight: [], skipped: [], worktreeInventory: [], ...incomplete });
    await settleBranchReconcileRun(agent);
    expect(emitLog).toHaveBeenLastCalledWith('warn', expect.stringContaining('; scan incomplete'), expect.any(Object));
  });
  it('reports a known empty inventory as complete', async () => {
    await settleBranchReconcileRun(agent);
    expect(emitLog).toHaveBeenLastCalledWith('info',
      'Branch reconciliation completion: cleaned 1, superseded 1, remaining 0',
      expect.objectContaining({ counts: null, skipCauses: null }));
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
