import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/fileUtils.js', async original => makePathsProxy(await original(), {
  dataRoot: () => lazyTempDataRoot('portos-realesrgan-job-'),
}));

const mocks = vi.hoisted(() => ({
  enqueueJob: vi.fn(),
  getHistoryItem: vi.fn(),
  planUpscaleHistoryItem: vi.fn(),
  mutateVideoHistory: vi.fn(),
}));
vi.mock('../mediaJobQueue/index.js', () => ({ enqueueJob: mocks.enqueueJob }));
vi.mock('./history.js', () => ({ getHistoryItem: mocks.getHistoryItem, mutateVideoHistory: mocks.mutateVideoHistory }));
vi.mock('./upscaleVideo.js', () => ({ planUpscaleHistoryItem: mocks.planUpscaleHistoryItem }));

vi.mock('./realesrganRuntime.js', () => ({
  resolveRealesrganInvocation: async () => ({ bin: 'realesrgan-fixture' }),
  realesrganArgs: ({ input, output }) => [input, output],
}));
vi.mock('../../lib/ffmpeg.js', async original => ({
  ...await original(),
  findFfmpeg: async () => 'ffmpeg-fixture',
  vfrSyncArgs: async () => [],
  bt709TagFilter: async () => null,
  runFfmpegProcess: async ({ args, bin }) => {
    const output = args.at(-1);
    if (bin === 'realesrgan-fixture') await copyFile(join(args[0], '00000001.png'), join(output, '00000001.png'));
    else await writeFile(output.replace('%08d', '00000001'), 'fixture');
    return { ok: true };
  },
  generateThumbnail: async () => null,
  probeVideoStreamInfo: async () => ({ width: 1708, height: 960, fps: 24, frameCount: 1 }),
  probeVideoDuration: async () => 0.04,
}));
vi.mock('./upscaleFfmpeg.js', () => ({
  finalizeUpscaleOutput: async (input, output) => {
    await copyFile(input, output);
    return { ok: true };
  },
}));

const { PATHS } = await import('../../lib/fileUtils.js');
const { enqueueRealesrganUpscale, runVideoUpscale, frameRateArg, cancel } = await import('./realesrganUpscaleJob.js');
const { mediaJobExecutionLane } = await import('../../lib/generationModes.js');

const SOURCE_ID = '11111111-2222-4333-8444-555555555555';
const READY_PLAN = {
  id: SOURCE_ID,
  method: 'realesrgan',
  alreadyUpscaled: false,
  source: { width: 854, height: 480, fps: 24000 / 1001, frameCount: 121, durationSeconds: 5.05, hasAudio: true },
  target: { width: 1708, height: 960, frameCount: 121 },
  runtime: {
    id: 'realesrgan-ncnn-vulkan', supported: true, installed: true, verified: true, reason: null,
    model: { id: 'realesrgan-x4plus', label: 'Real-ESRGAN x4plus (general footage)', nativeScale: 4 },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.planUpscaleHistoryItem.mockResolvedValue(READY_PLAN);
  mocks.getHistoryItem.mockResolvedValue({ id: SOURCE_ID, filename: `${SOURCE_ID}.mp4`, prompt: 'Example clip' });
  mocks.enqueueJob.mockResolvedValue({ jobId: 'job-1', position: 1, status: 'queued' });
});

afterAll(cleanupTempDataRoots);

it('publishes the selected attribution, measured duration and timing through the Real-ESRGAN worker', async () => {
  const item = { id: SOURCE_ID, filename: 'source.mp4', musicVideo: { projectId: 'mv-source', sceneId: 'shot-source' } };
  await mkdir(PATHS.videos, { recursive: true });
  await writeFile(join(PATHS.videos, item.filename), 'fixture');
  mocks.getHistoryItem.mockResolvedValue(item);
  let history = [item];
  mocks.mutateVideoHistory.mockImplementation(async mutate => { history = mutate(history); });

  await enqueueRealesrganUpscale(SOURCE_ID, { musicVideoProjectId: 'mv-other' });
  const { params } = mocks.enqueueJob.mock.lastCall[0];
  const result = await runVideoUpscale({ ...params, jobId: 'publication-fixture' });
  expect(result).toMatchObject({
    musicVideo: { projectId: 'mv-other' }, duration: 0.04, durationSec: 0.04,
    renderMs: expect.any(Number), renderStartedAt: expect.any(String), renderCompletedAt: expect.any(String),
  });
  expect(result.musicVideo).toEqual({ projectId: 'mv-other' });
  expect(history).toEqual([result, item]);
});

describe('enqueueRealesrganUpscale', () => {
  it('queues a local GPU video-upscale job with the selected weights and the plan geometry', async () => {
    await expect(enqueueRealesrganUpscale(SOURCE_ID, { realesrganModel: 'realesrgan-x4plus' })).resolves.toMatchObject({ jobId: 'job-1' });
    expect(mocks.planUpscaleHistoryItem).toHaveBeenCalledWith(SOURCE_ID, { method: 'realesrgan', realesrganModel: 'realesrgan-x4plus' });
    const [{ kind, params }] = mocks.enqueueJob.mock.calls[0];
    expect(kind).toBe('video-upscale');
    expect(params).toMatchObject({
      mode: 'realesrgan', upscaleMethod: 'realesrgan', historyId: SOURCE_ID, sourceFilename: `${SOURCE_ID}.mp4`,
      realesrganModel: 'realesrgan-x4plus', source: READY_PLAN.source, target: READY_PLAN.target,
      width: 1708, height: 960, numFrames: 121, prompt: 'Example clip (2× Real-ESRGAN)',
    });
    expect(params).not.toHaveProperty('musicVideo');
    // Runs on this machine's accelerator lane, never a cloud or peer lane.
    expect(mediaJobExecutionLane({ kind, mode: params.mode })).toBe('gpu');
  });

  it('attributes a Music Video shot as a final take, preserving shot-upscale selectOnComplete', async () => {
    await enqueueRealesrganUpscale(SOURCE_ID, {
      musicVideo: { projectId: 'mv-1', sceneId: 'mvs-1', tier: 'final', selectOnComplete: true },
    });
    expect(mocks.enqueueJob.mock.calls[0][0].params).toMatchObject({
      musicVideoProjectId: 'mv-1',
      musicVideo: { projectId: 'mv-1', sceneId: 'mvs-1', tier: 'final', selectOnComplete: true },
    });
    await enqueueRealesrganUpscale(SOURCE_ID, { musicVideoProjectId: 'mv-1', sceneId: 'mvs-1' });
    expect(mocks.enqueueJob.mock.calls[1][0].params.musicVideo).toEqual({ projectId: 'mv-1', sceneId: 'mvs-1', tier: 'final' });
  });

  it('inherits the source scene only within its Music Video project', async () => {
    const musicVideo = { projectId: 'mv-source', sceneId: 'shot-source' };
    mocks.getHistoryItem.mockResolvedValue({ id: SOURCE_ID, filename: `${SOURCE_ID}.mp4`, musicVideo });
    await enqueueRealesrganUpscale(SOURCE_ID);
    expect(mocks.enqueueJob.mock.lastCall[0].params).toMatchObject({
      musicVideoProjectId: 'mv-source', musicVideo: { ...musicVideo, tier: 'final' },
    });
    await enqueueRealesrganUpscale(SOURCE_ID, { musicVideoProjectId: 'mv-other' });
    expect(mocks.enqueueJob.mock.lastCall[0].params.musicVideo).toEqual({ projectId: 'mv-other', tier: 'final' });
  });

  it('refuses before queueing when the runtime is not set up, unsupported, or the source cannot be measured', async () => {
    mocks.planUpscaleHistoryItem.mockResolvedValueOnce({ ...READY_PLAN, runtime: { ...READY_PLAN.runtime, installed: false, reason: 'Real-ESRGAN (ncnn Vulkan) is not installed on this machine.' } });
    await expect(enqueueRealesrganUpscale(SOURCE_ID)).rejects.toMatchObject({ status: 400, code: 'REALESRGAN_NOT_READY', message: expect.stringMatching(/not installed/) });
    mocks.planUpscaleHistoryItem.mockResolvedValueOnce({ ...READY_PLAN, runtime: { ...READY_PLAN.runtime, supported: false, installed: false, reason: 'x86-64 only' } });
    await expect(enqueueRealesrganUpscale(SOURCE_ID)).rejects.toMatchObject({ status: 501, code: 'UNSUPPORTED_RUNTIME' });
    mocks.planUpscaleHistoryItem.mockResolvedValueOnce({ ...READY_PLAN, alreadyUpscaled: true });
    await expect(enqueueRealesrganUpscale(SOURCE_ID)).rejects.toMatchObject({ code: 'ALREADY_UPSCALED' });
    mocks.planUpscaleHistoryItem.mockResolvedValueOnce({ ...READY_PLAN, source: { ...READY_PLAN.source, fps: null } });
    await expect(enqueueRealesrganUpscale(SOURCE_ID)).rejects.toMatchObject({ code: 'UPSCALE_SOURCE_UNMEASURED' });
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
  });

  it('reports no cancel for a job it is not running', () => {
    expect(cancel('not-running')).toBe(false);
  });
});

describe('frameRateArg', () => {
  it('keeps integer rates exact and restores NTSC rates to their /1001 form', () => {
    expect(frameRateArg(24)).toBe('24');
    expect(frameRateArg(24000 / 1001)).toBe('24000/1001');
    expect(frameRateArg(30000 / 1001)).toBe('30000/1001');
    expect(frameRateArg(12.5)).toBe('12.500000');
    expect(frameRateArg(null)).toBeNull();
    expect(frameRateArg(0)).toBeNull();
  });
});
