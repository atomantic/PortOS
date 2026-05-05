import { describe, it, expect, vi, beforeEach } from 'vitest';
import { nextPendingScene, nextTaskKind, buildTimelineClips } from './orchestrator.js';
import { presetToRenderParams } from '../../lib/creativeDirectorPresets.js';

// Mocks for advanceAfterSceneSettled integration test.
const mockRunSceneRender = vi.fn(async () => undefined);
const mockUpdateProject = vi.fn(async () => undefined);
const mockUpdateScene = vi.fn(async () => undefined);
const mockEnqueueTreatmentTask = vi.fn(async () => undefined);
const mockEnqueueEvaluateTask = vi.fn(async () => undefined);
const mockSampleEvaluationFrames = vi.fn(async () => []);

vi.mock('./local.js', () => ({
  getProject: vi.fn(),
  updateProject: (...args) => mockUpdateProject(...args),
  updateScene: (...args) => mockUpdateScene(...args),
}));

vi.mock('./sceneRunner.js', () => ({
  runSceneRender: (...args) => mockRunSceneRender(...args),
}));

vi.mock('./stitchRunner.js', () => ({
  runStitch: vi.fn(async () => undefined),
}));

vi.mock('./agentBridge.js', () => ({
  enqueueTreatmentTask: (...args) => mockEnqueueTreatmentTask(...args),
  enqueueEvaluateTask: (...args) => mockEnqueueEvaluateTask(...args),
}));

vi.mock('../videoGen/local.js', () => ({
  sampleEvaluationFrames: (...args) => mockSampleEvaluationFrames(...args),
}));

import * as localMod from './local.js';
import { advanceAfterSceneSettled } from './completionHook.js';

const baseProject = {
  id: 'cd-1',
  name: 'Test',
  status: 'rendering',
  aspectRatio: '16:9',
  quality: 'standard',
  modelId: 'ltx2_unified',
  collectionId: 'mc-1',
  finalVideoId: null,
  treatment: null,
};

describe('orchestrator', () => {
  describe('nextPendingScene', () => {
    it('returns null when no treatment', () => {
      expect(nextPendingScene({ ...baseProject, treatment: null })).toBeNull();
    });

    it('returns the lowest-order non-terminal scene', () => {
      const project = {
        ...baseProject,
        treatment: {
          scenes: [
            { sceneId: 's1', order: 0, status: 'accepted' },
            { sceneId: 's2', order: 1, status: 'pending' },
            { sceneId: 's3', order: 2, status: 'pending' },
          ],
        },
      };
      expect(nextPendingScene(project).sceneId).toBe('s2');
    });

    it('considers rendering / evaluating as in-flight (not next)', () => {
      // The currently running scene IS the "next" scene from the queue
      // perspective — the orchestrator returns it so a re-enqueue picks
      // up where it left off rather than skipping ahead.
      const project = {
        ...baseProject,
        treatment: {
          scenes: [
            { sceneId: 's1', order: 0, status: 'accepted' },
            { sceneId: 's2', order: 1, status: 'rendering' },
            { sceneId: 's3', order: 2, status: 'pending' },
          ],
        },
      };
      expect(nextPendingScene(project).sceneId).toBe('s2');
    });

    it('returns null when every scene is terminal', () => {
      const project = {
        ...baseProject,
        treatment: {
          scenes: [
            { sceneId: 's1', order: 0, status: 'accepted' },
            { sceneId: 's2', order: 1, status: 'failed' },
          ],
        },
      };
      expect(nextPendingScene(project)).toBeNull();
    });
  });

  describe('nextTaskKind', () => {
    it('returns "treatment" when no treatment exists', () => {
      expect(nextTaskKind({ ...baseProject, treatment: null })).toBe('treatment');
    });

    it('returns "scene" when at least one scene is pending', () => {
      const project = {
        ...baseProject,
        treatment: { scenes: [{ sceneId: 's1', order: 0, status: 'pending' }] },
      };
      expect(nextTaskKind(project)).toBe('scene');
    });

    it('returns "stitch" when every scene accepted and no final video', () => {
      const project = {
        ...baseProject,
        treatment: {
          scenes: [
            { sceneId: 's1', order: 0, status: 'accepted' },
            { sceneId: 's2', order: 1, status: 'accepted' },
          ],
        },
      };
      expect(nextTaskKind(project)).toBe('stitch');
    });

    it('returns null when finalVideoId is already set', () => {
      const project = {
        ...baseProject,
        finalVideoId: 'final-uuid',
        treatment: { scenes: [{ sceneId: 's1', order: 0, status: 'accepted' }] },
      };
      expect(nextTaskKind(project)).toBeNull();
    });

    it('returns null when project is paused or failed', () => {
      const paused = { ...baseProject, status: 'paused', treatment: null };
      const failed = { ...baseProject, status: 'failed', treatment: null };
      expect(nextTaskKind(paused)).toBeNull();
      expect(nextTaskKind(failed)).toBeNull();
    });

    it('returns null when no scenes were ever accepted (full failure)', () => {
      const project = {
        ...baseProject,
        treatment: {
          scenes: [
            { sceneId: 's1', order: 0, status: 'failed' },
            { sceneId: 's2', order: 1, status: 'failed' },
          ],
        },
      };
      expect(nextTaskKind(project)).toBeNull();
    });
  });

  describe('buildTimelineClips', () => {
    it('orders accepted scenes by order field', () => {
      const project = {
        ...baseProject,
        treatment: {
          scenes: [
            { sceneId: 's2', order: 1, status: 'accepted', renderedJobId: 'job-2', durationSeconds: 4 },
            { sceneId: 's1', order: 0, status: 'accepted', renderedJobId: 'job-1', durationSeconds: 5 },
            { sceneId: 's3', order: 2, status: 'failed', renderedJobId: 'job-3', durationSeconds: 3 },
          ],
        },
      };
      const clips = buildTimelineClips(project);
      expect(clips).toEqual([
        { clipId: 'job-1', inSec: 0, outSec: 5 },
        { clipId: 'job-2', inSec: 0, outSec: 4 },
      ]);
    });
  });
});

describe('presetToRenderParams', () => {
  it('maps 16:9 + standard at 5s into the LTX-friendly numbers', () => {
    const r = presetToRenderParams({ aspectRatio: '16:9', quality: 'standard', durationSeconds: 5 });
    expect(r.width).toBe(768);
    expect(r.height).toBe(432);
    expect(r.fps).toBe(24);
    expect(r.steps).toBe(20);
    expect(r.guidanceScale).toBe(3.0);
    // 5s × 24fps = 120 → rounds to 120 (multiple of 8).
    expect(r.numFrames).toBe(120);
  });

  it('rounds frame count to multiple of 8 (LTX latent compression requires it)', () => {
    // 1.3s × 24fps = 31.2 — rounds to nearest 8 → 32.
    const r = presetToRenderParams({ aspectRatio: '1:1', quality: 'draft', durationSeconds: 1.3 });
    expect(r.numFrames % 8).toBe(0);
    expect(r.numFrames).toBe(32);
  });

  it('floors at 8 frames so a tiny scene still renders', () => {
    const r = presetToRenderParams({ aspectRatio: '16:9', quality: 'draft', durationSeconds: 0.1 });
    expect(r.numFrames).toBe(8);
  });

  it('throws on unknown aspect ratio', () => {
    expect(() => presetToRenderParams({ aspectRatio: '4:3', quality: 'standard', durationSeconds: 1 }))
      .toThrow(/aspectRatio/);
  });

  it('throws on unknown quality preset', () => {
    expect(() => presetToRenderParams({ aspectRatio: '16:9', quality: 'ultra', durationSeconds: 1 }))
      .toThrow(/quality/);
  });
});

describe('advanceAfterSceneSettled', () => {
  const makeProject = (overrides = {}) => ({
    id: 'cd-test',
    status: 'rendering',
    finalVideoId: null,
    treatment: {
      scenes: [
        { sceneId: 'scene-1', order: 0, status: 'accepted', renderedJobId: 'job-1' },
        { sceneId: 'scene-2', order: 1, status: 'pending' },
        { sceneId: 'scene-3', order: 2, status: 'pending' },
        { sceneId: 'scene-4', order: 3, status: 'pending' },
        { sceneId: 'scene-5', order: 4, status: 'pending' },
        { sceneId: 'scene-6', order: 5, status: 'pending' },
      ],
    },
    ...overrides,
  });

  beforeEach(() => {
    mockRunSceneRender.mockClear();
    mockUpdateProject.mockClear();
    mockUpdateScene.mockClear();
    mockEnqueueTreatmentTask.mockClear();
    mockEnqueueEvaluateTask.mockClear();
    mockSampleEvaluationFrames.mockReset().mockResolvedValue([]);
  });

  it('picks scene-2 (lowest-order pending) when scene-1 is accepted and scenes 2-6 are pending', async () => {
    const project = makeProject();
    // getProject called twice: initial fetch + fresh fetch before runSceneRender.
    localMod.getProject
      .mockResolvedValueOnce(project)
      .mockResolvedValueOnce(project);

    await advanceAfterSceneSettled(project.id);

    expect(mockRunSceneRender).toHaveBeenCalledTimes(1);
    const [, sceneArg] = mockRunSceneRender.mock.calls[0];
    expect(sceneArg.sceneId).toBe('scene-2');
  });

  it('enqueues treatment when project.treatment is null and status is "planning" (start route pre-flip)', async () => {
    // The start route sets status='planning' before calling
    // startCreativeDirectorProject, so advanceAfterSceneSettled must NOT
    // skip treatment enqueue just because status is already 'planning'.
    const project = { id: 'cd-planning', status: 'planning', finalVideoId: null, treatment: null, runs: [] };
    // getProject called twice: initial fetch + fresh fetch inside the treatment branch.
    localMod.getProject
      .mockResolvedValueOnce(project)
      .mockResolvedValueOnce(project);

    await advanceAfterSceneSettled(project.id);

    expect(mockEnqueueTreatmentTask).toHaveBeenCalledTimes(1);
  });

  it('does NOT enqueue a second treatment when a treatment run is already in-flight (persisted runs[] check, live worker)', async () => {
    // Covers the LIVE concurrent-worker case: a treatment task is genuinely
    // running in another agent. The post-restart case where this row is
    // stale is handled separately by recovery.js, which reaps stale
    // `running` rows before calling advanceAfterSceneSettled — so by the
    // time advance runs after a restart, this guard sees `failed` instead
    // of `running` and proceeds to enqueue. See recovery.test.js for that
    // path.
    const project = {
      id: 'cd-inflight',
      status: 'planning',
      finalVideoId: null,
      treatment: null,
      runs: [{ kind: 'treatment', status: 'running' }],
    };
    localMod.getProject.mockResolvedValueOnce(project);

    await advanceAfterSceneSettled(project.id);

    expect(mockEnqueueTreatmentTask).not.toHaveBeenCalled();
  });

  it('skips treatment when inflightTreatment in-memory set already has the projectId (concurrent call dedup)', async () => {
    // Simulate a concurrent call by firing two advances in parallel.
    // The first resolves slowly so the second enters while the first holds
    // the inflightTreatment lock. Both calls see treatment=null, but only
    // one should enqueue.
    let firstEnqueueResolve;
    mockEnqueueTreatmentTask.mockImplementationOnce(
      () => new Promise((resolve) => { firstEnqueueResolve = resolve; })
    );

    const project = { id: 'cd-concurrent', status: 'rendering', finalVideoId: null, treatment: null, runs: [] };
    // Each call to getProject returns the same base project (no inflight run).
    localMod.getProject.mockResolvedValue(project);

    const first = advanceAfterSceneSettled(project.id);
    // Let the first call fully reach enqueueTreatmentTask before starting the
    // second. There are 3 awaits (getProject, updateProject, getProject) before
    // the enqueue call, so we drain via a macrotask which flushes all pending
    // microtask chains regardless of how many levels deep they are.
    await new Promise((r) => setTimeout(r, 10));

    const second = advanceAfterSceneSettled(project.id);

    // Unblock the first enqueue so both promises can settle.
    firstEnqueueResolve();
    await Promise.all([first, second]);

    expect(mockEnqueueTreatmentTask).toHaveBeenCalledTimes(1);
  });

  it('re-fires the evaluator for an orphaned `evaluating` scene with renderedJobId set (resume-after-pause path)', async () => {
    // The render-completion path persists renderedJobId + status='evaluating'
    // when a pause lands during frame sampling, then bails without enqueuing
    // the evaluator. On resume, advanceAfterSceneSettled must detect the
    // orphan (renderedJobId set, no live evaluate run in runs[]) and re-fire
    // the evaluator instead of falling through to runSceneRender — otherwise
    // the user pays for a full re-render of work that already completed.
    const project = {
      id: 'cd-orphan-eval',
      status: 'rendering',
      finalVideoId: null,
      treatment: {
        scenes: [
          { sceneId: 'scene-1', order: 0, status: 'accepted', renderedJobId: '11111111-1111-4111-8111-111111111111' },
          { sceneId: 'scene-2', order: 1, status: 'evaluating', renderedJobId: '22222222-2222-4222-8222-222222222222', evaluationFrames: ['f1.jpg'] },
          { sceneId: 'scene-3', order: 2, status: 'pending' },
        ],
      },
      runs: [
        // Prior evaluate run was reaped by recovery (status='completed') —
        // there is no LIVE evaluate run, so the resume path should fire.
        { kind: 'evaluate', sceneId: 'scene-2', status: 'completed' },
      ],
    };
    // getProject called twice in this branch: initial fetch + post-sample re-check.
    localMod.getProject.mockResolvedValue(project);

    await advanceAfterSceneSettled(project.id);

    expect(mockEnqueueEvaluateTask).toHaveBeenCalledTimes(1);
    const [, sceneArg] = mockEnqueueEvaluateTask.mock.calls[0];
    expect(sceneArg.sceneId).toBe('scene-2');
    expect(sceneArg.renderedJobId).toBe('22222222-2222-4222-8222-222222222222');
    // Should NOT fall through to runSceneRender for the next pending scene —
    // resume must finish the orphaned evaluate first.
    expect(mockRunSceneRender).not.toHaveBeenCalled();
  });

  it('rejects orphaned-evaluating scenes whose renderedJobId is not a UUID (path-traversal guard)', async () => {
    // scene.renderedJobId is editable via PATCH; a tampered value must NOT
    // be accepted into the resume path because sampleEvaluationFrames builds
    // ffmpeg paths via string concat. Resume should fall through to the
    // pending-scene branch and re-render scene-3 instead.
    const project = {
      id: 'cd-tamper',
      status: 'rendering',
      finalVideoId: null,
      treatment: {
        scenes: [
          { sceneId: 'scene-2', order: 1, status: 'evaluating', renderedJobId: '../../../etc/passwd' },
          { sceneId: 'scene-3', order: 2, status: 'pending' },
        ],
      },
      runs: [],
    };
    localMod.getProject.mockResolvedValue(project);
    await advanceAfterSceneSettled(project.id);
    expect(mockEnqueueEvaluateTask).not.toHaveBeenCalled();
    expect(mockRunSceneRender).toHaveBeenCalledTimes(1);
    expect(mockRunSceneRender.mock.calls[0][1].sceneId).toBe('scene-3');
  });
});
