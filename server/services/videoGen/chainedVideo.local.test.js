/**
 * chainedVideo.local.test.js
 *
 * Split from local.test.js (#16214); shared mocks live in local.testFixtures.js.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Stateless helper, safe to import statically (it reads the current mock registry).
import { waitForStitch } from './local.testFixtures.js';

// vi.mock factories are hoisted above imports; the shared fixtures module is
// loaded the same way so its state objects outlive vi.resetModules().
const fx = await vi.hoisted(() => import('./local.testFixtures.js'));
const { MOCK_PATHS, fsState, anchorPick, makeProc } = fx;

vi.mock('os', async (importOriginal) => fx.osFactory(importOriginal));
vi.mock('../../lib/heavyJobClaim.js', () => fx.heavyJobClaimFactory());
vi.mock('../localMemory.js', async (importOriginal) => fx.localMemoryFactory(importOriginal));
vi.mock('../../lib/fileUtils.js', () => fx.fileUtilsFactory());
vi.mock('../settings.js', () => fx.settingsFactory());
vi.mock('../../lib/mediaModels.js', async () => fx.mediaModelsFactory());
vi.mock('../../lib/sseUtils.js', () => fx.sseUtilsFactory());
vi.mock('../../lib/ffmpeg.js', async () => fx.ffmpegFactory());
vi.mock('./extendSplice.js', () => fx.extendSpliceFactory());
vi.mock('../../lib/lipsyncAlign.js', () => fx.lipsyncAlignFactory());
vi.mock('../hfToken.js', () => fx.hfTokenFactory());
vi.mock('../../lib/hfCache.js', async (original) => fx.hfCacheFactory(original));
vi.mock('fs', () => fx.fsFactory());
vi.mock('../../lib/frameQuality.js', async (importOriginal) => fx.frameQualityFactory(importOriginal));
vi.mock('./runtimes.js', async (importOriginal) => fx.runtimesFactory(importOriginal));
vi.mock('../loras.js', () => fx.lorasFactory());
vi.mock('../loraEffectProbe.js', () => fx.loraEffectProbeFactory());
vi.mock('./ensureWeights.js', async (importOriginal) => fx.ensureWeightsFactory(importOriginal));
vi.mock('../../lib/childProcess.js', () => fx.childProcessFactory());
vi.mock('../../lib/detachedSpawn.js', () => fx.detachedSpawnFactory());
vi.mock('fs/promises', () => fx.fsPromisesMock);

// ─── module under test ───────────────────────────────────────────────────────
let generateChainedVideo;
let videoGenEvents;

beforeEach(async () => {
  vi.resetModules();
  fx.resetFsPromisesReadFile();
  ({ generateChainedVideo } = await import('./local.js'));
  ({ videoGenEvents } = await import('./events.js'));
});

afterEach(async () => {
  await fx.resetSharedMocks();
});

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Run generateChainedVideo and collect the `params` object each inner
 * generateVideo receives (via videoGenEvents 'started'). After 'started'
 * fires for every chunk, fire a 'completed' event for each inner job so the
 * chain progresses.
 *
 * Returns the array of per-chunk params in call order.
 */
async function _runChainAndCaptureArgs(chainParams, totalChunks) {
  const captured = [];
  const innerJobIds = [];

  videoGenEvents.on('started', (e) => {
    // generateVideo emits 'started' immediately after spawn — capture the
    // generationId so we can fire 'completed' for it.
    innerJobIds.push(e.generationId);
    captured.push(e);
  });

  // Start the chain (non-blocking — returns synchronously with a descriptor)
  const outerJobId = randomUUID();
  generateChainedVideo({
    ...chainParams,
    chunks: totalChunks,
    jobId: outerJobId,
    pythonPath: '/usr/bin/python3',
    modelId: 'ltx2_unified',
    prompt: 'test prompt',
    width: 512,
    height: 512,
    numFrames: 25,
    fps: 24,
  });

  // Drive the chain forward: wait for each chunk to emit 'started', then
  // immediately emit 'completed' for it so the orchestrator advances.
  for (let i = 0; i < totalChunks; i++) {
    await new Promise((resolve) => {
      const check = () => {
        if (innerJobIds.length > i) { resolve(); return; }
        setTimeout(check, 10);
      };
      check();
    });
    const id = innerJobIds[i];
    videoGenEvents.emit('completed', { generationId: id, filename: `${id}.mp4`, path: `/data/videos/${id}.mp4` });
  }

  // Wait for the outer chain to settle (stitch call or finishOk)
  await new Promise((resolve) => {
    const check = () => {
      if (captured.length >= totalChunks) { resolve(); return; }
      setTimeout(check, 10);
    };
    check();
  });
  // Give the async chain loop one more tick to finish and set currentExtendFromVideo
  await new Promise((r) => setTimeout(r, 50));

  videoGenEvents.removeAllListeners('started');
  return captured;
}

describe('generateChainedVideo — model-aware ETA geometry', () => {
  it('estimates an omitted H3 canvas at the model native default', async () => {
    const { readJSONFile } = await import('../../lib/fileUtils.js');
    vi.mocked(readJSONFile).mockResolvedValue([{
      modelId: 'minimax_h3_8bit',
      width: 1344,
      height: 768,
      numFrames: 124,
      steps: 8,
      renderMs: 10_000,
      createdAt: '2026-01-01T00:00:00.000Z',
    }]);
    const outerJobId = randomUUID();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let onCompleted;
    let onFailed;
    const settled = new Promise((resolve) => {
      onCompleted = (event) => {
        if (event.generationId === outerJobId) resolve({ status: 'completed' });
      };
      onFailed = (event) => {
        if (event.generationId === outerJobId) resolve({ status: 'failed', error: event.error });
      };
      videoGenEvents.on('completed', onCompleted);
      videoGenEvents.on('failed', onFailed);
    });

    try {
      await generateChainedVideo({
        chunks: 2,
        jobId: outerJobId,
        pythonPath: '/usr/bin/python3',
        modelId: 'minimax_h3_8bit',
        prompt: 'test prompt',
        mode: 'text',
      });
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('2 chunks, eta=20s (measured, n=1)'));
      // Await the terminal event under the test's own deadline. vi.waitFor's
      // separate one-second deadline can expire before the chain finishes.
      expect(await settled).toEqual({ status: 'completed' });
    } finally {
      videoGenEvents.off('completed', onCompleted);
      videoGenEvents.off('failed', onFailed);
      logSpy.mockRestore();
    }
  });
});

describe('generateChainedVideo — continuation strategy (context window vs last frame)', () => {
  // numFrames=25 → extendLatentFrames(25) = 3 latents = 24 new pixel frames.
  //
  // The probe is mocked to the lengths a real chain produces, NOT to the
  // rendered numFrames: chunk 0 is a plain 25-frame text render, but a windowed
  // hop returns `context + extension`, so its FILE is 49 frames — 24 new ones
  // behind a 25-frame echo of the window it was conditioned on. That gap is the
  // whole reason the stitch can't fall back on a chunk's own history
  // `numFrames`, and mocking both at 25 would hide it.
  const CHUNK_FRAMES = 25;
  const HOP_FILE_FRAMES = 49;
  const EXPECTED_EXTEND_LATENTS = 3;
  // 49 − 24 new frames = a 25-frame echo to drop.
  const EXPECTED_PREFIX_START = 25;
  // The 22-frame window off chunk 0 (25 − 22) and off a hop (49 − 22).
  const WINDOW_START_FIRST = 3;
  const WINDOW_START_HOP = 27;
  // 25 + (49−25) + (49−25) once the echoes come out of the timeline…
  const STITCHED_FRAMES_3_CHUNKS = 73;

  const flagValue = (args, flag) => (Array.isArray(args) && args.includes(flag)
    ? args[args.indexOf(flag) + 1] : null);

  /**
   * Drive a chain and return everything the continuation path touches: the
   * argv of each chunk's render child, every trim the orchestrator asked for,
   * and the raw child_process spawns (which is where both extractLastFrame's
   * `-sseof` seek and the final concat show up).
   */
  async function runChain(chainParams, totalChunks, probeFrames = null, expectFailure = false) {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const { trimVideoFromFrame, probeFrameCount } = await import('../../lib/ffmpeg.js');
    const { spawn } = await import('../../lib/childProcess.js');
    const { readJSONFile, atomicWrite } = await import('../../lib/fileUtils.js');
    vi.mocked(spawnDetached).mockClear();
    vi.mocked(trimVideoFromFrame).mockClear();
    vi.mocked(probeFrameCount).mockClear();
    vi.mocked(spawn).mockClear();
    vi.mocked(atomicWrite).mockClear();
    // Chunk 0 is a plain render; every hop after it comes back as
    // `context + extension`. The orchestrator probes each chunk exactly once,
    // in order, so the call index is the chunk index. `probeFrames` overrides
    // the sequence for chains whose chunk 0 isn't a plain render either.
    let probeCall = 0;
    vi.mocked(probeFrameCount).mockImplementation(async () => {
      const i = probeCall++;
      return probeFrames ? probeFrames[Math.min(i, probeFrames.length - 1)] : (i === 0 ? CHUNK_FRAMES : HOP_FILE_FRAMES);
    });

    // extractLastFrame and stitchVideos both look their inputs up in history;
    // feed the chunk ids back as they start so the chain can advance. The
    // geometry matters: stitchVideos reads the canonical width/height/fps for
    // its filter graph off the first entry, and sums numFrames for the
    // stitched record.
    const innerJobIds = [];
    vi.mocked(readJSONFile).mockImplementation(async () =>
      innerJobIds.map((id) => ({ id, filename: `${id}.mp4`, width: 512, height: 512, fps: 24, numFrames: CHUNK_FRAMES })),
    );
    videoGenEvents.on('started', (e) => innerJobIds.push(e.generationId));

    const outerJobId = randomUUID();
    const failed = expectFailure ? new Promise((resolve) => {
      const listener = (event) => {
        if (event.generationId !== outerJobId) return;
        videoGenEvents.off('failed', listener);
        resolve(event);
      };
      videoGenEvents.on('failed', listener);
    }) : null;
    generateChainedVideo({
      chunks: totalChunks,
      jobId: outerJobId,
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'test prompt',
      width: 512,
      height: 512,
      numFrames: CHUNK_FRAMES,
      fps: 24,
      mode: 'text',
      sourceImagePath: null,
      extendFromVideoPath: null,
      lastImagePath: null,
      ...chainParams,
    });

    for (let i = 0; i < totalChunks; i++) {
      await new Promise((resolve) => {
        const check = () => {
          if (innerJobIds.length > i) { resolve(); return; }
          setTimeout(check, 10);
        };
        check();
      });
      const id = innerJobIds[i];
      videoGenEvents.emit('completed', { generationId: id, filename: `${id}.mp4`, path: `/data/videos/${id}.mp4` });
    }
    if (failed) await failed;
    else await waitForStitch();
    videoGenEvents.removeAllListeners('started');

    const spawns = vi.mocked(spawn).mock.calls;
    return {
      innerJobIds,
      renders: vi.mocked(spawnDetached).mock.calls.map(([, args]) => args),
      trims: vi.mocked(trimVideoFromFrame).mock.calls,
      spawns,
      // The one ffmpeg run that assembles the timeline — either a concat
      // demuxer invocation or the trim-bearing filter graph that replaces it.
      concat: (spawns.find(([, args]) => Array.isArray(args)
        && (args.includes('concat') || args.some((a) => typeof a === 'string' && a.includes('concat=n=')))) || [])[1] || null,
      // The stitched history entry, read off the history write it triggers.
      stitched: vi.mocked(atomicWrite).mock.calls
        .flatMap(([, payload]) => (Array.isArray(payload) ? payload : []))
        .find((entry) => entry?.chainedFrom) || null,
    };
  }

  it('chains an ltx2 text render as extend hops conditioned on the prior chunk tail, not on a still', async () => {
    const { innerJobIds, renders, spawns } = await runChain({}, 3);

    expect(renders).toHaveLength(3);
    // Chunk 0 keeps the mode the user asked for.
    expect(flagValue(renders[0], '--mode')).toBe('text');
    // Chunks 1+ re-enter as extend renders reading the tail clip cut from the
    // chunk before them — a text chain now inherits motion across the seam
    // exactly the way an explicit extend chain does.
    for (const i of [1, 2]) {
      expect(flagValue(renders[i], '--mode')).toBe('extend');
      expect(flagValue(renders[i], '--extend-from-video'))
        .toBe(join(tmpdir(), `chaincontext-${innerJobIds[i - 1]}.mp4`));
      expect(flagValue(renders[i], '--extend-frames')).toBe(String(EXPECTED_EXTEND_LATENTS));
    }
    // The window replaces last-frame extraction entirely — no `-sseof` seek.
    expect(spawns.filter(([, args]) => Array.isArray(args) && args.includes('-sseof'))).toHaveLength(0);
  });

  it('cuts the echoed context out of the timeline in the stitch, not out of the chunk files', async () => {
    // extend_from_video returns `source + extension`, so every hop after the
    // first opens with a replay of its conditioning window. Left in, the
    // stitched clip repeats ~1s of footage at every seam. Cutting it in the
    // concat's own filter graph costs nothing on top of the timeline encode
    // that a trimmed concat needs anyway, where pre-trimming each chunk file
    // would add a whole x264 pass per hop AND grade the trimmed chunks
    // differently from the untrimmed chunk 0.
    const { innerJobIds, trims, concat, stitched } = await runChain({}, 3);

    const chunkPath = (i) => join(MOCK_PATHS.videos, `${innerJobIds[i]}.mp4`);

    // No chunk file is rewritten — the archived per-chunk entries stay exactly
    // what the model rendered.
    expect(trims.some(([from, to]) => from === to)).toBe(false);
    for (const i of [0, 1, 2]) {
      expect(trims.some(([, to]) => to === chunkPath(i))).toBe(false);
    }

    // Instead the offsets ride in the concat graph: chunk 0 whole, chunks 1+
    // starting after their echoed prefix.
    const graph = concat[concat.indexOf('-filter_complex') + 1];
    expect(graph).toContain('[0:v]');
    expect(graph).not.toMatch(/\[0:v\][^;]*trim=start_frame/);
    for (const i of [1, 2]) {
      expect(graph).toMatch(new RegExp(`\\[${i}:v\\][^;]*trim=start_frame=${EXPECTED_PREFIX_START}`));
    }
    // All three legs join in one concat, whose output is then BT.709-tagged so
    // the stitched timeline doesn't decode washed-out (#3800).
    expect(graph).toContain('concat=n=3:v=1:a=0[cv]');
    expect(graph).toContain('[cv]setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709[outv]');
    expect(concat).toContain('-color_primaries');
    // And the stitched record reports the timeline that exists, not the sum of
    // what each chunk was rendered at.
    expect(stitched?.numFrames).toBe(STITCHED_FRAMES_3_CHUNKS);

    // Each hop's conditioning window is still cut from the tail into tmpdir.
    const windowStart = (i) => trims
      .find(([from, to]) => from === chunkPath(i) && to === join(tmpdir(), `chaincontext-${innerJobIds[i]}.mp4`))?.[2]?.startFrame;
    expect(windowStart(0)).toBe(WINDOW_START_FIRST);
    expect(windowStart(1)).toBe(WINDOW_START_HOP);
  });

  it('runs no whole-chunk encode pass — the timeline encode is the only one', async () => {
    // The whole point: (N−1) whole-chunk encodes + 1 timeline encode collapses
    // to just the timeline encode. (The per-hop conditioning-window cut is
    // still an encode, but of ~22 frames, and it goes through the mocked
    // trimVideoFromFrame rather than spawn — the sibling test above is what
    // pins that it never touches a chunk file.)
    const { spawns, concat } = await runChain({}, 3);
    const encodes = spawns.filter(([, args]) => Array.isArray(args) && args.includes('libx264'));
    expect(encodes).toHaveLength(1);
    expect(encodes[0][1]).toBe(concat);
    // A trim-bearing concat can't stream-copy, and it can't use the demuxer
    // either — the demuxer has no way to express a per-input offset.
    expect(concat.join(' ')).not.toContain('-c copy');
    expect(concat).not.toContain('-f');
  });

  it('refuses a repeated-context salvage when the required exact trim fails', async () => {
    // Completed chunks remain available, but a failed seam trim cannot publish
    // a stitched clip that repeats history while claiming exact delivery.
    const { spawn } = await import('../../lib/childProcess.js');
    const failingProc = () => {
      const listeners = {};
      const proc = {
        pid: 12345,
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on(event, fn) { listeners[event] = fn; return proc; },
        off(event, fn) { if (listeners[event] === fn) delete listeners[event]; return proc; },
        kill: vi.fn(),
      };
      setImmediate(() => listeners.close?.(1, null));
      return proc;
    };
    vi.mocked(spawn).mockImplementation((_bin, args) => (
      Array.isArray(args) && args.includes('-filter_complex') ? failingProc() : makeProc()
    ));
    try {
      const { spawns, stitched } = await runChain({}, 3, null, true);
      const concats = spawns.map(([, args]) => args).filter(Array.isArray);
      expect(concats.some((args) => args.includes('-filter_complex'))).toBe(true);
      expect(concats.some((args) => args.includes('-f') && args.includes('copy'))).toBe(false);
      expect(stitched).toBeNull();
    } finally {
      vi.mocked(spawn).mockImplementation(() => makeProc());
    }
  });

  it('keeps the graph video-only when the chunks carry no audio stream', async () => {
    // Referencing `[k:a]` against a silent input aborts the whole ffmpeg run,
    // and AI renders are silent unless the model generated a soundtrack.
    const { concat } = await runChain({}, 2);
    expect(concat.join(' ')).not.toContain(':a]');
    expect(concat).toContain('-an');
  });

  it('probes each chunk once rather than re-reading it after the trim', async () => {
    // probeFrameCount falls back to a full -count_frames decode when the
    // container header carries no nb_frames, so a redundant probe per hop can
    // cost an entire extra decode of the clip.
    const { probeFrameCount } = await import('../../lib/ffmpeg.js');
    const { innerJobIds } = await runChain({}, 3);
    expect(vi.mocked(probeFrameCount).mock.calls).toHaveLength(innerJobIds.length);
  });

  it('honors a smaller context window', async () => {
    // 8 frames instead of the 22-frame default → the window starts 8 back.
    const { innerJobIds, trims } = await runChain({ contextFrames: 8 }, 2);
    const cut = trims.find(([, to]) => to === join(tmpdir(), `chaincontext-${innerJobIds[0]}.mp4`));
    expect(cut[2]).toMatchObject({ startFrame: CHUNK_FRAMES - 8 });
  });

  it('measures the untrimmed first chunk too, instead of trusting the count it was rendered at', async () => {
    // In an extend chain chunk 0's output is `user clip + extension`, so its
    // file is far longer than the numFrames its history entry records — and
    // nothing trims it, so no cut forces a measurement. It still has to be
    // measured, or the stitched entry's duration is short by the whole source
    // clip and a Remix off it re-renders at the wrong length.
    const FIRST_FILE_FRAMES = 60;
    const { stitched } = await runChain({
      mode: 'extend',
      extendFromVideoPath: join(MOCK_PATHS.videos, 'original-video.mp4'),
    }, 2, [FIRST_FILE_FRAMES, HOP_FILE_FRAMES]);
    // 60 whole + (49 − 25) after the hop's echo comes out.
    expect(stitched?.numFrames).toBe(FIRST_FILE_FRAMES + (HOP_FILE_FRAMES - EXPECTED_PREFIX_START));
  });

  it('resolves the default frame count before sizing the echo, like the render does', async () => {
    // numFrames is optional on the route, and generateVideo falls back to
    // DEFAULT_NUM_FRAMES (121 → 15 latents → 120 new pixel frames) before it
    // derives --extend-frames. The orchestrator has to fall back identically:
    // reading the raw request instead makes it assume a 1-latent, 8-frame
    // extension, so it would call all but 8 frames of every hop "echo" and
    // cut the hop's actual footage out of the timeline.
    const DEFAULT_HOP_FILE_FRAMES = 145; // a 25-frame echo + 120 new frames
    const { renders, concat } = await runChain({ numFrames: undefined }, 2, [121, DEFAULT_HOP_FILE_FRAMES]);
    expect(flagValue(renders[1], '--extend-frames')).toBe('15');
    const graph = concat[concat.indexOf('-filter_complex') + 1];
    expect(graph).toMatch(/\[1:v\]trim=start_frame=25,/);
  });

  it('never conditions the next hop on the echo the stitch is about to drop', async () => {
    // A window bigger than the chunk's own new footage (121 requested vs 24
    // rendered) clamps to the start of the file — which, now that the file
    // still holds its echoed prefix, would hand the next hop a replay of the
    // chunk BEFORE it. The window start floors at the prefix instead.
    const { innerJobIds, trims } = await runChain({ contextFrames: 121 }, 3);
    const windowStart = (i) => trims
      .find(([, to]) => to === join(tmpdir(), `chaincontext-${innerJobIds[i]}.mp4`))?.[2]?.startFrame;
    // Chunk 0 has no echo, so its whole render is fair game as a window.
    expect(windowStart(0)).toBe(0);
    expect(windowStart(1)).toBe(EXPECTED_PREFIX_START);
  });

  it('contextFrames: 0 opts back into last-frame chaining', async () => {
    // 0 is a real value, distinct from "unset" — it's how a user gets the
    // historical single-still hop back on a runtime that could do better.
    const { renders, trims, concat } = await runChain({ contextFrames: 0 }, 2);

    expect(flagValue(renders[1], '--mode')).toBe('image');
    expect(flagValue(renders[1], '--extend-from-video')).toBeNull();
    // No offsets to apply, so the concat keeps the demuxer stream-copy fast
    // path — the same one the hand-stitch from Media History takes.
    expect(trims).toHaveLength(0);
    expect(concat).toContain('copy');
    expect(concat).not.toContain('-filter_complex');
  });

  it('falls back to last-frame chaining on a runtime with no extend pipeline', async () => {
    // mlx_video has no extend_from_video, so the window is silently ignored
    // rather than rejected — switching models mid-form can't strand a request.
    const { renders, trims } = await runChain({ modelId: 'ltx23_unified', contextFrames: 22 }, 2);

    expect(flagValue(renders[1], '--mode')).not.toBe('extend');
    expect(trims).toHaveLength(0);
  });

  it('seeds an extend chain from the last frame on a runtime that cannot take a source video', async () => {
    // mlx_video offers an Extend *mode* but implements it as last-frame i2v —
    // buildArgs never forwards extendFromVideoPath to its builder. Chunks 2+
    // used to be handed that path with no source image, so the path was dropped
    // and they rendered from the prompt alone, ignoring the clip they were
    // meant to continue. They must fall back to the frame hop instead.
    const sourceVideoPath = join(MOCK_PATHS.videos, 'original-video.mp4');
    const { renders } = await runChain({
      modelId: 'ltx23_unified',
      mode: 'extend',
      extendFromVideoPath: sourceVideoPath,
    }, 2);

    expect(flagValue(renders[1], '--mode')).not.toBe('extend');
    // The source video never reaches this runtime's argv — it has no flag for
    // one. That silent drop is what left chunk 1 with nothing to continue from.
    expect(renders[0]).not.toContain(sourceVideoPath);
    expect(renders[1]).not.toContain(sourceVideoPath);
    // So chunk 1 must be given a still instead. Chunk 0 legitimately has none
    // (its conditioning was the dropped video), which is the contrast that
    // shows the frame is being supplied for chunk 1 specifically rather than
    // just inherited. The value is a tmpdir path — generateVideo resizes the
    // frame to the model resolution first — so assert presence, not location.
    expect(flagValue(renders[0], '--image')).toBeNull();
    expect(flagValue(renders[1], '--image')).toBeTruthy();
  });

  it.each([
    ['a scored anchor', { path: join(tmpdir(), 'cand-006.png'), index: 5, focus: 0.7, quality: 0.7, score: 0.8, usable: true }],
    ['the end-seek fallback', null],
  ])('stages a continuation still for the next frame-hop chunk via %s', async (_label, best) => {
    // The hop must survive BOTH anchor outcomes. A scoring failure degrades to
    // the old single-seek behavior — it must never leave chunk 1 with no image,
    // which would render it from the prompt alone and break the chain.
    anchorPick.best = best;
    // One hop → one anchor cache check; miss it so extraction actually runs.
    fsState.missOnce = ['anchor-'];
    const { copyFile } = await import('fs/promises');
    vi.mocked(copyFile).mockClear();

    const { renders, innerJobIds } = await runChain({
      modelId: 'ltx23_unified',
      mode: 'extend',
      extendFromVideoPath: join(MOCK_PATHS.videos, 'original-video.mp4'),
    }, 2);

    expect(flagValue(renders[1], '--image')).toBeTruthy();
    // A scored winner is copied into place under the new cache name; the
    // fallback lets ffmpeg write that path directly, so there is no install.
    const installedAnchor = vi.mocked(copyFile).mock.calls
      .some(([, dest]) => dest === join(MOCK_PATHS.images, `anchor-${innerJobIds[0]}.png`));
    expect(installedAnchor).toBe(!!best);
  });

  it('keeps the first chunk of an extend chain whole, conditioned on the user source clip', async () => {
    // In an extend chain chunk 0's output is `user clip + extension`, and the
    // user clip belongs in the result exactly once — here. Trimming it would
    // drop the very footage the user asked to extend.
    const sourceVideoPath = join(MOCK_PATHS.videos, 'original-video.mp4');
    const { innerJobIds, renders, trims } = await runChain({
      mode: 'extend',
      extendFromVideoPath: sourceVideoPath,
    }, 2);

    expect(flagValue(renders[0], '--mode')).toBe('extend');
    expect(flagValue(renders[0], '--extend-from-video')).toBe(sourceVideoPath);
    expect(trims.some(([, to]) => to === join(MOCK_PATHS.videos, `${innerJobIds[0]}.mp4`))).toBe(false);
    // Chunk 1 conditions on a bounded window, NOT on chunk 0's whole output —
    // that's what kept the chain from growing a copy of itself per hop.
    expect(flagValue(renders[1], '--extend-from-video'))
      .toBe(join(tmpdir(), `chaincontext-${innerJobIds[0]}.mp4`));
  });

  it('delivers the user clip, not the model\'s decode of it, from chunk 0 of an extend chain only (#11179)', async () => {
    const sourceVideoPath = join(MOCK_PATHS.videos, 'original-video.mp4');
    const { spliceExtendSource } = await import('./extendSplice.js');
    vi.mocked(spliceExtendSource).mockClear();

    const { innerJobIds } = await runChain({ mode: 'extend', extendFromVideoPath: sourceVideoPath }, 2);

    // Chunk 1's "source" is a temp tail window the stitch already holds; only
    // chunk 0 renders from the user's own clip. A hidden chunk keeps no audio master.
    expect(spliceExtendSource).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      runtime: 'ltx2', sourcePath: sourceVideoPath, keepMaster: false, outputPath: join(MOCK_PATHS.videos, `${innerJobIds[0]}.mp4`),
    }));
  });

  // #4875 — a chained render is ONE clip, so a speed profile applies to every
  // chunk or to none. Chunks 1+ re-enter as `extend` on a window-continuity
  // chain (the default), and no two-stage profile is validated for that
  // pipeline; applying it per chunk would render chunk 0 fast and the rest at
  // the model default, stitching a visible seam mid-clip.
  it('declines a speed profile for the whole chain when continuation runs as extend', async () => {
    const { renders } = await runChain(
      { modelId: 'ltx25_mlx_q8', contextFrames: 22, speedProfileId: 'fast' }, 2,
    );
    expect(renders).toHaveLength(2);
    for (const args of renders) {
      expect(args).not.toContain('--speed-profile');
      expect(args).not.toContain('--teacache');
      // Every chunk on the model's own sampler — no seam.
      expect(flagValue(args, '--steps')).toBe('30');
      expect(flagValue(args, '--cfg-scale')).toBe('3');
    }
  });

  it('applies a speed profile to every chunk of a frame-hop chain, where all modes qualify', async () => {
    // contextFrames: 0 → frame hop → chunks 1+ are `image`, which the profile
    // IS validated for, so the whole chain takes it.
    const { renders } = await runChain(
      { modelId: 'ltx25_mlx_q8', contextFrames: 0, speedProfileId: 'fast' }, 2,
    );
    expect(renders).toHaveLength(2);
    for (const args of renders) {
      expect(flagValue(args, '--speed-profile')).toBe('fast');
      expect(args).toContain('--teacache');
      expect(flagValue(args, '--steps')).toBe('8');
      expect(flagValue(args, '--cfg-scale')).toBe('1');
      expect(flagValue(args, '--stage2-steps')).toBe('3');
    }
  });
});

describe('generateChainedVideo — the chunk phase on the outer frames (#5872)', () => {
  it('carries the chunk phase on the chain progress frames without a synthetic outer started', async () => {
    // A chain emits `started` per CHUNK, under inner ids nothing outside the
    // orchestrator knows, so the outer id's consumers only ever see `progress`.
    // The runner's phase has to ride those frames or the page falls back to its
    // load/render heuristic for the whole multi-chunk render.
    const { readJSONFile } = await import('../../lib/fileUtils.js');
    const outerJobId = randomUUID();
    const innerJobIds = [];
    const startedIds = [];
    const outerProgress = [];
    const onStarted = (e) => {
      startedIds.push(e.generationId);
      if (e.generationId === outerJobId) return;
      innerJobIds.push(e.generationId);
      // A microtask lands before the chunk's first awaited I/O, while its
      // per-chunk listeners are attached.
      queueMicrotask(() => {
        videoGenEvents.emit('progress', {
          generationId: e.generationId, progress: 0.5, step: 5, totalSteps: 10, phase: 'sampling',
        });
      });
    };
    const onProgress = (e) => { if (e.generationId === outerJobId) outerProgress.push(e); };
    vi.mocked(readJSONFile).mockImplementation(async () =>
      innerJobIds.map((id) => ({ id, filename: `${id}.mp4` })),
    );
    videoGenEvents.on('started', onStarted);
    videoGenEvents.on('progress', onProgress);

    generateChainedVideo({
      chunks: 2,
      jobId: outerJobId,
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'a chained render',
      width: 512,
      height: 512,
      numFrames: 25,
      fps: 24,
    });

    const deadline = Date.now() + 5000;
    while (outerProgress.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(outerProgress[0]).toMatchObject({
      generationId: outerJobId, phase: 'sampling', step: 5, totalSteps: 10,
    });
    // No synthetic `started` under the outer id: consumers read that event as
    // "the run begins", and a chain fires one per chunk.
    expect(startedIds).not.toContain(outerJobId);

    for (const id of [...innerJobIds]) {
      videoGenEvents.emit('completed', { generationId: id, filename: `${id}.mp4`, path: `/data/videos/${id}.mp4` });
    }
    await waitForStitch();

    videoGenEvents.off('started', onStarted);
    videoGenEvents.off('progress', onProgress);
  });
});

describe('generateChainedVideo — per-chunk prompt beats (#3695)', () => {
  /**
   * Drive a text chain of `totalChunks` and return the `--prompt` value each
   * inner render was spawned with, in chunk order. Prompts are read off the
   * spawn args rather than the 'started' event because that event carries
   * sampler metadata, not the prompt — the spawn args are what the runner
   * actually renders.
   */
  async function runChainAndCapturePrompts(chainParams, totalChunks) {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();

    // Between chunks the chain extracts the prior chunk's last frame, which
    // looks the chunk up in history — feed it the ids as they start so the
    // chain can advance past chunk 0.
    const { readJSONFile } = await import('../../lib/fileUtils.js');
    const innerJobIds = [];
    vi.mocked(readJSONFile).mockImplementation(async () =>
      innerJobIds.map((id) => ({ id, filename: `${id}.mp4` })),
    );
    videoGenEvents.on('started', (e) => innerJobIds.push(e.generationId));

    generateChainedVideo({
      chunks: totalChunks,
      jobId: randomUUID(),
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'main prompt',
      width: 512,
      height: 512,
      numFrames: 25,
      fps: 24,
      mode: 'image',
      sourceImagePath: '/mock/source.png',
      extendFromVideoPath: null,
      lastImagePath: null,
      ...chainParams,
    });

    for (let i = 0; i < totalChunks; i++) {
      await new Promise((resolve) => {
        const check = () => {
          if (innerJobIds.length > i) { resolve(); return; }
          setTimeout(check, 10);
        };
        check();
      });
      const id = innerJobIds[i];
      videoGenEvents.emit('completed', { generationId: id, filename: `${id}.mp4`, path: `/data/videos/${id}.mp4` });
    }
    await waitForStitch();
    videoGenEvents.removeAllListeners('started');

    return spawnMock.mock.calls
      .map(([, args]) => (Array.isArray(args) && args.includes('--prompt')
        ? args[args.indexOf('--prompt') + 1] : null))
      .filter((p) => p != null);
  }

  it('renders each chunk with its own beat', async () => {
    const prompts = await runChainAndCapturePrompts(
      { chunkPrompts: ['she opens the door', 'she steps into the rain'] },
      2,
    );
    expect(prompts).toEqual(['she opens the door', 'she steps into the rain']);
  });

  it('falls back to the main prompt for a blank beat', async () => {
    // A blank middle entry is the explicit "no beat here" marker — it must
    // render the MAIN prompt, never an empty prompt.
    const prompts = await runChainAndCapturePrompts(
      { chunkPrompts: ['she opens the door', '', '   '] },
      3,
    );
    expect(prompts).toEqual(['she opens the door', 'main prompt', 'main prompt']);
  });

  it('falls back to the main prompt for a null beat and for indices past the list', async () => {
    const prompts = await runChainAndCapturePrompts(
      { chunkPrompts: [null, 'the storm breaks'] },
      3,
    );
    expect(prompts).toEqual(['main prompt', 'the storm breaks', 'main prompt']);
  });

  it('renders the main prompt for every chunk when no beats are supplied', async () => {
    const prompts = await runChainAndCapturePrompts({}, 2);
    expect(prompts).toEqual(['main prompt', 'main prompt']);
  });

  it('persists the beat list on the stitched history entry', async () => {
    // The individual chunk entries only record their own RESOLVED prompt, which
    // loses which chunks carried an explicit beat — so the visible stitched
    // entry has to carry the list for a Remix to round-trip it.
    const { atomicWrite } = await import('../../lib/fileUtils.js');
    await runChainAndCapturePrompts({ chunkPrompts: ['a beat', '', 'a later beat'] }, 3);

    const stitched = vi.mocked(atomicWrite).mock.calls
      .flatMap(([, payload]) => (Array.isArray(payload) ? payload : []))
      .find((item) => Array.isArray(item?.chainedFrom));
    expect(stitched).toBeTruthy();
    expect(stitched.chunkPrompts).toEqual(['a beat', '', 'a later beat']);
    // The stitched entry keeps its own derived identity alongside the beats.
    expect(stitched.filename).toMatch(/^chained-/);
  });
});
