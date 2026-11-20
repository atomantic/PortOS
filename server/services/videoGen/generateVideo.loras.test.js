/**
 * generateVideo.loras.test.js
 *
 * Split from local.test.js (#16214); shared mocks live in local.testFixtures.js.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { basename, join } from 'path';

// vi.mock factories are hoisted above imports; the shared fixtures module is
// loaded the same way so its state objects outlive vi.resetModules().
const fx = await vi.hoisted(() => import('./local.testFixtures.js'));
const { MOCK_PATHS, isLtx2Python, mockFindCachedRepoFile, h3LoraState, loraLayoutState, loraSidecarState, loraEffectState } = fx;

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

describe('generateVideo — video LoRA (--user-loras) arg threading', () => {
  it('emits --user-loras JSON with resolved path + strength for ltx2 renders', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();

    await generateVideo({
      jobId: 'lora-arg-test',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'audio reactive clip',
      width: 512, height: 512, numFrames: 25, fps: 24,
      mode: 'text',
      loras: [{ filename: 'lora-fal-ltx2-3-audio-reactive-lora-hf.safetensors', scale: 0.8 }],
    });

    const call = spawnMock.mock.calls.find(
      ([bin, args]) => isLtx2Python(bin)
        && Array.isArray(args) && args.includes('--user-loras'),
    );
    expect(call).toBeTruthy();
    const args = call[1];
    const payload = JSON.parse(args[args.indexOf('--user-loras') + 1]);
    expect(payload).toEqual([
      { path: join(MOCK_PATHS.loras, 'lora-fal-ltx2-3-audio-reactive-lora-hf.safetensors'), strength: 0.8 },
    ]);
  });

  it('defaults missing scale to 1.0', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();

    await generateVideo({
      jobId: 'lora-default-scale',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'clip',
      width: 512, height: 512, numFrames: 25, fps: 24,
      mode: 'text',
      loras: [{ filename: 'style.safetensors' }],
    });

    const call = spawnMock.mock.calls.find(
      ([, args]) => Array.isArray(args) && args.includes('--user-loras'),
    );
    const payload = JSON.parse(call[1][call[1].indexOf('--user-loras') + 1]);
    expect(payload[0].strength).toBe(1.0);
  });

  it('omits --user-loras when no LoRAs are passed', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();

    await generateVideo({
      jobId: 'no-lora',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'clip',
      width: 512, height: 512, numFrames: 25, fps: 24,
      mode: 'text',
    });

    const call = spawnMock.mock.calls.find(
      ([bin]) => isLtx2Python(bin),
    );
    expect(call[1]).not.toContain('--user-loras');
  });

  it.skipIf(process.platform === 'win32')('routes a bf16 mlx_video LTX model through the generate_av_lora.py wrapper with --user-loras', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();

    await generateVideo({
      jobId: 'mlx-lora-test',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx23_unified', // runtime: mlx_video, bf16 → LoRA-capable
      prompt: 'audio reactive clip',
      width: 512, height: 512, numFrames: 25, fps: 24,
      mode: 'text',
      loras: [{ filename: 'lora-fal-ltx2-3-audio-reactive-lora-hf.safetensors', scale: 0.8 }],
    });

    const call = spawnMock.mock.calls.find(
      ([bin, args]) => String(bin) === '/usr/bin/python3'
        && Array.isArray(args) && args.includes('--user-loras'),
    );
    expect(call).toBeTruthy();
    const args = call[1];
    // wrapper script, NOT the bare `-m mlx_video.generate_av` module path
    expect(args[0]).toBe(join(MOCK_PATHS.root, 'scripts', 'ml', 'generate_av_lora.py'));
    expect(args).not.toContain('-m');
    // the generate_av flags still flow through the wrapper
    expect(args).toContain('--model-repo');
    expect(args[args.indexOf('--model-repo') + 1]).toBe('notapalindrome/ltx23-mlx-av');
    const payload = JSON.parse(args[args.indexOf('--user-loras') + 1]);
    expect(payload).toEqual([
      { path: join(MOCK_PATHS.loras, 'lora-fal-ltx2-3-audio-reactive-lora-hf.safetensors'), strength: 0.8 },
    ]);
  });

  it.skipIf(process.platform === 'win32')('a non-LoRA mlx_video render still uses the bare generate_av module (no wrapper)', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();

    await generateVideo({
      jobId: 'mlx-no-lora',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx23_unified',
      prompt: 'clip',
      width: 512, height: 512, numFrames: 25, fps: 24,
      mode: 'text',
    });

    const call = spawnMock.mock.calls.find(
      ([bin, args]) => String(bin) === '/usr/bin/python3' && Array.isArray(args) && args.includes('mlx_video.generate_av'),
    );
    expect(call).toBeTruthy();
    expect(call[1]).not.toContain('--user-loras');
    expect(call[1]).not.toContain(join(MOCK_PATHS.root, 'scripts', 'ml', 'generate_av_lora.py'));
  });

  it.skipIf(process.platform === 'win32')('rejects LoRAs on a quantized (out-of-scope) mlx_video model', async () => {
    await expect(generateVideo({
      jobId: 'mlx-q4-lora',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx23_distilled_q4', // runtime: mlx_video, quantized → NOT capable
      prompt: 'clip',
      width: 512, height: 512, numFrames: 25, fps: 24,
      mode: 'text',
      loras: [{ filename: 'style.safetensors', scale: 1.0 }],
    })).rejects.toThrow(/LoRAs aren't supported/);
  });
});

describe('generateVideo — LoRA history-record contract (Remix round-trip)', () => {
  it('stamps loraFilenames + loraScales (not a bespoke `loras` field) so normalizeVideo/Remix can read them', async () => {
    let startedMeta = null;
    videoGenEvents.on('started', (e) => { if (e.generationId === 'lora-history-test') startedMeta = e; });

    await generateVideo({
      jobId: 'lora-history-test',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'styled clip',
      width: 512, height: 512, numFrames: 25, fps: 24,
      mode: 'text',
      loras: [{ filename: 'a.safetensors', scale: 0.7 }, { filename: 'b.safetensors', scale: 1.0 }],
    });
    videoGenEvents.removeAllListeners('started');

    expect(startedMeta).toBeTruthy();
    // The image LoRA contract that normalize.js#pickLoraFilenames + the Remix
    // handler consume — parallel arrays, not a `loras: [{filename,scale}]` blob.
    expect(startedMeta.loraFilenames).toEqual(['a.safetensors', 'b.safetensors']);
    expect(startedMeta.loraScales).toEqual([0.7, 1.0]);
    expect(startedMeta.provenance.sources.map((s) => s.id)).toEqual([
      'ltx2_unified', 'a.safetensors', 'b.safetensors',
    ]);
    expect(startedMeta.provenance.sources.every((s) => s.license == null)).toBe(true);
    expect(startedMeta.loras).toBeUndefined();
  });
});

describe('generateVideo — LoRA trigger-word weaving (#4665)', () => {
  const promptFrom = (spawnMock, jobId) => {
    const call = spawnMock.mock.calls.find(([, args]) =>
      Array.isArray(args) && args.some((a) => typeof a === 'string' && a.includes(jobId)));
    if (!call) return null;
    const i = call[1].indexOf('--prompt');
    return i === -1 ? null : call[1][i + 1];
  };

  const renderWithLoras = async ({ jobId, prompt, loras }) => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();
    let startedMeta = null;
    const onStarted = (e) => { if (e.generationId === jobId) startedMeta = e; };
    videoGenEvents.on('started', onStarted);
    await generateVideo({
      jobId,
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt,
      width: 512, height: 512, numFrames: 25, fps: 24,
      mode: 'text',
      loras,
    });
    videoGenEvents.off('started', onStarted);
    return { renderedPrompt: promptFrom(spawnMock, jobId), startedMeta };
  };

  beforeEach(() => { loraSidecarState.byFilename = {}; });
  afterEach(() => { loraSidecarState.byFilename = {}; });

  it('appends the selected LoRA trigger word to the prompt the runner receives', async () => {
    loraSidecarState.byFilename = { 'fox.safetensors': { triggerWords: ['fox_tok', 'animal'] } };
    const { renderedPrompt, startedMeta } = await renderWithLoras({
      jobId: 'weave-basic',
      prompt: 'a clip in the rain',
      loras: [{ filename: 'fox.safetensors', scale: 0.8 }],
    });
    // Only the FIRST trigger word — 'animal' is a loose Civitai tag, not an
    // activation token.
    expect(renderedPrompt).toBe('a clip in the rain, fox_tok');
    // Provenance: history keeps the user's prompt so Remix re-derives triggers
    // from whatever LoRAs are selected then rather than compounding this clause.
    expect(startedMeta.prompt).toBe('a clip in the rain');
    expect(startedMeta.renderPrompt).toBe('a clip in the rain, fox_tok');
    expect(startedMeta.addedTriggerWords).toEqual(['fox_tok']);
  });

  it('does not duplicate a trigger word the prompt already carries', async () => {
    loraSidecarState.byFilename = { 'fox.safetensors': { triggerWords: ['fox_tok'] } };
    const { renderedPrompt, startedMeta } = await renderWithLoras({
      jobId: 'weave-present',
      prompt: 'fox_tok running through the rain',
      loras: [{ filename: 'fox.safetensors', scale: 0.8 }],
    });
    expect(renderedPrompt).toBe('fox_tok running through the rain');
    // No provenance fields — this history row stays byte-identical to a
    // pre-feature one.
    expect(startedMeta.renderPrompt).toBeUndefined();
    expect(startedMeta.addedTriggerWords).toBeUndefined();
  });

  it('leaves the prompt untouched when the LoRA sidecar has no trigger words', async () => {
    loraSidecarState.byFilename = { 'legacy.safetensors': { triggerWords: [] } };
    const { renderedPrompt, startedMeta } = await renderWithLoras({
      jobId: 'weave-legacy',
      prompt: 'a clip in the rain',
      loras: [{ filename: 'legacy.safetensors', scale: 1.0 }],
    });
    expect(renderedPrompt).toBe('a clip in the rain');
    expect(startedMeta.renderPrompt).toBeUndefined();
  });

  it('is a no-op for a render with no LoRAs', async () => {
    loraSidecarState.byFilename = { 'fox.safetensors': { triggerWords: ['fox_tok'] } };
    const { renderedPrompt, startedMeta } = await renderWithLoras({
      jobId: 'weave-no-loras',
      prompt: 'a clip in the rain',
      loras: undefined,
    });
    expect(renderedPrompt).toBe('a clip in the rain');
    expect(startedMeta.renderPrompt).toBeUndefined();
  });
});

// H3's DiT is quantized, so LoRAs ride along only if the installed runner
// applies them at render time from quantization metadata. That is a property of
// the installed runtime plus adapter, so the verdict comes from a probe — and
// the render path must honor it in both directions rather than blanket-rejecting
// the runtime.
describe.skipIf(process.platform === 'win32')('MiniMax H3 user LoRAs', () => {
  const h3Render = (jobId) => renderToTerminal({
    jobId,
    modelId: 'minimax_h3_8bit',
    prompt: 'a fox watches the rain',
    width: 512, height: 320, numFrames: 141, fps: 24, mode: 'text',
    loras: [{ filename: 'fox.safetensors', scale: 0.8 }],
  });

  afterEach(() => { h3LoraState.capable = false; h3LoraState.cached = null; });

  // The model is decorated from the sync cache read, so on a capable install the
  // FIRST LoRA render after boot sees `runtimeLoraCapable: false`. buildArgs must
  // decide from the settled probe, not that stale snapshot, or the render is
  // refused and only succeeds on a retry.
  it('renders on a cold capability cache once the probe settles capable', async () => {
    h3LoraState.capable = true;
    h3LoraState.cached = false;   // sync read hasn't caught up yet
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();

    await expect(h3Render('h3-lora-cold-cache')).resolves.toBeDefined();

    const [, args] = spawnMock.mock.calls.find(([, a]) => (
      Array.isArray(a) && a.some((arg) => basename(String(arg)) === 'generate_minimax_h3.py')
    ));
    expect(args).toContain('--lora');
  });

  it('rejects LoRAs with an H3-specific reason when the adapter probe fails', async () => {
    h3LoraState.capable = false;
    await expect(h3Render('h3-lora-blocked')).rejects.toMatchObject({
      code: 'MINIMAX_H3_LORA_UNSUPPORTED',
      status: 400,
    });
  });

  it('forwards each LoRA as a paired --lora/--lora-scale once the runner proves capable', async () => {
    h3LoraState.capable = true;
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();

    await renderToTerminal({
      jobId: 'h3-lora-ok',
      modelId: 'minimax_h3_8bit',
      prompt: 'a fox watches the rain',
      width: 512, height: 320, numFrames: 141, fps: 24, mode: 'text',
      loras: [{ filename: 'fox.safetensors', scale: 0.8 }, { filename: 'rain.safetensors', scale: 0.5 }],
    });

    const [, args] = spawnMock.mock.calls.find(([, a]) => (
      Array.isArray(a) && a.some((arg) => basename(String(arg)) === 'generate_minimax_h3.py')
    ));
    expect(args.flatMap((arg, i) => (
      arg === '--lora' ? [[args[i + 1], args[i + 2] === '--lora-scale' ? args[i + 3] : 'UNPAIRED']] : []
    ))).toEqual([
      [expect.stringContaining('fox.safetensors'), '0.8'],
      [expect.stringContaining('rain.safetensors'), '0.5'],
    ]);
  });

  it('emits no LoRA argv on a plain H3 render', async () => {
    h3LoraState.capable = true;
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();

    await renderToTerminal({
      jobId: 'h3-no-lora',
      modelId: 'minimax_h3_8bit',
      prompt: 'a fox watches the rain',
      width: 512, height: 320, numFrames: 141, fps: 24, mode: 'text',
    });

    const [, args] = spawnMock.mock.calls.find(([, a]) => (
      Array.isArray(a) && a.some((arg) => basename(String(arg)) === 'generate_minimax_h3.py')
    ));
    expect(args).not.toContain('--lora');
    expect(args).not.toContain('--lora-scale');
  });
});

describe('generateVideo — IC-LoRA remix arg threading (#3100)', () => {
  // 704×448 is divisible by the Control weight's referenceDownscaleFactor of 2,
  // so these renders clear the resolution gate. Frames stay small so the FFLF
  // pixel-budget clamp (fflf-only anyway) never enters the picture.
  const baseIcRender = {
    pythonPath: '/usr/bin/python3',
    modelId: 'ltx2_unified',
    prompt: 'a dancer following the depth clip',
    width: 704, height: 448, numFrames: 25, fps: 24,
    mode: 'ic-control',
    icReferencePaths: ['/mock/data/videos/depth.mp4'],
  };

  const findIcCall = (spawnMock) => spawnMock.mock.calls.find(
    ([bin, args]) => isLtx2Python(bin)
      && Array.isArray(args) && args.includes('--ic-mode'),
  );

  beforeEach(() => {
    // Every weight resident. The probe is per-FILE (findCachedRepoFile) rather
    // than a snapshot walk, so an aggregate mirror is never enumerated.
    mockFindCachedRepoFile.mockImplementation(async (_repo, filename) => join('/mock/hf/snap', filename));
  });

  it('routes ic-control to --mode ic with the pinned weight, reference, and strength', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();

    await generateVideo({ ...baseIcRender, jobId: 'ic-basic', icStrength: 0.75 });

    const call = findIcCall(spawnMock);
    expect(call).toBeTruthy();
    const args = call[1];
    expect(args[args.indexOf('--mode') + 1]).toBe('ic');
    expect(args[args.indexOf('--ic-mode') + 1]).toBe('control');
    expect(args[args.indexOf('--ic-reference') + 1]).toBe('/mock/data/videos/depth.mp4');
    expect(args[args.indexOf('--ic-strength') + 1]).toBe('0.75');
    // Cached snapshot → the exact pinned filename, not the bare repo id, so a
    // multi-weight repo can't glob-pick the wrong file.
    expect(args[args.indexOf('--ic-lora-path') + 1])
      .toBe(join('/mock/hf/snap', 'ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors'));
    // The reference-count bounds are PASSED to the helper rather than hardcoded
    // there, so the registry stays the single source of truth across languages.
    expect(args[args.indexOf('--ic-min-references') + 1]).toBe('1');
    expect(args[args.indexOf('--ic-max-references') + 1]).toBe('1');
  });

  it('routes ic-colorize to its own weight and bare mode id (#3111)', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();

    await generateVideo({
      ...baseIcRender, jobId: 'ic-colorize-basic', mode: 'ic-colorize',
      prompt: 'restore natural color to the archival footage',
      icReferencePaths: ['/mock/data/videos/bw.mp4'],
    });

    const args = findIcCall(spawnMock)[1];
    expect(args[args.indexOf('--mode') + 1]).toBe('ic');
    // The bare registry id, not the `ic-` prefixed PortOS mode — the Python
    // helper's --ic-mode is free-form, so a prefixed value would only surface
    // as odd status prose.
    expect(args[args.indexOf('--ic-mode') + 1]).toBe('colorize');
    expect(args[args.indexOf('--ic-lora-path') + 1])
      .toBe(join('/mock/hf/snap', 'LTX-2.3-22b-IC-LoRA-Colorizer-0.9.safetensors'));
    expect(args[args.indexOf('--ic-reference') + 1]).toBe('/mock/data/videos/bw.mp4');
    expect(args[args.indexOf('--ic-min-references') + 1]).toBe('1');
    expect(args[args.indexOf('--ic-max-references') + 1]).toBe('1');
  });

  it('falls back to the HF repo id when the weight is not cached', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();
    mockFindCachedRepoFile.mockResolvedValue(null);

    await generateVideo({ ...baseIcRender, jobId: 'ic-uncached' });

    const args = findIcCall(spawnMock)[1];
    expect(args[args.indexOf('--ic-lora-path') + 1])
      .toBe('Lightricks/LTX-2.3-22b-IC-LoRA-Union-Control');
  });

  it('falls back to the Colorizer repo id when its weight is not cached', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();
    mockFindCachedRepoFile.mockResolvedValue(null);

    await generateVideo({ ...baseIcRender, jobId: 'ic-colorize-uncached', mode: 'ic-colorize' });

    const args = findIcCall(spawnMock)[1];
    expect(args[args.indexOf('--ic-lora-path') + 1])
      .toBe('DoctorDiffusion/LTX-2.3-IC-LoRA-Colorizer');
  });

  it('defaults --ic-strength to 1.0 and omits the optional dials', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();

    await generateVideo({ ...baseIcRender, jobId: 'ic-defaults' });

    const args = findIcCall(spawnMock)[1];
    // JS stringifies 1.0 as "1" — argparse's float parse accepts either.
    expect(args[args.indexOf('--ic-strength') + 1]).toBe('1');
    // Omitted so the pipeline applies its own defaults rather than us pinning
    // values that would shadow a future upstream change.
    expect(args).not.toContain('--ic-attention-strength');
    expect(args).not.toContain('--ic-skip-stage-2');
  });

  it('emits --ic-attention-strength and --ic-skip-stage-2 when requested', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();

    await generateVideo({
      ...baseIcRender, jobId: 'ic-dials',
      icAttentionStrength: 0.4, icSkipStage2: true,
    });

    const args = findIcCall(spawnMock)[1];
    expect(args[args.indexOf('--ic-attention-strength') + 1]).toBe('0.4');
    expect(args).toContain('--ic-skip-stage-2');
  });

  it('stacks user LoRAs alongside the IC-LoRA rather than replacing it', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();

    await generateVideo({
      ...baseIcRender, jobId: 'ic-plus-user-lora',
      loras: [{ filename: 'character.safetensors', scale: 0.9 }],
    });

    const args = findIcCall(spawnMock)[1];
    // Both channels present: the IC weight rides --ic-lora-path (fused via
    // lora_paths) and the character LoRA rides --user-loras (_pending_loras).
    expect(args).toContain('--ic-lora-path');
    const userLoras = JSON.parse(args[args.indexOf('--user-loras') + 1]);
    expect(userLoras).toEqual([
      { path: join(MOCK_PATHS.loras, 'character.safetensors'), strength: 0.9 },
    ]);
  });

  it('rejects a reference count outside the weight contract', async () => {
    // Control is a single-reference weight; two clips would silently produce
    // plausible garbage rather than an error inside the pipeline.
    await expect(generateVideo({
      ...baseIcRender, jobId: 'ic-too-many-refs',
      icReferencePaths: ['/mock/data/videos/a.mp4', '/mock/data/videos/b.mp4'],
    })).rejects.toThrow(/needs exactly 1 reference video/);
    await expect(generateVideo({
      ...baseIcRender, jobId: 'ic-no-refs', icReferencePaths: [],
    })).rejects.toThrow(/needs exactly 1 reference video/);
  });

  it('rejects a reference clip that is not on disk', async () => {
    const { existsSync } = await import('fs');
    // The reference path is the one existence check that matters here; every
    // other existsSync caller in this flow is satisfied by the default mock.
    vi.mocked(existsSync).mockImplementation((p) => p !== '/mock/data/videos/gone.mp4');
    await expect(generateVideo({
      ...baseIcRender, jobId: 'ic-missing-ref',
      icReferencePaths: ['/mock/data/videos/gone.mp4'],
    })).rejects.toThrow(/IC-LoRA reference not found on disk/);
    vi.mocked(existsSync).mockImplementation(() => true);
  });

  it('rejects an IC render on a non-ltx2 runtime', async () => {
    await expect(generateVideo({
      ...baseIcRender, jobId: 'ic-wrong-runtime', modelId: 'ltx23_unified',
    })).rejects.toThrow(/requires a ltx-2.3 model/);
  });

  // ── Ingredients: image-kind references (#3112) ─────────────────────────
  describe('ic-ingredients still references (#3112)', () => {
    const baseIngredients = {
      ...baseIcRender,
      mode: 'ic-ingredients',
      prompt: 'the owl greets the camera outside the store',
      icReferencePaths: ['/mock/images/owl.png', '/mock/images/store.png'],
    };

    it('materializes each still into a 9-frame clip at the render resolution', async () => {
      const { execFile } = await import('../../lib/childProcess.js');
      const { spawnDetached } = await import('../../lib/detachedSpawn.js');
      const execFileMock = vi.mocked(execFile);
      const spawnMock = vi.mocked(spawnDetached);
      execFileMock.mockClear();
      spawnMock.mockClear();

      await generateVideo({ ...baseIngredients, jobId: 'ing-stills' });

      // One ffmpeg per still. The pipeline's reference channel probes with ffprobe
      // and feeds the video VAE, whose reshape needs a (1 + 8k)-frame input — a
      // bare PNG has neither, so a still can't be passed through unchanged.
      const stillCalls = execFileMock.mock.calls.filter(([, args]) => args.includes('-loop'));
      expect(stillCalls).toHaveLength(2);
      for (const [, args] of stillCalls) {
        expect(args[args.indexOf('-frames:v') + 1]).toBe('9');
        // Scaled/cropped to the FLOORED render resolution — the pipeline requires
        // exact dimensions and won't pad.
        expect(args[args.indexOf('-vf') + 1]).toContain('crop=704:448');
        // No audio stream on a throwaway reference clip.
        expect(args).toContain('-an');
      }

      // The helper receives the materialized CLIPS, never the source stills.
      const args = findIcCall(spawnMock)[1];
      const refs = args.reduce((acc, a, i) => (a === '--ic-reference' ? [...acc, args[i + 1]] : acc), []);
      expect(refs).toHaveLength(2);
      for (const r of refs) expect(r).toMatch(/ic-still-\d+-ing-stills\.mp4$/);
      expect(refs).not.toContain('/mock/images/owl.png');
      expect(args[args.indexOf('--ic-mode') + 1]).toBe('ingredients');
      expect(args[args.indexOf('--ic-min-references') + 1]).toBe('2');
      expect(args[args.indexOf('--ic-max-references') + 1]).toBe('8');
    });

    it('accepts the full 2-8 range', async () => {
      const { spawnDetached } = await import('../../lib/detachedSpawn.js');
      const spawnMock = vi.mocked(spawnDetached);
      for (const n of [2, 5, 8]) {
        spawnMock.mockClear();
        await generateVideo({
          ...baseIngredients, jobId: `ing-${n}`,
          icReferencePaths: Array.from({ length: n }, (_, i) => `/mock/images/ref-${i}.png`),
        });
        const args = findIcCall(spawnMock)[1];
        expect(args.filter((a) => a === '--ic-reference')).toHaveLength(n);
      }
    });

    it('rejects a reference count outside the 2-8 contract', async () => {
      await expect(generateVideo({
        ...baseIngredients, jobId: 'ing-one', icReferencePaths: ['/mock/images/owl.png'],
      })).rejects.toThrow(/needs 2-8 reference image/);
      await expect(generateVideo({
        ...baseIngredients, jobId: 'ing-nine',
        icReferencePaths: Array.from({ length: 9 }, (_, i) => `/mock/images/ref-${i}.png`),
      })).rejects.toThrow(/needs 2-8 reference image/);
    });

    it('fails fast when the weight is not downloaded (no snapshot_download fallback)', async () => {
      // The registry refuses to hand the pipeline a bare repo id for this weight:
      // `_resolve_lora_path` would `snapshot_download` a gated repo / a ~708 GB
      // mirror. So an uncached Ingredients render must 400 rather than silently
      // starting an unbounded pull.
      mockFindCachedRepoFile.mockResolvedValue(null);
      await expect(generateVideo({ ...baseIngredients, jobId: 'ing-uncached' }))
        .rejects.toThrow(/is not downloaded — download Ingredients/);
    });

    it('stacks user LoRAs alongside the Ingredients weight rather than replacing it', async () => {
      const { spawnDetached } = await import('../../lib/detachedSpawn.js');
      const spawnMock = vi.mocked(spawnDetached);
      spawnMock.mockClear();

      await generateVideo({
        ...baseIngredients, jobId: 'ing-plus-character-lora',
        loras: [{ filename: 'character.safetensors', scale: 0.9 }],
      });

      const args = findIcCall(spawnMock)[1];
      // The payoff of the Phase 1 split: the IC weight rides --ic-lora-path (→
      // `lora_paths`, fused by _fuse_loras pre-Stage-1) while the user LoRA rides
      // --user-loras (→ `_pending_loras`, fused at DiT load), so an Ingredients ×
      // Character stack COMPOSES instead of one displacing the other.
      expect(args[args.indexOf('--ic-lora-path') + 1])
        .toBe(join('/mock/hf/snap', 'ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors'));
      expect(JSON.parse(args[args.indexOf('--user-loras') + 1])).toEqual([
        { path: join(MOCK_PATHS.loras, 'character.safetensors'), strength: 0.9 },
      ]);
    });

    it('waits for every encode before rejecting and cleaning derived files', async () => {
      const { execFile } = await import('../../lib/childProcess.js');
      const { unlink } = await import('fs/promises');
      const pending = [];
      const originals = [...baseIngredients.icReferencePaths, '/mock/images/source.png'];
      const files = new Set(originals);
      vi.mocked(unlink).mockImplementation(async (path) => { files.delete(path); });
      vi.mocked(execFile).mockImplementation((_bin, args, _opts, cb) => {
        const target = args.at(-1);
        if (args.includes('-loop')) pending.push((error) => {
          files.add(target);
          cb(error);
        });
        else {
          files.add(target);
          cb?.(null, '', '');
        }
      });
      let settled = false;
      const result = generateVideo({
        ...baseIngredients, jobId: 'ing-delayed', sourceImagePath: originals[2],
      }).catch((error) => error).finally(() => { settled = true; });
      await vi.waitFor(() => expect(pending).toHaveLength(2));
      // Finish input 1 first, but report input 0's failure after both settle.
      pending[1](new Error('second failed'));
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(files.size).toBe(5);
      expect(vi.mocked(unlink).mock.calls.filter(([path]) => path.includes('ing-delayed'))).toEqual([]);
      pending[0](new Error('first failed'));
      expect(await result).toMatchObject({
        code: 'IC_LORA_STILL_PREP_FAILED',
        message: 'Failed to prepare Ingredients reference owl.png: first failed',
      });
      expect([...files]).toEqual(originals);
      vi.mocked(unlink).mockImplementation(async () => {});
      vi.mocked(execFile).mockImplementation((_bin, _args, _opts, cb) => cb?.(null, '', ''));
    });

    it('requires ffmpeg for Ingredients even when ordinary images can pass through', async () => {
      const { findFfmpeg } = await import('../../lib/ffmpeg.js');
      vi.mocked(findFfmpeg).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      await expect(generateVideo({
        ...baseIngredients, jobId: 'ing-no-ffmpeg', sourceImagePath: '/mock/images/source.png',
      })).rejects.toMatchObject({ code: 'IC_LORA_STILL_NEEDS_FFMPEG', status: 400 });
    });

    it.each(['missing ffmpeg', 'failed resize'])('passes the original image to the child after %s', async (failure) => {
      const { findFfmpeg } = await import('../../lib/ffmpeg.js');
      const { execFile } = await import('../../lib/childProcess.js');
      const { spawnDetached } = await import('../../lib/detachedSpawn.js');
      const { unlink } = await import('fs/promises');
      if (failure === 'missing ffmpeg') vi.mocked(findFfmpeg).mockResolvedValueOnce(null);
      else vi.mocked(execFile).mockImplementationOnce((_bin, _args, _opts, cb) => cb?.(new Error('resize failed')));
      await generateVideo({
        ...baseIcRender, mode: 'image', icReferencePaths: null,
        jobId: 'image-fallback', sourceImagePath: '/mock/images/source.png',
      });
      const args = vi.mocked(spawnDetached).mock.calls.find(([, argv]) => argv.includes('--image'))[1];
      expect(args[args.indexOf('--image') + 1]).toBe('/mock/images/source.png');
      expect(vi.mocked(unlink).mock.calls.flat()).not.toContain('/mock/images/source.png');
    });

    it('also cleans up an earlier resized-source temp file when a still fails to encode', async () => {
      // resizedSrcTempPath is created by an EARLIER, unrelated resize step
      // (mirrors a caller that also passed sourceImagePath) — before the
      // buildArgs try/catch that normally cleans it up. A still-encode
      // failure in the Ingredients block throws before ever reaching that
      // try/catch, so without explicit cleanup here the resized-source temp
      // file would leak into os.tmpdir() even though the clip temp files
      // themselves were already covered by the test above.
      const { execFile } = await import('../../lib/childProcess.js');
      const { unlink } = await import('fs/promises');
      const execFileMock = vi.mocked(execFile);
      const unlinkMock = vi.mocked(unlink);
      execFileMock.mockClear();
      unlinkMock.mockClear();

      // The plain resize call (no `-loop`) succeeds; every still-clip call
      // (`-loop` present) fails.
      execFileMock.mockImplementation((_bin, args, _opts, cb) => {
        if (args.includes('-loop')) return cb?.(new Error('ffmpeg exploded'));
        return cb?.(null, '', '');
      });

      await expect(generateVideo({
        ...baseIngredients, jobId: 'ing-src-leak', sourceImagePath: '/mock/images/source.png',
      })).rejects.toThrow(/Failed to prepare Ingredients reference/);

      const unlinked = unlinkMock.mock.calls.map(([p]) => String(p));
      expect(unlinked.some((p) => p.includes('resized-src-ing-src-leak.png'))).toBe(true);

      execFileMock.mockImplementation((_bin, _args, _opts, cb) => cb?.(null, '', ''));
    });

    it('cleans up the temp clips after a successful render', async () => {
      const { unlink } = await import('fs/promises');
      const unlinkMock = vi.mocked(unlink);
      unlinkMock.mockClear();

      await generateVideo({ ...baseIngredients, jobId: 'ing-cleanup' });
      // Success-path cleanup runs in the child's async close handler, which fires
      // after generateVideo resolves.
      await vi.waitFor(() => expect(unlinkMock).toHaveBeenCalled());

      const unlinked = unlinkMock.mock.calls.map(([p]) => String(p));
      for (const i of [0, 1]) {
        expect(unlinked.some((p) => p.includes(`ic-still-${i}-ing-cleanup.mp4`))).toBe(true);
      }
      expect(unlinked).not.toContain('/mock/images/owl.png');
    });

    it('stamps the gallery basenames (not the temp clip paths) onto history', async () => {
      const started = [];
      const onStarted = (p) => started.push(p);
      videoGenEvents.on('started', onStarted);
      await generateVideo({ ...baseIngredients, jobId: 'ing-history' });
      videoGenEvents.off('started', onStarted);

      const meta = started.find((s) => s.generationId === 'ing-history');
      // History is user-facing: the gallery filenames are meaningful, the
      // `ic-still-N-<jobId>.mp4` temp encodes are not.
      expect(meta.icReferenceNames).toEqual(['owl.png', 'store.png']);
      expect(meta.mode).toBe('ic-ingredients');
    });
  });

  it('stamps the IC dials + reference basename onto the history record', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    vi.mocked(spawnDetached).mockClear();
    const started = [];
    const onStarted = (p) => started.push(p);
    videoGenEvents.on('started', onStarted);

    await generateVideo({
      ...baseIcRender, jobId: 'ic-history-stamp',
      icStrength: 0.6, icAttentionStrength: 0.4, icSkipStage2: true,
    });

    videoGenEvents.off('started', onStarted);
    const meta = started.find((s) => s.generationId === 'ic-history-stamp');
    expect(meta).toBeTruthy();
    expect(meta.mode).toBe('ic-control');
    expect(meta.icStrength).toBe(0.6);
    expect(meta.icSkipStage2).toBe(true);
    expect(meta.icAttentionStrength).toBe(0.4);
    // BASENAME only — the absolute staging path is machine-specific and never
    // belongs in a user-facing history record.
    expect(meta.icReferenceNames).toEqual(['depth.mp4']);
  });
});

describe('icLoraArgs — direct validation (#3100)', () => {
  let icLoraArgs;
  beforeEach(async () => { ({ icLoraArgs } = await import('./renderArgs.js')); });

  const base = {
    mode: 'ic-control',
    width: 704, height: 448,
    icReferencePaths: ['/mock/data/videos/depth.mp4'],
    icLoraWeightPath: '/mock/hf/snap/control.safetensors',
    icStrength: 1.0,
  };

  it('rejects an output resolution not divisible by the reference-downscale factor', () => {
    // Unreachable via generateVideo (edges are floored to multiples of 64, so
    // always even) but live the moment a weight ships with a factor > 2 — an odd
    // dimension here proves the guard fires instead of failing mid-render.
    expect(() => icLoraArgs({ ...base, width: 705 }))
      .toThrow(/divisible by 2/);
    expect(() => icLoraArgs({ ...base, height: 449 }))
      .toThrow(/divisible by 2/);
  });

  it('accepts any resolution for a factor-1 weight (#3111)', () => {
    // The Colorizer's safetensors metadata reports reference_downscale_factor=1,
    // so it conditions on a full-res reference and imposes NO divisibility rule.
    // Had we copied Control's 2, these would 400 for no reason.
    expect(() => icLoraArgs({ ...base, mode: 'ic-colorize', width: 705, height: 449 }))
      .not.toThrow();
    const args = icLoraArgs({ ...base, mode: 'ic-colorize' });
    expect(args[args.indexOf('--ic-mode') + 1]).toBe('colorize');
  });

  it('rejects an unknown remix mode', () => {
    expect(() => icLoraArgs({ ...base, mode: 'ic-nope' })).toThrow(/Unknown IC-LoRA remix mode/);
  });

  it('rejects an unresolved weight path', () => {
    expect(() => icLoraArgs({ ...base, icLoraWeightPath: null }))
      .toThrow(/is not downloaded — download Control/);
  });

  it('enforces the 2-8 reference bounds for Ingredients and passes them to the helper (#3112)', () => {
    // The count is a WEIGHT CONTRACT: a wrong one yields plausible garbage rather
    // than an error inside the pipeline, so it's enforced here (and in the route,
    // and again in the Python helper via the flags below).
    const ing = {
      ...base, mode: 'ic-ingredients',
      icLoraWeightPath: '/mock/hf/snap/ingredients.safetensors',
    };
    const ref = (n) => Array.from({ length: n }, (_, i) => `/mock/data/videos/ing-${i}.mp4`);
    expect(() => icLoraArgs({ ...ing, icReferencePaths: ref(1) })).toThrow(/needs 2-8 reference image/);
    expect(() => icLoraArgs({ ...ing, icReferencePaths: ref(9) })).toThrow(/needs 2-8 reference image/);
    expect(() => icLoraArgs({ ...ing, icReferencePaths: [] })).toThrow(/needs 2-8 reference image/);
    for (const n of [2, 5, 8]) {
      const args = icLoraArgs({ ...ing, icReferencePaths: ref(n) });
      expect(args[args.indexOf('--ic-mode') + 1]).toBe('ingredients');
      // Bounds are PASSED, never hardcoded in the helper — one registry entry
      // drives all three layers.
      expect(args[args.indexOf('--ic-min-references') + 1]).toBe('2');
      expect(args[args.indexOf('--ic-max-references') + 1]).toBe('8');
      expect(args.filter((a) => a === '--ic-reference')).toHaveLength(n);
    }
  });

  it('imposes no resolution-divisibility rule on Ingredients (factor 1) (#3112)', () => {
    // Its safetensors metadata reports reference_downscale_factor=1 (verified by a
    // Range read of the weight's header) — conditioning is full-resolution.
    expect(() => icLoraArgs({
      ...base, mode: 'ic-ingredients', width: 705, height: 449,
      icLoraWeightPath: '/mock/hf/snap/ingredients.safetensors',
      icReferencePaths: ['/mock/a.mp4', '/mock/b.mp4'],
    })).not.toThrow();
  });
});

describe('resolveVideoLoras — safetensors key-layout gate', () => {
  let resolveVideoLoras;
  beforeEach(async () => {
    vi.resetModules();
    loraLayoutState.layout = null;
    ({ resolveVideoLoras } = await import('./local.js'));
  });
  afterEach(async () => {
    loraLayoutState.layout = null;
    // Restore the shared mock here rather than inline, so a failing assertion
    // in a per-filename test can't leak its implementation into the next one.
    const { getLoraKeyLayout } = await import('../loras.js');
    vi.mocked(getLoraKeyLayout).mockImplementation(async () => loraLayoutState.layout);
  });

  it('resolves bare and ComfyUI layouts (the two the loader can fuse)', async () => {
    for (const layout of ['bare', 'comfyui']) {
      loraLayoutState.layout = layout;
      expect(await resolveVideoLoras([{ filename: 'style.safetensors', scale: 0.7 }])).toEqual([
        { path: join(MOCK_PATHS.loras, 'style.safetensors'), strength: 0.7, filename: 'style.safetensors' },
      ]);
    }
  });

  it('lets the MiniMax H3 adapter handle Diffusers and kohya layouts', async () => {
    for (const layout of ['diffusers', 'kohya']) {
      loraLayoutState.layout = layout;
      expect(await resolveVideoLoras(
        [{ filename: 'style.safetensors', scale: 0.7 }],
        { runtime: 'minimax_h3' },
      )).toEqual([
        { path: join(MOCK_PATHS.loras, 'style.safetensors'), strength: 0.7, filename: 'style.safetensors' },
      ]);
    }
  });

  it('still rejects a known non-LoRA file for MiniMax H3 before rendering', async () => {
    loraLayoutState.layout = 'not_a_lora';
    await expect(resolveVideoLoras(
      [{ filename: 'checkpoint.safetensors' }],
      { runtime: 'minimax_h3' },
    )).rejects.toMatchObject({ status: 400, code: 'LORA_LAYOUT_UNSUPPORTED' });
  });

  it('rejects a kohya-layout LoRA with an actionable 400 naming the layout', async () => {
    loraLayoutState.layout = 'kohya';
    await expect(resolveVideoLoras([{ filename: 'style.safetensors', scale: 1.0 }]))
      .rejects.toMatchObject({ status: 400, code: 'LORA_LAYOUT_UNSUPPORTED' });
    await expect(resolveVideoLoras([{ filename: 'style.safetensors' }]))
      .rejects.toThrow(/kohya/i);
  });

  it('rejects diffusers/PEFT and non-LoRA files too', async () => {
    loraLayoutState.layout = 'diffusers';
    await expect(resolveVideoLoras([{ filename: 'style.safetensors' }])).rejects.toThrow(/diffusers/i);
    loraLayoutState.layout = 'not_a_lora';
    await expect(resolveVideoLoras([{ filename: 'ckpt.safetensors' }])).rejects.toThrow(/no LoRA tensors/i);
  });

  it('rejects the whole render when ANY selected LoRA is un-fusable', async () => {
    const layouts = { 'ok.safetensors': 'comfyui', 'bad.safetensors': 'kohya' };
    const { getLoraKeyLayout } = await import('../loras.js');
    vi.mocked(getLoraKeyLayout).mockImplementation(async (f) => layouts[f] ?? null);
    await expect(resolveVideoLoras([
      { filename: 'ok.safetensors' }, { filename: 'bad.safetensors' },
    ])).rejects.toThrow(/bad\.safetensors/);
  });

  it('passes an undetermined layout through rather than blocking the render', async () => {
    loraLayoutState.layout = null;
    const resolved = await resolveVideoLoras([{ filename: 'mystery.safetensors' }]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].strength).toBe(1.0);
  });

  it('returns [] for no LoRAs without consulting the layout', async () => {
    const { getLoraKeyLayout } = await import('../loras.js');
    vi.mocked(getLoraKeyLayout).mockClear();
    expect(await resolveVideoLoras([])).toEqual([]);
    expect(await resolveVideoLoras(undefined)).toEqual([]);
    expect(getLoraKeyLayout).not.toHaveBeenCalled();
  });
});

describe('resolveVideoLoras — adapter-effect gate (#4872)', () => {
  let resolveVideoLoras;
  let probeLoraEffect;
  beforeEach(async () => {
    vi.resetModules();
    loraLayoutState.layout = 'comfyui';
    loraEffectState.reportByFilename = {};
    loraEffectState.defaultReport = { status: 'unmeasurable', measured: 0, reason: 'no numpy' };
    ({ resolveVideoLoras } = await import('./local.js'));
    ({ probeLoraEffect } = await import('../loraEffectProbe.js'));
    vi.mocked(probeLoraEffect).mockClear();
  });
  afterEach(() => {
    loraLayoutState.layout = null;
    loraEffectState.reportByFilename = {};
  });

  it('does NOT probe unless the caller opts in — a passive resolve stays free', async () => {
    await resolveVideoLoras([{ filename: 'style.safetensors' }]);
    expect(probeLoraEffect).not.toHaveBeenCalled();
  });

  it('probes every selected LoRA once the caller opts in', async () => {
    await resolveVideoLoras(
      [{ filename: 'a.safetensors' }, { filename: 'b.safetensors' }],
      { probeEffect: true },
    );
    expect(vi.mocked(probeLoraEffect).mock.calls.map(([f]) => f)).toEqual(['a.safetensors', 'b.safetensors']);
  });

  it('refuses a measured entirely-zero adapter with an actionable 400', async () => {
    loraEffectState.reportByFilename['dead.safetensors'] = {
      status: 'zero', measured: 6, zeroModules: 6,
      reason: 'all 6 measurable LoRA module(s) have exactly zero effect — fusing it would change nothing',
    };
    await expect(resolveVideoLoras([{ filename: 'dead.safetensors' }], { probeEffect: true }))
      .rejects.toMatchObject({ status: 400, code: 'LORA_EFFECT_ZERO' });
    await expect(resolveVideoLoras([{ filename: 'dead.safetensors' }], { probeEffect: true }))
      .rejects.toThrow(/dead\.safetensors.*zero effect/s);
  });

  it('refuses the whole render when ANY selected LoRA measures zero', async () => {
    loraEffectState.reportByFilename = {
      'ok.safetensors': { status: 'ok', measured: 4, medianRms: 0.01, maxRms: 0.02 },
      'dead.safetensors': { status: 'zero', measured: 4, zeroModules: 4, reason: 'zero effect' },
    };
    await expect(resolveVideoLoras(
      [{ filename: 'ok.safetensors' }, { filename: 'dead.safetensors' }],
      { probeEffect: true },
    )).rejects.toMatchObject({ code: 'LORA_EFFECT_ZERO' });
  });

  it('lets every other verdict through — the probe is a diagnostic, not a second gate', async () => {
    // A machine with no numpy, an adapter the probe cannot parse, and one whose
    // modules all diverged must all render exactly as they did before this
    // existed. Refusing on anything we did not positively measure would turn a
    // missing dependency into an un-renderable install.
    for (const report of [
      { status: 'unmeasurable', measured: 0, reason: 'numpy is not installed' },
      { status: 'unreadable', measured: 0, reason: 'no lora_A/lora_B pairs' },
      { status: 'nonfinite', measured: 0, skippedNonFinite: 8, reason: 'every module measured NaN' },
      { status: 'ok', measured: 8, medianRms: 1e-9, maxRms: 1e-8 },
      null,
    ]) {
      loraEffectState.defaultReport = report;
      const resolved = await resolveVideoLoras([{ filename: 'x.safetensors', scale: 0.6 }], { probeEffect: true });
      expect(resolved).toEqual([
        { path: join(MOCK_PATHS.loras, 'x.safetensors'), strength: 0.6, filename: 'x.safetensors' },
      ]);
    }
  });

  it('never probes a LoRA the key-layout gate already refused', async () => {
    loraLayoutState.layout = 'kohya';
    await expect(resolveVideoLoras([{ filename: 'style.safetensors' }], { probeEffect: true })).rejects.toThrow();
    expect(probeLoraEffect).not.toHaveBeenCalled();
  });
});
