import { describe, it, expect, vi, beforeEach } from 'vitest';

const enqueueJob = vi.fn(async () => ({ jobId: 'job-ext-1' }));
vi.mock('../mediaJobQueue/index.js', () => ({ enqueueJob }));
let row = null;
vi.mock('./history.js', () => ({ getHistoryItem: async () => row }));
let geometry = { durationSec: 8, width: 1280, height: 720 };
vi.mock('../../lib/ffmpeg.js', () => ({ probeVideoGeometry: async () => geometry, safeUnder: (root, name) => `${root}/${name}` }));
vi.mock('fs', async (importOriginal) => ({ ...(await importOriginal()), existsSync: () => true }));
const take = { takeId: 'mvt-1', kind: 'video', assetId: 'clip-1', dependencies: { version: 1 } };
vi.mock('../musicVideo/requireProject.js', () => ({
  requireProject: async () => ({ id: 'p1', scenes: [{ sceneId: 's1', takes: [take] }] }),
}));

const { extendHistoryClip } = await import('./extendHosted.js');
const { extendTakeInPointFrames } = await import('../../lib/musicVideoSequenceTake.js');
const { appendSceneTakes } = await import('../musicVideo/takes.js');

const VEO = 'fal:fal-ai/veo3.1/fast/image-to-video';

describe('extendHistoryClip', () => {
  beforeEach(() => {
    enqueueJob.mockClear();
    row = { id: 'clip-1', modelId: VEO, filename: 'clip-1.mp4' };
    geometry = { durationSec: 8, width: 1280, height: 720 };
  });

  // Uniquely catches a preview that differs from the send, or one that spends money.
  it('previews the exact body and price without queuing, then queues the same request', async () => {
    const plan = await extendHistoryClip('clip-1', { prompt: 'She walks on', dryRun: true });
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(plan).toMatchObject({ dryRun: true, seconds: 7, resolution: '720p', estimatedCostUsd: 1.05 });
    expect(plan.body).toMatchObject({ prompt: 'She walks on', video_url: 'pending:video', duration: '7s', generate_audio: false });
    const queued = await extendHistoryClip('clip-1', { prompt: 'She walks on' });
    expect(queued).toMatchObject({ dryRun: false, jobId: 'job-ext-1', body: plan.body });
    const { params } = enqueueJob.mock.calls[0][0];
    expect(params).toMatchObject({ mode: 'fal', modelId: 'fal-ai/veo3.1/fast/extend-video', extendedFrom: 'clip-1', prompt: 'She walks on' });
    expect(params.musicVideo).toBeUndefined();
  });

  // Uniquely catches a child filed without its parent, or against a take that is not this clip.
  it('tags a Music Video extension with its parent take and the parent\'s dependencies', async () => {
    await extendHistoryClip('clip-1', { prompt: 'x', musicVideo: { projectId: 'p1', sceneId: 's1', takeId: 'mvt-1' } });
    const { params } = enqueueJob.mock.calls[0][0];
    expect(params.musicVideo).toEqual({ projectId: 'p1', sceneId: 's1' });
    expect(params.musicVideoExtend).toMatchObject({ parentTakeId: 'mvt-1', extensionSec: 7 });
    expect(params.musicVideoDependencies).toEqual(take.dependencies);
    await expect(extendHistoryClip('clip-1', { prompt: 'x', musicVideo: { projectId: 'p1', sceneId: 's1', takeId: 'nope' } }))
      .rejects.toMatchObject({ status: 409, code: 'EXTEND_TAKE_MISMATCH' });
  });

  it('refuses a clip whose model declares no extend with 409, before probing or queuing', async () => {
    row = { ...row, modelId: 'fal:fal-ai/kling-video/v3/pro/image-to-video' };
    await expect(extendHistoryClip('clip-1', { prompt: 'x' })).rejects.toMatchObject({ status: 409, code: 'EXTEND_UNSUPPORTED' });
    row = { ...row, modelId: 'ltx-2.5' };
    await expect(extendHistoryClip('clip-1', { prompt: 'x', dryRun: true })).rejects.toMatchObject({ status: 409 });
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('refuses an over-length or wrong-aspect source with the reason', async () => {
    geometry = { durationSec: 9, width: 1280, height: 720 };
    await expect(extendHistoryClip('clip-1', { prompt: 'x' })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/at most 8s/) });
    geometry = { durationSec: 5, width: 1000, height: 1000 };
    await expect(extendHistoryClip('clip-1', { prompt: 'x' })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/16:9 or 9:16/) });
    expect(enqueueJob).not.toHaveBeenCalled();
  });
});

describe('extension lineage', () => {
  // Uniquely catches an extension that selects itself, or a child that loses its parent or its in-point.
  it('files the child as an unselected candidate recording its parent and the in-point of its new footage', () => {
    expect(extendTakeInPointFrames({ deliveredSec: 15, extensionSec: 7 })).toBe(192);
    expect(extendTakeInPointFrames({ deliveredSec: 7.1, extensionSec: 7 })).toBe(0);
    const project = { id: 'p1', scenes: [{ sceneId: 's1', startSec: 0, endSec: 8, videoHistoryId: 'clip-1', takes: [{ ...take, status: 'candidate' }] }] };
    const { scene, appended } = appendSceneTakes(project, 's1', [{
      kind: 'video', assetId: 'clip-2', source: 'generated', extend: { parentTakeId: 'mvt-1', offsetFrames: 192 }, autoSelect: false,
    }]);
    expect(appended[0]).toMatchObject({ parentTakeId: 'mvt-1', extend: { parentTakeId: 'mvt-1', offsetFrames: 192 }, status: 'candidate' });
    expect(scene.videoHistoryId).toBe('clip-1');
  });
});
