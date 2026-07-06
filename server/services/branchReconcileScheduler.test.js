/**
 * Unit tests for the Branch & PR Reconciler scheduler + coordinator dispatch.
 *
 * - filterActionable — action toggles gate which in-flight branches dispatch.
 * - buildCoordinatorTask — stable dedup description, multi-line body in
 *   metadata.context, auto-approved, no worktree.
 * - runBranchReconcile — disabled short-circuit, force bypass, cleanup toggle,
 *   dispatch only when actionable, duplicate handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./eventScheduler.js', () => ({ schedule: vi.fn(), cancel: vi.fn() }));
vi.mock('./settings.js', () => ({ getSettings: vi.fn() }));
vi.mock('../lib/timezone.js', () => ({ getUserTimezone: vi.fn(async () => 'UTC') }));
vi.mock('../lib/fileUtils.js', () => ({ PATHS: { root: '/repo' } }));
vi.mock('./cosTaskStore.js', () => ({
  PRIORITY_VALUES: { LOW: 1, MEDIUM: 2, HIGH: 3 },
  addTask: vi.fn(async () => ({ id: 'sys-branch-reconcile-x' }))
}));
vi.mock('./branchReconcile.js', () => ({ reconcile: vi.fn() }));

import {
  filterActionable, formatInFlightForPrompt, buildCoordinatorTask, runBranchReconcile, getLastRun
} from './branchReconcileScheduler.js';
import { getSettings } from './settings.js';
import { addTask } from './cosTaskStore.js';
import { reconcile } from './branchReconcile.js';

beforeEach(() => {
  vi.clearAllMocks();
  addTask.mockResolvedValue({ id: 'sys-branch-reconcile-x' });
});

const IN_FLIGHT = [
  { branch: 'needspr', state: 'NEEDS_PR', openPr: null },
  { branch: 'conflicted', state: 'CONFLICTED', openPr: { number: 1, mergeable: 'CONFLICTING' } },
  { branch: 'inreview', state: 'IN_REVIEW', openPr: { number: 2, mergeable: 'MERGEABLE', url: 'u' } }
];

describe('filterActionable', () => {
  it('all states pass when all actions default on', () => {
    expect(filterActionable(IN_FLIGHT, {}).map((b) => b.branch))
      .toEqual(['needspr', 'conflicted', 'inreview']);
  });
  it('drops NEEDS_PR when openPr disabled', () => {
    expect(filterActionable(IN_FLIGHT, { openPr: false }).map((b) => b.branch))
      .toEqual(['conflicted', 'inreview']);
  });
  it('drops CONFLICTED when resolveConflicts disabled', () => {
    expect(filterActionable(IN_FLIGHT, { resolveConflicts: false }).map((b) => b.branch))
      .toEqual(['needspr', 'inreview']); // IN_REVIEW still kept via autoMerge
  });
  it('drops IN_REVIEW only when both resolveConflicts and autoMerge disabled', () => {
    expect(filterActionable(IN_FLIGHT, { resolveConflicts: false, autoMerge: false }).map((b) => b.branch))
      .toEqual(['needspr']);
  });
});

describe('formatInFlightForPrompt', () => {
  it('renders a section per branch with state, PR, and a Do line', () => {
    const out = formatInFlightForPrompt(IN_FLIGHT, { defaultBranch: 'main', actions: {} });
    expect(out).toContain('`needspr` [NEEDS_PR]');
    expect(out).toContain('PR #2 (MERGEABLE)');
    expect(out).toContain('Do:');
  });
  it('IN_REVIEW omits merge instruction when autoMerge is off', () => {
    const out = formatInFlightForPrompt([IN_FLIGHT[2]], { defaultBranch: 'main', actions: { autoMerge: false } });
    expect(out).toContain('Do NOT merge');
  });
});

describe('buildCoordinatorTask', () => {
  it('produces a raw, auto-approved task with body in metadata.context', () => {
    const task = buildCoordinatorTask(IN_FLIGHT, { defaultBranch: 'main', actions: {}, now: 0 });
    expect(task.autoApproved).toBe(true);
    expect(task.status).toBe('pending');
    expect(task.metadata.useWorktree).toBe(false);
    expect(task.metadata.context).toContain('Branch & PR Reconciliation');
    expect(task.metadata.context).toContain('`conflicted`');
    // Stable description = dedup key across daily runs.
    expect(task.description).toBe("Branch & PR reconcile: finish this machine's in-flight local branches");
  });
});

describe('runBranchReconcile', () => {
  it('short-circuits when disabled (no reconcile)', async () => {
    getSettings.mockResolvedValue({ branchReconcile: { enabled: false } });
    const res = await runBranchReconcile({ now: 0 });
    expect(res.skipped).toBe('disabled');
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('force bypasses the disabled gate', async () => {
    getSettings.mockResolvedValue({ branchReconcile: { enabled: false } });
    reconcile.mockResolvedValue({ defaultBranch: 'main', cleaned: [], inFlight: [], wip: [], skipped: [] });
    const res = await runBranchReconcile({ force: true, now: 0 });
    expect(res.skipped).not.toBe('disabled'); // ran, not short-circuited
    expect(reconcile).toHaveBeenCalledWith('/repo', { cleanup: true });
  });

  it('passes cleanup:false when cleanupMerged disabled', async () => {
    getSettings.mockResolvedValue({ branchReconcile: { enabled: true, actions: { cleanupMerged: false } } });
    reconcile.mockResolvedValue({ defaultBranch: 'main', cleaned: [], inFlight: [], wip: [], skipped: [] });
    await runBranchReconcile({ now: 0 });
    expect(reconcile).toHaveBeenCalledWith('/repo', { cleanup: false });
  });

  it('dispatches a coordinator when actionable branches exist', async () => {
    getSettings.mockResolvedValue({ branchReconcile: { enabled: true, actions: {} } });
    reconcile.mockResolvedValue({
      defaultBranch: 'main', cleaned: ['old'], inFlight: IN_FLIGHT, wip: [], skipped: []
    });
    const res = await runBranchReconcile({ now: 0 });
    expect(addTask).toHaveBeenCalledTimes(1);
    expect(addTask.mock.calls[0][1]).toBe('internal');
    expect(res.dispatched).toBe(true);
    expect(res.actionable).toEqual(['needspr', 'conflicted', 'inreview']);
  });

  it('does not dispatch when nothing is actionable', async () => {
    getSettings.mockResolvedValue({ branchReconcile: { enabled: true, actions: {} } });
    reconcile.mockResolvedValue({ defaultBranch: 'main', cleaned: [], inFlight: [], wip: ['x'], skipped: [] });
    const res = await runBranchReconcile({ now: 0 });
    expect(addTask).not.toHaveBeenCalled();
    expect(res.dispatched).toBe(false);
  });

  it('reports dispatched=false when addTask says duplicate', async () => {
    getSettings.mockResolvedValue({ branchReconcile: { enabled: true, actions: {} } });
    reconcile.mockResolvedValue({ defaultBranch: 'main', cleaned: [], inFlight: IN_FLIGHT, wip: [], skipped: [] });
    addTask.mockResolvedValue({ id: 'existing', duplicate: true });
    const res = await runBranchReconcile({ now: 0 });
    expect(res.dispatched).toBe(false);
    expect(getLastRun()).toBe(res);
  });
});
