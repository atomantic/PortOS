import { EventEmitter } from 'events';
import {
  describe, it, expect, vi, beforeEach,
} from 'vitest';

const mockMediaJobEvents = new EventEmitter();
let queueJobSeq = 0;

vi.mock('../mediaJobQueue/index.js', () => ({
  enqueueJob: vi.fn(),
  cancelJob: vi.fn(async (jobId) => ({ ok: true, status: 'canceled', jobId })),
  mediaJobEvents: mockMediaJobEvents,
}));
vi.mock('./generateVideo.js', () => ({
  generateVideo: vi.fn(),
  cancel: vi.fn(() => true),
  resolveVideoModel: vi.fn(() => ({ runtime: 'ltx2', name: 'Example LTX' })),
  defaultVideoModelId: () => 'example-ltx',
}));
vi.mock('../../lib/ffmpeg.js', () => ({
  probeFrameCount: vi.fn(async () => 121),
  trimVideoFromFrame: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../../lib/fileUtils.js', () => ({
  PATHS: { videos: '/fixture/videos', images: '/fixture/images' },
  unlinkGuarded: vi.fn(async () => {}),
}));
vi.mock('./reactor.js', () => ({ generateVideo: vi.fn(), cancel: vi.fn(() => true) }));
vi.mock('./fal.js', () => ({ generateVideo: vi.fn(), cancel: vi.fn(() => true) }));
vi.mock('./frameExtraction.js', () => ({ extractLastFrame: vi.fn(async () => ({ filename: 'frame-still.png' })) }));
vi.mock('./history.js', () => ({ getHistoryItem: vi.fn(async () => ({ clipId: 'reactor-clip-1' })) }));
vi.mock('./stitchVideos.js', () => ({
  stitchVideos: vi.fn(async (videoIds, opts) => {
    if (opts.requireExactTrims && videoIds.some((id) => !Number.isInteger(opts.trims?.get(id)?.frames) || opts.trims.get(id).frames <= 0)) {
      throw new Error('Exact continuation delivery requires a measured trim plan for every chunk');
    }
    return { filename: `${opts.id}.mp4`, thumbnail: `${opts.id}-thumb.png` };
  }),
}));

const { enqueueJob, cancelJob } = await import('../mediaJobQueue/index.js');
const { generateVideo: localGenerate, resolveVideoModel } = await import('./generateVideo.js');
const { probeFrameCount, trimVideoFromFrame } = await import('../../lib/ffmpeg.js');
const { unlinkGuarded } = await import('../../lib/fileUtils.js');
const { generateVideo: reactorGenerate, cancel: reactorCancel } = await import('./reactor.js');
const { generateVideo: falGenerate, cancel: falCancel } = await import('./fal.js');
const { extractLastFrame } = await import('./frameExtraction.js');
const { getHistoryItem } = await import('./history.js');
const { stitchVideos } = await import('./stitchVideos.js');
const { videoGenEvents } = await import('./events.js');
const { listActiveRenders } = await import('../renderActivity.js');
const {
  generateContinuousVideoEpisode,
  composeEpisodeClips,
  attachEpisodeSseClient,
  listActiveContinuousVideoEpisodes,
  cancelContinuousVideoEpisode,
} = await import('./continuousVideo.js');

// Two-beat scene: a 20-word opening beat (always 'fresh'), then a second
// 20-word beat that overflows BEAT_MAX_WORDS (35) and becomes a 'continue'
// clip — mirrors the shape scriptVideoCompiler.compileScriptToClips emits.
const WORDS_20 = Array(20).fill('word').join(' ');
const scenes = [{
  sceneId: 'scene-1',
  location: 'loc1',
  lines: [
    { type: 'action', text: WORDS_20 },
    { type: 'action', text: WORDS_20 },
  ],
}];
const bible = {
  styleDescriptor: 'Style: painterly line art.',
  locations: { loc1: { descriptor: 'Location: a rain-slicked alley.' } },
  cast: {},
};

// Auto-resolve `completed` once the mocked cloud generateVideo has been invoked
// for this jobId — matches how reactor/fal emit their terminal event asynchronously.
const succeedOnce = ({ jobId }) => {
  queueMicrotask(() => videoGenEvents.emit('completed', { generationId: jobId, filename: `${jobId}.mp4` }));
  return Promise.resolve({ jobId });
};
const succeedOn = (mockFn) => mockFn.mockImplementation(succeedOnce);

// Auto-resolve `completed` / `failed` for local clips routed through mediaJobQueue.
const enqueueSucceedOnce = () => {
  const jobId = `queued-clip-${++queueJobSeq}`;
  queueMicrotask(() => mockMediaJobEvents.emit('completed', { id: jobId, status: 'completed' }));
  return Promise.resolve({ jobId, position: 1, status: 'queued' });
};
const enqueueFailOnce = (error = 'render failed') => {
  const jobId = `queued-clip-${++queueJobSeq}`;
  queueMicrotask(() => mockMediaJobEvents.emit('failed', { id: jobId, status: 'failed', error }));
  return Promise.resolve({ jobId, position: 1, status: 'queued' });
};
const succeedLocalQueue = () => enqueueJob.mockImplementation(enqueueSucceedOnce);
const failLocalQueueOnce = (error = 'render failed') => enqueueJob.mockImplementationOnce(() => enqueueFailOnce(error));

beforeEach(() => {
  vi.clearAllMocks();
  queueJobSeq = 0;
  mockMediaJobEvents.removeAllListeners();
  resolveVideoModel.mockReturnValue({ runtime: 'ltx2', name: 'Example LTX' });
  probeFrameCount.mockResolvedValue(121);
  trimVideoFromFrame.mockResolvedValue({ ok: true });
  cancelJob.mockImplementation(async (jobId) => ({ ok: true, status: 'canceled', jobId }));
});

describe('composeEpisodeClips', () => {
  it('adds the hard-cut opener and bible references to a continuing clip', () => {
    const clips = composeEpisodeClips({ scenes, bible, framings: [null, 'medium shot'] });
    expect(clips).toHaveLength(2);
    expect(clips[0].cutType).toBe('fresh');
    expect(clips[1].cutType).toBe('continue');
    expect(clips[1].prompt.startsWith('Hard cut to medium shot:')).toBe(true);
    expect(clips[1].references).toEqual([{ kind: 'locations', id: 'loc1' }]);
  });

  it('leaves a continuing clip unmarked when no framing is supplied', () => {
    const clips = composeEpisodeClips({ scenes, bible });
    expect(clips[1].framing).toBeNull();
    expect(clips[1].prompt.startsWith('Hard cut to')).toBe(false);
  });
});

describe('generateContinuousVideoEpisode', () => {
  it('short-circuits on a lint failure without generating any clip', async () => {
    const result = await generateContinuousVideoEpisode({ scenes, bible, framings: [], backend: 'local' });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('lint');
    expect(result.lint.pass).toBe(false);
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(localGenerate).not.toHaveBeenCalled();
  });

  it('routes local clips through mediaJobQueue in chain order (never direct generateVideo) and stitches them', async () => {
    succeedLocalQueue();
    const result = await generateContinuousVideoEpisode({
      scenes, bible, framings: [null, 'medium shot'], backend: 'local',
    });
    expect(result.ok).toBe(true);
    expect(localGenerate).not.toHaveBeenCalled();
    expect(enqueueJob).toHaveBeenCalledTimes(2);
    expect(enqueueJob.mock.calls[0][0]).toEqual(expect.objectContaining({
      kind: 'video',
      owner: `continuous-video:${result.jobId}`,
    }));
    // Second (continuing) clip conditions on the first clip's extracted last frame.
    expect(extractLastFrame).toHaveBeenCalledTimes(1);
    const secondCallParams = enqueueJob.mock.calls[1][0].params;
    expect(secondCallParams.sourceImagePath).toContain('frame-still.png');
    expect(secondCallParams.jobId).toBeUndefined();
    expect(stitchVideos).toHaveBeenCalledWith(
      result.clipIds,
      expect.objectContaining({ historyKey: 'chainedFrom' }),
    );
    expect(result.filename).toBe(`${result.jobId}.mp4`);
  });

  it('re-establishes a failed continuation clip fresh instead of aborting the episode', async () => {
    // clip0 (fresh) succeeds; clip1's conditioned attempt fails ONCE; the
    // unconditioned retry that follows succeeds.
    enqueueJob.mockImplementationOnce(() => enqueueSucceedOnce());
    enqueueJob.mockImplementationOnce(() => enqueueFailOnce('continuation render failed'));
    enqueueJob.mockImplementationOnce(() => enqueueSucceedOnce());
    const result = await generateContinuousVideoEpisode({
      scenes, bible, framings: [null, 'medium shot'], backend: 'local',
    });
    expect(result.ok).toBe(true);
    // clip0 (1 call) + clip1 failed attempt (1 call) + clip1 fresh retry (1 call)
    expect(enqueueJob).toHaveBeenCalledTimes(3);
    const retryParams = enqueueJob.mock.calls[2][0].params;
    expect(retryParams.sourceImagePath).toBeNull();
    expect(result.clipIds).toHaveLength(2);
  });

  it('aborts the episode when a fresh clip fails outright', async () => {
    failLocalQueueOnce('backend unavailable');
    const result = await generateContinuousVideoEpisode({
      scenes, bible, framings: [null, 'medium shot'], backend: 'local',
    });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('generation');
    expect(result.failedClipIndex).toBe(0);
    expect(stitchVideos).not.toHaveBeenCalled();
  });

  it('conditions a reactor continuation clip with continue_from_clip_id instead of a frame still', async () => {
    succeedOn(reactorGenerate);
    const result = await generateContinuousVideoEpisode({
      scenes, bible, framings: [null, 'medium shot'], backend: 'reactor',
    });
    expect(result.ok).toBe(true);
    expect(getHistoryItem).toHaveBeenCalledTimes(1);
    const secondCallArgs = reactorGenerate.mock.calls[1][0];
    expect(secondCallArgs.continueFromClipId).toBe('reactor-clip-1');
    expect(extractLastFrame).not.toHaveBeenCalled();
  });

  it('rejects an unknown backend', async () => {
    await expect(generateContinuousVideoEpisode({ scenes, bible, backend: 'bogus' }))
      .rejects.toThrow(/Unknown continuous-video backend/);
  });

  it('refuses an explicitly unavailable H3 temporal episode before any clip renders', async () => {
    resolveVideoModel.mockReturnValue({ runtime: 'minimax_h3', name: 'Example H3' });
    const jobId = 'h3-refused';
    const writes = [];
    const mockRes = { writeHead: vi.fn(), write: vi.fn((chunk) => writes.push(chunk)), end: vi.fn(), req: { on: vi.fn() } };
    const promise = generateContinuousVideoEpisode({
      scenes, bible, framings: [null, 'medium shot'],
      renderOptions: { continuityStrategy: 'window' },
      jobId,
    });
    // Synchronous job registration lets an immediate SSE attach observe the
    // terminal error frame instead of 404ing before resolveEpisodeContinuity finishes.
    expect(attachEpisodeSseClient(jobId, mockRes)).toBe(true);
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/temporal|window|hardware|comparison/i);
    expect(writes.join('')).toContain('"type":"error"');
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(localGenerate).not.toHaveBeenCalled();
    expect(extractLastFrame).not.toHaveBeenCalled();
    expect(listActiveRenders().filter((r) => r.kind === 'continuous-video')).toHaveLength(0);
  });

  it('delivers three temporal clips with bounded tail/audio cuts and exact prefix trims', async () => {
    succeedLocalQueue();
    probeFrameCount.mockResolvedValueOnce(121).mockResolvedValueOnce(142)
      .mockResolvedValueOnce(142);
    const clips = [
      { prompt: 'First', cutType: 'fresh', frames: 121, fps: 24 },
      { prompt: 'Second', cutType: 'continue', frames: 121, fps: 24 },
      { prompt: 'Third', cutType: 'continue', frames: 121, fps: 24 },
    ];
    const result = await generateContinuousVideoEpisode({
      clips, renderOptions: { continuityStrategy: 'window', contextFrames: 22 },
    });
    expect(result.ok).toBe(true);
    expect(enqueueJob.mock.calls.map(([job]) => job.params.mode)).toEqual(['text', 'extend', 'extend']);
    expect(extractLastFrame).not.toHaveBeenCalled();
    expect(trimVideoFromFrame.mock.calls.map(([, , options]) => options)).toEqual([
      { startFrame: 99, fps: 24 }, { startFrame: 120, fps: 24 },
    ]);
    const stitchOptions = stitchVideos.mock.calls[0][1];
    expect(stitchOptions.requireExactTrims).toBe(true);
    expect([...stitchOptions.trims.values()]).toEqual([
      { startFrame: 0, frames: 121 },
      { startFrame: 22, frames: 120 }, { startFrame: 22, frames: 120 },
    ]);
    expect(probeFrameCount).toHaveBeenCalledTimes(3);
    expect(stitchOptions.continuation.actualHistoryFrames).toBe(22);
    expect(unlinkGuarded.mock.calls.map(([path]) => path)).toEqual(trimVideoFromFrame.mock.calls.map(([, path]) => path));
  });

  it('measures a fresh clip after a temporal continuation without trimming its new frames', async () => {
    succeedLocalQueue();
    probeFrameCount.mockResolvedValueOnce(121).mockResolvedValueOnce(142).mockResolvedValueOnce(121);
    const result = await generateContinuousVideoEpisode({
      clips: [
        { prompt: 'First', cutType: 'fresh', frames: 121, fps: 24 },
        { prompt: 'Second', cutType: 'continue', frames: 121, fps: 24 },
        { prompt: 'Third', cutType: 'fresh', frames: 121, fps: 24 },
      ],
      renderOptions: { continuityStrategy: 'window', contextFrames: 22 },
    });
    expect(result.ok).toBe(true);
    expect(enqueueJob.mock.calls.map(([job]) => job.params.mode)).toEqual(['text', 'extend', 'text']);
    expect([...stitchVideos.mock.calls[0][1].trims.values()]).toEqual([
      { startFrame: 0, frames: 121 }, { startFrame: 22, frames: 120 }, { startFrame: 0, frames: 121 },
    ]);
    expect(probeFrameCount).toHaveBeenCalledTimes(3);
    expect(trimVideoFromFrame).toHaveBeenCalledTimes(1);
  });

  it('cleans a partially prepared temporal tail without removing completed clips or retrying fresh', async () => {
    succeedLocalQueue();
    trimVideoFromFrame.mockResolvedValueOnce({ ok: false, reason: 'fixture failure' });
    const result = await generateContinuousVideoEpisode({
      scenes, bible, framings: [null, 'medium shot'],
      renderOptions: { continuityStrategy: 'window', contextFrames: 22 },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('fixture failure');
    expect(result.clipIds).toHaveLength(1);
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    expect(stitchVideos).not.toHaveBeenCalled();
    expect(unlinkGuarded).toHaveBeenCalledExactlyOnceWith(trimVideoFromFrame.mock.calls[0][1]);
  });

  it('refuses an unmeasurable temporal source instead of using its whole clip as history', async () => {
    succeedLocalQueue();
    probeFrameCount.mockResolvedValueOnce(null);
    const result = await generateContinuousVideoEpisode({
      scenes, bible, framings: [null, 'medium shot'],
      renderOptions: { continuityStrategy: 'window' },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Cannot measure');
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    expect(trimVideoFromFrame).not.toHaveBeenCalled();
    expect(unlinkGuarded).not.toHaveBeenCalled();
  });

  it('does not retry an explicitly temporal continuation unconditioned when its render fails', async () => {
    enqueueJob.mockImplementationOnce(() => enqueueSucceedOnce())
      .mockImplementationOnce(() => enqueueFailOnce());
    const result = await generateContinuousVideoEpisode({
      scenes, bible, framings: [null, 'medium shot'],
      renderOptions: { continuityStrategy: 'window' },
    });
    expect(result.ok).toBe(false);
    expect(enqueueJob).toHaveBeenCalledTimes(2);
    expect(stitchVideos).not.toHaveBeenCalled();
    expect(unlinkGuarded).toHaveBeenCalledExactlyOnceWith(trimVideoFromFrame.mock.calls[0][1]);
  });

  it('tracks active episodes in renderActivity and clears immediately on settlement while keeping SSE replay', async () => {
    enqueueJob.mockImplementationOnce(async () => ({ jobId: 'queued-track-1', position: 1, status: 'queued' }))
      .mockImplementationOnce(() => enqueueSucceedOnce());
    const jobId = 'tracked-episode-1';
    const promise = generateContinuousVideoEpisode({
      scenes, bible, framings: [null, 'medium shot'], backend: 'local', jobId,
    });

    await vi.waitFor(() => expect(enqueueJob).toHaveBeenCalledTimes(1));
    expect(listActiveRenders()).toContainEqual(expect.objectContaining({
      kind: 'continuous-video',
      noun: 'continuous-video episode',
      to: '/video-gen?episode=1',
    }));
    expect(listActiveContinuousVideoEpisodes()).toContainEqual(expect.objectContaining({
      jobId,
      backend: 'local',
      status: 'running',
      totalClips: 2,
    }));

    mockMediaJobEvents.emit('completed', { id: 'queued-track-1', status: 'completed' });
    const result = await promise;
    expect(result.ok).toBe(true);

    // Cleared immediately on settlement (not lingering for the 5s SSE replay delay).
    expect(listActiveRenders().filter((r) => r.kind === 'continuous-video')).toHaveLength(0);
    expect(listActiveContinuousVideoEpisodes()).toEqual([]);

    // Late SSE client still receives the replayed terminal complete frame.
    const writes = [];
    const lateRes = { writeHead: vi.fn(), write: vi.fn((chunk) => writes.push(chunk)), end: vi.fn(), req: { on: vi.fn() } };
    expect(attachEpisodeSseClient(jobId, lateRes)).toBe(true);
    expect(writes.join('')).toContain('"type":"complete"');

    // Canceling an already-settled episode reports ALREADY_TERMINAL, not NOT_FOUND.
    await expect(cancelContinuousVideoEpisode(jobId)).resolves.toMatchObject({
      ok: false, code: 'ALREADY_TERMINAL', status: 'complete',
    });
  });

  it('cancels a running local episode via mediaJobQueue, cleans scratch files, and broadcasts canceled SSE', async () => {
    // Clip 0 finishes; clip 1 creates a temporal scratch file and waits in the GPU queue.
    enqueueJob
      .mockImplementationOnce(() => enqueueSucceedOnce())
      .mockImplementationOnce(async () => ({ jobId: 'queued-clip-pending', position: 2, status: 'queued' }));

    const jobId = 'cancel-local-ep';
    const writes = [];
    const mockRes = { writeHead: vi.fn(), write: vi.fn((chunk) => writes.push(chunk)), end: vi.fn(), req: { on: vi.fn() } };
    const promise = generateContinuousVideoEpisode({
      scenes, bible, framings: [null, 'medium shot'],
      backend: 'local',
      renderOptions: { continuityStrategy: 'window', contextFrames: 22 },
      jobId,
    });
    expect(attachEpisodeSseClient(jobId, mockRes)).toBe(true);

    await vi.waitFor(() => expect(enqueueJob).toHaveBeenCalledTimes(2));
    const cancelRes = await cancelContinuousVideoEpisode(jobId);
    expect(cancelRes).toEqual({ ok: true, jobId, status: 'canceling' });

    const result = await promise;
    expect(result).toMatchObject({ ok: false, canceled: true, jobId, stage: 'canceled' });
    expect(cancelJob).toHaveBeenCalledExactlyOnceWith('queued-clip-pending');
    expect(enqueueJob).toHaveBeenCalledTimes(2); // did NOT retry fresh
    expect(stitchVideos).not.toHaveBeenCalled();
    expect(unlinkGuarded).toHaveBeenCalledExactlyOnceWith(trimVideoFromFrame.mock.calls[0][1]);
    expect(writes.join('')).toContain('"type":"canceled"');
    expect(listActiveRenders().filter((r) => r.kind === 'continuous-video')).toHaveLength(0);
    expect(listActiveContinuousVideoEpisodes()).toEqual([]);
  });

  it.each([
    ['fal', falGenerate, falCancel],
    ['reactor', reactorGenerate, reactorCancel],
  ])('cancels an active %s episode, invokes backend cancel(innerJobId), and emits canceled SSE', async (backend, genMock, cancelMock) => {
    let capturedInnerId = null;
    genMock.mockImplementationOnce(async ({ jobId }) => {
      capturedInnerId = jobId;
      return { jobId };
    });

    const jobId = `cancel-${backend}-ep`;
    const writes = [];
    const mockRes = { writeHead: vi.fn(), write: vi.fn((chunk) => writes.push(chunk)), end: vi.fn(), req: { on: vi.fn() } };
    const promise = generateContinuousVideoEpisode({
      scenes, bible, framings: [null, 'medium shot'], backend, jobId,
    });
    expect(attachEpisodeSseClient(jobId, mockRes)).toBe(true);

    await vi.waitFor(() => expect(capturedInnerId).toBeTruthy());
    const cancelRes = await cancelContinuousVideoEpisode(jobId);
    expect(cancelRes).toEqual({ ok: true, jobId, status: 'canceling' });

    const result = await promise;
    expect(result).toMatchObject({ ok: false, canceled: true, jobId, stage: 'canceled' });
    expect(cancelMock).toHaveBeenCalledExactlyOnceWith(capturedInnerId);
    expect(genMock).toHaveBeenCalledTimes(1);
    expect(stitchVideos).not.toHaveBeenCalled();
    expect(writes.join('')).toContain('"type":"canceled"');
    expect(listActiveRenders().filter((r) => r.kind === 'continuous-video')).toHaveLength(0);
  });

  it('returns NOT_FOUND when canceling an unknown episode id', async () => {
    await expect(cancelContinuousVideoEpisode('missing-episode')).resolves.toMatchObject({
      ok: false, code: 'NOT_FOUND',
    });
  });

  it('registers SSE before delayed queue/backend import resolves and schedules cleanup on setup rejection', async () => {
    vi.useFakeTimers();
    try {
      vi.resetModules();
      vi.doMock('../mediaJobQueue/index.js', async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          get enqueueJob() { throw new Error('cold backend import failed'); },
          cancelJob: vi.fn(),
          mediaJobEvents: new EventEmitter(),
        };
      });
      const mod = await import('./continuousVideo.js');
      const jobId = 'delayed-setup-fail';
      const writes = [];
      const mockRes = { writeHead: vi.fn(), write: vi.fn((chunk) => writes.push(chunk)), end: vi.fn(), req: { on: vi.fn() } };

      const promise = mod.generateContinuousVideoEpisode({
        scenes, bible, framings: [null, 'medium shot'], backend: 'local', jobId,
      });

      // Must attach synchronously while dynamic module import is still pending.
      expect(mod.attachEpisodeSseClient(jobId, mockRes)).toBe(true);
      expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'Content-Type': 'text/event-stream' }));

      await vi.advanceTimersByTimeAsync(20);
      const result = await promise;
      expect(result.ok).toBe(false);
      expect(result.error).toContain('cold backend import failed');
      expect(writes.join('')).toContain('"type":"error"');
      expect(writes.join('')).toContain('cold backend import failed');

      // Late client within cleanup window receives replayed error; after delay job is evicted.
      const lateWrites = [];
      const lateRes = { writeHead: vi.fn(), write: vi.fn((chunk) => lateWrites.push(chunk)), end: vi.fn(), req: { on: vi.fn() } };
      expect(mod.attachEpisodeSseClient(jobId, lateRes)).toBe(true);
      expect(lateWrites.join('')).toContain('cold backend import failed');

      await vi.advanceTimersByTimeAsync(5000);
      expect(mockRes.end).toHaveBeenCalled();
      expect(mod.attachEpisodeSseClient(jobId, lateRes)).toBe(false);
    } finally {
      vi.useRealTimers();
      vi.resetModules();
    }
  });
});
