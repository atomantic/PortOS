import { beforeEach, describe, expect, it, vi } from 'vitest';

// The schedule adapter serializes each write and returns fresh objects on read,
// matching persistence rather than sharing an in-memory execution record.
const persisted = vi.hoisted(() => ({ json: '' }));
vi.mock('./taskScheduleStore.js', async importOriginal => ({
  ...(await importOriginal()),
  loadSchedule: async () => JSON.parse(persisted.json),
  updateSchedule: async (mutate) => {
    const schedule = JSON.parse(persisted.json);
    const { result, changed } = await mutate(schedule);
    if (changed) persisted.json = JSON.stringify(schedule);
    return result;
  },
}));
vi.mock('./branchReconcile.js', async (importOriginal) => ({
  ...await importOriginal(),
  reconcile: vi.fn(),
  formatInFlightForPrompt: vi.fn(async (branches) => branches.map(b => b.branch).join(',')),
}));
vi.mock('./cosClaimOwnership.js', () => ({ readClaimOwnershipAgents: vi.fn(async () => []) }));
vi.mock('./agentState.js', async (importOriginal) => ({ ...await importOriginal(), getActiveAgentIds: () => new Set() }));
vi.mock('./userTimezone.js', () => ({ getUserTimezone: async () => 'UTC' }));
vi.mock('./apps.js', () => ({ getAppById: vi.fn(async () => null) }));

import { reconcile } from './branchReconcile.js';
import { readClaimOwnershipAgents } from './cosClaimOwnership.js';
import { applyPerpetualDrainCap, resolveBranchReconcileBlock } from './cosTaskPreStepBlocks.js';
import * as schedule from './taskSchedule.js';
import { perpetualRefillPlan } from './cos.js';

const app = { id: 'example-app', name: 'Example App', repoPath: '/example/repo' };
const branch = name => ({ branch: name, state: 'NEEDS_PR', head: name });
const scan = (inFlight = [], extra = {}) => ({ defaultBranch: 'main', inFlight, cleaned: [], skipped: [], wip: [], ...extra });
const outcome = () => JSON.parse(persisted.json).executions['task:branch-reconcile'].perApp[app.id].branchReconcileOutcome;
const run = () => resolveBranchReconcileBlock(app, 'branch-reconcile', { branchesPerAgent: 2 }, schedule);

beforeEach(() => {
  vi.clearAllMocks();
  readClaimOwnershipAgents.mockResolvedValue([]);
  persisted.json = JSON.stringify({ tasks: { 'branch-reconcile': { enabled: true, perpetual: false, type: 'on-demand', drainDispatchCap: 5 } }, executions: {} });
});

describe('manual branch reconciliation sweep', () => {
  it('processes multiple batches and performs the final scan with perpetual disabled', async () => {
    reconcile.mockResolvedValueOnce(scan(['a', 'b', 'c'].map(branch)))
      .mockResolvedValueOnce(scan([branch('c')], { cleaned: ['a', 'b'] }))
      .mockResolvedValueOnce(scan([], { cleaned: ['c'] }));
    expect(await run()).toMatchObject({ skip: false, block: 'a,b' });
    expect(perpetualRefillPlan({ metadata: { taskAnalysisType: 'branch-reconcile', taskOnDemand: true, taskApp: app.id } }, await schedule.loadSchedule()))
      .toEqual({ lane: 'onDemand', taskType: 'branch-reconcile', appId: app.id });
    expect(await run()).toMatchObject({ skip: false, block: 'c' });
    expect(await run()).toEqual({ skip: true });
    expect(outcome()).toMatchObject({ status: 'drained', remaining: [], nextAction: null });
    expect((await schedule.loadSchedule()).tasks['branch-reconcile'].perpetual).toBe(false);
    expect(await schedule.isPerpetualParkActive('branch-reconcile', app.id)).toBe(true);
  });

  it('attempts later batches before declaring unchanged branches incomplete', async () => {
    reconcile.mockResolvedValue(scan(['a', 'b', 'c'].map(branch)));
    expect(await run()).toMatchObject({ block: 'a,b' });
    expect(await run()).toMatchObject({ block: 'c' });
    expect(await run()).toEqual({ skip: true });
    expect(outcome()).toMatchObject({ status: 'incomplete', reason: 'no-progress', remaining: ['a', 'b', 'c'].map(branch => ({ branch, reason: 'actionable' })) });
  });

  it('applies the saved dispatch budget to a non-perpetual manual sweep and retains its last inventory', async () => {
    reconcile.mockResolvedValue(scan([branch('a')]));
    await run();
    const cap = await applyPerpetualDrainCap(app, 'branch-reconcile', { perpetual: false, drainDispatchCap: 1 }, schedule, { onDemand: true });
    expect(cap).toEqual({ skip: true });
    expect(outcome()).toMatchObject({ status: 'incomplete', reason: 'drain-cap', remaining: [{ branch: 'a', reason: 'actionable' }] });
  });

  it('retains checkout and gated-action holds instead of reporting a drained repository', async () => {
    reconcile.mockResolvedValue(scan([], {
      skipped: [{ branch: 'merged-held', path: '/example/held', reason: 'worktree-locked' }],
      detachedWorktrees: [{ path: '/example/detached', reason: 'worktree-unmanaged-location' }],
      wip: [{ branch: 'manual', liveOwnerReason: 'manual-handoff' }],
    }));
    expect(await run()).toEqual({ skip: true });
    expect(outcome()).toMatchObject({ status: 'incomplete', remaining: [
      { branch: 'merged-held', path: '/example/held', reason: 'worktree-locked' },
      { path: '/example/detached', reason: 'worktree-unmanaged-location' },
      { branch: 'manual', reason: 'manual-handoff' },
    ] });
  });

  it.each([
    [{ skipped: [{ branch: 'moved', reason: 'not-merged-on-recheck' }] }, { branch: 'moved', reason: 'not-merged-on-recheck' }],
    [{ orphanRemotes: { remoteUnavailable: true, reported: [] } }, { reason: 'remote-state-unavailable' }],
    [{ worktreeInventory: null }, { reason: 'worktree-inventory-unavailable' }],
    [{ worktreeInventory: [{ path: '/example/unmerged-detached', detached: true, head: 'abc123', locked: true, lockReason: 'owner handoff', managed: false, reason: 'worktree-locked' }] },
      { path: '/example/unmerged-detached', detached: true, head: 'abc123', locked: true, lockReason: 'owner handoff', managed: false, reason: 'worktree-locked' }],
  ])('does not report drained when the final scan has incomplete evidence (%j)', async (extra, remaining) => {
    reconcile.mockResolvedValue(scan([], extra));
    expect(await run()).toEqual({ skip: true });
    expect(outcome()).toMatchObject({ status: 'incomplete', remaining: [remaining] });
  });

  it('preserves the last observation across a failed scan or unavailable ownership state', async () => {
    reconcile.mockResolvedValueOnce(scan([branch('a')])).mockRejectedValueOnce(new Error('git unavailable'));
    await run();
    const observedAt = outcome().observedAt;
    expect(await run()).toEqual({ skip: true });
    expect(outcome()).toMatchObject({ status: 'incomplete', reason: 'scan-unavailable', observedAt, remaining: [{ branch: 'a', reason: 'actionable' }] });
    readClaimOwnershipAgents.mockRejectedValueOnce(new Error('registry unavailable'));
    expect(await run()).toEqual({ skip: true });
    expect(outcome()).toMatchObject({ status: 'incomplete', reason: 'owner-state-unavailable' });
  });
});
