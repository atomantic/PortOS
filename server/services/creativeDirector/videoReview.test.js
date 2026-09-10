import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ project: null, start: vi.fn(), enqueue: vi.fn() }));
vi.mock('./local.js', () => ({
  getProject: vi.fn(async () => structuredClone(mocks.project)),
  mutateVideoProject: vi.fn(async (_id, mutate) => {
    const result = await mutate(structuredClone(mocks.project));
    mocks.project = result.project;
    return result;
  }),
}));
vi.mock('../instanceIdentity.js', () => ({ getInstanceId: vi.fn(async () => 'example-owner') }));
vi.mock('./completionHook.js', () => ({ startCreativeDirectorProject: mocks.start }));
vi.mock('./videoSources.js', () => ({ assertVideoSourcesAvailable: vi.fn() }));
import { getVideoReview, reviewVideo, videoReviewAllowsDispatch } from './videoReview.js';
import { applySceneUpdate, applyPlanStepUpdate, applyTreatment, applyPlan, mergeProjectRecord } from './projectsLogic.js';
import { sanitizeRecordForWire } from '../../lib/syncWire.js';

const scene = (id, order, extra = {}) => ({ sceneId: id, order, intent: 'Example shot', prompt: 'Example landscape', durationSeconds: 5, status: 'accepted', renderedJobId: `example-render-${id}`, workRevision: 0, ...extra });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.project = { id: 'example-video', workspace: 'video', videoOwnerInstanceId: 'example-owner', videoReplica: false,
    status: 'rendering', targetDurationSeconds: 15, aspectRatio: '16:9', updatedAt: '2026-09-01T00:00:00Z',
    videoDraft: { reviewPolicy: 'review', sources: [], checkpoints: ['script-shot-plan', 'references', 'rough-cut', 'final-cut'] },
    videoExecution: { authorized: true },
    treatment: { script: 'An invented journey.', artifact: { revision: 1, stale: false }, scenes: [scene('one', 0), scene('two', 1, { useContinuationFromPrior: true }), scene('three', 2)] },
    videoRoughCut: { videoId: 'example-rough' }, videoFinalCut: { videoId: 'example-final' },
  };
});
const inputFor = async (stage, action, extra = {}) => ({ stage, action, revision: (await getVideoReview('example-video')).checkpoints.find(row => row.stage === stage).revision, ...extra });

describe('Video review workflow', () => {
  it('invalidates reference edits and continuing clips while preserving independent accepted shots', async () => {
    await reviewVideo('example-video', await inputFor('script-shot-plan', 'approve'));
    mocks.project = applySceneUpdate(mocks.project, 'one', { sourceImageFile: 'example-frame.png', expectedWorkRevision: 0 }).project;
    expect(mocks.project.status).toBe('paused');
    expect(mocks.project.treatment.scenes.map(s => s.status)).toEqual(['pending', 'pending', 'accepted']);
    expect(mocks.project.treatment.scenes.map(s => s.workRevision)).toEqual([1, 1, 0]);
    expect(mocks.project.treatment.history[0].scenes[0].renderedJobId).toBe('example-render-one');
    expect(await videoReviewAllowsDispatch('example-video', ['script-shot-plan', 'references'])).toBe(false);
    expect(() => applySceneUpdate(mocks.project, 'two', { expectedWorkRevision: 0, status: 'accepted' })).toThrow('superseded revision');
  });

  it('blocks actual consumption until current approval, resumes once, and keeps feedback separate', async () => {
    expect(await videoReviewAllowsDispatch('example-video', ['script-shot-plan', 'references'])).toBe(false);
    expect(mocks.project.videoReview.waitingFor.stage).toBe('script-shot-plan');
    await reviewVideo('example-video', await inputFor('script-shot-plan', 'feedback', { rating: 'up' }));
    expect(mocks.start).not.toHaveBeenCalled();
    expect(await videoReviewAllowsDispatch('example-video', ['script-shot-plan'])).toBe(false);
    const approval = await inputFor('script-shot-plan', 'approve');
    await reviewVideo('example-video', approval);
    await reviewVideo('example-video', approval);
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(await videoReviewAllowsDispatch('example-video', ['script-shot-plan', 'references'])).toBe(true);
    const reloaded = await getVideoReview('example-video');
    expect(reloaded.feedback).toHaveLength(1);
    expect(reloaded.checkpoints[1]).toMatchObject({ status: 'skipped', skipReason: 'No attached references' });
    mocks.project.modelOverrides = { treatment: { providerId: 'example-new-provider' } };
    await expect(reviewVideo('example-video', approval)).rejects.toMatchObject({ code: 'VIDEO_REVIEW_STALE' });
    expect(await videoReviewAllowsDispatch('example-video', ['script-shot-plan'])).toBe(false);
  });

  it('retains accepted independent shots and history while refusing late render/evaluator callbacks', async () => {
    await reviewVideo('example-video', await inputFor('rough-cut', 'request-revision', { sceneId: 'one', note: 'Change the opening lighting' }));
    expect(mocks.project.status).toBe('paused');
    expect(mocks.project.treatment.history[0].scenes[0].renderedJobId).toBe('example-render-one');
    expect(mocks.project.treatment.scenes.map(s => s.status)).toEqual(['pending', 'pending', 'accepted']);
    expect(mocks.project.treatment.scenes[2].renderedJobId).toBe('example-render-three');
    expect(mocks.project.videoRoughCut).toBeNull();
    expect(mocks.project.videoFinalCut).toBeNull();
    expect(() => applySceneUpdate(mocks.project, 'one', { expectedWorkRevision: 0, status: 'accepted', renderedJobId: 'late-render' })).toThrow('superseded revision');
    expect(mocks.start).not.toHaveBeenCalled();
    expect(() => applyTreatment(mocks.project, { productionRevision: 0 })).toThrow('revised after planning began');
  });

  it('rejects callbacks after a whole-stage revision and resets active work', async () => {
    mocks.project.treatment.scenes[0].status = 'rendering';
    await reviewVideo('example-video', await inputFor('script-shot-plan', 'request-revision', { note: 'Revise the script' }));
    expect(mocks.project.treatment.artifact.stale).toBe(true);
    expect((await getVideoReview('example-video')).checkpoints[0].ready).toBe(false);
    expect(mocks.project.treatment.scenes[0]).toMatchObject({ status: 'pending', renderedJobId: null, workRevision: 1 });
    expect(() => applySceneUpdate(mocks.project, 'one', { expectedWorkRevision: 0, status: 'accepted' })).toThrow('superseded revision');
    expect(mocks.project.treatment.scenes[2].renderedJobId).toBe('example-render-three');
  });

  it('reuses only unchanged successful plan work and invalidates changed dependencies', () => {
    const steps = [
      { stepId: 'a', toolName: 'media_enqueueVideoJob', args: { params: { prompt: 'Old', durationSeconds: 5 } }, dependsOn: [] },
      { stepId: 'b', toolName: 'media_enqueueVideoJob', args: { params: { prompt: 'Next', durationSeconds: 5 } }, dependsOn: ['a'] },
      { stepId: 'c', toolName: 'media_enqueueVideoJob', args: { params: { prompt: 'Independent', durationSeconds: 5 } }, dependsOn: [] },
    ];
    mocks.project.plan = { steps: steps.map(step => ({ ...step, status: 'done', result: { jobId: step.stepId } })) };
    const revised = applyPlan(mocks.project, { steps: steps.map(step => step.stepId === 'a' ? { ...step, args: { params: { prompt: 'Changed', durationSeconds: 5 } }, status: 'done', result: { jobId: 'forged' } } : step) });
    expect(revised.plan.steps.map(step => step.status)).toEqual(['pending', 'pending', 'done']);
    expect(revised.plan.steps[0].result).toBeNull();
    expect(revised.plan.steps[2].result).toEqual({ jobId: 'c' });
    expect(revised.plan.history[0].steps[0].result).toEqual({ jobId: 'a' });
    expect(() => applyPlanStepUpdate(revised, 'a', { expectedProductionRevision: 0, status: 'done' })).toThrow('superseded revision');
  });

  it('invalidates a requested DAG step and its dependents without rerunning independent results', async () => {
    mocks.project.plan = { steps: [
      { stepId: 'a', status: 'done', result: { jobId: 'old-a' } },
      { stepId: 'b', dependsOn: ['a'], status: 'done', result: { jobId: 'old-b' } },
      { stepId: 'c', status: 'done', result: { jobId: 'keep-c' } },
    ] };
    await reviewVideo('example-video', await inputFor('script-shot-plan', 'request-revision', { stepId: 'a', note: 'Revise the first clip' }));
    expect(mocks.project.plan.steps.map(s => s.status)).toEqual(['pending', 'pending', 'done']);
    expect(mocks.project.plan.history[0].steps[0].result.jobId).toBe('old-a');
    expect(() => applyPlanStepUpdate(mocks.project, 'a', { expectedProductionRevision: 0, status: 'done' })).toThrow('superseded revision');
  });

  it('skips human checkpoints for autonomous policy but still requires local execution authorization', async () => {
    mocks.project.videoDraft.reviewPolicy = 'autonomous';
    expect(await videoReviewAllowsDispatch('example-video', ['script-shot-plan', 'rough-cut', 'final-cut'])).toBe(true);
    mocks.project.videoExecution = null;
    expect(await videoReviewAllowsDispatch('example-video', ['script-shot-plan'])).toBe(false);
  });

  it('keeps owner authority out of sync and rejects review on replicas', async () => {
    const wire = sanitizeRecordForWire('creativeDirectorProject', mocks.project);
    expect(wire).not.toHaveProperty('videoExecution');
    expect(wire).not.toHaveProperty('videoReplica');
    const replica = mergeProjectRecord(null, { ...wire, videoExecution: { authorized: true } }).next;
    expect(replica).toMatchObject({ videoReplica: true, videoExecution: null });
    const local = mocks.project;
    expect(mergeProjectRecord(local, { ...wire, updatedAt: '2099-01-01T00:00:00Z', videoReview: { decisions: {} } }).next).toEqual(local);
    mocks.project = replica;
    await expect(reviewVideo('example-video', await inputFor('script-shot-plan', 'approve'))).rejects.toMatchObject({ code: 'VIDEO_OWNER_REQUIRED' });
  });
});


it('preserves paid clips and continuation frames when only the cut audio changes, and invalidates review', async () => {
  mocks.project.status = 'paused';
  await reviewVideo('example-video', await inputFor('script-shot-plan', 'approve'));
  mocks.project.status = 'paused';
  const before = structuredClone(mocks.project.treatment.scenes);
  mocks.project = applySceneUpdate(mocks.project, 'one', { muteAudio: true, expectedWorkRevision: 0 }).project;
  expect(mocks.project.treatment.scenes.map(s => s.renderedJobId)).toEqual(before.map(s => s.renderedJobId));
  expect(mocks.project.treatment.scenes.map(s => s.status)).toEqual(['accepted', 'accepted', 'accepted']);
  expect(mocks.project.treatment.scenes.map(s => s.workRevision)).toEqual([1, 0, 0]);
  expect(mocks.project.videoRoughCut).toBeNull();
  expect(mocks.project.videoFinalCut).toBeNull();
  expect(await videoReviewAllowsDispatch('example-video', ['script-shot-plan'])).toBe(false);
  mocks.project.status = 'rendering';
  expect(() => applySceneUpdate(mocks.project, 'one', { muteAudio: false, expectedWorkRevision: 1 })).toThrow('Pause production');
});
