import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enqueueJob: vi.fn(),
  getHistoryItem: vi.fn(),
  planUpscaleHistoryItem: vi.fn(),
}));
vi.mock('../mediaJobQueue/index.js', () => ({ enqueueJob: mocks.enqueueJob }));
vi.mock('./history.js', () => ({ getHistoryItem: mocks.getHistoryItem, loadHistory: vi.fn(async () => []), mutateVideoHistory: vi.fn() }));
vi.mock('./upscaleVideo.js', () => ({ planUpscaleHistoryItem: mocks.planUpscaleHistoryItem }));

const { enqueueRealesrganUpscale, frameRateArg, cancel } = await import('./realesrganUpscaleJob.js');
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

  it('attributes a Music Video shot as a final take, selecting it over its source only when asked', async () => {
    await enqueueRealesrganUpscale(SOURCE_ID, { musicVideoProjectId: 'mv-1', sceneId: 'mvs-1', selectOverSource: true });
    expect(mocks.enqueueJob.mock.calls[0][0].params).toMatchObject({
      musicVideoProjectId: 'mv-1',
      musicVideo: { projectId: 'mv-1', sceneId: 'mvs-1', tier: 'final', selectOverSource: true },
    });
    await enqueueRealesrganUpscale(SOURCE_ID, { musicVideoProjectId: 'mv-1', sceneId: 'mvs-1' });
    expect(mocks.enqueueJob.mock.calls[1][0].params.musicVideo).toEqual({ projectId: 'mv-1', sceneId: 'mvs-1', tier: 'final' });
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
