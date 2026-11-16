/**
 * generateVideo.core.test.js
 *
 * Split from local.test.js (#16214); shared mocks live in local.testFixtures.js.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { basename, join } from 'path';
import { tmpdir, totalmem } from 'os';
import { randomUUID } from 'crypto';
// Pure table, no mocking involved — a static import survives vi.resetModules().
import { INSPIRE_DEFAULT_IMAGE_STRENGTH } from '../../lib/videoReferenceModes.js';

// vi.mock factories are hoisted above imports; the shared fixtures module is
// loaded the same way so its state objects outlive vi.resetModules().
const fx = await vi.hoisted(() => import('./local.testFixtures.js'));
const { heavyClaimRelease, mockPrepareLocalMemory, MOCK_PATHS, isLtx2Python, isLtx25Python, mockInspectModelCache } = fx;

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
let generateVideo;
let videoGenEvents;

beforeEach(async () => {
  vi.resetModules();
  fx.resetFsPromisesReadFile();
  ({ generateVideo } = await import('./local.js'));
  ({ videoGenEvents } = await import('./events.js'));
});

afterEach(async () => {
  await fx.resetSharedMocks();
});

const renderToTerminal = (request) => fx.renderToTerminal(generateVideo, videoGenEvents, request);

describe('generateVideo — ltx2 FFLF image resizing', () => {
  // Windows uses the separate diffusers runner, which intentionally consumes
  // only the start image. This assertion is specific to the MLX FFLF helper.
  it.skipIf(process.platform === 'win32')('resizes both start and end frames before passing them to the ltx2 helper', async () => {
    const { execFile } = await import('../../lib/childProcess.js');
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const execFileMock = vi.mocked(execFile);
    const spawnMock = vi.mocked(spawnDetached);
    execFileMock.mockClear();
    spawnMock.mockClear();

    const jobId = 'fflf-two-frame-resize-test';
    const sourceImagePath = '/mock/uploads/start.png';
    const lastImagePath = '/mock/uploads/end.png';

    await generateVideo({
      jobId,
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'interpolate the two anchors',
      width: 512,
      height: 512,
      numFrames: 25,
      fps: 24,
      mode: 'fflf',
      sourceImagePath,
      lastImagePath,
    });

    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock.mock.calls.map((call) => call[1][1])).toEqual([
      sourceImagePath,
      lastImagePath,
    ]);

    const renderCall = spawnMock.mock.calls.find(
      ([bin, args]) => isLtx2Python(bin)
        && Array.isArray(args)
        && args.includes('--mode')
        && args.includes('fflf'),
    );
    expect(renderCall).toBeTruthy();

    const args = renderCall[1];
    expect(args[args.indexOf('--image') + 1]).toBe(join(tmpdir(), `resized-src-${jobId}.png`));
    expect(args[args.indexOf('--last-image') + 1]).toBe(join(tmpdir(), `resized-last-${jobId}.png`));
  });
});

describe('generateVideo — LTX audio-reactive conditioning', () => {
  it('threads the song offset while disabling generated clip audio', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();

    await generateVideo({
      jobId: 'audio-reactive-offset-test',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'streetlights pulse with the music; no performers',
      width: 512,
      height: 512,
      numFrames: 25,
      fps: 24,
      mode: 'a2v',
      sourceImagePath: '/mock/source.png',
      audioFilePath: '/mock/song.wav',
      audioStartSec: 42.5,
      disableAudio: true,
    });

    const renderCall = spawnMock.mock.calls.find(
      ([bin, args]) => isLtx2Python(bin)
        && Array.isArray(args)
        && args.includes('--mode')
        && args.includes('a2v'),
    );
    expect(renderCall).toBeTruthy();
    expect(renderCall[1]).not.toContain('--no-teacache');
    expect(renderCall[1]).toEqual(expect.arrayContaining([
      '--audio', '/mock/song.wav',
      '--audio-start', '42.5',
      '--no-audio',
    ]));
  });
});

describe('generateVideo — retired runtime guard', () => {
  it('refuses a preserved Hunyuan entry before choosing a fallback runner', async () => {
    await expect(generateVideo({
      jobId: 'retired-hunyuan-runtime',
      pythonPath: '/usr/bin/python3',
      modelId: 'custom_hunyuan',
      prompt: 'a quiet street at dusk',
      width: 512,
      height: 512,
      numFrames: 25,
      fps: 24,
      mode: 'text',
    })).rejects.toMatchObject({ status: 400, code: 'VIDEO_RUNTIME_RETIRED' });
  });
});

describe('generateVideo — PORTOS_T2V_TWO_STAGE arg threading', () => {
  afterEach(() => { delete process.env.PORTOS_T2V_TWO_STAGE; });

  // Drive a plain default T2V Standard render through generateVideo and pull
  // the ltx2 helper's spawn args back out — this is the only place the
  // Node-side override + --stage2-steps threading is observable end-to-end
  // (the pure-helper test can't see buildLtx2Args).
  const renderArgsFor = async (jobId) => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();
    await generateVideo({
      jobId,
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified', // mock model: steps 30, guidance 3.5
      prompt: 'a quiet street at dusk',
      width: 512,
      height: 512,
      numFrames: 25,
      fps: 24,
      // plain T2V: no mode, no conditioning, no explicit steps/guidance
    });
    const call = spawnMock.mock.calls.find(
      ([bin, args]) => isLtx2Python(bin)
        && Array.isArray(args) && args.includes('--mode') && args.includes('text'),
    );
    expect(call).toBeTruthy();
    return call[1];
  };

  it('threads --stage2-steps 3 + fast steps/cfg when the knob is on', async () => {
    process.env.PORTOS_T2V_TWO_STAGE = '1';
    const args = await renderArgsFor('t2v-twostage-on');
    expect(args[args.indexOf('--preview-dir') + 1]).toContain('portos-video-stepwise-');
    expect(args[args.indexOf('--stage2-steps') + 1]).toBe('3');
    expect(args[args.indexOf('--steps') + 1]).toBe('8');
    expect(args[args.indexOf('--cfg-scale') + 1]).toBe('1');
  });

  it('leaves the Standard render untouched (model defaults, no --stage2-steps) when the knob is off', async () => {
    const args = await renderArgsFor('t2v-twostage-off');
    expect(args).not.toContain('--stage2-steps');
    expect(args[args.indexOf('--steps') + 1]).toBe('30');
    expect(args[args.indexOf('--cfg-scale') + 1]).toBe('3.5');
  });
});

describe('generateVideo — LTX-2.5 sibling runtime spawn', () => {
  const renderLtxFamily = async (jobId, modelId) => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();
    await generateVideo({
      jobId,
      pythonPath: '/usr/bin/python3',
      modelId,
      prompt: 'a quiet street at dusk',
      width: 512,
      height: 512,
      numFrames: 25,
      fps: 24,
    });
    return spawnMock.mock.calls;
  };

  it('spawns the 2.5 venv, omits the shared Gemma 3 encoder, and pins --model to the cached revision', async () => {
    const calls = await renderLtxFamily('ltx25-spawn', 'ltx25_mlx_q8');
    const renderCall = calls.find(
      ([bin, args]) => isLtx25Python(bin)
        && Array.isArray(args)
        && args.includes('--mode')
        && args.includes('text'),
    );
    expect(renderCall).toBeTruthy();
    expect(renderCall[1]).not.toContain('--gemma');
    expect(renderCall[1][renderCall[1].indexOf('--model') + 1]).toBe('/mock/hf/snap');
    expect(renderCall[1]).not.toContain('MrMofer/ltx-2.5-mlx-q8');
    expect(calls.some(([bin]) => isLtx2Python(bin))).toBe(false);
  });

  it('still threads --gemma through the 2.3 venv and leaves an unpinned repo id on --model', async () => {
    const calls = await renderLtxFamily('ltx2-gemma-still', 'ltx2_unified');
    const renderCall = calls.find(
      ([bin, args]) => isLtx2Python(bin)
        && Array.isArray(args)
        && args.includes('--mode')
        && args.includes('text'),
    );
    expect(renderCall).toBeTruthy();
    expect(renderCall[1]).toEqual(expect.arrayContaining(['--gemma', 'some/text-encoder']));
    expect(renderCall[1][renderCall[1].indexOf('--model') + 1]).toBe('Lightricks/LTX-Video');
    expect(calls.some(([bin]) => isLtx25Python(bin))).toBe(false);
  });

  // Substituted prompt conditioner on 2.5 (#4320). The shim flags and the 2.3
  // `--gemma` flag are different mechanisms sharing one builder, so each
  // runtime must emit exactly its own — and neither when nothing was picked.
  it.each([
    ['ltx25_mlx_q8', isLtx25Python],
    ['ltx2_unified', isLtx2Python],
  ])('adds no text-encoder shim argv to an unswapped %s render', async (modelId, isPython) => {
    const calls = await renderLtxFamily(`${modelId}-no-shim`, modelId);
    const [, args] = calls.find(([bin, a]) => isPython(bin) && Array.isArray(a) && a.includes('--mode'));
    expect(args.filter((arg) => String(arg).startsWith('--text-encoder'))).toEqual([]);
  });

  // Every ltx25 substitute failed its empirical gate, so the
  // route/service path must reject its id rather than half-wire a render.
  it.each([
    'ltx25-abliterated-4bit',
    'ltx25-heretic-8bit',
    'ltx25-ltx-heretic-mxfp8',
  ])('rejects the unverified %s', async (textEncoderId) => {
    await expect(generateVideo({
      jobId: `ltx25-unverified-${textEncoderId}`,
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx25_mlx_q8',
      prompt: 'a quiet street at dusk',
      width: 512, height: 512, numFrames: 25, fps: 24,
      textEncoderId,
    })).rejects.toMatchObject({ status: 400, code: 'VIDEO_TEXT_ENCODER_UNSUPPORTED' });
  });

  // The flags a resolved substitute produces, exercised directly: the registry
  // entries that would drive them end-to-end are gated until the A/B render in
  // #4320 lands, and this is the contract that has to survive that flag flip.
  describe('ltx25TextEncoderArgs', () => {
    let ltx25TextEncoderArgs;
    beforeEach(async () => {
      ({ ltx25TextEncoderArgs } = await import('./renderArgs.js'));
    });

    it('emits nothing for the stock choice', () => {
      expect(ltx25TextEncoderArgs(null)).toEqual([]);
    });

    it('emits one --text-encoder-file per pinned file plus a shim root outside the checkout', () => {
      const args = ltx25TextEncoderArgs({
        id: 'ltx25-abliterated-4bit',
        paths: ['/mock/hf/snap/config.json', '/mock/hf/snap/model-00001-of-00003.safetensors'],
      });
      expect(args[args.indexOf('--text-encoder-id') + 1]).toBe('ltx25-abliterated-4bit');
      expect(args.flatMap((arg, i) => (arg === '--text-encoder-file' ? [args[i + 1]] : [])))
        .toEqual(['/mock/hf/snap/config.json', '/mock/hf/snap/model-00001-of-00003.safetensors']);
      const shimRoot = args[args.indexOf('--text-encoder-shim-root') + 1];
      expect(shimRoot).toContain(join('.portos', 'ltx25-encoder-shims'));
      expect(shimRoot).not.toContain(join('.portos', 'ltx-2.5-mlx'));
      // No overrides declared — the config rewrite flag stays off, the same way
      // the H3 builder omits its key-remap flags for a checkpoint needing none.
      expect(args).not.toContain('--text-encoder-config-json');
      // Never the 2.3 mechanism: a 2.5 pack's own tower wins over --gemma.
      expect(args).not.toContain('--gemma');
    });

    it('forwards configOverrides as one JSON payload', () => {
      const args = ltx25TextEncoderArgs({
        id: 'ltx25-heretic-8bit',
        paths: ['/mock/hf/snap/config.json'],
        configOverrides: { model_type: 'gemma4' },
      });
      expect(JSON.parse(args[args.indexOf('--text-encoder-config-json') + 1]))
        .toEqual({ model_type: 'gemma4' });
    });

    // An empty object is not an override — emitting `{}` would make the runner
    // rewrite a config for no reason and hide a registry typo behind a no-op.
    it('omits the config flag for an empty override map', () => {
      expect(ltx25TextEncoderArgs({ id: 'x', paths: ['/p'], configOverrides: {} }))
        .not.toContain('--text-encoder-config-json');
    });
  });

  it('rejects a missing pinned 2.5 snapshot before spawn', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    vi.mocked(spawnDetached).mockClear();
    mockInspectModelCache.mockResolvedValueOnce({ cached: false, snapshotPath: null, sizeBytes: 0 });
    await expect(generateVideo({
      jobId: 'ltx25-uncached',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx25_mlx_q8',
      prompt: 'a quiet street at dusk',
      width: 512, height: 512, numFrames: 25, fps: 24,
    })).rejects.toMatchObject({ code: 'LTX2_MODEL_NOT_CACHED' });
    expect(spawnDetached).not.toHaveBeenCalled();
  });
});

describe('generateVideo — pinned snapshot policies', () => {
  const withModel = async (modelId, update, run) => {
    const mediaModels = await import('../../lib/mediaModels.js');
    const getVideoModelsMock = vi.mocked(mediaModels.getVideoModels);
    const catalog = getVideoModelsMock();
    getVideoModelsMock.mockReturnValue(catalog.map((model) => (
      model.id === modelId ? update(model) : model
    )));
    try {
      return await run();
    } finally {
      getVideoModelsMock.mockReturnValue(catalog);
    }
  };

  const fastvideoRender = (fields = {}) => generateVideo({
    jobId: 'fastvideo-snapshot-policy',
    modelId: 'fasth3_dense_datafree_int8',
    prompt: 'a quiet street at dusk',
    width: 832, height: 480, numFrames: 124, fps: 24, mode: 'text',
    ...fields,
  });

  const ref2vaRender = () => generateVideo({
    jobId: 'ref2va-snapshot-policy',
    modelId: 'minimax_h3_ref2va_8bit',
    prompt: 'a fox listens to the rain',
    width: 512, height: 320, numFrames: 124, fps: 24, mode: 'a2v',
    sourceImagePath: '/mock/source.png', audioFilePath: '/mock/audio.wav',
  });

  it('passes a cached pinned FastVideo snapshot to the runner', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();
    mockInspectModelCache.mockResolvedValueOnce({
      cached: true,
      snapshotPath: '/mock/hf/fastvideo-snapshot',
      sizeBytes: 1000,
    });

    await fastvideoRender();

    expect(mockInspectModelCache).toHaveBeenCalledWith(
      'FastVideo/FastVideo-FastH3-4-step-Preview-v1-Dense-DataFree',
      { revision: 'f624f08c6c279ab43534c003e556fc5b295b6558' },
    );
    const call = spawnMock.mock.calls.find(([, args]) => (
      Array.isArray(args) && args.some((arg) => basename(String(arg)) === 'generate_fastvideo.py')
    ));
    expect(call).toBeDefined();
    expect(call[1][call[1].indexOf('--model-root') + 1])
      .toBe('/mock/hf/fastvideo-snapshot');
  });

  it('rejects a pinned FastVideo model when its snapshot is not cached', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    vi.mocked(spawnDetached).mockClear();
    mockInspectModelCache.mockResolvedValueOnce({ cached: false, snapshotPath: null, sizeBytes: 0 });

    await expect(fastvideoRender()).rejects.toMatchObject({
      message: 'FastH3 Preview v1 Dense Data-Free revision f624f08c is not fully cached. Download or repair it in Video Gen before rendering.',
      status: 400,
      code: 'FASTVIDEO_MODEL_NOT_CACHED',
    });
    expect(mockInspectModelCache).toHaveBeenCalledWith(
      'FastVideo/FastVideo-FastH3-4-step-Preview-v1-Dense-DataFree',
      { revision: 'f624f08c6c279ab43534c003e556fc5b295b6558' },
    );
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it('keeps an unpinned, uncached FastVideo model on its best-effort repo fallback', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();
    mockInspectModelCache.mockResolvedValueOnce({ cached: false, snapshotPath: null, sizeBytes: 0 });

    await withModel('fasth3_dense_datafree_int8', ({ revision: _revision, ...model }) => model, fastvideoRender);

    expect(mockInspectModelCache).toHaveBeenCalledWith(
      'FastVideo/FastVideo-FastH3-4-step-Preview-v1-Dense-DataFree',
    );
    const call = spawnMock.mock.calls.find(([, args]) => (
      Array.isArray(args) && args.some((arg) => basename(String(arg)) === 'generate_fastvideo.py')
    ));
    expect(call).toBeDefined();
    expect(call[1][call[1].indexOf('--model-root') + 1])
      .toBe('FastVideo/FastVideo-FastH3-4-step-Preview-v1-Dense-DataFree');
  });

  it('rejects a Ref2VA model with no immutable revision', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    vi.mocked(spawnDetached).mockClear();

    await withModel(
      'minimax_h3_ref2va_8bit',
      ({ revision: _revision, ...model }) => model,
      async () => expect(ref2vaRender()).rejects.toMatchObject({
        message: 'MiniMax H3 Ref2VA model "minimax_h3_ref2va_8bit" is missing an immutable Hugging Face revision.',
        status: 500,
        code: 'VIDEO_MODEL_MISCONFIGURED',
      }),
    );
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it('rejects a pinned Ref2VA model when its snapshot is not cached', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    vi.mocked(spawnDetached).mockClear();
    mockInspectModelCache.mockResolvedValueOnce({ cached: false, snapshotPath: null, sizeBytes: 0 });

    await expect(ref2vaRender()).rejects.toMatchObject({
      message: 'MiniMax H3 Ref2VA MLX 8-bit revision 61dc387e is not fully cached. Download or repair it in Video Gen before rendering.',
      status: 400,
      code: 'MINIMAX_H3_REF2VA_MODEL_NOT_CACHED',
    });
    expect(mockInspectModelCache).toHaveBeenCalledWith(
      'Sawfwair/MiniMax-H3-Ref2VA-MLX-8bit',
      { revision: '61dc387ef1a7166425cdacd63c2340598dcc364f' },
    );
    expect(spawnDetached).not.toHaveBeenCalled();
  });
});

describe('FFLF/ltx2 pixel-budget helpers', () => {
  const DEFAULT_BUDGET = 704 * 448 * 25; //  7,884,800 — 48 GB floor
  const BUDGET_128GB = 768 * 512 * 97; // 38,141,952 — 128 GB anchor
  const GB = 1024 ** 3;

  let resolveFflfLtx2PixelBudget;
  let computeFflfLtx2PixelBudget;
  let computeFflfSafeFrames;

  beforeEach(async () => {
    ({ resolveFflfLtx2PixelBudget, computeFflfLtx2PixelBudget, computeFflfSafeFrames } =
      await import('./renderArgs.js'));
    delete process.env.FFLF_LTX2_PIXEL_BUDGET;
  });

  afterEach(() => {
    delete process.env.FFLF_LTX2_PIXEL_BUDGET;
  });

  describe('computeFflfLtx2PixelBudget (RAM-scaled, pure)', () => {
    it('hits the measured anchors exactly: 128 GB validated, tested-safe value at 48 GB', () => {
      expect(computeFflfLtx2PixelBudget(48 * GB)).toBe(DEFAULT_BUDGET);
      expect(computeFflfLtx2PixelBudget(128 * GB)).toBe(BUDGET_128GB);
    });

    it('holds the tested-safe floor through 64 GB so no already-running machine gets a larger untested cap', () => {
      // 64 GB Macs are documented to OOM at full resolution — keep their cap
      // EXACTLY where it shipped, don't extrapolate them upward.
      expect(computeFflfLtx2PixelBudget(8 * GB)).toBe(DEFAULT_BUDGET);
      expect(computeFflfLtx2PixelBudget(16 * GB)).toBe(DEFAULT_BUDGET);
      expect(computeFflfLtx2PixelBudget(32 * GB)).toBe(DEFAULT_BUDGET);
      expect(computeFflfLtx2PixelBudget(48 * GB)).toBe(DEFAULT_BUDGET);
      expect(computeFflfLtx2PixelBudget(64 * GB)).toBe(DEFAULT_BUDGET);
      // Just past the ramp start it begins to rise.
      expect(computeFflfLtx2PixelBudget(65 * GB)).toBeGreaterThan(DEFAULT_BUDGET);
    });

    it('scales monotonically with RAM above the 64 GB ramp start', () => {
      const b80 = computeFflfLtx2PixelBudget(80 * GB);
      const b96 = computeFflfLtx2PixelBudget(96 * GB);
      const b256 = computeFflfLtx2PixelBudget(256 * GB);
      expect(b80).toBeGreaterThan(DEFAULT_BUDGET);
      expect(b96).toBeGreaterThan(b80);
      expect(BUDGET_128GB).toBeGreaterThan(b96);
      expect(b256).toBeGreaterThan(BUDGET_128GB);
    });

    it('reaches the 97-frame smooth-motion regime at 768×512 by 128 GB', () => {
      // The whole point of #737: a 128 GB box must be able to render 97 frames
      // at 768×512 (the validated smooth config) without an env override.
      expect(computeFflfSafeFrames(768, 512, 97, computeFflfLtx2PixelBudget(128 * GB))).toBe(97);
    });

    it('falls to the floor on invalid memory inputs', () => {
      expect(computeFflfLtx2PixelBudget(0)).toBe(DEFAULT_BUDGET);
      expect(computeFflfLtx2PixelBudget(NaN)).toBe(DEFAULT_BUDGET);
      expect(computeFflfLtx2PixelBudget(-1)).toBe(DEFAULT_BUDGET);
    });
  });

  describe('resolveFflfLtx2PixelBudget', () => {
    it('defaults to the RAM-scaled budget for this machine when the env var is unset', () => {
      expect(resolveFflfLtx2PixelBudget()).toBe(computeFflfLtx2PixelBudget(totalmem()));
      // Floor always holds, on any machine the suite runs on.
      expect(resolveFflfLtx2PixelBudget()).toBeGreaterThanOrEqual(DEFAULT_BUDGET);
    });

    it('honors a positive numeric FFLF_LTX2_PIXEL_BUDGET override', () => {
      process.env.FFLF_LTX2_PIXEL_BUDGET = '12000000';
      expect(resolveFflfLtx2PixelBudget()).toBe(12_000_000);
    });

    it('ignores a non-positive or non-numeric override and falls back to the RAM-scaled budget', () => {
      const scaled = computeFflfLtx2PixelBudget(totalmem());
      process.env.FFLF_LTX2_PIXEL_BUDGET = '0';
      expect(resolveFflfLtx2PixelBudget()).toBe(scaled);
      process.env.FFLF_LTX2_PIXEL_BUDGET = '-5';
      expect(resolveFflfLtx2PixelBudget()).toBe(scaled);
      process.env.FFLF_LTX2_PIXEL_BUDGET = 'lots';
      expect(resolveFflfLtx2PixelBudget()).toBe(scaled);
    });
  });

  describe('computeFflfSafeFrames', () => {
    it('returns numFrames unchanged when the request already fits the budget', () => {
      expect(computeFflfSafeFrames(704, 448, 25, DEFAULT_BUDGET)).toBe(25);
      expect(computeFflfSafeFrames(704, 448, 10, DEFAULT_BUDGET)).toBe(10);
    });

    it('clamps down to the 8k+1 latent boundary when the request exceeds the budget', () => {
      // 768×512 = 393216 px/frame. budget/wh ≈ 20.05 → safeLatent floor((20-1)/8)=2 → 2*8+1=17.
      const safe = computeFflfSafeFrames(768, 512, 121, DEFAULT_BUDGET);
      expect(safe).toBe(17);
      expect(safe).toBeLessThan(121);
      expect(768 * 512 * safe).toBeLessThanOrEqual(DEFAULT_BUDGET);
      // The clamp lands on the latent boundary (8k+1).
      expect((safe - 1) % 8).toBe(0);
    });

    it('never returns below the minimum single-latent frame count (8*1+1)', () => {
      // A resolution so large that even one latent block barely fits.
      const safe = computeFflfSafeFrames(4000, 4000, 200, DEFAULT_BUDGET);
      expect(safe).toBe(9);
    });

    it('falls open (returns numFrames) when inputs are invalid', () => {
      expect(computeFflfSafeFrames(0, 448, 25, DEFAULT_BUDGET)).toBe(25);
      expect(computeFflfSafeFrames(704, 448, 0, DEFAULT_BUDGET)).toBe(0);
      expect(computeFflfSafeFrames(704, 448, 25, 0)).toBe(25);
    });

    it('defaults the budget arg to the resolved env budget', () => {
      process.env.FFLF_LTX2_PIXEL_BUDGET = String(704 * 448 * 25);
      expect(computeFflfSafeFrames(704, 448, 25)).toBe(25);
    });
  });
});

describe('resolveT2vTwoStageOverride — PORTOS_T2V_TWO_STAGE gate', () => {
  let resolveT2vTwoStageOverride;
  const ON = { PORTOS_T2V_TWO_STAGE: '1' };
  const FAST = { guidance: 1.0, steps: 8, stage2Steps: 3 };
  // A plain default T2V Standard render: ltx2, no mode, no conditioning, no
  // explicit guidance/steps.
  const plainT2V = { runtime: 'ltx2', mode: null, guidanceScale: null, steps: undefined };

  beforeEach(async () => {
    ({ resolveT2vTwoStageOverride } = await import('./renderArgs.js'));
  });

  it('returns the fast two-stage override for a plain T2V Standard render when the knob is on', () => {
    expect(resolveT2vTwoStageOverride({ ...plainT2V, env: ON })).toEqual(FAST);
    expect(resolveT2vTwoStageOverride({ ...plainT2V, mode: 'text', env: ON })).toEqual(FAST);
  });

  it('returns null when the knob is off / unset / non-truthy', () => {
    expect(resolveT2vTwoStageOverride({ ...plainT2V, env: {} })).toBeNull();
    expect(resolveT2vTwoStageOverride({ ...plainT2V, env: { PORTOS_T2V_TWO_STAGE: '0' } })).toBeNull();
    expect(resolveT2vTwoStageOverride({ ...plainT2V, env: { PORTOS_T2V_TWO_STAGE: 'false' } })).toBeNull();
  });

  it('accepts common truthy spellings (1/true/yes/on, case/space-insensitive)', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' On ']) {
      expect(resolveT2vTwoStageOverride({ ...plainT2V, env: { PORTOS_T2V_TWO_STAGE: v } })).toEqual(FAST);
    }
  });

  it('returns null for non-ltx2 runtimes even with the knob on', () => {
    expect(resolveT2vTwoStageOverride({ ...plainT2V, runtime: 'mlx_video', env: ON })).toBeNull();
    expect(resolveT2vTwoStageOverride({ ...plainT2V, runtime: 'wan22', env: ON })).toBeNull();
  });

  it('only applies to the default text mode, not conditioned modes', () => {
    for (const mode of ['image', 'fflf', 'a2v', 'extend']) {
      expect(resolveT2vTwoStageOverride({ ...plainT2V, mode, env: ON })).toBeNull();
    }
  });

  it('opts out when the user explicitly set guidance or steps (Standard only)', () => {
    expect(resolveT2vTwoStageOverride({ ...plainT2V, guidanceScale: 3.5, env: ON })).toBeNull();
    expect(resolveT2vTwoStageOverride({ ...plainT2V, guidanceScale: '7', env: ON })).toBeNull();
    expect(resolveT2vTwoStageOverride({ ...plainT2V, steps: 30, env: ON })).toBeNull();
    // Empty-string guidance is "not set" → still eligible.
    expect(resolveT2vTwoStageOverride({ ...plainT2V, guidanceScale: '', env: ON })).toEqual(FAST);
  });

  it('opts out when any conditioning input is present (not a plain T2V)', () => {
    expect(resolveT2vTwoStageOverride({ ...plainT2V, sourceImagePath: '/tmp/a.png', env: ON })).toBeNull();
    expect(resolveT2vTwoStageOverride({ ...plainT2V, uploadedTempPath: '/tmp/up.png', env: ON })).toBeNull();
    expect(resolveT2vTwoStageOverride({ ...plainT2V, uploadedTempPaths: ['/tmp/up.png'], env: ON })).toBeNull();
    expect(resolveT2vTwoStageOverride({ ...plainT2V, keyframes: [{ path: '/a', index: 0 }, { path: '/b', index: 8 }], env: ON })).toBeNull();
    expect(resolveT2vTwoStageOverride({ ...plainT2V, extendFromVideoPath: '/tmp/v.mp4', env: ON })).toBeNull();
    expect(resolveT2vTwoStageOverride({ ...plainT2V, audioFilePath: '/tmp/a.wav', env: ON })).toBeNull();
    // Empty arrays are not conditioning → still eligible.
    expect(resolveT2vTwoStageOverride({ ...plainT2V, uploadedTempPaths: [], keyframes: null, env: ON })).toEqual(FAST);
  });
});

describe('generateVideo — heavy claim setup cleanup (#4364)', () => {
  it('retains resolved segment settings and parent mapping before a pre-watch argument failure', async () => {
    const recorder = await import('./executionRecorder.js');
    const renderArgs = await import('./renderArgs.js');
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    vi.mocked(spawnDetached).mockClear();
    const recordExecution = vi.fn(async () => true);
    const recordDiagnostics = vi.fn(async () => true);
    recorder.setVideoExecutionRecorder({ recordExecution, recordDiagnostics });
    const executionParent = { jobId: 'queue-outer', segmentIndex: 1, segmentCount: 3 };
    const build = vi.spyOn(renderArgs, 'buildArgs').mockImplementationOnce(() => { throw new Error('synthetic argument refusal'); });
    try {
      await expect(generateVideo({ jobId: 'pre-watch-receipt', executionParent, modelId: 'ltx2_unified', prompt: 'Synthetic action', seed: 37,
        width: 512, height: 512, numFrames: 25, fps: 24, mode: 'text' })).rejects.toThrow('synthetic argument refusal');
      expect(recordExecution).toHaveBeenCalledWith('pre-watch-receipt', expect.objectContaining({ seed: 37, width: 512, height: 512, numFrames: 25, steps: 30, executionParent }));
      expect(recordDiagnostics).toHaveBeenCalledWith('pre-watch-receipt', { termination: expect.objectContaining({ reason: 'refused' }) }, executionParent);
      expect(spawnDetached).not.toHaveBeenCalled();
    } finally {
      build.mockRestore();
      recorder.setVideoExecutionRecorder(null);
    }
  });

  it('releases the claim when local setup fails before spawn', async () => {
    mockPrepareLocalMemory.mockRejectedValueOnce(new Error('memory setup failed'));

    await expect(generateVideo({
      jobId: 'claim-setup-failure',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'a clip',
      width: 512, height: 512, numFrames: 25, fps: 24,
      mode: 'text',
    })).rejects.toThrow('memory setup failed');

    expect(heavyClaimRelease).toHaveBeenCalledTimes(1);
  });

  // #4766 — the vLLM Qwen container holds ~23 GB of a 24 GB card and is invisible
  // to the resident-model unload, so the render used to die inside its model load
  // with an OOM naming neither vLLM nor a fix. Refuse up front, with the prose.
  it('refuses before spawn when something else is holding the GPU', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    vi.mocked(spawnDetached).mockClear();
    mockPrepareLocalMemory.mockResolvedValueOnce({
      unloaded: [], availableGb: 64, totalGb: 64, budgetGb: 64,
      blockers: [{
        runtime: 'vllm', providerId: 'opencode-vllm-tui', providerName: 'OpenCode vLLM TUI',
        endpoint: 'http://127.0.0.1:18020/v1',
        reason: 'vLLM (Qwen3.8-27B) is serving and holds the GPU. Stop it with `docker compose --profile single stop` in /srv/example/qwen-serving.',
      }],
    });

    await expect(generateVideo({
      jobId: 'gpu-blocked',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'a clip',
      width: 512, height: 512, numFrames: 25, fps: 24,
      mode: 'text',
    })).rejects.toThrow('docker compose --profile single stop');

    expect(spawnDetached).not.toHaveBeenCalled();
    expect(heavyClaimRelease).toHaveBeenCalledTimes(1);
  });
});

// Failures after conditioning returned but before the watcher owns the render:
// the derived (resized) conditioning files, the preview directory and the
// running job record must all unwind, and the original error must survive.
describe.skipIf(process.platform === 'win32')('generateVideo — startup unwinds after conditioning', () => {
  const jobIdFor = (name) => `startup-unwind-${name}`;
  const render = (jobId) => generateVideo({
    jobId,
    pythonPath: '/usr/bin/python3',
    modelId: 'ltx2_unified',
    prompt: 'interpolate the two anchors',
    width: 512, height: 512, numFrames: 25, fps: 24,
    mode: 'fflf',
    sourceImagePath: '/mock/uploads/start.png',
    lastImagePath: '/mock/uploads/end.png',
  });
  const unlinkedPaths = async () => {
    const { unlink } = await import('fs/promises');
    return vi.mocked(unlink).mock.calls.map(([path]) => String(path));
  };
  const expectDerivedFilesReleased = async (jobId) => {
    const unlinked = await unlinkedPaths();
    expect(unlinked).toContain(join(tmpdir(), `resized-src-${jobId}.png`));
    expect(unlinked).toContain(join(tmpdir(), `resized-last-${jobId}.png`));
    expect(unlinked).not.toContain('/mock/uploads/start.png');
    expect(unlinked).not.toContain('/mock/uploads/end.png');
  };

  it('releases derived conditioning files when preview-directory allocation rejects', async () => {
    const { mkdtemp, unlink } = await import('fs/promises');
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const { claimHeavyLocalJob } = await import('../../lib/heavyJobClaim.js');
    const { videoJobState } = await import('./jobState.js');
    const jobId = jobIdFor('mkdtemp');
    vi.mocked(unlink).mockClear();
    vi.mocked(mkdtemp).mockRejectedValueOnce(new Error('EIO: preview directory'));

    await expect(render(jobId)).rejects.toThrow('EIO: preview directory');

    await expectDerivedFilesReleased(jobId);
    expect(spawnDetached).not.toHaveBeenCalled();
    expect(claimHeavyLocalJob).not.toHaveBeenCalled();
    expect(videoJobState.jobs.get(jobId)?.status ?? 'absent').not.toBe('running');
  });

  it('releases files, preview directory and the running record when claim acquisition rejects', async () => {
    const { rm, unlink } = await import('fs/promises');
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const { claimHeavyLocalJob } = await import('../../lib/heavyJobClaim.js');
    const { videoJobState } = await import('./jobState.js');
    const jobId = jobIdFor('claim');
    vi.mocked(unlink).mockClear();
    vi.mocked(rm).mockClear();
    vi.mocked(claimHeavyLocalJob).mockRejectedValueOnce(new Error('EACCES: claim directory'));

    await expect(render(jobId)).rejects.toThrow('EACCES: claim directory');

    await expectDerivedFilesReleased(jobId);
    expect(vi.mocked(rm).mock.calls.map(([path]) => String(path))).toContain(
      join(tmpdir(), 'portos-video-stepwise-mock'),
    );
    expect(spawnDetached).not.toHaveBeenCalled();
    expect(videoJobState.jobs.has(jobId)).toBe(false);
    expect(heavyClaimRelease).not.toHaveBeenCalled();
  });

  it('keeps the acquisition error visible and records unsettled ownership when cleanup also fails', async () => {
    const { unlink } = await import('fs/promises');
    const { claimHeavyLocalJob } = await import('../../lib/heavyJobClaim.js');
    const { maintenance } = await import('../../lib/maintenanceAdmission.js');
    const unsettled = vi.spyOn(maintenance, 'markResourceUnsettled');
    vi.mocked(unlink).mockRejectedValue(new Error('EBUSY: temp file'));
    vi.mocked(claimHeavyLocalJob).mockRejectedValueOnce(new Error('EACCES: claim directory'));

    try {
      await expect(render(jobIdFor('cleanup-fails'))).rejects.toThrow('EACCES: claim directory');
      expect(unsettled).toHaveBeenCalledWith('media', jobIdFor('cleanup-fails'));
    } finally {
      unsettled.mockRestore();
      vi.mocked(unlink).mockReset().mockImplementation(async () => {});
    }
  });
});

describe('generateVideo — close-handler resilience (issue #1334)', () => {
  // A throw from finalizeGeneratedVideo inside proc.on('close') must NOT leak as
  // an unhandled rejection (process-killing on Node ≥15) or strand the job
  // `running` with no terminal SSE — it has to surface as a 'failed' event.
  it('routes a finalize throw to a terminal failed event instead of an unhandled rejection', async () => {
    vi.resetModules();
    // Spread the real module rather than enumerating the handful of exports
    // generateVideo happens to use today: a listed-exports-only mock breaks the
    // whole file the moment local.js imports one more helper (it did, twice).
    vi.doMock('./generateVideoHelpers.js', async (importOriginal) => ({
      ...(await importOriginal()),
      isWatchdogSuccess: () => false,
      finalizeGeneratedVideo: vi.fn(async () => { throw new Error('boom finalize'); }),
    }));
    const { generateVideo: gv } = await import('./local.js');
    const { videoGenEvents: events } = await import('./events.js');

    const failed = new Promise((resolve) => events.once('failed', resolve));

    await gv({
      jobId: 'close-handler-finalize-throw',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'a clip',
      width: 512, height: 512, numFrames: 25, fps: 24,
      mode: 'text',
    });

    const evt = await failed;
    expect(evt.generationId).toBe('close-handler-finalize-throw');
    expect(evt.error).toMatch(/boom finalize/);

    vi.doUnmock('./generateVideoHelpers.js');
  });
});

describe.each(['wan22', 'wan22_cuda'])('generateVideo — Wan frame defaults %s', (runtime) => {
  it.each([undefined, 120])('rejects off-grid frames (%s) before spawn', async (numFrames) => {
    const { getVideoModels } = await import('../../lib/mediaModels.js');
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    vi.mocked(getVideoModels).mockReturnValueOnce([{
      id: 'wan_test', name: 'Test Wan', runtime,
      supportedModes: ['text'], frameStride: 4, defaultFrames: 120,
    }]);
    await expect(generateVideo({
      modelId: 'wan_test', prompt: 'test', mode: 'text', numFrames,
    })).rejects.toMatchObject({
      status: 400, code: 'WAN22_INVALID_FRAME_COUNT',
      message: 'Test Wan requires a 4n+1 frame count; got 120.',
    });
    expect(spawnDetached).not.toHaveBeenCalled();
  });
});

describe('runtime fingerprint (/status)', () => {
  it('hostRuntimeFingerprint reports chip/os/platform/arch/node', async () => {
    const { hostRuntimeFingerprint } = await import('./local.js');
    const fp = hostRuntimeFingerprint();
    expect(typeof fp.chip).toBe('string');
    expect(fp.chip.length).toBeGreaterThan(0);
    expect(typeof fp.os).toBe('string');
    expect(fp.platform).toBe(process.platform);
    expect(fp.arch).toBe(process.arch);
    expect(fp.node).toBe(process.version);
  });

  it('resolveRuntimeFingerprint returns host info immediately + only resolved runtimes (non-blocking)', async () => {
    // /status must not block on probes, so resolveRuntimeFingerprint never
    // awaits a probe: `runtimes` contains only fingerprints already resolved in
    // cache (uncached installed runtimes are warmed in the background). Whether
    // any are present depends on the machine (CI: none; a dev box warms async),
    // so assert the shape — host always present, every included runtime entry is
    // a resolved fingerprint with a `versions` object and NO `error` (errors are
    // never cached) — rather than a specific machine's install set.
    const { resolveRuntimeFingerprint } = await import('./local.js');
    const block = await resolveRuntimeFingerprint();
    expect(block.host).toBeDefined();
    expect(typeof block.host.chip).toBe('string');
    expect(block.runtimes && typeof block.runtimes === 'object').toBe(true);
    for (const [id, fp] of Object.entries(block.runtimes)) {
      expect(typeof id).toBe('string');
      expect(fp.error).toBeUndefined();
      expect(typeof fp.versions).toBe('object');
    }
  });

  it('invalidateRuntimeFingerprintCache is callable for a single id and for all', async () => {
    const { invalidateRuntimeFingerprintCache } = await import('./local.js');
    expect(() => invalidateRuntimeFingerprintCache('ltx2')).not.toThrow();
    expect(() => invalidateRuntimeFingerprintCache()).not.toThrow();
  });
});

describe('generateVideo — BYOV missing-python-module failure path (#1833 regression)', () => {
  // When a BYOV-runtime child dies with a ModuleNotFoundError, generateVideo's
  // close handler drops the cached "ready" via invalidateByovReadyCache() and
  // emits a 'failed' event whose reason names the runtime venv. That helper was
  // extracted to runtimes.js in #1833; this test guards against it being only
  // re-exported (`export * from './runtimes.js'`) but NOT bound in local.js's
  // own scope — which would make the reference here throw a ReferenceError, so
  // the terminal 'failed' event never carries the venv-specific reason.
  it('classifies the first emitted missing-venv failure before the render rejects', async () => {
    vi.resetModules();
    const { generateVideo: gv } = await import('./local.js');
    const { videoGenEvents: events } = await import('./events.js');
    const { BYOV_RUNTIME_INFO } = await import('./runtimes.js');
    const { existsSync } = await import('fs');
    const originalExists = vi.mocked(existsSync).getMockImplementation();
    vi.mocked(existsSync).mockImplementation((path) => path !== BYOV_RUNTIME_INFO.ltx2.venvPython);
    const failed = new Promise((resolve) => events.once('failed', resolve));
    try {
      await expect(gv({ jobId: 'example-missing-venv', modelId: 'ltx2_unified', prompt: 'invented clip',
        width: 512, height: 512, numFrames: 25, fps: 24, mode: 'text' })).rejects.toMatchObject({ code: 'LTX2_VENV_MISSING' });
      expect((await failed).failure).toMatchObject({ classification: 'ltx2_venv_missing' });
    } finally {
      vi.mocked(existsSync).mockImplementation(originalExists);
    }
  });

  it('emits a failed event naming the runtime venv when the child reports ModuleNotFoundError', async () => {
    vi.resetModules();
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    vi.mocked(spawnDetached).mockImplementationOnce(async () => {
      const listeners = {};
      const stderrListeners = {};
      const proc = {
        pid: 4242,
        exitCode: null,
        signalCode: null,
        killed: false,
        stdout: { on: vi.fn() },
        stderr: { on: (event, fn) => { stderrListeners[event] = fn; } },
        on(event, fn) { listeners[event] = fn; return proc; },
        off(event, fn) { if (listeners[event] === fn) delete listeners[event]; return proc; },
        kill: vi.fn(),
      };
      // Feed the missing-module traceback to the stderr parser, then exit non-zero.
      setImmediate(() => {
        stderrListeners.data?.(Buffer.from("ModuleNotFoundError: No module named 'ltx_pipelines_mlx'\n"));
        proc.exitCode = 1;
        listeners.close?.(1, null);
      });
      return proc;
    });

    const { generateVideo: gv } = await import('./local.js');
    const { videoGenEvents: events } = await import('./events.js');

    const failed = new Promise((resolve) => events.once('failed', resolve));
    await gv({
      jobId: 'byov-missing-module',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified', // runtime: 'ltx2' → a BYOV runtime
      prompt: 'a clip',
      width: 512, height: 512, numFrames: 25, fps: 24,
      mode: 'text',
    });

    const evt = await failed;
    expect(evt.generationId).toBe('byov-missing-module');
    // Reason produced only by the BYOV missingPyModule branch (post-invalidate).
    expect(evt.error).toMatch(/ltx_pipelines_mlx/);
    expect(evt.error).toMatch(/LTX-2 MLX/);
  });
});

describe('resolveVideoModel — live registry lookup (#2124 no-restart add)', () => {
  it('resolves a model id through the live getVideoModels() list', async () => {
    const { resolveVideoModel } = await import('./local.js');
    // getVideoModels is mocked to return the catalog; a render-time lookup must
    // go through it (not a boot snapshot) so a runtime-added model resolves.
    expect(resolveVideoModel('ltx23_distilled_q4')?.id).toBe('ltx23_distilled_q4');
  });

  it('does not revive a disabled or removed model from the boot snapshot', async () => {
    const mediaModels = await import('../../lib/mediaModels.js');
    const { resolveVideoModel } = await import('./local.js');
    mediaModels.getVideoModels.mockReturnValueOnce([]);
    expect(resolveVideoModel('ltx23_distilled_q4')).toBeNull();
  });

  it('returns null for an unknown id', async () => {
    const { resolveVideoModel } = await import('./local.js');
    expect(resolveVideoModel('does-not-exist')).toBeNull();
  });

  it('picks up a model added to the live list after boot (no restart)', async () => {
    const mediaModels = await import('../../lib/mediaModels.js');
    const { resolveVideoModel } = await import('./local.js');
    // Simulate addUserModelEntry hot-reloading the registry: getVideoModels now
    // returns an entry that was NOT present when local.js built VIDEO_MODELS.
    mediaModels.getVideoModels.mockReturnValueOnce([
      { id: 'hf-newly-added', name: 'New', runtime: 'mlx_video', repo: 'x/y', steps: 25, guidance: 3 },
    ]);
    expect(resolveVideoModel('hf-newly-added')?.id).toBe('hf-newly-added');
  });
});

describe('generateVideo — chunk-boundary marker parsing (#2463)', () => {
  // Controllable child that never exits on its own, exposing its stdout/stderr
  // 'data' listeners and 'close' handler so the test can feed pipe chunks on
  // arbitrary byte boundaries and assert markers are stitched into one event.
  function makeControllableProc() {
    const listeners = {};
    let stdoutData = null;
    let stderrData = null;
    const proc = {
      pid: 5150,
      exitCode: null,
      signalCode: null,
      killed: false,
      stdout: { on: vi.fn((event, fn) => { if (event === 'data') stdoutData = fn; }) },
      stderr: { on: vi.fn((event, fn) => { if (event === 'data') stderrData = fn; }) },
      on(event, fn) { listeners[event] = fn; return proc; },
      off(event, fn) { if (listeners[event] === fn) delete listeners[event]; return proc; },
      kill: vi.fn((signal) => { proc.killed = true; proc.signalCode = signal; }),
    };
    return {
      proc,
      // Pass raw Buffers so the reader's StringDecoder path is exercised.
      emitStdout: (buf) => stdoutData?.(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)),
      emitStderr: (buf) => stderrData?.(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)),
      fireClose: (code, signal) => listeners.close?.(code, signal),
    };
  }

  const statusFrames = (broadcastSse, message) =>
    broadcastSse.mock.calls.filter((c) => c[1]?.type === 'status' && c[1]?.message === message);

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  async function startRender(jobId, ctrl) {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    vi.mocked(spawnDetached).mockImplementationOnce(async () => ctrl.proc);
    generateVideo({
      jobId,
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'boundary test',
      width: 512, height: 512, numFrames: 25, fps: 24,
      mode: 'text',
    });
    // Let generateVideo await spawnDetached and register the stream handlers.
    await vi.advanceTimersByTimeAsync(0);
  }

  it('stitches a STATUS marker split across two stderr chunks into one event', async () => {
    const { broadcastSse } = await import('../../lib/sseUtils.js');
    const ctrl = makeControllableProc();
    await startRender('boundary-stderr-split', ctrl);

    // The `STATUS:Loading model` marker arrives torn across a pipe boundary.
    ctrl.emitStderr('STATUS:Loading ');
    // First half has no line terminator → carried, nothing emitted yet.
    expect(statusFrames(vi.mocked(broadcastSse), 'Loading model')).toHaveLength(0);
    expect(statusFrames(vi.mocked(broadcastSse), 'Loading')).toHaveLength(0);

    ctrl.emitStderr('model\n');
    // The completed line is parsed exactly once as the full marker.
    expect(statusFrames(vi.mocked(broadcastSse), 'Loading model')).toHaveLength(1);
  });

  it('stitches a multibyte codepoint split across two stdout chunks (result JSON captured)', async () => {
    const { videoGenEvents } = await import('./events.js');
    const ctrl = makeControllableProc();
    const completed = [];
    const onCompleted = (e) => completed.push(e);
    videoGenEvents.on('completed', onCompleted);
    await startRender('boundary-stdout-multibyte', ctrl);

    // "café" (é = 0xC3 0xA9) — split the 2-byte codepoint across the boundary.
    const json = Buffer.from('{"video_path": "/data/videos/café.mp4"}\n', 'utf8');
    const cut = json.indexOf(0xa9); // byte AFTER the 0xC3 lead byte
    ctrl.emitStdout(json.subarray(0, cut));   // ends mid-codepoint
    ctrl.emitStdout(json.subarray(cut));      // completes it + the newline
    ctrl.fireClose(0, null);
    await vi.advanceTimersByTimeAsync(0);

    videoGenEvents.off('completed', onCompleted);
    // A torn decode would have yielded replacement chars and failed JSON.parse,
    // so no result would be captured and the job would not complete cleanly.
    expect(completed).toHaveLength(1);
  });

  it('flushes a final unterminated STATUS marker on close', async () => {
    const { broadcastSse } = await import('../../lib/sseUtils.js');
    const ctrl = makeControllableProc();
    await startRender('boundary-flush-on-close', ctrl);

    // Marker written without a trailing newline (a killed child mid-write).
    ctrl.emitStderr('STATUS:Finalizing');
    // Nothing emitted while it sits in the carry buffer…
    expect(statusFrames(vi.mocked(broadcastSse), 'Finalizing')).toHaveLength(0);

    ctrl.fireClose(0, null);
    await vi.advanceTimersByTimeAsync(0);
    // …the reader's flush() on 'close' emits the final line exactly once.
    expect(statusFrames(vi.mocked(broadcastSse), 'Finalizing')).toHaveLength(1);
  });
});

describe('generateVideo — signal-death diagnosis (#3101)', () => {
  // The dominant real-world Apple-Silicon render abort is the macOS Metal
  // command-buffer watchdog, which arrives as SIGABRT. Before #3101 every signal
  // except SIGKILL fell through to a bare `Killed by signal SIGABRT` with no
  // cause and no next step. These assert the close handler's signal→message map
  // AND that the precedence above it (missingPyModule → signal)
  // is preserved.
  function makeSignalProc() {
    const listeners = {};
    let stdoutData = null;
    let stderrData = null;
    const proc = {
      pid: 3101,
      exitCode: null,
      signalCode: null,
      killed: false,
      stdout: { on: vi.fn((event, fn) => { if (event === 'data') stdoutData = fn; }) },
      stderr: { on: vi.fn((event, fn) => { if (event === 'data') stderrData = fn; }) },
      on(event, fn) { listeners[event] = fn; return proc; },
      off(event, fn) { if (listeners[event] === fn) delete listeners[event]; return proc; },
      kill: vi.fn((signal) => { proc.killed = true; proc.signalCode = signal; }),
    };
    return {
      proc,
      emitStdout: (text) => stdoutData?.(Buffer.from(text)),
      emitStderr: (text) => stderrData?.(Buffer.from(text)),
      fireClose: (code, signal) => listeners.close?.(code, signal),
    };
  }

  // Start a render, kill it with `signal`, and return the terminal 'failed' event.
  async function failWithSignal(jobId, signal, { onStarted } = {}) {
    vi.resetModules();
    const { generateVideo: gv } = await import('./local.js');
    const { videoGenEvents: events } = await import('./events.js');
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');

    // No output on disk, so isWatchdogSuccess can never treat the kill as success.
    const { existsSync, statSync } = await import('fs');
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(statSync).mockReturnValue({ size: 0 });

    const ctrl = makeSignalProc();
    vi.mocked(spawnDetached).mockImplementationOnce(async () => ctrl.proc);

    const failed = new Promise((resolve) => events.once('failed', resolve));
    await gv({
      jobId,
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'crash on a signal',
      width: 512, height: 512, numFrames: 25, fps: 24,
      mode: 'text',
    });
    onStarted?.(ctrl);
    ctrl.fireClose(null, signal);
    return failed;
  }

  it.each(['stdout', 'stderr'])('keeps a chunked final %s exception in the ordinary exit cause', async (stream) => {
    vi.resetModules();
    const { generateVideo: gv } = await import('./local.js');
    const { videoGenEvents: events } = await import('./events.js');
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const ctrl = makeSignalProc();
    vi.mocked(spawnDetached).mockImplementationOnce(async () => ctrl.proc);
    const failed = new Promise((resolve) => events.once('failed', resolve));
    await gv({ jobId: 'example-diagnostic', pythonPath: '/mock/python', modelId: 'ltx2_unified',
      prompt: 'invented clip', width: 512, height: 512, numFrames: 25, fps: 24, mode: 'text' });
    const emit = stream === 'stdout' ? ctrl.emitStdout : ctrl.emitStderr;
    emit('Traceback (most recent call last):\n  File "/mock/runtime.py", line 42, in render\n');
    emit('RuntimeError: shader comp');
    emit('ilation failed');
    await ctrl.fireClose(1, null);
    expect((await failed).error).toBe('Exit code 1: RuntimeError: shader compilation failed');
  });

  it('classifies distinct Metal abort evidence and leaves signal-only advice unclassified', async () => {
    const failures = [];
    for (const cause of ['OutOfMemory', 'InnocentVictim', null]) {
      failures.push(await failWithSignal(`signal-evidence-${cause}`, 'SIGABRT', {
        onStarted: (ctrl) => { if (cause) ctrl.emitStderr(`kIOGPUCommandBufferCallbackError${cause}\n`); },
      }));
    }
    expect(failures[0].failure.cause).toBe('Metal command buffer failed: OutOfMemory');
    expect(failures[1].failure.signature).not.toBe(failures[0].failure.signature);
    expect(failures[2].failure).toBeNull();
  });

  it('preserves classified child failure evidence on a chained render', async () => {
    vi.resetModules();
    const { generateChainedVideo: chain } = await import('./local.js');
    const { videoGenEvents: events } = await import('./events.js');
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const ctrl = makeSignalProc();
    vi.mocked(spawnDetached).mockImplementationOnce(async () => {
      setImmediate(() => {
        ctrl.emitStderr("AttributeError: 'Tokenizer' object has no attribute 'encode'\n");
        ctrl.fireClose(1, null);
      });
      return ctrl.proc;
    });
    const failed = new Promise((resolve) => {
      const onFailed = (event) => {
        if (event.generationId !== 'example-failed-chain') return;
        events.off('failed', onFailed);
        resolve(event);
      };
      events.on('failed', onFailed);
    });
    await chain({ chunks: 2, jobId: 'example-failed-chain', pythonPath: '/mock/python', modelId: 'ltx2_unified',
      prompt: 'invented clip', width: 512, height: 512, numFrames: 25, fps: 24, mode: 'text' });
    expect((await failed).failure).toMatchObject({ classification: 'attributeerror', signature: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it('a bare SIGABRT with no native line is an unexplained native abort, not a Metal watchdog', async () => {
    const evt = await failWithSignal('signal-sigabrt', 'SIGABRT');
    expect(evt.error).toMatch(/native abort with no diagnostic/);
    expect(evt.error).not.toMatch(/watchdog/i);
    expect(evt.error).not.toMatch(/Killed by signal SIGABRT/);
  });

  it('SIGBUS and SIGSEGV name a native MLX/Metal crash', async () => {
    for (const [i, sig] of ['SIGBUS', 'SIGSEGV'].entries()) {
      const evt = await failWithSignal(`signal-native-${i}`, sig);
      expect(evt.error).toMatch(new RegExp(sig));
      expect(evt.error).toMatch(/MLX\/Metal/);
      expect(evt.error).not.toMatch(new RegExp(`Killed by signal ${sig}`));
    }
  });

  it('SIGKILL keeps the out-of-memory wording', async () => {
    const evt = await failWithSignal('signal-sigkill', 'SIGKILL');
    expect(evt.error).toMatch(/out of memory/i);
  });

  it('an unmapped signal still reports verbatim (never mis-attributed)', async () => {
    const evt = await failWithSignal('signal-unmapped', 'SIGTERM');
    expect(evt.error).toMatch(/Killed by signal SIGTERM/);
  });

  it('stamps the runtime fingerprint the child emitted into the signal-death message', async () => {
    const fp = { runtime: 'ltx2', versions: { mlx: '0.22.0', mlx_metal: '0.22.0' }, chip: 'Apple M4 Max', os: 'macOS-15.4-arm64' };
    const evt = await failWithSignal('signal-fingerprint', 'SIGABRT', {
      onStarted: (ctrl) => ctrl.emitStderr(`RUNTIME:${JSON.stringify(fp)}\n`),
    });
    expect(evt.error).toMatch(/\[runtime: ltx2 \| mlx 0\.22\.0, mlx_metal 0\.22\.0 \| Apple M4 Max \| macOS-15\.4-arm64\]/);
  });

  it('a missing python module still wins over the signal map (precedence preserved)', async () => {
    const evt = await failWithSignal('signal-module-precedence', 'SIGABRT', {
      onStarted: (ctrl) => ctrl.emitStderr("ModuleNotFoundError: No module named 'ltx_pipelines_mlx'\n"),
    });
    expect(evt.error).toMatch(/ltx_pipelines_mlx/);
    expect(evt.error).not.toMatch(/Metal command-buffer watchdog/i);
  });
});

describe('generateVideo — durable re-render inputs (#3696)', () => {
  // The `started` event spreads the same `meta` object finalizeGeneratedVideo
  // later persists as the history record, so it's the observable surface for
  // what a completed render would store — without having to drive the child
  // process to a successful close.
  const startedMetaFor = async (params) => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();
    let started = null;
    const onStarted = (e) => { started = e; };
    videoGenEvents.on('started', onStarted);
    await generateVideo({
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'a quiet street at dusk',
      width: 512,
      height: 512,
      numFrames: 25,
      fps: 24,
      ...params,
    });
    videoGenEvents.off('started', onStarted);
    const renderCall = spawnMock.mock.calls.find(
      ([bin, args]) => isLtx2Python(bin) && Array.isArray(args),
    );
    return { started, args: renderCall?.[1] || [] };
  };

  it('records the seed a random-seed render actually resolved to, matching the one the child got', async () => {
    const { started, args } = await startedMetaFor({ jobId: 'finish-random-seed-test' });
    // No seed was supplied — the record must still pin the resolved value, or
    // a Finish re-render would roll a different composition.
    expect(Number.isInteger(started.seed)).toBe(true);
    expect(args[args.indexOf('--seed') + 1]).toBe(String(started.seed));
    expect(started.renderInputsVersion).toBe(1);
    expect(started.conditioning).toEqual([]);
    expect(started.mode).toBe('text');
  });

  it('keeps an explicitly supplied seed verbatim', async () => {
    const { started, args } = await startedMetaFor({ jobId: 'finish-explicit-seed-test', seed: 1234 });
    expect(started.seed).toBe(1234);
    expect(args[args.indexOf('--seed') + 1]).toBe('1234');
  });

  it('inventories conditioning for an image-to-video render (so Finish is not offered for it)', async () => {
    const { started } = await startedMetaFor({
      jobId: 'finish-i2v-conditioning-test',
      mode: 'image',
      sourceImagePath: '/mock/source.png',
    });
    expect(started.conditioning).toContain('image');
    expect(started.mode).toBe('image');
  });

  it('inventories audio conditioning even though the mode still reads as text', async () => {
    // The mode inference only looks at images/keyframes, so an audio-driven
    // render with no explicit mode would otherwise be stamped `text` and look
    // fully reproducible. The conditioning inventory is what catches it.
    const { started } = await startedMetaFor({
      jobId: 'finish-audio-conditioning-test',
      audioFilePath: '/mock/song.wav',
    });
    expect(started.mode).toBe('text');
    expect(started.conditioning).toEqual(['audio']);
  });
});

describe('generateVideo — history-calibrated ETA (#3801)', () => {
  const startedFor = async (history, params = {}) => {
    const { readJSONFile } = await import('../../lib/fileUtils.js');
    vi.mocked(readJSONFile).mockImplementation(async () => history);
    let started = null;
    const onStarted = (e) => { started = e; };
    videoGenEvents.on('started', onStarted);
    await generateVideo({
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'a quiet street at dusk',
      width: 512,
      height: 512,
      numFrames: 25,
      fps: 24,
      ...params,
    });
    videoGenEvents.off('started', onStarted);
    return started;
  };

  const timedRecord = (renderMs, over = {}) => ({
    modelId: 'ltx2_unified',
    width: 512,
    height: 512,
    numFrames: 25,
    steps: 30,
    renderMs,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...over,
  });

  it('reports an explicit null ETA on a fresh install with no measured renders', async () => {
    const started = await startedFor([], { jobId: 'eta-no-history' });
    // null, not 0 and not omitted — the client must be able to tell "unknown"
    // apart from "about to finish".
    expect(started.etaMs).toBeNull();
    expect('etaBasis' in started).toBe(false);
  });

  it('estimates from a same-shape measured render and labels the basis', async () => {
    const history = [timedRecord(1_200_000), timedRecord(1_200_000, { createdAt: '2026-07-30T00:00:00.000Z' })];
    const started = await startedFor(history, { jobId: 'eta-measured' });
    expect(started.etaMs).toBe(1_200_000);
    expect(started.etaBasis).toBe('measured');
    expect(started.etaSampleCount).toBe(2);
  });

  it('ignores measurements from a different model', async () => {
    const history = [timedRecord(1_200_000, { modelId: 'some_other_model' })];
    expect((await startedFor(history, { jobId: 'eta-other-model' })).etaMs).toBeNull();
  });

  it('scales a differently-shaped measurement by pixels × frames × steps', async () => {
    const history = [timedRecord(600_000, { numFrames: 50 })];
    const started = await startedFor(history, { jobId: 'eta-scaled' });
    // Half the frames → half the work → half the time.
    expect(started.etaMs).toBe(300_000);
    expect(started.etaBasis).toBe('proportional');
  });
});

// The reference-mode promise (#4874) at the RENDER boundary. The route gates it
// too, but persisted-queue replays, retries and internal producers all reach
// generateVideo directly — a hole here means a clip anchored under an Inspire
// label, which is precisely the lie the contract exists to prevent.
describe('generateVideo — i2v reference mode (#4874)', () => {
  const renderWithReference = async ({ jobId, modelId = 'ltx25_mlx_q8', i2vReferenceMode, imageStrength, mode = 'image' }) => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();
    let startedMeta = null;
    const onStarted = (e) => { if (e.generationId === jobId) startedMeta = e; };
    videoGenEvents.on('started', onStarted);
    await generateVideo({
      jobId,
      pythonPath: '/usr/bin/python3',
      modelId,
      prompt: 'a fox in the rain',
      width: 512, height: 512, numFrames: 25, fps: 24,
      mode,
      sourceImagePath: mode === 'image' ? '/mock/uploads/start.png' : null,
      i2vReferenceMode,
      imageStrength,
    });
    videoGenEvents.off('started', onStarted);
    const call = spawnMock.mock.calls.find(([, args]) => Array.isArray(args) && args.includes('--mode'));
    return { args: call?.[1] || [], startedMeta };
  };

  const valueAfter = (args, flag) => args[args.indexOf(flag) + 1];

  it('emits no reference-mode argv for a default (anchored) render', async () => {
    // An anchored render's argv must stay byte-identical to what it was before
    // the flag existed, so an older helper pin can still run it.
    const { args, startedMeta } = await renderWithReference({ jobId: 'ref-anchor-default' });
    expect(args).not.toContain('--i2v-reference-mode');
    expect(args).not.toContain('--image-strength');
    expect(startedMeta.i2vReferenceMode).toBeUndefined();
    expect(startedMeta.imageStrength).toBeUndefined();
  });

  it('emits the flag AND a resolved strength for a loose reference on LTX-2.5', async () => {
    const { args, startedMeta } = await renderWithReference({
      jobId: 'ref-inspire', i2vReferenceMode: 'inspire',
    });
    expect(valueAfter(args, '--i2v-reference-mode')).toBe('inspire');
    // "Unset" under Inspire cannot mean "let the pipeline decide" — that would
    // anchor. The contract's low default is substituted instead.
    expect(Number(valueAfter(args, '--image-strength'))).toBe(INSPIRE_DEFAULT_IMAGE_STRENGTH);
    // History provenance, so Remix and the gallery can describe the promise.
    expect(startedMeta.i2vReferenceMode).toBe('inspire');
    expect(startedMeta.imageStrength).toBe(INSPIRE_DEFAULT_IMAGE_STRENGTH);
  });

  it('honors an explicit strength under a loose reference', async () => {
    const { args, startedMeta } = await renderWithReference({
      jobId: 'ref-inspire-explicit', i2vReferenceMode: 'inspire', imageStrength: 0.8,
    });
    expect(Number(valueAfter(args, '--image-strength'))).toBe(0.8);
    expect(startedMeta.imageStrength).toBe(0.8);
  });

  it('rejects a loose reference on the 2.3 pin rather than silently anchoring', async () => {
    // ltx2 and ltx25 share the family predicate but not the per-image
    // conditioning API — waving this through would deliver an anchored clip.
    await expect(renderWithReference({
      jobId: 'ref-inspire-ltx2', modelId: 'ltx2_unified', i2vReferenceMode: 'inspire',
    })).rejects.toMatchObject({ status: 400, code: 'I2V_REFERENCE_MODE_UNSUPPORTED' });
  });

  it('rejects a loose reference outside image mode', async () => {
    await expect(renderWithReference({
      jobId: 'ref-inspire-text', i2vReferenceMode: 'inspire', mode: 'text',
    })).rejects.toMatchObject({ status: 400, code: 'I2V_REFERENCE_MODE_REQUIRES_IMAGE' });
  });

  it('rejects an unknown reference mode instead of collapsing it to anchor', async () => {
    await expect(renderWithReference({
      jobId: 'ref-bogus', i2vReferenceMode: 'inspiration',
    })).rejects.toMatchObject({ status: 400, code: 'I2V_REFERENCE_MODE_UNKNOWN' });
  });
});

describe('resident video batches', () => {
  it.each([
    { exitCode: 0, outputs: 2, complete: true },
    { exitCode: 1, outputs: 0, complete: false, invalidOutput: true },
    { exitCode: 1, outputs: 1, complete: false },
    { exitCode: 0, outputs: 1, complete: false },
    { exitCode: null, signal: 'SIGTERM', outputs: 1, complete: false },
  ])('persists finished outputs and ends the queue job once ($exitCode, $signal, $outputs outputs)', async ({ exitCode, signal = null, outputs, complete, invalidOutput }) => {
    const { EventEmitter } = await import('node:events');
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const { atomicWrite } = await import('../../lib/fileUtils.js');
    const { planVideoBatch } = await import('./batch.js');
    const { videoJobState } = await import('./jobState.js');
    const proc = Object.assign(new EventEmitter(), {
      pid: 12345, exitCode: null, signalCode: null, killed: false,
      stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
    });
    vi.mocked(spawnDetached).mockResolvedValueOnce(proc);
    vi.mocked(atomicWrite).mockClear();
    const jobId = randomUUID();
    const batch = planVideoBatch({ jobId, batchSize: 2, seed: 0 });
    const completed = vi.fn();
    const failed = vi.fn();
    videoGenEvents.on('completed', completed);
    videoGenEvents.on('failed', failed);
    await generateVideo({
      jobId, prompt: 'Example shot', batchSize: 2, seed: 0,
      modelId: 'minimax_h3_8bit', width: 1344, height: 768,
      numFrames: 124, fps: 24, displaySleep: false,
    });
    const job = videoJobState.jobs.get(jobId);
    const args = vi.mocked(spawnDetached).mock.calls.at(-1)[1];
    expect(JSON.parse(args[args.indexOf('--batch-seeds') + 1])).toEqual([0, 1]);
    if (invalidOutput) {
      proc.stdout.emit('data', Buffer.from(JSON.stringify({ video_path: join(MOCK_PATHS.videos, 'other.mp4'), batch_index: 0, seed: 99 }) + '\n'));
    }
    if (complete) vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    for (const item of batch.slice(0, outputs)) {
      proc.stdout.emit('data', Buffer.from(JSON.stringify({ video_path: join(MOCK_PATHS.videos, item.filename), batch_index: item.index, seed: item.seed }) + '\n'));
      if (complete && item.index === 0) {
        await vi.advanceTimersByTimeAsync(40_001);
        vi.useRealTimers();
        expect(proc.kill).not.toHaveBeenCalled();
      }
    }
    await vi.waitFor(() => expect(atomicWrite).toHaveBeenCalledTimes(outputs));
    expect(job.status).toBe('running');
    expect(completed).not.toHaveBeenCalled();
    proc.exitCode = exitCode;
    proc.signalCode = signal;
    proc.emit('close', exitCode, signal);
    await vi.waitFor(() => expect(complete ? completed : failed).toHaveBeenCalledTimes(1));
    expect(complete ? failed : completed).not.toHaveBeenCalled();
    const saved = vi.mocked(atomicWrite).mock.calls.at(-1)?.[1] || [];
    expect(saved.filter((item) => item.batchId === jobId)).toHaveLength(outputs);
    if (outputs) {
      expect(saved[0].seed).toBe(outputs - 1);
      expect(saved[0].id).toMatch(/^[a-f0-9-]{36}$/);
    }
    const terminal = (complete ? completed : failed).mock.calls[0][0];
    expect(terminal.results.map((item) => item.seed)).toEqual(complete ? [0, 1] : outputs ? [0] : []);
    if (invalidOutput) expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    else expect(proc.kill).not.toHaveBeenCalled();
  });
});

describe('generateVideo — native Extend keeps the original source (#11171)', () => {
  const extendRender = async (jobId, request) => {
    const { spliceExtendSource } = await import('./extendSplice.js');
    vi.mocked(spliceExtendSource).mockClear();
    await renderToTerminal({
      jobId,
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'a quiet street at dusk',
      width: 512, height: 512, numFrames: 25, fps: 24,
      ...request,
    });
    return vi.mocked(spliceExtendSource);
  };

  it('splices a plain extend of a source clip, sized to the extension the helper was asked for', async () => {
    const splice = await extendRender('splice-plain-extend', { mode: 'extend', extendFromVideoPath: '/mock/source.mp4' });
    // numFrames 25 → 3 latents, the same count --extend-frames carries.
    expect(splice).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      sourcePath: '/mock/source.mp4', extendLatents: 3, keepMaster: true, outputPath: expect.stringContaining('splice-plain-extend'),
    }));
  });

  it('splices the first chunk of an extend chain (the user\'s own clip) without keeping an audio master', async () => {
    const splice = await extendRender('splice-chain-first', {
      mode: 'extend', extendFromVideoPath: '/mock/source.mp4', hidden: true, keepExtendSource: true,
    });
    expect(splice).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      sourcePath: '/mock/source.mp4', extendLatents: 3, keepMaster: false,
    }));
  });

  it('leaves a chain chunk alone — the chain trims its own echoed context', async () => {
    const splice = await extendRender('splice-chain-chunk', { mode: 'extend', extendFromVideoPath: '/mock/tail-window.mp4', hidden: true });
    expect(splice).not.toHaveBeenCalled();
  });

  it('leaves a runtime whose extend is last-frame i2v alone — its output holds no source', async () => {
    const splice = await extendRender('splice-mlx-video', { modelId: 'ltx23_unified', mode: 'extend', extendFromVideoPath: '/mock/source.mp4' });
    expect(splice).not.toHaveBeenCalled();
  });

  it('does not splice a render with no source clip', async () => {
    const splice = await extendRender('splice-text', { mode: 'text' });
    expect(splice).not.toHaveBeenCalled();
  });
});

describe('generateVideo — a2v mouth-lead correction (#15409)', () => {
  const render = async (jobId, request) => {
    const { alignLipsyncLead } = await import('../../lib/lipsyncAlign.js');
    vi.mocked(alignLipsyncLead).mockClear();
    const recorder = await import('./executionRecorder.js');
    const recordDiagnostics = vi.fn(async () => true);
    recorder.setVideoExecutionRecorder({ recordExecution: vi.fn(async () => true), recordDiagnostics });
    try {
      await renderToTerminal({
        jobId, pythonPath: '/usr/bin/python3', modelId: 'ltx2_unified', prompt: 'a singer on a rooftop',
        width: 512, height: 512, numFrames: 25, fps: 24, ...request,
      });
    } finally {
      recorder.setVideoExecutionRecorder(null);
    }
    const { atomicWrite } = await import('../../lib/fileUtils.js');
    const record = vi.mocked(atomicWrite).mock.calls
      .flatMap(([, value]) => Array.isArray(value) ? value : [])
      .find(value => value.id === jobId);
    return { align: vi.mocked(alignLipsyncLead), recordDiagnostics, record };
  };

  it('aligns the finished a2v clip and records the verdict on the history item and the job receipt', async () => {
    const { align, recordDiagnostics, record } = await render('lipsync-a2v', {
      mode: 'a2v', sourceImagePath: '/mock/source.png', audioFilePath: '/mock/song.wav',
    });
    expect(align).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ videoPath: expect.stringContaining('lipsync-a2v.mp4') }));
    const verdict = { shiftFrames: 2, lag: 2, peakScore: 0.61, reason: 'mouth-lead' };
    expect(record.lipsyncAlign).toEqual(verdict);
    expect(recordDiagnostics).toHaveBeenCalledWith('lipsync-a2v', { lipsyncAlign: verdict });
  });

  it('leaves renders without conditioning audio alone', async () => {
    const { align, record } = await render('lipsync-text', { mode: 'text' });
    expect(align).not.toHaveBeenCalled();
    expect(record).not.toHaveProperty('lipsyncAlign');
  });
});
