import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./cosAgentLifecycle.js', () => ({ recordCleanupOutcome: vi.fn(async () => true), recordRepoCleanupRecovery: vi.fn(async () => true) }));
vi.mock('./apps.js', () => ({ getAppById: vi.fn() }));
vi.mock('./cosTaskStore.js', () => ({ getTaskById: vi.fn() }));
vi.mock('./agentState.js', () => ({ getActiveAgentIds: vi.fn(() => new Set(['active'])) }));
vi.mock('./cosClaimOwnership.js', () => ({ readClaimOwnershipAgents: vi.fn() }));
vi.mock('./branchReconcile.js', async (importOriginal) => ({
  ...await importOriginal(),
  reconcile: vi.fn(), buildActiveOwnerIds: vi.fn(() => new Set(['active'])),
}));
vi.mock('./branchReconcileOutcome.js', () => ({ getBranchReconcileOutcome: vi.fn(), recordBranchReconcileOutcome: vi.fn() }));
vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn() }));
vi.mock('./prWatcher.js', () => ({ readPendingMergePrs: vi.fn(() => [{ prBranch: 'claim/queued' }]) }));
import { recordCleanupOutcome, recordRepoCleanupRecovery } from './cosAgentLifecycle.js';
import { getAppById } from './apps.js';
import { getTaskById } from './cosTaskStore.js';
import { readClaimOwnershipAgents } from './cosClaimOwnership.js';
import { reconcile } from './branchReconcile.js';
import { emitLog } from './cosEvents.js';
import { getBranchReconcileOutcome, recordBranchReconcileOutcome } from './branchReconcileOutcome.js';
import { settleBranchReconcileRun, settleRetirementReviewRun } from './branchReconcileCompletion.js';

const agent = { id: 'agent-reconcile', taskId: 'task-example', metadata: { taskAnalysisType: 'branch-reconcile', taskApp: 'example' } };
describe('branch reconciliation completion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getBranchReconcileOutcome.mockResolvedValue(null);
    getTaskById.mockResolvedValue({ id: 'task-example', metadata: { perpetual: false } });
    getAppById.mockResolvedValue({ id: 'example', repoPath: '/example/repo', forgeAccount: 'example-account' });
    readClaimOwnershipAgents.mockResolvedValue([]);
    reconcile.mockResolvedValue({ cleaned: ['merged'], reapedSuperseded: ['superseded'], inFlight: [], skipped: [], worktreeInventory: [], orphanRemotes: { reported: [] } });
  });
  it('settles a non-perpetual run immediately using fresh ownership and its target account', async () => {
    expect(await settleBranchReconcileRun(agent)).toMatchObject({ cleaned: ['merged'], reapedSuperseded: ['superseded'] });
    expect(reconcile).toHaveBeenCalledWith('/example/repo', {
      appId: 'example', cleanup: true, reapSuperseded: true, pendingMergeBranches: new Set(['claim/queued']), activeAgentIds: new Set(['active']),
      claimOwners: { agents: [], readAgents: readClaimOwnershipAgents }, forgeAccount: 'example-account'
    });
  });
  it('keeps superseded branches when the task turns reapSuperseded off', async () => {
    getTaskById.mockResolvedValue({ id: 'task-example', metadata: { reapSuperseded: false } });
    await settleBranchReconcileRun(agent);
    expect(reconcile).toHaveBeenCalledWith('/example/repo', expect.objectContaining({ cleanup: true, reapSuperseded: false }));
  });
  it('records an incomplete outcome instead of throwing when the run has no managed app', async () => {
    const appless = { ...agent, metadata: { ...agent.metadata, taskApp: null } };
    expect(await settleBranchReconcileRun(appless)).toBeNull();
    expect(getAppById).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(recordBranchReconcileOutcome).toHaveBeenCalledWith(null, expect.objectContaining({ status: 'incomplete', reason: 'no-managed-app-target' }));
  });
  it('requires an exact persisted archive receipt after the review task reports success', async () => {
    const release = { branch: 'claim/issue-42', path: '/example/checkout', head: 'a'.repeat(40) };
    getTaskById.mockResolvedValue({ id: 'task-example', metadata: { reconcileRetirements: [{ release, cognition: { ownerAgentId: 'original-owner', observation: 'exact-observation' }, createdAt: '2026-10-20T00:00:00Z', prUrl: 'https://github.com/example/repo/pull/42' }] } });
    getBranchReconcileOutcome.mockResolvedValue({ retired: [{ ...release, branchDeleted: true }] });
    await settleBranchReconcileRun({ ...agent, result: { success: true } });
    expect(recordBranchReconcileOutcome).toHaveBeenCalledWith('example', expect.objectContaining({ status: 'incomplete', reason: 'retirement-receipt-unverified' }));
    expect(emitLog).toHaveBeenLastCalledWith('warn', expect.stringContaining('remaining 1; scan incomplete'), expect.any(Object));
    recordBranchReconcileOutcome.mockClear();
    getBranchReconcileOutcome.mockResolvedValue({ retired: [{ ...release, branchDeleted: true, archiveDir: '/example/archive', retiredAt: '2026-10-20T00:01:00Z' }] });
    await settleBranchReconcileRun({ ...agent, result: { success: true } });
    expect(recordBranchReconcileOutcome).not.toHaveBeenCalled();
    expect(recordRepoCleanupRecovery).toHaveBeenCalledWith('original-owner', release.branch, 'exact-observation', { phase: 'completed', taskId: 'task-example' });
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
    expect(emitLog).toHaveBeenLastCalledWith('info', expect.stringContaining('remaining 3'), expect.objectContaining({
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
    expect(emitLog).toHaveBeenLastCalledWith('info', expect.stringContaining('remaining 2'), expect.objectContaining({
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
  it('fails closed on unreadable ownership and records an unresolvable app target', async () => {
    readClaimOwnershipAgents.mockRejectedValueOnce(new Error('unreadable'));
    await expect(settleBranchReconcileRun(agent)).rejects.toThrow('unreadable');
    getAppById.mockResolvedValueOnce(null);
    expect(await settleBranchReconcileRun(agent)).toBeNull();
    expect(recordBranchReconcileOutcome).toHaveBeenCalledWith('example', expect.objectContaining({ reason: 'no-managed-app-target' }));
    expect(reconcile).not.toHaveBeenCalled();
  });
  it('ignores other completed task types', async () => {
    await settleBranchReconcileRun({ metadata: { taskAnalysisType: 'claim-issue' } });
    expect(getTaskById).not.toHaveBeenCalled();
  });
});


describe('legacy cleanup recovery completion', () => {
  it('keeps a recovery without an exact persisted retirement target unresolved', async () => {
    vi.clearAllMocks();
    getTaskById.mockResolvedValue({ id: 'legacy-recovery', taskType: 'internal', metadata: {} });
    const recovery = { id: 'legacy-agent', taskId: 'legacy-recovery', result: { success: true }, metadata: {
      recoveryOrigin: { subsystem: 'repository-cleanup' }, retirementReview: { appId: 'untrusted-hint' },
    } };
    expect(await settleRetirementReviewRun(recovery)).toEqual({ verified: false });
    expect(recordCleanupOutcome).toHaveBeenCalledWith(recovery.id, { status: 'blocked', reason: 'legacy-cleanup-receipt-unverified' });
    expect(reconcile).not.toHaveBeenCalled();
  });
});
