/**
 * Shared fixture for the mediaJobQueue suites (index.*.test.js): the module
 * mocks, provider stubs, a per-file temp data dir and the shared queue
 * instance, plus the polling and persisted-snapshot helpers. Not a test file
 * itself: importing it registers the mocks and the file-level hooks.
 *
 * Import it before anything that resolves a mocked module. Its mutable
 * bindings (mediaJobQueue, the event buses, tempDataDir, currentAdmission,
 * atomicWriteSpy) are exported live and reassigned per test or importFresh().
 * The suites are split by concern so Vitest runs them in parallel workers
 * (#16215); a new queue test goes in the file whose concern it pins.
 */
vi.mock('../musicVideo/catalogCheckin.js', async original => ({ ...await original(), withCatalogCheckin: (...args) => catalogDispatch.hydrate(...args) }));
vi.mock('../musicVideo/projects.js', () => ({ getProject: vi.fn(async () => ({ mediaMode: 'code-images-video' })) }));
vi.mock('../musicVideo/productionReviewService.js', () => ({ assertMusicVideoSceneReview: vi.fn(async () => {}) }));
import { expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, sep } from 'path';

// Read lazily by the catalogCheckin mock factory, so it needs no vi.hoisted
// (a hoisted binding cannot be exported to the suites).
export const catalogDispatch = { hydrate: vi.fn(async project => project) };

// The queue persists to data/media-jobs.json. Steer it at a temp dir so each
// test gets a clean slate without scribbling over the real data dir. Every
// suite file that imports this module evaluates it once, under a root of its
// own: the files run in parallel workers sharing one run temp root, so the
// leak check in afterAll must only see this file's directories.
const suiteRoot = mkdtempSync(join(tmpdir(), 'mediaJobQueue-suite-'));
export let tempDataDir;
// Observe each queue snapshot without replacing the real write.
export let atomicWriteSpy;

export function queueSnapshotJobs(path, payload) {
  return path === join(tempDataDir, 'media-jobs.json') ? JSON.parse(payload).jobs : [];
}

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  // Still performs the real write (so file-reading assertions work) — just
  // counted. Reassigned per factory eval; tests mockClear() before measuring.
  atomicWriteSpy = vi.fn((...args) => actual.atomicWrite(...args));
  return {
    ...actual,
    // Override PATHS so JOBS_FILE lands in the temp dir. We can't read the
    // temp path here at module-load time (vi.mock is hoisted before the test
    // creates the dir), so expose a setter the tests use.
    PATHS: new Proxy({}, {
      get(_, key) {
        if (key === 'data') return tempDataDir;
        if (['uploads', 'videos', 'images', 'loras', 'imageRefs'].includes(key)) return join(tempDataDir, key);
        return actual.PATHS[key];
      },
    }),
    atomicWrite: (...args) => atomicWriteSpy(...args),
    resolveImageInputPath: (path) => typeof path === 'string' && path.startsWith(`${join(tempDataDir, 'images')}${sep}`) && existsSync(path) ? path : actual.resolveImageInputPath(path),
  };
});

// The queue binds `maintenance` once per module instance; delegate to the
// current test's admission so a shared instance still gets a per-test journal.
export let currentAdmission;
vi.mock('../../lib/maintenanceAdmission.js', async (importOriginal) => ({
  ...await importOriginal(),
  maintenance: new Proxy({}, { get: (_target, property) => currentAdmission[property] }),
}));

vi.mock('../../lib/mediaModels.js', () => ({
  getImageModels: vi.fn(() => [
    { id: 'flux2-example', runner: 'flux2', quantization: 'sdnq' },
    { id: 'flux2-example-bf16', runner: 'flux2', quantization: 'none' },
  ]),
  getVideoModels: vi.fn(() => [
    { id: 'example-mlx', runtime: 'mlx_video' },
    { id: 'example-cuda', runtime: 'cuda_video' },
    { id: 'example-large-cuda', runtime: 'cuda_video', hardwareRequirements: { requiresNvidiaGpu: true, minVramGb: 48 } },
    { id: 'example-other', runtime: 'mlx_video' },
  ]),
  getDefaultVideoModelId: vi.fn(() => 'example-mlx'),
}));

vi.mock('../../lib/systemCapabilities.js', async (importOriginal) => ({
  ...await importOriginal(),
  captureSystemCapabilities: () => ({ platform: 'win32', arch: 'x64', totalMemoryGb: 64 }),
  detectSystemCapabilities: vi.fn(async () => ({ platform: 'win32', arch: 'x64', totalMemoryGb: 64,
    cuda: { status: 'available', maxVramGb: 8 } })),
}));

// Mock the gen modules so the worker's dynamic imports return controllable
// stubs. The dispatcher relies on videoGenEvents / imageGenEvents to fire
// 'completed' or 'failed' for the worker to advance — we drive those events
// directly from each test.
export const stubs = {
  generateVideo: vi.fn(async () => ({ jobId: 'whatever' })),
  generateVideoGrok: vi.fn(async () => ({ jobId: 'whatever' })),
  generateVideoFal: vi.fn(async () => ({ jobId: 'whatever' })),
  generateVideoGemini: vi.fn(async () => ({ jobId: 'whatever' })),
  generateChainedVideo: vi.fn(async () => ({ jobId: 'whatever' })),
  generateImage: vi.fn(async () => ({ jobId: 'whatever' })),
  getVerifierSettings: vi.fn(),
  verifyImage: vi.fn(),
  finishVisualProfile: vi.fn(),
  generateImageGrok: vi.fn(async () => ({ jobId: 'whatever' })),
  generateImageCodex: vi.fn(async () => ({ jobId: 'whatever' })),
  generateImageFal: vi.fn(async () => ({ jobId: 'whatever' })),
  generateAudio: vi.fn(async () => ({ jobId: 'whatever' })),
  generateAudioRemote: vi.fn(async () => ({ jobId: 'whatever' })),
  generateImageRemote: vi.fn(async () => ({ jobId: 'whatever' })),
  generateVideoRemote: vi.fn(async () => ({ jobId: 'whatever' })),
  cancelVideo: vi.fn(),
  cancelImage: vi.fn(),
  cancelImageCodex: vi.fn(),
  cancelAudio: vi.fn(),
  cancelAudioRemote: vi.fn(),
  cancelImageRemote: vi.fn(),
  cancelVideoRemote: vi.fn(),
  // #1332: loraTraining is loaded through the runtime registry for runTraining
  // (worker) and hasSurvivingTrainer (boot reconcile). Stub both so the boot
  // re-attach decision is testable without loading the real trainer module.
  runTraining: vi.fn(() => new Promise(() => {})),
  hasSurvivingTrainer: vi.fn(async () => false),
  runVideoUpscale: vi.fn(() => new Promise(() => {})),
  cancelVideoUpscale: vi.fn(),
  runTopazUpscale: vi.fn(() => new Promise(() => {})),
  cancelTopazUpscale: vi.fn(() => true),
  runVideoStitch: vi.fn(() => new Promise(() => {})),
  runVideoVertical: vi.fn(() => new Promise(() => {})),
  cancelVideoStitch: vi.fn(),
  runSharingCopy: vi.fn(async () => ({})),
  cancelSharingCopy: vi.fn(() => true),
  renderComposition: vi.fn(async () => ({})),
  cancelComposition: vi.fn(),
  renderSuperCollider: vi.fn(() => new Promise(() => {})),
  cancelSuperCollider: vi.fn(() => true),
};

vi.mock('../musicVideo/revisionService.js', () => ({ assertPerformanceRepairDispatch: vi.fn().mockResolvedValue(undefined) }));

vi.mock('../creativeDirector/videoExecution.js', () => ({
  assertVideoAttemptDispatch: vi.fn().mockResolvedValue(undefined),
  settleVideoAttempt: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../videoGen/geminiWeb.js', () => ({
  generateVideo: (...args) => stubs.generateVideoGemini(...args),
  cancel: (...args) => stubs.cancelVideo(...args),
}));

vi.mock('../videoGen/local.js', () => ({
  generateVideo: (...args) => stubs.generateVideo(...args),
  generateChainedVideo: (...args) => stubs.generateChainedVideo(...args),
  cancel: (...args) => stubs.cancelVideo(...args),
}));

vi.mock('../musicVideo/sharingCopy.js', () => ({
  runSharingCopy: (...args) => stubs.runSharingCopy(...args),
  cancel: (...args) => stubs.cancelSharingCopy(...args),
  cleanupInterruptedSharingCopy: vi.fn(async () => {}),
}));

vi.mock('../htmlComposition/index.js', () => ({
  renderComposition: (...args) => stubs.renderComposition(...args),
  cancel: (...args) => stubs.cancelComposition(...args),
}));

vi.mock('../superColliderRender.js', () => ({
  renderSuperCollider: (...args) => stubs.renderSuperCollider(...args),
  cancel: (...args) => stubs.cancelSuperCollider(...args),
}));

vi.mock('../videoGen/upscaleJob.js', () => ({
  runVideoUpscale: (...args) => stubs.runVideoUpscale(...args),
  cancel: (...args) => stubs.cancelVideoUpscale(...args),
}));

vi.mock('../videoGen/topazJob.js', () => ({
  runVideoUpscale: (...args) => stubs.runTopazUpscale(...args),
  cancel: (...args) => stubs.cancelTopazUpscale(...args),
}));

vi.mock('../videoGen/verticalJob.js', () => ({
  runVideoVertical: (...args) => stubs.runVideoVertical(...args),
  cancel: () => false,
}));

vi.mock('../videoGen/stitchJob.js', () => ({
  runVideoStitch: (...args) => stubs.runVideoStitch(...args),
  cancel: (...args) => stubs.cancelVideoStitch(...args),
}));

vi.mock('../videoGen/grok.js', () => ({
  generateVideo: (...args) => stubs.generateVideoGrok(...args),
  cancel: (...args) => stubs.cancelVideo(...args),
}));

vi.mock('../videoGen/fal.js', () => ({
  generateVideo: (...args) => stubs.generateVideoFal(...args),
  cancel: (...args) => stubs.cancelVideo(...args),
}));

vi.mock('../imageGen/finishVisualProfile.js', () => ({ finishVisualProfileImage: (...args) => stubs.finishVisualProfile(...args) }));
vi.mock('../imageVerifier.js', () => ({
  getVerifierSettings: (...args) => stubs.getVerifierSettings(...args),
  verifyImage: (...args) => stubs.verifyImage(...args),
}));
vi.mock('../imageGen/local.js', () => ({
  generateImage: (...args) => stubs.generateImage(...args),
  cancel: (...args) => stubs.cancelImage(...args),
}));

vi.mock('../imageGen/codex.js', () => ({
  generateImage: (...args) => stubs.generateImageCodex(...args),
  cancel: (...args) => stubs.cancelImageCodex(...args),
}));

vi.mock('../imageGen/grok.js', () => ({
  generateImage: (...args) => stubs.generateImageGrok(...args),
  cancel: (...args) => stubs.cancelImage(...args),
}));

vi.mock('../imageGen/fal.js', () => ({
  generateImage: (...args) => stubs.generateImageFal(...args),
  cancel: (...args) => stubs.cancelImageCodex(...args),
}));

vi.mock('../audioGen/local.js', () => ({
  generateAudio: (...args) => stubs.generateAudio(...args),
  cancel: (...args) => stubs.cancelAudio(...args),
}));

vi.mock('../audioGen/remote.js', () => ({
  generateAudio: (...args) => stubs.generateAudioRemote(...args),
  cancel: (...args) => stubs.cancelAudioRemote(...args),
}));

vi.mock('../imageGen/remote.js', () => ({
  generateImage: (...args) => stubs.generateImageRemote(...args),
  cancel: (...args) => stubs.cancelImageRemote(...args),
}));

vi.mock('../videoGen/remote.js', () => ({
  generateVideo: (...args) => stubs.generateVideoRemote(...args),
  generateChainedVideo: (...args) => stubs.generateVideoRemote(...args),
  cancel: (...args) => stubs.cancelVideoRemote(...args),
}));

vi.mock('../loraTraining/index.js', () => ({
  runTraining: (...args) => stubs.runTraining(...args),
  hasSurvivingTrainer: (...args) => stubs.hasSurvivingTrainer(...args),
  cancel: () => {},
}));

// Import the queue + the gen-event emitters AFTER the mocks above are
// registered. Static imports would race with vi.mock hoisting on a real
// dependency cycle, so dynamic-import this in beforeEach.
export let mediaJobQueue;
export let videoGenEvents;
export let imageGenEvents;
export let audioGenEvents;

// A fresh module graph costs ~150ms, so tests share one instance and reset it
// with __resetForTests(). Only a test that simulates a restart (or swaps a
// doMock'd dependency) calls importFresh(); that marks the graph dirty so the
// next beforeEach rebuilds a clean one instead of inheriting its mocks.
let moduleGraphDirty = true;
export async function importFresh() {
  await mediaJobQueue?.__resetForTests();
  vi.resetModules();
  mediaJobQueue = await import('./index.js');
  // The fresh graph has a fresh runtime registry; bootHooks.js's lazy loaders resolve to the mocks above, as at boot.
  (await import('../bootHooks.js')).registerBootHooks();
  videoGenEvents = (await import('../videoGen/events.js')).videoGenEvents;
  imageGenEvents = (await import('../imageGenEvents.js')).imageGenEvents;
  audioGenEvents = (await import('../audioGen/events.js')).audioGenEvents;
  moduleGraphDirty = true;
}

export const flush = async () => {
  await Promise.resolve();
  await mediaJobQueue?.__drainForTests();
};

export const remoteMediaParams = () => ({
  wireVersion: 1,
  peerId: '00000000-0000-4000-8000-000000000001',
  profile: { style: 'ambient', mood: 'calm', tempo: 'slow', energy: 'low', instruments: [] },
  request: { engine: 'remote-audio', modelId: 'example/model' },
});

export const remoteImageMediaParams = () => ({
  wireVersion: 1,
  peerId: '00000000-0000-4000-8000-000000000001',
  request: {
    kind: 'image', engine: 'local', modelId: 'dev', prompt: 'a harbour', width: 512, height: 512,
  },
});

export const remoteVideoMediaParams = () => ({
  wireVersion: 1,
  peerId: '00000000-0000-4000-8000-000000000001',
  request: {
    kind: 'video', engine: 'local', modelId: 'ltx2', prompt: 'a harbour', numFrames: 121, fps: 24,
  },
});

export const remoteRecoverySettlement = (jobId, peerId = remoteVideoMediaParams().peerId) => ({
  jobId, peerId, remoteJobId: '00000000-0000-4000-8000-000000000090', status: 'completed', executorSettled: true,
});

beforeEach(async () => {
  // One path for the whole file: the shared queue instance captures its jobs
  // file under it at import. afterEach removes it, so each test starts empty.
  tempDataDir ??= mkdtempSync(join(suiteRoot, 'mediaJobQueue-test-'));
  mkdirSync(tempDataDir, { recursive: true });
  // Queue fixtures deliberately abandon active work when simulating a crash.
  // Give each test its own real journal, retaining it across importFresh()
  // within that test so restart recovery still exercises durable ownership.
  const { createMaintenanceAdmission } = await vi.importActual('../../lib/maintenanceAdmission.js');
  currentAdmission = createMaintenanceAdmission(tempDataDir);
  Object.values(stubs).forEach((fn) => fn.mockReset());
  stubs.getVerifierSettings.mockResolvedValue({ enabledForGeneration: false });
  const { getDefaultVideoModelId } = await import('../../lib/mediaModels.js');
  getDefaultVideoModelId.mockImplementation(() => 'example-mlx');
  // Default codex stub: hang (matches video/local defaults so tests that
  // don't care about codex don't accidentally complete too fast).
  stubs.generateImageCodex.mockImplementation(() => new Promise(() => {}));
  // #1332 training stubs lose their implementations on mockReset above; restore
  // safe defaults (no survivor; runTraining hangs so a re-attached run stays
  // 'running'). Individual tests override hasSurvivingTrainer as needed.
  stubs.runTraining.mockImplementation(() => new Promise(() => {}));
  stubs.hasSurvivingTrainer.mockResolvedValue(false);
  stubs.runVideoUpscale.mockImplementation(() => new Promise(() => {}));
  stubs.runTopazUpscale.mockImplementation(() => new Promise(() => {}));
  stubs.cancelTopazUpscale.mockReturnValue(true);
  stubs.runVideoStitch.mockImplementation(() => new Promise(() => {}));
  stubs.runVideoVertical.mockImplementation(() => new Promise(() => {}));
  if (moduleGraphDirty) await importFresh();
  else {
    await mediaJobQueue.__resetForTests();
    // Settings are read through a module cache; tests write settings.json directly.
    (await import('../settings.js')).__resetSettingsCache();
  }
  moduleGraphDirty = false;
});

afterEach(async () => {
  await flush();
  await mediaJobQueue?.__resetForTests();
  if (tempDataDir && existsSync(tempDataDir)) {
    rmSync(tempDataDir, { recursive: true, force: true });
  }
});

// No sweep: reset must join owned work before fixture removal, rather than
// deleting evidence of a late writer after the fact.
afterAll(() => {
  expect(readdirSync(suiteRoot).filter(name => name.startsWith('mediaJobQueue-test-'))).toEqual([]);
  rmSync(suiteRoot, { recursive: true, force: true });
});

// Polling helper for the async settles this suite waits on (a durable disk
// write, a worker tick). A predicate that THROWS counts as "not true yet" and
// keeps polling: several predicates readFileSync the persisted snapshot, which
// legitimately does not exist until the first write lands in the freshly-made
// temp dir, so an unguarded throw escaped the loop and failed the test on its
// FIRST poll instead of waiting for the write (#5512 — flaked on slow Windows
// CI runners). Swallowing is bounded to the retry window only: the timeout
// still throws, and names the predicate source plus the last error, so a
// genuinely broken predicate stays diagnosable instead of becoming an
// anonymous 3-second stall. No predicate here uses expect(), so a real
// assertion failure cannot be downgraded into a timeout by the catch.
// CI's default budget is scaled up here, in the one helper every call site
// shares — a cold spawn plus filesystem work through an AV filter driver on a
// shared Windows runner routinely exceeds the budget that's generous on a
// developer machine (#7516). A call site that needs a longer budget for a
// real reason should say so locally via `timeoutMs`, not rely on this default.
const DEFAULT_WAIT_MS = process.env.CI ? 15000 : 3000;
export async function waitFor(predicate, { timeoutMs = DEFAULT_WAIT_MS, intervalMs = 30 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      if (predicate()) return;
      lastError = null;
    } catch (err) {
      lastError = err;
    }
    // Deadline is checked AFTER a poll so the budget always ends on an
    // evaluation. Checking first (the `while` this replaced) spent the final
    // interval asleep and threw without ever re-testing the predicate, losing
    // up to intervalMs of the window to the same race this helper guards.
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const source = String(predicate).replace(/\s+/g, ' ').slice(0, 160);
  throw new Error(
    `waitFor: predicate never became true within ${timeoutMs}ms: ${source}${lastError ? ` — last error: ${lastError.message}` : ''}`,
    lastError ? { cause: lastError } : undefined,
  );
}

// #8325: a job id handed to a caller must survive a crash, so admission waits
// for the snapshot that contains the job — and a failed snapshot refuses it.
export const persistedJobs = () => JSON.parse(readFileSync(join(tempDataDir, 'media-jobs.json'), 'utf-8')).jobs;
export const persistedIds = () => persistedJobs().map((j) => j.id);
// Hold the NEXT snapshot write until the returned release() is called.
export const holdNextWrite = () => {
  const realWrite = atomicWriteSpy.getMockImplementation();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  atomicWriteSpy.mockImplementationOnce(async (...args) => {
    await gate;
    return realWrite(...args);
  });
  return () => release();
};
