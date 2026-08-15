/**
 * CD completion hook — deliverable verification (#4146).
 *
 * A `plan`/`treatment` agent's deliverable is the PATCH its prompt describes, not
 * its exit code. These lock the finalization semantics: an exit-0 run that never
 * PATCHed is recorded `failed` (so the live re-dispatch guard reaps it instead of
 * boot recovery), a run that DID PATCH is recorded `completed`, and the bounded
 * gate parks the project once the treatment stage has come back empty too often.
 *
 * The scene-loop behaviour of `advanceAfterSceneSettled` is covered in
 * orchestrator.test.js; this file only exercises the completion/gate paths.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MAX_CONSECUTIVE_MISSED_DELIVERABLES } from '../../lib/creativeDirectorPresets.js';

const mockGetProject = vi.fn();
const mockUpdateProject = vi.fn(async () => undefined);
const mockUpdateScene = vi.fn(async () => undefined);
const mockUpdateRun = vi.fn(async () => ({}));
const mockRecordRun = vi.fn(async () => ({}));
const mockEnqueueTreatmentTask = vi.fn(async () => undefined);
const mockAdvancePlan = vi.fn(async () => undefined);
const mockRunSceneRender = vi.fn(async () => undefined);

vi.mock('./local.js', () => ({
  getProject: (...a) => mockGetProject(...a),
  updateProject: (...a) => mockUpdateProject(...a),
  updateScene: (...a) => mockUpdateScene(...a),
  updateRun: (...a) => mockUpdateRun(...a),
  recordRun: (...a) => mockRecordRun(...a),
}));
vi.mock('./agentBridge.js', () => ({ enqueueTreatmentTask: (...a) => mockEnqueueTreatmentTask(...a) }));
vi.mock('./planAdvance.js', () => ({ advanceAfterPlanStepSettled: (...a) => mockAdvancePlan(...a) }));
vi.mock('./sceneEvaluator.js', () => ({ dispatchSceneEvaluation: vi.fn(async () => undefined) }));
vi.mock('./sceneRunner.js', () => ({ runSceneRender: (...a) => mockRunSceneRender(...a) }));
vi.mock('./stitchRunner.js', () => ({ runStitch: vi.fn(async () => undefined) }));
vi.mock('../videoGen/local.js', () => ({ sampleEvaluationFrames: vi.fn(async () => []) }));
vi.mock('../mediaJobQueue/index.js', () => ({
  listJobs: vi.fn(() => []),
  mediaJobEvents: { on: vi.fn(), off: vi.fn() },
}));

const { handleCreativeDirectorCompletion, advanceAfterSceneSettled, __resetInflightState } = await import('./completionHook.js');

const planTask = (runId = 'run-1') => ({
  id: 'task-1',
  metadata: { creativeDirector: { projectId: 'cd-1', kind: 'plan', runId } },
});

const planProject = (over = {}) => ({
  id: 'cd-1',
  status: 'planning',
  directive: { goal: 'g', deliverables: [], constraints: {} },
  plan: null,
  runs: [{ runId: 'run-1', kind: 'plan', status: 'running', deliverableMark: null }],
  ...over,
});

const missedTreatmentRun = (runId) => ({ runId, kind: 'treatment', status: 'failed', deliverableMissing: true });

beforeEach(() => {
  vi.clearAllMocks();
  __resetInflightState();
});

describe('handleCreativeDirectorCompletion — plan deliverable', () => {
  it('marks an exit-0 plan run FAILED when no plan was PATCHed', async () => {
    mockGetProject.mockResolvedValue(planProject());
    await handleCreativeDirectorCompletion(planTask(), 'agent-1', true);
    expect(mockUpdateRun).toHaveBeenCalledWith('cd-1', 'run-1', expect.objectContaining({
      status: 'failed',
      deliverableMissing: true,
      failureReason: expect.stringMatching(/never wrote the plan/),
    }));
    // The PROJECT is not failed — the advance loop still gets to re-dispatch once.
    expect(mockUpdateProject).not.toHaveBeenCalled();
    expect(mockAdvancePlan).toHaveBeenCalledWith('cd-1');
  });

  it('marks a plan run COMPLETED when the plan did land', async () => {
    mockGetProject.mockResolvedValue(planProject({ plan: { steps: [{ stepId: 'a' }], replanRounds: 0 } }));
    await handleCreativeDirectorCompletion(planTask(), 'agent-1', true);
    expect(mockUpdateRun).toHaveBeenCalledWith('cd-1', 'run-1', expect.objectContaining({ status: 'completed' }));
    expect(mockUpdateRun.mock.calls[0][2]).not.toHaveProperty('deliverableMissing');
    expect(mockAdvancePlan).toHaveBeenCalledWith('cd-1');
  });

  it('marks a RE-plan run failed when it left the existing plan untouched', async () => {
    mockGetProject.mockResolvedValue(planProject({
      plan: { steps: [{ stepId: 'a' }], replanRounds: 1 },
      runs: [{ runId: 'run-1', kind: 'plan', status: 'running', deliverableMark: 'plan:1' }],
    }));
    await handleCreativeDirectorCompletion(planTask(), 'agent-1', true);
    expect(mockUpdateRun).toHaveBeenCalledWith('cd-1', 'run-1', expect.objectContaining({ status: 'failed', deliverableMissing: true }));
  });

  it('marks a RE-plan run completed when replanRounds advanced (a new plan landed)', async () => {
    mockGetProject.mockResolvedValue(planProject({
      plan: { steps: [{ stepId: 'a' }], replanRounds: 2 },
      runs: [{ runId: 'run-1', kind: 'plan', status: 'running', deliverableMark: 'plan:1' }],
    }));
    await handleCreativeDirectorCompletion(planTask(), 'agent-1', true);
    expect(mockUpdateRun).toHaveBeenCalledWith('cd-1', 'run-1', expect.objectContaining({ status: 'completed' }));
  });

  it('does not manufacture a failure for a legacy run that recorded no baseline', async () => {
    // Run row predates the mark (no `deliverableMark` key at all) — presence of a
    // plan is all we can honestly check.
    mockGetProject.mockResolvedValue(planProject({
      plan: { steps: [{ stepId: 'a' }], replanRounds: 1 },
      runs: [{ runId: 'run-1', kind: 'plan', status: 'running' }],
    }));
    await handleCreativeDirectorCompletion(planTask(), 'agent-1', true);
    expect(mockUpdateRun).toHaveBeenCalledWith('cd-1', 'run-1', expect.objectContaining({ status: 'completed' }));
  });

  it('leaves a genuinely failed run on the project-failed path (unchanged)', async () => {
    mockGetProject.mockResolvedValue(planProject());
    await handleCreativeDirectorCompletion(planTask(), 'agent-1', false);
    expect(mockUpdateRun).toHaveBeenCalledWith('cd-1', 'run-1', expect.objectContaining({ status: 'failed' }));
    expect(mockUpdateRun.mock.calls[0][2]).not.toHaveProperty('deliverableMissing');
    expect(mockUpdateProject).toHaveBeenCalledWith('cd-1', expect.objectContaining({ status: 'failed' }));
    expect(mockAdvancePlan).not.toHaveBeenCalled();
  });

  it('does not deliverable-check an evaluate run (no verifiable PATCH deliverable)', async () => {
    mockGetProject.mockResolvedValue({
      id: 'cd-1', status: 'rendering', directive: null, treatment: { scenes: [] },
      runs: [{ runId: 'run-1', kind: 'evaluate', status: 'running' }],
    });
    await handleCreativeDirectorCompletion({
      id: 'task-1', metadata: { creativeDirector: { projectId: 'cd-1', kind: 'evaluate', runId: 'run-1', sceneId: 's1' } },
    }, 'agent-1', true);
    expect(mockUpdateRun).toHaveBeenCalledWith('cd-1', 'run-1', expect.objectContaining({ status: 'completed' }));
  });

  it('falls back to recordRun (carrying the miss) when the run row is gone', async () => {
    mockUpdateRun.mockResolvedValueOnce(null);
    mockGetProject.mockResolvedValue(planProject());
    await handleCreativeDirectorCompletion(planTask(), 'agent-1', true);
    expect(mockRecordRun).toHaveBeenCalledWith('cd-1', expect.objectContaining({ status: 'failed', deliverableMissing: true }));
  });
});

describe('advanceAfterSceneSettled — bounded treatment gate', () => {
  const noTreatment = (runs) => ({ id: 'cd-1', name: 'p', status: 'planning', directive: null, treatment: null, runs });

  it('re-enqueues the treatment task while the empty streak is under the bound', async () => {
    mockGetProject.mockResolvedValue(noTreatment([missedTreatmentRun('t1')]));
    await advanceAfterSceneSettled('cd-1');
    expect(mockEnqueueTreatmentTask).toHaveBeenCalledTimes(1);
    expect(mockUpdateProject).toHaveBeenCalledWith('cd-1', { status: 'planning' });
  });

  it('pauses the project instead of re-dispatching once the bound is reached', async () => {
    const runs = Array.from({ length: MAX_CONSECUTIVE_MISSED_DELIVERABLES }, (_, i) => missedTreatmentRun(`t${i}`));
    mockGetProject.mockResolvedValue(noTreatment(runs));
    await advanceAfterSceneSettled('cd-1');
    expect(mockEnqueueTreatmentTask).not.toHaveBeenCalled();
    expect(mockUpdateProject).toHaveBeenCalledWith('cd-1', {
      status: 'paused',
      failureReason: expect.stringMatching(/tool-capable model/),
    });
    // Streak closed so a Resume after switching models gets a fresh budget.
    for (const run of runs) {
      expect(mockUpdateRun).toHaveBeenCalledWith('cd-1', run.runId, { deliverableStreakClosed: true });
    }
  });

  it('re-dispatches again after the streak was closed (Resume gets a fresh budget)', async () => {
    const runs = Array.from({ length: MAX_CONSECUTIVE_MISSED_DELIVERABLES }, (_, i) => ({
      ...missedTreatmentRun(`t${i}`), deliverableStreakClosed: true,
    }));
    mockGetProject.mockResolvedValue(noTreatment(runs));
    await advanceAfterSceneSettled('cd-1');
    expect(mockEnqueueTreatmentTask).toHaveBeenCalledTimes(1);
  });
});
