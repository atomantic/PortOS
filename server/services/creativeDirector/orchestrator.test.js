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
// fs.existsSync is consulted on (a) every persisted evaluationFrame to detect
// frames deleted under us, and (b) the rendered .mp4 itself to differentiate
// "video deleted while paused" (fail scene) from "transient ffmpeg failure"
// (bail and retry). Tests override per-call with mockReturnValueOnce.
const mockExistsSync = vi.fn(() => false);

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

// #1929 first-pass seed-frame defer: completionHook now consults the media-job
// queue for an in-flight seeded reference-frame job before rendering the first
// pending scene. Mock the queue so tests can control the listJobs snapshot and
// drive the settle event. `mediaJobEvents` is a real EventEmitter so the defer
// listener can be exercised end-to-end.
const { mockListJobs, mockMediaJobEvents } = vi.hoisted(() => {
  // Minimal EventEmitter-shaped stub (on/off/emit) — enough for the defer
  // listener the completionHook registers. Kept dependency-free so it can live
  // in the hoisted block (runs before imports).
  const handlers = { completed: [], failed: [], canceled: [] };
  const emitter = {
    on: (ev, fn) => { (handlers[ev] ||= []).push(fn); },
    off: (ev, fn) => { handlers[ev] = (handlers[ev] || []).filter((h) => h !== fn); },
    emit: (ev, payload) => { (handlers[ev] || []).slice().forEach((h) => h(payload)); },
  };
  return { mockListJobs: vi.fn(() => []), mockMediaJobEvents: emitter };
});
vi.mock('../mediaJobQueue/index.js', () => ({
  listJobs: (...args) => mockListJobs(...args),
  mediaJobEvents: mockMediaJobEvents,
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return { ...actual, existsSync: (...args) => mockExistsSync(...args) };
});

import * as localMod from './local.js';
import { advanceAfterSceneSettled, findPendingSeedFrameJob } from './completionHook.js';

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
    mockExistsSync.mockReset().mockReturnValue(false);
    mockListJobs.mockReset().mockReturnValue([]);
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
    // The resume path now verifies the rendered .mp4 is still on disk
    // BEFORE deciding to re-sample; let it through. The persisted frame
    // (f1.jpg) is intentionally NOT on disk (existsSync defaults to
    // false for everything else), so sampleEvaluationFrames runs.
    // Simulate a successful re-sample so the evaluator is enqueued.
    mockExistsSync.mockImplementation((p) => typeof p === 'string' && p.endsWith('.mp4'));
    mockSampleEvaluationFrames.mockResolvedValueOnce(['f1.jpg']);

    await advanceAfterSceneSettled(project.id);

    expect(mockEnqueueEvaluateTask).toHaveBeenCalledTimes(1);
    const [, sceneArg] = mockEnqueueEvaluateTask.mock.calls[0];
    expect(sceneArg.sceneId).toBe('scene-2');
    expect(sceneArg.renderedJobId).toBe('22222222-2222-4222-8222-222222222222');
    // Should NOT fall through to runSceneRender for the next pending scene —
    // resume must finish the orphaned evaluate first.
    expect(mockRunSceneRender).not.toHaveBeenCalled();
  });

  it('fails the orphan scene AND advances to the next pending scene when the rendered .mp4 is missing (deleted-while-paused)', async () => {
    // The deleted-video branch in resume must do TWO things:
    //   1. Mark the orphaned scene `failed` (the evaluator's
    //      multi-frame and single-thumbnail fallback BOTH need the .mp4
    //      and its thumbnail, all of which are unlinked together by
    //      videoGen/local#deleteHistoryItem — none can recover).
    //   2. Nudge the orchestrator forward — otherwise the project sits in
    //      `rendering` forever because updateScene goes through local.js
    //      directly, not the route handler that auto-calls advance.
    const project = {
      id: 'cd-deleted-video',
      status: 'rendering',
      finalVideoId: null,
      treatment: {
        scenes: [
          { sceneId: 'scene-1', order: 0, status: 'evaluating', renderedJobId: '11111111-1111-4111-8111-111111111111', evaluationFrames: [] },
          { sceneId: 'scene-2', order: 1, status: 'pending' },
        ],
      },
      runs: [
        { kind: 'evaluate', sceneId: 'scene-1', status: 'completed' },
      ],
    };
    // After the deleted-video branch fails the orphan scene, the
    // implementation tail-recurses into advanceAfterSceneSettled. Reflect the
    // failure in the mock so the recursive call sees scene-1 as 'failed'
    // (not 'evaluating') and falls through to the nextPending branch instead
    // of re-entering the orphan branch indefinitely. The third+ call serves
    // the runSceneRender re-read.
    const projectAfterFail = {
      ...project,
      treatment: {
        ...project.treatment,
        scenes: [
          { ...project.treatment.scenes[0], status: 'failed' },
          project.treatment.scenes[1],
        ],
      },
    };
    localMod.getProject
      .mockResolvedValueOnce(project)
      .mockResolvedValue(projectAfterFail);
    // sampleEvaluationFrames returns [] (deleted video / extraction failure).
    mockSampleEvaluationFrames.mockResolvedValue([]);
    // existsSync returns false for every check — simulating that the .mp4
    // is gone from disk (the deleted-video case).
    mockExistsSync.mockReturnValue(false);

    await advanceAfterSceneSettled(project.id);

    // Scene-1 was failed with the right notes.
    expect(mockUpdateScene).toHaveBeenCalledWith(
      'cd-deleted-video',
      'scene-1',
      expect.objectContaining({
        status: 'failed',
        evaluation: expect.objectContaining({
          accepted: false,
          notes: expect.stringContaining('rendered video was deleted'),
        }),
      }),
    );
    // Evaluator must NOT be enqueued — there are no frames.
    expect(mockEnqueueEvaluateTask).not.toHaveBeenCalled();
    // After the tail-recursion, the orchestrator advanced to scene-2 (the
    // next pending scene) instead of leaving the project stuck.
    expect(mockRunSceneRender).toHaveBeenCalled();
    const renderedScene = mockRunSceneRender.mock.calls.at(-1)[1];
    expect(renderedScene.sceneId).toBe('scene-2');
  });

  it('enqueues the evaluator with empty frames (single-thumbnail fallback) when frame sampling returns 0 but the rendered video is still on disk', async () => {
    // sampleEvaluationFrames returns [] for non-fatal failures: ffmpeg
    // missing on PATH, ffprobe miscount, transient I/O. The cd-evaluate
    // template has a `{{^multiFrame}}` branch that falls back to the
    // single thumbnail at /data/video-thumbnails/{renderedJobId}.jpg —
    // the same fallback the normal render-completion path relies on. The
    // resume path must mirror that behavior (hand off whatever frames it
    // got, even an empty array) instead of bailing, otherwise the
    // project sits in `rendering` with an orphaned `evaluating` scene
    // and no automatic way back to progress from the UI.
    const project = {
      id: 'cd-transient-ffmpeg',
      status: 'rendering',
      finalVideoId: null,
      treatment: {
        scenes: [
          { sceneId: 'scene-1', order: 0, status: 'evaluating', renderedJobId: '22222222-2222-4222-8222-222222222222', evaluationFrames: [] },
          { sceneId: 'scene-2', order: 1, status: 'pending' },
        ],
      },
      runs: [
        { kind: 'evaluate', sceneId: 'scene-1', status: 'completed' },
      ],
    };
    localMod.getProject.mockResolvedValue(project);
    // Sampling returns [] (failure of some kind).
    mockSampleEvaluationFrames.mockResolvedValue([]);
    // existsSync(videoPath) → true: the rendered .mp4 is still on disk, so
    // the empty frames must be a transient ffmpeg/ffprobe failure.
    mockExistsSync.mockImplementation((p) => typeof p === 'string' && p.endsWith('.mp4'));

    await advanceAfterSceneSettled(project.id);

    // Scene must NOT be marked failed — the render is recoverable.
    expect(mockUpdateScene).not.toHaveBeenCalledWith(
      'cd-transient-ffmpeg',
      'scene-1',
      expect.objectContaining({ status: 'failed' }),
    );
    // Evaluator IS enqueued — empty frames go through the
    // single-thumbnail fallback path in the prompt template.
    expect(mockEnqueueEvaluateTask).toHaveBeenCalledTimes(1);
    const [, sceneArg] = mockEnqueueEvaluateTask.mock.calls[0];
    expect(sceneArg.sceneId).toBe('scene-1');
    expect(sceneArg.evaluationFrames).toEqual([]);
    // Resume must not skip past scene-1 to render scene-2 — the orphan
    // evaluator is owning that slot.
    expect(mockRunSceneRender).not.toHaveBeenCalled();
  });

  it('fails the orphan scene when the cached evaluationFrames are still on disk but the rendered .mp4 is gone (video-deleted-while-paused, frames-survive)', async () => {
    // The MP4 existence check must run BEFORE the frame-cache check,
    // because the evaluator (multi-frame OR single-thumbnail fallback)
    // both reference the .mp4 by its renderedJobId. If the user deleted
    // the rendered video while the project was paused but the cached
    // evaluationFrames thumbnails happened to survive (deleteHistoryItem
    // swallows unlink errors), the old code would happily enqueue the
    // evaluator and the scene could be accepted — only for the later
    // stitch step to fail on the missing input file.
    const project = {
      id: 'cd-mp4-gone-frames-stay',
      status: 'rendering',
      finalVideoId: null,
      treatment: {
        scenes: [
          { sceneId: 'scene-1', order: 0, status: 'evaluating', renderedJobId: '33333333-3333-4333-8333-333333333333', evaluationFrames: ['f1.jpg', 'f2.jpg', 'f3.jpg'] },
          { sceneId: 'scene-2', order: 1, status: 'pending' },
        ],
      },
      runs: [
        { kind: 'evaluate', sceneId: 'scene-1', status: 'completed' },
      ],
    };
    const projectAfterFail = {
      ...project,
      treatment: {
        ...project.treatment,
        scenes: [
          { ...project.treatment.scenes[0], status: 'failed' },
          project.treatment.scenes[1],
        ],
      },
    };
    localMod.getProject
      .mockResolvedValueOnce(project)
      .mockResolvedValue(projectAfterFail);
    // Frame thumbnails are on disk (allFramesExist would return true), but
    // the .mp4 is gone — only existsSync calls for the frame .jpg paths
    // return true; the .mp4 check returns false.
    mockExistsSync.mockImplementation((p) => typeof p === 'string' && p.endsWith('.jpg'));

    await advanceAfterSceneSettled(project.id);

    // Scene-1 was failed because the .mp4 is gone, even though the
    // cached frames were still on disk.
    expect(mockUpdateScene).toHaveBeenCalledWith(
      'cd-mp4-gone-frames-stay',
      'scene-1',
      expect.objectContaining({
        status: 'failed',
        evaluation: expect.objectContaining({
          accepted: false,
          notes: expect.stringContaining('rendered video was deleted'),
        }),
      }),
    );
    // Evaluator must NOT fire — its inputs (.mp4 and the thumbnail) are
    // gone, regardless of whether the cached frames survived.
    expect(mockEnqueueEvaluateTask).not.toHaveBeenCalled();
    // Sampling is also skipped — we bailed before that step.
    expect(mockSampleEvaluationFrames).not.toHaveBeenCalled();
    // Tail-advance moves the orchestrator forward to scene-2.
    expect(mockRunSceneRender).toHaveBeenCalled();
    expect(mockRunSceneRender.mock.calls.at(-1)[1].sceneId).toBe('scene-2');
  });

  it('rejects + fails orphaned-evaluating scenes whose renderedJobId is not a UUID (path-traversal guard, wedge prevention)', async () => {
    // scene.renderedJobId is editable via PATCH; a tampered value must NOT
    // be accepted into the resume path because sampleEvaluationFrames builds
    // ffmpeg paths via string concat. The scene must also be MARKED FAILED
    // — silently skipping it would leave it `evaluating` forever, and the
    // inflight check at the bottom of advanceAfterSceneSettled would
    // block every future advance call, wedging the whole project.
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
    // The wedged scene must be reset to `failed` so it doesn't block
    // future advances.
    expect(mockUpdateScene).toHaveBeenCalledWith(
      'cd-tamper',
      'scene-2',
      expect.objectContaining({ status: 'failed' }),
    );
    // After failing the wedged scene, advance still falls through to
    // render the next pending scene.
    expect(mockRunSceneRender).toHaveBeenCalledTimes(1);
    expect(mockRunSceneRender.mock.calls[0][1].sceneId).toBe('scene-3');
  });

  // #1929 — defer scene-0 render until its seeded reference frame settles.
  describe('first-pass seed-frame defer (#1929)', () => {
    // Each test uses a UNIQUE projectId: the completionHook's in-memory
    // `inflightSeedDefer` set persists across tests, so a test that defers but
    // never fires the settle event would otherwise leak its deferKey and wedge
    // a later same-id test into the "already armed" early-return.
    const seedProject = (id, overrides = {}) => ({
      id,
      status: 'rendering',
      finalVideoId: null,
      generateFirstPass: true,
      treatment: {
        scenes: [
          { sceneId: 'scene-1', order: 0, status: 'pending' },
          { sceneId: 'scene-2', order: 1, status: 'pending' },
        ],
      },
      ...overrides,
    });
    const seedJob = (projectId, sceneId, status = 'running') => ({
      id: `${projectId}-job`,
      kind: 'image',
      status,
      params: { creativeDirector: { projectId, sceneId } },
    });

    it('defers runSceneRender for the first scene while its seed frame job is in-flight', async () => {
      const project = seedProject('cd-seed-defer');
      localMod.getProject.mockResolvedValue(project);
      mockListJobs.mockReturnValue([seedJob(project.id, 'scene-1')]);

      await advanceAfterSceneSettled(project.id);

      // The render must NOT fire yet — the seeded reference frame is still
      // generating.
      expect(mockRunSceneRender).not.toHaveBeenCalled();
    });

    it('renders after the seed frame job completes and sourceImageFile lands', async () => {
      const project = seedProject('cd-seed-completes');
      const projectWithFrame = seedProject('cd-seed-completes', {
        treatment: {
          scenes: [
            { sceneId: 'scene-1', order: 0, status: 'pending', sourceImageFile: 'seed.png' },
            { sceneId: 'scene-2', order: 1, status: 'pending' },
          ],
        },
      });
      // 1st advance: no frame → defers. After the seed job completes, the
      // scene-image hook has filed sourceImageFile, so every subsequent read
      // returns the framed project.
      localMod.getProject
        .mockResolvedValueOnce(project)
        .mockResolvedValue(projectWithFrame);
      // Job is in-flight on the first list check; on the re-check (after
      // listeners attach) it's still in-flight, so we truly wait for the event.
      mockListJobs.mockReturnValue([seedJob(project.id, 'scene-1')]);

      await advanceAfterSceneSettled(project.id);
      expect(mockRunSceneRender).not.toHaveBeenCalled();

      // Fire the completion event — the defer listener re-advances.
      mockMediaJobEvents.emit('completed', seedJob(project.id, 'scene-1', 'completed'));
      // Let the async poll + re-advance settle.
      await new Promise((r) => setTimeout(r, 400));

      expect(mockRunSceneRender).toHaveBeenCalledTimes(1);
      const [, sceneArg] = mockRunSceneRender.mock.calls[0];
      expect(sceneArg.sceneId).toBe('scene-1');
      expect(sceneArg.sourceImageFile).toBe('seed.png');
    });

    it('renders text-to-video when the seed frame job fails (frame never lands)', async () => {
      const project = seedProject('cd-seed-fails');
      localMod.getProject.mockResolvedValue(project);
      mockListJobs.mockReturnValue([seedJob(project.id, 'scene-1')]);

      await advanceAfterSceneSettled(project.id);
      expect(mockRunSceneRender).not.toHaveBeenCalled();

      // Once the job fails it's terminal — the queue no longer reports it as
      // queued/running, so the re-advance won't re-defer.
      mockListJobs.mockReturnValue([seedJob(project.id, 'scene-1', 'failed')]);
      mockMediaJobEvents.emit('failed', seedJob(project.id, 'scene-1', 'failed'));
      // Poll runs to the deadline (no sourceImageFile ever) then renders.
      await new Promise((r) => setTimeout(r, 3200));

      expect(mockRunSceneRender).toHaveBeenCalledTimes(1);
      expect(mockRunSceneRender.mock.calls[0][1].sceneId).toBe('scene-1');
    });

    it('does NOT defer when generateFirstPass is off', async () => {
      const project = seedProject('cd-seed-noflag', { generateFirstPass: false });
      localMod.getProject.mockResolvedValue(project);
      // Even if a stray matching job exists, no defer without the flag.
      mockListJobs.mockReturnValue([seedJob(project.id, 'scene-1')]);

      await advanceAfterSceneSettled(project.id);

      expect(mockRunSceneRender).toHaveBeenCalledTimes(1);
      expect(mockRunSceneRender.mock.calls[0][1].sceneId).toBe('scene-1');
    });

    it('does NOT defer when the scene already has a sourceImageFile', async () => {
      const project = seedProject('cd-seed-hasframe', {
        treatment: {
          scenes: [
            { sceneId: 'scene-1', order: 0, status: 'pending', sourceImageFile: 'existing.png' },
            { sceneId: 'scene-2', order: 1, status: 'pending' },
          ],
        },
      });
      localMod.getProject.mockResolvedValue(project);
      mockListJobs.mockReturnValue([seedJob(project.id, 'scene-1')]);

      await advanceAfterSceneSettled(project.id);

      expect(mockRunSceneRender).toHaveBeenCalledTimes(1);
    });

    it('does NOT defer when no seed job is in-flight for the scene (renders immediately)', async () => {
      const project = seedProject('cd-seed-nojob');
      localMod.getProject.mockResolvedValue(project);
      // Job list has only a job for a DIFFERENT scene.
      mockListJobs.mockReturnValue([seedJob(project.id, 'scene-2')]);

      await advanceAfterSceneSettled(project.id);

      expect(mockRunSceneRender).toHaveBeenCalledTimes(1);
      expect(mockRunSceneRender.mock.calls[0][1].sceneId).toBe('scene-1');
    });
  });

  describe('findPendingSeedFrameJob (#1929)', () => {
    const job = (over) => ({ id: 'j1', kind: 'image', status: 'running', params: { creativeDirector: { projectId: 'p1', sceneId: 's1' } }, ...over });

    it('matches a queued/running image job tagged for the project+scene', () => {
      expect(findPendingSeedFrameJob([job()], 'p1', 's1')?.id).toBe('j1');
      expect(findPendingSeedFrameJob([job({ status: 'queued' })], 'p1', 's1')?.id).toBe('j1');
    });
    it('ignores terminal, wrong-kind, wrong-scene, and untagged jobs', () => {
      expect(findPendingSeedFrameJob([job({ status: 'completed' })], 'p1', 's1')).toBeNull();
      expect(findPendingSeedFrameJob([job({ status: 'failed' })], 'p1', 's1')).toBeNull();
      expect(findPendingSeedFrameJob([job({ kind: 'video' })], 'p1', 's1')).toBeNull();
      expect(findPendingSeedFrameJob([job()], 'p1', 's2')).toBeNull();
      expect(findPendingSeedFrameJob([job()], 'p2', 's1')).toBeNull();
      expect(findPendingSeedFrameJob([{ kind: 'image', status: 'running', params: {} }], 'p1', 's1')).toBeNull();
    });
    it('handles a non-array input defensively', () => {
      expect(findPendingSeedFrameJob(null, 'p1', 's1')).toBeNull();
    });
  });
});
