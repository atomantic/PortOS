import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-fal-upscale-'),
}));

const mocks = vi.hoisted(() => ({
  enqueueJob: vi.fn(),
  getSettings: vi.fn(),
  getHistoryItem: vi.fn(),
  mutateVideoHistory: vi.fn(),
  planUpscaleHistoryItem: vi.fn(),
  hostFalDataUri: vi.fn(),
  submitFalRequest: vi.fn(),
  awaitFalCompletion: vi.fn(),
  readCompletedFalResult: vi.fn(),
  cancelFalRequest: vi.fn(),
  finalizeUpscaleOutput: vi.fn(),
  probeVideoStreamInfo: vi.fn(),
  probeVideoDuration: vi.fn(),
  generateThumbnail: vi.fn(),
}));

vi.mock('../mediaJobQueue/index.js', () => ({ enqueueJob: mocks.enqueueJob }));
vi.mock('../settings.js', () => ({ getSettings: mocks.getSettings }));
vi.mock('./history.js', () => ({ getHistoryItem: mocks.getHistoryItem, mutateVideoHistory: mocks.mutateVideoHistory }));
vi.mock('./upscaleVideo.js', () => ({ planUpscaleHistoryItem: mocks.planUpscaleHistoryItem }));
vi.mock('./upscaleFfmpeg.js', () => ({ finalizeUpscaleOutput: mocks.finalizeUpscaleOutput }));
vi.mock('../falQueue.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    hostFalDataUri: mocks.hostFalDataUri,
    submitFalRequest: mocks.submitFalRequest,
    awaitFalCompletion: mocks.awaitFalCompletion,
    readCompletedFalResult: mocks.readCompletedFalResult,
    cancelFalRequest: mocks.cancelFalRequest,
  };
});
vi.mock('../../lib/ffmpeg.js', async (importOriginal) => ({
  ...(await importOriginal()),
  probeVideoStreamInfo: mocks.probeVideoStreamInfo,
  probeVideoDuration: mocks.probeVideoDuration,
  generateThumbnail: mocks.generateThumbnail,
}));

const { PATHS } = await import('../../lib/paths.js');
const { videoGenEvents } = await import('./events.js');
const { enqueueFalSeedvr2Upscale, runVideoUpscale, cancel } = await import('./falUpscaleJob.js');
const { planFalSeedvr2Target, estimateFalSeedvr2CostUsd, FAL_SEEDVR2_HISTORY_MODEL_ID } = await import('./upscalePlan.js');
const { renderSpendEntry } = await import('../../lib/musicVideo/musicVideoSpend.js');
const { isMeteredProjectRender } = await import('../musicVideo/renderSpend.js');
const { mediaJobExecutionLane } = await import('../../lib/generationModes.js');

const SOURCE_ID = '11111111-2222-4333-8444-555555555555';
const BASE_ITEM = {
  id: SOURCE_ID,
  filename: `${SOURCE_ID}.mp4`,
  prompt: 'Example clip',
  width: 854,
  height: 480,
  fps: 24,
  numFrames: 121,
  musicVideo: { projectId: 'mv-old', sceneId: 'mvs-old' },
};

const READY_PLAN = {
  id: SOURCE_ID,
  method: 'fal-seedvr2',
  alreadyUpscaled: false,
  source: { width: 854, height: 480, fps: 24, frameCount: 121, durationSeconds: 5.04, hasAudio: false },
  target: { width: 1920, height: 1088, frameCount: 121 },
  runtime: { id: 'fal-seedvr2', label: 'fal.ai SeedVR2', supported: true, installed: true, reason: null },
  estimatedCostUsd: 0.2528,
};

beforeEach(async () => {
  vi.clearAllMocks();
  await mkdir(PATHS.videos, { recursive: true });
  await mkdir(PATHS.videoThumbnails, { recursive: true });
  await writeFile(join(PATHS.videos, `${SOURCE_ID}.mp4`), Buffer.from('source-mp4'));
  mocks.getSettings.mockResolvedValue({ videoGen: { fal: { apiKey: 'fal-test-key' } } });
  mocks.getHistoryItem.mockResolvedValue(BASE_ITEM);
  mocks.planUpscaleHistoryItem.mockResolvedValue(READY_PLAN);
  mocks.enqueueJob.mockResolvedValue({ jobId: 'job-upscale-1', position: 1, status: 'queued' });
});

afterAll(() => cleanupTempDataRoots());

describe('fal SeedVR2 pricing & lane classification', () => {
  it('computes 1080p aspect-preserving dimensions, $0.001/MP cost, and cloud lane routing', () => {
    const target = planFalSeedvr2Target({ width: 854, height: 480, frameCount: 121, targetResolution: '1080p' });
    expect(target).toEqual({ width: 1920, height: 1088, frameCount: 121 });
    expect(estimateFalSeedvr2CostUsd(target)).toBe(0.2528);
    expect(mediaJobExecutionLane({ kind: 'video-upscale', mode: 'fal' })).toBe('cloud');
  });
});

describe('enqueueFalSeedvr2Upscale', () => {
  it('refuses already-upscaled clips and missing FAL_KEY before queueing', async () => {
    mocks.planUpscaleHistoryItem.mockResolvedValueOnce({ ...READY_PLAN, alreadyUpscaled: true });
    await expect(enqueueFalSeedvr2Upscale(SOURCE_ID)).rejects.toMatchObject({ code: 'ALREADY_UPSCALED', status: 400 });

    mocks.planUpscaleHistoryItem.mockResolvedValueOnce({
      ...READY_PLAN,
      runtime: { ...READY_PLAN.runtime, installed: false, reason: 'Missing FAL_KEY' },
    });
    await expect(enqueueFalSeedvr2Upscale(SOURCE_ID)).rejects.toMatchObject({ code: 'FAL_KEY_MISSING', status: 400 });
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
  });

  it('queues on the cloud fal lane with estimated cost and explicit Music Video attribution', async () => {
    const res = await enqueueFalSeedvr2Upscale(SOURCE_ID, {
      targetResolution: '1080p',
      musicVideoProjectId: 'mv-v2',
      sceneId: 'mvs-75',
    });
    expect(res.jobId).toBe('job-upscale-1');
    expect(mocks.enqueueJob).toHaveBeenCalledWith({
      kind: 'video-upscale',
      params: expect.objectContaining({
        mode: 'fal',
        upscaleMethod: 'fal-seedvr2',
        historyId: SOURCE_ID,
        targetResolution: '1080p',
        estimatedCostUsd: 0.2528,
        musicVideoCostUsd: 0.2528,
        musicVideoCostModelId: FAL_SEEDVR2_HISTORY_MODEL_ID,
        musicVideoProjectId: 'mv-v2',
        musicVideo: { projectId: 'mv-v2', sceneId: 'mvs-75', tier: 'final' },
      }),
    });
  });

  it('inherits source Music Video attribution without leaking its scene to another explicit project', async () => {
    await enqueueFalSeedvr2Upscale(SOURCE_ID, { targetResolution: '1080p' });
    expect(mocks.enqueueJob).toHaveBeenLastCalledWith({
      kind: 'video-upscale',
      params: expect.objectContaining({
        musicVideoProjectId: 'mv-old',
        musicVideo: { projectId: 'mv-old', sceneId: 'mvs-old', tier: 'final' },
      }),
    });

    await enqueueFalSeedvr2Upscale(SOURCE_ID, { targetResolution: '1080p', musicVideoProjectId: 'mv-new' });
    expect(mocks.enqueueJob).toHaveBeenLastCalledWith({
      kind: 'video-upscale',
      params: expect.objectContaining({
        musicVideoProjectId: 'mv-new',
        musicVideo: { projectId: 'mv-new', tier: 'final' },
      }),
    });
  });
});

describe('runVideoUpscale & spend accounting', () => {
  it('uploads, upscales via SeedVR2, records history + cost + Music Video tag, and counts in renderSpend', async () => {
    mocks.probeVideoStreamInfo
      .mockResolvedValueOnce({ width: 854, height: 480, fps: 24, frameCount: 121 })
      .mockResolvedValueOnce({ width: 1936, height: 1088, fps: 24, frameCount: 121 })
      .mockResolvedValueOnce({ width: 1936, height: 1088, fps: 24, frameCount: 121 });
    mocks.probeVideoDuration.mockResolvedValue(5.041667);
    mocks.generateThumbnail.mockResolvedValue('thumb.jpg');
    mocks.hostFalDataUri.mockResolvedValue('https://fal.media/example-input.mp4');
    mocks.submitFalRequest.mockResolvedValue({
      request_id: 'fal-req-1',
      status_url: 'https://queue.fal.run/status/1',
      response_url: 'https://queue.fal.run/response/1',
      cancel_url: 'https://queue.fal.run/cancel/1',
    });
    mocks.awaitFalCompletion.mockResolvedValue({ outcome: 'completed' });
    mocks.readCompletedFalResult
      .mockResolvedValueOnce({ video: { url: 'https://fal.media/example-output.mp4' } })
      .mockResolvedValueOnce(Buffer.from('upscaled-mp4').buffer);
    mocks.finalizeUpscaleOutput.mockImplementation(async (_raw, dest) => {
      await writeFile(dest, Buffer.from('final-mp4'));
      return { ok: true };
    });
    let history = [];
    mocks.mutateVideoHistory.mockImplementation(async (fn) => { history = fn(history); });

    const completed = [];
    const onCompleted = (payload) => completed.push(payload);
    videoGenEvents.on('completed', onCompleted);
    try {
      const entry = await runVideoUpscale({
        jobId: 'job-upscale-1',
        historyId: SOURCE_ID,
        targetResolution: '1080p',
        musicVideo: { projectId: 'mv-v2', sceneId: 'mvs-75', tier: 'final' },
      });

      expect(mocks.submitFalRequest).toHaveBeenCalledWith({
        apiKey: 'fal-test-key',
        modelId: 'fal-ai/seedvr/upscale/video',
        body: {
          video_url: 'https://fal.media/example-input.mp4',
          upscale_mode: 'target',
          target_resolution: '1080p',
          noise_scale: 0.1,
        },
      });
      expect(entry).toMatchObject({
        upscaledFrom: SOURCE_ID,
        upscaleMethod: 'fal-seedvr2',
        upscaleRuntime: 'fal-seedvr2',
        modelId: FAL_SEEDVR2_HISTORY_MODEL_ID,
        width: 1936,
        height: 1088,
        numFrames: 121,
        estimatedCostUsd: 0.2549,
        falRequestId: 'fal-req-1',
        musicVideo: { projectId: 'mv-v2', sceneId: 'mvs-75' },
      });
      expect(history).toHaveLength(1);
      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({ generationId: 'job-upscale-1', id: entry.id });

      // Verify the completed job feeds Music Video spend accounting under the fal lane.
      const completedJob = {
        id: 'job-upscale-1',
        kind: 'video-upscale',
        params: { mode: 'fal', musicVideoProjectId: 'mv-v2', musicVideo: { projectId: 'mv-v2', sceneId: 'mvs-75' } },
        result: completed[0],
      };
      expect(isMeteredProjectRender(completedJob)).toBe(true);
      expect(renderSpendEntry({
        job: completedJob,
        estimatedUsd: entry.estimatedCostUsd,
        modelId: entry.modelId,
        assetId: entry.id,
        at: '2026-01-01T00:00:00.000Z',
      })).toMatchObject({
        projectId: 'mv-v2',
        lane: 'fal',
        mediaKind: 'video',
        assetId: entry.id,
        usd: 0.2549,
        modelId: FAL_SEEDVR2_HISTORY_MODEL_ID,
      });
    } finally {
      videoGenEvents.off('completed', onCompleted);
    }
  });

  it('cancels an active in-flight upscale locally and remotely', async () => {
    let resolvePoll;
    mocks.probeVideoStreamInfo.mockResolvedValue({ width: 854, height: 480, fps: 24, frameCount: 121 });
    mocks.hostFalDataUri.mockResolvedValue('https://fal.media/example-input.mp4');
    mocks.submitFalRequest.mockResolvedValue({
      request_id: 'fal-req-2',
      status_url: 'https://queue.fal.run/status/2',
      response_url: 'https://queue.fal.run/response/2',
      cancel_url: 'https://queue.fal.run/cancel/2',
    });
    mocks.awaitFalCompletion.mockImplementation(() => new Promise((resolve) => { resolvePoll = resolve; }));

    const pending = runVideoUpscale({ jobId: 'job-cancel-1', historyId: SOURCE_ID });
    await vi.waitFor(() => expect(mocks.awaitFalCompletion).toHaveBeenCalledOnce());
    expect(await cancel('job-cancel-1')).toBe(true);
    expect(mocks.cancelFalRequest).toHaveBeenCalledOnce();
    resolvePoll({ outcome: 'canceled' });
    expect(await pending).toBeNull();
  });
});
