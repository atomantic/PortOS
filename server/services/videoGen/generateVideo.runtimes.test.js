/**
 * generateVideo.runtimes.test.js
 *
 * Split from local.test.js (#16214); shared mocks live in local.testFixtures.js.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { basename, join } from 'path';
import { MINIMAX_H3_HOST_RESERVE_GB } from '../../lib/minimaxH3Memory.js';

// vi.mock factories are hoisted above imports; the shared fixtures module is
// loaded the same way so its state objects outlive vi.resetModules().
const fx = await vi.hoisted(() => import('./local.testFixtures.js'));
const { isLtx2Python, isLtx25Python, fsPromisesMock, mockInspectModelCache, mockFindCachedRepoFile, loraSidecarState, makeProc } = fx;

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
let generateVideo;
let videoGenEvents;

beforeEach(async () => {
  vi.resetModules();
  fx.resetFsPromisesReadFile();
  ({ generateChainedVideo, generateVideo } = await import('./local.js'));
  ({ videoGenEvents } = await import('./events.js'));
});

afterEach(async () => {
  await fx.resetSharedMocks();
});

const renderToTerminal = (request) => fx.renderToTerminal(generateVideo, videoGenEvents, request);

describe('generateVideo — Wan MLX-Gen contract', () => {
  it('passes the locked Lightning sampler and exact high/low adapter pair', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();
    await generateVideo({
      jobId: 'wan-lightning-args',
      modelId: 'wan22_t2v_a14b_lightning',
      prompt: 'a starship lifts off',
      negativePrompt: 'blur',
      width: 480, height: 256, numFrames: 81, fps: 20,
      steps: 99, guidanceScale: 9, mode: 'text',
    });
    const call = spawnMock.mock.calls.find(([, args]) => Array.isArray(args) && args.some((arg) => basename(String(arg)) === 'generate_wan22.py'));
    expect(call).toBeDefined();
    const args = call[1];
    expect(args[args.indexOf('--steps') + 1]).toBe('4');
    expect(args[args.indexOf('--guidance') + 1]).toBe('1');
    expect(args[args.indexOf('--guidance-2') + 1]).toBe('1');
    expect(args[args.indexOf('--flow-shift') + 1]).toBe('5');
    expect(args[args.indexOf('--solver') + 1]).toBe('euler');
    expect(args[args.indexOf('--model-repo') + 1]).toBe('/mock/hf/snap');
    expect(args.flatMap((arg, i) => arg === '--lora-path' ? [args[i + 1]] : [])).toEqual([
      join('/mock/hf/snap', 'Wan2.2-T2V-A14B-4steps-lora-rank64-Seko-V1.1/high_noise_model.safetensors'),
      join('/mock/hf/snap', 'Wan2.2-T2V-A14B-4steps-lora-rank64-Seko-V1.1/low_noise_model.safetensors'),
    ]);
    expect(args.flatMap((arg, i) => arg === '--lora-target-role' ? [args[i + 1]] : [])).toEqual([
      'high_noise_transformer',
      'low_noise_transformer',
    ]);
    expect(spawnMock.mock.calls.find(([, childArgs]) => childArgs === args)?.[2]).toMatchObject({
      killProcessGroup: true,
    });
    expect(mockInspectModelCache).toHaveBeenCalledWith(
      'AbstractFramework/wan2.2-t2v-a14b-diffusers-8bit',
      { revision: '39ee5f1f630789956f29f40b5c2c6d48c6e9a798' },
    );
    expect(mockFindCachedRepoFile).toHaveBeenCalledWith(
      'lightx2v/Wan2.2-Lightning',
      expect.any(String),
      { revision: '18bccf8884ec0a078eed79785eb4ef13ea16ce1e' },
    );
  });

  it('passes the exact ordered I2V Lightning adapter pair', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();
    await generateVideo({
      jobId: 'wan-i2v-lightning-args',
      modelId: 'wan22_i2v_a14b_lightning', prompt: 'a boat crosses a lake',
      sourceImagePath: '/mock/data/images/boat.png',
      width: 480, height: 256, numFrames: 81, fps: 20, mode: 'image',
    });
    const args = spawnMock.mock.calls.find(([, childArgs]) => childArgs.some((arg) => basename(String(arg)) === 'generate_wan22.py'))[1];
    expect(args.flatMap((arg, i) => arg === '--lora-path' ? [args[i + 1]] : [])).toEqual([
      join('/mock/hf/snap', 'Wan2.2-I2V-A14B-4steps-lora-rank64-Seko-V1/high_noise_model.safetensors'),
      join('/mock/hf/snap', 'Wan2.2-I2V-A14B-4steps-lora-rank64-Seko-V1/low_noise_model.safetensors'),
    ]);
    expect(args.flatMap((arg, i) => arg === '--lora-target-role' ? [args[i + 1]] : [])).toEqual([
      'high_noise_transformer',
      'low_noise_transformer',
    ]);
  });

  it('rejects a Wan model in an unsupported mode before spawn', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    vi.mocked(spawnDetached).mockClear();
    await expect(generateVideo({
      modelId: 'wan22_t2v_a14b_lightning', prompt: 'test',
      width: 480, height: 256, numFrames: 81, fps: 20, mode: 'image',
    })).rejects.toMatchObject({ code: 'WAN22_MODE_UNSUPPORTED' });
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it('rejects a non-4n+1 Wan frame count', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    vi.mocked(spawnDetached).mockClear();
    await expect(generateVideo({
      modelId: 'wan22_ti2v_5b', prompt: 'test',
      width: 480, height: 256, numFrames: 82, fps: 20, mode: 'text',
    })).rejects.toMatchObject({ code: 'WAN22_INVALID_FRAME_COUNT' });
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it('rejects image mode without a source before cache or spawn work', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    vi.mocked(spawnDetached).mockClear();
    await expect(generateVideo({
      modelId: 'wan22_i2v_a14b_lightning', prompt: 'test',
      width: 480, height: 256, numFrames: 81, fps: 20, mode: 'image',
    })).rejects.toMatchObject({ code: 'WAN22_I2V_REQUIRES_IMAGE' });
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it('rejects text mode with a source before cache or spawn work', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    vi.mocked(spawnDetached).mockClear();
    await expect(generateVideo({
      modelId: 'wan22_ti2v_5b', prompt: 'test', sourceImagePath: '/mock/source.png',
      width: 480, height: 256, numFrames: 81, fps: 20, mode: 'text',
    })).rejects.toMatchObject({ code: 'WAN22_TEXT_MODE_SOURCE_CONFLICT' });
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it('rejects a missing immutable base snapshot before spawn', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    vi.mocked(spawnDetached).mockClear();
    mockInspectModelCache.mockResolvedValueOnce({ cached: false, snapshotPath: null, sizeBytes: 0 });
    await expect(generateVideo({
      modelId: 'wan22_ti2v_5b', prompt: 'test',
      width: 480, height: 256, numFrames: 81, fps: 20, mode: 'text',
    })).rejects.toMatchObject({ code: 'WAN22_MODEL_NOT_CACHED' });
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it('rejects mismatched Wan dependency roles before staging or spawning', async () => {
    const { getVideoModels } = await import('../../lib/mediaModels.js');
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const catalog = getVideoModels();
    vi.mocked(getVideoModels).mockReturnValueOnce(catalog.map((model) => (
      model.id === 'wan22_t2v_a14b_lightning'
        ? { ...model, requiredWeights: [{ ...model.requiredWeights[0], targetRoles: ['high_noise_transformer'] }] }
        : model
    )));

    await expect(generateVideo({
      modelId: 'wan22_t2v_a14b_lightning', prompt: 'a quiet lake',
      width: 480, height: 256, numFrames: 81, fps: 20, mode: 'text',
    })).rejects.toMatchObject({
      status: 500, code: 'VIDEO_MODEL_MISCONFIGURED',
      message: 'Wan model "wan22_t2v_a14b_lightning" has an invalid requiredWeights entry.',
    });
    expect(mockFindCachedRepoFile).not.toHaveBeenCalled();
    expect(fsPromisesMock.mkdtemp).not.toHaveBeenCalled();
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it('rejects a partially cached Wan adapter pair before staging or spawning', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    mockFindCachedRepoFile
      .mockResolvedValueOnce('/mock/hf/high_noise_model.safetensors')
      .mockResolvedValueOnce(null);

    await expect(generateVideo({
      modelId: 'wan22_t2v_a14b_lightning', prompt: 'a quiet lake',
      width: 480, height: 256, numFrames: 81, fps: 20, mode: 'text',
    })).rejects.toMatchObject({
      status: 400, code: 'WAN22_REQUIRED_WEIGHT_NOT_CACHED',
      message: 'Wan T2V Lightning is missing required weight Wan2.2-T2V-A14B-4steps-lora-rank64-Seko-V1.1/low_noise_model.safetensors. Download or repair its dependencies in Video Gen.',
    });
    expect(fsPromisesMock.mkdtemp).not.toHaveBeenCalled();
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it('rejects a T2V-only Wan chain before rendering chunk one', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    vi.mocked(spawnDetached).mockClear();
    await expect(generateChainedVideo({
      chunks: 2, jobId: 'wan-chain-reject', modelId: 'wan22_t2v_a14b_lightning',
      prompt: 'test', width: 480, height: 256, numFrames: 81, fps: 20, mode: 'text',
    })).rejects.toMatchObject({ code: 'WAN22_CHAIN_REQUIRES_IMAGE_MODE' });
    expect(spawnDetached).not.toHaveBeenCalled();
  });
});

describe('generateVideo — MiniMax H3 MLX contract', () => {
  it('fails the owning assertion when mocked render completion fails', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    vi.mocked(spawnDetached).mockImplementationOnce(async () => makeProc(1));
    await expect(renderToTerminal({
      jobId: 'h3-terminal-failure', modelId: 'minimax_h3_8bit',
      prompt: 'Synthetic completion failure', mode: 'text',
    })).rejects.toThrow(/failed/);
  });

  it('refuses explicit temporal replay and direct history before resolving assets or spawning', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    vi.mocked(spawnDetached).mockClear();
    for (const conditioning of [
      { continuityStrategy: 'window', contextFrames: 17 },
      { historyContext: { sourceVideoPath: '/mock/prior.mp4', endFrame: 124, frames: 17 } },
    ]) {
      await expect(generateVideo({ modelId: 'minimax_h3_8bit', prompt: 'A paper boat on a pond',
        ...conditioning })).rejects.toMatchObject({ code: 'VIDEO_TEMPORAL_UNAVAILABLE' });
    }
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it('records current frame behavior instead of replaying stale window provenance', async () => {
    const { atomicWrite } = await import('../../lib/fileUtils.js');
    const jobId = 'h3-stale-window-provenance';
    await renderToTerminal({
      jobId, modelId: 'minimax_h3_8bit', prompt: 'A paper boat on a pond',
      mode: 'text', numFrames: 124, fps: 24,
      continuation: {
        requestedStrategy: 'auto', effectiveStrategy: 'window',
        contextFrames: 22, actualHistoryFrames: 22, runtime: 'ltx2',
        capability: true, backendPin: null, unavailableReason: null,
      },
    });
    const record = vi.mocked(atomicWrite).mock.calls
      .flatMap(([, value]) => Array.isArray(value) ? value : [])
      .find(value => value.id === jobId);
    expect(record.continuation).toMatchObject({
      requestedStrategy: 'auto', effectiveStrategy: 'frame', actualHistoryFrames: 0,
      contextFrames: 0, runtime: 'minimax_h3', capability: false,
    });
  });

  // H3 anchors keyframes at the first/last latent frame only, so the ltx2
  // arbitrary-index array and every non-keyframe conditioning channel stay out.
  it.each([
    ['keyframes', { keyframes: [{ path: '/mock/first.png', frame: 0 }, { path: '/mock/last.png', frame: 140 }] }],
    ['extension video', { mode: 'extend', extendFromVideoPath: '/mock/prior.mp4' }],
    ['audio file', { mode: 'a2v', audioFilePath: '/mock/audio.wav' }],
    ['IC reference', { mode: 'ic-restyle', icReferencePaths: ['/mock/reference.mp4'] }],
  ])('rejects direct %s conditioning before any child is spawned', async (_label, conditioning) => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    vi.mocked(spawnDetached).mockClear();

    await expect(generateVideo({
      jobId: 'h3-conditioning',
      modelId: 'minimax_h3_8bit',

      prompt: 'a fox watches the rain',
      width: 512, height: 320, numFrames: 141, fps: 24,
      ...conditioning,
    })).rejects.toMatchObject({ code: 'MINIMAX_H3_MODE_UNSUPPORTED' });

    expect(spawnDetached).not.toHaveBeenCalled();
  });

  // Each mode has exactly one legal image shape; a mismatch must fail rather
  // than silently render a different clip than the caller asked for.
  it.each([
    ['text mode with a source image', { mode: 'text', sourceImagePath: '/mock/source.png' }, 'MINIMAX_H3_TEXT_MODE_SOURCE_CONFLICT'],
    ['image mode with no image', { mode: 'image' }, 'MINIMAX_H3_I2V_REQUIRES_IMAGE'],
    ['image mode with a last frame', { mode: 'image', sourceImagePath: '/mock/source.png', lastImagePath: '/mock/last.png' }, 'MINIMAX_H3_I2V_LAST_IMAGE_CONFLICT'],
    ['fflf mode with no frames', { mode: 'fflf' }, 'MINIMAX_H3_FFLF_REQUIRES_IMAGE'],
  ])('rejects %s before any child is spawned', async (_label, fields, code) => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    vi.mocked(spawnDetached).mockClear();

    await expect(generateVideo({
      jobId: 'h3-image-shape',
      modelId: 'minimax_h3_8bit',

      prompt: 'a fox watches the rain',
      width: 512, height: 320, numFrames: 141, fps: 24,
      ...fields,
    })).rejects.toMatchObject({ code });

    expect(spawnDetached).not.toHaveBeenCalled();
  });

  // The helper stretches the FIRST keyframe onto the canvas as the geometry
  // anchor, so packed order has to put the first frame ahead of the last.
  it.each([
    ['image', { mode: 'image', sourceImagePath: '/mock/source.png' }, ['first']],
    ['fflf', { mode: 'fflf', sourceImagePath: '/mock/source.png', lastImagePath: '/mock/last.png' }, ['first', 'last']],
    ['fflf with only a last frame', { mode: 'fflf', lastImagePath: '/mock/last.png' }, ['last']],
    ['text', { mode: 'text' }, []],
  ])('forwards %s conditioning as anchored --image pairs', async (_label, fields, expectedAnchors) => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();

    await renderToTerminal({
      jobId: 'h3-keyframes',
      modelId: 'minimax_h3_8bit',

      prompt: 'a fox watches the rain',
      width: 512, height: 320, numFrames: 141, fps: 24,
      ...fields,
    });

    const [, args] = spawnMock.mock.calls.find(([, a]) => (
      Array.isArray(a) && a.some((arg) => basename(String(arg)) === 'generate_minimax_h3.py')
    ));
    // Paths are the ffmpeg-resized copies, so assert the anchors and that each
    // one directly follows its own --image rather than the literal input path.
    expect(args.flatMap((arg, i) => (
      arg === '--image' ? [args[i + 2] === '--anchor' ? args[i + 3] : 'UNPAIRED'] : []
    ))).toEqual(expectedAnchors);
  });

  it('cancel() while first-run weights are still preparing answers pending and never spawns', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const { cancel } = await import('./local.js');
    const { videoJobState } = await import('./jobState.js');
    const errors = vi.spyOn(console, 'error');
    vi.mocked(spawnDetached).mockClear();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let enteredWeights;
    const entered = new Promise((resolve) => { enteredWeights = resolve; });
    // quant_config.json is probed only by ensureMiniMaxH3Weights.
    mockFindCachedRepoFile.mockImplementation(async (_repo, filename) => {
      if (filename === 'quant_config.json') {
        enteredWeights();
        await gate;
      }
      return join('/mock/hf/snap', filename);
    });
    try {
      const rendering = generateVideo({
        jobId: 'h3-cancel-while-preparing',
        modelId: 'minimax_h3_8bit',
        prompt: 'a fox watches the rain',
        width: 512, height: 320, numFrames: 141, fps: 24, mode: 'text',
      });
      const refused = expect(rendering).rejects.toMatchObject({ code: 'VIDEO_GEN_CANCELED' });
      await entered;
      expect(cancel()).toBe('pending');
      release();
      await refused;
      expect(videoJobState.jobs.get('h3-cancel-while-preparing')).toMatchObject({
        status: 'canceled', lastPayload: { type: 'canceled', reason: 'Canceled' },
      });
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      mockFindCachedRepoFile.mockImplementation(async (_repo, filename) => join('/mock/hf/snap', filename));
    }
    expect(spawnDetached).not.toHaveBeenCalled();
    // Preparation ended with the render, so a later cancel has nothing to claim.
    expect(cancel()).toBe(false);
  });

  it('uses the pinned cache-only helper, locked sampler and credential-free environment', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const { hfChildEnv } = await import('../hfToken.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();
    vi.mocked(hfChildEnv).mockClear();
    const priorToken = process.env.HF_TOKEN;
    const priorHubToken = process.env.HUGGING_FACE_HUB_TOKEN;
    process.env.HF_TOKEN = 'test-secret';
    process.env.HUGGING_FACE_HUB_TOKEN = 'test-secret-2';

    try {
      await renderToTerminal({
        jobId: 'h3-args',
        modelId: 'minimax_h3_8bit',

        prompt: 'a fox watches the rain',
        width: 1536, height: 672, numFrames: 107, fps: 24,
        steps: 99, guidanceScale: 12, mode: 'text',
      });
    } finally {
      if (priorToken === undefined) delete process.env.HF_TOKEN; else process.env.HF_TOKEN = priorToken;
      if (priorHubToken === undefined) delete process.env.HUGGING_FACE_HUB_TOKEN;
      else process.env.HUGGING_FACE_HUB_TOKEN = priorHubToken;
    }

    const call = spawnMock.mock.calls.find(([, args]) => (
      Array.isArray(args) && args.some((arg) => basename(String(arg)) === 'generate_minimax_h3.py')
    ));
    expect(call).toBeDefined();
    const [bin, args, options] = call;
    expect(String(bin)).toContain(join('.portos', 'minimax-h3-mlx', '.venv', 'bin', 'python3'));
    expect(args[args.indexOf('--model-repo') + 1]).toBe('pipenetwork/MiniMax-H3-MLX-8bit');
    expect(args[args.indexOf('--model-revision') + 1]).toBe('3ac52081470b0488921c3ec3ba84a39097bf2361');
    expect(args[args.indexOf('--runtime-revision') + 1]).toBe('fcd9e9b79a1d6018d91ac477c0968de1fa067e49');
    expect(args[args.indexOf('--checkpoint-repo') + 1]).toBe('MiniMaxAI/MiniMax-H3');
    expect(args[args.indexOf('--checkpoint-revision') + 1]).toBe('6818f6c32d12b210915e44ad56a4228c2608f160');
    expect(args[args.indexOf('--width') + 1]).toBe('1536');
    expect(args[args.indexOf('--height') + 1]).toBe('672');
    expect(args[args.indexOf('--num-frames') + 1]).toBe('107');
    expect(args[args.indexOf('--steps') + 1]).toBe('8');
    expect(args[args.indexOf('--preview-dir') + 1]).toContain('portos-video-stepwise-');
    expect(args.flatMap((arg, i) => arg === '--checkpoint-file' ? [args[i + 1]] : []))
      .toEqual(['LICENSE', 'FL2VA/vae/video/config.json']);
    expect(options.killProcessGroup).toBe(true);
    expect(options.env).toMatchObject({
      HF_HUB_DISABLE_IMPLICIT_TOKEN: '1',
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      PYTHONUNBUFFERED: '1',
    });
    expect(options.env).not.toHaveProperty('HF_TOKEN');
    expect(options.env).not.toHaveProperty('HUGGING_FACE_HUB_TOKEN');
    expect(hfChildEnv).not.toHaveBeenCalled();
  });

  it('forwards the newest preview as currentImage and ignores events after teardown', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const { watch } = await import('fs');
    const { readFile } = await import('fs/promises');
    const listeners = {};
    const proc = {
      pid: 6789,
      exitCode: null,
      signalCode: null,
      killed: false,
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on(event, fn) { listeners[event] = fn; return proc; },
      off(event, fn) { if (listeners[event] === fn) delete listeners[event]; return proc; },
      kill: vi.fn(),
    };
    vi.mocked(spawnDetached).mockImplementationOnce(async () => proc);
    const progress = [];
    const onProgress = (event) => {
      if (event.generationId === 'preview-current-image') progress.push(event);
    };
    videoGenEvents.on('progress', onProgress);

    try {
      await generateVideo({
        jobId: 'preview-current-image',
        pythonPath: '/usr/bin/python3',
        modelId: 'ltx2_unified',
        prompt: 'a quiet street at dusk',
        width: 512,
        height: 512,
        numFrames: 25,
        fps: 24,
      });
      const watchCall = vi.mocked(watch).mock.calls.at(-1);
      expect(watchCall[0]).toContain('portos-video-stepwise-');
      vi.mocked(readFile).mockResolvedValueOnce(Buffer.from('frame-one'));
      watchCall[1]('rename', 'preview.png');
      await new Promise((resolve) => setImmediate(resolve));
      expect(progress).toContainEqual({
        generationId: 'preview-current-image',
        currentImage: Buffer.from('frame-one').toString('base64'),
      });

      listeners.close?.(1, null);
      await new Promise((resolve) => setImmediate(resolve));
      vi.mocked(readFile).mockResolvedValueOnce(Buffer.from('stale-frame'));
      watchCall[1]('rename', 'preview.png');
      await new Promise((resolve) => setImmediate(resolve));
      expect(progress).toHaveLength(1);
    } finally {
      videoGenEvents.off('progress', onProgress);
    }
  });

  // Substituted prompt conditioner (#4081). The whole override path has to stay
  // dormant unless it was asked for — an unswapped render's argv must be
  // byte-identical to what it was before the feature existed.
  it.each([undefined, null, 'stock'])('adds no text-encoder argv for %j', async (textEncoderId) => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();

    await renderToTerminal({
      jobId: 'h3-stock-encoder',
      modelId: 'minimax_h3_8bit',
      prompt: 'a fox watches the rain',
      mode: 'text',
      textEncoderId,
    });

    const [, args] = spawnMock.mock.calls.find(([, a]) => (
      Array.isArray(a) && a.some((arg) => basename(String(arg)) === 'generate_minimax_h3.py')
    ));
    expect(args.filter((arg) => String(arg).startsWith('--text-encoder'))).toEqual([]);
  });

  it('forwards a substituted text encoder as a resolved path plus its key remap', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();

    await renderToTerminal({
      jobId: 'h3-swapped-encoder',
      modelId: 'minimax_h3_8bit',
      prompt: 'a fox watches the rain',
      mode: 'text',
      textEncoderId: 'heretic-bf16',
    });

    const [, args] = spawnMock.mock.calls.find(([, a]) => (
      Array.isArray(a) && a.some((arg) => basename(String(arg)) === 'generate_minimax_h3.py')
    ));
    expect(args[args.indexOf('--text-encoder-id') + 1]).toBe('heretic-bf16');
    // A resolved cache path, never a repo id — the helper runs fully offline
    // (HF_HUB_OFFLINE=1) and cannot look one up.
    expect(args[args.indexOf('--text-encoder-file') + 1])
      .toBe(join('/mock/hf/snap', 'qwen3vl_32b_h3_ultra_uncensored_heretic_bf16.safetensors'));
    // Outside the pinned checkout: anything written inside it would read as
    // untracked in the pin verification the helper itself runs.
    const shimRoot = args[args.indexOf('--text-encoder-shim-root') + 1];
    expect(shimRoot).toContain(join('.portos', 'minimax-h3-encoder-shims'));
    expect(shimRoot).not.toContain(join('.portos', 'minimax-h3-mlx'));
    expect(args.flatMap((arg, i) => (arg === '--text-encoder-key-prefix' ? [args[i + 1]] : [])))
      .toEqual(['model.=model.language_model.', 'visual.=model.visual.']);
    expect(args[args.indexOf('--text-encoder-final-norm-key') + 1]).toBe('model.norm.weight');
  });

  it('records the requested text encoder on the history row only when swapped', async () => {
    const seen = [];
    const onStarted = (e) => seen.push(e);
    videoGenEvents.on('started', onStarted);
    try {
      await renderToTerminal({ jobId: 'h3-rec-encoder', modelId: 'minimax_h3_8bit', prompt: 'a fox', mode: 'text', textEncoderId: 'heretic-bf16' });
      await renderToTerminal({ jobId: 'h3-rec-stock', modelId: 'minimax_h3_8bit', prompt: 'a fox', mode: 'text' });
    } finally { videoGenEvents.off('started', onStarted); }
    expect(seen.find((e) => e.generationId === 'h3-rec-encoder').textEncoderId).toBe('heretic-bf16');
    expect('textEncoderId' in seen.find((e) => e.generationId === 'h3-rec-stock')).toBe(false);
  });

  // An upstream conditioner arrives as several shards, and the loader globs the
  // shim directory — so every pinned shard has to reach the helper. Forwarding
  // just the first would load a module tree with most of its layers missing.
  it('forwards every shard of a multi-shard text encoder', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const { downloadableVideoTextEncoder } = await import('../../lib/videoTextEncoders.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();

    await renderToTerminal({
      jobId: 'h3-multishard-encoder',
      modelId: 'minimax_h3_8bit',
      prompt: 'a fox watches the rain',
      mode: 'text',
      textEncoderId: 'huihui-abliterated',
    });

    const [, args] = spawnMock.mock.calls.find(([, a]) => (
      Array.isArray(a) && a.some((arg) => basename(String(arg)) === 'generate_minimax_h3.py')
    ));
    const forwarded = args.flatMap((arg, i) => (arg === '--text-encoder-file' ? [args[i + 1]] : []));
    expect(forwarded).toEqual(
      downloadableVideoTextEncoder('huihui-abliterated').files.map((name) => join('/mock/hf/snap', name)),
    );
    // Upstream namespace, own final norm — neither adapter is emitted.
    expect(args).not.toContain('--text-encoder-key-prefix');
    expect(args).not.toContain('--text-encoder-final-norm-key');
  });

  // A partially-cached multi-shard conditioner (one shard interrupted) must fail
  // as a clean 400, not load a module tree with missing parameters.
  it('rejects a multi-shard text encoder missing any one shard', async () => {
    mockFindCachedRepoFile.mockImplementation(async (_repo, filename) => (
      filename === 'model-00011-of-00014.safetensors' ? null : join('/mock/hf/snap', filename)
    ));
    try {
      await expect(generateVideo({
        jobId: 'h3-multishard-partial',
        modelId: 'minimax_h3_8bit',
        prompt: 'a fox watches the rain',
        mode: 'text',
        textEncoderId: 'huihui-abliterated',
      })).rejects.toMatchObject({ status: 400, code: 'VIDEO_TEXT_ENCODER_NOT_CACHED' });
    } finally {
      mockFindCachedRepoFile.mockImplementation(async (_repo, filename) => join('/mock/hf/snap', filename));
    }
  });

  // A ~48 GB weight that isn't downloaded must fail as a clean 400 on the
  // request, not minutes into the render when the helper's cache probe misses.
  it('rejects a substituted text encoder that is not downloaded', async () => {
    mockFindCachedRepoFile.mockImplementation(async (_repo, filename) => (
      filename.includes('ultra_uncensored_heretic') ? null : join('/mock/hf/snap', filename)
    ));
    try {
      await expect(generateVideo({
        jobId: 'h3-encoder-missing',
        modelId: 'minimax_h3_8bit',
        prompt: 'a fox watches the rain',
        mode: 'text',
        textEncoderId: 'heretic-bf16',
      })).rejects.toMatchObject({ status: 400, code: 'VIDEO_TEXT_ENCODER_NOT_CACHED' });
    } finally {
      mockFindCachedRepoFile.mockImplementation(async (_repo, filename) => join('/mock/hf/snap', filename));
    }
  });

  it('rejects a text encoder the model has no remap for', async () => {
    await expect(generateVideo({
      jobId: 'h3-encoder-unknown',
      modelId: 'minimax_h3_8bit',
      prompt: 'a fox watches the rain',
      mode: 'text',
      textEncoderId: 'not-a-real-encoder',
    })).rejects.toMatchObject({ status: 400, code: 'VIDEO_TEXT_ENCODER_UNSUPPORTED' });
  });

  it('uses H3 native dimensions when an internal caller omits resolution', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();

    await renderToTerminal({
      jobId: 'h3-native-default',
      modelId: 'minimax_h3_8bit',
      prompt: 'a fox watches the rain',
      mode: 'text',
    });

    const [, args] = spawnMock.mock.calls.find(([, childArgs]) => (
      Array.isArray(childArgs) && childArgs.some((arg) => basename(String(arg)) === 'generate_minimax_h3.py')
    ));
    expect(args[args.indexOf('--width') + 1]).toBe('1344');
    expect(args[args.indexOf('--height') + 1]).toBe('768');
    expect(args[args.indexOf('--num-frames') + 1]).toBe('124');
  });

  it('falls back when user-edited model defaults are not valid dimensions', async () => {
    const mediaModels = await import('../../lib/mediaModels.js');
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const getVideoModelsMock = vi.mocked(mediaModels.getVideoModels);
    const catalog = getVideoModelsMock();
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();
    getVideoModelsMock.mockReturnValue(catalog.map((model) => (
      model.id === 'minimax_h3_8bit'
        ? { ...model, defaultWidth: '', defaultHeight: 'not-a-number' }
        : model
    )));

    try {
      await renderToTerminal({
        jobId: 'h3-invalid-native-default',
        modelId: 'minimax_h3_8bit',
        prompt: 'a fox watches the rain',
        mode: 'text',
      });
    } finally {
      getVideoModelsMock.mockReturnValue(catalog);
    }

    const [, args] = spawnMock.mock.calls.find(([, childArgs]) => (
      Array.isArray(childArgs) && childArgs.some((arg) => basename(String(arg)) === 'generate_minimax_h3.py')
    ));
    expect(args[args.indexOf('--width') + 1]).toBe('768');
    expect(args[args.indexOf('--height') + 1]).toBe('512');
  });

  // Capacity bounding (#5420). The floors live in lib/minimaxH3Memory.js and are
  // unit-tested there; what these two pin is that the render boundary is WIRED
  // to them — that the contract reaches the helper's argv, and that a box below
  // every profile is refused before a child exists rather than after an hour of
  // loading weights it can never hold.
  it.each([
    ['minimax_h3_8bit', 'generate_minimax_h3.py', 'unified-8bit'],
    ['minimax_h3_cuda', 'generate_minimax_h3_cuda.py', null],
  ])('hands %s its host-memory contract', async (modelId, helper, expectedProfile) => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();

    await renderToTerminal({
      jobId: `h3-memory-${modelId}`,
      modelId,
      prompt: 'a fox watches the rain',
      width: 1344, height: 768, numFrames: 124, fps: 24, mode: 'text',
    });

    const [, args] = spawnMock.mock.calls.find(([, childArgs]) => (
      Array.isArray(childArgs) && childArgs.some((arg) => basename(String(arg)) === helper)
    ));
    expect(args[args.indexOf('--min-system-memory-gb') + 1]).toBe(modelId === 'minimax_h3_8bit' ? '128' : '1');
    expect(args[args.indexOf('--memory-headroom-gb') + 1]).toBe(String(MINIMAX_H3_HOST_RESERVE_GB));
    // Only the MLX lane takes a server-selected profile: on CUDA the tier is
    // VRAM-driven, so it stays the runner's call on --offload-profile.
    if (expectedProfile) expect(args[args.indexOf('--memory-profile') + 1]).toBe(expectedProfile);
    else expect(args).not.toContain('--memory-profile');
  });

  // Reusable prompt embeddings (#5443). The keying, retention and every
  // degradation path are unit-tested against the runner in
  // scripts/ml/generate_minimax_h3.test.js; what this pins is that the render
  // boundary WIRES the cache at all, and that it stays on the MLX lane — the
  // diffusers CUDA runner has no such flag and would exit on an unknown one.
  it.each([
    ['minimax_h3_8bit', 'generate_minimax_h3.py', true],
    ['minimax_h3_cuda', 'generate_minimax_h3_cuda.py', false],
  ])('gives %s a prompt-embedding cache only where the runner has one', async (modelId, helper, cached) => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    // Imported here rather than at the top of the file: this module is vi.mocked
    // above, and a static import would read it before the mock is installed.
    const { MINIMAX_H3_PROMPT_EMBEDDING_CACHE_DIR } = await import('./runtimes.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();

    await renderToTerminal({
      jobId: `h3-embed-cache-${modelId}`,
      modelId,
      prompt: 'a fox watches the rain',
      width: 1344, height: 768, numFrames: 124, fps: 24, mode: 'text',
    });

    const [, args] = spawnMock.mock.calls.find(([, childArgs]) => (
      Array.isArray(childArgs) && childArgs.some((arg) => basename(String(arg)) === helper)
    ));
    if (cached) {
      expect(args[args.indexOf('--prompt-embedding-cache-dir') + 1])
        .toBe(MINIMAX_H3_PROMPT_EMBEDDING_CACHE_DIR);
    } else {
      expect(args).not.toContain('--prompt-embedding-cache-dir');
    }
  });

  it('refuses a render this machine cannot hold, before any child is spawned', async () => {
    const mediaModels = await import('../../lib/mediaModels.js');
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const getVideoModelsMock = vi.mocked(mediaModels.getVideoModels);
    const catalog = getVideoModelsMock();
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();
    getVideoModelsMock.mockReturnValue(catalog.map((model) => (
      model.id === 'minimax_h3_8bit'
        ? { ...model, memoryProfiles: [{ ...model.memoryProfiles[0], minMemoryGb: 1e6 }] }
        : model
    )));

    try {
      await expect(generateVideo({
        jobId: 'h3-memory-refused',
        modelId: 'minimax_h3_8bit',
        prompt: 'a fox watches the rain',
        width: 1344, height: 768, numFrames: 124, fps: 24, mode: 'text',
      })).rejects.toMatchObject({ code: 'MINIMAX_H3_MEMORY_INSUFFICIENT', status: 400 });
    } finally {
      getVideoModelsMock.mockReturnValue(catalog);
    }

    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('generateVideo — MiniMax H3 CUDA contract', () => {
  const cudaCall = (spawnMock) => spawnMock.mock.calls.find(([, args]) => (
    Array.isArray(args) && args.some((arg) => basename(String(arg)) === 'generate_minimax_h3_cuda.py')
  ));

  it('dispatches to the CUDA helper and venv, never to the MLX port or generate_win.py', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();

    await renderToTerminal({
      jobId: 'h3-cuda-args',
      modelId: 'minimax_h3_cuda',
      prompt: 'a fox watches the rain',
      width: 1344, height: 768, numFrames: 141, fps: 24,
      steps: 99, guidanceScale: 12, mode: 'text',
    });

    const call = cudaCall(spawnMock);
    expect(call).toBeDefined();
    const [bin, args, options] = call;
    expect(String(bin)).toContain(join('.portos', 'minimax-h3-cuda'));
    // The MLX port's checkout flags describe a runtime this lane doesn't have.
    expect(args).not.toContain('--runtime-dir');
    expect(args).not.toContain('--runtime-revision');
    expect(args).not.toContain('--checkpoint-repo');
    expect(args[args.indexOf('--model-repo') + 1]).toBe('MiniMaxAI/MiniMax-H3');
    expect(args[args.indexOf('--model-revision') + 1]).toBe('42ed227ee7df40d41602854ae760620d6eb651fe');
    expect(args[args.indexOf('--width') + 1]).toBe('1344');
    expect(args[args.indexOf('--num-frames') + 1]).toBe('141');
    // The sampler is locked, so a caller's steps/guidance are ignored.
    expect(args[args.indexOf('--steps') + 1]).toBe('8');
    // One --repo-file per pinned component file; this is what keeps the runner
    // cache-only against a repo whose full snapshot is ~498 GB.
    expect(args.flatMap((arg, i) => (arg === '--repo-file' ? [args[i + 1]] : [])))
      .toEqual(['modular_model_index.json', 'transformer/config.json']);
    // H3's repos are public and the runner never reaches the network, so no
    // ambient credential is handed to the child — same posture as the MLX lane.
    expect(options.env).toMatchObject({
      HF_HUB_DISABLE_IMPLICIT_TOKEN: '1',
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
    });
    expect(options.env).not.toHaveProperty('HF_TOKEN');
    expect(options.killProcessGroup).toBe(true);
  });

  it('anchors both keyframes, in packed order', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();

    await renderToTerminal({
      jobId: 'h3-cuda-fflf',
      modelId: 'minimax_h3_cuda',
      prompt: 'a fox watches the rain',
      width: 1344, height: 768, numFrames: 141, fps: 24,
      mode: 'fflf', sourceImagePath: '/mock/source.png', lastImagePath: '/mock/last.png',
    });

    const [, args] = cudaCall(spawnMock);
    expect(args.flatMap((arg, i) => (
      arg === '--image' ? [args[i + 2] === '--anchor' ? args[i + 3] : 'UNPAIRED'] : []
    ))).toEqual(['first', 'last']);
  });

  it('enforces its own frame window, not the MLX port\'s', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    vi.mocked(spawnDetached).mockClear();

    // 107 is legal on the MLX grid and illegal here — the check has to read the
    // entry's own frameOptions or the two lanes silently share one window.
    await expect(generateVideo({
      jobId: 'h3-cuda-frames',
      modelId: 'minimax_h3_cuda',
      prompt: 'a fox watches the rain',
      width: 1344, height: 768, numFrames: 107, fps: 24, mode: 'text',
    })).rejects.toMatchObject({ code: 'MINIMAX_H3_INVALID_FRAME_COUNT' });
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it.each([
    ['a negative prompt', { negativePrompt: 'blurry' }, 'MINIMAX_H3_NEGATIVE_PROMPT_UNSUPPORTED'],
    ['disabled audio', { disableAudio: true }, 'MINIMAX_H3_AUDIO_REQUIRED'],
    ['a tiling mode', { tiling: 'spatial' }, 'MINIMAX_H3_TILING_UNSUPPORTED'],
    ['a non-24 fps', { fps: 30 }, 'MINIMAX_H3_INVALID_FPS'],
  ])('rejects %s before any child is spawned', async (_label, fields, code) => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    vi.mocked(spawnDetached).mockClear();

    await expect(generateVideo({
      jobId: 'h3-cuda-controls',
      modelId: 'minimax_h3_cuda',
      prompt: 'a fox watches the rain',
      width: 1344, height: 768, numFrames: 141, fps: 24, mode: 'text',
      ...fields,
    })).rejects.toMatchObject({ code });
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  // `offloadProfile` is an optional per-install override in data/media-models.json,
  // so it arrives unvalidated. The helper's argparse `choices=` would catch a typo
  // too, but only as an opaque non-zero child exit after the render was queued.
  it.each([
    ['int8-lean', true],
    ['bf16', true],
    ['int8-leaan', false],
  ])('validates a declared offloadProfile %j before spawning', async (profile, legal) => {
    const mediaModels = await import('../../lib/mediaModels.js');
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const getVideoModelsMock = vi.mocked(mediaModels.getVideoModels);
    const catalog = getVideoModelsMock();
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();
    getVideoModelsMock.mockReturnValue(catalog.map((model) => (
      model.id === 'minimax_h3_cuda' ? { ...model, offloadProfile: profile } : model
    )));

    const render = () => renderToTerminal({
      jobId: `h3-cuda-offload-${profile}`,
      modelId: 'minimax_h3_cuda',
      prompt: 'a fox watches the rain',
      width: 1344, height: 768, numFrames: 141, fps: 24, mode: 'text',
    });

    try {
      if (!legal) {
        await expect(render()).rejects.toMatchObject({ code: 'VIDEO_MODEL_MISCONFIGURED' });
        expect(spawnDetached).not.toHaveBeenCalled();
        return;
      }
      await render();
      const [, args] = cudaCall(spawnMock);
      expect(args[args.indexOf('--offload-profile') + 1]).toBe(profile);
    } finally {
      getVideoModelsMock.mockReturnValue(catalog);
    }
  });

  // Absent is the shipped state: the registry syncs between peers and cannot
  // know what GPU is on the other end, so the helper sizes the recipe itself.
  it('omits --offload-profile entirely when the entry declares none', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();

    await renderToTerminal({
      jobId: 'h3-cuda-offload-default',
      modelId: 'minimax_h3_cuda',
      prompt: 'a fox watches the rain',
      width: 1344, height: 768, numFrames: 141, fps: 24, mode: 'text',
    });

    const [, args] = cudaCall(spawnMock);
    expect(args).not.toContain('--offload-profile');
  });
});

describe('generateVideo — LTX-2.5 CUDA contract', () => {
  const ltx25Call = (spawnMock) => spawnMock.mock.calls.find(([, args]) => (
    Array.isArray(args) && args.some((arg) => basename(String(arg)) === 'generate_ltx25_cuda.py')
  ));

  it('dispatches a cache-only first-frame render through the dedicated streamed runtime', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();

    await generateVideo({
      jobId: 'ltx25-cuda-args',
      modelId: 'ltx25_cuda_distilled',
      prompt: 'a fox watches the rain',
      width: 768, height: 512, numFrames: 121, fps: 24,
      steps: 99, guidanceScale: 12, mode: 'image',
      sourceImagePath: '/mock/source.png', imageStrength: 0.7,
      disableAudio: true,
    });

    const call = ltx25Call(spawnMock);
    expect(call).toBeDefined();
    const [bin, args, options] = call;
    expect(String(bin)).toContain(join('.portos', 'ltx-2.5-cuda'));
    expect(args[args.indexOf('--model-repo') + 1]).toBe('Lightricks/LTX-2.5');
    expect(args[args.indexOf('--model-revision') + 1])
      .toBe('bf86adedf518142442575d1ce2e767b7d01c8c76');
    expect(args[args.indexOf('--steps') + 1]).toBe('8');
    expect(args).not.toContain('--guidance');
    expect(basename(args[args.indexOf('--image') + 1]))
      .toBe('resized-src-ltx25-cuda-args.png');
    expect(args[args.indexOf('--image-strength') + 1]).toBe('0.7');
    expect(args).toContain('--disable-audio');
    expect(args.flatMap((arg, i) => (arg === '--repo-file' ? [args[i + 1]] : []))).toEqual([
      'diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors',
      'text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors',
    ]);
    expect(options.env).toMatchObject({
      HF_HUB_DISABLE_IMPLICIT_TOKEN: '1',
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
    });
    expect(options.killProcessGroup).toBe(true);
  });

  it('rejects image mode without a source at the render boundary', async () => {
    await expect(generateVideo({
      jobId: 'ltx25-cuda-missing-image',
      modelId: 'ltx25_cuda_distilled',
      prompt: 'a fox watches the rain',
      mode: 'image',
    })).rejects.toMatchObject({ code: 'LTX25_CUDA_I2V_REQUIRES_IMAGE' });
  });

  it('promotes a staged upload before enforcing the image contract', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();

    await generateVideo({
      jobId: 'ltx25-cuda-staged-image',
      modelId: 'ltx25_cuda_distilled',
      prompt: 'a fox watches the rain',
      mode: 'image', uploadedTempPath: '/mock/upload.png',
    });

    const [, args] = ltx25Call(spawnMock);
    expect(basename(args[args.indexOf('--image') + 1]))
      .toBe('resized-src-ltx25-cuda-staged-image.png');
  });
});

describe('generateVideo — Wan 2.2 CUDA contract', () => {
  it('dispatches a pinned, cache-only text render through the dedicated CUDA runtime', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();

    await generateVideo({
      jobId: 'wan22-cuda-args',
      modelId: 'wan22_cuda_ti2v_5b',
      prompt: 'a fox watches the rain',
      negativePrompt: 'text, watermark',
      width: 832, height: 480, numFrames: 81, fps: 24,
      steps: 12, guidanceScale: 4.5, mode: 'text',
    });

    const call = spawnMock.mock.calls.find(([, args]) => (
      Array.isArray(args) && args.some((arg) => basename(String(arg)) === 'generate_wan22_cuda.py')
    ));
    expect(call).toBeDefined();
    const [bin, args, options] = call;
    expect(String(bin)).toContain(join('.portos', 'wan2.2-cuda'));
    expect(args[args.indexOf('--model-repo') + 1]).toBe('Wan-AI/Wan2.2-TI2V-5B-Diffusers');
    expect(args[args.indexOf('--model-revision') + 1])
      .toBe('b8fff7315c768468a5333511427288870b2e9635');
    expect(args[args.indexOf('--steps') + 1]).toBe('12');
    expect(args[args.indexOf('--guidance') + 1]).toBe('4.5');
    expect(args[args.indexOf('--negative-prompt') + 1]).toBe('text, watermark');
    expect(options.env).toMatchObject({
      HF_HUB_DISABLE_IMPLICIT_TOKEN: '1',
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
    });
    expect(options.killProcessGroup).toBe(true);
  });

  it('rejects image mode even when a source is supplied', async () => {
    await expect(generateVideo({
      jobId: 'wan22-cuda-image',
      modelId: 'wan22_cuda_ti2v_5b',
      prompt: 'a fox watches the rain',
      mode: 'image', sourceImagePath: '/mock/source.png',
    })).rejects.toMatchObject({ code: 'WAN22_MODE_UNSUPPORTED' });
  });
});

// #4875 — the user-facing speed profile. Three things must hold end to end:
// the profile's schedule and levers reach the helper's argv; an incompatible
// request degrades to the model's own sampler instead of half-applying; and a
// Quality render builds byte-identical argv to one from before the feature
// existed (the default-preservation contract).
describe('generateVideo — LTX-2.5 speed profile (#4875)', () => {
  const renderArgs = async ({ jobId, modelId = 'ltx25_mlx_q8', ...rest }) => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();
    await renderToTerminal({
      jobId,
      pythonPath: '/usr/bin/python3',
      modelId,
      prompt: 'a quiet street at dusk',
      width: 512, height: 512, numFrames: 25, fps: 24,
      ...rest,
    });
    const call = spawnMock.mock.calls.find(
      ([bin, args]) => (isLtx25Python(bin) || isLtx2Python(bin))
        && Array.isArray(args) && args.includes('--mode'),
    );
    expect(call).toBeTruthy();
    return call[1];
  };

  const valueAfter = (args, flag) => args[args.indexOf(flag) + 1];

  it.each([
    ['image', { mode: 'image', sourceImagePath: '/mock/first.png' }],
    ['audio', { mode: 'a2v', sourceImagePath: '/mock/first.png', audioFilePath: '/mock/audio.wav' }],
  ])('uses 30 guided first-stage steps for %s renders and honors an explicit override', async (name, input) => {
    const defaults = await renderArgs({ jobId: `sp-default-${name}`, ...input });
    expect(valueAfter(defaults, '--steps')).toBe('30');
    expect(valueAfter(defaults, '--cfg-scale')).toBe('3');
    expect(defaults).not.toContain('--stage2-steps');

    const overridden = await renderArgs({ jobId: `sp-override-${name}`, ...input, steps: 8, guidanceScale: 2 });
    expect(valueAfter(overridden, '--steps')).toBe('8');
    expect(valueAfter(overridden, '--cfg-scale')).toBe('2');
  });

  it.each([
    ['audio', { mode: 'a2v', audioFilePath: '/mock/audio.wav' }],
    ['extend', { mode: 'extend', extendFromVideoPath: '/mock/source.mp4' }],
  ])('disables uncalibrated LTX-2.5 TeaCache for quality %s renders', async (name, input) => {
    const args = await renderArgs({ jobId: `sp-no-cache-${name}`, ...input });
    expect(args).toContain('--no-teacache');
  });

  it('threads the profile schedule and its levers into the helper argv', async () => {
    const args = await renderArgs({ jobId: 'sp-fast', mode: 'text', speedProfileId: 'fast' });
    expect(valueAfter(args, '--steps')).toBe('8');
    expect(valueAfter(args, '--stage2-steps')).toBe('3');
    expect(valueAfter(args, '--cfg-scale')).toBe('1');
    expect(valueAfter(args, '--speed-profile')).toBe('fast');
    expect(args).toContain('--teacache');
    expect(valueAfter(args, '--require-adapter')).toBe('ltx-2.5-22b-distilled-lora-450.safetensors');
    // The profile declares no threshold override, so the pin's calibrated
    // default must be left alone rather than pinned to a literal here.
    expect(args).not.toContain('--teacache-thresh');
  });

  it('applies on image mode too — the other mode the schedule was validated for', async () => {
    const args = await renderArgs({ jobId: 'sp-image', mode: 'image', sourceImagePath: '/mock/first.png', speedProfileId: 'fast' });
    expect(valueAfter(args, '--speed-profile')).toBe('fast');
    expect(valueAfter(args, '--steps')).toBe('8');
  });

  // DEFAULT PRESERVATION: the whole point of 'quality' being a no-op.
  it.each([
    ['omitted', 'omitted', undefined],
    ['the explicit default id', 'explicit', 'quality'],
    ['an empty string', 'empty', ''],
  ])('leaves a render with %s byte-identical to the pre-feature argv', async (_name, label, speedProfileId) => {
    // Pin the seed and strip the per-job output path so the comparison is of
    // the SCHEDULE, not of the two values that are per-render by design.
    const strip = (a) => a.map((v) => String(v).replace(/sp-[a-z-]+\.mp4$/, "<job>.mp4"));
    const baseline = strip(await renderArgs({ jobId: `sp-base-${label}`, mode: 'text', seed: 7 }));
    const args = strip(await renderArgs({ jobId: `sp-default-${label}`, mode: 'text', seed: 7, speedProfileId }));
    expect(args).toEqual(baseline);
    expect(args.filter((a) => String(a).startsWith('--speed-profile')
      || String(a).startsWith('--teacache') || String(a).startsWith('--require-adapter'))).toEqual([]);
    expect(args).not.toContain('--stage2-steps');
    expect(valueAfter(args, '--steps')).toBe('30');
    expect(valueAfter(args, '--cfg-scale')).toBe('3');
  });

  it('declines on a mode the profile was never validated for, keeping the model sampler', async () => {
    const args = await renderArgs({
      jobId: 'sp-extend-declines',
      mode: 'extend',
      extendFromVideoPath: '/mock/source.mp4',
      speedProfileId: 'fast',
    });
    expect(args).not.toContain('--speed-profile');
    expect(args).not.toContain('--teacache');
    expect(valueAfter(args, '--steps')).toBe('30');
    expect(valueAfter(args, '--cfg-scale')).toBe('3');
  });

  // MODEL PIN COMPATIBILITY: the 2.3 entry points at different weights, so it
  // declares no profiles — asking for one must degrade, not half-apply.
  it('declines on a model that declares no profiles', async () => {
    const args = await renderArgs({ jobId: 'sp-wrong-model', modelId: 'ltx2_unified', mode: 'text', speedProfileId: 'fast' });
    expect(args).not.toContain('--speed-profile');
    expect(valueAfter(args, '--steps')).toBe('30');
    expect(valueAfter(args, '--cfg-scale')).toBe('3.5');
  });

  it('declines an id no model offers', async () => {
    const args = await renderArgs({ jobId: 'sp-unknown-id', mode: 'text', speedProfileId: 'turbo' });
    expect(args).not.toContain('--speed-profile');
    expect(valueAfter(args, '--steps')).toBe('30');
    expect(valueAfter(args, '--cfg-scale')).toBe('3');
  });

  // The profile owns steps AND CFG together — a half-override would give the
  // user neither the profile's speed nor their own setting.
  it('overrides explicit steps and CFG rather than blending with them', async () => {
    const args = await renderArgs({ jobId: 'sp-overrides-user', mode: 'text', speedProfileId: 'fast', steps: 30, guidanceScale: 7 });
    expect(valueAfter(args, '--steps')).toBe('8');
    expect(valueAfter(args, '--cfg-scale')).toBe('1');
  });

  describe('history metadata', () => {
    const metaFor = async (jobId, extra) => {
      let started = null;
      const onStarted = (e) => { if (e.generationId === jobId) started = e; };
      videoGenEvents.on('started', onStarted);
      await generateVideo({
        jobId,
        pythonPath: '/usr/bin/python3',
        modelId: 'ltx25_mlx_q8',
        prompt: 'a quiet street at dusk',
        width: 512, height: 512, numFrames: 25, fps: 24,
        mode: 'text',
        ...extra,
      });
      videoGenEvents.off('started', onStarted);
      expect(started).toBeTruthy();
      return started;
    };

    it('stamps the REQUESTED profile id and the effective schedule', async () => {
      const meta = await metaFor('sp-meta-fast', { speedProfileId: 'fast' });
      expect(meta.speedProfileId).toBe('fast');
      expect(meta.stage2Steps).toBe(3);
      expect(meta.steps).toBe(8);
      expect(meta.guidanceScale).toBe(1);
    });

    // The ETA estimator buckets on this field, so a Quality render must carry
    // NO key at all — an explicit 'quality' would be a second spelling of the
    // default and would not match pre-feature history.
    it('stamps nothing on a default render', async () => {
      const meta = await metaFor('sp-meta-default', {});
      expect(meta.speedProfileId).toBeUndefined();
      expect(meta.stage2Steps).toBeUndefined();
    });

    it('preserves the exact supplied-audio provenance in renderer history metadata', async () => {
      const audioConditioning = { sourceSha256: 'a'.repeat(64), clipSha256: 'b'.repeat(64),
        sampleRate: 48000, channels: 2, startSample: 96000, endSample: 144000, sampleCount: 48000 };
      const meta = await metaFor('supplied-audio-provenance', {
        mode: 'a2v', audioFilePath: '/mock/data/uploads/example.wav', audioStartSec: 0, audioConditioning,
      });
      expect(meta.audioConditioning).toEqual(audioConditioning);
      expect(meta.mode).toBe('a2v');
      await expect(metaFor('supplied-audio-malformed', { audioConditioning: { ...audioConditioning, endSample: 144001 } }))
        .rejects.toThrow();
    });

    it('stamps nothing when the profile was declined', async () => {
      const meta = await metaFor('sp-meta-declined', { speedProfileId: 'turbo' });
      expect(meta.speedProfileId).toBeUndefined();
    });

    // Optional record fields are written only when they applied, so every
    // other history row stays byte-identical; each is read back on Remix/resume.
    it('records visualConditioning and hidden only when supplied', async () => {
      const visualConditioning = { render: { parameters: { aspectRatio: '16:9' } } };
      const meta = await metaFor('rec-visual-hidden', { visualConditioning, hidden: true });
      expect(meta.visualConditioning).toEqual(visualConditioning);
      expect(meta.hidden).toBe(true);
      const plain = await metaFor('rec-visual-hidden-off', {});
      expect('visualConditioning' in plain).toBe(false);
      expect('hidden' in plain).toBe(false);
    });

    it('stamps the two-stage T2V experiment only when the knob applied', async () => {
      process.env.PORTOS_T2V_TWO_STAGE = '1';
      try {
        const on = await metaFor('rec-twostage-on', { modelId: 'ltx2_unified', mode: undefined });
        expect(on.twoStageT2v).toBe(true);
        expect(on.stage2Steps).toBe(3);
      } finally { delete process.env.PORTOS_T2V_TWO_STAGE; }
      const off = await metaFor('rec-twostage-off', { modelId: 'ltx2_unified', mode: undefined });
      expect('twoStageT2v' in off).toBe(false);
    });

    it('records the LoRA license sidecar on the provenance sources', async () => {
      loraSidecarState.byFilename = { 'lic.safetensors': { license: ' CC-BY-4.0 ', name: 'Lic' } };
      try {
        const meta = await metaFor('rec-lora-license', {
          modelId: 'ltx2_unified', loras: [{ filename: 'lic.safetensors', scale: 1 }],
        });
        const source = meta.provenance.sources.find((x) => x.id === 'lic.safetensors');
        expect(source.license).toBe('CC-BY-4.0');
      } finally { loraSidecarState.byFilename = {}; }
    });
  });
});

// #6499 — block streaming for the LTX-2/2.5 MLX runtimes. Three things must
// hold end to end: a non-default request reaches the helper argv; the
// default ('auto', which is also absence) leaves argv byte-identical to a
// render from before this setting existed; and history stamps the REQUESTED
// mode the same way speedProfileId does.
describe('generateVideo — LTX-2/2.5 block streaming (#6499)', () => {
  const renderArgs = async ({ jobId, modelId = 'ltx25_mlx_q8', ...rest }) => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();
    await renderToTerminal({
      jobId,
      pythonPath: '/usr/bin/python3',
      modelId,
      prompt: 'a quiet street at dusk',
      width: 512, height: 512, numFrames: 25, fps: 24,
      ...rest,
    });
    const call = spawnMock.mock.calls.find(
      ([bin, args]) => (isLtx25Python(bin) || isLtx2Python(bin))
        && Array.isArray(args) && args.includes('--mode'),
    );
    expect(call).toBeTruthy();
    return call[1];
  };

  it('replays an A2V schedule into the helper without dropping selected LoRA strength', async () => {
    const args = await renderArgs({ jobId: 'a2v-stage-replay', mode: 'a2v', audioFilePath: '/mock/audio.wav',
      a2vLoraStageStrengths: [0, 1], loras: [{ filename: 'example.safetensors', scale: 0.7 }] });
    expect(args[args.indexOf('--a2v-lora-stage-strengths') + 1]).toBe('[0,1]');
    expect(JSON.parse(args[args.indexOf('--user-loras') + 1])[0].strength).toBe(0.7);
  });

  it('threads an explicit request into the helper argv', async () => {
    const args = await renderArgs({ jobId: 'stream-explicit', mode: 'text', streamingMode: 'stream' });
    expect(args[args.indexOf('--streaming-mode') + 1]).toBe('stream');
  });

  it('threads an explicit resident request too — not just the non-default "stream" value', async () => {
    const args = await renderArgs({ jobId: 'stream-resident', mode: 'text', streamingMode: 'resident' });
    expect(args[args.indexOf('--streaming-mode') + 1]).toBe('resident');
  });

  // DEFAULT PRESERVATION: 'auto' (and absence) is the bridge's own default.
  it.each([
    ['omitted', 'omitted', undefined],
    ['the explicit default mode', 'explicit', 'auto'],
  ])('leaves a render with %s byte-identical to the pre-feature argv', async (_name, label, streamingMode) => {
    const strip = (a) => a.map((v) => String(v).replace(/stream-[a-z-]+\.mp4$/, '<job>.mp4'));
    const baseline = strip(await renderArgs({ jobId: `stream-base-${label}`, mode: 'text', seed: 7 }));
    const args = strip(await renderArgs({ jobId: `stream-default-${label}`, mode: 'text', seed: 7, streamingMode }));
    expect(args).toEqual(baseline);
    expect(args).not.toContain('--streaming-mode');
  });

  describe('history metadata', () => {
    const metaFor = async (jobId, extra) => {
      let started = null;
      const onStarted = (e) => { if (e.generationId === jobId) started = e; };
      videoGenEvents.on('started', onStarted);
      await renderToTerminal({
        jobId,
        pythonPath: '/usr/bin/python3',
        modelId: 'ltx25_mlx_q8',
        prompt: 'a quiet street at dusk',
        width: 512, height: 512, numFrames: 25, fps: 24,
        mode: 'text',
        ...extra,
      });
      videoGenEvents.off('started', onStarted);
      expect(started).toBeTruthy();
      return started;
    };

    it('saves requested stage multipliers on A2V history, including the legacy default', async () => {
      const input = { mode: 'a2v', audioFilePath: '/mock/audio.wav', loras: [{ filename: 'example.safetensors', scale: 0.7 }] };
      expect(await metaFor('a2v-stage-meta', { ...input, a2vLoraStageStrengths: [0, 1] }))
        .toMatchObject({ a2vLoraStageStrengths: [0, 1], loraScales: [0.7] });
      expect(await metaFor('a2v-stage-legacy-meta', input)).toMatchObject({ a2vLoraStageStrengths: [1, 1] });
    });

    it('stamps the REQUESTED mode', async () => {
      const meta = await metaFor('stream-meta-explicit', { streamingMode: 'stream' });
      expect(meta.streamingMode).toBe('stream');
    });

    it('stamps nothing on a default render', async () => {
      const meta = await metaFor('stream-meta-default', {});
      expect(meta.streamingMode).toBeUndefined();
    });

    it('stamps nothing for the explicit default mode either', async () => {
      const meta = await metaFor('stream-meta-auto', { streamingMode: 'auto' });
      expect(meta.streamingMode).toBeUndefined();
    });
  });
});
