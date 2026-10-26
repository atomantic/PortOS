import { EventEmitter } from 'node:events';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({
  syntheticHistory: false,
  model: { id: 'example-ltx', runtime: 'ltx2', supportedModes: ['text', 'image', 'extend'], defaultFrames: 25 },
  render: vi.fn(),
  loadHistory: vi.fn(),
  probe: vi.fn(),
  trim: vi.fn(),
  unlink: vi.fn(),
  stitch: vi.fn(),
  extract: vi.fn(),
}));
// This fixture exercises delivery layout only; production H3 admission stays
// unavailable until a real paired hardware inspection establishes fidelity.
vi.mock('../../lib/videoContinuity.js', async (importOriginal) => {
  const actual = await importOriginal();
  const synthetic = (model) => fixtures.syntheticHistory && model?.runtime === 'minimax_h3';
  return {
    ...actual,
    continuationContract: (runtime) => fixtures.syntheticHistory && runtime === 'minimax_h3'
      ? { temporalContext: true, adapter: 'h3-history', historyFrames: 17, fps: 24, outputLayout: 'new-output-only' }
      : actual.continuationContract(runtime),
    continuityRequestViolation: (opts) => synthetic(opts.model) ? null : actual.continuityRequestViolation(opts),
    resolveContinuityRequest: (opts) => synthetic(opts.model)
      ? { ...actual.resolveContinuityRequest(opts), requestedStrategy: 'window', effectiveStrategy: 'window', contextFrames: 17, capability: true }
      : actual.resolveContinuityRequest(opts),
  };
});
vi.mock('../../lib/fileUtils.js', () => ({
  PATHS: { videos: '/mock/videos', images: '/mock/images' }, unlinkGuarded: fixtures.unlink,
}));
vi.mock('../../lib/ffmpeg.js', () => ({ probeFrameCount: fixtures.probe, trimVideoFromFrame: fixtures.trim }));
vi.mock('../../lib/sseUtils.js', () => ({ broadcastSse: vi.fn(), closeJobAfterDelay: vi.fn() }));
vi.mock('./history.js', () => ({ loadHistory: fixtures.loadHistory, mutateVideoHistory: vi.fn(async (update) => update([])) }));
vi.mock('./eta.js', () => ({ estimateRenderMs: vi.fn(() => null) }));
vi.mock('./renderArgs.js', () => ({ DEFAULT_NUM_FRAMES: 121, resolveVideoDimensions: () => ({ width: 320, height: 192 }) }));
vi.mock('./frameExtraction.js', () => ({ extractLastFrame: fixtures.extract }));
vi.mock('./stitchVideos.js', () => ({ stitchVideos: fixtures.stitch }));
vi.mock('./generateVideo.js', () => ({ generateVideo: fixtures.render, resolveVideoModel: () => fixtures.model, defaultVideoModelId: () => fixtures.model.id }));
vi.mock('./events.js', () => ({ videoGenEvents: new EventEmitter() }));

import { generateChainedVideo } from './chainedVideo.js';
import { videoGenEvents } from './events.js';
import { videoJobState, cancel } from './jobState.js';

const terminal = (id) => new Promise((resolve) => {
  const completed = (event) => {
    if (event.generationId !== id) return;
    detach();
    resolve({ completed: event });
  };
  const failed = (event) => {
    if (event.generationId !== id) return;
    detach();
    resolve({ failed: event });
  };
  const detach = () => {
    videoGenEvents.off('completed', completed);
    videoGenEvents.off('failed', failed);
  };
  videoGenEvents.on('completed', completed);
  videoGenEvents.on('failed', failed);
});

beforeEach(() => {
  fixtures.syntheticHistory = false;
  fixtures.model.runtime = 'ltx2';
  fixtures.loadHistory.mockReset().mockResolvedValue([]);
  fixtures.model.supportedModes = ['text', 'image', 'extend'];
  fixtures.render.mockImplementation(async ({ jobId }) => {
    queueMicrotask(() => videoGenEvents.emit('completed', { generationId: jobId }));
    return { jobId };
  });
  fixtures.probe.mockReset().mockResolvedValueOnce(25).mockResolvedValueOnce(49).mockResolvedValueOnce(49);
  fixtures.trim.mockReset().mockResolvedValue({ ok: true });
  fixtures.unlink.mockReset().mockResolvedValue(undefined);
  fixtures.stitch.mockReset().mockResolvedValue({ filename: 'example.mp4', thumbnail: 'example.jpg' });
  fixtures.extract.mockReset().mockResolvedValue({ filename: 'example-last.jpg' });
  videoJobState.jobs.clear();
  videoJobState.activeChain = null;
  videoJobState.activeProcess = null;
});

const start = async (overrides = {}) => {
  const done = terminal('example-chain');
  await generateChainedVideo({ chunks: 3, jobId: 'example-chain', modelId: fixtures.model.id, numFrames: 25, prompt: 'Example scene', ...overrides });
  return done;
};

describe('bounded chain delivery', () => {
  it('delivers all new frames once across three chunks and measures bounded matching audio intervals', async () => {
    expect((await start()).completed).toBeDefined();
    const renders = fixtures.render.mock.calls.map(([params]) => params);
    const [ids, options] = fixtures.stitch.mock.calls[0];
    expect(renders.map(({ mode }) => mode)).toEqual(['text', 'extend', 'extend']);
    expect(fixtures.trim.mock.calls.map(([from, to, opts]) => ({ from: basename(from), to: basename(to), ...opts })))
      .toEqual([
        { from: `${ids[0]}.mp4`, to: `chaincontext-${ids[0]}.mp4`, startFrame: 3, fps: 24 },
        { from: `${ids[1]}.mp4`, to: `chaincontext-${ids[1]}.mp4`, startFrame: 27, fps: 24 },
      ]);
    expect(renders.slice(1).map(({ extendFromVideoPath }) => extendFromVideoPath))
      .toEqual(ids.slice(0, 2).map((id) => join(tmpdir(), `chaincontext-${id}.mp4`)));
    expect([...options.trims.values()]).toEqual([
      { startFrame: 0, frames: 25 }, { startFrame: 25, frames: 24 }, { startFrame: 25, frames: 24 },
    ]);
    // Synthetic frame labels pin the timeline, including both seam endpoints.
    const inputs = [Array.from({ length: 25 }, (_, i) => i), [...Array(25).fill('history'), ...Array.from({ length: 24 }, (_, i) => 25 + i)], [...Array(25).fill('history'), ...Array.from({ length: 24 }, (_, i) => 49 + i)]];
    const timeline = inputs.flatMap((frames, i) => frames.slice(options.trims.get(ids[i]).startFrame));
    expect(timeline).toEqual(Array.from({ length: 73 }, (_, i) => i));
    expect(options.requireExactTrims).toBe(true);
    expect(options.continuation.hops.map(({ actualHistoryFrames, startFrame, endFrameExclusive, audioStartSec, audioEndSec }) => ({ actualHistoryFrames, startFrame, endFrameExclusive, audioStartSec, audioEndSec })))
      .toEqual([
        { actualHistoryFrames: 22, startFrame: 3, endFrameExclusive: 25, audioStartSec: 3 / 24, audioEndSec: 25 / 24 },
        { actualHistoryFrames: 22, startFrame: 27, endFrameExclusive: 49, audioStartSec: 27 / 24, audioEndSec: 49 / 24 },
      ]);
    expect(fixtures.unlink.mock.calls.map(([path]) => path)).toEqual(ids.slice(0, 2).map((id) => join(tmpdir(), `chaincontext-${id}.mp4`)));
  });

  it('routes a new-output-only history layout from each original chunk without reencoding or trimming its new frames', async () => {
    fixtures.syntheticHistory = true;
    fixtures.model.runtime = 'minimax_h3';
    fixtures.probe.mockReset().mockResolvedValue(33);
    expect((await start({ continuityStrategy: 'window', contextFrames: 17 })).completed).toBeDefined();
    const renders = fixtures.render.mock.calls.map(([params]) => params);
    const [ids, options] = fixtures.stitch.mock.calls[0];
    expect(renders.map(({ mode }) => mode)).toEqual(['text', 'text', 'text']);
    expect(renders.slice(1).map(({ historyContext }) => historyContext)).toEqual(ids.slice(0, 2).map((id) => ({
      sourceVideoPath: join('/mock/videos', `${id}.mp4`), endFrame: 33, frames: 17,
    })));
    expect(renders.slice(1).every(({ sourceImagePath, extendFromVideoPath }) => sourceImagePath === null && extendFromVideoPath === null)).toBe(true);
    expect([...options.trims.values()]).toEqual(Array(3).fill({ startFrame: 0, frames: 33 }));
    expect(options.continuation.hops.map(({ actualHistoryFrames, audioStartSec, audioEndSec }) => ({ actualHistoryFrames, audioStartSec, audioEndSec })))
      .toEqual(Array(2).fill({ actualHistoryFrames: 17, audioStartSec: 16 / 24, audioEndSec: 33 / 24 }));
    expect(fixtures.trim).not.toHaveBeenCalled();
    expect(fixtures.extract).not.toHaveBeenCalled();
    expect(fixtures.unlink).not.toHaveBeenCalled();
  });

  it('clears preparation state when history loading fails before the first chunk', async () => {
    fixtures.loadHistory.mockRejectedValueOnce(new Error('example history read failure'));
    await expect(generateChainedVideo({ chunks: 3, jobId: 'example-unstarted-chain' })).rejects.toThrow('example history read failure');
    expect(videoJobState.activeChain).toBeNull();
    expect(videoJobState.jobs.has('example-unstarted-chain')).toBe(false);
    expect(fixtures.render).not.toHaveBeenCalled();
  });

  it('refuses an unmeasurable length before creating an unbounded context or another render', async () => {
    fixtures.probe.mockReset().mockResolvedValue(null);
    expect((await start()).failed.error).toMatch(/refusing unbounded/);
    expect(fixtures.render).toHaveBeenCalledTimes(1);
    expect(fixtures.trim).not.toHaveBeenCalled();
    expect(fixtures.stitch).not.toHaveBeenCalled();
    expect(fixtures.unlink).not.toHaveBeenCalled();
  });

  it('cleans a partially created owned history slice on preparation failure while retaining completed source clips', async () => {
    fixtures.trim.mockResolvedValue({ ok: false, reason: 'example encoder failure' });
    expect((await start()).failed.error).toMatch(/example encoder failure/);
    const [[, scratch]] = fixtures.trim.mock.calls;
    expect(fixtures.unlink).toHaveBeenCalledExactlyOnceWith(scratch);
    expect(fixtures.render).toHaveBeenCalledTimes(1);
    expect(fixtures.stitch).not.toHaveBeenCalled();
  });

  it('stops after cancellation during history preparation and removes only owned scratch', async () => {
    fixtures.trim.mockImplementation(async () => {
      expect(cancel()).toBe(true);
      return { ok: true };
    });
    let releaseCleanup;
    let observeCleanup;
    const cleaning = new Promise((resolve) => { observeCleanup = resolve; });
    const cleaned = new Promise((resolve) => { releaseCleanup = resolve; });
    fixtures.unlink.mockImplementation(() => { observeCleanup(); return cleaned; });
    let terminalReported = false;
    const done = start().then((result) => { terminalReported = true; return result; });
    await cleaning;
    expect(terminalReported).toBe(false);
    releaseCleanup();
    expect((await done).failed.error).toMatch(/Canceled/);
    expect(fixtures.render).toHaveBeenCalledTimes(1);
    expect(fixtures.stitch).not.toHaveBeenCalled();
    expect(fixtures.unlink).toHaveBeenCalledExactlyOnceWith(fixtures.trim.mock.calls[0][1]);
  });

  it('refuses explicit H3 windows before any chunk and preserves the legacy last-frame default', async () => {
    fixtures.model.runtime = 'minimax_h3';
    await expect(generateChainedVideo({ chunks: 3, jobId: 'example-refused', continuityStrategy: 'window' })).rejects.toMatchObject({ code: 'VIDEO_TEMPORAL_UNAVAILABLE' });
    expect(fixtures.render).not.toHaveBeenCalled();
    expect((await start()).completed).toBeDefined();
    expect(fixtures.render.mock.calls.map(([params]) => params.mode)).toEqual(['text', 'image', 'image']);
    expect(fixtures.probe).not.toHaveBeenCalled();
    expect(fixtures.extract).toHaveBeenCalledTimes(2);
    expect(fixtures.stitch.mock.calls[0][1].continuation).toMatchObject({ requestedStrategy: 'auto', effectiveStrategy: 'frame', actualHistoryFrames: 0 });
  });

  it('passes cancellation into an in-progress stitch and never reports a canceled result as completed', async () => {
    fixtures.stitch.mockImplementation(async (_ids, options) => {
      cancel();
      expect(options.signal.aborted).toBe(true);
      throw new Error('Stitch canceled');
    });
    expect((await start()).failed.error).toMatch(/Stitch canceled/);
    expect(fixtures.unlink).toHaveBeenCalledTimes(2);
  });
});
