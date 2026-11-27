import { vi, beforeEach } from 'vitest';
import express from 'express';
import { createHash } from 'node:crypto';
import { errorMiddleware } from '../lib/errorHandler.js';
import videoGenRoutes from './videoGen.js';

const updateVideoPoster = vi.hoisted(() => vi.fn());

vi.mock('../services/videoGen/poster.js', () => ({ updateVideoPoster, createSharingCopy: vi.fn() }));

const compiledVisual = vi.hoisted(() => ({
  version: 1, compilerVersion: '1.0.0', status: 'locked', assets: [], adapters: [], omitted: [], warnings: [],
}));

const probeVideoDuration = vi.hoisted(() => vi.fn(async () => 41.041281));

const probeVideoGeometry = vi.hoisted(() => vi.fn());

const validateRunwayVideoInput = vi.hoisted(() => vi.fn(async () => ({ durationSec: 4 })));

vi.mock('../services/videoGen/runwayVideoInputs.js', () => ({ validateRunwayVideoInput }));

vi.mock('../lib/ffmpeg.js', async (importOriginal) => ({
  ...(await importOriginal()),
  probeVideoDuration,
  probeVideoGeometry,
}));

const compileFableLoomVisualRequest = vi.hoisted(() => vi.fn(async ({ authoredPrompt, authoredNegativePrompt, sourceImagePath }) => ({
  prompt: authoredPrompt,
  negativePrompt: authoredNegativePrompt || '',
  referenceImagePaths: [],
  referenceImageStrengths: [],
  loraFilenames: [],
  loraScales: [],
  sourceImagePath,
  visualConditioning: compiledVisual,
})));

const fableLoomVideoCapabilities = vi.hoisted(() => vi.fn(() => ({ version: 1, kind: 'video' })));

const getLoom = vi.hoisted(() => vi.fn(async () => null));

vi.mock('../services/fableLoom/visualConditioning.js', () => ({
  compileFableLoomVisualRequest,
  fableLoomVideoCapabilities,
}));

vi.mock('../services/fableLoom/records.js', () => ({ getLoom }));

const mediaUsage = vi.hoisted(() => ({ assertMediaDeletable: vi.fn(async () => {}) }));

vi.mock('../services/mediaUsage.js', () => mediaUsage);

vi.mock('../services/mediaRemoteDelete.js', () => ({
  deleteMediaAnywhere: vi.fn(async () => ({ status: 'deleted' })),
  cancelPendingDelete: vi.fn(async () => ({ ok: true, cancelled: true })),
}));

const installProcess = vi.hoisted(() => {
  const spawn = vi.fn();
  const makeChild = ({ code = 0, stdout = '', stderr = '' } = {}) => {
    const listeners = {};
    const child = {
      pid: 4242,
      killed: false,
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      kill: vi.fn(() => true),
      on: vi.fn((event, handler) => {
        listeners[event] = handler;
        if (event === 'close') setImmediate(() => {
          for (const [stream, text] of [[child.stdout, stdout], [child.stderr, stderr]]) {
            // Split writes also exercise summaries received across chunks.
            const onData = stream.on.mock.calls.find(([name]) => name === 'data')?.[1];
            onData?.(text.slice(0, 19));
            onData?.(text.slice(19));
          }
          void handler(code);
        });
        return child;
      }),
    };
    return child;
  };
  return { spawn, makeChild };
});

vi.mock('../lib/childProcess.js', async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: installProcess.spawn,
}));

// The enqueue gate resolves the runtime's LoRA capability for real (it is
// imported straight from the leaf so a mocked service can't fake it), which
// would spawn a venv python — and the suite's shared spawn mock reports every
// child as a clean exit, i.e. "capable". Pin the verdict explicitly so each
// test states the capability it is exercising.
const loraCapability = vi.hoisted(() => ({ capable: false }));

const runtimeProbes = vi.hoisted(() => ({
  isByovRuntimeInstalled: vi.fn(() => false),
  isByovRuntimeReady: vi.fn(async () => false),
  isByovRuntimeCurrent: vi.fn(async () => false),
  invalidateByovReadyCache: vi.fn(),
  invalidateByovLoraCapabilityCache: vi.fn(),
  warmByovLoraCapabilities: vi.fn(async () => {}),
  invalidateRuntimeFingerprintCache: vi.fn(),
}));

vi.mock('../services/videoGen/runtimes.js', async (importOriginal) => ({
  ...(await importOriginal()),
  ...runtimeProbes,
  resolveA2vLoraStageCapable: vi.fn(async () => true),
  resolveByovRuntimeLoraCapable: vi.fn(async (runtime) => runtime === 'minimax_h3' && loraCapability.capable),
}));

vi.mock('../services/videoGen/displayPower.js', () => ({
  isDisplaySleepEnabled: vi.fn(() => false),
}));

// The HTTP fixture owns synthetic LoRA identities; layout parsing has its
// own service tests and must not read sidecars for these nonexistent files.
vi.mock('../services/loras.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getLoraKeyLayout: vi.fn(async () => 'bare'),
}));

vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn(async () => ({ imageGen: { local: { pythonPath: '/usr/bin/python3' } } })),
  updateSettingsWith: vi.fn(async (mutate) => mutate({ imageGen: { local: { pythonPath: '/usr/bin/python3' } } })),
}));

vi.mock('../services/musicVideo/projects.js', () => ({
  getProject: vi.fn(),
}));

const clipCastReferences = vi.hoisted(() => vi.fn(async () => []));

vi.mock('../services/musicVideo/clipCastReferences.js', () => ({ musicVideoClipCastReferences: clipCastReferences, musicVideoClipReferences: clipCastReferences }));

vi.mock('../services/tracks/index.js', () => ({
  getTrack: vi.fn(),
}));

const prepareSourceAudioWindow = vi.hoisted(() => vi.fn());

vi.mock('../services/federatedMedia/sourceAudio.js', async (importOriginal) => ({
  ...(await importOriginal()),
  prepareSourceAudioWindow,
}));

vi.mock('../lib/pythonSetup.js', () => ({
  // /status reads the real 30s memo in services/imageGen/setup.js, so only the
  // interpreter spawn (probePythonHealth) and the constants that module loads are doubled.
  probePythonHealth: vi.fn(async () => ({ installed: ['mflux', 'mlx'], missing: [], missingPip: [], interpreterArch: 'arm64', pythonVersion: '3.12.1' })),
  REQUIRED_PACKAGES: ['mflux', 'mlx'],
  HOST_ARCH: 'arm64',
  hostIsAppleSilicon: vi.fn(() => false),
  detectArm64Python: vi.fn(async () => null),
  pipNameFor: vi.fn((pkg) => pkg),
  isAllowedPython: vi.fn(() => true),
  detectPythonSync: vi.fn(() => null),
  // setupScriptRunner presets PYTHON_BIN from the venv-base picker on Windows.
  detectVenvBasePythonSync: vi.fn(() => null),
}));

// The generative upscale is queued, not run inline (#6511), so it lives in
// its own service module and the route reaches it directly.
vi.mock('../services/videoGen/upscaleJob.js', () => ({
  enqueueLtxUpscale: vi.fn(),
}));

// Stitch is queued as a media job (#13000); the route reaches it directly.
vi.mock('../services/videoGen/stitchJob.js', () => ({
  enqueueStitch: vi.fn(),
}));

vi.mock('../services/videoGen/verticalJob.js', () => ({
  enqueueVertical: vi.fn(),
}));

vi.mock('../services/videoGen/trim.js', () => ({
  trimHistoryItem: vi.fn(),
}));

// The route and prepareParams.js reach these through different modules
// (local.js facade vs the catalog/history leaves); one set of fns serves both.
const videoGenLeaves = vi.hoisted(() => ({
  // The route checks `runtime` on the default model when validating a2v —
  // include it so the a2v happy-path tests don't trip the runtime capability
  // guard. Tests that need to exercise the legacy runtime override the mock
  // per-test via mockReturnValueOnce.
  listVideoModels: vi.fn(() => [{
    id: 'ltx2_unified', name: 'LTX-2 Unified', runtime: 'ltx2', supportedModes: ['text', 'image', 'fflf'],
  }]),
  defaultVideoModelId: vi.fn(() => 'ltx2_unified'),
  loadHistory: vi.fn(async () => []),
  readHistorySnapshot: vi.fn(async () => []),
  getHistoryItem: vi.fn(async () => null),
}));

vi.mock('../services/videoGen/modelCatalog.js', () => ({
  listVideoModels: videoGenLeaves.listVideoModels,
  defaultVideoModelId: videoGenLeaves.defaultVideoModelId,
}));

vi.mock('../services/videoGen/history.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadHistory: videoGenLeaves.loadHistory,
  readHistorySnapshot: videoGenLeaves.readHistorySnapshot,
  getHistoryItem: videoGenLeaves.getHistoryItem,
}));

vi.mock('../services/videoGen/local.js', () => ({
  ...videoGenLeaves,
  deleteHistoryItem: vi.fn(async (id) => ({ ok: true, id })),
  // The route imports setHistoryItemHidden too — without this entry, ESM
  // module linking fails when the route is loaded inside the test process.
  setHistoryItemHidden: vi.fn(async (id, hidden) => ({ ok: true, id, hidden })),
  extractLastFrame: vi.fn(),
  stitchVideos: vi.fn(),
  upscaleHistoryItem: vi.fn(),
  planUpscaleHistoryItem: vi.fn(),
  // Mirrors the real export — keeps the route's keyframe-range check in
  // sync with whatever the service actually defaults to.
  DEFAULT_NUM_FRAMES: 121,
  // /status advertises the FFLF pixel-frame budget so the client can mirror
  // the keyframe-index clamp. Mock returns the real default so the status
  // shape test sees a concrete number.
  resolveFflfLtx2PixelBudget: vi.fn(() => 704 * 448 * 25),
  // The route gates pythonPath enforcement on this allowlist (BYOV runtimes
  // bring their own venv). Mirror the real export so the
  // "accepts BYOV-runtime when pythonPath missing" case passes and the
  // negative case (legacy mlx_video model) still 400s.
  BYOV_VIDEO_RUNTIMES: new Set(['ltx2', 'ltx25', 'wan22', 'minimax_h3', 'minimax_h3_ref2va']),
  // The route's /status response now surfaces the BYOV runtime list so the
  // client can drop its hardcoded copy. Mirror the real shape — only the
  // `id` and a couple of UI-display fields are read by /status.
  BYOV_RUNTIME_INFO: {
    minimax_h3: {
      id: 'minimax_h3', label: 'MiniMax H3 MLX', venvPython: '/tmp/minimax-h3.py',
      installEnvVar: 'INSTALL_MINIMAX_H3', pinEnvVar: 'MINIMAX_H3_PIN',
      expectedRevision: 'fcd9e9b79a1d6018d91ac477c0968de1fa067e49',
      repoUrl: 'x', repoDir: '/tmp',
    },
    // No `expectedRevision`: this runtime is installed wheels, not a checkout,
    // which is why it carries an installSourceLabel instead of a clone URL.
    minimax_h3_cuda: {
      id: 'minimax_h3_cuda', label: 'MiniMax H3 CUDA', venvPython: '/tmp/minimax-h3-cuda.py',
      installEnvVar: 'INSTALL_MINIMAX_H3_CUDA', repoUrl: 'x', repoDir: '/tmp',
      installSourceLabel: 'pinned PyPI wheels',
    },
    minimax_h3_ref2va: {
      id: 'minimax_h3_ref2va', label: 'MiniMax H3 Ref2VA via mere.run',
      executable: '/tmp/mere.run', expectedVersion: '0.47.0',
      installEnvVar: 'INSTALL_MERERUN', repoUrl: 'https://github.com/sawfwair/mere-run',
      repoDir: '/tmp/mere-run', installSourceLabel: 'signed mere.run release',
      hfDownloadPython: false,
    },
    ltx2: { id: 'ltx2', label: 'LTX-2 MLX', venvPython: '/tmp/ltx2.py', installEnvVar: 'INSTALL_LTX2', repoUrl: 'x', repoDir: '/tmp' },
    wan22: {
      id: 'wan22', label: 'Wan 2.2 MLX', venvPython: '/tmp/wan22.py',
      installEnvVar: 'INSTALL_WAN22', pinEnvVar: 'WAN22_PIN',
      expectedRevision: '2452f0c12edcc8886eebf15772205ce9c417a618',
      repoUrl: 'x', repoDir: '/tmp',
    },
  },
  ...runtimeProbes,
  // /status now surfaces a runtime block (host chip/os + per-runtime versions).
  // Mock returns a fixed shape so the status test can assert it's wired through.
  resolveRuntimeFingerprint: vi.fn(async () => ({
    host: { chip: 'Apple M5 Max', os: 'Darwin 25.5.0', platform: 'darwin', arch: 'arm64', node: 'v22' },
    runtimes: { ltx2: { runtime: 'ltx2', versions: { mlx: '0.22.0' }, chip: 'Apple M5 Max' } },
  })),
}));

const sseDownload = vi.hoisted(() => ({
  start: vi.fn(async ({ res }) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"type":"complete"}\n\n');
  }),
}));

vi.mock('../lib/sseDownload.js', () => ({
  openSseStream: (res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    return {
      send: (event) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); },
      safeEnd: () => { if (!res.writableEnded) res.end(); },
    };
  },
}));

vi.mock('../services/hfDownloadStream.js', () => ({
  startHfDownloadStream: sseDownload.start,
}));

vi.mock('../services/federatedMedia/remoteSubmission.js', () => ({
  prepareRemoteMediaJob: vi.fn(async ({ peerId, kind, request }) => ({
    peer: { id: peerId },
    capability: { kind, engine: request.engine, modelId: request.modelId },
    remoteMedia: { wireVersion: 1, peerId, reconcile: false, cancelRequested: false, request },
  })),
}));

vi.mock('../services/mediaJobQueue/index.js', () => ({
  enqueueJob: vi.fn(({ kind, params }) => ({ jobId: `mock-${kind}-job`, position: 1, status: 'queued' })),
  attachSseClient: vi.fn(() => false),
  cancelJob: vi.fn(async () => ({ ok: true, status: 'canceling' })),
  listJobs: vi.fn(() => []),
  laneConcurrencyFor: vi.fn(() => 1),
}));

const recordUserAction = vi.hoisted(() => vi.fn(async () => ({ id: 'evt' })));

vi.mock('../services/userActions.js', () => ({ recordUserAction }));

vi.mock('../lib/multipart.js', () => {
  const withPendingUpload = () => (req, _res, next) => {
    if (pendingUpload.current) {
      req.files = Object.fromEntries(pendingUpload.current.map((f) => [f.fieldname, f]));
      pendingUpload.current = null;
    }
    next();
  };
  return {
    optionalUpload: () => (_req, _res, next) => next(),
    // Bypass the streaming parser. If a test set a pending upload via
    // setPendingUpload(), inject it under req.files keyed by fieldname so the
    // route exercises the upload-staging path; otherwise pass through.
    optionalUploadFields: withPendingUpload,
    uploadFields: withPendingUpload,
  };
});

const fsMock = vi.hoisted(() => ({
  unlink: vi.fn(async () => {}),
  copyFile: vi.fn(async () => {}),
}));

vi.mock('../lib/uploads.js', () => ({
  assertFileNotMediaManifest: vi.fn(async () => {}),
}));

vi.mock('../lib/fileUtils.js', () => ({
  tryReadFile: vi.fn().mockResolvedValue(null),
  sha256File: vi.fn(async (path) => createHash('sha256').update(path).digest('hex')),
  PATHS: {
    root: '/mock',
    data: '/mock/data',
    images: '/mock/images',
    videos: '/mock/videos',
    uploads: '/mock/uploads',
    music: '/mock/music',
    loras: '/mock/loras',
  },
  // Route awaits ensureDir before staging the upload; no-op for tests since
  // we mock copyFile too.
  ensureDir: vi.fn(async () => {}),
  // The LoRA filename guard (services/loras.js) the preview's LoRA check runs.
  assertSafeFilename: vi.fn(),
  copyFileGuarded: fsMock.copyFile,
  unlinkGuarded: fsMock.unlink,
  // The route resolves user-supplied basenames through this helper before
  // handing them to the renderer. Mirror the real helper's basename-strip
  // + dot-segment rejection so the "strips path-traversal" test below
  // genuinely exercises the documented behavior (otherwise the mock would
  // happily forward `../../etc/passwd` through unchanged).
  resolveGalleryImage: vi.fn((name) => {
    if (typeof name !== 'string' || !name) return null;
    const safe = name.split(/[/\\]/).pop();
    if (!safe || safe === '.' || safe === '..') return null;
    return `/mock/images/${safe}`;
  }),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
}));

vi.mock('fs/promises', () => ({
  stat: vi.fn(async () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); }),
  unlink: fsMock.unlink,
  // The route stages multipart uploads to data/uploads/ via copyFile. Stub
  // the copy so tests that simulate req.file don't actually touch disk.
  copyFile: fsMock.copyFile,
}));

// Render submissions go through the mediaJobQueue. Mock its surface so the
// route tests stay synchronous and don't kick off the worker loop.
// The federated branch resolves the peer + capacity preflight through this
// helper; mock it so the route test asserts its own validation and enqueue
// wiring without standing up a peer registry.
const federatedPeerId = '00000000-0000-4000-8000-0000000000f2';

// Pending file metadata for tests that need to simulate an upload. Tests set
// this via `setPendingUpload({ fieldname, ... })` before issuing the request;
// the mocked uploadFields middleware reads it off the holder, attaches it as
// req.files keyed by fieldname, and clears it. Mutable wrapper avoids
// reaching into vi mock internals. Several files may be staged in one request
// (`setPendingUpload(a, b)`) — the rollback cases need more than one durable
// copy in flight to prove a later failure unwinds the earlier ones.
const pendingUpload = { current: null };

const setPendingUpload = (...files) => { pendingUpload.current = files.flat(); };

let app;

function installVideoRouteHooks() {
  beforeEach(() => {
    loraCapability.capable = false;
    app = express();
    app.use(express.json());
    app.use('/api/video-gen', videoGenRoutes);
    app.use(errorMiddleware);
    vi.clearAllMocks();
    // Reset the upload holder so a test that set a pending upload but
    // bailed before the route consumed it can't leak into the next test.
    pendingUpload.current = null;
    installProcess.spawn.mockReset().mockImplementation(() => installProcess.makeChild());
    runtimeProbes.isByovRuntimeInstalled.mockReturnValue(false);
    runtimeProbes.isByovRuntimeReady.mockResolvedValue(false);
    runtimeProbes.isByovRuntimeCurrent.mockResolvedValue(false);
    probeVideoDuration.mockResolvedValue(41.041281);
    prepareSourceAudioWindow.mockReset();
  });
}

export {
  compiledVisual,
  compileFableLoomVisualRequest,
  fableLoomVideoCapabilities,
  getLoom,
  loraCapability,
  clipCastReferences,
  prepareSourceAudioWindow,
  recordUserAction,
  setPendingUpload,
  app,
  installVideoRouteHooks,
  validateRunwayVideoInput,
  federatedPeerId,
  updateVideoPoster,
  probeVideoGeometry,
  mediaUsage,
  installProcess,
  runtimeProbes,
  videoGenLeaves,
  sseDownload,
};
