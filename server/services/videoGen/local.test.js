/**
 * Tests for generateChainedVideo's extend-chain argument routing.
 *
 * Key assertion: when mode='extend' and chunks>1, every chunk after the first
 * must receive mode='extend' with extendFromVideoPath pointing to the prior
 * chunk's output video file — not mode='image' with an extracted last frame.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { basename, join } from 'path';
import { tmpdir, totalmem } from 'os';
import { MINIMAX_H3_HOST_RESERVE_GB } from '../../lib/minimaxH3Memory.js';
import { randomUUID } from 'crypto';
// Pure table, no mocking involved — a static import survives vi.resetModules().
import { INSPIRE_DEFAULT_IMAGE_STRENGTH } from '../../lib/videoReferenceModes.js';

const { heavyClaimRelease, heavyClaimHandoff, mockPrepareLocalMemory } = vi.hoisted(() => ({
  heavyClaimRelease: vi.fn(async () => {}),
  // Repointing the machine claim at the render child's PID. Stubbed rather than
  // omitted so a test can make it fail, which is how the relaunch path's
  // spawned-but-never-wired child becomes observable.
  heavyClaimHandoff: vi.fn(async () => {}),
  mockPrepareLocalMemory: vi.fn(async () => ({ unloaded: [], availableGb: 64, totalGb: 64, budgetGb: 64, blockers: [] })),
}));
vi.mock('../../lib/heavyJobClaim.js', () => ({
  claimHeavyLocalJob: vi.fn(async () => ({
    ok: true, holder: {}, release: heavyClaimRelease, handoffTo: heavyClaimHandoff,
  })),
}));
vi.mock('../localMemory.js', async (importOriginal) => ({
  ...(await importOriginal()),
  prepareLocalMemory: mockPrepareLocalMemory,
}));

// ─── dep mocks (must be declared before the module import) ───────────────────

const MOCK_PATHS = {
  root: '/mock/root',
  data: '/mock/data',
  videos: '/mock/data/videos',
  images: '/mock/data/images',
  videoThumbnails: '/mock/data/video-thumbnails',
  uploads: '/mock/data/uploads',
  loras: '/mock/data/loras',
};

const isLtx2Python = (bin) => String(bin)
  .includes(join('.portos', 'ltx-2-mlx', '.venv', 'bin', 'python3'));
const isLtx25Python = (bin) => String(bin)
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

async function waitForStitch() {
  const { atomicWrite } = await import('../../lib/fileUtils.js');
  const deadline = Date.now() + 5000;
  while (!stitchedHistoryEntry(vi.mocked(atomicWrite)) && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 10));
  }
}

vi.mock('../../lib/fileUtils.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  ensureDir: vi.fn(async () => {}),
  PATHS: MOCK_PATHS,
  readJSONFile: vi.fn(async () => []),
  atomicWrite: vi.fn(async () => {}),
  // resolveVideoLoras → assertSafeLoraFilename → assertSafeFilename; the
  // filename safety check is unit-tested in loras.test.js, so a no-op here
  // lets the LoRA-arg test focus on the spawn-args plumbing.
  assertSafeFilename: vi.fn(),
  UUID_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
}));

// The restricted-model license gate resolves authorization from the install's
// recorded acknowledgements at render time, so these tests declare whether this
// "install" has accepted MiniMax H3's license.
const H3_TERMS = 'minimax-h3-community-license-2026-08-02';
const settingsState = vi.hoisted(() => ({ acceptedModelTerms: [] }));
vi.mock('../settings.js', () => ({
  getSettings: vi.fn(async () => ({ videoGen: { acceptedModelTerms: [...settingsState.acceptedModelTerms] } })),
}));

// The SHIPPED speed-profile decorator runs over this fixture rather than the
// profiles being hand-copied onto the ltx25 entry: the mock carries the real
// repo + revision, so the pin guard is exercised and the fixture cannot drift
// from server/lib/videoSpeedProfiles.js.
vi.mock('../../lib/mediaModels.js', async () => {
  const { applyVideoSpeedProfiles } = await import('../../lib/videoSpeedProfiles.js');
  return ({
  getVideoModels: vi.fn(() => applyVideoSpeedProfiles([
    { id: 'ltx2_unified', name: 'LTX-2 Unified', runtime: 'ltx2', repo: 'Lightricks/LTX-Video', steps: 30, guidance: 3.5 },
    {
      id: 'ltx25_mlx_q8', name: 'LTX-2.5 MLX Q8', runtime: 'ltx25',
      repo: 'MrMofer/ltx-2.5-mlx-q8',
      revision: 'f1b56e7dc89f71a9af2cddac787b89ed22a8b7fc',
      steps: 8, guidance: 3,
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
      termsGate: { id: 'minimax-h3-community-license-2026-08-02' },
      requiredWeights: [{
        repo: 'MiniMaxAI/MiniMax-H3',
        revision: '6818f6c32d12b210915e44ad56a4228c2608f160',
        files: ['LICENSE', 'FL2VA/vae/video/config.json'],
      }],
      // Deliberately a 1 GB floor rather than the shipped 128 GB: these suites
      // must assert the same thing on every machine and in CI, and a real floor
      // would make the capacity gate pass or fail with the runner's own RAM.
      // The shipped table's numbers are pinned in lib/minimaxH3Memory.test.js.
      memoryProfiles: [{ id: 'unified-8bit', name: 'Unified 8-bit', minMemoryGb: 1, minVramGb: null, unified: true }],
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
      termsGate: { id: 'minimax-h3-community-license-2026-08-02' },
      memoryProfiles: [{ id: 'int8-lean', name: 'int8, leaf-level', minMemoryGb: 1, minVramGb: 12, unified: false }],
    },
    {
      id: 'wan22_ti2v_5b', name: 'Wan TI2V', runtime: 'wan22',
      repo: 'AbstractFramework/wan2.2-ti2v-5b-diffusers-8bit',
      revision: '6875952a110b6bdbcfc00d72b1d89a8e02ab0fc3',
      supportedModes: ['text', 'image'], frameStride: 4, steps: 25, guidance: 5,
      guidance2: null, flowShift: 3, solver: 'unipc',
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
});

vi.mock('../../lib/sseUtils.js', () => ({
  broadcastSse: vi.fn(),
  attachSseClient: vi.fn(() => true),
  closeJobAfterDelay: vi.fn(),
  PYTHON_NOISE_RE: /^\s*$/,
}));

vi.mock('../../lib/ffmpeg.js', async () => ({
  findFfmpeg: vi.fn(async () => '/usr/bin/ffmpeg'),
  safeUnder: vi.fn((base, file) => (file ? join(base, file) : null)),
  generateThumbnail: vi.fn(async () => 'thumb.jpg'),
  optimizeForStreaming: vi.fn(async () => {}),
  upscaleVideo2x: vi.fn(async () => ({ ok: true })),
  extractEvaluationFrames: vi.fn(async () => []),
  // Chained renders on a window-continuity runtime probe each chunk's length
  // and cut the next hop's conditioning window from it. 25 matches the
  // numFrames the chain tests render, so the prefix math below lands on a
  // realistic value.
  probeFrameCount: vi.fn(async () => 25),
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
}));

// hfChildEnv() carries the resolved token over the inherited child env; mocking here
// avoids touching the real settings layer (which would await an unmocked
// `getSettings()` chain and hang the spawn-mock-driven tests).
vi.mock('../hfToken.js', () => ({
  hfChildEnv: vi.fn(async () => ({})),
  getHfToken: vi.fn(async () => null),
}));

// resolveIcLoraWeight() inspects the HF cache to pin the exact weight file.
// That's real async fs work against the user's ~/.cache — mock the inspection
// layer so the IC-LoRA arg tests exercise the registry + arg plumbing, not the
// cache walk (which hfCache.test.js covers). `snapshotPath` non-null + the
// always-true existsSync mock below means the weight resolves to its exact
// pinned filename; a test that wants the un-cached fallback overrides this.
const { mockInspectModelCache, mockFindCachedRepoFile } = vi.hoisted(() => ({
  mockInspectModelCache: vi.fn(async () => ({ cached: true, sizeBytes: 1000, snapshotPath: '/mock/hf/snap' })),
  // icLoraWeights resolves an IC weight via the exact-file probe (NOT the
  // snapshot walk) so an aggregate mirror is never enumerated. Default to
  // "resident", derived from the same mocked snapshot path the tests assert on.
  mockFindCachedRepoFile: vi.fn(async (_repo, filename) => join('/mock/hf/snap', filename)),
}));
vi.mock('../../lib/hfCache.js', () => ({
  inspectModelCache: mockInspectModelCache,
  findCachedRepoFile: mockFindCachedRepoFile,
  // Built on the singular mock rather than stubbed independently, mirroring the
  // real helper — so a test that makes ONE file miss (the partial-download
  // cases) still drives the plural probe's all-or-nothing verdict.
  findCachedRepoFiles: async (repo, filenames, opts) => {
    const paths = await Promise.all(filenames.map((name) => mockFindCachedRepoFile(repo, name, opts)));
    return paths.every(Boolean) ? paths : null;
  },
}));

// Default: every path exists at 1000 bytes. `missOnce` lets one test drive a
// cache MISS on a path that then exists after ffmpeg writes it — which is the
// only way to reach extractLastFrame's extraction path at all, since a
// stat-everything mock otherwise short-circuits on the cache hit.
const fsState = vi.hoisted(() => ({ missOnce: [], candidateCount: null }));
vi.mock('fs', () => ({
  // `candidateCount` caps how many anchor candidates 'exist', so a test can
  // model ffmpeg writing fewer frames than the window asked for.
  existsSync: vi.fn((p) => {
    const s = String(p);
    if (fsState.candidateCount == null || !s.includes('anchorcand-')) return true;
    const n = s.match(/cand-(\d+)\.png$/);
    return n ? Number(n[1]) <= fsState.candidateCount : true;
  }),
  statSync: vi.fn((p) => {
    const i = fsState.missOnce.findIndex((frag) => String(p).includes(frag));
    if (i >= 0) { fsState.missOnce.splice(i, 1); return undefined; }
    return { size: 1000 };
  }),
  watch: vi.fn(() => ({ close: vi.fn() })),
}));

// Anchor scoring. The scorer itself is unit-tested in lib/frameQuality.test.js;
// stub the pick here so these tests drive the two outcomes extractLastFrame
// branches on — a scored winner, and a tail with nothing usable in it.
const anchorPick = vi.hoisted(() => ({ best: null }));
vi.mock('../../lib/frameQuality.js', async (importOriginal) => ({
  ...await importOriginal(),
  pickBestFrame: vi.fn(async () => anchorPick.best),
}));

// Whether the installed MiniMax H3 checkout can apply LoRAs to its quantized
// DiT. Really a spawned python probe; stubbed here so the render-path tests
// drive both verdicts without the shared child_process mock (which resolves
// every spawn successfully) silently reporting "capable".
// `cached` is the SYNC read (false on a cold cache even for a capable install);
// `capable` is the settled probe verdict. They are separate so a test can pin
// the cold-cache case, where the two legitimately disagree.
const h3LoraState = vi.hoisted(() => ({ capable: false, cached: null }));
vi.mock('./runtimes.js', async (importOriginal) => ({
  ...await importOriginal(),
  byovRuntimeLoraCapable: vi.fn((runtime) => runtime === 'minimax_h3'
    && (h3LoraState.cached ?? h3LoraState.capable)),
  resolveByovRuntimeLoraCapable: vi.fn(async (runtime) => runtime === 'minimax_h3' && h3LoraState.capable),
}));

// LoRA key-layout gate (resolveVideoLoras). `null` = undetermined, which is
// the permissive default so the pre-existing LoRA-threading tests below still
// reach the spawn path; the gate's own tests set a layout explicitly.
const loraLayoutState = vi.hoisted(() => ({ layout: null }));
const loraSidecarState = vi.hoisted(() => ({ byFilename: {} }));
vi.mock('../loras.js', () => ({
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
}));

// Adapter-effect gate (#4872). generateVideo opts every render into the probe,
// so it has to be stubbed here — the shared child_process mock resolves every
// spawn successfully, which would report a fabricated measurement. Default
// verdict is 'unmeasurable' (the permissive one: no interpreter on the box),
// so every pre-existing LoRA render test reaches the spawn path unchanged; the
// gate's own tests set a status explicitly.
const loraEffectState = vi.hoisted(() => ({ reportByFilename: {}, defaultReport: { status: 'unmeasurable', measured: 0, reason: 'no numpy' } }));
vi.mock('../loraEffectProbe.js', () => ({
  LORA_EFFECT_PROBE_BUDGET_MS: 300_000,
  probeLoraEffect: vi.fn(async (filename) => loraEffectState.reportByFilename[filename] || loraEffectState.defaultReport),
}));

vi.mock('fs/promises', () => ({
  unlink: vi.fn(async () => {}),
  writeFile: vi.fn(async () => {}),
  copyFile: vi.fn(async () => {}),
  rm: vi.fn(async () => {}),
  readFile: vi.fn(async () => Buffer.from('')),
  mkdtemp: vi.fn(async (prefix) => `${prefix}mock`),
  // Unused by the code under test, but lib/ffmpeg.js imports it and the ffmpeg
  // mock above pulls the real module in for buildTrimConcatArgs.
  rename: vi.fn(async () => {}),
}));

// Fake EventEmitter-like process that completes immediately with exit code 0.
// Shared shape for both the child_process spawn mock (ffmpeg/probe) and the
// detachedSpawn mock (the render child). Hoisted so the vi.mock factories
// (themselves hoisted above normal declarations) can reference it.
// When non-null, the NEXT spawn closes with this exit code — the only way to
// drive a partial ffmpeg run (candidates written, non-zero exit) through the
// shared proc mock.
const spawnState = vi.hoisted(() => ({ nextExitCode: null }));

const { makeProc } = vi.hoisted(() => ({
  makeProc: () => {
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
      const code = spawnState.nextExitCode ?? 0;
      spawnState.nextExitCode = null;
      proc.exitCode = code;
      listeners.close?.(code, null);
    });
    return proc;
  },
}));

vi.mock('../../lib/childProcess.js', () => ({
  spawn: vi.fn(() => makeProc()),
  execFile: vi.fn((_bin, _args, _opts, cb) => cb?.(null, '', '')),
}));

// The render child now goes through spawnDetached (double-fork survival of a
// pm2 restart). Mock it to the same fake proc, async since spawnDetached
// resolves once the PID is known.
vi.mock('../../lib/detachedSpawn.js', () => ({
  spawnDetached: vi.fn(async () => makeProc()),
}));

// ─── module under test ───────────────────────────────────────────────────────
// Import AFTER all vi.mock calls so the hoisted mocks are in place.
let updateHistoryItemPrompt;
let generateChainedVideo;
let generateVideo;
let extractLastFrame;
let stitchVideos;
let videoGenEvents;

beforeEach(async () => {
  vi.resetModules();
  // Re-import fresh copies so mock reset above applies cleanly
  ({ generateChainedVideo, generateVideo, extractLastFrame, stitchVideos, updateHistoryItemPrompt } = await import('./local.js'));
  ({ videoGenEvents } = await import('./events.js'));
});

afterEach(() => {
  settingsState.acceptedModelTerms = [];
  fsState.missOnce = [];
  fsState.candidateCount = null;
  spawnState.nextExitCode = null;
  anchorPick.best = null;
  vi.clearAllMocks();
});

describe('stitchVideos — history provenance', () => {
  const renderFields = [
    'steps',
    'guidanceScale',
    'tiling',
    'disableAudio',
    'mode',
    'textEncoderId',
    'imageStrength',
    'i2vReferenceMode',
    'conditioning',
    'renderInputsVersion',
  ];

  const stitchHistory = async (firstChunkFields = {}) => {
    const { readJSONFile } = await import('../../lib/fileUtils.js');
    const chunkIds = ['chunk-a', 'chunk-b'];
    vi.mocked(readJSONFile).mockResolvedValue([
      {
        id: chunkIds[0], filename: 'chunk-a.mp4', prompt: 'first beat',
        modelId: 'ltx2_unified', seed: 42, width: 768, height: 512,
        numFrames: 49, fps: 24, ...firstChunkFields,
      },
      {
        id: chunkIds[1], filename: 'chunk-b.mp4', prompt: 'second beat',
        modelId: 'ltx2_unified', seed: 43, width: 768, height: 512,
        numFrames: 49, fps: 24,
      },
    ]);
    return stitchVideos(chunkIds, {
      id: randomUUID(),
      filenamePrefix: 'chained',
      historyKey: 'chainedFrom',
    });
  };

  it('inherits every render dial and provenance field from the first chunk', async () => {
    const chunkRenderConfig = {
      steps: 20,
      guidanceScale: 0,
      tiling: 'none',
      disableAudio: false,
      mode: 'image',
      textEncoderId: 'example-encoder',
      imageStrength: 0,
      i2vReferenceMode: 'inspire',
      conditioning: [],
      renderInputsVersion: 1,
    };

    const stitched = await stitchHistory(chunkRenderConfig);

    expect(stitched).toMatchObject(chunkRenderConfig);
  });

  it('does not stamp absent render fields onto a legacy stitched entry', async () => {
    const stitched = await stitchHistory();

    for (const field of renderFields) expect(stitched).not.toHaveProperty(field);
  });
});

describe('extractLastFrame — anchor selection', () => {
  const ID = 'upload-ab12cd34';
  const ANCHOR = 'anchor-upload-ab12cd34.png';

  const seedHistory = async () => {
    const { readJSONFile } = await import('../../lib/fileUtils.js');
    vi.mocked(readJSONFile).mockResolvedValue([{
      id: ID,
      filename: `${ID}.mp4`,
      prompt: 'example',
    }]);
  };

  const ffmpegSpawns = async () => {
    const { spawn } = await import('../../lib/childProcess.js');
    return vi.mocked(spawn).mock.calls.map(([, args]) => (Array.isArray(args) ? args : []));
  };

  it('accepts an uploaded gallery history id and serves the cached anchor', async () => {
    await seedHistory();
    // Cache hit (statSync reports a non-empty file) — no ffmpeg at all.
    await expect(extractLastFrame(ID)).resolves.toEqual({
      filename: ANCHOR,
      path: `/data/images/${ANCHOR}`,
    });
    expect(await ffmpegSpawns()).toHaveLength(0);
  });

  it('scores the tail window and installs the winning candidate', async () => {
    await seedHistory();
    fsState.missOnce = [ANCHOR];
    anchorPick.best = {
      path: join(tmpdir(), `anchorcand-${ID}`, 'cand-003.png'),
      index: 2,
      focus: 0.81,
      quality: 0.79,
      score: 0.82,
      usable: true,
    };
    const { copyFile, writeFile, rm } = await import('fs/promises');

    await expect(extractLastFrame(ID)).resolves.toEqual({
      filename: ANCHOR,
      path: `/data/images/${ANCHOR}`,
    });

    // The winner is installed under the NEW cache name, not the legacy one, and
    // straight to it — no `.tmp` alongside, which the peer media-library
    // manifest would federate as an image asset (it skips only `.json`).
    const dest = join(MOCK_PATHS.images, ANCHOR);
    expect(vi.mocked(copyFile)).toHaveBeenCalledWith(anchorPick.best.path, dest);
    expect(vi.mocked(copyFile).mock.calls.some(([, d]) => String(d).endsWith('.tmp'))).toBe(false);
    // One decode pass over the tail window; the single-seek fallback must NOT
    // have run — that would mean the scored pick was thrown away.
    const spawns = await ffmpegSpawns();
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toEqual(expect.arrayContaining(['-sseof', '-1.00', '-vf', 'fps=12']));
    expect(spawns[0]).not.toContain('-vframes');
    // Temp candidates are cleaned up rather than left in tmpdir.
    expect(vi.mocked(rm)).toHaveBeenCalledWith(
      join(tmpdir(), `anchorcand-${ID}`),
      { recursive: true, force: true },
    );
    // Sidecar names the offset the anchor actually came from, derived from the
    // candidates actually decoded rather than a nominal window start. The fps
    // grid stops one interval short of EOF, so index 2 of 12 at 12fps sits
    // (12−2)/12 = 0.83s from the end — not 0.75s, which would be the distance
    // to the newest CANDIDATE rather than to the cut.
    const sidecar = JSON.parse(vi.mocked(writeFile).mock.calls.at(-1)[1]);
    expect(sidecar).toMatchObject({ filename: ANCHOR, extractedAt: '-0.83s' });
  });

  it('reads back exactly the candidate files it told ffmpeg to write', async () => {
    // The enumerator builds `cand-NNN.png` names by hand rather than reading the
    // directory, so nothing else checks that they match the pattern ffmpeg
    // actually received. A typo in the pattern or the padding would produce zero
    // candidates in production with every other test still green — derive the
    // expectation from the argv so the two sides can't drift apart.
    await seedHistory();
    fsState.missOnce = [ANCHOR];
    fsState.candidateCount = 3; // ffmpeg only managed three frames
    const { pickBestFrame } = await import('../../lib/frameQuality.js');

    await extractLastFrame(ID);

    const outPattern = (await ffmpegSpawns())[0].at(-1);
    expect(outPattern).toContain('%03d');
    const [scanned] = vi.mocked(pickBestFrame).mock.calls.at(-1);
    expect(scanned).toEqual([1, 2, 3].map((n) => outPattern.replace('%03d', String(n).padStart(3, '0'))));
    // Enumeration stops at the first gap instead of inventing a full window.
    expect(scanned).toHaveLength(3);
  });

  it('reports the offset against the candidates it got, not a nominal window', async () => {
    // The short-clip case the offset arithmetic exists for: `-sseof` clamps to
    // the file start, so a sub-window clip yields fewer candidates and a
    // TAIL_WINDOW_SECONDS-derived offset would name a time the frame does not
    // have. (3 − 1) / 12fps = 0.17s from the cut.
    await seedHistory();
    fsState.missOnce = [ANCHOR];
    fsState.candidateCount = 3;
    anchorPick.best = {
      path: join(tmpdir(), `anchorcand-${ID}`, 'cand-002.png'),
      index: 1,
      focus: 0.6,
      quality: 0.6,
      score: 0.65,
      usable: true,
    };
    const { writeFile } = await import('fs/promises');

    await extractLastFrame(ID);

    const sidecar = JSON.parse(vi.mocked(writeFile).mock.calls.at(-1)[1]);
    expect(sidecar).toMatchObject({ extractedAt: '-0.17s' });
  });

  it.each([
    ['re-scans', 'last-frame-unscanned', true],
    ['serves', '-0.42s', false],
    ['serves', 'last-frame', false],
  ])('%s a cached anchor whose sidecar says %s', async (_verb, extractedAt, rescans) => {
    // A one-off ffmpeg or tmpdir failure used to pin the degraded end-seek frame
    // to this clip forever behind the size>0 cache hit. The sidecar marker is
    // what makes THAT attempt provisional — and the other two rows are the
    // bypass probe: without the marker the cache must still short-circuit, or
    // every click re-spawns ffmpeg and the cache stops existing.
    const { tryReadFile } = await import('../../lib/fileUtils.js');
    await seedHistory();
    vi.mocked(tryReadFile).mockResolvedValueOnce(
      JSON.stringify({ filename: ANCHOR, extractedAt }),
    );
    anchorPick.best = null;
    fsState.candidateCount = 0; // the scan still can't produce anything

    await extractLastFrame(ID);

    // statSync reports a healthy non-zero file in every row; only the marker
    // decides whether the scan runs anyway.
    expect((await ffmpegSpawns()).length > 0).toBe(rescans);
  });

  it.each([
    ['a scan that ran and found nothing usable', 12, 'last-frame'],
    ['a scan that could not run at all', 0, 'last-frame-unscanned'],
  ])('marks the fallback anchor from %s as %s', async (_label, count, expected) => {
    // Only the second is provisional: a degenerate tail is a property of the
    // clip and must stay cached, or every click re-spawns ffmpeg for nothing.
    await seedHistory();
    fsState.missOnce = [ANCHOR];
    fsState.candidateCount = count;
    anchorPick.best = null;
    const { writeFile } = await import('fs/promises');

    await extractLastFrame(ID);

    const sidecar = JSON.parse(vi.mocked(writeFile).mock.calls.at(-1)[1]);
    expect(sidecar).toMatchObject({ extractedAt: expected });
  });

  it('names the candidate rather than a time when the scan was truncated', async () => {
    // A partial run's candidates end wherever ffmpeg stopped, not at EOF, so
    // the grid gives no distance to the cut. Inventing one would put a silent
    // lie in the gallery record.
    await seedHistory();
    fsState.missOnce = [ANCHOR];
    fsState.candidateCount = 3;
    spawnState.nextExitCode = 1; // ffmpeg wrote 3 frames, then died
    anchorPick.best = {
      path: join(tmpdir(), `anchorcand-${ID}`, 'cand-002.png'),
      index: 1, focus: 0.6, quality: 0.6, score: 0.65, usable: true,
    };
    const { writeFile } = await import('fs/promises');

    await extractLastFrame(ID);

    const sidecar = JSON.parse(vi.mocked(writeFile).mock.calls.at(-1)[1]);
    expect(sidecar).toMatchObject({ extractedAt: 'tail-candidate 2/3' });
  });

  it('treats a failed install as provisional, not as a degenerate tail', async () => {
    // A winner WAS found; only the copy failed (ENOSPC/EIO/EACCES — all
    // transient). Stamping that 'last-frame' would classify it as a property of
    // the clip and pin the degraded end-seek anchor behind the cache forever.
    await seedHistory();
    fsState.missOnce = [ANCHOR];
    anchorPick.best = {
      path: join(tmpdir(), `anchorcand-${ID}`, 'cand-006.png'),
      index: 5, focus: 0.7, quality: 0.7, score: 0.8, usable: true,
    };
    const { copyFile, writeFile } = await import('fs/promises');
    vi.mocked(copyFile).mockRejectedValueOnce(new Error('ENOSPC'));

    await extractLastFrame(ID);

    const sidecar = JSON.parse(vi.mocked(writeFile).mock.calls.at(-1)[1]);
    expect(sidecar).toMatchObject({ extractedAt: 'last-frame-unscanned' });
  });

  it('clears a stale provisional marker once a scan finally runs', async () => {
    // call 1 could not scan → 'last-frame-unscanned'; call 2 scans and finds the
    // tail genuinely degenerate. The `wx` sidecar write is a no-op against the
    // surviving file, so without an unconditional unlink the marker outlives the
    // scan and the clip re-scans on every click forever.
    const { tryReadFile } = await import('../../lib/fileUtils.js');
    await seedHistory();
    vi.mocked(tryReadFile).mockResolvedValueOnce(
      JSON.stringify({ filename: ANCHOR, extractedAt: 'last-frame-unscanned' }),
    );
    fsState.candidateCount = 12; // this time the scan runs...
    anchorPick.best = null;      // ...and the tail really is degenerate
    const { unlink, writeFile } = await import('fs/promises');

    await extractLastFrame(ID);

    const sidecarPath = join(MOCK_PATHS.images, ANCHOR.replace('.png', '.metadata.json'));
    expect(vi.mocked(unlink)).toHaveBeenCalledWith(sidecarPath);
    const sidecar = JSON.parse(vi.mocked(writeFile).mock.calls.at(-1)[1]);
    expect(sidecar).toMatchObject({ extractedAt: 'last-frame' });
  });

  it('falls back to the end seek when no candidate is usable', async () => {
    await seedHistory();
    fsState.missOnce = [ANCHOR];
    anchorPick.best = null;
    const { copyFile, writeFile } = await import('fs/promises');

    await expect(extractLastFrame(ID)).resolves.toEqual({
      filename: ANCHOR,
      path: `/data/images/${ANCHOR}`,
    });

    expect(vi.mocked(copyFile)).not.toHaveBeenCalled();
    const spawns = await ffmpegSpawns();
    expect(spawns).toHaveLength(2);
    expect(spawns[1]).toEqual(expect.arrayContaining(['-sseof', '-1.0', '-vframes', '1']));
    // The fallback genuinely doesn't know which frame it got, so the sidecar
    // keeps the legacy value rather than inventing an offset.
    const sidecar = JSON.parse(vi.mocked(writeFile).mock.calls.at(-1)[1]);
    expect(sidecar).toMatchObject({ extractedAt: 'last-frame' });
  });
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
async function runChainAndCaptureArgs(chainParams, totalChunks) {
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
    // eslint-disable-next-line no-await-in-loop
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

// ─── tests ───────────────────────────────────────────────────────────────────

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
    settingsState.acceptedModelTerms = [H3_TERMS];
    const outerJobId = randomUUID();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let outerCompleted = false;
    videoGenEvents.on('completed', (event) => {
      if (event.generationId === outerJobId) outerCompleted = true;
    });

    await generateChainedVideo({
      chunks: 2,
      jobId: outerJobId,
      pythonPath: '/usr/bin/python3',
      modelId: 'minimax_h3_8bit',
      prompt: 'test prompt',
      mode: 'text',
    });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('2 chunks, eta=20s (measured, n=1)'));
    await vi.waitFor(() => expect(outerCompleted).toBe(true));
    videoGenEvents.removeAllListeners('completed');
    logSpy.mockRestore();
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
  // …versus the 123 frames actually on the timeline if the cuts don't land.
  const UNTRIMMED_FRAMES_3_CHUNKS = 123;

  const flagValue = (args, flag) => (Array.isArray(args) && args.includes(flag)
    ? args[args.indexOf(flag) + 1] : null);

  /**
   * Drive a chain and return everything the continuation path touches: the
   * argv of each chunk's render child, every trim the orchestrator asked for,
   * and the raw child_process spawns (which is where both extractLastFrame's
   * `-sseof` seek and the final concat show up).
   */
  async function runChain(chainParams, totalChunks, probeFrames = null) {
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

    generateChainedVideo({
      chunks: totalChunks,
      jobId: randomUUID(),
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
      // eslint-disable-next-line no-await-in-loop
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

  it('falls back to a stream copy when the trimmed filter graph fails, rather than losing the chain', async () => {
    // The pre-trim implementation degraded to a repeated seam when a chunk
    // trim failed, because failing there would have discarded every chunk
    // already rendered. Moving the cut into the concat has to keep that: the
    // untrimmed chunks were never re-encoded, so they're still in codec
    // lockstep and the demuxer can still assemble them.
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
      const { spawns, stitched } = await runChain({}, 3);
      const concats = spawns.map(([, args]) => args).filter(Array.isArray);
      expect(concats.some((args) => args.includes('-filter_complex'))).toBe(true);
      // …and the salvage run, which is the plain demuxer stream copy.
      const copy = concats.find((args) => args.includes('-f') && args.includes('copy'));
      expect(copy).toBeTruthy();
      // The echoes are still in the output, so the record must say so — and
      // "so" is the chunks' MEASURED lengths (25 + 49 + 49), not the numFrames
      // they were rendered at, which understates an extend render's file by
      // the whole context window.
      expect(stitched?.numFrames).toBe(UNTRIMMED_FRAMES_3_CHUNKS);
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
      expect(flagValue(args, '--steps')).toBe('8');
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

describe('generateChainedVideo — resolved geometry on the outer frames (#4588)', () => {
  it('carries the chunk geometry on the chain progress frames without a synthetic outer started', async () => {
    const { readJSONFile } = await import('../../lib/fileUtils.js');
    const outerJobId = randomUUID();
    const innerJobIds = [];
    const startedIds = [];
    const outerProgress = [];
    const onStarted = (e) => {
      startedIds.push(e.generationId);
      if (e.generationId === outerJobId) return;
      innerJobIds.push(e.generationId);
      // Feed the live chunk a progress frame from a microtask: the chain's own
      // `started` listener is registered AFTER this one, so it has to run (and
      // record the geometry) before the progress frame goes out — and a
      // microtask still lands before the chunk's first awaited I/O, while its
      // per-chunk listeners are attached.
      queueMicrotask(() => {
        videoGenEvents.emit('progress', { generationId: e.generationId, progress: 0.5, step: 5, totalSteps: 10 });
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
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(outerProgress[0]).toMatchObject({
      generationId: outerJobId, width: 512, height: 512, step: 5, totalSteps: 10,
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
      // eslint-disable-next-line no-await-in-loop
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
      ({ ltx25TextEncoderArgs } = await import('./local.js'));
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

describe('FFLF/ltx2 pixel-budget helpers', () => {
  const DEFAULT_BUDGET = 704 * 448 * 25; //  7,884,800 — 48 GB floor
  const BUDGET_128GB = 768 * 512 * 97; // 38,141,952 — 128 GB anchor
  const GB = 1024 ** 3;

  let resolveFflfLtx2PixelBudget;
  let computeFflfLtx2PixelBudget;
  let computeFflfSafeFrames;

  beforeEach(async () => {
    ({ resolveFflfLtx2PixelBudget, computeFflfLtx2PixelBudget, computeFflfSafeFrames } =
      await import('./local.js'));
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
    ({ resolveT2vTwoStageOverride } = await import('./local.js'));
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

describe('generateVideo — panel-side completion watchdog', () => {
  // Build a fake child that does NOT auto-exit, exposing handles to its stdout
  // 'data' listener and 'close' handler so the test can drive completion
  // detection + the grace-timer escalation deterministically.
  function makeHangingProc() {
    const listeners = {};
    let stdoutData = null;
    const proc = {
      pid: 4242,
      exitCode: null, // stays null — the child never exits on its own
      signalCode: null,
      killed: false,
      stdout: { on: vi.fn((event, fn) => { if (event === 'data') stdoutData = fn; }) },
      stderr: { on: vi.fn() },
      on(event, fn) { listeners[event] = fn; return proc; },
      off(event, fn) { if (listeners[event] === fn) delete listeners[event]; return proc; },
      kill: vi.fn((signal) => { proc.killed = true; proc.signalCode = signal; }),
    };
    return {
      proc,
      emitStdout: (text) => stdoutData?.(Buffer.from(text)),
      fireClose: (code, signal) => listeners.close?.(code, signal),
    };
  }

  beforeEach(async () => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.VIDEOGEN_COMPLETION_WATCHDOG_MS;
  });

  it('SIGKILLs a child that prints the result JSON but never exits, after the grace window', async () => {
    process.env.VIDEOGEN_COMPLETION_WATCHDOG_MS = '40000';
    // re-import so the module-level grace constant picks up the env override
    vi.resetModules();
    ({ generateVideo } = await import('./local.js'));

    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const hang = makeHangingProc();
    vi.mocked(spawnDetached).mockImplementationOnce(async () => hang.proc);

    generateVideo({
      jobId: 'watchdog-json-hang',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'render and hang',
      width: 512, height: 512, numFrames: 25, fps: 24,
      mode: 'text',
    });

    // Let generateVideo run far enough to register stdout/close handlers.
    await vi.advanceTimersByTimeAsync(0);

    // The render finishes its real work and emits the result JSON, then hangs.
    hang.emitStdout('{"video_path": "/data/videos/out.mp4"}\n');
    expect(hang.proc.kill).not.toHaveBeenCalled();

    // Just before the grace window, still no kill.
    await vi.advanceTimersByTimeAsync(39999);
    expect(hang.proc.kill).not.toHaveBeenCalled();

    // Past the grace window — the watchdog escalates to SIGKILL.
    await vi.advanceTimersByTimeAsync(2);
    expect(hang.proc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('SIGKILLs a child that prints the muxing-done line but never exits', async () => {
    process.env.VIDEOGEN_COMPLETION_WATCHDOG_MS = '40000';
    vi.resetModules();
    ({ generateVideo } = await import('./local.js'));

    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const hang = makeHangingProc();
    vi.mocked(spawnDetached).mockImplementationOnce(async () => hang.proc);

    generateVideo({
      jobId: 'watchdog-mux-hang',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'mux and hang',
      width: 512, height: 512, numFrames: 25, fps: 24,
      mode: 'text',
    });
    await vi.advanceTimersByTimeAsync(0);

    hang.emitStdout('[Decoding video + audio + muxing] done in 3.2s\n');
    await vi.advanceTimersByTimeAsync(40001);
    expect(hang.proc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('reports completed (not failed) when the watchdog SIGKILL fires after a real render finished', async () => {
    process.env.VIDEOGEN_COMPLETION_WATCHDOG_MS = '40000';
    vi.resetModules();
    ({ generateVideo } = await import('./local.js'));
    ({ videoGenEvents } = await import('./events.js'));

    // The output file exists + is non-empty (fs mock already returns true/size 1000),
    // so the watchdog-killed render must be treated as a success.
    const { existsSync, statSync } = await import('fs');
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(statSync).mockReturnValue({ size: 1000 });

    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const hang = makeHangingProc();
    vi.mocked(spawnDetached).mockImplementationOnce(async () => hang.proc);

    const events = [];
    const onCompleted = (e) => events.push(['completed', e]);
    const onFailed = (e) => events.push(['failed', e]);
    videoGenEvents.on('completed', onCompleted);
    videoGenEvents.on('failed', onFailed);

    generateVideo({
      jobId: 'watchdog-success-recover',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'render then teardown-hang',
      width: 512, height: 512, numFrames: 25, fps: 24,
      mode: 'text',
    });
    await vi.advanceTimersByTimeAsync(0);

    // Render emits its result JSON, then hangs in teardown.
    hang.emitStdout('{"video_path": "/data/videos/out.mp4"}\n');
    // Watchdog fires the SIGKILL past the grace window.
    await vi.advanceTimersByTimeAsync(40001);
    expect(hang.proc.kill).toHaveBeenCalledWith('SIGKILL');
    // The OS delivers the kill → 'close' fires with signal SIGKILL.
    hang.fireClose(null, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(0);

    videoGenEvents.off('completed', onCompleted);
    videoGenEvents.off('failed', onFailed);

    const kinds = events.map(([k]) => k);
    expect(kinds).toContain('completed');
    expect(kinds).not.toContain('failed');
  });

  it('still reports failed when a SIGKILL arrives without a completion marker (real OOM kill)', async () => {
    process.env.VIDEOGEN_COMPLETION_WATCHDOG_MS = '40000';
    vi.resetModules();
    ({ generateVideo } = await import('./local.js'));
    ({ videoGenEvents } = await import('./events.js'));

    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const hang = makeHangingProc();
    vi.mocked(spawnDetached).mockImplementationOnce(async () => hang.proc);

    const events = [];
    const onCompleted = (e) => events.push(['completed', e]);
    const onFailed = (e) => events.push(['failed', e]);
    videoGenEvents.on('completed', onCompleted);
    videoGenEvents.on('failed', onFailed);

    generateVideo({
      jobId: 'watchdog-oom-kill',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'oom before completion',
      width: 512, height: 512, numFrames: 25, fps: 24,
      mode: 'text',
    });
    await vi.advanceTimersByTimeAsync(0);

    // No completion marker ever seen — the kernel OOM-kills the child mid-render.
    hang.fireClose(null, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(0);

    videoGenEvents.off('completed', onCompleted);
    videoGenEvents.off('failed', onFailed);

    const kinds = events.map(([k]) => k);
    expect(kinds).toContain('failed');
    expect(kinds).not.toContain('completed');
  });

  it('does NOT SIGKILL when the child exits cleanly after completion (timer is cleared on close)', async () => {
    process.env.VIDEOGEN_COMPLETION_WATCHDOG_MS = '40000';
    vi.resetModules();
    ({ generateVideo } = await import('./local.js'));

    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const hang = makeHangingProc();
    vi.mocked(spawnDetached).mockImplementationOnce(async () => hang.proc);

    generateVideo({
      jobId: 'watchdog-clean-exit',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'render and exit',
      width: 512, height: 512, numFrames: 25, fps: 24,
      mode: 'text',
    });
    await vi.advanceTimersByTimeAsync(0);

    // Completion marker arms the watchdog…
    hang.emitStdout('{"video_path": "/data/videos/out.mp4"}\n');
    // …but the child then exits cleanly well within the grace window.
    hang.proc.exitCode = 0;
    hang.fireClose(0, null);
    await vi.advanceTimersByTimeAsync(0);

    // Advancing past the grace window must NOT trigger a SIGKILL — the close
    // handler cleared the timer.
    await vi.advanceTimersByTimeAsync(60000);
    expect(hang.proc.kill).not.toHaveBeenCalled();
  });

  it('allows a render to continue without a completion marker', async () => {
    process.env.VIDEOGEN_COMPLETION_WATCHDOG_MS = '40000';
    vi.resetModules();
    ({ generateVideo } = await import('./local.js'));

    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const hang = makeHangingProc();
    vi.mocked(spawnDetached).mockImplementationOnce(async () => hang.proc);

    generateVideo({
      jobId: 'watchdog-no-marker',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'progress only',
      width: 512, height: 512, numFrames: 25, fps: 24,
      mode: 'text',
    });
    await vi.advanceTimersByTimeAsync(0);

    // A render may be silent for an extended period before it exits. The
    // completion watchdog is not armed until a completion marker is seen, and
    // there is no separate idle timeout that can terminate this render.
    await vi.advanceTimersByTimeAsync(120000);
    expect(hang.proc.kill).not.toHaveBeenCalled();
  });
});

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
    expect(args[0]).toBe(join(MOCK_PATHS.root, 'scripts', 'generate_av_lora.py'));
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
    expect(call[1]).not.toContain(join(MOCK_PATHS.root, 'scripts', 'generate_av_lora.py'));
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

describe('generateVideo — heavy claim setup cleanup (#4364)', () => {
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

    await generateVideo({
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
      await generateVideo({
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

    await generateVideo({
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

    await generateVideo({
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

  // An upstream conditioner arrives as several shards, and the loader globs the
  // shim directory — so every pinned shard has to reach the helper. Forwarding
  // just the first would load a module tree with most of its layers missing.
  it('forwards every shard of a multi-shard text encoder', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const { downloadableVideoTextEncoder } = await import('../../lib/videoTextEncoders.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();

    await generateVideo({
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

    await generateVideo({
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
      await generateVideo({
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

    await generateVideo({
      jobId: `h3-memory-${modelId}`,
      modelId,
      prompt: 'a fox watches the rain',
      width: 1344, height: 768, numFrames: 124, fps: 24, mode: 'text',
    });

    const [, args] = spawnMock.mock.calls.find(([, childArgs]) => (
      Array.isArray(childArgs) && childArgs.some((arg) => basename(String(arg)) === helper)
    ));
    expect(args[args.indexOf('--min-system-memory-gb') + 1]).toBe('1');
    expect(args[args.indexOf('--memory-headroom-gb') + 1]).toBe(String(MINIMAX_H3_HOST_RESERVE_GB));
    // Only the MLX lane takes a server-selected profile: on CUDA the tier is
    // VRAM-driven, so it stays the runner's call on --offload-profile.
    if (expectedProfile) expect(args[args.indexOf('--memory-profile') + 1]).toBe(expectedProfile);
    else expect(args).not.toContain('--memory-profile');
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

// H3's DiT is quantized, so LoRAs ride along only if the installed runner
// applies them at render time from quantization metadata. That is a property of
// the installed runtime plus adapter, so the verdict comes from a probe — and
// the render path must honor it in both directions rather than blanket-rejecting
// the runtime.
describe.skipIf(process.platform === 'win32')('MiniMax H3 user LoRAs', () => {
  const h3Render = (jobId) => generateVideo({
    jobId,
    modelId: 'minimax_h3_8bit',
    prompt: 'a fox watches the rain',
    width: 512, height: 320, numFrames: 141, fps: 24, mode: 'text',
    loras: [{ filename: 'fox.safetensors', scale: 0.8 }],
  });

  beforeEach(() => { settingsState.acceptedModelTerms = [H3_TERMS]; });
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

    await generateVideo({
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

    await generateVideo({
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

  it('SIGABRT names the macOS Metal command-buffer watchdog with a resolution/frame-count next step', async () => {
    const evt = await failWithSignal('signal-sigabrt', 'SIGABRT');
    expect(evt.error).toMatch(/Metal command-buffer watchdog/i);
    expect(evt.error).toMatch(/kIOGPUCommandBufferCallbackErrorImpactingInteractivity/);
    expect(evt.error).toMatch(/resolution/i);
    expect(evt.error).toMatch(/frame count/i);
    // The old bare wording must be gone.
    expect(evt.error).not.toMatch(/Killed by signal SIGABRT/);
  });

  it('SIGBUS and SIGSEGV name a native MLX/Metal crash', async () => {
    for (const [i, sig] of ['SIGBUS', 'SIGSEGV'].entries()) {
      // eslint-disable-next-line no-await-in-loop
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
    })).rejects.toThrow(/require an ltx2-runtime model/);
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

    it('cleans up EVERY temp clip when one still fails to encode', async () => {
      // Promise.all rejects at the first failure while siblings are still in
      // flight, so a push-on-success registry would miss the ones that landed
      // afterwards. Every target path is registered before any encode starts.
      const { execFile } = await import('../../lib/childProcess.js');
      const { unlink } = await import('fs/promises');
      const execFileMock = vi.mocked(execFile);
      const unlinkMock = vi.mocked(unlink);
      execFileMock.mockClear();
      unlinkMock.mockClear();

      // Fail the SECOND still; the first and third still succeed.
      let stillIndex = 0;
      execFileMock.mockImplementation((_bin, args, _opts, cb) => {
        if (args.includes('-loop')) {
          const mine = stillIndex++;
          if (mine === 1) return cb?.(new Error('ffmpeg exploded'));
        }
        return cb?.(null, '', '');
      });

      await expect(generateVideo({
        ...baseIngredients, jobId: 'ing-partial-fail',
        icReferencePaths: ['/mock/images/a.png', '/mock/images/b.png', '/mock/images/c.png'],
      })).rejects.toThrow(/Failed to prepare Ingredients reference b\.png/);

      // All three temp paths unlinked, not just the ones that had resolved when
      // the rejection fired.
      const unlinked = unlinkMock.mock.calls.map(([p]) => String(p));
      for (const i of [0, 1, 2]) {
        expect(unlinked.some((p) => p.includes(`ic-still-${i}-ing-partial-fail.mp4`))).toBe(true);
      }
      // The ORIGINAL gallery stills are the user's files and must survive.
      for (const f of ['/mock/images/a.png', '/mock/images/b.png', '/mock/images/c.png']) {
        expect(unlinked).not.toContain(f);
      }
      execFileMock.mockImplementation((_bin, _args, _opts, cb) => cb?.(null, '', ''));
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
      icStrength: 0.6, icSkipStage2: true,
    });

    videoGenEvents.off('started', onStarted);
    const meta = started.find((s) => s.generationId === 'ic-history-stamp');
    expect(meta).toBeTruthy();
    expect(meta.mode).toBe('ic-control');
    expect(meta.icStrength).toBe(0.6);
    expect(meta.icSkipStage2).toBe(true);
    // BASENAME only — the absolute staging path is machine-specific and never
    // belongs in a user-facing history record.
    expect(meta.icReferenceNames).toEqual(['depth.mp4']);
  });
});

describe('icLoraArgs — direct validation (#3100)', () => {
  let icLoraArgs;
  beforeEach(async () => { ({ icLoraArgs } = await import('./local.js')); });

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

describe('generateVideo — MiniMax H3 CUDA contract', () => {
  // Same license gate as the MLX entry: it is the same weights under the same
  // terms, so acceptance is recorded once and honored by both runtimes.
  beforeEach(() => { settingsState.acceptedModelTerms = [H3_TERMS]; });

  const cudaCall = (spawnMock) => spawnMock.mock.calls.find(([, args]) => (
    Array.isArray(args) && args.some((arg) => basename(String(arg)) === 'generate_minimax_h3_cuda.py')
  ));

  it('dispatches to the CUDA helper and venv, never to the MLX port or generate_win.py', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();

    await generateVideo({
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

    await generateVideo({
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

    const render = () => generateVideo({
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

    await generateVideo({
      jobId: 'h3-cuda-offload-default',
      modelId: 'minimax_h3_cuda',
      prompt: 'a fox watches the rain',
      width: 1344, height: 768, numFrames: 141, fps: 24, mode: 'text',
    });

    const [, args] = cudaCall(spawnMock);
    expect(args).not.toContain('--offload-profile');
  });
});

// ── one-shot prompt-encode relaunch after a Metal watchdog abort (#4589) ─────
// A real Metal abort can't be produced here, so the child is driven directly:
// the marker lines and the abort banner are pushed onto its stderr, then it is
// closed on SIGABRT exactly as the OS would. What is under test is the decision
// generateVideo makes from that wreckage — relaunch or fail — plus the argv the
// relaunch carries.
describe('generateVideo — Gemma prompt-encode watchdog relaunch', () => {
  const TIMEOUT_ABORT = 'libc++abi: terminating due to uncaught exception of type std::runtime_error: [METAL] Command buffer execution failed: Caused GPU Timeout Error (00000002:kIOGPUCommandBufferCallbackErrorTimeout)';
  const INTERACTIVITY_ABORT = 'libc++abi: terminating due to uncaught exception: [METAL] Command buffer execution failed: (00000004:kIOGPUCommandBufferCallbackErrorImpactingInteractivity)';
  const OOM_ABORT = '[METAL] Command buffer execution failed: (00000008:kIOGPUCommandBufferCallbackErrorOutOfMemory)';

  // A child whose stderr and terminal signal the test drives by hand. The
  // shared makeProc() closes itself on exit 0, which is the opposite of every
  // case here.
  const makeDrivenProc = (pid, { failWiring = false } = {}) => {
    const listeners = {};
    const onData = {};
    const proc = {
      pid,
      exitCode: null,
      signalCode: null,
      killed: false,
      stdout: {
        on: vi.fn((event, fn) => {
          if (failWiring) throw new Error('stdout stream vanished');
          onData[`stdout:${event}`] = fn;
        }),
      },
      stderr: { on: vi.fn((event, fn) => { onData[`stderr:${event}`] = fn; }) },
      on(event, fn) { listeners[event] = fn; return proc; },
      off(event, fn) { if (listeners[event] === fn) delete listeners[event]; return proc; },
      kill: vi.fn(),
    };
    return {
      proc,
      // Full wiring — the stdout reader goes on with the real terminal handler,
      // and only there. The pre-handoff exit buffer subscribes to 'close'/'error'
      // alone, so this stays false across the handoff window even though the
      // child's exit can no longer be lost.
      isWired: () => typeof onData['stdout:data'] === 'function',
      stderr: (text) => onData['stderr:data']?.(Buffer.from(`${text}\n`)),
      close: async (code, signal) => {
        proc.exitCode = code;
        proc.signalCode = signal;
        await listeners.close?.(code, signal);
      },
      abort: async (signal = 'SIGABRT') => {
        proc.signalCode = signal;
        await listeners.close?.(null, signal);
      },
      finish: async () => {
        proc.exitCode = 0;
        await listeners.close?.(0, null);
      },
    };
  };

  let restorePlatform = () => {};
  let failures;
  let onFailed;

  beforeEach(async () => {
    // The command-buffer watchdog is a macOS construct and generateVideo gates
    // the relaunch on the real platform, so pin it — otherwise this whole
    // describe would silently assert "never relaunches" on Windows CI.
    // Pinned inside the hook, never at module scope: local.js is already
    // imported by then.
    const { pinPlatform } = await import('../../lib/testHelper.js');
    restorePlatform = pinPlatform('darwin');
    failures = [];
    onFailed = (payload) => failures.push(payload);
    videoGenEvents.on('failed', onFailed);
  });

  afterEach(() => {
    videoGenEvents.off('failed', onFailed);
    restorePlatform();
  });

  const startRender = async (jobId, children) => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    spawnMock.mockClear();
    for (const child of children) spawnMock.mockResolvedValueOnce(child.proc);
    await generateVideo({
      jobId,
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'a lighthouse in fog',
      width: 512,
      height: 512,
      numFrames: 25,
      fps: 24,
      seed: 987654,
    });
    return spawnMock;
  };

  const ltx2Calls = (spawnMock) => spawnMock.mock.calls.filter(([bin]) => isLtx2Python(bin));
  const flagValue = (args, flag) => args[args.indexOf(flag) + 1];

  it.each([
    ['the classic timeout signature', TIMEOUT_ABORT],
    ['the impacting-interactivity signature newer macOS reports', INTERACTIVITY_ABORT],
  ])('relaunches once at a reduced Gemma budget on %s', async (_label, abort) => {
    const first = makeDrivenProc(101);
    const second = makeDrivenProc(102);
    const spawnMock = await startRender(`pe-${abort.length}`, [first, second]);

    first.stderr('STAGE:encode-prompt');
    first.stderr(abort);
    await first.abort();

    const calls = ltx2Calls(spawnMock);
    expect(calls).toHaveLength(2);
    const [firstArgs, retryArgs] = calls.map(([, args]) => args);
    // The original render never carries the flag — the reduced budget exists
    // only as the mitigation, not as a new default.
    expect(firstArgs).not.toContain('--gemma-max-length');
    expect(flagValue(retryArgs, '--gemma-max-length')).toBe('512');
    // Same render, smaller prompt budget: seed and output must survive verbatim
    // or the relaunch silently produces a different clip than the user asked for.
    expect(flagValue(retryArgs, '--seed')).toBe(flagValue(firstArgs, '--seed'));
    expect(flagValue(retryArgs, '--seed')).toBe('987654');
    expect(flagValue(retryArgs, '--output')).toBe(flagValue(firstArgs, '--output'));
    expect(flagValue(retryArgs, '--prompt')).toBe(flagValue(firstArgs, '--prompt'));
    // The aborted child must not surface as a terminal failure — the job is
    // still running, on its replacement child.
    expect(failures).toHaveLength(0);

    await second.finish();
  });

  // The bypass probe for the phase gate: identical abort, identical signal, one
  // extra marker line. If the gate were dropped this case would relaunch too.
  it('does not relaunch once the prompt encode has finished', async () => {
    const first = makeDrivenProc(103);
    const spawnMock = await startRender('pe-after-encode', [first]);

    first.stderr('STAGE:encode-prompt');
    first.stderr('STAGE:encode-prompt-done');
    first.stderr(TIMEOUT_ABORT);
    await first.abort();

    expect(ltx2Calls(spawnMock)).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].error).toMatch(/SIGABRT/);
  });

  // An OOM abort is not a watchdog timeout: a shorter prompt does not fix it,
  // and relaunching burns another model load on a machine already out of room.
  it('does not relaunch on an out-of-memory abort inside the encoder', async () => {
    const first = makeDrivenProc(104);
    const spawnMock = await startRender('pe-oom', [first]);

    first.stderr('STAGE:encode-prompt');
    first.stderr(OOM_ABORT);
    await first.abort();

    expect(ltx2Calls(spawnMock)).toHaveLength(1);
    expect(failures).toHaveLength(1);
  });

  it('relaunches at most once — a second abort at the reduced budget fails the job', async () => {
    const first = makeDrivenProc(105);
    const second = makeDrivenProc(106);
    const spawnMock = await startRender('pe-twice', [first, second]);

    first.stderr('STAGE:encode-prompt');
    first.stderr(TIMEOUT_ABORT);
    await first.abort();
    expect(ltx2Calls(spawnMock)).toHaveLength(2);

    second.stderr('STAGE:encode-prompt');
    second.stderr(TIMEOUT_ABORT);
    await second.abort();

    expect(ltx2Calls(spawnMock)).toHaveLength(2);
    expect(failures).toHaveLength(1);
  });

  it('never relaunches off macOS, where the command-buffer watchdog does not exist', async () => {
    restorePlatform();
    const { pinPlatform } = await import('../../lib/testHelper.js');
    restorePlatform = pinPlatform('win32');
    const first = makeDrivenProc(107);
    const spawnMock = await startRender('pe-win32', [first]);

    first.stderr('STAGE:encode-prompt');
    first.stderr(TIMEOUT_ABORT);
    await first.abort();

    expect(ltx2Calls(spawnMock)).toHaveLength(1);
    expect(failures).toHaveLength(1);
  });

  // A cancel is answered by SIGTERM, so the child normally dies on a signal the
  // classifier already ignores — but a cancel that RACES an abort already in
  // flight still arrives as SIGABRT. Relaunching there would restart the render
  // the user just stopped.
  it('does not relaunch a child PortOS killed on purpose, even on SIGABRT', async () => {
    const first = makeDrivenProc(108);
    const spawnMock = await startRender('pe-killed', [first]);

    first.stderr('STAGE:encode-prompt');
    first.stderr(TIMEOUT_ABORT);
    // What killWithEscalation() leaves behind on the handle when cancel() fires.
    first.proc.killed = true;
    await first.abort();

    expect(ltx2Calls(spawnMock)).toHaveLength(1);
    expect(failures).toHaveLength(1);
  });

  // The relaunch clears activeProcess before it awaits the replacement spawn, so
  // for that window cancel() has nothing to kill and reports false. The epoch
  // check is the only thing that notices — without it the replacement child runs
  // to completion after the user asked to stop.
  it('abandons the replacement child when a cancel lands during the relaunch spawn', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const { cancel } = await import('./local.js');
    const spawnMock = vi.mocked(spawnDetached);
    const first = makeDrivenProc(109);
    const second = makeDrivenProc(110);
    spawnMock.mockClear();
    spawnMock.mockResolvedValueOnce(first.proc);
    // Cancel from INSIDE the spawn await — the exact window activeProcess is null.
    spawnMock.mockImplementationOnce(async () => {
      cancel();
      return second.proc;
    });
    await generateVideo({
      jobId: 'pe-cancel-race',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'a lighthouse in fog',
      width: 512,
      height: 512,
      numFrames: 25,
      fps: 24,
      seed: 987654,
    });

    first.stderr('STAGE:encode-prompt');
    first.stderr(TIMEOUT_ABORT);
    await first.abort();

    // The replacement was spawned, then stopped rather than left running…
    expect(ltx2Calls(spawnMock)).toHaveLength(2);
    expect(second.proc.kill).toHaveBeenCalledWith('SIGTERM');
    // …and the job still reports a terminal failure instead of hanging.
    expect(failures).toHaveLength(1);
  });

  // A replacement child that never gets its close listener can never report a
  // terminal event, so it must not be left running.
  it('stops the replacement child when wiring it throws', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    const first = makeDrivenProc(111);
    const second = makeDrivenProc(112, { failWiring: true });
    spawnMock.mockClear();
    spawnMock.mockResolvedValueOnce(first.proc).mockResolvedValueOnce(second.proc);
    await generateVideo({
      jobId: 'pe-wire-throws',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'a lighthouse in fog',
      width: 512,
      height: 512,
      numFrames: 25,
      fps: 24,
      seed: 987654,
    });

    first.stderr('STAGE:encode-prompt');
    first.stderr(TIMEOUT_ABORT);
    await first.abort();

    expect(second.proc.kill).toHaveBeenCalledWith('SIGTERM');
    // The job still ends, reporting the abort that started all this.
    expect(failures).toHaveLength(1);
  });

  // The replacement must not be reachable by cancel() until it is wired: an
  // unwired child killed mid-handoff emits its exit into the void and strands the
  // job `running`, and its close handler could otherwise release the accelerator
  // claim while the handoff is still in flight — which would then rewrite the
  // claim file with a dead PID and wedge every later render.
  it('finishes the claim handoff before the replacement child is trackable', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    const first = makeDrivenProc(113);
    const second = makeDrivenProc(114);
    spawnMock.mockClear();
    spawnMock.mockResolvedValueOnce(first.proc).mockResolvedValueOnce(second.proc);
    await generateVideo({
      jobId: 'pe-wire-order',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'a lighthouse in fog',
      width: 512,
      height: 512,
      numFrames: 25,
      fps: 24,
      seed: 987654,
    });
    // Sampled from inside the handoff — the window where a wired-and-tracked
    // child could run its close handler against the in-flight claim write.
    let wiredDuringHandoff = null;
    heavyClaimHandoff.mockImplementationOnce(async (pid) => {
      if (pid === 114) wiredDuringHandoff = second.isWired();
    });

    first.stderr('STAGE:encode-prompt');
    first.stderr(TIMEOUT_ABORT);
    await first.abort();

    expect(wiredDuringHandoff).toBe(false);
    // …and the wiring does land right after, so the replacement can finalize.
    expect(second.isWired()).toBe(true);
    await second.finish();
    expect(failures).toHaveLength(0);
  });

  // The cancel window does not close when the spawn resolves — the handoff is
  // awaited too, and activeProcess is still null across it, so cancel() again
  // leaves nothing behind but the epoch bump.
  it('abandons the replacement child when a cancel lands during the claim handoff', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const { cancel } = await import('./local.js');
    const spawnMock = vi.mocked(spawnDetached);
    const first = makeDrivenProc(115);
    const second = makeDrivenProc(116);
    spawnMock.mockClear();
    spawnMock.mockResolvedValueOnce(first.proc).mockResolvedValueOnce(second.proc);
    await generateVideo({
      jobId: 'pe-cancel-handoff',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'a lighthouse in fog',
      width: 512,
      height: 512,
      numFrames: 25,
      fps: 24,
      seed: 987654,
    });
    heavyClaimHandoff.mockImplementationOnce(async (pid) => {
      if (pid === 116) cancel();
    });

    first.stderr('STAGE:encode-prompt');
    first.stderr(TIMEOUT_ABORT);
    await first.abort();

    expect(second.proc.kill).toHaveBeenCalledWith('SIGTERM');
    // Never wired, so it could not have reported anything — the job's terminal
    // event has to come from the original abort instead.
    expect(second.isWired()).toBe(false);
    expect(failures).toHaveLength(1);
  });

  // The claim handoff yields to the event loop, so a replacement that dies in
  // that window emits its 'close' before anything is listening. Nothing would
  // ever reap it: the job would sit `running` forever, still holding the
  // accelerator claim, with no terminal SSE or queue event.
  it('reaps a replacement child that died before its listener was attached', async () => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    const spawnMock = vi.mocked(spawnDetached);
    const first = makeDrivenProc(117);
    const second = makeDrivenProc(118);
    spawnMock.mockClear();
    spawnMock.mockResolvedValueOnce(first.proc).mockResolvedValueOnce(second.proc);
    await generateVideo({
      jobId: 'pe-early-death',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'a lighthouse in fog',
      width: 512,
      height: 512,
      numFrames: 25,
      fps: 24,
      seed: 987654,
    });
    // Dies during the handoff, and its close() fires into the void — modelled by
    // setting the exit state without invoking any listener.
    heavyClaimHandoff.mockImplementationOnce(async (pid) => {
      if (pid === 118) second.proc.exitCode = 3;
    });

    first.stderr('STAGE:encode-prompt');
    first.stderr(TIMEOUT_ABORT);
    await first.abort();

    expect(failures).toHaveLength(1);
    expect(failures[0].error).toMatch(/Exit code 3/);
    expect(heavyClaimRelease).toHaveBeenCalled();

    // …and the real 'close' arriving late — carrying that same exit status —
    // is absorbed rather than re-running the whole teardown and reporting the
    // job as failed a second time.
    await second.close(3, null);
    expect(failures).toHaveLength(1);
    expect(heavyClaimRelease).toHaveBeenCalledTimes(1);
  });
});

// ── the first render child vs the accelerator handoff (#4617) ────────────────
// Between `spawnDetached` resolving and the render child's real listeners going
// on sits the machine-claim handoff — an await on real file I/O. A child that
// dies inside that window emits with nobody subscribed: a lost 'close' leaves
// the job `running` forever while still holding the accelerator claim (every
// later render then 409s), and a lost 'error' is worse, since an EventEmitter
// with no 'error' listener throws and takes the server down with it.
describe('generateVideo — first render child dies during the accelerator handoff', () => {
  // A child that never exits on its own, so the test decides exactly when — and
  // from where — its terminal event fires.
  const makeSilentProc = (pid, { failWiring = false } = {}) => {
    const listeners = {};
    const proc = {
      pid,
      exitCode: null,
      signalCode: null,
      killed: false,
      stdout: { on: vi.fn(() => { if (failWiring) throw new Error('stdout stream vanished'); }) },
      stderr: { on: vi.fn() },
      on(event, fn) { listeners[event] = fn; return proc; },
      off(event, fn) { if (listeners[event] === fn) delete listeners[event]; return proc; },
      kill: vi.fn(),
    };
    return {
      proc,
      close: (code, signal) => {
        proc.exitCode = code;
        proc.signalCode = signal;
        return listeners.close?.(code, signal);
      },
      // A spawn-side failure (no `sh`, no PID recorded) — the handle reports it
      // as 'error' and never populates exitCode, so nothing but a listener can
      // observe it.
      error: (err) => listeners.error?.(err),
    };
  };

  let failures;
  let onFailed;

  beforeEach(() => {
    failures = [];
    onFailed = (payload) => failures.push(payload);
    videoGenEvents.on('failed', onFailed);
  });

  afterEach(() => {
    videoGenEvents.off('failed', onFailed);
  });

  const render = async (jobId, child, duringHandoff) => {
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    vi.mocked(spawnDetached).mockClear();
    vi.mocked(spawnDetached).mockResolvedValueOnce(child.proc);
    heavyClaimHandoff.mockImplementationOnce(async () => duringHandoff());
    return generateVideo({
      jobId,
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'a lighthouse in fog',
      width: 512,
      height: 512,
      numFrames: 25,
      fps: 24,
      seed: 987654,
    });
  };

  it('reports the exit and hands the accelerator claim back when the close lands unsubscribed', async () => {
    const child = makeSilentProc(201);
    await render('first-child-close-in-handoff', child, () => child.close(3, null));

    expect(failures).toHaveLength(1);
    expect(failures[0].error).toMatch(/Exit code 3/);
    expect(heavyClaimRelease).toHaveBeenCalled();

    // …and the real 'close' arriving late carries the same status through a
    // handler that already ran, so the job must not fail (or release) twice.
    await child.close(3, null);
    expect(failures).toHaveLength(1);
    expect(heavyClaimRelease).toHaveBeenCalledTimes(1);
  });

  it('reports a spawn error raised in the same window, which no exit status records', async () => {
    const child = makeSilentProc(202);
    await render('first-child-error-in-handoff', child, () => child.error(new Error('detached spawn produced no PID')));

    // exitCode/signalCode stay null on a spawn failure — only a subscriber sees it.
    expect(child.proc.exitCode).toBeNull();
    expect(failures).toHaveLength(1);
    expect(failures[0].error).toMatch(/produced no PID/);
    expect(heavyClaimRelease).toHaveBeenCalled();
  });

  it('stops the child and releases the claim when the handoff itself throws', async () => {
    const child = makeSilentProc(203);
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    vi.mocked(spawnDetached).mockClear();
    vi.mocked(spawnDetached).mockResolvedValueOnce(child.proc);
    heavyClaimHandoff.mockImplementationOnce(async () => { throw new Error('claim file vanished'); });

    await expect(generateVideo({
      jobId: 'first-child-handoff-throws',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'a lighthouse in fog',
      width: 512,
      height: 512,
      numFrames: 25,
      fps: 24,
      seed: 987654,
    })).rejects.toThrow('claim file vanished');

    // Never wired, so it could never report anything — it must not be left
    // running, and the claim it may already have been handed has to come back.
    expect(child.proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(heavyClaimRelease).toHaveBeenCalled();
    // …and the job converges instead of sitting `running` in the jobs map with
    // its staged temp files, which is the same stranding #4617 is about.
    expect(failures).toHaveLength(1);
    expect(failures[0].error).toMatch(/claim file vanished/);
  });

  it('stops the child and fails the job when the wiring itself throws', async () => {
    const child = makeSilentProc(204, { failWiring: true });
    const { spawnDetached } = await import('../../lib/detachedSpawn.js');
    vi.mocked(spawnDetached).mockClear();
    vi.mocked(spawnDetached).mockResolvedValueOnce(child.proc);

    await expect(generateVideo({
      jobId: 'first-child-wiring-throws',
      pythonPath: '/usr/bin/python3',
      modelId: 'ltx2_unified',
      prompt: 'a lighthouse in fog',
      width: 512,
      height: 512,
      numFrames: 25,
      fps: 24,
      seed: 987654,
    })).rejects.toThrow('stdout stream vanished');

    expect(child.proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(heavyClaimRelease).toHaveBeenCalled();
    expect(failures).toHaveLength(1);
  });
});

describe('updateHistoryItemPrompt — trigger-weave provenance (#4665)', () => {
  const seedHistory = async (item) => {
    const { readJSONFile, atomicWrite } = await import('../../lib/fileUtils.js');
    vi.mocked(readJSONFile).mockResolvedValue([item]);
    vi.mocked(atomicWrite).mockClear();
    return () => {
      const calls = vi.mocked(atomicWrite).mock.calls;
      return calls[calls.length - 1]?.[1]?.[0];
    };
  };

  it('drops renderPrompt + addedTriggerWords when the user edits the prompt', async () => {
    // The provenance describes the prompt this render was MADE with. Leaving it
    // after an edit has the row claim a renderPrompt derived from text that is
    // no longer there, and name tokens as "added" to a prompt they never were.
    const written = await seedHistory({
      id: 'woven-1',
      prompt: 'a rooftop at dusk',
      renderPrompt: 'a rooftop at dusk, fox_tok',
      addedTriggerWords: ['fox_tok'],
    });
    await updateHistoryItemPrompt('woven-1', 'a beach at noon');
    const item = written();
    expect(item.prompt).toBe('a beach at noon');
    expect(item.renderPrompt).toBeUndefined();
    expect(item.addedTriggerWords).toBeUndefined();
  });

  it('leaves an un-woven row otherwise untouched', async () => {
    const written = await seedHistory({ id: 'plain-1', prompt: 'a rooftop', seed: 42 });
    await updateHistoryItemPrompt('plain-1', 'a beach');
    const item = written();
    expect(item).toEqual({ id: 'plain-1', prompt: 'a beach', seed: 42 });
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
    await generateVideo({
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
    expect(valueAfter(args, '--steps')).toBe('8');
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
    expect(valueAfter(args, '--steps')).toBe('8');
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
    expect(valueAfter(args, '--steps')).toBe('8');
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

    it('stamps nothing when the profile was declined', async () => {
      const meta = await metaFor('sp-meta-declined', { speedProfileId: 'turbo' });
      expect(meta.speedProfileId).toBeUndefined();
    });
  });
});

// #4875 — the chunk entries of a chain are written `hidden: true`, so the
// STITCHED record is the only one the user ever sees. Without inheriting the
// profile there, a chained render's lightbox shows no "Speed profile" row at
// all — including for a chain whose TeaCache or adapter was unavailable, which
// is exactly the silent speed claim the feature exists to prevent — and a Remix
// of the clip quietly reverts to Quality.
describe('stitchVideos — speed-profile inheritance (#4875)', () => {
  const chunk = (id, extra = {}) => ({
    id, filename: `${id}.mp4`, prompt: 'a shot', modelId: 'ltx25_mlx_q8',
    width: 512, height: 512, fps: 24, numFrames: 25, seed: 7, ...extra,
  });

  const stitchOf = async (entries) => {
    const { readJSONFile, atomicWrite } = await import('../../lib/fileUtils.js');
    const { probeFrameCount } = await import('../../lib/ffmpeg.js');
    vi.mocked(atomicWrite).mockClear();
    vi.mocked(probeFrameCount).mockImplementation(async () => 25);
    vi.mocked(readJSONFile).mockImplementation(async () => entries);
    return stitchVideos(entries.map((e) => e.id));
  };

  it('carries the requested profile and the runner outcome from the first chunk', async () => {
    const applied = { id: 'fast', teacache: false, degraded: ['teacache'] };
    const stitched = await stitchOf([
      chunk('c1', { speedProfileId: 'fast', speedProfileApplied: applied }),
      chunk('c2', { speedProfileId: 'fast', speedProfileApplied: applied }),
    ]);
    // Both halves: the REQUEST (what Remix round-trips, what the ETA buckets
    // on) and the OUTCOME (what stops a degraded run reading as a full one).
    expect(stitched.speedProfileId).toBe('fast');
    expect(stitched.speedProfileApplied).toEqual(applied);
  });

  it('stamps neither field for a Quality chain, so the record stays pre-feature shaped', async () => {
    const stitched = await stitchOf([chunk('c1'), chunk('c2')]);
    expect('speedProfileId' in stitched).toBe(false);
    expect('speedProfileApplied' in stitched).toBe(false);
  });

  it('carries the id alone when the runner reported no outcome', async () => {
    const stitched = await stitchOf([
      chunk('c1', { speedProfileId: 'fast' }), chunk('c2', { speedProfileId: 'fast' }),
    ]);
    expect(stitched.speedProfileId).toBe('fast');
    expect('speedProfileApplied' in stitched).toBe(false);
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
