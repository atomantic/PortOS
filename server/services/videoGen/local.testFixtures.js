/**
 * Shared mocks and fixtures for the local.js facade suites (generateVideo,
 * chainedVideo, frameExtraction, historyOps, stitchVideos, upscaleVideo).
 *
 * `vi.mock` calls are hoisted per test file, so each suite declares them and
 * delegates the factory here; the hoisted `await import()` of this module keeps
 * ONE instance of the state objects below alive across `vi.resetModules()`.
 */
import { vi, expect } from 'vitest';
import { join } from 'path';
import { createHash } from 'crypto';

export const heavyClaimRelease = vi.fn(async () => {});
// Repointing the machine claim at the render child's PID. Stubbed rather than
// omitted so a test can make it fail, which is how the relaunch path's
// spawned-but-never-wired child becomes observable.
export const heavyClaimHandoff = vi.fn(async () => {});
export const mockPrepareLocalMemory = vi.fn(async () => ({ unloaded: [], availableGb: 120, totalGb: 128, budgetGb: 120, blockers: [] }));

export const osFactory = async (importOriginal) => ({ ...await importOriginal(), totalmem: () => 128 * 1024 ** 3 });
export const heavyJobClaimFactory = () => ({
  claimHeavyLocalJob: vi.fn(async () => ({
    ok: true, holder: {}, release: heavyClaimRelease, handoffTo: heavyClaimHandoff,
  })),
});
export const localMemoryFactory = async (importOriginal) => ({
  ...(await importOriginal()),
  prepareLocalMemory: mockPrepareLocalMemory,
});

export const MOCK_PATHS = {
  root: '/mock/root',
  data: '/mock/data',
  videos: '/mock/data/videos',
  images: '/mock/data/images',
  videoThumbnails: '/mock/data/video-thumbnails',
  uploads: '/mock/data/uploads',
  loras: '/mock/data/loras',
};

// This install's own federation identity, so a suite that saves a new history
// row stamps a known origin instead of failing the lazy identity import.
export const FIXTURE_INSTANCE_ID = 'fixture-instance';
export const FIXTURE_INSTANCE = { self: { instanceId: FIXTURE_INSTANCE_ID, name: 'fixture-host' }, peers: [] };

// `readJSONFile` answers the two files these suites touch: the history rows a
// test set, and the fixture identity for instances.json. Returning the rows for
// instances.json (the old blanket mock) left `data.self` undefined, so origin
// stamping silently fell back to "no origin".
export const mockReadJSONFile = (rows = []) => vi.fn(async (path) => {
  const file = String(path);
  return file.endsWith('instances.json') ? FIXTURE_INSTANCE : rows;
});

export const isLtx2Python = (bin) => String(bin)
  .includes(join('.portos', 'ltx-2-mlx', '.venv', 'bin', 'python3'));
export const isLtx25Python = (bin) => String(bin)
  .includes(join('.portos', 'ltx-2.5-mlx', '.venv', 'bin', 'python3'));

// The two chain helpers below used to sleep a flat 100ms for the timeline
// stitch and then read the concat spawn / stitched history entry out of the
// mocks. That is enough on an idle machine and not enough on a contended
// worker during a full-suite run: the stitch had not landed, those reads came
// back null, and the tests failed on a TypeError rather than an assertion —
// while passing in isolation. Poll the real completion condition instead (the
// stitched history entry is written last, after the concat spawn), and fall
// through on timeout so a genuine regression still fails on its own assertion.
const stitchedHistoryEntry = (atomicWriteMock) => atomicWriteMock.mock.calls
  .flatMap(([, payload]) => (Array.isArray(payload) ? payload : []))
  .find((entry) => entry?.chainedFrom) || null;

export const waitForStitch = async () => {
  const { atomicWrite } = await import('../../lib/fileUtils.js');
  const deadline = Date.now() + 5000;
  while (!stitchedHistoryEntry(vi.mocked(atomicWrite)) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
};

export const fsPromisesMock = ({
  unlink: vi.fn(async () => {}),
  writeFile: vi.fn(async () => {}),
  copyFile: vi.fn(async () => {}),
  rm: vi.fn(async () => {}),
  readFile: vi.fn(async () => Buffer.from('')),
  mkdtemp: vi.fn(async (prefix) => `${prefix}mock`),
  rename: vi.fn(async () => {}),
});

export const probeState = { frames: 25, durationSeconds: null };
// Held apart from the vi.mock factory for the same reason as fsMockImpl below:
// tests pin these probes for their own scenario and the override outlives them.
export const probeMockImpl = ({
  probeFrameCount: async () => probeState.frames,
  probeVideoDuration: async () => probeState.durationSeconds,
});

export const { mockInspectModelCache, mockFindCachedRepoFile } = ({
  mockInspectModelCache: vi.fn(async () => ({ cached: true, sizeBytes: 1000, snapshotPath: '/mock/hf/snap' })),
  // icLoraWeights resolves an IC weight via the exact-file probe (NOT the
  // snapshot walk) so an aggregate mirror is never enumerated. Default to
  // "resident", derived from the same mocked snapshot path the tests assert on.
  mockFindCachedRepoFile: vi.fn(async (_repo, filename) => join('/mock/hf/snap', filename)),
});

export const fsState = { missOnce: [], candidateCount: null, mtimeMs: null };
// Held apart from the vi.mock factory so afterEach can put them back: several
// tests below install a whole-suite `mockReturnValue` on existsSync/statSync,
// and vi.clearAllMocks() drops calls but NOT a return-value override — so a
// leaked one silently reshapes the filesystem every later test sees.
export const fsMockImpl = ({
  // `candidateCount` caps how many anchor candidates 'exist', so a test can
  // model ffmpeg writing fewer frames than the window asked for.
  existsSync: (p) => {
    const s = String(p);
    if (fsState.candidateCount == null || !s.includes('anchorcand-')) return true;
    const n = s.match(/cand-(\d+)\.png$/);
    return n ? Number(n[1]) <= fsState.candidateCount : true;
  },
  statSync: (p) => {
    const i = fsState.missOnce.findIndex((frag) => String(p).includes(frag));
    if (i >= 0) { fsState.missOnce.splice(i, 1); return undefined; }
    return { size: 1000, mtimeMs: fsState.mtimeMs ?? Date.now() };
  },
});

export const anchorPick = { best: null };

export const h3LoraState = { capable: false, cached: null };
export const byovRevisionState = { current: null, expectedRevision: null };
export const loraLayoutState = { layout: null };
export const loraSidecarState = { byFilename: {} };
export const loraEffectState = { reportByFilename: {}, defaultReport: { status: 'unmeasurable', measured: 0, reason: 'no numpy' } };

export const spawnState = { nextExitCode: null };

export const makeProc = (exitCode) => {
  const listeners = {};
  const proc = {
    pid: 12345,
    exitCode: null,
    signalCode: null,
    killed: false,
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on(event, fn) { listeners[event] = fn; return proc; },
    off(event, fn) { if (listeners[event] === fn) delete listeners[event]; return proc; },
    kill: vi.fn(),
  };
  // fire close(0) async so the caller's .on('close') handler can register first
  setImmediate(() => {
    const code = exitCode ?? spawnState.nextExitCode ?? 0;
    spawnState.nextExitCode = null;
    proc.exitCode = code;
    listeners.close?.(code, null);
  });
  return proc;
};

// ─── mock factories (one per vi.mock in the suites) ──────────────────────────

export const fileUtilsFactory = () => ({
  tryReadFile: vi.fn().mockResolvedValue(null),
  sha256File: vi.fn(async (path) => createHash('sha256').update(path).digest('hex')),
  ensureDir: vi.fn(async () => {}),
  PATHS: MOCK_PATHS,
  // instanceIdentity.js imports dataPath from this facade; without it the lazy
  // identity read throws and origin stamping is skipped.
  dataPath: (...segments) => join(MOCK_PATHS.data, ...segments),
  readJSONFile: mockReadJSONFile(),
  atomicWrite: vi.fn(async () => {}),
  copyFileGuarded: fsPromisesMock.copyFile,
  writeFileGuarded: fsPromisesMock.writeFile,
  unlinkGuarded: fsPromisesMock.unlink,
  rmGuarded: fsPromisesMock.rm,
  // resolveVideoLoras → assertSafeLoraFilename → assertSafeFilename; the
  // filename safety check is unit-tested in loras.test.js, so a no-op here
  // lets the LoRA-arg test focus on the spawn-args plumbing.
  assertSafeFilename: vi.fn(),
  UUID_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
});

export const settingsFactory = () => ({
  getSettings: vi.fn(async () => ({ videoGen: {} })),
});

export const mediaModelsFactory = async () => {
  const { applyVideoSpeedProfiles } = await import('../../lib/videoSpeedProfiles.js');
  return ({
  getVideoModels: vi.fn(() => applyVideoSpeedProfiles([
    { id: 'ltx2_unified', name: 'LTX-2 Unified', runtime: 'ltx2', repo: 'Lightricks/LTX-Video', steps: 30, guidance: 3.5 },
    {
      id: 'ltx25_mlx_q8', name: 'LTX-2.5 MLX Q8', runtime: 'ltx25',
      repo: 'MrMofer/ltx-2.5-mlx-q8',
      revision: 'f1b56e7dc89f71a9af2cddac787b89ed22a8b7fc',
      steps: 30, guidance: 3,
    },
    // bf16 LTX-2.x mlx_video model — LoRA-capable via the generate_av wrapper.
    { id: 'ltx23_unified', name: 'LTX-2.3 Unified Beta', runtime: 'mlx_video', repo: 'notapalindrome/ltx23-mlx-av', steps: 25, guidance: 3.0 },
    // quantized mlx_video model — NOT LoRA-capable (out of scope).
    { id: 'ltx23_distilled_q4', name: 'LTX-2.3 Distilled Q4', runtime: 'mlx_video', repo: 'notapalindrome/ltx23-mlx-av-q4', steps: 25, guidance: 3.0 },
    // Compatibility fixture: the shipped profile is gone, but a user-repointed
    // or peer-synced historical entry must fail closed instead of falling into
    // the generic MLX/CUDA runner.
    { id: 'custom_hunyuan', name: 'Custom historical Hunyuan', runtime: 'hunyuan', repo: 'example-org/custom-video-runtime', supportedModes: ['text'], steps: 30, guidance: 6 },
    {
      id: 'minimax_h3_8bit', name: 'MiniMax H3 MLX 8-bit', runtime: 'minimax_h3',
      repo: 'pipenetwork/MiniMax-H3-MLX-8bit',
      revision: '3ac52081470b0488921c3ec3ba84a39097bf2361',
      supportedModes: ['text', 'image', 'fflf'], defaultFrames: 124,
      frameOptions: [107, 124, 141, 158], fpsOptions: [24],
      defaultWidth: 1344, defaultHeight: 768, resolutionStep: 32,
      steps: 8, guidance: 0, samplerLocked: true,
      requiredWeights: [{
        repo: 'MiniMaxAI/MiniMax-H3',
        revision: '6818f6c32d12b210915e44ad56a4228c2608f160',
        files: ['LICENSE', 'FL2VA/vae/video/config.json'],
      }],
      // A fixed host and the real declared floor keep admission independent of CI hardware.
      memoryProfiles: [{ id: 'unified-8bit', name: 'Unified 8-bit', minMemoryGb: 128, minVramGb: null, unified: true }],
    },
    {
      id: 'minimax_h3_cuda', name: 'MiniMax H3 CUDA int8', runtime: 'minimax_h3_cuda',
      repo: 'MiniMaxAI/MiniMax-H3',
      revision: '42ed227ee7df40d41602854ae760620d6eb651fe',
      repoFiles: ['modular_model_index.json', 'transformer/config.json'],
      supportedModes: ['text', 'image', 'fflf'], defaultFrames: 124,
      // Deliberately excludes 107 — the diffusers window starts at 5 s, so the
      // MLX grid's first point is illegal here and the two entries must not
      // share a frame list.
      frameOptions: [124, 141, 158], fpsOptions: [24],
      defaultWidth: 1344, defaultHeight: 768, resolutionStep: 32,
      steps: 8, guidance: 0, samplerLocked: true,
      memoryProfiles: [{ id: 'int8-lean', name: 'int8, leaf-level', minMemoryGb: 1, minVramGb: 12, unified: false }],
    },
    {
      id: 'minimax_h3_ref2va_8bit', name: 'MiniMax H3 Ref2VA MLX 8-bit', runtime: 'minimax_h3_ref2va',
      repo: 'Sawfwair/MiniMax-H3-Ref2VA-MLX-8bit',
      revision: '61dc387ef1a7166425cdacd63c2340598dcc364f',
      supportedModes: ['a2v'], requiresSourceImageForA2v: true,
      defaultFrames: 124, frameOptions: [107, 124, 141, 158], fpsOptions: [24],
      defaultWidth: 512, defaultHeight: 320, resolutionStep: 32,
      steps: 9, guidance: 0, samplerLocked: true,
      supportsNegativePrompt: false, supportsTiling: false, supportsDisableAudio: false,
    },
    {
      id: 'fasth3_dense_datafree_int8', name: 'FastH3 Preview v1 Dense Data-Free', runtime: 'fastvideo',
      repo: 'FastVideo/FastVideo-FastH3-4-step-Preview-v1-Dense-DataFree',
      revision: 'f624f08c6c279ab43534c003e556fc5b295b6558',
      fastvideoFamily: 'fasth3', fastvideoMlxFormat: 'int8', supportedModes: ['text'],
      defaultWidth: 832, defaultHeight: 480, defaultFrames: 124,
      frameOptions: [107, 124, 141, 158], fpsOptions: [24],
      steps: 4, guidance: 1, samplerLocked: true, supportsNegativePrompt: false,
    },
    {
      id: 'ltx25_cuda_distilled', name: 'LTX-2.5 CUDA Distilled', runtime: 'ltx25_cuda',
      repo: 'Lightricks/LTX-2.5',
      revision: 'bf86adedf518142442575d1ce2e767b7d01c8c76',
      repoFiles: [
        'diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors',
        'text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors',
      ],
      supportedModes: ['text', 'image'], defaultFrames: 121, fpsOptions: [24],
      steps: 8, guidance: 1, samplerLocked: true,
      supportsNegativePrompt: false, supportsDisableAudio: true,
    },
    {
      id: 'wan22_ti2v_5b', name: 'Wan TI2V', runtime: 'wan22',
      repo: 'AbstractFramework/wan2.2-ti2v-5b-diffusers-8bit',
      revision: '6875952a110b6bdbcfc00d72b1d89a8e02ab0fc3',
      supportedModes: ['text', 'image'], frameStride: 4, steps: 25, guidance: 5,
      guidance2: null, flowShift: 3, solver: 'unipc',
    },
    {
      id: 'wan22_cuda_ti2v_5b', name: 'Wan TI2V CUDA', runtime: 'wan22_cuda',
      repo: 'Wan-AI/Wan2.2-TI2V-5B-Diffusers',
      revision: 'b8fff7315c768468a5333511427288870b2e9635',
      supportedModes: ['text'], frameStride: 4,
      defaultWidth: 1280, defaultHeight: 704, resolutionStep: 16,
      defaultFrames: 121, steps: 50, guidance: 5,
    },
    {
      id: 'wan22_t2v_a14b_lightning', name: 'Wan T2V Lightning', runtime: 'wan22',
      repo: 'AbstractFramework/wan2.2-t2v-a14b-diffusers-8bit',
      revision: '39ee5f1f630789956f29f40b5c2c6d48c6e9a798',
      supportedModes: ['text'], frameStride: 4, steps: 4, guidance: 1,
      guidance2: 1, flowShift: 5, solver: 'euler', samplerLocked: true,
      requiredWeights: [{
        repo: 'lightx2v/Wan2.2-Lightning',
        revision: '18bccf8884ec0a078eed79785eb4ef13ea16ce1e',
        files: [
          'Wan2.2-T2V-A14B-4steps-lora-rank64-Seko-V1.1/high_noise_model.safetensors',
          'Wan2.2-T2V-A14B-4steps-lora-rank64-Seko-V1.1/low_noise_model.safetensors',
        ],
        targetRoles: ['high_noise_transformer', 'low_noise_transformer'],
      }],
    },
    {
      id: 'wan22_i2v_a14b_lightning', name: 'Wan I2V Lightning', runtime: 'wan22',
      repo: 'AbstractFramework/wan2.2-i2v-a14b-diffusers-8bit',
      revision: '1a17fbea2649c576de844e08e79fe56296751efa',
      supportedModes: ['image'], frameStride: 4, steps: 4, guidance: 1,
      guidance2: 1, flowShift: 5, solver: 'euler', samplerLocked: true,
      requiredWeights: [{
        repo: 'lightx2v/Wan2.2-Lightning',
        revision: '18bccf8884ec0a078eed79785eb4ef13ea16ce1e',
        files: [
          'Wan2.2-I2V-A14B-4steps-lora-rank64-Seko-V1/high_noise_model.safetensors',
          'Wan2.2-I2V-A14B-4steps-lora-rank64-Seko-V1/low_noise_model.safetensors',
        ],
        targetRoles: ['high_noise_transformer', 'low_noise_transformer'],
      }],
    },
  ])),
  getDefaultVideoModelId: vi.fn(() => 'ltx2_unified'),
  getTextEncoderRepo: vi.fn(() => 'some/text-encoder'),
});
};

export const sseUtilsFactory = async () => ({
  dispatchCanceledJob: (await vi.importActual('../../lib/sseUtils.js')).dispatchCanceledJob,
  broadcastSse: vi.fn(),
  attachSseClient: vi.fn(() => true),
  closeJobAfterDelay: vi.fn(),
  PYTHON_NOISE_RE: /^\s*$/,
});

export const ffmpegFactory = async () => ({
  FFMPEG_SCAN_TIMEOUT_MS: 15 * 60 * 1000,
  findFfmpeg: vi.fn(async () => '/usr/bin/ffmpeg'),
  vfrSyncArgs: vi.fn(async () => ['-fps_mode', 'vfr']),
  safeUnder: vi.fn((base, file) => (file ? join(base, file) : null)),
  generateThumbnail: vi.fn(async () => 'thumb.jpg'),
  optimizeForStreaming: vi.fn(async () => {}),
  upscaleVideo2x: vi.fn(async () => ({ ok: true })),
  extractEvaluationFrames: vi.fn(async () => []),
  // Chained renders on a window-continuity runtime probe each chunk's length
  // and cut the next hop's conditioning window from it. 25 matches the
  // numFrames the chain tests render, so the prefix math below lands on a
  // realistic value. `probeState` lets the post-completion teardown tests drive
  // both probes — including the "could not answer" null sentinel — without
  // disturbing that default.
  probeFrameCount: vi.fn(probeMockImpl.probeFrameCount),
  probeVideoDuration: vi.fn(probeMockImpl.probeVideoDuration),
  // The upscale plan endpoint (#6509) reads source geometry through this one.
  // Unused by the render paths here, but the module graph still links it.
  probeVideoStreamInfo: vi.fn(async () => ({ width: 768, height: 512, fps: 24, frameCount: 25 })),
  trimVideoFromFrame: vi.fn(async (_videoPath, outPath) => ({ ok: true, outPath })),
  hasAudioStream: vi.fn(async () => false),
  // The real builder is pure and covered by ffmpeg.test.js; keep it real here
  // so the chain tests assert on the argv that actually reaches ffmpeg.
  buildTrimConcatArgs: (await vi.importActual('../../lib/ffmpeg.js')).buildTrimConcatArgs,
  // Also real: it spawns through the mocked lib/childProcess.js, so the anchor
  // tests still read the argv off the shared spawn mock. Stubbing it would hide
  // the very args they assert on.
  runFfmpegProcess: (await vi.importActual('../../lib/ffmpeg.js')).runFfmpegProcess,
  // Report the setparams filter as available so the chain tests assert on the
  // fully-tagged argv (the degraded, container-flags-only shape is covered in
  // ffmpeg.test.js).
  bt709TagFilter: vi.fn(async () => (await vi.importActual('../../lib/ffmpeg.js')).BT709_TAG_FILTER),
});

export const extendSpliceFactory = () => ({
  spliceExtendSource: vi.fn(async () => ({ applied: false, reason: 'mocked' })),
});

export const lipsyncAlignFactory = () => ({
  alignLipsyncLead: vi.fn(async () => ({ shiftFrames: 2, lag: 2, peakScore: 0.61, reason: 'mouth-lead' })),
});

export const hfTokenFactory = () => ({
  hfChildEnv: vi.fn(async () => ({})),
  getHfToken: vi.fn(async () => null),
});

export const hfCacheFactory = async (original) => ({
  isSafeHfRepoRelativePath: (await original()).isSafeHfRepoRelativePath,
  inspectModelCache: mockInspectModelCache,
  findCachedRepoFile: mockFindCachedRepoFile,
  // Built on the singular mock rather than stubbed independently, mirroring the
  // real helper — so a test that makes ONE file miss (the partial-download
  // cases) still drives the plural probe's all-or-nothing verdict.
  findCachedRepoFiles: async (repo, filenames, opts) => {
    const paths = await Promise.all(filenames.map((name) => mockFindCachedRepoFile(repo, name, opts)));
    return paths.every(Boolean) ? paths : null;
  },
});

export const fsFactory = () => ({
  existsSync: vi.fn(fsMockImpl.existsSync),
  statSync: vi.fn(fsMockImpl.statSync),
  watch: vi.fn(() => ({ close: vi.fn() })),
});

export const frameQualityFactory = async (importOriginal) => ({
  ...await importOriginal(),
  pickBestFrame: vi.fn(async () => anchorPick.best),
});

export const runtimesFactory = async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveA2vLoraStageCapable: vi.fn(async () => true),
    byovRuntimeLoraCapable: vi.fn((runtime) => runtime === 'minimax_h3'
      && (h3LoraState.cached ?? h3LoraState.capable)),
    resolveByovRuntimeLoraCapable: vi.fn(async (runtime) => runtime === 'minimax_h3' && h3LoraState.capable),
    isByovRuntimeCurrent: vi.fn(async (runtime) => (
      byovRevisionState.current === null
        ? actual.isByovRuntimeCurrent(runtime)
        : byovRevisionState.current
    )),
    byovRuntimeExpectedRevision: vi.fn((runtime) => (
      byovRevisionState.expectedRevision === null
        ? actual.byovRuntimeExpectedRevision(runtime)
        : byovRevisionState.expectedRevision
    )),
  };
};

export const lorasFactory = () => ({
  assertSafeLoraFilename: vi.fn(),
  getLoraKeyLayout: vi.fn(async () => loraLayoutState.layout),
  // Trigger-word weaving (#4665) reads each selected LoRA's sidecar. Default to
  // "no trigger words" so every pre-existing LoRA test renders its prompt
  // unchanged; the weave tests populate `loraSidecarState.byFilename`.
  readTriggerWordsByFilename: vi.fn(async (names) => Object.fromEntries(
    (names || [])
      .map((n) => [n, loraSidecarState.byFilename[n]?.triggerWords])
      .filter(([, words]) => Array.isArray(words)),
  )),
  readLoraLicensesByFilename: vi.fn(async (names) => Object.fromEntries(
    (names || []).map((n) => {
      const sc = loraSidecarState.byFilename[n] || {};
      return [n, {
        license: typeof sc.license === 'string' && sc.license.trim() ? sc.license.trim() : null,
        sourceUrl: sc.sourceUrl || sc.civitai?.url || sc.huggingface?.url || null,
        name: sc.name || null,
      }];
    }),
  )),
});

export const loraEffectProbeFactory = () => ({
  LORA_EFFECT_PROBE_BUDGET_MS: 300_000,
  probeLoraEffect: vi.fn(async (filename) => loraEffectState.reportByFilename[filename] || loraEffectState.defaultReport),
});

export const ensureWeightsFactory = async (importOriginal) => ({
  ...(await importOriginal()),
  assertTextEncoderFilesComplete: vi.fn(async () => {}),
});

export const childProcessFactory = () => ({
  spawn: vi.fn(() => makeProc()),
  execFile: vi.fn((_bin, _args, _opts, cb) => cb?.(null, '', '')),
});

export const detachedSpawnFactory = () => ({
  spawnDetached: vi.fn(async () => makeProc()),
});

// ─── per-test lifecycle ──────────────────────────────────────────────────────

export const resetFsPromisesReadFile = () => fsPromisesMock.readFile.mockReset().mockImplementation(async (path) => Buffer.from(
  String(path).endsWith('model.safetensors.index.json')
    ? JSON.stringify({ weight_map: { example: 'model-00001-of-00001.safetensors' } }) : '',
));

export const resetSharedMocks = async () => {
  // Put the shared filesystem mock back before anything else — a test that
  // pinned existsSync/statSync to a fixed value keeps that override across
  // vi.clearAllMocks(), and the next test inherits its filesystem.
  const { existsSync, statSync } = await import('fs');
  vi.mocked(existsSync).mockImplementation(fsMockImpl.existsSync);
  vi.mocked(statSync).mockImplementation(fsMockImpl.statSync);
  const { probeFrameCount, probeVideoDuration } = await import('../../lib/ffmpeg.js');
  vi.mocked(probeFrameCount).mockImplementation(probeMockImpl.probeFrameCount);
  vi.mocked(probeVideoDuration).mockImplementation(probeMockImpl.probeVideoDuration);
  byovRevisionState.current = null;
  byovRevisionState.expectedRevision = null;
  fsState.missOnce = [];
  fsState.candidateCount = null;
  fsState.mtimeMs = null;
  probeState.frames = 25;
  probeState.durationSeconds = null;
  spawnState.nextExitCode = null;
  anchorPick.best = null;
  vi.clearAllMocks();
};

// The mocked render child closes itself on a later tick and its close handler
// (finalize + publication admission) is not awaited by generateVideo. Hold each
// render open until that handler reports a terminal event, so no completion
// outlives the test or the admission fixture's teardown, and a failed one
// fails the test that started it instead of passing on argv alone.
export const renderToTerminal = async (generateVideo, videoGenEvents, request) => {
  const jobId = request.jobId;
  let terminal;
  const settled = new Promise((resolve) => {
    terminal = (status) => (event) => { if (event.generationId === jobId) resolve({ status, error: event.error }); };
  });
  const onCompleted = terminal('completed');
  const onFailed = terminal('failed');
  videoGenEvents.on('completed', onCompleted);
  videoGenEvents.on('failed', onFailed);
  try {
    const result = await generateVideo(request);
    expect(await settled).toEqual({ status: 'completed', error: undefined });
    return result;
  } finally {
    videoGenEvents.off('completed', onCompleted);
    videoGenEvents.off('failed', onFailed);
  }
};
