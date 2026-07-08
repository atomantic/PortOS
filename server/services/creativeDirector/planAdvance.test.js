/**
 * CDO Phase 2 (#2184) — production-plan advance loop.
 *
 * Two layers:
 *   1. `deriveNextPlanAction` — pure next-step derivation over a plan DAG. No
 *      mocks; locks the ordering/dependency/terminal semantics.
 *   2. `advanceAfterPlanStepSettled` — the executor, over a mocked local store +
 *      mocked `dispatchCreativeTool`. Locks: dispatch → step transitions, gated
 *      rejection pauses, bounded re-planning, and the legacy-project no-op.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- pure derivation (no mocks needed) -------------------------------------
import { deriveNextPlanAction } from './planAdvance.js';

const step = (id, over = {}) => ({ stepId: id, toolName: 't', args: {}, dependsOn: [], status: 'pending', ...over });

describe('deriveNextPlanAction (pure)', () => {
  it('empty plan → { type: empty }', () => {
    expect(deriveNextPlanAction({ steps: [] }).type).toBe('empty');
    expect(deriveNextPlanAction(null).type).toBe('empty');
  });
  it('a running step short-circuits to waiting', () => {
    const a = deriveNextPlanAction({ steps: [step('a', { status: 'running' }), step('b')] });
    expect(a).toMatchObject({ type: 'waiting', step: { stepId: 'a' } });
  });
  it('a blocked step short-circuits to blocked', () => {
    const a = deriveNextPlanAction({ steps: [step('a', { status: 'done' }), step('b', { status: 'blocked' })] });
    expect(a).toMatchObject({ type: 'blocked', step: { stepId: 'b' } });
  });
  it('runs the first pending step with all deps terminal-success', () => {
    const a = deriveNextPlanAction({ steps: [step('a'), step('b', { dependsOn: ['a'] })] });
    expect(a).toMatchObject({ type: 'run', step: { stepId: 'a' } });
  });
  it('respects dependsOn — a dependent waits until its dep is done, then runs', () => {
    const notYet = deriveNextPlanAction({ steps: [step('a', { status: 'done' }), step('b', { dependsOn: ['a'] })] });
    expect(notYet).toMatchObject({ type: 'run', step: { stepId: 'b' } });
    // While the dep is still pending, only the dep is runnable (sequential).
    const first = deriveNextPlanAction({ steps: [step('a'), step('b', { dependsOn: ['a'] })] });
    expect(first.step.stepId).toBe('a');
  });
  it('treats a skipped dep as satisfied', () => {
    const a = deriveNextPlanAction({ steps: [step('a', { status: 'skipped' }), step('b', { dependsOn: ['a'] })] });
    expect(a).toMatchObject({ type: 'run', step: { stepId: 'b' } });
  });
  it('is sequential — returns ONE runnable step even when two are eligible', () => {
    const a = deriveNextPlanAction({ steps: [step('a'), step('b')] });
    expect(a).toMatchObject({ type: 'run', step: { stepId: 'a' } });
  });
  it('pending steps blocked by a FAILED dependency → stuck (pause with residuals)', () => {
    const a = deriveNextPlanAction({ steps: [step('a', { status: 'failed' }), step('b', { dependsOn: ['a'] })] });
    expect(a.type).toBe('stuck');
    expect(a.steps.map((s) => s.stepId)).toEqual(['b']);
  });
  it('pending step depending on an UNKNOWN id → stuck', () => {
    const a = deriveNextPlanAction({ steps: [step('b', { dependsOn: ['ghost'] })] });
    expect(a.type).toBe('stuck');
  });
  it('all steps done/skipped → complete', () => {
    const a = deriveNextPlanAction({ steps: [step('a', { status: 'done' }), step('b', { status: 'skipped' })] });
    expect(a.type).toBe('complete');
  });
  it('all terminal with a failed step → failed', () => {
    const a = deriveNextPlanAction({ steps: [step('a', { status: 'done' }), step('b', { status: 'failed' })] });
    expect(a.type).toBe('failed');
    expect(a.steps.map((s) => s.stepId)).toEqual(['b']);
  });
});

// ---- executor (mocked store + dispatch) ------------------------------------

const mockGetProject = vi.fn();
const mockUpdateProject = vi.fn();
const mockUpdatePlanStep = vi.fn();
const mockRecordRun = vi.fn();
const mockUpdateRun = vi.fn();
const mockEnqueuePlanTask = vi.fn();
const mockDispatch = vi.fn();
const mockListJobs = vi.fn();

vi.mock('./local.js', () => ({
  getProject: (...a) => mockGetProject(...a),
  updateProject: (...a) => mockUpdateProject(...a),
  updatePlanStep: (...a) => mockUpdatePlanStep(...a),
  recordRun: (...a) => mockRecordRun(...a),
  updateRun: (...a) => mockUpdateRun(...a),
}));
vi.mock('./agentBridge.js', () => ({
  enqueuePlanTask: (...a) => mockEnqueuePlanTask(...a),
}));
vi.mock('../creative/toolRegistry.js', () => ({
  dispatchCreativeTool: (...a) => mockDispatch(...a),
}));
vi.mock('../mediaJobQueue/index.js', () => ({
  listJobs: (...a) => mockListJobs(...a),
  mediaJobEvents: { on: vi.fn(), off: vi.fn() },
}));

const { advanceAfterPlanStepSettled, __resetPlanInflightState } = await import('./planAdvance.js');

// A tiny in-memory project the mocked store mutates so recursion sees fresh state.
function makeStore(initial) {
  let project = structuredClone(initial);
  mockGetProject.mockImplementation(async () => structuredClone(project));
  mockUpdateProject.mockImplementation(async (_id, patch) => {
    project = { ...project, ...patch };
    return structuredClone(project);
  });
  mockUpdatePlanStep.mockImplementation(async (_id, stepId, patch) => {
    const idx = project.plan.steps.findIndex((s) => s.stepId === stepId);
    if (idx < 0) return null;
    project.plan.steps[idx] = { ...project.plan.steps[idx], ...patch };
    return structuredClone(project.plan.steps[idx]);
  });
  mockRecordRun.mockImplementation(async (_id, entry) => {
    const run = { runId: `run-${(project.runs?.length || 0) + 1}`, ...entry };
    project.runs = [...(project.runs || []), run];
    return run;
  });
  mockUpdateRun.mockImplementation(async (_id, runId, patch) => {
    const idx = (project.runs || []).findIndex((r) => r.runId === runId);
    if (idx >= 0) project.runs[idx] = { ...project.runs[idx], ...patch };
    return null;
  });
  return () => project;
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetPlanInflightState();
  mockListJobs.mockReturnValue([]);
  mockEnqueuePlanTask.mockResolvedValue(undefined);
});

const planProject = (steps, over = {}) => ({
  id: 'cd-1',
  status: 'rendering',
  directive: { goal: 'do it', deliverables: [], constraints: {} },
  plan: { steps, replanRounds: 0 },
  runs: [],
  ...over,
});

describe('advanceAfterPlanStepSettled — executor', () => {
  it('is a no-op for a legacy project (no directive)', async () => {
    makeStore({ id: 'cd-1', status: 'rendering', directive: null, plan: null, runs: [] });
    await advanceAfterPlanStepSettled('cd-1');
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockEnqueuePlanTask).not.toHaveBeenCalled();
  });

  it('enqueues the planner when a directive project has no plan yet', async () => {
    makeStore({ id: 'cd-1', status: 'draft', directive: { goal: 'g', deliverables: [], constraints: {} }, plan: null, runs: [] });
    await advanceAfterPlanStepSettled('cd-1');
    expect(mockUpdateProject).toHaveBeenCalledWith('cd-1', { status: 'planning' });
    expect(mockEnqueuePlanTask).toHaveBeenCalledTimes(1);
  });

  it('dispatches a synchronous step, marks it done, and advances to the next', async () => {
    const read = makeStore(planProject([
      step('a', { toolName: 'pipeline_createSeries' }),
      step('b', { toolName: 'pipeline_generateStage', dependsOn: ['a'] }),
    ]));
    mockDispatch.mockResolvedValue({ ok: true, mode: 'execute', result: { id: 's1' } });
    await advanceAfterPlanStepSettled('cd-1');
    // Both steps dispatched in order, then project completes.
    expect(mockDispatch).toHaveBeenNthCalledWith(1, 'pipeline_createSeries', {}, { projectId: 'cd-1' });
    expect(mockDispatch).toHaveBeenNthCalledWith(2, 'pipeline_generateStage', {}, { projectId: 'cd-1' });
    const p = read();
    expect(p.plan.steps.map((s) => s.status)).toEqual(['done', 'done']);
    expect(p.status).toBe('complete');
  });

  it('records a run per step and stores an id-only result summary', async () => {
    const read = makeStore(planProject([step('a', { toolName: 'pipeline_createSeries' })]));
    mockDispatch.mockResolvedValue({ ok: true, mode: 'execute', result: { id: 's1', seriesId: 's1', huge: 'x'.repeat(9999) } });
    await advanceAfterPlanStepSettled('cd-1');
    const p = read();
    expect(p.runs.some((r) => r.kind === 'plan-step' && r.stepId === 'a')).toBe(true);
    expect(p.plan.steps[0].result).toEqual({ id: 's1', seriesId: 's1' });
  });

  it('pauses with residuals when the gate rejects a step (over budget)', async () => {
    const read = makeStore(planProject([step('a', { toolName: 'pipeline_generateStage' })]));
    mockDispatch.mockResolvedValue({ ok: false, rejected: true, reason: 'budget' });
    await advanceAfterPlanStepSettled('cd-1');
    const p = read();
    expect(p.status).toBe('paused');
    expect(p.plan.steps[0].status).toBe('blocked');
    expect(p.failureReason).toMatch(/budget/);
  });

  it('bounded re-plan: a failed step re-enqueues the planner until MAX_REPLAN_ROUNDS, then pauses', async () => {
    // replanRounds already at the max → the failure must pause, not re-plan.
    const read = makeStore(planProject([step('a', { toolName: 'pipeline_generateStage' })], { plan: { steps: [step('a', { toolName: 'pipeline_generateStage' })], replanRounds: 2 } }));
    mockDispatch.mockResolvedValue({ ok: false, threw: true, error: 'boom' });
    await advanceAfterPlanStepSettled('cd-1');
    const p = read();
    expect(mockEnqueuePlanTask).not.toHaveBeenCalled();
    expect(p.status).toBe('paused');
    expect(p.plan.steps[0].status).toBe('failed');
  });

  it('a failed step under the replan budget re-enqueues the planner', async () => {
    makeStore(planProject([step('a', { toolName: 'pipeline_generateStage' })]));
    mockDispatch.mockResolvedValue({ ok: false, threw: true, error: 'boom' });
    await advanceAfterPlanStepSettled('cd-1');
    expect(mockEnqueuePlanTask).toHaveBeenCalledTimes(1);
  });

  it('leaves a long-running step running until its job settles (does not advance past it)', async () => {
    const read = makeStore(planProject([
      step('a', { toolName: 'pipeline_renderComicCover' }),
      step('b', { toolName: 'pipeline_generateStage', dependsOn: ['a'] }),
    ]));
    mockDispatch.mockResolvedValue({ ok: true, mode: 'execute', longRunning: true, result: { jobId: 'job-1' } });
    await advanceAfterPlanStepSettled('cd-1');
    const p = read();
    // Step a stays running (waiting on job-1); step b is untouched.
    expect(p.plan.steps[0].status).toBe('running');
    expect(p.plan.steps[1].status).toBe('pending');
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(p.status).not.toBe('complete');
  });

  it('does not double-dispatch a step already running (idempotent)', async () => {
    makeStore(planProject([step('a', { toolName: 'pipeline_createSeries', status: 'running' })], {
      runs: [{ runId: 'r0', kind: 'plan-step', stepId: 'a', status: 'running' }],
    }));
    await advanceAfterPlanStepSettled('cd-1');
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});
