vi.mock('../musicVideo/projects.js', () => ({ getProject: vi.fn(async () => ({ mediaMode: 'code-images-video' })) }));
vi.mock('../musicVideo/productionReviewService.js', () => ({ assertMusicVideoSceneReview: vi.fn(async () => {}) }));
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync, renameSync, lstatSync } from 'fs';
import { tmpdir } from 'os';
import { createHash } from 'node:crypto';
import { join, sep } from 'path';
import { IMAGE_GEN_MODE } from '../imageGen/modes.js';

// The queue persists to data/media-jobs.json. Steer it at a temp dir so each
// test gets a clean slate without scribbling over the real data dir.
let tempDataDir;
// Counting wrapper around the real atomicWrite. persist() funnels every disk
// write through atomicWrite, so spying on it lets tests assert *how many*
// times state was flushed — used to pin the progress-persist debounce (it must
// coalesce a burst of progress events into one write, not write per-event).
let atomicWriteSpy;

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
let currentAdmission;
vi.mock('../../lib/maintenanceAdmission.js', async (importOriginal) => ({
  ...await importOriginal(),
  maintenance: new Proxy({}, { get: (_target, property) => currentAdmission[property] }),
}));

vi.mock('../../lib/mediaModels.js', () => ({
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
const stubs = {
  generateVideo: vi.fn(async () => ({ jobId: 'whatever' })),
  generateVideoGrok: vi.fn(async () => ({ jobId: 'whatever' })),
  generateVideoFal: vi.fn(async () => ({ jobId: 'whatever' })),
  generateChainedVideo: vi.fn(async () => ({ jobId: 'whatever' })),
  generateImage: vi.fn(async () => ({ jobId: 'whatever' })),
  finishVisualProfile: vi.fn(),
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
  // #1332: loraTraining is dynamically imported by the queue for runTraining
  // (worker) and hasSurvivingTrainer (boot reconcile). Stub both so the boot
  // re-attach decision is testable without loading the real trainer module.
  runTraining: vi.fn(() => new Promise(() => {})),
  hasSurvivingTrainer: vi.fn(async () => false),
  runVideoUpscale: vi.fn(() => new Promise(() => {})),
  cancelVideoUpscale: vi.fn(),
  runTopazUpscale: vi.fn(() => new Promise(() => {})),
  cancelTopazUpscale: vi.fn(() => true),
  runVideoStitch: vi.fn(() => new Promise(() => {})),
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
  cleanupPreparedTopaz: vi.fn(async () => {}),
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
vi.mock('../imageGen/local.js', () => ({
  generateImage: (...args) => stubs.generateImage(...args),
  cancel: (...args) => stubs.cancelImage(...args),
}));

vi.mock('../imageGen/codex.js', () => ({
  generateImage: (...args) => stubs.generateImageCodex(...args),
  cancel: (...args) => stubs.cancelImageCodex(...args),
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
let mediaJobQueue;
let videoGenEvents;
let imageGenEvents;
let audioGenEvents;

// A fresh module graph costs ~150ms, so tests share one instance and reset it
// with __resetForTests(). Only a test that simulates a restart (or swaps a
// doMock'd dependency) calls importFresh(); that marks the graph dirty so the
// next beforeEach rebuilds a clean one instead of inheriting its mocks.
let moduleGraphDirty = true;
async function importFresh() {
  await mediaJobQueue?.__resetForTests();
  vi.resetModules();
  mediaJobQueue = await import('./index.js');
  videoGenEvents = (await import('../videoGen/events.js')).videoGenEvents;
  imageGenEvents = (await import('../imageGenEvents.js')).imageGenEvents;
  audioGenEvents = (await import('../audioGen/events.js')).audioGenEvents;
  moduleGraphDirty = true;
}

const flush = async () => {
  await Promise.resolve();
  await mediaJobQueue?.__drainForTests();
};

const remoteMediaParams = () => ({
  wireVersion: 1,
  peerId: '00000000-0000-4000-8000-000000000001',
  profile: { style: 'ambient', mood: 'calm', tempo: 'slow', energy: 'low', instruments: [] },
  request: { engine: 'remote-audio', modelId: 'example/model' },
});

const remoteImageMediaParams = () => ({
  wireVersion: 1,
  peerId: '00000000-0000-4000-8000-000000000001',
  request: {
    kind: 'image', engine: 'local', modelId: 'dev', prompt: 'a harbour', width: 512, height: 512,
  },
});

const remoteVideoMediaParams = () => ({
  wireVersion: 1,
  peerId: '00000000-0000-4000-8000-000000000001',
  request: {
    kind: 'video', engine: 'local', modelId: 'ltx2', prompt: 'a harbour', numFrames: 121, fps: 24,
  },
});

const remoteRecoverySettlement = (jobId, peerId = remoteVideoMediaParams().peerId) => ({
  jobId, peerId, remoteJobId: '00000000-0000-4000-8000-000000000090', status: 'completed', executorSettled: true,
});

beforeEach(async () => {
  // One path for the whole file: the shared queue instance captures its jobs
  // file under it at import. afterEach removes it, so each test starts empty.
  tempDataDir ??= mkdtempSync(join(tmpdir(), 'mediaJobQueue-test-'));
  mkdirSync(tempDataDir, { recursive: true });
  // Queue fixtures deliberately abandon active work when simulating a crash.
  // Give each test its own real journal, retaining it across importFresh()
  // within that test so restart recovery still exercises durable ownership.
  const { createMaintenanceAdmission } = await vi.importActual('../../lib/maintenanceAdmission.js');
  currentAdmission = createMaintenanceAdmission(tempDataDir);
  Object.values(stubs).forEach((fn) => fn.mockReset());
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
  expect(readdirSync(tmpdir()).filter(name => name.startsWith('mediaJobQueue-test-'))).toEqual([]);
});

describe('mediaJobQueue', () => {
  it.each(['unchanged', 'replaced', 'removed'])('dispatches the admitted reviewed bytes after the source is %s', async (change) => {
    const source = join(tempDataDir, 'images', 'reviewed.png');
    mkdirSync(join(tempDataDir, 'images'), { recursive: true });
    writeFileSync(source, 'reviewed bytes');
    const digest = createHash('sha256').update('reviewed bytes').digest('hex');
    stubs.generateVideo.mockResolvedValue({});
    stubs.generateImage.mockResolvedValue({});
    const blocker = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'hold the lane' } });
    await waitFor(() => stubs.generateVideo.mock.calls.length === 1);
    const job = await mediaJobQueue.enqueueJob({ kind: 'image', params: { prompt: 'edit', referenceImagePaths: [source], reviewedReferenceDigest: digest } });
    if (change === 'replaced') writeFileSync(source, 'unreviewed bytes');
    if (change === 'removed') rmSync(source);
    videoGenEvents.emit('completed', { generationId: blocker.jobId, filename: 'done.mp4' });
    await waitFor(() => stubs.generateImage.mock.calls.length === 1);
    const request = stubs.generateImage.mock.calls[0][0];
    expect(request.reviewedReferenceSnapshot.jobId).toBe(job.jobId);
    expect(readFileSync(request.referenceImagePaths[0], 'utf8')).toBe('reviewed bytes');
    imageGenEvents.emit('failed', { generationId: job.jobId, error: 'synthetic failure', inputProcessSettled: true });
    await waitFor(() => mediaJobQueue.getJob(job.jobId).status === 'failed');
  });

  it('snapshots only the edited image and keeps further references in order', async () => {
    const source = join(tempDataDir, 'images', 'reviewed.png');
    const extra = join(tempDataDir, 'images', 'place.png');
    mkdirSync(join(tempDataDir, 'images'), { recursive: true });
    writeFileSync(source, 'reviewed bytes');
    writeFileSync(extra, 'place bytes');
    const digest = createHash('sha256').update('reviewed bytes').digest('hex');
    stubs.generateImage.mockResolvedValue({});
    const job = await mediaJobQueue.enqueueJob({ kind: 'image', params: { prompt: 'edit', referenceImagePaths: [source, extra], reviewedReferenceDigest: digest } });
    await waitFor(() => stubs.generateImage.mock.calls.length === 1);
    const request = stubs.generateImage.mock.calls[0][0];
    expect(readFileSync(request.referenceImagePaths[0], 'utf8')).toBe('reviewed bytes');
    expect(request.referenceImagePaths.slice(1)).toEqual([extra]);
    imageGenEvents.emit('failed', { generationId: job.jobId, error: 'synthetic failure', inputProcessSettled: true });
    await waitFor(() => mediaJobQueue.getJob(job.jobId).status === 'failed');
  });

  it('replays a durably queued reviewed snapshot after restart', async () => {
    const source = join(tempDataDir, 'images', 'reviewed.png');
    mkdirSync(join(tempDataDir, 'images'), { recursive: true });
    writeFileSync(source, 'reviewed bytes');
    const digest = createHash('sha256').update('reviewed bytes').digest('hex');
    mediaJobQueue.quiesceMediaJobQueue();
    const job = await mediaJobQueue.enqueueJob({ kind: 'image', params: { prompt: 'edit', referenceImagePaths: [source], reviewedReferenceDigest: digest } });
    const persisted = persistedJobs().find(row => row.id === job.jobId);
    expect(persisted.params).toMatchObject({ prompt: '', modelId: null, pythonPath: null, referenceImagePaths: [] });
    expect(persisted.params.reviewedReferenceRequest.prompt).toBe('edit');
    const original = mediaJobQueue.getJob(job.jobId).params.reviewedReferenceSnapshot;
    writeFileSync(source, 'replacement');
    await importFresh();
    stubs.generateImage.mockResolvedValue({});
    await mediaJobQueue.initMediaJobQueue();
    await waitFor(() => stubs.generateImage.mock.calls.length === 1);
    const request = stubs.generateImage.mock.calls[0][0];
    expect(request.reviewedReferenceSnapshot).toEqual(original);
    expect(request.modelId).toBeUndefined();
    expect(readFileSync(request.referenceImagePaths[0], 'utf8')).toBe('reviewed bytes');
    imageGenEvents.emit('failed', { generationId: job.jobId, error: 'synthetic', inputProcessSettled: true });
    await waitFor(() => mediaJobQueue.getJob(job.jobId).status === 'failed');
  });

  it('refuses an unanchored legacy snapshot on replay without invoking the provider', async () => {
    const source = join(tempDataDir, 'images', 'reviewed.png');
    mkdirSync(join(tempDataDir, 'images'), { recursive: true });
    writeFileSync(source, 'reviewed bytes');
    const digest = createHash('sha256').update('reviewed bytes').digest('hex');
    mediaJobQueue.quiesceMediaJobQueue();
    const job = await mediaJobQueue.enqueueJob({ kind: 'image', params: { prompt: 'edit', referenceImagePaths: [source], reviewedReferenceDigest: digest } });
    const jobsPath = join(tempDataDir, 'media-jobs.json');
    const store = JSON.parse(readFileSync(jobsPath, 'utf8'));
    const identity = store.jobs.find(row => row.id === job.jobId).params.reviewedReferenceSnapshot;
    delete identity.anchorVersion;
    const manifestPath = join(tempDataDir, 'imageRefs', `snapshot-${identity.snapshotId}.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    delete manifest.anchorVersion;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    rmSync(join(tempDataDir, 'imageRefs', `snapshot-${identity.snapshotId}.anchor`));
    writeFileSync(jobsPath, JSON.stringify(store));
    await importFresh();
    await mediaJobQueue.initMediaJobQueue();
    await waitFor(() => mediaJobQueue.getJob(job.jobId).status === 'failed');
    expect(stubs.generateImage).not.toHaveBeenCalled();
    expect(readFileSync(join(tempDataDir, 'imageRefs', identity.filename), 'utf8')).toBe('reviewed bytes');
  });

  it('retains a snapshot when failure arrives without child-settlement proof', async () => {
    const source = join(tempDataDir, 'images', 'reviewed.png');
    mkdirSync(join(tempDataDir, 'images'), { recursive: true });
    writeFileSync(source, 'reviewed bytes');
    const digest = createHash('sha256').update('reviewed bytes').digest('hex');
    stubs.generateImage.mockResolvedValue({});
    const job = await mediaJobQueue.enqueueJob({ kind: 'image', params: { prompt: 'edit', referenceImagePaths: [source], reviewedReferenceDigest: digest } });
    await waitFor(() => stubs.generateImage.mock.calls.length === 1);
    const id = mediaJobQueue.getJob(job.jobId).params.reviewedReferenceSnapshot;
    imageGenEvents.emit('failed', { generationId: job.jobId, error: 'handoff failed' });
    await waitFor(() => mediaJobQueue.getJob(job.jobId).status === 'failed');
    await flush();
    expect(JSON.parse(readFileSync(join(tempDataDir, 'imageRefs', `snapshot-${id.snapshotId}.json`), 'utf8')).state).toBe('invoked');
    expect(readFileSync(join(tempDataDir, 'imageRefs', id.filename), 'utf8')).toBe('reviewed bytes');
  });

  it('retains a canceled remote recovery until the peer work is proven settled', async () => {
    const source = join(tempDataDir, 'images', 'reviewed.png');
    mkdirSync(join(tempDataDir, 'images'), { recursive: true });
    writeFileSync(source, 'reviewed bytes');
    const digest = createHash('sha256').update('reviewed bytes').digest('hex');
    mediaJobQueue.quiesceMediaJobQueue();
    const marker = { ...remoteImageMediaParams(), inputAssets: [{ role: 'referenceImages', path: source }] };
    const job = await mediaJobQueue.enqueueJob({ kind: 'image', params: { prompt: 'edit', referenceImagePaths: [source], reviewedReferenceDigest: digest, remoteMedia: marker } });
    const retained = mediaJobQueue.getJob(job.jobId);
    const id = retained.params.reviewedReferenceSnapshot;
    const { markSnapshotState } = await import('../imageGen/reviewedReference.js');
    await markSnapshotState(id, 'invoked');
    retained.params.remoteMedia.reconcile = true;
    retained.params.remotePeerReservation = true;
    await mediaJobQueue.cancelJob(job.jobId);
    expect(JSON.parse(readFileSync(join(tempDataDir, 'imageRefs', `snapshot-${id.snapshotId}.json`), 'utf8')).state).toBe('invoked');
  });

  it('marks a canceled queued snapshot settled only after its terminal state is durable', async () => {
    const source = join(tempDataDir, 'images', 'reviewed.png');
    mkdirSync(join(tempDataDir, 'images'), { recursive: true });
    writeFileSync(source, 'reviewed bytes');
    const digest = createHash('sha256').update('reviewed bytes').digest('hex');
    mediaJobQueue.quiesceMediaJobQueue();
    const job = await mediaJobQueue.enqueueJob({ kind: 'image', params: { prompt: 'edit', referenceImagePaths: [source], reviewedReferenceDigest: digest } });
    const id = mediaJobQueue.getJob(job.jobId).params.reviewedReferenceSnapshot;
    await mediaJobQueue.cancelJob(job.jobId);
    const manifest = JSON.parse(readFileSync(join(tempDataDir, 'imageRefs', `snapshot-${id.snapshotId}.json`), 'utf8'));
    expect(manifest.state).toBe('settled');
    expect(persistedJobs().find(row => row.id === job.jobId).status).toBe('canceled');
    expect(stubs.generateImage).not.toHaveBeenCalled();
  });

  it('refuses a replaced snapshot before invoking the provider', async () => {
    const source = join(tempDataDir, 'images', 'reviewed.png');
    mkdirSync(join(tempDataDir, 'images'), { recursive: true });
    writeFileSync(source, 'reviewed bytes');
    const digest = createHash('sha256').update('reviewed bytes').digest('hex');
    stubs.generateVideo.mockResolvedValue({});
    const blocker = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'hold the lane' } });
    await waitFor(() => stubs.generateVideo.mock.calls.length === 1);
    const job = await mediaJobQueue.enqueueJob({ kind: 'image', params: { prompt: 'edit', referenceImagePaths: [source], reviewedReferenceDigest: digest } });
    const snapshot = mediaJobQueue.getJob(job.jobId).params.reviewedReferenceRequest.referenceImagePaths[0];
    const identity = mediaJobQueue.getJob(job.jobId).params.reviewedReferenceSnapshot;
    // Keep the original inode alive: unlink + recreate may recycle it, which
    // would not establish the distinct file this ownership regression requires.
    renameSync(snapshot, `${snapshot}.original`);
    writeFileSync(snapshot, 'reviewed bytes');
    const replacement = lstatSync(snapshot, { bigint: true });
    expect({ dev: String(replacement.dev), ino: String(replacement.ino) })
      .not.toEqual({ dev: identity.dev, ino: identity.ino });
    videoGenEvents.emit('completed', { generationId: blocker.jobId, filename: 'done.mp4' });
    await waitFor(() => mediaJobQueue.getJob(job.jobId).status === 'failed');
    expect(stubs.generateImage).not.toHaveBeenCalled();
    expect(readFileSync(snapshot, 'utf8')).toBe('reviewed bytes');
  });

  it.each([
    ['local', 'a missing snapshot', /ownership is missing/, async (params) => { delete params.reviewedReferenceSnapshot; }],
    ['remote', 'a remote input that is not the snapshot', /ownership does not match/, async (params) => { params.remoteMedia.inputAssets[0].role = 'sourceImage'; }],
    ['local', 'an already-invoked snapshot', /not available for dispatch/, async (params) => {
      const { markSnapshotState } = await import('../imageGen/reviewedReference.js');
      await markSnapshotState(params.reviewedReferenceSnapshot, 'invoked');
    }],
  ])('refuses %s replay of %s without invoking the provider', async (route, _label, error, corrupt) => {
    const source = join(tempDataDir, 'images', 'reviewed.png');
    mkdirSync(join(tempDataDir, 'images'), { recursive: true });
    writeFileSync(source, 'reviewed bytes');
    const digest = createHash('sha256').update('reviewed bytes').digest('hex');
    mediaJobQueue.quiesceMediaJobQueue();
    const remoteMedia = route === 'remote' ? { remoteMedia: { ...remoteImageMediaParams(), inputAssets: [{ role: 'referenceImages', path: source }] } } : {};
    const job = await mediaJobQueue.enqueueJob({ kind: 'image', params: { prompt: 'edit', referenceImagePaths: [source], reviewedReferenceDigest: digest, ...remoteMedia } });
    const jobsPath = join(tempDataDir, 'media-jobs.json');
    const store = JSON.parse(readFileSync(jobsPath, 'utf8'));
    await corrupt(store.jobs.find(row => row.id === job.jobId).params);
    writeFileSync(jobsPath, JSON.stringify(store));
    await importFresh();
    await mediaJobQueue.initMediaJobQueue();
    await waitFor(() => mediaJobQueue.getJob(job.jobId).status === 'failed');
    expect(mediaJobQueue.getJob(job.jobId).error).toMatch(error);
    expect(stubs.generateImage).not.toHaveBeenCalled();
    expect(stubs.generateImageRemote).not.toHaveBeenCalled();
  });

  it('blocks guide generation and rechecks media policy before delayed provider dispatch', async () => {
    const { getProject } = await import('../musicVideo/projects.js');
    const request = { kind: 'image', params: { prompt: 'Synthetic guide', musicVideo: { projectId: 'mv-example', castAndSets: { key: 'guide' } } } };
    getProject.mockResolvedValueOnce({ mediaMode: 'code-only' });
    await expect(mediaJobQueue.enqueueJob(request)).rejects.toMatchObject({ code: 'MUSIC_VIDEO_MEDIA_POLICY' });
    expect(stubs.generateImage).not.toHaveBeenCalled();
    getProject.mockResolvedValueOnce({ mediaMode: 'code-images' }).mockResolvedValueOnce({ mediaMode: 'code-only' });
    const { jobId } = await mediaJobQueue.enqueueJob(request);
    await waitFor(() => mediaJobQueue.getJob(jobId).status === 'failed');
    expect(mediaJobQueue.getJob(jobId).error).toContain('planning guides');
    expect(stubs.generateImage).not.toHaveBeenCalled();
  });

  it('admits release cover art for a code-only video: the cover is not footage in it', async () => {
    const { getProject } = await import('../musicVideo/projects.js');
    getProject.mockClear();
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'image', params: { prompt: 'Synthetic cover', musicVideo: { projectId: 'mv-example', coverArt: { requestId: 'req-example' } } } });
    expect(mediaJobQueue.getJob(jobId)).toBeTruthy();
    expect(getProject).not.toHaveBeenCalled();
  });

  it('rejects an unreviewed music-video scene before queue admission and rechecks delayed dispatch', async () => {
    const { assertMusicVideoSceneReview } = await import('../musicVideo/productionReviewService.js');
    const request = { kind: 'video', params: { prompt: 'Synthetic scene', musicVideo: { projectId: 'mv-example', sceneId: 'scene-example' } } };
    assertMusicVideoSceneReview.mockRejectedValueOnce(new Error('Storyboard approval required'));
    await expect(mediaJobQueue.enqueueJob(request)).rejects.toThrow('Storyboard approval required');
    expect(stubs.generateVideo).not.toHaveBeenCalled();
    assertMusicVideoSceneReview.mockResolvedValueOnce().mockRejectedValueOnce(new Error('Proof changed while queued'));
    const { jobId } = await mediaJobQueue.enqueueJob(request);
    await waitFor(() => mediaJobQueue.getJob(jobId).status === 'failed');
    expect(mediaJobQueue.getJob(jobId).error).toContain('Proof changed while queued');
    expect(stubs.generateVideo).not.toHaveBeenCalled();
  });

  it('invalidates snapshots after enqueue and cancellation so idle clients see changes', async () => {
    const changed = vi.fn();
    mediaJobQueue.mediaJobEvents.on('changed', changed);
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'example' } });
    await flush();
    expect(changed).toHaveBeenCalledWith({});
    changed.mockClear();
    await mediaJobQueue.cancelJob(jobId);
    await flush();
    expect(changed).toHaveBeenCalledWith({});
    mediaJobQueue.mediaJobEvents.off('changed', changed);
  });

  it('maintenance preserves queued work and refuses Run now while active work finishes', async () => {
    const { maintenance } = await import('../../lib/maintenanceAdmission.js');
    const first = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'first' } });
    await waitFor(() => stubs.generateVideo.mock.calls.length === 1);
    const { hold } = maintenance.begin({ reason: 'Work', owner: 'Operator' });
    try {
      const second = await mediaJobQueue.enqueueJob({ kind: 'image', params: { mode: 'codex', prompt: 'next' } });
      expect(mediaJobQueue.runJobNow(second.jobId)).toMatchObject({ ok: false, code: 'MAINTENANCE_HELD' });
      expect(mediaJobQueue.getJob(second.jobId).status).toBe('queued');
      expect(maintenance.status().state).toBe('draining');
      videoGenEvents.emit('completed', { generationId: first.jobId, filename: 'example.mp4' });
      await waitFor(() => maintenance.status().state === 'ready');
      expect(stubs.generateImageCodex).not.toHaveBeenCalled();
      expect(mediaJobQueue.getJob(second.jobId).status).toBe('queued');
    } finally { maintenance.resume({ id: hold.id, revision: hold.revision }); }
  });

  it.each(['local', 'remote'])('keeps maintenance draining through terminal and archive writes for a %s render', async (route) => {
    const { maintenance } = await import('../../lib/maintenanceAdmission.js');
    const generate = route === 'remote' ? stubs.generateVideoRemote : stubs.generateVideo;
    generate.mockResolvedValueOnce({});
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'video', params: {
      prompt: 'Synthetic settlement', ...(route === 'remote' ? { remoteMedia: remoteVideoMediaParams() } : {}),
    } });
    await waitFor(() => generate.mock.calls.length === 1);
    await flush();
    const { hold } = maintenance.begin({ reason: 'Verify durable settlement', owner: 'Operator' });
    const realWrite = atomicWriteSpy.getMockImplementation();
    let releaseTerminal;
    let releaseArchive;
    const terminalWrite = new Promise(resolve => { releaseTerminal = resolve; });
    const archiveWrite = new Promise(resolve => { releaseArchive = resolve; });
    let completedWrites = 0;
    atomicWriteSpy.mockImplementation(async (path, data) => {
      if (data?.jobs?.some(job => job.id === jobId && job.status === 'completed')) {
        completedWrites += 1;
        if (completedWrites === 1) await terminalWrite;
        if (completedWrites === 2) await archiveWrite;
      }
      return realWrite(path, data);
    });
    try {
      videoGenEvents.emit('completed', { generationId: jobId, filename: 'example.mp4' });
      await waitFor(() => completedWrites === 1);
      expect(maintenance.status()).toMatchObject({ state: 'draining', blockers: [expect.objectContaining({ kind: 'media', resource: jobId })] });
      expect(mediaJobQueue.getJob(jobId).status).toBe('running');
      expect(persistedJobs().find(job => job.id === jobId).status).toBe('running');

      releaseTerminal();
      await waitFor(() => completedWrites === 2);
      expect(mediaJobQueue.getJob(jobId).status).toBe('completed');
      expect(persistedJobs().find(job => job.id === jobId).status).toBe('completed');
      expect(maintenance.status().state).toBe('draining');

      releaseArchive();
      await waitFor(() => maintenance.status().state === 'ready');
      expect(generate).toHaveBeenCalledTimes(1);
    } finally {
      releaseTerminal();
      releaseArchive();
      atomicWriteSpy.mockImplementation(realWrite);
      await flush();
      maintenance.resume({ id: hold.id, revision: hold.revision });
    }
  });

  // One case per distinct gate in assertFableLoomDispatchInputs: the accepted
  // path, a job queued before canon fingerprints (cross-version compatibility),
  // a recorded-asset digest (shared by reference/adapter/canon files), and the
  // adapter activation-word re-weave.
  it.each([
    'unchanged', 'unchanged-legacy-canon', 'canon-image', 'trigger',
  ])('checks FableLoom %s inputs after queue delay and before provider dispatch', async (changed) => {
    const images = join(tempDataDir, 'images');
    const loras = join(tempDataDir, 'loras');
    mkdirSync(images, { recursive: true });
    mkdirSync(loras, { recursive: true });
    const reference = join(images, 'reference.png');
    const canonReference = join(images, 'canon.png');
    const adapter = join(loras, 'example.safetensors');
    const canonAdapter = join(loras, 'canon.safetensors');
    writeFileSync(reference, 'original-reference');
    writeFileSync(canonReference, 'canon-reference');
    writeFileSync(adapter, 'original-adapter');
    writeFileSync(canonAdapter, 'canon-adapter');
    const hash = value => createHash('sha256').update(value).digest('hex');
    // A job queued before canon fingerprints existed keeps its basename check.
    const canonAsset = changed === 'unchanged-legacy-canon'
      ? { role: 'character-neutral', filename: 'canon.png' }
      : { role: 'character-neutral', filename: 'canon.png', inputRoot: 'images', sha256: hash('canon-reference') };
    const params = {
      mode: 'local', prompt: 'An authored view', negativePrompt: '',
      fableLoom: { loomId: 'loom-1', episodeId: 'ep-1', nodeId: 'node-1' },
      referenceImagePaths: [canonReference, reference], referenceImageStrengths: [1, 0.4],
      loraFilenames: ['canon.safetensors'], loraPaths: [adapter], loraScales: [0.8, 0.7],
      visualConditioning: {
        version: 1, capability: { kind: 'image', backend: 'local' },
        authoredPrompt: 'An authored view', authoredNegativePrompt: '',
        compiledPrompt: 'An authored view', compiledNegativePrompt: '', renderedPrompt: 'An authored view',
        assets: [
          canonAsset,
          { role: 'request-reference', filename: 'reference.png', inputRoot: 'images', sha256: hash('original-reference') },
        ],
        referenceImageStrengths: [1, 0.4],
        adapters: [
          { source: 'Canon adapter', filename: 'canon.safetensors', sha256: hash('canon-adapter'), scale: 0.8 },
          { source: 'Request adapter', relativePath: 'example.safetensors', filename: 'example.safetensors',
            sha256: hash('original-adapter'), scale: 0.7 },
        ],
      },
    };
    const first = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'busy' } });
    await waitFor(() => stubs.generateVideo.mock.calls.length === 1);
    const second = await mediaJobQueue.enqueueJob({ kind: 'image', params });
    expect(mediaJobQueue.getJob(second.jobId).status).toBe('queued');
    if (changed === 'canon-image') writeFileSync(canonReference, 'changed-canon-reference');
    if (changed === 'trigger') writeFileSync(`${adapter}.metadata.json`, JSON.stringify({ triggerWords: ['new-token'] }));
    videoGenEvents.emit('completed', { generationId: first.jobId, filename: 'example.mp4' });
    if (changed.startsWith('unchanged')) {
      await waitFor(() => stubs.generateImage.mock.calls.length === 1);
      expect(stubs.generateImage).toHaveBeenCalledWith(expect.objectContaining({
        referenceImagePaths: [canonReference, reference], referenceImageStrengths: [1, 0.4],
        loraFilenames: params.loraFilenames, loraPaths: params.loraPaths, loraScales: [0.8, 0.7],
      }));
      imageGenEvents.emit('completed', { generationId: second.jobId, filename: 'example.png' });
    } else {
      await waitFor(() => mediaJobQueue.getJob(second.jobId)?.status === 'failed');
      expect(mediaJobQueue.getJob(second.jobId).error).toContain('changed while queued');
      expect(stubs.generateImage).not.toHaveBeenCalled();
    }
  });

  it('continues to dispatch legacy FableLoom jobs without replay evidence', async () => {
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'image', params: {
      mode: 'local', prompt: 'Legacy scene', fableLoom: { loomId: 'loom-1', episodeId: 'ep-1', nodeId: 'node-1' },
    } });
    await waitFor(() => stubs.generateImage.mock.calls.length === 1);
    expect(stubs.generateImage).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Legacy scene' }));
    imageGenEvents.emit('completed', { generationId: jobId, filename: 'legacy.png' });
  });

  it('enqueueJob returns jobId + queued status + position', async () => {
    // Block the worker so the second enqueue lands behind the first in the
    // pipeline rather than entering an empty queue after the first ran.
    stubs.generateVideo.mockImplementation(() => new Promise(() => {}));
    const r1 = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'a' } });
    const r2 = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'b' } });
    expect(r1.status).toBe('queued');
    expect(r1.jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r1.position).toBe(1);
    expect(r2.position).toBe(2);
  });

  // The generative video upscale (#6511) rides the queue as its own kind, on
  // the serialized GPU lane and the videoGen event bus, so it can be watched,
  // cancelled and watchdogged exactly like a render.
  it('dispatches HTML compositions locally, forwards progress and cancellation, and settles the queue', async () => {
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'html-composition', params: { directory: 'compositions/example' } });
    await waitFor(() => stubs.renderComposition.mock.calls.length === 1);
    expect(stubs.renderComposition).toHaveBeenCalledWith(expect.objectContaining({ directory: 'compositions/example', jobId }));
    expect(mediaJobQueue.isRemoteMediaJob(mediaJobQueue.getJob(jobId))).toBe(false);
    videoGenEvents.emit('progress', { generationId: jobId, progress: 0.5 });
    expect(mediaJobQueue.getJob(jobId).progress).toBe(0.5);
    await mediaJobQueue.cancelJob(jobId);
    expect(stubs.cancelComposition).toHaveBeenCalledWith(jobId);
    videoGenEvents.emit('failed', { generationId: jobId, error: 'Render canceled' });
    await waitFor(() => mediaJobQueue.getJob(jobId)?.status === 'canceled');
  });

  it('dispatches private sharing copies through the serialized lane and preserves physical cancellation settlement', async () => {
    stubs.runSharingCopy.mockImplementation(() => new Promise(() => {}));
    stubs.cancelSharingCopy.mockReturnValue(true);
    const params = { sharingProjectId: 'mv-example', renderHistoryId: 'final-example', sourceHash: 'a'.repeat(64) };
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'video-sharing', params });
    await waitFor(() => stubs.runSharingCopy.mock.calls.length === 1);
    expect(stubs.runSharingCopy).toHaveBeenCalledWith(expect.objectContaining({ ...params, jobId }));
    expect(mediaJobQueue.isRemoteMediaJob(mediaJobQueue.getJob(jobId))).toBe(false);
    expect(mediaJobQueue.laneConcurrencyFor(mediaJobQueue.getJob(jobId))).toBe(1);
    videoGenEvents.emit('status', { generationId: jobId, message: 'Encoding sharing copy' });
    expect(mediaJobQueue.getJob(jobId).statusMsg).toBe('Encoding sharing copy');
    expect(await mediaJobQueue.cancelJob(jobId)).toMatchObject({ ok: true, status: 'canceling' });
    expect(stubs.cancelSharingCopy).toHaveBeenCalledWith(jobId);
    expect(mediaJobQueue.getJob(jobId).status).toBe('running');
    videoGenEvents.emit('failed', { generationId: jobId, error: 'Sharing export cancelled' });
    await waitFor(() => mediaJobQueue.getJob(jobId)?.status === 'canceled');
  });

  it('keeps sharing exports queued during maintenance and draining until process settlement', async () => {
    const { maintenance } = await import('../../lib/maintenanceAdmission.js');
    let releaseProcess;
    stubs.runSharingCopy.mockImplementation(() => new Promise(resolve => { releaseProcess = resolve; }));
    stubs.cancelSharingCopy.mockReturnValue(true);
    const params = { sharingProjectId: 'mv-example', renderHistoryId: 'final-example', sourceHash: 'a'.repeat(64) };
    const first = await mediaJobQueue.enqueueJob({ kind: 'video-sharing', params });
    await waitFor(() => stubs.runSharingCopy.mock.calls.length === 1);
    const { hold } = maintenance.begin({ reason: 'Sharing fixture drain', owner: 'Operator' });
    try {
      const second = await mediaJobQueue.enqueueJob({ kind: 'video-sharing', params: { ...params, sharingProjectId: 'mv-other' } });
      await mediaJobQueue.cancelJob(first.jobId);
      expect(maintenance.status().state).toBe('draining');
      expect(stubs.runSharingCopy).toHaveBeenCalledTimes(1);
      expect(mediaJobQueue.getJob(second.jobId).status).toBe('queued');
      videoGenEvents.emit('failed', { generationId: first.jobId, error: 'Sharing export cancelled' });
      await waitFor(() => mediaJobQueue.getJob(first.jobId).status === 'canceled');
      expect(maintenance.status().state).toBe('draining');
      releaseProcess();
      await waitFor(() => maintenance.status().state === 'ready');
      expect(stubs.runSharingCopy).toHaveBeenCalledTimes(1);
      expect(mediaJobQueue.getJob(first.jobId).status).toBe('canceled');
      await mediaJobQueue.cancelJob(second.jobId);
    } finally { releaseProcess?.(); maintenance.resume({ id: hold.id, revision: hold.revision }); }
  });

  // SuperCollider renders (#9413) are local-only audio jobs: progress rides the
  // audio bus, and a cancel reaches the render module so it can remove the container.
  it('dispatches SuperCollider renders locally with their frozen source and cancels through the render module', async () => {
    const params = { source: 'Pbind(\\dur, 1)', sourceHash: 'a'.repeat(64), durationSec: 8, seed: 7 };
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'supercollider', params });
    await waitFor(() => stubs.renderSuperCollider.mock.calls.length === 1);
    expect(stubs.renderSuperCollider).toHaveBeenCalledWith(expect.objectContaining({ ...params, jobId }));
    expect(mediaJobQueue.isRemoteMediaJob(mediaJobQueue.getJob(jobId))).toBe(false);
    audioGenEvents.emit('progress', { generationId: jobId, progress: 0.5, message: 'Rendering the SuperCollider score' });
    expect(mediaJobQueue.getJob(jobId)).toMatchObject({ progress: 0.5, statusMsg: 'Rendering the SuperCollider score' });
    expect(await mediaJobQueue.cancelJob(jobId)).toMatchObject({ ok: true, status: 'canceling' });
    expect(stubs.cancelSuperCollider).toHaveBeenCalledWith(jobId);
    audioGenEvents.emit('failed', { generationId: jobId, error: 'Render canceled' });
    await waitFor(() => mediaJobQueue.getJob(jobId)?.status === 'canceled');
  });

  describe('video-upscale kind', () => {
    const upscaleParams = { historyId: 'src-1', sourceFilename: 'src-1.mp4', runtime: 'ltx25', seed: 7 };

    it('dispatches to the upscale service and takes the serialized GPU lane', async () => {
      const render = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'a' } });
      const upscale = await mediaJobQueue.enqueueJob({ kind: 'video-upscale', params: upscaleParams });
      await waitFor(() => stubs.generateVideo.mock.calls.length === 1);

      // The render holds the one GPU slot; the upscale waits behind it rather
      // than starting a second heavy child on the same accelerator.
      expect(mediaJobQueue.getJob(render.jobId).status).toBe('running');
      expect(mediaJobQueue.getJob(upscale.jobId).status).toBe('queued');
      expect(stubs.runVideoUpscale).not.toHaveBeenCalled();
      expect(mediaJobQueue.laneConcurrencyFor({ kind: 'video-upscale', params: upscaleParams })).toBe(1);

      videoGenEvents.emit('completed', { generationId: render.jobId });
      await waitFor(() => stubs.runVideoUpscale.mock.calls.length === 1);
      expect(stubs.runVideoUpscale).toHaveBeenCalledWith({ ...upscaleParams, chunks: 1, uploadedTempPaths: [], jobId: upscale.jobId });
    });

    it('settles on the videoGen event bus and cancels through the upscale service', async () => {
      const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'video-upscale', params: upscaleParams });
      await waitFor(() => stubs.runVideoUpscale.mock.calls.length === 1);

      await mediaJobQueue.cancelJob(jobId);
      expect(stubs.cancelVideoUpscale).toHaveBeenCalledWith(jobId);
      // The service reports the kill as a failure; the queue maps a requested
      // cancel to 'canceled' so the source-preserving outcome reads correctly.
      videoGenEvents.emit('failed', { generationId: jobId, error: 'Canceled while running' });
      await waitFor(() => mediaJobQueue.getJob(jobId)?.status === 'canceled');
    });

    it('reports the kind in queue capacity so it is never invisible', () => {
      expect(Object.keys(mediaJobQueue.getQueueCapacity().byKind)).toContain('video-upscale');
    });

    it('restores the same Topaz request and does not claim cancellation without provider confirmation', async () => {
      const id = '00000000-0000-4000-8000-000000000099';
      writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify({ jobs: [{ id, kind: 'video-upscale', status: 'running', queuedAt: '2026-04-30T10:00:00Z', params: { mode: 'topaz', requestId: 'request-id' }, result: { topazPhase: 'accepting', topazUncertain: true } }] }));
      await importFresh();
      await mediaJobQueue.initMediaJobQueue();
      await waitFor(() => stubs.runTopazUpscale.mock.calls.length === 1);
      expect(stubs.runTopazUpscale).toHaveBeenCalledWith(expect.objectContaining({ jobId: id, requestId: 'request-id', topazRecovery: true }));
      expect(mediaJobQueue.getJob(id).result).toMatchObject({ topazPhase: 'accepting', topazUncertain: true });
      await mediaJobQueue.cancelJob(id);
      videoGenEvents.emit('failed', { generationId: id, error: 'Cancellation unconfirmed', remoteCancellationConfirmed: false });
      await waitFor(() => mediaJobQueue.getJob(id).status === 'failed');
      expect(mediaJobQueue.getJob(id).result.topazUncertain).toBe(true);
    });
  });

  describe('getQueueCapacity', () => {
    it('separates the serialized GPU lane from the parallel remote lane', async () => {
      // Both lanes run concurrently, so a remote job must NOT be reported as
      // waiting behind the local GPU render — that conflation is what made two
      // idle peers each read as busy while waiting on the other.
      stubs.generateVideo.mockImplementation(() => new Promise(() => {}));
      stubs.generateAudioRemote.mockImplementation(() => new Promise(() => {}));
      await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'local' } });
      await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'waiting' } });
      await mediaJobQueue.enqueueJob({
        kind: 'audio',
        params: {
          prompt: '',
          engine: 'remote-audio',
          modelId: 'example/model',
          remoteMedia: remoteMediaParams(),
        },
      });
      await waitFor(() => stubs.generateVideo.mock.calls.length === 1
        && stubs.generateAudioRemote.mock.calls.length === 1);

      const capacity = mediaJobQueue.getQueueCapacity();
      // The remote render runs concurrently with the local one and the second
      // video still waits — the remote job neither occupies the GPU lane nor
      // queues behind it.
      expect(capacity.lanes.gpu).toMatchObject({ running: 1, queued: 1, limit: 1 });
      expect(capacity.lanes.remote).toMatchObject({ running: 1, queued: 0 });
      expect(capacity.runningKind).toBe('video');
      expect(capacity.totals).toEqual({ running: 2, queued: 1 });
    });

    it('runs local and Grok video renders in parallel lanes', async () => {
      stubs.generateVideo.mockImplementation(() => new Promise(() => {}));
      stubs.generateVideoGrok.mockImplementation(() => new Promise(() => {}));
      const local = await mediaJobQueue.enqueueJob({ kind: 'video', params: { mode: 'text', prompt: 'local' } });
      const grok = await mediaJobQueue.enqueueJob({
        kind: 'video',
        params: { mode: IMAGE_GEN_MODE.GROK, prompt: 'grok' },
      });

      await waitFor(() => stubs.generateVideo.mock.calls.length === 1
        && stubs.generateVideoGrok.mock.calls.length === 1);

      expect(mediaJobQueue.getJob(local.jobId).status).toBe('running');
      expect(mediaJobQueue.getJob(grok.jobId).status).toBe('running');
      expect(mediaJobQueue.getQueueCapacity().lanes).toMatchObject({
        gpu: { running: 1, queued: 0 },
        cloud: { running: 1, queued: 0 },
      });

      videoGenEvents.emit('failed', { generationId: local.jobId, error: 'cleanup' });
      videoGenEvents.emit('failed', { generationId: grok.jobId, error: 'cleanup' });
      await waitFor(() => mediaJobQueue.getJob(local.jobId)?.status === 'failed'
        && mediaJobQueue.getJob(grok.jobId)?.status === 'failed');
    });

    it('counts queue depth per kind', async () => {
      stubs.generateVideo.mockImplementation(() => new Promise(() => {}));
      await mediaJobQueue.enqueueJob({ kind: 'video', params: {} });
      await mediaJobQueue.enqueueJob({ kind: 'video', params: {} });
      await mediaJobQueue.enqueueJob({ kind: 'image', params: {} });
      await waitFor(() => stubs.generateVideo.mock.calls.length === 1);

      const { byKind } = mediaJobQueue.getQueueCapacity();
      expect(byKind.video).toEqual({ running: 1, queued: 1 });
      expect(byKind.image).toEqual({ running: 0, queued: 1 });
    });

    // An absent key and a zero read identically in a UI, and only one of them
    // is true — every known kind must be present even with no work.
    it('reports every known kind on an empty queue', () => {
      const { byKind, totals, runningKind } = mediaJobQueue.getQueueCapacity();
      expect(Object.keys(byKind).sort()).toEqual([...mediaJobQueue.JOB_KINDS].sort());
      expect(Object.values(byKind).every((c) => c.running === 0 && c.queued === 0)).toBe(true);
      expect(totals).toEqual({ running: 0, queued: 0 });
      expect(runningKind).toBeNull();
    });

    it('reports the remote lane bound', () => {
      expect(mediaJobQueue.getQueueCapacity().lanes.remote.limit)
        .toBe(mediaJobQueue.REMOTE_MEDIA_PARALLEL_LIMIT);
    });
  });

  describe('laneConcurrencyFor', () => {
    // The lanes are alternatives, not a pool: a caller that summed their limits
    // would claim the wide cloud-CLI width for GPU work that serializes.
    it('answers with the lane the job would run in, never a total', () => {
      const { lanes } = mediaJobQueue.getQueueCapacity();
      expect(mediaJobQueue.laneConcurrencyFor({ kind: 'audio', params: {} })).toBe(lanes.gpu.limit);
      expect(mediaJobQueue.laneConcurrencyFor({ kind: 'image', params: {} })).toBe(lanes.gpu.limit);
      expect(mediaJobQueue.laneConcurrencyFor({
        kind: 'image', params: { mode: IMAGE_GEN_MODE.CODEX },
      })).toBe(lanes.cloud.limit);
      // A peer runs one job at a time; the remote total bounds all peers.
      expect(mediaJobQueue.laneConcurrencyFor({
        kind: 'audio', params: { remoteMedia: remoteMediaParams() },
      })).toBe(1);
    });

    it('tracks the cloud lane limit as configured rather than a snapshot of it', () => {
      mediaJobQueue.setCodexParallelLimit(5);
      expect(mediaJobQueue.laneConcurrencyFor({
        kind: 'image', params: { mode: IMAGE_GEN_MODE.CODEX },
      })).toBe(5);
    });
  });

  it('rejects unknown kinds', async () => {
    await expect(mediaJobQueue.enqueueJob({ kind: 'bogus', params: {} })).rejects.toThrow(/invalid kind/);
  });

  it('listJobs filters by kind / status / owner', async () => {
    // Pin the first dequeued job in 'running' indefinitely so the rest of
    // the assertions see the queue + running set we expect.
    stubs.generateVideo.mockImplementation(() => new Promise(() => {}));
    stubs.generateImage.mockImplementation(() => new Promise(() => {}));
    await mediaJobQueue.enqueueJob({ kind: 'video', params: {}, owner: 'creative-director:cd-1' });
    await mediaJobQueue.enqueueJob({ kind: 'image', params: {}, owner: 'voice' });
    await mediaJobQueue.enqueueJob({ kind: 'video', params: {}, owner: 'creative-director:cd-2' });
    expect(mediaJobQueue.listJobs({ kind: 'video' })).toHaveLength(2);
    expect(mediaJobQueue.listJobs({ kind: 'image' })).toHaveLength(1);
    expect(mediaJobQueue.listJobs({ owner: 'voice' })).toHaveLength(1);
    await vi.dynamicImportSettled();
    await flush();
    // One job is 'running' (worker dequeued it), the other two are still 'queued'.
    expect(mediaJobQueue.listJobs({ status: 'queued' })).toHaveLength(2);
    expect(mediaJobQueue.listJobs({ status: 'running' })).toHaveLength(1);
  });

  it('limits a 500-row terminal archive while preserving live FIFO and filtered recents', async () => {
    const now = Date.now();
    const archived = Array.from({ length: 500 }, (_, i) => ({
      id: `archived-${i}`,
      kind: i % 2 ? 'video' : 'image',
      owner: i % 4 ? 'other' : 'example',
      status: i % 5 === 0 ? 'completed' : i % 3 === 0 ? 'canceled' : 'failed',
      queuedAt: new Date(now - 600_000).toISOString(),
      completedAt: new Date(now - i * 1000).toISOString(),
      params: {},
    }));
    writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify({ jobs: archived }));
    await mediaJobQueue.initMediaJobQueue();
    stubs.generateVideo.mockImplementation(() => new Promise(() => {}));
    const first = await mediaJobQueue.enqueueJob({ kind: 'video', params: {}, owner: 'example' });
    const second = await mediaJobQueue.enqueueJob({ kind: 'video', params: {}, owner: 'example' });
    await flush();

    const all = mediaJobQueue.listQueueJobs();
    expect(all.slice(0, 2).map((j) => j.id)).toEqual([first.jobId, second.jobId]);
    expect(all).toHaveLength(12);
    expect(all.slice(2).map((j) => j.id)).toEqual(
      archived.filter((j) => j.status !== 'completed').slice(0, 10).map((j) => j.id),
    );
    expect(mediaJobQueue.listJobs()).toHaveLength(502);

    const scoped = mediaJobQueue.listQueueJobs({ kind: 'video', owner: 'example', limit: 3 });
    expect(scoped.slice(0, 2).map((j) => j.id)).toEqual([first.jobId, second.jobId]);
    expect(scoped.slice(2).map((j) => j.id)).toEqual(
      archived.filter((j) => j.kind === 'video' && j.owner === 'example' && j.status !== 'completed')
        .slice(0, 3).map((j) => j.id),
    );
  });

  it('cancelQueuedJobs cancels every queued job, leaves running ones alone', async () => {
    // Block the worker so subsequent enqueues stay queued.
    let resolveBlocker;
    stubs.generateVideo.mockImplementation(() => new Promise((r) => { resolveBlocker = r; }));
    const blocker = await mediaJobQueue.enqueueJob({ kind: 'video', params: {} });
    const a = await mediaJobQueue.enqueueJob({ kind: 'video', params: {} });
    const b = await mediaJobQueue.enqueueJob({ kind: 'image', params: {} });
    const c = await mediaJobQueue.enqueueJob({ kind: 'video', params: {} });

    await flush();

    // No filter: every queued job (a, b, c) cancels; running blocker is untouched.
    // Canceled jobs are archived (not dropped) so they stay findable for the
    // recent-reel UI and /api/media-jobs?status=canceled within the 24h TTL.
    const r = await mediaJobQueue.cancelQueuedJobs();
    expect(r.canceled).toBe(3);
    expect(mediaJobQueue.getJob(a.jobId).status).toBe('canceled');
    expect(mediaJobQueue.getJob(b.jobId).status).toBe('canceled');
    expect(mediaJobQueue.getJob(c.jobId).status).toBe('canceled');
    expect(mediaJobQueue.getJob(blocker.jobId).status).toBe('running');

    videoGenEvents.emit('failed', { generationId: blocker.jobId, error: 'cleanup' });
    if (resolveBlocker) resolveBlocker();
    await flush();
  });

  it('reports cancellation staged during admission without announcing an enqueue', async () => {
    const realWrite = atomicWriteSpy.getMockImplementation();
    let releaseAdmission;
    let releaseCancellation;
    const admissionGate = new Promise(resolve => { releaseAdmission = resolve; });
    const cancellationGate = new Promise(resolve => { releaseCancellation = resolve; });
    atomicWriteSpy.mockImplementationOnce(async (...args) => {
      await admissionGate;
      return realWrite(...args);
    });
    atomicWriteSpy.mockImplementationOnce(async (...args) => {
      await cancellationGate;
      return realWrite(...args);
    });
    const enqueued = vi.fn();
    mediaJobQueue.mediaJobEvents.on('enqueued', enqueued);
    const frames = [];
    const admission = mediaJobQueue.enqueueJob({ kind: 'video', params: {} });
    let cancellation;
    try {
      await waitFor(() => atomicWriteSpy.mock.calls.length >= 1);
      const job = mediaJobQueue.listJobs()[0];
      expect(mediaJobQueue.attachSseClient(job.id, {
        writeHead: () => {},
        write: message => {
          for (const line of message.split('\n')) {
            if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)));
          }
        },
        end: () => {},
        req: { on: () => {} },
      })).toBe(true);
      // Discard the subscription's initial status replay; observe admission's fan-out.
      frames.length = 0;
      cancellation = mediaJobQueue.cancelQueuedJobs();
      releaseAdmission();
      await expect(admission).resolves.toMatchObject({ jobId: job.id, status: 'canceled' });
      expect(enqueued).not.toHaveBeenCalled();
      expect(frames.some(frame => frame.type === 'queued')).toBe(false);
      expect(stubs.generateVideo).not.toHaveBeenCalled();

      releaseCancellation();
      await expect(cancellation).resolves.toEqual({ canceled: 1 });
      expect(mediaJobQueue.getJob(job.id).status).toBe('canceled');
      expect(frames.some(frame => frame.type === 'canceled')).toBe(true);
    } finally {
      releaseAdmission();
      releaseCancellation();
      await Promise.allSettled([admission, cancellation]);
      mediaJobQueue.mediaJobEvents.off('enqueued', enqueued);
      atomicWriteSpy.mockImplementation(realWrite);
    }
  });

  it('cancelQueuedJobs respects a kind filter', async () => {
    let resolveBlocker;
    stubs.generateVideo.mockImplementation(() => new Promise((r) => { resolveBlocker = r; }));
    const blocker = await mediaJobQueue.enqueueJob({ kind: 'video', params: {} });
    const v = await mediaJobQueue.enqueueJob({ kind: 'video', params: {} });
    const i = await mediaJobQueue.enqueueJob({ kind: 'image', params: {} });

    await flush();

    const r = await mediaJobQueue.cancelQueuedJobs({ kind: 'video' });
    expect(r.canceled).toBe(1);
    // Canceled jobs are archived (not dropped) — `v` is findable with status 'canceled'.
    expect(mediaJobQueue.getJob(v.jobId).status).toBe('canceled');
    // Image queued job is left in the queue (still 'queued', not canceled).
    expect(mediaJobQueue.getJob(i.jobId).status).toBe('queued');
    expect(mediaJobQueue.getJob(blocker.jobId).status).toBe('running');

    // Cleanup the leftover queued image + the running blocker.
    await mediaJobQueue.cancelJob(i.jobId);
    videoGenEvents.emit('failed', { generationId: blocker.jobId, error: 'cleanup' });
    if (resolveBlocker) resolveBlocker();
    await flush();
  });

  it('cancelJob drops a queued job before it starts', async () => {
    // Block the worker by making the first job hang — generateVideo never
    // resolves, so subsequent enqueues stay queued for cancellation.
    let resolveBlocker;
    stubs.generateVideo.mockImplementation(() => new Promise((r) => { resolveBlocker = r; }));
    const blocker = await mediaJobQueue.enqueueJob({ kind: 'video', params: {} });
    const target = await mediaJobQueue.enqueueJob({ kind: 'video', params: {} });

    await flush();

    const result = await mediaJobQueue.cancelJob(target.jobId);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('canceled');
    // Canceled jobs are archived (not dropped) so /api/media-jobs?status=canceled
    // and the recent-reel UI can find them within the 24h TTL.
    const archived = mediaJobQueue.getJob(target.jobId);
    expect(archived).not.toBeNull();
    expect(archived.status).toBe('canceled');

    // Unblock the first one for cleanup.
    videoGenEvents.emit('failed', { generationId: blocker.jobId, error: 'cleanup' });
    if (resolveBlocker) resolveBlocker();
    await flush();
  });

  it('keeps an image running through its finish and retains the ungraded reference', async () => {
    let finish;
    stubs.generateImageCodex.mockImplementation(async () => ({}));
    stubs.finishVisualProfile.mockImplementation(({ result }) => new Promise(resolve => { finish = () => resolve({ ...result, finishedVariant: { filename: 'example-finished.png' } }); }));
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'image', params: { mode: 'codex', prompt: 'Example', visualProfile: { version: 1 } } });
    await waitFor(() => stubs.generateImageCodex.mock.calls.length === 1);
    imageGenEvents.emit('completed', { generationId: jobId, filename: 'example-source.png' });
    await waitFor(() => typeof finish === 'function');
    expect(mediaJobQueue.getJob(jobId).status).toBe('running');
    expect(mediaJobQueue.getJob(jobId).params.visualProfileSource.filename).toBe('example-source.png');
    finish();
    await waitFor(() => mediaJobQueue.getJob(jobId).status === 'completed');
    expect(mediaJobQueue.getJob(jobId).result).toMatchObject({ filename: 'example-source.png', finishedVariant: { filename: 'example-finished.png' } });
  });

  it('cancels the finish browser independently after the provider has settled', async () => {
    stubs.generateImageCodex.mockImplementation(async () => ({}));
    stubs.finishVisualProfile.mockImplementation(({ signal }) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }));
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'image', params: { mode: 'codex', prompt: 'Example', visualProfile: { version: 1 } } });
    await waitFor(() => stubs.generateImageCodex.mock.calls.length === 1);
    imageGenEvents.emit('completed', { generationId: jobId, filename: 'example-source.png' });
    await waitFor(() => stubs.finishVisualProfile.mock.calls.length === 1);
    expect((await mediaJobQueue.cancelJob(jobId)).ok).toBe(true);
    await waitFor(() => mediaJobQueue.getJob(jobId).status === 'canceled');
    expect(stubs.cancelImageCodex).not.toHaveBeenCalled();
    expect(mediaJobQueue.getJob(jobId).result.filename).toBe('example-source.png');
  });

  it.each(['local', 'remote', 'settled-remote'])('persists %s film-finish cancellation before acknowledging and honors it after restart', async route => {
    let releaseFinish;
    stubs.finishVisualProfile.mockImplementation(({ signal }) => new Promise((_resolve, reject) => {
      releaseFinish = () => reject(signal.reason || new Error('fixture cleanup'));
    }));
    const generate = route === 'local' ? stubs.generateImageCodex : stubs.generateImageRemote;
    generate.mockResolvedValue({});
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'image', params: {
      mode: 'codex', prompt: 'Example', visualProfile: { version: 1 },
      ...(route !== 'local' ? { remoteMedia: remoteImageMediaParams() } : {}),
      ...(route === 'settled-remote' ? { visualProfileSource: { filename: 'example-source.png' } } : {}),
    } });
    if (route !== 'settled-remote') {
      await waitFor(() => generate.mock.calls.length === 1);
      imageGenEvents.emit('completed', { generationId: jobId, filename: 'example-source.png', remoteInputsDisposable: true });
    }
    await waitFor(() => typeof releaseFinish === 'function');
    let interruptedSnapshot;
    try {
      expect(await mediaJobQueue.cancelJob(jobId)).toMatchObject({ ok: true, status: 'canceling' });
      interruptedSnapshot = JSON.parse(readFileSync(join(tempDataDir, 'media-jobs.json'), 'utf8'));
      const saved = interruptedSnapshot.jobs.find(row => row.id === jobId);
      expect(saved).toMatchObject({ status: 'running', cancelRequested: true,
        params: { visualProfileSource: { filename: 'example-source.png' } } });
      if (route !== 'local') expect(saved.params.remoteMedia.cancelRequested).toBe(true);
    } finally {
      releaseFinish();
    }
    await waitFor(() => mediaJobQueue.getJob(jobId).status === 'canceled');
    await importFresh();
    // Restore the exact acknowledged snapshot to model process loss before the
    // in-flight finish handler persisted its terminal cancellation.
    writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify(interruptedSnapshot));
    stubs.finishVisualProfile.mockClear();
    generate.mockClear();
    if (route === 'remote') generate.mockImplementation(async params => {
      imageGenEvents.emit('failed', { generationId: params.jobId, error: 'Canceled remotely', remoteInputsDisposable: true });
    });
    await mediaJobQueue.initMediaJobQueue();
    await waitFor(() => mediaJobQueue.getJob(jobId)?.status === 'canceled');
    expect(stubs.finishVisualProfile).not.toHaveBeenCalled();
    expect(mediaJobQueue.getJob(jobId).result).toMatchObject({ filename: 'example-source.png' });
    if (route === 'remote') {
      expect(generate).toHaveBeenCalledWith(expect.objectContaining({ jobId,
        remoteMedia: expect.objectContaining({ reconcile: true, cancelRequested: true }) }));
    } else {
      expect(generate).not.toHaveBeenCalled();
      const response = { write: vi.fn(), req: { on: vi.fn() }, writeHead: vi.fn(), end: vi.fn() };
      mediaJobQueue.attachSseClient(jobId, response);
      expect(response.write.mock.calls.flat().join('')).toContain('"type":"canceled"');
    }
  });

  it('does not acknowledge film-finish cancellation when its snapshot cannot be written', async () => {
    let releaseFinish;
    stubs.generateImageCodex.mockResolvedValue({});
    stubs.finishVisualProfile.mockImplementation(({ signal }) => new Promise((_resolve, reject) => {
      releaseFinish = () => reject(signal.reason || new Error('fixture cleanup'));
    }));
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'image', params: {
      mode: 'codex', prompt: 'Example', visualProfile: { version: 1 },
    } });
    await waitFor(() => stubs.generateImageCodex.mock.calls.length === 1);
    imageGenEvents.emit('completed', { generationId: jobId, filename: 'example-source.png' });
    await waitFor(() => typeof releaseFinish === 'function');
    const realWrite = atomicWriteSpy.getMockImplementation();
    atomicWriteSpy.mockRejectedValueOnce(new Error('synthetic storage failure'));
    try {
      await expect(mediaJobQueue.cancelJob(jobId)).rejects.toThrow('synthetic storage failure');
    } finally {
      atomicWriteSpy.mockImplementation(realWrite);
      releaseFinish();
    }
    await waitFor(() => mediaJobQueue.getJob(jobId).status === 'canceled');
  });

  it('aborts a stalled finish at its deadline and holds the lane until browser cleanup settles', async () => {
    let releaseCleanup;
    let aborted = false;
    const cleanup = new Promise(resolve => { releaseCleanup = resolve; });
    stubs.generateImage.mockImplementation(async () => ({}));
    stubs.finishVisualProfile.mockImplementation(({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        void cleanup.then(() => reject(signal.reason));
      }, { once: true });
    }));
    const first = await mediaJobQueue.enqueueJob({ kind: 'image', params: { mode: 'local', prompt: 'First', visualProfile: { version: 1 } } });
    await waitFor(() => stubs.generateImage.mock.calls.length === 1);
    const next = await mediaJobQueue.enqueueJob({ kind: 'image', params: { mode: 'local', prompt: 'Next' } });
    vi.useFakeTimers();
    try {
      imageGenEvents.emit('completed', { generationId: first.jobId, filename: 'original.png' });
      await vi.waitFor(() => expect(stubs.finishVisualProfile).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(mediaJobQueue.VISUAL_PROFILE_FINISH_TIMEOUT_MS);
      expect(aborted).toBe(true);
      expect(mediaJobQueue.getJob(first.jobId).status).toBe('running');
      expect(mediaJobQueue.getJob(first.jobId).params.visualProfileSource.filename).toBe('original.png');
      expect(mediaJobQueue.getJob(next.jobId).status).toBe('queued');
      expect(stubs.generateImage).toHaveBeenCalledTimes(1);
      releaseCleanup();
      await vi.waitFor(() => expect(mediaJobQueue.getJob(first.jobId).status).toBe('failed'));
      expect(mediaJobQueue.getJob(first.jobId)).toMatchObject({
        result: { filename: 'original.png' }, error: expect.stringContaining('exceeded its 3-minute deadline'),
      });
      await vi.waitFor(() => expect(stubs.generateImage).toHaveBeenCalledTimes(2));
      imageGenEvents.emit('completed', { generationId: next.jobId, filename: 'next.png' });
    } finally {
      releaseCleanup();
      vi.useRealTimers();
    }
  });

  it('retains maintenance ownership when the finish browser cleanup is unverified', async () => {
    stubs.generateImage.mockImplementation(async () => ({}));
    stubs.finishVisualProfile.mockImplementation(async ({ onCleanupFailure }) => {
      onCleanupFailure();
      throw new Error('Owned browser cleanup did not settle');
    });
    const { maintenance } = await import('../../lib/maintenanceAdmission.js');
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'image', params: { mode: 'local', prompt: 'First', visualProfile: { version: 1 } } });
    await waitFor(() => stubs.generateImage.mock.calls.length === 1);
    imageGenEvents.emit('completed', { generationId: jobId, filename: 'original.png' });
    await waitFor(() => mediaJobQueue.getJob(jobId).status === 'failed');
    await waitFor(() => maintenance.status().blockers.some(blocker => blocker.resource === jobId && blocker.unsettled));
    expect(mediaJobQueue.getJob(jobId).result.filename).toBe('original.png');
  });

  it('retries a failed local finish from its durable source without another image provider call', async () => {
    stubs.generateImageCodex.mockImplementation(async () => ({}));
    stubs.finishVisualProfile.mockRejectedValueOnce(new Error('Browser unavailable')).mockImplementation(async ({ result }) => result);
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'image', params: { mode: 'codex', prompt: 'Example', visualProfile: { version: 1 } } });
    await waitFor(() => stubs.generateImageCodex.mock.calls.length === 1);
    imageGenEvents.emit('completed', { generationId: jobId, filename: 'example-source.png' });
    await waitFor(() => mediaJobQueue.getJob(jobId).status === 'failed');
    const failed = mediaJobQueue.getJob(jobId);
    expect(failed.error).toContain('original image retained');
    const retry = await mediaJobQueue.enqueueJob({ kind: 'image', params: failed.params });
    await waitFor(() => mediaJobQueue.getJob(retry.jobId).status === 'completed');
    expect(stubs.generateImageCodex).toHaveBeenCalledTimes(1);
    expect(mediaJobQueue.getJob(retry.jobId).result.filename).toBe('example-source.png');
  });

  it('finishes a settled remote source locally without acquiring or retaining a peer reservation', async () => {
    stubs.finishVisualProfile.mockImplementation(async ({ result }) => result);
    const job = await mediaJobQueue.enqueueJob({ kind: 'image', params: {
      remoteMedia: remoteImageMediaParams(), visualProfile: { version: 1 }, visualProfileSource: { filename: 'settled-source.png' },
    } });
    await waitFor(() => mediaJobQueue.getJob(job.jobId).status === 'completed');
    expect(mediaJobQueue.getJob(job.jobId).params.remotePeerReservation).not.toBe(true);
    expect(stubs.finishVisualProfile).toHaveBeenCalledTimes(1);
    expect(stubs.generateImageCodex).not.toHaveBeenCalled();
  });

  it('worker drains a queued video job and marks it completed on the gen completed event', async () => {
    const progressLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const job = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'hi' } });
    // Wait until the worker invokes generateVideo. The stub records the call.
    await waitFor(() => stubs.generateVideo.mock.calls.length === 1);
    // The queue passed our jobId through so the gen module would write to
    // a deterministic file.
    expect(stubs.generateVideo).toHaveBeenCalledWith(expect.objectContaining({ jobId: job.jobId, prompt: 'hi' }));

    // Simulate the gen module finishing. The dispatcher attached a listener
    // on videoGenEvents 'completed' for our jobId and flips the queue's job
    // status.
    videoGenEvents.emit('completed', {
      generationId: job.jobId,
      filename: `${job.jobId}.mp4`,
      path: `/data/videos/${job.jobId}.mp4`,
    });
    await waitFor(() => mediaJobQueue.getJob(job.jobId).status === 'completed');

    const finished = mediaJobQueue.getJob(job.jobId);
    expect(finished.status).toBe('completed');
    expect(finished.completedAt).toBeTruthy();
    expect(finished.result?.path).toBe(`/data/videos/${job.jobId}.mp4`);
    const summary = `media-job [${job.jobId.slice(0, 8)}] completed`;
    expect(progressLog).toHaveBeenCalledWith(expect.stringContaining(summary));
    expect(errorLog).not.toHaveBeenCalledWith(expect.stringContaining(summary));
  });

  it('progress/status events update the live job record for non-SSE readers', async () => {
    const file = join(tempDataDir, 'media-jobs.json');
    const job = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'progress please' } });
    await waitFor(() => stubs.generateVideo.mock.calls.length === 1);

    videoGenEvents.emit('status', { generationId: job.jobId, message: 'Loading pipeline' });
    await waitFor(() => mediaJobQueue.getJob(job.jobId)?.statusMsg === 'Loading pipeline');
    expect(mediaJobQueue.getJob(job.jobId).progress).toBe(0);

    videoGenEvents.emit('progress', {
      generationId: job.jobId,
      progress: 0.42,
      step: 21,
      totalSteps: 50,
      message: 'Rendering step 21/50',
    });
    await waitFor(() => mediaJobQueue.getJob(job.jobId)?.progress === 0.42);
    const running = mediaJobQueue.getJob(job.jobId);
    expect(running.status).toBe('running');
    expect(running.statusMsg).toBe('Rendering step 21/50');

    videoGenEvents.emit('completed', { generationId: job.jobId, filename: `${job.jobId}.mp4` });
    await waitFor(() => {
      const data = JSON.parse(readFileSync(file, 'utf-8'));
      const persisted = data.jobs.find((j) => j.id === job.jobId);
      return persisted?.status === 'completed';
    });
    const persisted = JSON.parse(readFileSync(file, 'utf-8')).jobs.find((j) => j.id === job.jobId);
    expect(persisted.progress).toBe(1);
    expect(persisted.statusMsg).toBe('Completed');
  });

  it('retains the render ETA on the job record so a reload gets it back (#3801)', async () => {
    const job = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'how long' } });
    await waitFor(() => stubs.generateVideo.mock.calls.length === 1);
    await waitFor(() => mediaJobQueue.getJob(job.jobId)?.status === 'running');

    videoGenEvents.emit('progress', { generationId: job.jobId, progress: 0.1, etaMs: 1_800_000 });
    await waitFor(() => mediaJobQueue.getJob(job.jobId)?.etaMs === 1_800_000);
    // A later frame without the field must not wipe the retained estimate —
    // the client hydrates from this record on reload.
    videoGenEvents.emit('progress', { generationId: job.jobId, progress: 0.2 });
    await waitFor(() => mediaJobQueue.getJob(job.jobId)?.progress === 0.2);
    expect(mediaJobQueue.getJob(job.jobId).etaMs).toBe(1_800_000);

    videoGenEvents.emit('completed', { generationId: job.jobId, filename: `${job.jobId}.mp4` });
    await waitFor(() => mediaJobQueue.getJob(job.jobId)?.status === 'completed');
  });

  it('forwards structured step/totalSteps/loss onto the SSE wire', async () => {
    // The LoRA training live gallery reads loss + step off the progress/preview
    // SSE frames to plot a curve and key sample thumbnails by step. The
    // dispatcher must pass those structured fields through (additive — guarded
    // by presence so image/video frames that omit them are unaffected).
    const job = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'metrics' } });
    await waitFor(() => stubs.generateVideo.mock.calls.length === 1);
    await waitFor(() => mediaJobQueue.getJob(job.jobId)?.status === 'running');

    const frames = [];
    const res = {
      writeHead: () => {},
      write: (msg) => {
        for (const line of msg.split('\n')) {
          if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)));
        }
      },
      end: () => {}, // sseUtils calls c.end() on deferred cleanup after a terminal frame
      req: { on: () => {} },
    };
    expect(mediaJobQueue.attachSseClient(job.jobId, res)).toBe(true);

    videoGenEvents.emit('progress', {
      generationId: job.jobId, progress: 0.5, step: 250, totalSteps: 600, loss: 0.0812,
      message: 'Training step 250/600',
    });
    await waitFor(() => frames.some((f) => f.type === 'progress' && f.step === 250));
    expect(frames.find((f) => f.type === 'progress' && f.step === 250))
      .toMatchObject({ type: 'progress', step: 250, totalSteps: 600, loss: 0.0812 });

    // Preview-only sample frame (no progress number) still carries its step.
    videoGenEvents.emit('progress', {
      generationId: job.jobId, currentImage: 'http://x/samples/step-000250.png', step: 250,
      message: 'Sample @ step 250',
    });
    await waitFor(() => frames.some((f) => f.type === 'preview'));
    expect(frames.find((f) => f.type === 'preview'))
      .toMatchObject({ type: 'preview', currentImage: 'http://x/samples/step-000250.png', step: 250 });

    videoGenEvents.emit('completed', { generationId: job.jobId, filename: `${job.jobId}.mp4` });
    await waitFor(() => mediaJobQueue.getJob(job.jobId)?.status === 'completed');
  });

  it('forwards the runner phase on status and progress frames (#5872)', async () => {
    // A local video render is silent for minutes at a time — FastH3 streams an
    // ~89 GB INT4 DiT before its first denoise step and reports no numeric
    // progress while it does. The phase id is the ONLY thing that lets the page
    // say what it is doing, so it has to survive the dispatcher on both frame
    // types. Presence-guarded: a frame that carries no phase must not stamp one.
    const job = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'what are you doing' } });
    await waitFor(() => stubs.generateVideo.mock.calls.length === 1);
    await waitFor(() => mediaJobQueue.getJob(job.jobId)?.status === 'running');

    const frames = [];
    expect(mediaJobQueue.attachSseClient(job.jobId, {
      writeHead: () => {},
      write: (msg) => {
        for (const line of msg.split('\n')) {
          if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)));
        }
      },
      end: () => {},
      req: { on: () => {} },
    })).toBe(true);

    videoGenEvents.emit('status', {
      generationId: job.jobId, message: 'Loading the FastVideo pipeline · 2m45s elapsed', phase: 'load-pipeline',
    });
    await waitFor(() => frames.some((f) => f.type === 'status' && f.phase === 'load-pipeline'));

    videoGenEvents.emit('progress', { generationId: job.jobId, progress: 0.25, phase: 'sampling' });
    await waitFor(() => frames.some((f) => f.type === 'progress' && f.phase === 'sampling'));

    videoGenEvents.emit('status', { generationId: job.jobId, message: 'no phase here' });
    await waitFor(() => frames.some((f) => f.message === 'no phase here'));
    expect('phase' in frames.find((f) => f.message === 'no phase here')).toBe(false);

    videoGenEvents.emit('completed', { generationId: job.jobId, filename: `${job.jobId}.mp4` });
    await waitFor(() => mediaJobQueue.getJob(job.jobId)?.status === 'completed');
  });

  it('persists chained segment receipts and replay seeds under the authoritative queue parent across restart', async () => {
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'video', params: {
      modelId: 'example-mlx', chunks: 3, executionQueueJobId: 'untrusted-parent',
      segmentSeeds: [100, 101, 102], segmentSeedBase: null,
    } });
    await waitFor(() => stubs.generateChainedVideo.mock.calls.length === 1);
    expect(stubs.generateChainedVideo.mock.calls[0][0].executionQueueJobId).toBe(jobId);
    const { recordVideoExecution, recordVideoExecutionDiagnostics } = await import('../videoGen/executionRecorder.js');
    const meta = { modelId: 'example-mlx', width: 320, height: 192, numFrames: 25, fps: 24, steps: 9,
      sourceImagePath: '/private/example.png' };
    for (const segmentIndex of [0, 1]) {
      const executionParent = { jobId, segmentIndex, segmentCount: 3 };
      await recordVideoExecution(`example-child-${segmentIndex}`, { ...meta, seed: 100 + segmentIndex, executionParent });
      await recordVideoExecutionDiagnostics(`example-child-${segmentIndex}`, { termination: {
        exitCode: 0, signal: null, reason: 'completed', observedAt: new Date().toISOString(),
      } }, executionParent);
    }
    await recordVideoExecution('example-child-0', { ...meta, seed: 100,
      executionParent: { jobId, segmentIndex: 0, segmentCount: 3 } });
    const persisted = () => JSON.parse(readFileSync(join(tempDataDir, 'media-jobs.json'), 'utf8')).jobs.find(job => job.id === jobId);
    expect(persisted()).toMatchObject({ params: { segmentSeeds: [100, 101, 102], segmentSeedBase: null },
      videoExecutions: [
        { childJobId: 'example-child-0', segmentIndex: 0, seed: 100, parameters: { steps: 9 }, diagnostics: { termination: { reason: 'completed' } } },
        { childJobId: 'example-child-1', segmentIndex: 1, seed: 101, parameters: { steps: 9 } },
      ] });
    expect(persisted().params).not.toHaveProperty('seed');
    expect(JSON.stringify(persisted().videoExecutions)).not.toContain('/private');
    videoGenEvents.emit('failed', { generationId: jobId, error: 'Synthetic third-segment refusal' });
    await waitFor(() => mediaJobQueue.getJob(jobId)?.status === 'failed');
    await importFresh();
    await mediaJobQueue.initMediaJobQueue();
    expect(mediaJobQueue.getJob(jobId)).toMatchObject({ status: 'failed',
      params: { segmentSeeds: [100, 101, 102], segmentSeedBase: null }, videoExecutions: persisted().videoExecutions });
  });

  it('uses the same bounded queued segment count for dispatch and durable receipt admission', async () => {
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'video', params: { modelId: 'example-mlx', chunks: 99 } });
    await waitFor(() => stubs.generateChainedVideo.mock.calls.length === 1);
    expect(stubs.generateChainedVideo.mock.calls[0][0]).toMatchObject({ chunks: 8, executionQueueJobId: jobId });
    await expect(mediaJobQueue.recordVideoExecution('example-bounded-child', {
      modelId: 'example-mlx', seed: 7, width: 320, height: 192, numFrames: 25, fps: 24, steps: 9,
      executionParent: { jobId, segmentIndex: 0, segmentCount: 8 },
    })).resolves.toBe(true);
    videoGenEvents.emit('failed', { generationId: jobId, error: 'Synthetic interruption' });
    await waitFor(() => mediaJobQueue.getJob(jobId)?.status === 'failed');
  });

  it.each([
    [undefined, 12345, null, [12345, null]],
    [null, 12345, null, [12345, null]],
    ['', 12345, null, [12345, null]],
    ['40', 40, 40, [40, 41]],
  ])('normalizes retry seed base %s consistently with the chain renderer', async (requestedSeed, resolvedSeed, expectedBase, expectedSeeds) => {
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'video', params: {
      modelId: 'example-mlx', chunks: 2, seed: requestedSeed, segmentSeeds: [40, 41], segmentSeedBase: 40,
    } });
    await waitFor(() => stubs.generateChainedVideo.mock.calls.length === 1);
    await mediaJobQueue.recordVideoExecution('example-cleared-seed-child', {
      modelId: 'example-mlx', seed: resolvedSeed, width: 320, height: 192, numFrames: 25, fps: 24, steps: 9,
      executionParent: { jobId, segmentIndex: 0, segmentCount: 2 },
    });
    expect(mediaJobQueue.getJob(jobId).params).toMatchObject({ segmentSeeds: expectedSeeds, segmentSeedBase: expectedBase });
    videoGenEvents.emit('failed', { generationId: jobId, error: 'Synthetic interruption' });
    await waitFor(() => mediaJobQueue.getJob(jobId)?.status === 'failed');
  });

  it('retains late chained segment cancellation evidence without changing siblings or reviving the parent', async () => {
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'video', params: { modelId: 'example-mlx', chunks: 2, seed: 40 } });
    await waitFor(() => stubs.generateChainedVideo.mock.calls.length === 1);
    const { recordVideoExecution, recordVideoExecutionDiagnostics } = await import('../videoGen/executionRecorder.js');
    const meta = { modelId: 'example-mlx', width: 320, height: 192, numFrames: 25, fps: 24, steps: 9 };
    const first = { jobId, segmentIndex: 0, segmentCount: 2 };
    const second = { jobId, segmentIndex: 1, segmentCount: 2 };
    await recordVideoExecution('example-child-0', { ...meta, seed: 100, executionParent: first });
    await recordVideoExecutionDiagnostics('example-child-0', { termination: {
      exitCode: 0, signal: null, reason: 'completed', observedAt: new Date().toISOString(),
    } }, first);
    stubs.cancelVideo.mockReturnValue(true);
    await mediaJobQueue.cancelJob(jobId);
    videoGenEvents.emit('failed', { generationId: jobId, error: 'Canceled during segment preparation' });
    await waitFor(() => mediaJobQueue.getJob(jobId)?.status === 'canceled');
    await expect(recordVideoExecution('example-child-0', { ...meta, seed: 100, executionParent: second })).rejects.toThrow('Segment receipts must be unique');
    await recordVideoExecution('example-child-1', { ...meta, seed: 101, executionParent: second });
    await recordVideoExecutionDiagnostics('example-child-1', { termination: {
      exitCode: null, signal: 'SIGTERM', reason: 'canceled', observedAt: new Date().toISOString(),
    } }, second);
    expect(await recordVideoExecutionDiagnostics('unrelated-child', { memory: { peakRssBytes: 4096 } }, second)).toBe(false);
    await expect(recordVideoExecution('replacement-child', { ...meta, seed: 101, executionParent: second }))
      .rejects.toThrow('different seed or child');
    await expect(recordVideoExecution('example-child-1', { ...meta, seed: 999, executionParent: second }))
      .rejects.toThrow('different seed or child');
    expect(mediaJobQueue.getJob(jobId)).toMatchObject({ status: 'canceled',
      params: { seed: 40, segmentSeeds: [100, 101], segmentSeedBase: 40 }, videoExecutions: [
        { childJobId: 'example-child-0', diagnostics: { termination: { reason: 'completed' } } },
        { childJobId: 'example-child-1', diagnostics: { termination: { reason: 'canceled', signal: 'SIGTERM' } } },
      ] });
    expect(stubs.generateChainedVideo).toHaveBeenCalledTimes(1);
  });

  it('refuses a missing queued segment parent and receipt persistence failure before launch', async () => {
    const meta = { modelId: 'example-mlx', seed: 7, width: 320, height: 192, numFrames: 25, fps: 24, steps: 9 };
    await expect(mediaJobQueue.recordVideoExecution('unknown-direct-job', meta)).resolves.toBe(false);
    await expect(mediaJobQueue.recordVideoExecution('example-child', { ...meta,
      executionParent: { jobId: 'missing-queue-job', segmentIndex: 0, segmentCount: 2 },
    })).rejects.toThrow('no matching local parent');
    const { recordVideoExecution, setVideoExecutionRecorder } = await import('../videoGen/executionRecorder.js');
    setVideoExecutionRecorder(null);
    await expect(recordVideoExecution('unknown-direct-job', meta)).resolves.toBe(false);
    await expect(recordVideoExecution('example-child', { ...meta,
      executionParent: { jobId: 'missing-queue-job', segmentIndex: 0, segmentCount: 2 },
    })).rejects.toThrow('recorder is unavailable');
    // enqueueJob installs the real queue adapter again before dispatch.
    const realWrite = atomicWriteSpy.getMockImplementation();
    let rejectReceipt = true;
    atomicWriteSpy.mockImplementation(async (file, data, ...args) => {
      if (rejectReceipt && data.jobs?.some(job => job.videoExecutions?.length)) {
        rejectReceipt = false;
        throw new Error('Synthetic segment receipt write refusal');
      }
      return realWrite(file, data, ...args);
    });
    const launch = vi.fn();
    stubs.generateChainedVideo.mockImplementation(async ({ executionQueueJobId }) => {
      await recordVideoExecution('example-child', { ...meta,
        executionParent: { jobId: executionQueueJobId, segmentIndex: 0, segmentCount: 2 },
      });
      launch();
    });
    try {
      const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'video', params: { modelId: 'example-mlx', chunks: 2 } });
      await waitFor(() => mediaJobQueue.getJob(jobId)?.status === 'failed');
      expect(launch).not.toHaveBeenCalled();
      expect(mediaJobQueue.getJob(jobId).error).toContain('Synthetic segment receipt write refusal');
    } finally {
      atomicWriteSpy.mockImplementation(realWrite);
    }
  });

  it('retains resolved execution seeds and bounded termination evidence across failure, cancellation and restart', async () => {
    const ids = [];
    const meta = { seed: 123456, modelId: 'example-mlx', width: 768, height: 768, numFrames: 141, fps: 24, steps: 9, mode: 'fflf' };
    const { recordVideoExecution, recordVideoExecutionDiagnostics } = await import('../videoGen/executionRecorder.js');
    for (const reason of ['failed', 'canceled']) {
      const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'video', params: { modelId: 'example-mlx', prompt: 'Synthetic action' } });
      ids.push(jobId);
      await waitFor(() => stubs.generateVideo.mock.calls.some(([params]) => params.jobId === jobId));
      await recordVideoExecution(jobId, meta);
      const savedBeforeExit = JSON.parse(readFileSync(join(tempDataDir, 'media-jobs.json'), 'utf8')).jobs.find(j => j.id === jobId);
      expect(savedBeforeExit).toMatchObject({ params: { seed: meta.seed }, videoExecution: { seed: meta.seed, parameters: { numFrames: 141 } } });
      await recordVideoExecutionDiagnostics(jobId, { memory: { peakAllocatedBytes: 4096, allocatorApplied: true } });
      if (reason === 'canceled') {
        stubs.cancelVideo.mockReturnValue(true);
        await mediaJobQueue.cancelJob(jobId);
      }
      await recordVideoExecutionDiagnostics(jobId, { memory: { peakAllocatedBytes: 2048 }, termination: {
        exitCode: null, signal: reason === 'failed' ? 'SIGKILL' : 'SIGTERM', reason, observedAt: new Date().toISOString(),
      } });
      videoGenEvents.emit('failed', { generationId: jobId, error: reason === 'failed' ? 'Process killed' : 'Canceled while running' });
      await waitFor(() => mediaJobQueue.getJob(jobId)?.status === reason);
    }
    await importFresh();
    await mediaJobQueue.initMediaJobQueue();
    for (const id of ids) {
      expect(mediaJobQueue.getJob(id)).toMatchObject({ params: { seed: meta.seed }, videoExecution: {
        seed: meta.seed, diagnostics: { memory: { peakAllocatedBytes: 4096 }, termination: { exitCode: null } },
      } });
    }
    expect(mediaJobQueue.getJob(ids[0]).videoExecution.diagnostics.termination).toMatchObject({ signal: 'SIGKILL', reason: 'failed' });
  });

  it('durably retains a first seed resolved after cancellation without reviving the canceled job', async () => {
    let resolveMetadata;
    const metadataReady = new Promise(resolve => { resolveMetadata = resolve; });
    const { recordVideoExecution } = await import('../videoGen/executionRecorder.js');
    const meta = { seed: 765432, modelId: 'example-mlx', width: 768, height: 768, numFrames: 141, fps: 24, steps: 9 };
    stubs.generateVideo.mockImplementation(async ({ jobId }) => {
      await metadataReady;
      await recordVideoExecution(jobId, meta);
    });
    stubs.cancelVideo.mockReturnValue(true);
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'video', params: { modelId: 'example-mlx' } });
    await waitFor(() => stubs.generateVideo.mock.calls.length === 1);
    await mediaJobQueue.cancelJob(jobId);
    videoGenEvents.emit('failed', { generationId: jobId, error: 'Canceled while resolving metadata' });
    await waitFor(() => mediaJobQueue.getJob(jobId)?.status === 'canceled');
    expect(mediaJobQueue.getJob(jobId)).not.toHaveProperty('videoExecution');
    resolveMetadata();
    await waitFor(() => JSON.parse(readFileSync(join(tempDataDir, 'media-jobs.json'), 'utf8')).jobs
      .some(job => job.id === jobId && job.status === 'canceled' && job.videoExecution?.seed === meta.seed));
    await expect(recordVideoExecution(jobId, { ...meta, seed: meta.seed + 1 })).rejects.toThrow('different seed');
    await importFresh();
    await mediaJobQueue.initMediaJobQueue();
    expect(mediaJobQueue.getJob(jobId)).toMatchObject({ status: 'canceled', params: { seed: meta.seed }, videoExecution: { seed: meta.seed } });
    expect(stubs.generateVideo).toHaveBeenCalledTimes(1);
  });

  it('retains one combined memory and signal receipt when terminal settlement recovers a diagnostic write failure', async () => {
    const { recordVideoExecution, recordVideoExecutionDiagnostics } = await import('../videoGen/executionRecorder.js');
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'video', params: { modelId: 'example-mlx' } });
    await waitFor(() => stubs.generateVideo.mock.calls.some(([params]) => params.jobId === jobId));
    await recordVideoExecution(jobId, { seed: 37, modelId: 'example-mlx', width: 768, height: 768, numFrames: 141, fps: 24, steps: 9 });
    const realWrite = atomicWriteSpy.getMockImplementation();
    let rejectDiagnostic = true;
    atomicWriteSpy.mockImplementation(async (file, data, ...args) => {
      if (rejectDiagnostic && data.jobs?.some(job => job.id === jobId && job.videoExecution?.diagnostics?.termination)) {
        rejectDiagnostic = false;
        throw new Error('synthetic final evidence disk failure');
      }
      return realWrite(file, data, ...args);
    });
    try {
      await expect(recordVideoExecutionDiagnostics(jobId, {
        memory: { peakAllocatedBytes: 4096 },
        termination: { exitCode: null, signal: 'SIGKILL', reason: 'failed', observedAt: new Date().toISOString() },
      })).rejects.toThrow('synthetic final evidence disk failure');
      videoGenEvents.emit('failed', { generationId: jobId, error: 'Process killed' });
      await waitFor(() => mediaJobQueue.getJob(jobId)?.status === 'failed');
      await importFresh();
      await mediaJobQueue.initMediaJobQueue();
      expect(mediaJobQueue.getJob(jobId)).toMatchObject({ status: 'failed', videoExecution: {
        diagnostics: { memory: { peakAllocatedBytes: 4096 }, termination: { signal: 'SIGKILL', reason: 'failed' } },
      } });
    } finally {
      atomicWriteSpy.mockImplementation(realWrite);
    }
  });

  it('rejects a pre-launch receipt storage failure before the provider can launch its child', async () => {
    const realWrite = atomicWriteSpy.getMockImplementation();
    let rejectReceipt = true;
    atomicWriteSpy.mockImplementation(async (file, data, ...args) => {
      if (rejectReceipt && data.jobs?.some(j => j.status === 'running' && j.videoExecution)) {
        rejectReceipt = false;
        throw Object.assign(new Error('synthetic receipt disk failure'), { code: 'EACCES' });
      }
      return realWrite(file, data, ...args);
    });
    const launched = vi.fn();
    stubs.generateVideo.mockImplementation(async ({ jobId }) => {
      const { recordVideoExecution } = await import('../videoGen/executionRecorder.js');
      await recordVideoExecution(jobId, { seed: 7, modelId: 'example-mlx', width: 768, height: 768, numFrames: 141, fps: 24, steps: 9 });
      launched();
    });
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'video', params: { modelId: 'example-mlx' } });
    await waitFor(() => mediaJobQueue.getJob(jobId)?.status === 'failed');
    expect(launched).not.toHaveBeenCalled();
    expect(mediaJobQueue.getJob(jobId).error).toContain('synthetic receipt disk failure');
    atomicWriteSpy.mockImplementation(realWrite);
  });

  it('debounce-persists live progress before a terminal transition', async () => {
    const file = join(tempDataDir, 'media-jobs.json');
    const job = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'restart snapshot' } });
    await waitFor(() => stubs.generateVideo.mock.calls.length === 1);

    // Use a message synthesizeMessage() could NOT produce (it would emit
    // "Rendering step 37/100" from step/totalSteps) so this pins the
    // explicit-message passthrough, not the synthesized fallback.
    videoGenEvents.emit('progress', {
      generationId: job.jobId,
      progress: 0.37,
      step: 37,
      totalSteps: 100,
      message: 'Rendering step 37/100 (upscaling)',
    });

    await waitFor(() => {
      const data = JSON.parse(readFileSync(file, 'utf-8'));
      const persisted = data.jobs.find((j) => j.id === job.jobId);
      return persisted?.status === 'running'
        && persisted.progress === 0.37
        && persisted.statusMsg === 'Rendering step 37/100 (upscaling)';
    }, { timeoutMs: 2000 });

    videoGenEvents.emit('completed', { generationId: job.jobId, filename: `${job.jobId}.mp4` });
    await waitFor(() => mediaJobQueue.getJob(job.jobId).status === 'completed');
  });

  it('debounce coalesces a burst of progress events into a single persist write', async () => {
    // Companion to the snapshot test above: that one proves the *value*
    // reaches disk; this one proves the debounce, by counting writes. Without
    // it the test above would still pass if scheduleProgressPersist regressed
    // to a naive per-event persist() — the high-frequency-write antipattern
    // AGENTS.md forbids. We pin the coalescing by counting atomicWrite calls
    // under a burst of N progress events (must be ≪ N within one window).
    const file = join(tempDataDir, 'media-jobs.json');
    const job = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'burst' } });
    await waitFor(() => stubs.generateVideo.mock.calls.length === 1);

    // Let the enqueue + 'running'-transition writes land first, then zero the
    // counter so we measure only the progress burst. Waiting on the persisted
    // 'running' status guarantees both prior writes have flushed.
    await waitFor(() => {
      if (!existsSync(file)) return false;
      const persisted = JSON.parse(readFileSync(file, 'utf-8')).jobs.find((j) => j.id === job.jobId);
      return persisted?.status === 'running';
    });
    atomicWriteSpy.mockClear();

    // Fire a tight synchronous burst. emit() is synchronous, so all N handlers
    // run in one tick: the first arms the 250ms debounce timer, the rest only
    // mark the buffer dirty. A regression to per-event persist() would turn
    // this into N atomicWrite calls instead of one debounced flush.
    const BURST = 12;
    for (let i = 1; i <= BURST; i++) {
      videoGenEvents.emit('progress', {
        generationId: job.jobId,
        progress: i / BURST,
        message: `Rendering step ${i}/${BURST}`,
      });
    }

    // Wait for the debounce flush to land the LAST burst value — proves at
    // least one progress write happened (so the bound below is non-vacuous).
    await waitFor(() => {
      const persisted = JSON.parse(readFileSync(file, 'utf-8')).jobs.find((j) => j.id === job.jobId);
      return persisted?.statusMsg === `Rendering step ${BURST}/${BURST}`;
    }, { timeoutMs: 2000 });

    // The "value landed" wait above is NOT a safe count checkpoint on its own:
    // job.statusMsg is mutated to the final "12/12" synchronously during the
    // burst, so a naive per-event persist() regression would write the final
    // value on its FIRST chained flush while the other 11 are still draining —
    // counting here could read 1 and pass vacuously. So settle first: hold
    // until the write count stops climbing across a quiet window. The single
    // debounced flush stabilizes at 1; a per-event regression keeps climbing
    // to ≈ BURST and only then stabilizes, so the bound below catches it.
    let prevCount = -1;
    await waitFor(() => {
      const c = atomicWriteSpy.mock.calls.length;
      const settled = c > 0 && c === prevCount;
      prevCount = c;
      return settled;
    }, { intervalMs: 60, timeoutMs: 2000 });

    // One debounce window ⇒ one flush (allow tiny slack for a trailing
    // reschedule). The naive-per-event regression would settle at ≈ BURST (12).
    expect(atomicWriteSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(atomicWriteSpy.mock.calls.length).toBeLessThanOrEqual(2);

    videoGenEvents.emit('completed', { generationId: job.jobId, filename: `${job.jobId}.mp4` });
    await waitFor(() => mediaJobQueue.getJob(job.jobId).status === 'completed');
  });

  it('reports a failed debounced progress write to stderr with the job id', async () => {
    const job = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'progress persistence failure' } });
    await waitFor(() => stubs.generateVideo.mock.calls.length === 1);
    await waitFor(() => mediaJobQueue.getJob(job.jobId)?.status === 'running');
    const realWrite = atomicWriteSpy.getMockImplementation();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    atomicWriteSpy.mockImplementation(async (path, data) => {
      if (data?.jobs?.some((entry) => entry.id === job.jobId && entry.progress === 0.25)) throw new Error('synthetic progress disk failure');
      return realWrite(path, data);
    });
    try {
      videoGenEvents.emit('progress', { generationId: job.jobId, progress: 0.25, message: 'working' });
      await waitFor(() => errorLog.mock.calls.some(([message]) => String(message).includes('persist on progress failed')));
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining(`[${job.jobId.slice(0, 8)}] mediaJobQueue persist on progress failed: synthetic progress disk failure`));
      expect(mediaJobQueue.getJob(job.jobId)).toMatchObject({ status: 'running', progress: 0.25 });
    } finally {
      atomicWriteSpy.mockImplementation(realWrite);
      errorLog.mockRestore();
    }
  });

  it('refuses a canceled suffix repair at provider dispatch without paying again', async () => {
    const { assertPerformanceRepairDispatch } = await import('../musicVideo/revisionService.js');
    assertPerformanceRepairDispatch.mockRejectedValueOnce(new Error('This repair revision is canceled'));
    const job = await mediaJobQueue.enqueueJob({ kind: 'video', params: {
      prompt: 'Example continuation', musicVideo: { projectId: 'example-project', sceneId: 'example-suffix', revisionId: 'example-revision' },
      shotInstruction: { repair: { role: 'continuation' } },
    } });
    await waitFor(() => mediaJobQueue.getJob(job.jobId).status === 'failed');
    expect(stubs.generateVideo).not.toHaveBeenCalled();
  });

  it('cancels during dispatch validation without invoking the provider and cleans staged uploads', async () => {
    const { assertVideoAttemptDispatch } = await import('../creativeDirector/videoExecution.js');
    let releaseDispatch;
    let enteredDispatch;
    const entered = new Promise((resolve) => { enteredDispatch = resolve; });
    const gate = new Promise((resolve) => { releaseDispatch = resolve; });
    assertVideoAttemptDispatch.mockImplementationOnce(() => {
      enteredDispatch();
      return gate;
    });
    const uploads = join(tempDataDir, 'uploads');
    mkdirSync(uploads, { recursive: true });
    const uploadedTempPath = join(uploads, 'example-frame.png');
    const audioFilePath = join(uploads, 'example-audio.wav');
    const extraPath = join(uploads, 'example-extra.png');
    for (const path of [uploadedTempPath, audioFilePath, extraPath]) writeFileSync(path, 'staged');
    const job = await mediaJobQueue.enqueueJob({ kind: 'video', params: {
      prompt: 'cancel before dispatch', uploadedTempPath, audioFilePath,
      uploadedTempPaths: [extraPath],
      videoProduction: { projectId: 'example-project', attemptId: 'example-attempt' },
    } });
    await entered;
    stubs.cancelVideo.mockReturnValueOnce(false);
    try {
      await expect(mediaJobQueue.cancelJob(job.jobId)).resolves.toEqual({ ok: true, status: 'canceling' });
    } finally {
      releaseDispatch();
    }
    await waitFor(() => mediaJobQueue.getJob(job.jobId).status === 'canceled');
    expect(stubs.generateVideo).not.toHaveBeenCalled();
    expect(stubs.generateChainedVideo).not.toHaveBeenCalled();
    for (const path of [uploadedTempPath, audioFilePath, extraPath]) expect(existsSync(path)).toBe(false);
  });

  it('accepts cancellation while a cloud provider is preparing before started', async () => {
    let finishPreparation;
    stubs.generateVideoGrok.mockImplementationOnce(({ jobId }) => new Promise(resolve => {
      finishPreparation = () => {
        videoGenEvents.emit('failed', { generationId: jobId, error: 'Canceled' });
        resolve({ jobId });
      };
    }));
    const job = await mediaJobQueue.enqueueJob({ kind: 'video', params: { mode: 'grok', prompt: 'preparing render' } });
    await waitFor(() => typeof finishPreparation === 'function');
    stubs.cancelVideo.mockReturnValueOnce('pending');
    try {
      await expect(mediaJobQueue.cancelJob(job.jobId)).resolves.toEqual({ ok: true, status: 'canceling' });
    } finally {
      finishPreparation();
    }
    await waitFor(() => mediaJobQueue.getJob(job.jobId).status === 'canceled');
  });

  it('restores cancellation bookkeeping when a provider refuses during finalization', async () => {
    const job = await mediaJobQueue.enqueueJob({ kind: 'video', params: {
      mode: 'grok', prompt: 'finishing render', videoProduction: { submissionUncertain: false },
    } });
    await waitFor(() => stubs.generateVideoGrok.mock.calls.length === 1);
    stubs.cancelVideo.mockReturnValueOnce(false);
    const result = await mediaJobQueue.cancelJob(job.jobId);
    expect(result).toMatchObject({ ok: false, code: 'ALREADY_TERMINAL', error: 'Job is already finishing' });
    expect(mediaJobQueue.getJob(job.jobId).cancelRequested).toBeFalsy();
    expect(mediaJobQueue.getJob(job.jobId).params.videoProduction.submissionUncertain).toBe(false);
    const snapshotFile = join(tempDataDir, 'media-jobs.json');
    await waitFor(() => JSON.parse(readFileSync(snapshotFile, 'utf8')).jobs
      .some((entry) => entry.id === job.jobId && entry.status === 'running'));
    const persisted = JSON.parse(readFileSync(snapshotFile, 'utf8')).jobs.find((entry) => entry.id === job.jobId);
    expect(persisted.params.videoProduction.submissionUncertain).toBe(false);
    videoGenEvents.emit('failed', { generationId: job.jobId, error: 'History write failed' });
    await waitFor(() => mediaJobQueue.getJob(job.jobId).status === 'failed');
    expect(mediaJobQueue.getJob(job.jobId).error).toBe('History write failed');
  });

  it.each([true, undefined, 'pending'])('preserves accepted, pending or legacy cancellation results (%s)', async (accepted) => {
    const job = await mediaJobQueue.enqueueJob({ kind: 'video', params: { mode: 'grok', prompt: 'cancel render', videoProduction: { projectId: 'example-project', attemptId: 'example-attempt' } } });
    await waitFor(() => stubs.generateVideoGrok.mock.calls.length === 1);
    stubs.cancelVideo.mockImplementationOnce(() => {
      videoGenEvents.emit('failed', { generationId: job.jobId, error: 'Stopped' });
      return accepted;
    });
    await expect(mediaJobQueue.cancelJob(job.jobId)).resolves.toMatchObject({ ok: true, status: 'canceling' });
    await waitFor(() => mediaJobQueue.getJob(job.jobId).status === 'canceled');
    const { settleVideoAttempt } = await import('../creativeDirector/videoExecution.js');
    await waitFor(() => settleVideoAttempt.mock.calls.length === 1);
    expect(settleVideoAttempt).toHaveBeenCalledWith('example-project', 'example-attempt', { jobId: job.jobId, status: 'uncertain' });
  });

  it('refuses cancellation when completion starts during provider resolution', async () => {
    const job = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'import race' } });
    await waitFor(() => stubs.generateVideo.mock.calls.length === 1);

    // cancelJob passes its first guard synchronously and yields at the dynamic
    // import. Complete before that promise resumes to exercise the second guard.
    const cancellation = mediaJobQueue.cancelJob(job.jobId);
    videoGenEvents.emit('completed', { generationId: job.jobId, filename: 'example.mp4' });

    await expect(cancellation).resolves.toMatchObject({
      ok: false, code: 'ALREADY_TERMINAL', error: 'Job is already finishing',
    });
    expect(stubs.cancelVideo).not.toHaveBeenCalled();
    expect(mediaJobQueue.getJob(job.jobId).cancelRequested).toBeFalsy();
    await waitFor(() => mediaJobQueue.getJob(job.jobId).status === 'completed');
  });

  it('cancel during the terminal drain window is refused, not "canceling"', async () => {
    const job = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'finishing race' } });
    await waitFor(() => stubs.generateVideo.mock.calls.length === 1);

    // Dirty the debounce so terminate() must actually drain (the widened
    // async window this guards). emit() is synchronous: the 'completed'
    // handler runs terminate(), which sets job.terminating synchronously and
    // then parks on the async drain with job.status still 'running'.
    videoGenEvents.emit('progress', { generationId: job.jobId, progress: 0.9, message: 'Almost done' });
    videoGenEvents.emit('completed', { generationId: job.jobId, filename: `${job.jobId}.mp4` });

    // A cancel landing in that window must be refused (the outcome is already
    // decided) rather than reported as 'canceling', and must not fire a
    // redundant provider cancel. cancelJob's guard returns synchronously
    // before any await, so no microtask flips the status first.
    const result = await mediaJobQueue.cancelJob(job.jobId);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('ALREADY_TERMINAL');
    expect(stubs.cancelVideo).not.toHaveBeenCalled();

    await waitFor(() => mediaJobQueue.getJob(job.jobId).status === 'completed');
  });

  it('holds restored Video production submissions before any worker can spend', async () => {
    const jobs = ['queued', 'running'].map((status, index) => ({ id: `00000000-0000-4000-8000-00000000000${index + 1}`,
      kind: 'video', status, queuedAt: '2026-04-30T10:00:00.000Z',
      params: { videoProduction: { projectId: 'example-video', attemptId: `example-attempt-${index}` } } }));
    writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify({ jobs }));
    await importFresh();
    await mediaJobQueue.initMediaJobQueue();
    expect(mediaJobQueue.getJob(jobs[0].id)).toMatchObject({ status: 'failed', params: { videoProduction: { submissionUncertain: false } } });
    expect(mediaJobQueue.getJob(jobs[1].id)).toMatchObject({ status: 'failed', params: { videoProduction: { submissionUncertain: true } } });
    expect(stubs.generateVideo).not.toHaveBeenCalled();
    expect(stubs.generateVideoRemote).not.toHaveBeenCalled();
  });

  it('boot recovery: persisted "running" jobs are reclassified as failed', async () => {
    const interruptedId = '00000000-0000-4000-8000-000000000001';
    const persisted = {
      jobs: [
        {
          id: interruptedId,
          kind: 'video',
          status: 'running',
          queuedAt: '2026-04-30T10:00:00.000Z',
          startedAt: '2026-04-30T10:00:01.000Z',
          params: {},
        },
      ],
    };
    writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify(persisted, null, 2));

    await importFresh();
    await mediaJobQueue.initMediaJobQueue();

    const recovered = mediaJobQueue.getJob(interruptedId);
    expect(recovered).toBeTruthy();
    expect(recovered.status).toBe('failed');
    expect(recovered.error).toMatch(/interrupted by restart/);
  });

  it('boot recovery (#8977): an interrupted paid fal performance render is failed, never resubmitted, and its song slice released', async () => {
    const interruptedId = '00000000-0000-4000-8000-000000000003';
    const slice = join(tempDataDir, 'uploads', 'mv-performance-example.wav');
    mkdirSync(join(tempDataDir, 'uploads'), { recursive: true });
    writeFileSync(slice, 'wav');
    writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify({
      jobs: [{
        id: interruptedId, kind: 'video', status: 'running',
        queuedAt: '2026-04-30T10:00:00.000Z', startedAt: '2026-04-30T10:00:01.000Z',
        params: {
          mode: 'fal', videoMode: 'image', prompt: 'singer', audioFilePath: slice,
          musicVideo: { projectId: 'mv-1', sceneId: 'mvs-1' },
          shotInstruction: { version: 1, shotMode: 'performance', edit: { inSec: 1, outSec: 2 } },
        },
      }],
    }));

    await importFresh();
    await mediaJobQueue.initMediaJobQueue();

    expect(mediaJobQueue.getJob(interruptedId)).toMatchObject({ status: 'failed', error: expect.stringMatching(/interrupted by restart/) });
    await waitFor(() => !existsSync(slice));
    expect(stubs.generateVideoFal).not.toHaveBeenCalled();
  });

  it('boot recovery (#1332): a "running" training job whose trainer survived is re-enqueued for re-attach', async () => {
    const runId = 'run-survivor-1';
    const trainingId = '00000000-0000-4000-8000-000000000010';
    const persisted = {
      jobs: [{
        id: trainingId, kind: 'training', status: 'running',
        queuedAt: '2026-04-30T10:00:00.000Z', startedAt: '2026-04-30T10:00:01.000Z',
        params: { runId },
      }],
    };
    writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify(persisted, null, 2));

    await importFresh();
    stubs.hasSurvivingTrainer.mockResolvedValue(true); // trainer is still alive
    await mediaJobQueue.initMediaJobQueue();

    // The reconcile consulted the probe with the run id.
    expect(stubs.hasSurvivingTrainer).toHaveBeenCalledWith(runId);
    // The worker resumes it via runTraining flagged reattach:true (NOT failed) —
    // the same job id so SSE clients keyed off it still resolve.
    await waitFor(() => stubs.runTraining.mock.calls.length === 1);
    expect(stubs.runTraining).toHaveBeenCalledWith(expect.objectContaining({
      jobId: trainingId, runId, reattach: true,
    }));
    // It occupies the GPU lane as a running job rather than being archived failed.
    const job = mediaJobQueue.getJob(trainingId);
    expect(job.status).toBe('running');
    expect(job.error).toBeUndefined();
  });

  it('boot recovery (#1332): a "running" training job with no surviving trainer is failed as before', async () => {
    const runId = 'run-dead-1';
    const trainingId = '00000000-0000-4000-8000-000000000011';
    const persisted = {
      jobs: [{
        id: trainingId, kind: 'training', status: 'running',
        queuedAt: '2026-04-30T10:00:00.000Z', startedAt: '2026-04-30T10:00:01.000Z',
        params: { runId },
      }],
    };
    writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify(persisted, null, 2));

    await importFresh();
    stubs.hasSurvivingTrainer.mockResolvedValue(false); // trainer did not survive
    await mediaJobQueue.initMediaJobQueue();

    expect(stubs.hasSurvivingTrainer).toHaveBeenCalledWith(runId);
    const job = mediaJobQueue.getJob(trainingId);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/interrupted by restart/);
    expect(stubs.runTraining).not.toHaveBeenCalled();
  });

  it('boot recovery: persisted "queued" jobs are re-enqueued for the worker', async () => {
    const queuedId = '00000000-0000-4000-8000-000000000002';
    const persisted = {
      jobs: [
        {
          id: queuedId,
          kind: 'video',
          status: 'queued',
          queuedAt: '2026-04-30T10:00:00.000Z',
          params: { prompt: 'restart-me' },
        },
      ],
    };
    writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify(persisted, null, 2));

    await importFresh();
    await mediaJobQueue.initMediaJobQueue();

    // Worker should pick the recovered job and call generateVideo with the
    // original jobId so SSE clients keyed off it still resolve.
    await waitFor(() => stubs.generateVideo.mock.calls.length === 1);
    expect(stubs.generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      jobId: queuedId,
      prompt: 'restart-me',
    }));
  });

  it('persists state to media-jobs.json on enqueue / completion', async () => {
    const file = join(tempDataDir, 'media-jobs.json');
    const job = await mediaJobQueue.enqueueJob({ kind: 'video', params: {} });
    // Admission is durable (#8325): the acknowledged job is already on disk.
    const initial = JSON.parse(readFileSync(file, 'utf-8'));
    expect(initial.jobs.find((j) => j.id === job.jobId)).toBeTruthy();

    await waitFor(() => stubs.generateVideo.mock.calls.length === 1);
    videoGenEvents.emit('completed', { generationId: job.jobId, filename: `${job.jobId}.mp4` });
    // After completion the worker calls persist() fire-and-forget, so wait
    // for the file to actually reflect the new status before asserting.
    await waitFor(() => {
      const data = JSON.parse(readFileSync(file, 'utf-8'));
      const j = data.jobs.find((x) => x.id === job.jobId);
      return j?.status === 'completed';
    });
  });

  it('failed gen events propagate to job status', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const progressLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const job = await mediaJobQueue.enqueueJob({ kind: 'image', params: { prompt: 'hi' } });
    await waitFor(() => stubs.generateImage.mock.calls.length === 1);
    imageGenEvents.emit('failed', { generationId: job.jobId, error: 'OOM' });
    await waitFor(() => mediaJobQueue.getJob(job.jobId).status === 'failed');

    const failed = mediaJobQueue.getJob(job.jobId);
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('OOM');
    const summary = `media-job [${job.jobId.slice(0, 8)}] failed: OOM`;
    expect(errorLog.mock.calls.filter(([message]) => String(message).includes(summary))).toHaveLength(1);
    expect(progressLog).not.toHaveBeenCalledWith(expect.stringContaining(summary));
  });

  it('pre-gen sanitizer nulls uploadedTempPath that resolves outside PATHS.uploads', async () => {
    // Any path that is not under the uploads root should be nulled out so the
    // gen module never sees it (defense-in-depth against corrupted job params).
    const job = await mediaJobQueue.enqueueJob({
      kind: 'video',
      params: { prompt: 'x', uploadedTempPath: '/etc/passwd' },
    });
    await waitFor(() => stubs.generateVideo.mock.calls.length === 1);
    const callArgs = stubs.generateVideo.mock.calls[0][0];
    // The gen module must receive a nulled path, not the original dangerous one.
    expect(callArgs.uploadedTempPath).toBeNull();

    videoGenEvents.emit('completed', { generationId: job.jobId, filename: `${job.jobId}.mp4` });
    await waitFor(() => mediaJobQueue.getJob(job.jobId).status === 'completed');
  });

  it('keeps maintenance and the lane owned after watchdog cancellation until provider teardown settles', async () => {
    vi.useFakeTimers();
    process.env.MEDIA_JOB_WATCHDOG_VIDEO_MS = '50';
    await importFresh();
    const { maintenance } = await import('../../lib/maintenanceAdmission.js');
    // A real local provider returns its job id after spawn, before child exit.
    stubs.generateVideo.mockResolvedValue({ jobId: 'provider-started' });
    const job = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'hang' } });
    let hold;
    try {
      await vi.waitFor(() => expect(stubs.generateVideo).toHaveBeenCalledTimes(1), { interval: 1 });
      ({ hold } = maintenance.begin({ reason: 'Wait for physical teardown', owner: 'Operator' }));
      await vi.advanceTimersByTimeAsync(100);
      await flush();
      await vi.waitFor(() => expect(stubs.cancelVideo).toHaveBeenCalledTimes(1));
      await flush();
      expect(mediaJobQueue.getJob(job.jobId)).toMatchObject({ status: 'failed', error: expect.stringMatching(/watchdog timeout/) });
      expect(maintenance.status()).toMatchObject({ state: 'draining', blockers: [expect.objectContaining({ resource: job.jobId })] });
      expect(mediaJobQueue.getQueueCapacity().lanes.gpu.running).toBe(1);

      // A cancel acknowledgment/time passing is no proof of exit or cleanup.
      await vi.advanceTimersByTimeAsync(8000);
      expect(maintenance.status().state).toBe('draining');
      videoGenEvents.emit('failed', { generationId: job.jobId, error: 'Child closed and cleanup finished' });
      await flush();
      await vi.waitFor(() => expect(maintenance.status().state).toBe('ready'));
      expect(mediaJobQueue.getQueueCapacity().lanes.gpu.running).toBe(0);
      expect(stubs.generateVideo).toHaveBeenCalledTimes(1);
    } finally {
      videoGenEvents.emit('failed', { generationId: job.jobId, error: 'Fixture teardown' });
      await flush();
      if (hold) maintenance.resume({ id: hold.id, revision: hold.revision });
      delete process.env.MEDIA_JOB_WATCHDOG_VIDEO_MS;
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('does not start a provider after its watchdog wins during asynchronous dispatch checks', async () => {
    vi.useFakeTimers();
    process.env.MEDIA_JOB_WATCHDOG_VIDEO_MS = '50';
    await importFresh();
    const { maintenance } = await import('../../lib/maintenanceAdmission.js');
    const { assertVideoAttemptDispatch } = await import('../creativeDirector/videoExecution.js');
    const dispatchCheck = Promise.withResolvers();
    let checkEntered = false;
    assertVideoAttemptDispatch.mockImplementationOnce(() => {
      checkEntered = true;
      return dispatchCheck.promise;
    });
    const job = await mediaJobQueue.enqueueJob({ kind: 'video', params: {
      prompt: 'delayed dispatch', videoProduction: { projectId: 'example', attemptId: 'example-attempt' },
    } });
    let hold;
    const ready = Promise.withResolvers();
    const onMaintenanceChanged = status => {
      if (status.state === 'ready') ready.resolve();
    };
    maintenance.events.on('changed', onMaintenanceChanged);
    try {
      await vi.waitFor(() => expect(checkEntered).toBe(true), { interval: 1 });
      ({ hold } = maintenance.begin({ reason: 'Drain pending preparation', owner: 'Operator' }));
      await vi.advanceTimersByTimeAsync(100);
      await vi.waitFor(() => expect(mediaJobQueue.getJob(job.jobId).status).toBe('failed'));
      expect(maintenance.status().state).toBe('draining');
      dispatchCheck.resolve();
      // Finalization performs real file I/O; await its actual readiness signal
      // instead of a wall-clock poll that also advances the fake flush deadline.
      await ready.promise;
      expect(maintenance.status().state).toBe('ready');
      expect(stubs.generateVideo).not.toHaveBeenCalled();
      expect(mediaJobQueue.getQueueCapacity().lanes.gpu.running).toBe(0);
    } finally {
      maintenance.events.off('changed', onMaintenanceChanged);
      dispatchCheck.resolve();
      await flush();
      if (hold) maintenance.resume({ id: hold.id, revision: hold.revision });
      delete process.env.MEDIA_JOB_WATCHDOG_VIDEO_MS;
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('terminal handlers are idempotent: watchdog then gen emit causes only one mediaJobEvents.failed', async () => {
    // Short watchdog so we can trigger it quickly in tests.
    process.env.MEDIA_JOB_WATCHDOG_VIDEO_MS = '50';
    await importFresh();

    // generateVideo hangs so watchdog fires first.
    stubs.generateVideo.mockImplementation(() => new Promise(() => {}));

    const failedEmits = [];
    const completedEmits = [];
    mediaJobQueue.mediaJobEvents.on('failed', (j) => failedEmits.push(j.id));
    mediaJobQueue.mediaJobEvents.on('completed', (j) => completedEmits.push(j.id));

    const job = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'double-terminal' } });
    await waitFor(() => stubs.generateVideo.mock.calls.length === 1);

    // Let the watchdog fire and confirm the job lands as failed.
    await waitFor(() => mediaJobQueue.getJob(job.jobId)?.status === 'failed', { timeoutMs: 2000 });
    expect(failedEmits).toHaveLength(1);

    // Now the underlying gen (late) emits completed — must be a no-op.
    videoGenEvents.emit('completed', { generationId: job.jobId, filename: `${job.jobId}.mp4` });
    await flush();

    // Still only one failed emit, zero completed emits, status unchanged.
    expect(failedEmits).toHaveLength(1);
    expect(completedEmits).toHaveLength(0);
    expect(mediaJobQueue.getJob(job.jobId).status).toBe('failed');

    delete process.env.MEDIA_JOB_WATCHDOG_VIDEO_MS;
  });

  // Regression: a client that reconnects to /:jobId/events for a queued job
  // recovered from media-jobs.json (or one that never had an SSE entry for
  // any reason) must NOT receive a synthetic terminal `error` frame just
  // because no SSE entry exists yet. The fix pre-seeds an entry on boot and
  // attachSseClient creates one on the fly for live (queued/running) jobs.
  it('attachSseClient on a recovered queued job seeds an SSE entry instead of terminating', async () => {
    // Block the worker so the recovered queued job stays queued for the
    // duration of the test (we want to assert the queued-attach path, not
    // the running-attach path).
    stubs.generateVideo.mockImplementation(() => new Promise(() => {}));
    const queuedId = '00000000-0000-4000-8000-000000000003';
    const persisted = {
      jobs: [
        {
          id: queuedId,
          kind: 'video',
          status: 'queued',
          queuedAt: '2026-04-30T10:00:00.000Z',
          params: { prompt: 'hi' },
        },
      ],
    };
    writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify(persisted, null, 2));
    await importFresh();
    await mediaJobQueue.initMediaJobQueue();

    // Fake response that captures writeHead/write/end calls so we can assert
    // the route did NOT short-circuit with a terminal `error` frame. `req.on`
    // is required by lib/sseUtils.js#attachSseClient (it wires a 'close'
    // listener to clean up the client list).
    const writes = [];
    const fakeRes = {
      writeHead: vi.fn(),
      write: vi.fn((s) => writes.push(s)),
      end: vi.fn(),
      req: { on: vi.fn() },
    };
    const ok = mediaJobQueue.attachSseClient(queuedId, fakeRes);
    expect(ok).toBe(true);
    // The seeded payload is `queued`, OR `started` if the worker raced ahead
    // and picked the job before we attached. Either way is a valid replay of
    // real lifecycle state — the regression we're guarding against is the
    // pre-fix path that terminated the response with .end() and emitted no
    // payload at all.
    const written = writes.join('');
    expect(written).toMatch(/"type":"(queued|started)"/);
    expect(written).not.toMatch(/"type":"error"/);
    expect(fakeRes.end).not.toHaveBeenCalled();
  });

  it('non-string uploadedTempPath (number) on a persisted job does not throw on enqueue', async () => {
    const jobId = '00000000-0000-4000-8000-000000000010';
    const persisted = {
      jobs: [
        {
          id: jobId,
          kind: 'video',
          status: 'queued',
          queuedAt: '2026-04-30T10:00:00.000Z',
          params: { prompt: 'corrupted', uploadedTempPath: 12345 },
        },
      ],
    };
    writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify(persisted, null, 2));
    await importFresh();
    await expect(mediaJobQueue.initMediaJobQueue()).resolves.not.toThrow();
    // Worker should call generateVideo with uploadedTempPath nulled out (sanitizer fired).
    await waitFor(() => stubs.generateVideo.mock.calls.length === 1);
    const callArgs = stubs.generateVideo.mock.calls[0][0];
    expect(callArgs.uploadedTempPath).toBeNull();
    videoGenEvents.emit('completed', { generationId: jobId, filename: `${jobId}.mp4` });
    await waitFor(() => mediaJobQueue.getJob(jobId)?.status === 'completed');
  });

  it('non-string uploadedTempPath (object) on a persisted job does not throw on enqueue', async () => {
    const jobId = '00000000-0000-4000-8000-000000000011';
    const persisted = {
      jobs: [
        {
          id: jobId,
          kind: 'video',
          status: 'queued',
          queuedAt: '2026-04-30T10:00:00.000Z',
          params: { prompt: 'corrupted', uploadedTempPath: { evil: true } },
        },
      ],
    };
    writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify(persisted, null, 2));
    await importFresh();
    await expect(mediaJobQueue.initMediaJobQueue()).resolves.not.toThrow();
    await waitFor(() => stubs.generateVideo.mock.calls.length === 1);
    const callArgs = stubs.generateVideo.mock.calls[0][0];
    expect(callArgs.uploadedTempPath).toBeNull();
    videoGenEvents.emit('completed', { generationId: jobId, filename: `${jobId}.mp4` });
    await waitFor(() => mediaJobQueue.getJob(jobId)?.status === 'completed');
  });

  it('watchdog falls back to default when env var is non-numeric (does not fire immediately)', async () => {
    // setTimeout(NaN) effectively fires synchronously, which would fail every
    // job at boot. Confirm the parser rejects non-numeric strings and falls
    // back to the default — by checking the job is still 'running' shortly
    // after enqueue, despite the deliberately bogus env var.
    process.env.MEDIA_JOB_WATCHDOG_VIDEO_MS = 'not-a-number';
    await importFresh();
    stubs.generateVideo.mockImplementation(() => new Promise(() => {})); // hang forever

    const job = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'guard' } });
    await waitFor(() => stubs.generateVideo.mock.calls.length === 1);

    // Wait a beat — long enough that a NaN-driven watchdog would have fired.
    await new Promise((r) => setTimeout(r, 100));
    expect(mediaJobQueue.getJob(job.jobId)?.status).toBe('running');

    delete process.env.MEDIA_JOB_WATCHDOG_VIDEO_MS;
  });
});

describe('Audio kind (#1928)', () => {
  it('holds new peer dispatch while an admitted remote render settles locally', async () => {
    const { maintenance } = await import('../../lib/maintenanceAdmission.js');
    let reconcileRemote;
    stubs.generateAudioRemote.mockImplementationOnce(() => new Promise(resolve => { reconcileRemote = resolve; }));
    const active = await mediaJobQueue.enqueueJob({ kind: 'audio', params: { remoteMedia: remoteMediaParams() } });
    await waitFor(() => stubs.generateAudioRemote.mock.calls.length === 1);
    const { hold } = maintenance.begin({ reason: 'Peer drain', owner: 'Operator' });
    try {
      const queued = await mediaJobQueue.enqueueJob({ kind: 'audio', params: { remoteMedia: remoteMediaParams() } });
      audioGenEvents.emit('completed', { generationId: active.jobId, filename: `${active.jobId}.wav` });
      await waitFor(() => mediaJobQueue.getJob(active.jobId)?.status === 'completed');
      expect(maintenance.status().state).toBe('draining');
      expect(stubs.generateAudioRemote).toHaveBeenCalledTimes(1);
      reconcileRemote();
      await waitFor(() => !maintenance.status().blockers.some(blocker => blocker.resource === active.jobId));
      expect(mediaJobQueue.getJob(queued.jobId).status).toBe('queued');
    } finally { maintenance.resume({ id: hold.id, revision: hold.revision }); }
  });

  it('dispatches an audio job to audioGen/local.js#generateAudio and completes', async () => {
    const job = await mediaJobQueue.enqueueJob({
      kind: 'audio',
      params: { prompt: 'a moody synth bed', engine: 'musicgen' },
    });
    await waitFor(() => stubs.generateAudio.mock.calls.length === 1);

    expect(stubs.generateAudio).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: job.jobId, prompt: 'a moody synth bed', engine: 'musicgen' }),
    );
    // Audio shares the GPU lane (no parallel codex-style lane) — the other
    // gen modules must not have been invoked.
    expect(stubs.generateVideo).not.toHaveBeenCalled();
    expect(stubs.generateImage).not.toHaveBeenCalled();
    expect(stubs.generateAudioRemote).not.toHaveBeenCalled();

    audioGenEvents.emit('completed', { generationId: job.jobId, filename: `${job.jobId}.wav`, durationSec: 12 });
    await waitFor(() => mediaJobQueue.getJob(job.jobId)?.status === 'completed');

    const settled = mediaJobQueue.getJob(job.jobId);
    expect(settled.result).toEqual({ generationId: job.jobId, filename: `${job.jobId}.wav`, durationSec: 12 });
  });

  it('serializes jobs per peer while distinct peers and local GPU run together, releasing the peer after cancellation', async () => {
    stubs.generateVideo.mockImplementation(() => new Promise(() => {}));
    const finish = new Map();
    stubs.generateVideoRemote.mockImplementation(({ jobId }) => new Promise((resolve) => finish.set(jobId, resolve)));
    const submit = (peerId) => mediaJobQueue.enqueueJob({ kind: 'video', params: { remoteMedia: { ...remoteVideoMediaParams(), peerId } } });
    const local = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'local' } });
    const first = await submit('11111111-1111-4111-8111-111111111111');
    const second = await submit('11111111-1111-4111-8111-111111111111');
    const other = await submit('22222222-2222-4222-8222-222222222222');
    await waitFor(() => mediaJobQueue.getJob(other.jobId)?.status === 'running');
    expect(mediaJobQueue.getJob(local.jobId).status).toBe('running');
    expect(mediaJobQueue.getJob(first.jobId).status).toBe('running');
    expect(mediaJobQueue.getJob(second.jobId).status).toBe('queued');
    await mediaJobQueue.cancelJob(first.jobId);
    videoGenEvents.emit('failed', { generationId: first.jobId, error: 'Canceled', remoteInputsDisposable: true });
    finish.get(first.jobId)();
    await waitFor(() => mediaJobQueue.getJob(second.jobId)?.status === 'running');
  });

  it('runs remote audio in its own lane without occupying the local GPU', async () => {
    stubs.generateVideo.mockImplementation(() => new Promise(() => {}));
    stubs.generateAudioRemote.mockImplementation(() => new Promise(() => {}));

    const video = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'local render' } });
    const remote = await mediaJobQueue.enqueueJob({
      kind: 'audio',
      params: {
        prompt: '',
        engine: 'remote-audio',
        modelId: 'example/model',
        remoteMedia: remoteMediaParams(),
      },
    });

    await waitFor(() => stubs.generateVideo.mock.calls.length === 1
      && stubs.generateAudioRemote.mock.calls.length === 1);
    expect(stubs.generateAudio).not.toHaveBeenCalled();
    expect(mediaJobQueue.getJob(video.jobId).status).toBe('running');
    expect(mediaJobQueue.getJob(remote.jobId).status).toBe('running');

    audioGenEvents.emit('completed', { generationId: remote.jobId, filename: `${remote.jobId}.wav` });
    videoGenEvents.emit('failed', { generationId: video.jobId, error: 'cleanup' });
    await waitFor(() => mediaJobQueue.getJob(remote.jobId)?.status === 'completed');
  });

  // #4683 — the downgrade contract is enforced HERE, not at each routed enqueue
  // site, so a future caller that forgets to blank the local render fields can't
  // ship a job a build rolled back past `remoteMedia` would render for real.
  it('normalizes any enqueued job carrying a marker into the downgrade-safe shape', async () => {
    stubs.generateImageRemote.mockImplementation(() => new Promise(() => {}));
    // Deliberately hostile input: a caller that passed the local render fields
    // straight through, exactly as a forgotten normalization would.
    const remote = await mediaJobQueue.enqueueJob({
      kind: 'image',
      params: {
        prompt: 'a harbour',
        modelId: 'dev',
        pythonPath: '/usr/bin/python3',
        width: 512,
        remoteMedia: remoteImageMediaParams(),
      },
    });

    const { params } = mediaJobQueue.getJob(remote.jobId);
    expect(params.prompt).toBe('');
    expect(params.modelId).toBeNull();
    expect(params.pythonPath).toBeNull();
    // Surviving job params and the marker itself ride through untouched, and
    // the job still routes to the remote adapter on this build.
    expect(params.width).toBe(512);
    expect(params.remoteMedia.request.prompt).toBe('a harbour');
    await waitFor(() => stubs.generateImageRemote.mock.calls.length === 1);
    expect(stubs.generateImage).not.toHaveBeenCalled();
  });

  it('re-normalizes a routed job restored from a snapshot an older build wrote', async () => {
    // Boot restoration is the second way a job enters the queue. A record
    // persisted before #4683 still carries the top-level model id a legacy
    // dispatcher would render from, so upgrading and then rolling back would
    // otherwise resurrect a locally-renderable job.
    writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify({
      jobs: [
        {
          id: 'aaaaaaaa-0000-4000-8000-000000000001',
          kind: 'image',
          status: 'queued',
          queuedAt: '2026-08-01T00:00:00.000Z',
          params: {
            prompt: 'a harbour', modelId: 'dev', pythonPath: '/usr/bin/python3',
            remoteMedia: remoteImageMediaParams(),
          },
        },
        {
          id: 'aaaaaaaa-0000-4000-8000-000000000002',
          kind: 'image',
          status: 'running',
          queuedAt: '2026-08-01T00:00:00.000Z',
          params: {
            prompt: 'a harbour', modelId: 'dev', pythonPath: '/usr/bin/python3',
            remoteMedia: remoteImageMediaParams(),
          },
        },
      ],
    }));
    stubs.generateImageRemote.mockImplementation(() => new Promise(() => {}));
    await importFresh();
    await mediaJobQueue.initMediaJobQueue();

    for (const id of ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002']) {
      const { params } = mediaJobQueue.getJob(id);
      expect(params.prompt).toBe('');
      expect(params.modelId).toBeNull();
      expect(params.pythonPath).toBeNull();
      expect(params.remoteMedia.request.prompt).toBe('a harbour');
    }
    // The interrupted running job still gets its reconcile flag.
    expect(mediaJobQueue.getJob('aaaaaaaa-0000-4000-8000-000000000002').params.remoteMedia.reconcile).toBe(true);
  });

  it('re-normalizes an ARCHIVED routed job too — the recent reel is a retry surface', async () => {
    // A rolled-back build restores archived rows, shows them in the Render
    // Queue's recent reel, and its Retry hands the stored params straight to a
    // local render. Leaving the archive un-normalized would keep #4683 open
    // through that path.
    writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify({
      jobs: [{
        id: 'bbbbbbbb-0000-4000-8000-000000000001',
        kind: 'image',
        status: 'failed',
        error: 'peer unreachable',
        queuedAt: new Date(Date.now() - 60_000).toISOString(),
        // Inside the archive's 24h retention window, or the boot prune drops it.
        completedAt: new Date().toISOString(),
        params: {
          prompt: 'a harbour', modelId: 'dev', pythonPath: '/usr/bin/python3',
          remoteMedia: remoteImageMediaParams(),
        },
      }],
    }));
    await importFresh();
    await mediaJobQueue.initMediaJobQueue();

    const { params, status } = mediaJobQueue.getJob('bbbbbbbb-0000-4000-8000-000000000001');
    expect(status).toBe('failed');
    expect(params.prompt).toBe('');
    expect(params.modelId).toBeNull();
    expect(params.pythonPath).toBeNull();
    expect(params.remoteMedia.request.prompt).toBe('a harbour');
  });

  it('rejects media admission during retired-data removal and permits it after settlement', async () => {
    const { withRetiredDataRemoval } = await import('../../lib/retiredLoraTraining.js');
    await withRetiredDataRemoval(async () => {
      await expect(mediaJobQueue.enqueueJob({ kind: 'image', params: {} })).rejects.toMatchObject({ status: 409, code: 'DATA_MAINTENANCE_ACTIVE' });
    });
    const accepted = await mediaJobQueue.enqueueJob({ kind: 'image', params: {} });
    expect(accepted.jobId).toBeTruthy();
  });

  it('retires persisted queued training without invoking a trainer or removing artifacts', async () => {
    const id = '00000000-0000-4000-8000-000000000019';
    writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify({ jobs: [{ id, kind: 'training', status: 'queued', params: { runId: 'example-retired' } }] }));
    await importFresh();
    await mediaJobQueue.initMediaJobQueue();
    expect(mediaJobQueue.getJob(id)).toMatchObject({ status: 'canceled', error: expect.stringContaining('retired') });
    expect(stubs.runTraining).not.toHaveBeenCalled();
  });

  it('refuses retired training even when carrying a stray remote marker', async () => {
    await expect(mediaJobQueue.enqueueJob({ kind: 'training', params: { runId: 'example', remoteMedia: remoteImageMediaParams() } })).rejects.toMatchObject({ status: 410, code: 'LORA_TRAINING_RETIRED' });
  });

  it('persists cancellation intent before signaling a running remote adapter', async () => {
    stubs.generateAudioRemote.mockImplementation(() => new Promise(() => {}));
    const remote = await mediaJobQueue.enqueueJob({
      kind: 'audio',
      params: {
        prompt: '',
        remoteMedia: remoteMediaParams(),
      },
    });
    await waitFor(() => stubs.generateAudioRemote.mock.calls.length === 1);

    await expect(mediaJobQueue.cancelJob(remote.jobId)).resolves.toMatchObject({ ok: true, status: 'canceling' });
    expect(stubs.cancelAudioRemote).toHaveBeenCalledWith(remote.jobId);
    expect(mediaJobQueue.getJob(remote.jobId).params.remoteMedia.cancelRequested).toBe(true);

    audioGenEvents.emit('failed', { generationId: remote.jobId, error: 'canceled remotely' });
    await waitFor(() => mediaJobQueue.getJob(remote.jobId)?.status === 'canceled');
  });

  it('re-enqueues a persisted running remote job with reconciliation enabled', async () => {
    const id = '00000000-0000-4000-8000-000000000002';
    writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify({
      jobs: [{
        id,
        kind: 'audio',
        owner: null,
        status: 'running',
        queuedAt: '2026-08-17T12:00:00.000Z',
        startedAt: '2026-08-17T12:00:01.000Z',
        params: {
          prompt: '',
          engine: 'remote-audio',
          modelId: 'example/model',
          remoteMedia: remoteMediaParams(),
        },
      }],
    }));
    stubs.generateAudioRemote.mockImplementation(() => new Promise(() => {}));

    await mediaJobQueue.initMediaJobQueue();
    await waitFor(() => stubs.generateAudioRemote.mock.calls.length === 1);

    expect(stubs.generateAudioRemote).toHaveBeenCalledWith(expect.objectContaining({
      jobId: id,
      remoteMedia: expect.objectContaining({ reconcile: true }),
    }));
    audioGenEvents.emit('completed', { generationId: id, filename: `${id}.wav` });
    await waitFor(() => mediaJobQueue.getJob(id)?.status === 'completed');
  });

  it.each([{ mediaMode: 'code-only' }, null])('recovers an already-submitted remote cancellation after project policy changes: %j', async project => {
    const { getProject } = await import('../musicVideo/projects.js');
    getProject.mockResolvedValueOnce(project);
    const id = '00000000-0000-4000-8000-000000000003';
    writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify({ jobs: [{
      id, kind: 'video', status: 'running', queuedAt: new Date().toISOString(),
      params: { musicVideo: { projectId: 'mv-example', sceneId: 'scene-example' },
        remoteMedia: { ...remoteVideoMediaParams(), cancelRequested: true } },
    }] }));
    stubs.generateVideoRemote.mockImplementation(async params => {
      videoGenEvents.emit('failed', { generationId: params.jobId, error: 'Canceled remotely' });
    });
    await mediaJobQueue.initMediaJobQueue();
    await waitFor(() => mediaJobQueue.getJob(id)?.status === 'canceled');
    expect(stubs.generateVideoRemote).toHaveBeenCalledWith(expect.objectContaining({
      jobId: id, remoteMedia: expect.objectContaining({ reconcile: true, cancelRequested: true }),
    }));
    expect(stubs.generateVideo).not.toHaveBeenCalled();
    // A newly submitted request still passes admission policy, even if it
    // carries a forged cancellation/reconciliation marker.
    await expect(mediaJobQueue.enqueueJob({ kind: 'video', params: {
      musicVideo: { projectId: 'mv-example' }, remoteMedia: { ...remoteVideoMediaParams(), reconcile: true, cancelRequested: true },
    } })).rejects.toThrow();
  });


  it('routes an image remote job to the remote adapter and the remote lane, not the GPU', async () => {
    stubs.generateImage.mockImplementation(() => new Promise(() => {}));
    stubs.generateImageRemote.mockImplementation(() => new Promise(() => {}));

    // A local image render occupies the single GPU slot; the federated one must
    // still start, because it renders on the peer's hardware.
    const local = await mediaJobQueue.enqueueJob({ kind: 'image', params: { prompt: 'local render' } });
    const remote = await mediaJobQueue.enqueueJob({
      kind: 'image',
      params: { prompt: '', modelId: 'dev', remoteMedia: remoteImageMediaParams() },
    });

    await waitFor(() => stubs.generateImage.mock.calls.length === 1
      && stubs.generateImageRemote.mock.calls.length === 1);
    expect(mediaJobQueue.getJob(local.jobId).status).toBe('running');
    expect(mediaJobQueue.getJob(remote.jobId).status).toBe('running');
    // The local adapter must never see the federated job — it would re-render
    // it here and spend this machine's GPU on work already queued on the peer.
    expect(stubs.generateImage).not.toHaveBeenCalledWith(
      expect.objectContaining({ jobId: remote.jobId }),
    );

    imageGenEvents.emit('completed', { generationId: remote.jobId, filename: `${remote.jobId}.png` });
    imageGenEvents.emit('failed', { generationId: local.jobId, error: 'cleanup' });
    await waitFor(() => mediaJobQueue.getJob(remote.jobId)?.status === 'completed');
  });

  it('runs local and federated video renders in parallel lanes', async () => {
    stubs.generateVideo.mockImplementation(() => new Promise(() => {}));
    stubs.generateVideoRemote.mockImplementation(() => new Promise(() => {}));

    const local = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'local render' } });
    const remote = await mediaJobQueue.enqueueJob({
      kind: 'video',
      params: { prompt: '', modelId: null, remoteMedia: remoteVideoMediaParams() },
    });

    await waitFor(() => stubs.generateVideo.mock.calls.length === 1
      && stubs.generateVideoRemote.mock.calls.length === 1);

    expect(mediaJobQueue.getJob(local.jobId).status).toBe('running');
    expect(mediaJobQueue.getJob(remote.jobId).status).toBe('running');
    expect(stubs.generateVideo).not.toHaveBeenCalledWith(
      expect.objectContaining({ jobId: remote.jobId }),
    );
    expect(mediaJobQueue.getQueueCapacity().lanes).toMatchObject({
      gpu: { running: 1, queued: 0 },
      remote: { running: 1, queued: 0 },
    });

    videoGenEvents.emit('failed', { generationId: local.jobId, error: 'cleanup' });
    videoGenEvents.emit('failed', { generationId: remote.jobId, error: 'cleanup' });
    await waitFor(() => mediaJobQueue.getJob(local.jobId)?.status === 'failed'
      && mediaJobQueue.getJob(remote.jobId)?.status === 'failed');
  });

  it('re-enqueues a persisted running remote VIDEO job with reconciliation enabled', async () => {
    const id = '00000000-0000-4000-8000-000000000003';
    writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify({
      jobs: [{
        id,
        kind: 'video',
        owner: null,
        status: 'running',
        queuedAt: '2026-08-19T12:00:00.000Z',
        startedAt: '2026-08-19T12:00:01.000Z',
        params: { prompt: '', modelId: 'ltx2', remoteMedia: remoteVideoMediaParams() },
      }],
    }));
    stubs.generateVideoRemote.mockImplementation(() => new Promise(() => {}));

    await mediaJobQueue.initMediaJobQueue();
    await waitFor(() => stubs.generateVideoRemote.mock.calls.length === 1);

    expect(stubs.generateVideoRemote).toHaveBeenCalledWith(expect.objectContaining({
      jobId: id,
      remoteMedia: expect.objectContaining({ reconcile: true }),
    }));
    expect(stubs.generateVideo).not.toHaveBeenCalled();
    videoGenEvents.emit('completed', { generationId: id, filename: `${id}.mp4` });
    await waitFor(() => mediaJobQueue.getJob(id)?.status === 'completed');
  });

  // cancelJob's dispatch-by-kind (mod.cancel(jobId)) is exercised generically
  // by the Codex lane's cancel test below via the same getGenModuleForJob
  // mechanism; audioGen/local.js#cancel's own behavior (aborting the in-flight
  // generateMusic signal) is unit-tested directly in audioGen/local.test.js.
});

describe('Codex lane', () => {
  it.each([
    { name: 'releases before the shutdown deadline', timeout: false },
    { name: 'releases after the shutdown deadline', timeout: true },
    { name: 'preserves independently marked uncertainty', timeout: true, uncertain: true },
    { name: 'preserves a failed final write', timeout: true, fail: true },
  ])('owns a completed lane until persistence settles: $name', async ({ timeout, uncertain, fail }) => {
    let providerEntered;
    const started = new Promise(resolve => { providerEntered = resolve; });
    stubs.generateImageCodex.mockImplementation(async () => { providerEntered(); return {}; });
    await mediaJobQueue.initMediaJobQueue();
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'image', params: { prompt: 'Gated settlement', mode: 'codex' } });
    await started;
    mediaJobQueue.quiesceMediaJobQueue();
    await mediaJobQueue.__drainForTests();
    const { maintenance } = await import('../../lib/maintenanceAdmission.js');
    const write = atomicWriteSpy.getMockImplementation();
    let release;
    let gateEntered;
    const gate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { gateEntered = resolve; });
    let completed = false;
    let writesAfterCompletion = 0;
    const observe = job => { if (job.id === jobId) completed = true; };
    mediaJobQueue.mediaJobEvents.on('completed', observe);
    atomicWriteSpy.mockImplementation(async (...args) => {
      // The first post-publication write archives the lane. The next write is
      // the final flush, reached only after that archive snapshot is durable.
      if (completed && ++writesAfterCompletion === 2) {
        gateEntered();
        await gate;
        if (fail) throw new Error('Synthetic final write failure');
      }
      return write(...args);
    });
    vi.useFakeTimers();
    try {
      imageGenEvents.emit('completed', { generationId: jobId, filename: 'synthetic.png' });
      await entered;
      expect(persistedJobs().find(job => job.id === jobId).status).toBe('completed');
      const shutdownFlush = mediaJobQueue.flushMediaJobQueue();
      if (timeout) {
        await vi.advanceTimersByTimeAsync(mediaJobQueue.MEDIA_QUEUE_FLUSH_TIMEOUT_MS + 1);
        await expect(shutdownFlush).resolves.toMatchObject({ ok: false, timedOut: true });
      }
      // The write still belongs to this live lane, even after shutdown's
      // separate deadline. It is pending work, not lost/uncertain ownership.
      expect(maintenance.status().blockers).toEqual([expect.objectContaining({ resource: jobId, unsettled: undefined })]);
      if (uncertain) maintenance.recoverOwned('media', jobId).markUnsettled();
      release();
      if (!timeout) await expect(shutdownFlush).resolves.toEqual({ ok: true });
      await mediaJobQueue.__drainForTests({ settleLanes: true });
      expect(writesAfterCompletion).toBeGreaterThanOrEqual(3);
      expect(persistedJobs().find(job => job.id === jobId).status).toBe('completed');
      if (uncertain || fail) {
        expect(maintenance.status().blockers).toEqual([expect.objectContaining({ resource: jobId, unsettled: true })]);
      } else {
        expect(maintenance.status().blockers).toEqual([]);
      }
    } finally {
      release();
      atomicWriteSpy.mockImplementation(write);
      mediaJobQueue.mediaJobEvents.off('completed', observe);
      vi.useRealTimers();
    }
  });

  it('runs more than ten renders while enforcing the saved limit and cleaning up listeners', async () => {
    // Kickoff resolves; terminal events keep each render active until completed.
    let enteredTwelve;
    let enteredThirteen;
    const firstBatchEntered = new Promise(resolve => { enteredTwelve = resolve; });
    const replacementEntered = new Promise(resolve => { enteredThirteen = resolve; });
    let entered = 0;
    stubs.generateImageCodex.mockImplementation(async () => {
      entered += 1;
      if (entered === 12) enteredTwelve();
      if (entered === 13) enteredThirteen();
      return {};
    });
    await mediaJobQueue.initMediaJobQueue();
    mediaJobQueue.setCodexParallelLimit(12);
    const events = ['progress', 'status', 'completed', 'failed'];
    const listenerCounts = () => events.map((event) => imageGenEvents.listenerCount(event));
    const before = listenerCounts();
    const jobs = [];
    for (let i = 0; i < 13; i++) {
      jobs.push(await mediaJobQueue.enqueueJob({
        kind: 'image', params: { prompt: `Example render ${i}`, mode: 'codex' },
      }));
    }
    await firstBatchEntered;
    expect(stubs.generateImageCodex).toHaveBeenCalledTimes(12);
    expect(mediaJobQueue.getQueueCapacity().lanes.cloud.limit).toBe(12);
    expect(mediaJobQueue.getJob(jobs[12].jobId).status).toBe('queued');

    imageGenEvents.emit('completed', { generationId: jobs[0].jobId, filename: 'example.png' });
    await replacementEntered;
    expect(stubs.generateImageCodex).toHaveBeenCalledTimes(13);
    expect(persistedJobs().find(job => job.id === jobs[0].jobId).status).toBe('completed');
    for (const job of jobs.slice(1)) {
      imageGenEvents.emit('completed', { generationId: job.jobId, filename: 'example.png' });
    }
    await mediaJobQueue.__drainForTests({ settleLanes: true });
    expect(jobs.every((job) => mediaJobQueue.getJob(job.jobId).status === 'completed')).toBe(true);
    expect(listenerCounts()).toEqual(before);
    const { maintenance } = await import('../../lib/maintenanceAdmission.js');
    expect(maintenance.status().blockers).toEqual([]);
  });

  it('dispatches a Codex job to imageGen/codex.js#generateImage, not local', async () => {
    // Allow the codex job to resolve immediately so the worker can settle.
    stubs.generateImageCodex.mockResolvedValue({ jobId: 'whatever' });

    const job = await mediaJobQueue.enqueueJob({
      kind: 'image',
      params: { prompt: 'codex test', mode: 'codex' },
    });
    await waitFor(() => stubs.generateImageCodex.mock.calls.length === 1);

    expect(stubs.generateImageCodex).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: job.jobId, prompt: 'codex test', mode: 'codex' }),
    );
    // The GPU local image gen must NOT have been called.
    expect(stubs.generateImage).not.toHaveBeenCalled();

    imageGenEvents.emit('completed', { generationId: job.jobId, filename: `${job.jobId}.png` });
    await waitFor(() => mediaJobQueue.getJob(job.jobId).status === 'completed');
  });

  it('Codex job and a GPU video job run concurrently — both dispatch functions are called', async () => {
    // Both stubs hang indefinitely so neither completes before we assert.
    stubs.generateVideo.mockImplementation(() => new Promise(() => {}));
    stubs.generateImageCodex.mockImplementation(() => new Promise(() => {}));

    const videoJob = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'video' } });
    const codexJob = await mediaJobQueue.enqueueJob({
      kind: 'image',
      params: { prompt: 'codex concurrent', mode: 'codex' },
    });

    // Both dispatch functions should be called without either blocking the other.
    await waitFor(
      () => stubs.generateVideo.mock.calls.length === 1 && stubs.generateImageCodex.mock.calls.length === 1,
    );

    expect(stubs.generateVideo).toHaveBeenCalledWith(expect.objectContaining({ jobId: videoJob.jobId }));
    expect(stubs.generateImageCodex).toHaveBeenCalledWith(expect.objectContaining({ jobId: codexJob.jobId }));

    // Clean up: emit failures so the worker can settle.
    videoGenEvents.emit('failed', { generationId: videoJob.jobId, error: 'cleanup' });
    imageGenEvents.emit('failed', { generationId: codexJob.jobId, error: 'cleanup' });
    await waitFor(
      () =>
        mediaJobQueue.getJob(videoJob.jobId).status !== 'running' &&
        mediaJobQueue.getJob(codexJob.jobId).status !== 'running',
    );
  });

  it('dispatches a fal.ai image job to imageGen/fal.js on the cloud lane, beside a running GPU job', async () => {
    stubs.generateVideo.mockImplementation(() => new Promise(() => {}));
    stubs.generateImageFal.mockImplementation(() => new Promise(() => {}));

    const videoJob = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'video' } });
    const falJob = await mediaJobQueue.enqueueJob({
      kind: 'image',
      params: { prompt: 'fal plate', mode: 'fal', model: 'fal-ai/nano-banana-pro' },
    });
    // The GPU slot is taken by the video job, so the fal job can only have
    // started if it was classified onto the cloud lane.
    await waitFor(
      () => stubs.generateVideo.mock.calls.length === 1 && stubs.generateImageFal.mock.calls.length === 1,
    );
    expect(stubs.generateImageFal).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: falJob.jobId, mode: 'fal', model: 'fal-ai/nano-banana-pro' }),
    );
    expect(stubs.generateImage).not.toHaveBeenCalled();
    expect(stubs.generateImageCodex).not.toHaveBeenCalled();

    videoGenEvents.emit('failed', { generationId: videoJob.jobId, error: 'cleanup' });
    imageGenEvents.emit('failed', { generationId: falJob.jobId, error: 'cleanup' });
    await waitFor(
      () =>
        mediaJobQueue.getJob(videoJob.jobId).status !== 'running' &&
        mediaJobQueue.getJob(falJob.jobId).status !== 'running',
    );
  });

  it('queued Codex job reports position within the Codex lane (not counting GPU jobs)', async () => {
    // GPU job hangs so the GPU slot is occupied but separate from the Codex lane.
    stubs.generateVideo.mockImplementation(() => new Promise(() => {}));
    // First Codex job hangs so a second Codex job lands in the queue.
    stubs.generateImageCodex.mockImplementation(() => new Promise(() => {}));

    // Enqueue one GPU video job (occupies the GPU lane, should not affect Codex positions).
    const videoJob = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'video blocker' } });

    // First Codex job: worker picks it up immediately (codexRunning slot).
    const codex1 = await mediaJobQueue.enqueueJob({
      kind: 'image',
      params: { prompt: 'codex first', mode: 'codex' },
    });

    // Wait until the first Codex job is actually running so codexRunning is set.
    await waitFor(() => stubs.generateImageCodex.mock.calls.length === 1);

    // Second Codex job: lands in queue behind the running Codex job (position 2 in Codex lane).
    const codex2 = await mediaJobQueue.enqueueJob({
      kind: 'image',
      params: { prompt: 'codex second', mode: 'codex' },
    });

    // The second Codex job's position should be 2 (1 running Codex + 1 queue slot),
    // not inflated by the GPU video job also being in flight.
    expect(codex2.position).toBe(2);
    expect(mediaJobQueue.getJob(codex2.jobId).position).toBe(2);

    // Clean up.
    videoGenEvents.emit('failed', { generationId: videoJob.jobId, error: 'cleanup' });
    imageGenEvents.emit('failed', { generationId: codex1.jobId, error: 'cleanup' });
    imageGenEvents.emit('failed', { generationId: codex2.jobId, error: 'cleanup' });
    await flush();
  });

  it('runJobNow promotes a queued Codex job past the parallel limit', async () => {
    // Pin the codex lane at limit=1 and saturate it with a running Codex job
    // so the second one lands in the queue.
    mediaJobQueue.setCodexParallelLimit(1);
    stubs.generateImageCodex.mockImplementation(() => new Promise(() => {}));

    const codex1 = await mediaJobQueue.enqueueJob({
      kind: 'image', params: { prompt: 'codex first', mode: 'codex' },
    });
    await waitFor(() => stubs.generateImageCodex.mock.calls.length === 1);

    const codex2 = await mediaJobQueue.enqueueJob({
      kind: 'image', params: { prompt: 'codex second', mode: 'codex' },
    });
    expect(mediaJobQueue.getJob(codex2.jobId).status).toBe('queued');

    const result = mediaJobQueue.runJobNow(codex2.jobId);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('running');
    // Both Codex jobs are now in-flight (lane size 2, above the limit of 1).
    await waitFor(() => stubs.generateImageCodex.mock.calls.length === 2);
    expect(mediaJobQueue.getJob(codex2.jobId).status).toBe('running');

    imageGenEvents.emit('failed', { generationId: codex1.jobId, error: 'cleanup' });
    imageGenEvents.emit('failed', { generationId: codex2.jobId, error: 'cleanup' });
    await flush();
  });

  it('gives each cloud provider its own swim lane so a Codex backlog never holds Grok', async () => {
    mediaJobQueue.setCodexParallelLimit(1);
    stubs.generateImageCodex.mockImplementation(() => new Promise(() => {}));
    stubs.generateVideoGrok.mockImplementation(() => new Promise(() => {}));

    const codex1 = await mediaJobQueue.enqueueJob({ kind: 'image', params: { prompt: 'codex first', mode: 'codex' } });
    await waitFor(() => stubs.generateImageCodex.mock.calls.length === 1);
    const codex2 = await mediaJobQueue.enqueueJob({ kind: 'image', params: { prompt: 'codex second', mode: 'codex' } });
    expect(mediaJobQueue.getJob(codex2.jobId)).toMatchObject({ status: 'queued', position: 2 });

    const grok = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'grok', mode: IMAGE_GEN_MODE.GROK } });
    expect(grok.position).toBe(1);
    await waitFor(() => stubs.generateVideoGrok.mock.calls.length === 1);
    expect(mediaJobQueue.getJob(grok.jobId).status).toBe('running');
    expect(mediaJobQueue.getJob(codex2.jobId)).toMatchObject({ status: 'queued', position: 2 });

    imageGenEvents.emit('failed', { generationId: codex1.jobId, error: 'cleanup' });
    imageGenEvents.emit('failed', { generationId: codex2.jobId, error: 'cleanup' });
    videoGenEvents.emit('failed', { generationId: grok.jobId, error: 'cleanup' });
    await flush();
  });

  it('runJobNow rejects GPU (non-Codex) queued jobs with NOT_CODEX', async () => {
    // Block the GPU lane with one running job and queue a second so we have a
    // queued GPU job to attempt run-now on.
    stubs.generateVideo.mockImplementation(() => new Promise(() => {}));
    const v1 = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'first' } });
    await waitFor(() => stubs.generateVideo.mock.calls.length === 1);
    const v2 = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'second' } });
    expect(mediaJobQueue.getJob(v2.jobId).status).toBe('queued');

    const result = mediaJobQueue.runJobNow(v2.jobId);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('NOT_CODEX');
    // The queued GPU job stays queued — single MLX runtime can't double up.
    expect(mediaJobQueue.getJob(v2.jobId).status).toBe('queued');

    videoGenEvents.emit('failed', { generationId: v1.jobId, error: 'cleanup' });
    videoGenEvents.emit('failed', { generationId: v2.jobId, error: 'cleanup' });
    await flush();
  });

  it('runJobNow returns NOT_FOUND for an unknown id', () => {
    const result = mediaJobQueue.runJobNow('does-not-exist');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('NOT_FOUND');
  });
});

describe('audioFilePath sanitization', () => {
  it('pre-gen sanitizer nulls audioFilePath that resolves outside PATHS.uploads', async () => {
    // audioFilePath must be treated identically to uploadedTempPath: if it
    // doesn't resolve under PATHS.uploads, the gen module must never see it.
    const job = await mediaJobQueue.enqueueJob({
      kind: 'video',
      params: { prompt: 'x', audioFilePath: '/etc/shadow' },
    });
    await waitFor(() => stubs.generateVideo.mock.calls.length === 1);
    const callArgs = stubs.generateVideo.mock.calls[0][0];
    expect(callArgs.audioFilePath).toBeNull();

    videoGenEvents.emit('completed', { generationId: job.jobId, filename: `${job.jobId}.mp4` });
    await waitFor(() => mediaJobQueue.getJob(job.jobId).status === 'completed');
  });
});

describe('chunks dispatch', () => {
  it('video job with chunks > 1 calls generateChainedVideo instead of generateVideo', async () => {
    const job = await mediaJobQueue.enqueueJob({
      kind: 'video',
      params: { prompt: 'chained', chunks: 3 },
    });
    await waitFor(() => stubs.generateChainedVideo.mock.calls.length === 1);

    expect(stubs.generateChainedVideo).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: job.jobId, prompt: 'chained', chunks: 3 }),
    );
    // The single-chunk path must NOT have been called.
    expect(stubs.generateVideo).not.toHaveBeenCalled();

    videoGenEvents.emit('completed', { generationId: job.jobId, filename: `${job.jobId}.mp4` });
    await waitFor(() => mediaJobQueue.getJob(job.jobId).status === 'completed');
  });

  it('video job with chunks === 1 calls generateVideo (not generateChainedVideo)', async () => {
    const job = await mediaJobQueue.enqueueJob({
      kind: 'video',
      params: { prompt: 'single', chunks: 1 },
    });
    await waitFor(() => stubs.generateVideo.mock.calls.length === 1);

    expect(stubs.generateVideo).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: job.jobId, prompt: 'single', chunks: 1 }),
    );
    expect(stubs.generateChainedVideo).not.toHaveBeenCalled();

    videoGenEvents.emit('completed', { generationId: job.jobId, filename: `${job.jobId}.mp4` });
    await waitFor(() => mediaJobQueue.getJob(job.jobId).status === 'completed');
  });
});

describe('live pythonPath re-resolution', () => {
  it('video job spawn uses the pythonPath currently in settings, not the snapshot at enqueue', async () => {
    // Job was enqueued with a stale pythonPath (e.g. user fixed their config
    // after submission, or the persisted file from a previous session is
    // being replayed). The worker must overwrite from live settings before
    // calling generateVideo so the stale snapshot can't poison the spawn.
    writeFileSync(
      join(tempDataDir, 'settings.json'),
      JSON.stringify({ imageGen: { local: { pythonPath: '/live/path/python3' } } }),
    );
    const job = await mediaJobQueue.enqueueJob({
      kind: 'video',
      params: { prompt: 'stale-snapshot', pythonPath: '/stale/anaconda/python3' },
    });
    await waitFor(() => stubs.generateVideo.mock.calls.length === 1);
    expect(stubs.generateVideo.mock.calls[0][0].pythonPath).toBe('/live/path/python3');
    videoGenEvents.emit('completed', { generationId: job.jobId, filename: `${job.jobId}.mp4` });
    await waitFor(() => mediaJobQueue.getJob(job.jobId).status === 'completed');
  });

  it('codex image job leaves params.pythonPath untouched', async () => {
    writeFileSync(
      join(tempDataDir, 'settings.json'),
      JSON.stringify({ imageGen: { local: { pythonPath: '/live/path/python3' } } }),
    );
    const job = await mediaJobQueue.enqueueJob({
      kind: 'image',
      params: { prompt: 'codex', mode: 'codex' },
    });
    await waitFor(() => stubs.generateImageCodex.mock.calls.length === 1);
    expect(stubs.generateImageCodex.mock.calls[0][0].pythonPath).toBeUndefined();
    imageGenEvents.emit('completed', { generationId: job.jobId, filename: `${job.jobId}.png` });
    await waitFor(() => mediaJobQueue.getJob(job.jobId).status === 'completed');
  });
});

describe('cancelJob running-Codex branch', () => {
  it('canceling a running Codex job calls imageGen/codex.js#cancel, not the local cancel', async () => {
    // Codex job hangs indefinitely so it stays in 'running' for the cancel.
    stubs.generateImageCodex.mockImplementation(() => new Promise(() => {}));

    const job = await mediaJobQueue.enqueueJob({
      kind: 'image',
      params: { prompt: 'codex running cancel', mode: 'codex' },
    });

    // Wait until the Codex job is actually running (worker picked it up).
    await waitFor(() => stubs.generateImageCodex.mock.calls.length === 1);
    expect(mediaJobQueue.getJob(job.jobId).status).toBe('running');

    const result = await mediaJobQueue.cancelJob(job.jobId);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('canceling');

    // Codex cancel must have fired.
    expect(stubs.cancelImageCodex).toHaveBeenCalled();
    // The GPU/local image cancel must NOT have fired.
    expect(stubs.cancelImage).not.toHaveBeenCalled();
    expect(stubs.cancelVideo).not.toHaveBeenCalled();

    // Simulate the codex gen acknowledging the cancel with a failure event
    // so the worker settles cleanly.
    imageGenEvents.emit('failed', { generationId: job.jobId, error: 'canceled' });
    await waitFor(() => mediaJobQueue.getJob(job.jobId).status !== 'running');
  });
});

/**
 * Strict-read regression (#4115).
 *
 * `initMediaJobQueue` ends with `await persist()`, and persist() writes the
 * FULL in-memory snapshot. While the boot read swallowed unreadable files, a
 * corrupt media-jobs.json booted an empty queue and that first persist
 * atomicWrote `{"jobs":[]}` over the real snapshot — losing the archive and
 * orphaning every job the reconcile would have reattached or failed.
 *
 * Init is an AWAITED step of runPostRouteSequence, where a rejection is fatal
 * (process.exit), so the fix cannot simply throw: it boots empty, reports, and
 * latches persistence off so the file survives for recovery.
 *
 * Corrupt JSON is the portable way to produce "present but unreadable" — it
 * fails the parse identically on every platform and needs no privileges.
 */
describe('mediaJobQueue unreadable snapshot (#4115)', () => {
  const CORRUPT = '{"jobs": [{"id": "00000000-0000-4000-8000-0000000000aa",';

  it('boots without throwing, so an unreadable snapshot cannot kill the server', async () => {
    writeFileSync(join(tempDataDir, 'media-jobs.json'), CORRUPT);
    await importFresh();
    await expect(mediaJobQueue.initMediaJobQueue()).resolves.toBeUndefined();
    expect(mediaJobQueue.listJobs()).toEqual([]);
  });

  it('does NOT overwrite the unreadable file — at boot or on a later enqueue', async () => {
    const file = join(tempDataDir, 'media-jobs.json');
    writeFileSync(file, CORRUPT);
    await importFresh();
    await mediaJobQueue.initMediaJobQueue();

    // The boot persist is the first chance to clobber it.
    expect(readFileSync(file, 'utf8'), 'boot persist must be suppressed').toBe(CORRUPT);

    // …and so is every write the running queue would normally make.
    stubs.generateVideo.mockImplementation(() => new Promise(() => {}));
    await expect(mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'after a bad boot' } }))
      .rejects.toMatchObject({ status: 503, code: mediaJobQueue.MEDIA_QUEUE_PERSIST_FAILED });
    expect(stubs.generateVideo).not.toHaveBeenCalled();
    await flush();
    expect(
      readFileSync(file, 'utf8'),
      'persistence stays latched off for the process lifetime'
    ).toBe(CORRUPT);
  });

  it('a readable snapshot still persists normally (the latch is not sticky across boots)', async () => {
    const file = join(tempDataDir, 'media-jobs.json');
    writeFileSync(file, JSON.stringify({ jobs: [] }));
    await importFresh();
    await mediaJobQueue.initMediaJobQueue();

    stubs.generateVideo.mockImplementation(() => new Promise(() => {}));
    const job = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'good boot' } });
    await flush();
    const written = JSON.parse(readFileSync(file, 'utf8'));
    expect(written.jobs.map((j) => j.id)).toContain(job.jobId);
  });
});

describe('importArchivedJobs (#12782)', () => {
  const file = () => join(tempDataDir, 'media-jobs.json');
  const readJobs = () => JSON.parse(readFileSync(file(), 'utf8')).jobs;
  const OLD = '2026-01-01T00:00:00.000Z';
  const record = (n, patch = {}) => ({
    id: `00000000-0000-4000-8000-0000000000${n}`, kind: 'image', status: 'completed', completedAt: OLD,
    params: { prompt: 'a harbour', seed: 7 }, result: { filename: `${n}.png` }, ...patch,
  });

  it('makes an imported record visible without a restart and survives a later queue persist and the 24h trim', async () => {
    await mediaJobQueue.initMediaJobQueue();
    const imported = record('11');
    expect(await mediaJobQueue.importArchivedJobs([imported])).toBe(1);
    expect(mediaJobQueue.getJob(imported.id)).toMatchObject({ params: { prompt: 'a harbour', seed: 7 }, result: { filename: '11.png' } });

    // The regression: an unrelated queue mutation rewrites the file from memory
    // and trims archive rows older than 24h — the imported row must outlive both.
    stubs.generateVideo.mockImplementation(() => new Promise(() => {}));
    await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'later job' } });
    await flush();
    expect(readJobs().map((j) => j.id)).toContain(imported.id);
    expect(mediaJobQueue.getJob(imported.id)).toBeTruthy();

    await importFresh();
    await mediaJobQueue.initMediaJobQueue();
    expect(mediaJobQueue.getJob(imported.id)).toMatchObject({ imported: true, status: 'completed' });
  });

  it('keeps local rows on an id collision and refuses peer-supplied runtime state', async () => {
    writeFileSync(file(), JSON.stringify({ jobs: [record('21', { params: { prompt: 'local' }, completedAt: new Date().toISOString() })] }));
    await importFresh();
    await mediaJobQueue.initMediaJobQueue();
    const hostile = record('22', {
      params: { prompt: 'p', remotePeerReservation: true, uploadedTempPath: '/etc/passwd', initImagePath: '/etc/hosts' },
      result: { filename: '../../escape.png' },
    });
    const skipped = [record('23', { status: 'running' }), record('24', { kind: 'training' }), record('../25')];
    expect(await mediaJobQueue.importArchivedJobs([record('21', { params: { prompt: 'peer' } }), hostile, ...skipped])).toBe(1);
    expect(mediaJobQueue.getJob(record('21').id).params.prompt).toBe('local');
    const stored = mediaJobQueue.getJob(hostile.id);
    expect(stored.params).toEqual({ prompt: 'p' });
    expect(stored.result).toEqual({});
    expect(skipped.map((j) => mediaJobQueue.getJob(j.id))).toEqual([null, null, null]);
  });

  it('refuses to import into a queue whose snapshot was unreadable, leaving the file alone', async () => {
    const CORRUPT = '{"jobs": [{"id": "00000000-0000-4000-8000-0000000000aa",';
    writeFileSync(file(), CORRUPT);
    await importFresh();
    await mediaJobQueue.initMediaJobQueue();
    await expect(mediaJobQueue.importArchivedJobs([record('31')])).rejects.toThrow(/blocked/);
    expect(mediaJobQueue.getJob(record('31').id)).toBeNull();
    expect(readFileSync(file(), 'utf8')).toBe(CORRUPT);
  });
});

// Polling helper for the async settles this suite waits on (a debounced disk
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
async function waitFor(predicate, { timeoutMs = DEFAULT_WAIT_MS, intervalMs = 30 } = {}) {
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

// Regression: three terminal failures must preserve the rest of a batch,
// including its staged bytes, across reload and explicit resume.
describe('local video failure holds', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  const tick = async () => {
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(150);
    await flush();
  };
  const submit = async (modelId = 'example-mlx', extra = {}) => (await mediaJobQueue.enqueueJob({
    kind: 'video', owner: 'example-owner', params: { modelId, prompt: 'invented clip', ...extra },
  })).jobId;
  // Admission is async (#8325); submit in order so queue positions stay FIFO.
  const submitMany = async (count, make = () => submit()) => {
    const ids = [];
    for (let i = 0; i < count; i += 1) ids.push(await make());
    return ids;
  };
  const finish = async (id, error = 'RuntimeError: shader compilation failed') => {
    videoGenEvents.emit(error ? 'failed' : 'completed', { generationId: id, error });
    await flush();
  };

  it.each(['example-mlx', 'example-cuda'])('retains %s batch inputs through hold, restart and one resume', async (modelId) => {
    const upload = join(tempDataDir, 'uploads', 'example.png');
    mkdirSync(join(tempDataDir, 'uploads'));
    writeFileSync(upload, 'synthetic image');
    const ids = await submitMany(5, () => submit(modelId, { uploadedTempPath: upload, seed: 42 }));
    for (const id of ids.slice(0, 3)) {
      await tick();
      expect(mediaJobQueue.getJob(id).status).toBe('running');
      await finish(id);
      // A duplicate terminal event must never advance the streak a second time.
      await finish(id);
    }
    await tick();
    expect(stubs.generateVideo).toHaveBeenCalledTimes(3);
    const retained = ids.slice(3).map((id) => mediaJobQueue.getJob(id));
    expect(retained.map((j) => j.id)).toEqual(ids.slice(3));
    expect(retained.every((j) => j.status === 'queued' && j.hold.heldJobCount === 2)).toBe(true);
    expect(existsSync(upload)).toBe(true);
    const persisted = JSON.parse(readFileSync(join(tempDataDir, 'media-jobs.json'), 'utf8'));
    expect(persisted.videoHolds).toHaveLength(1);
    expect(persisted.videoHolds[0]).not.toHaveProperty('signature');
    expect(mediaJobQueue.isVideoModelHeld(modelId, persisted.videoHolds[0].runtime)).toBe(true);

    vi.clearAllTimers();
    await mediaJobQueue.__resetForTests();
    await importFresh();
    await mediaJobQueue.initMediaJobQueue();
    await tick();
    expect(stubs.generateVideo).toHaveBeenCalledTimes(3);
    const restored = mediaJobQueue.getJob(ids[3]);
    expect(restored).toMatchObject({ owner: 'example-owner', status: 'queued', params: { uploadedTempPath: upload, seed: 42 }, hold: { heldJobCount: 2 } });
    expect(await mediaJobQueue.resumeVideoHold(restored.hold.id)).toBe(true);
    expect(mediaJobQueue.isVideoModelHeld(modelId, persisted.videoHolds[0].runtime)).toBe(false);
    expect(await mediaJobQueue.resumeVideoHold(persisted.videoHolds[0].id)).toBe(false);
    for (const id of ids.slice(3)) { await tick(); await finish(id, null); }
    await tick();
    expect(stubs.generateVideo.mock.calls.map(([p]) => p.jobId)).toEqual(ids);
    expect(JSON.parse(readFileSync(join(tempDataDir, 'media-jobs.json'), 'utf8')).videoHolds).toEqual([]);
  });

  it('refills mixed lanes in FIFO order while skipping holds and oversubscribed cloud capacity', async () => {
    const heldBatch = await submitMany(4);
    for (const id of heldBatch.slice(0, 3)) { await tick(); await finish(id); }
    mediaJobQueue.setCodexParallelLimit(1);
    stubs.generateImageCodex.mockResolvedValue({});
    const cloudJob = async () => (await mediaJobQueue.enqueueJob({
      kind: 'image', params: { mode: 'codex', prompt: 'example cloud image' },
    })).jobId;
    let peerSequence = 0;
    const remoteJob = () => submit('example-mlx', { remoteMedia: { ...remoteVideoMediaParams(), peerId: `11111111-1111-4111-8111-${String(++peerSequence).padStart(12, '0')}` } });
    const gpu = [await submit('example-other')];
    const cloud = [await cloudJob()];
    // Concurrent dynamic imports can bypass the module mock in this test runner;
    // without this adapter stub, 19 of 20 dispatches reach the real peer lookup.
    const { REMOTE_MEDIA_MODULES } = await import('./remoteMediaJob.js');
    const remoteAdapter = vi.spyOn(REMOTE_MEDIA_MODULES, 'video').mockResolvedValue({
      generateVideo: stubs.generateVideoRemote,
    });
    const remoteLimit = mediaJobQueue.getQueueCapacity().lanes.remote.limit;
    const remote = await submitMany(remoteLimit, remoteJob);
    await tick();
    cloud.push(await cloudJob());
    expect(mediaJobQueue.runJobNow(cloud[1]).ok).toBe(true);
    await tick();

    // Interleave waiting jobs behind all three busy lanes and the held cohort.
    for (let i = 0; i < 2; i += 1) {
      cloud.push(await cloudJob());
      gpu.push(await submit('example-other'));
      remote.push(await remoteJob());
    }
    await tick();
    const occupancy = () => {
      const { lanes } = mediaJobQueue.getQueueCapacity();
      return ['gpu', 'cloud', 'remote'].map((lane) => lanes[lane].running);
    };
    expect(occupancy()).toEqual([1, 2, remoteLimit]);
    expect(mediaJobQueue.getJob(cloud[2]).status).toBe('queued');

    // Returning cloud from negative to zero slots must still refuse admission;
    // GPU and remote refill independently on the same worker pass.
    imageGenEvents.emit('completed', { generationId: cloud[0] });
    await finish(gpu[0], null);
    await finish(remote[0], null);
    await tick();
    expect(occupancy()).toEqual([1, 1, remoteLimit]);
    expect(mediaJobQueue.getJob(cloud[2]).status).toBe('queued');
    expect(mediaJobQueue.getJob(gpu[1]).status).toBe('running');
    expect(mediaJobQueue.getJob(remote[remoteLimit]).status).toBe('running');
    expect(mediaJobQueue.getJob(gpu[2]).status).toBe('queued');
    expect(mediaJobQueue.getJob(remote[remoteLimit + 1]).status).toBe('queued');

    imageGenEvents.emit('completed', { generationId: cloud[1] });
    await finish(gpu[1], null);
    await finish(remote[remoteLimit], null);
    await tick();
    expect(occupancy()).toEqual([1, 1, remoteLimit]);
    expect(mediaJobQueue.getJob(cloud[2]).status).toBe('running');
    expect(mediaJobQueue.getJob(cloud[3]).status).toBe('queued');

    // A live limit change opens the next cloud slot without restarting the worker.
    mediaJobQueue.setCodexParallelLimit(2);
    await tick();
    expect(occupancy()).toEqual([1, 2, remoteLimit]);
    expect(stubs.generateImageCodex.mock.calls.map(([p]) => p.jobId)).toEqual(cloud);
    expect(stubs.generateVideoRemote.mock.calls.map(([p]) => p.jobId)).toEqual(remote);
    expect(stubs.generateVideo.mock.calls.slice(3).map(([p]) => p.jobId)).toEqual(gpu);
    expect(mediaJobQueue.getJob(heldBatch[3])).toMatchObject({
      status: 'queued', hold: { heldJobCount: 1 },
    });
    remoteAdapter.mockRestore();
  });

  it('lets other local models, image, audio, cloud and remote work pass a hold', async () => {
    const ids = await submitMany(4);
    for (const id of ids.slice(0, 3)) { await tick(); await finish(id); }
    const cloud = await submit('example-mlx', { mode: 'grok' });
    const remote = await submit('example-mlx', { remoteMedia: remoteVideoMediaParams() });
    const other = await submit('example-other');
    await tick();
    expect(stubs.generateVideoGrok).toHaveBeenCalledWith(expect.objectContaining({ jobId: cloud }));
    expect(stubs.generateVideoRemote).toHaveBeenCalledWith(expect.objectContaining({ jobId: remote }));
    expect(mediaJobQueue.getJob(other).status).toBe('running');
    await finish(other, null);
    for (const [kind, emitter] of [['image', imageGenEvents], ['audio', audioGenEvents]]) {
      stubs.runTraining.mockResolvedValue({});
      const { jobId } = await mediaJobQueue.enqueueJob({ kind, params: {} });
      await tick();
      expect(mediaJobQueue.getJob(jobId).status).toBe('running');
      emitter.emit('completed', { generationId: jobId });
      await flush();
    }
    expect(mediaJobQueue.getJob(ids[3]).status).toBe('queued');
  });

  it('resets on success or a different cause, ignores cancellation, and excludes bare exit codes', async () => {
    const errors = ["AttributeError: 'Tokenizer' object has no attribute 'encode'",
      "AttributeError: 'Pipeline' object has no attribute 'decode'",
      "AttributeError: 'Tokenizer' object has no attribute 'encode'", 'RuntimeError: shape mismatch', 'RuntimeError: shape mismatch', null,
      'RuntimeError: shader failed', 'RuntimeError: shader failed', 'Exit code 1',
      'RuntimeError: shape mismatch', 'RuntimeError: shader failed', 'RuntimeError: shader failed'];
    for (const error of errors) {
      const id = await submit(); await tick(); await finish(id, error);
    }
    const canceled = await submit(); await tick();
    await mediaJobQueue.cancelJob(canceled);
    await finish(canceled, 'RuntimeError: unrelated cancellation');
    const third = await submit(); const retained = await submit();
    await tick(); await finish(third, 'RuntimeError: shader failed'); await tick();
    expect(mediaJobQueue.getJob(canceled).status).toBe('canceled');
    expect(mediaJobQueue.getJob(retained)).toMatchObject({ status: 'queued', hold: { cause: 'shader failed' } });
  });

  // #9029: a started job reaches its provider — and attaches the listeners a
  // terminal event needs — only after async pre-dispatch work (a cold settings
  // read is real I/O). A drain that skipped that window let `finish` emit into
  // nothing, stranding the lane so the retained job above never saw its hold.
  it('drains a started job through its pre-dispatch window', async () => {
    const { assertVideoAttemptDispatch } = await import('../creativeDirector/videoExecution.js');
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    assertVideoAttemptDispatch.mockImplementationOnce(() => gate);
    const id = await submit('example-mlx', { videoProduction: { projectId: 'example-project', attemptId: 'example-attempt' } });
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(150);
    expect(mediaJobQueue.getJob(id).status).toBe('running');
    let drained = false;
    const drain = flush().then(() => { drained = true; });
    // Every snapshot write and terminal transition has landed; only dispatch is open.
    await expect(mediaJobQueue.flushMediaJobQueue()).resolves.toEqual({ ok: true });
    expect(drained).toBe(false);
    release();
    await drain;
    expect(stubs.generateVideo).toHaveBeenCalledWith(expect.objectContaining({ jobId: id }));
    await finish(id, null);
    expect(mediaJobQueue.getJob(id).status).toBe('completed');
  });

  it('counts pre-dispatch rejection once and resumes with a cleared streak', async () => {
    stubs.generateVideo.mockRejectedValue(Object.assign(new Error("Example runtime is not installed. Install or repair it from Video Gen's model setup panel."), { code: 'EXAMPLE_VENV_MISSING' }));
    const ids = await submitMany(4);
    for (let i = 0; i < 4; i += 1) {
      await tick();
      await mediaJobQueue.__drainForTests({ settleLanes: true });
    }
    expect(stubs.generateVideo).toHaveBeenCalledTimes(3);
    const held = mediaJobQueue.getJob(ids[3]);
    expect(held.status).toBe('queued');
    await mediaJobQueue.resumeVideoHold(held.hold.id);
    const next = await submit();
    await tick();
    await mediaJobQueue.__drainForTests({ settleLanes: true });
    await tick();
    await mediaJobQueue.__drainForTests({ settleLanes: true });
    expect(stubs.generateVideo).toHaveBeenCalledTimes(5);
    expect(mediaJobQueue.getJob(next).status).toBe('failed');
  });

  it('holds repeated quoted-only exceptions while keeping distinct keys separate', async () => {
    const errors = ["KeyError: 'Width'", "KeyError: 'width'", "KeyError: 'Width'",
      "KeyError: 'width'", "KeyError: 'width'", "KeyError: 'width'"];
    const ids = await submitMany(errors.length + 1);
    for (const [i, error] of errors.entries()) {
      await tick();
      expect(mediaJobQueue.getJob(ids[i]).status).toBe('running');
      await finish(ids[i], error);
    }
    await tick();
    expect(mediaJobQueue.getJob(ids.at(-1))).toMatchObject({ status: 'queued',
      hold: { classification: 'keyerror', cause: 'KeyError: redacted diagnostic details' } });
    await mediaJobQueue.cancelJob(ids.at(-1));
    const [hold] = mediaJobQueue.listVideoHolds();
    expect(hold.heldJobCount).toBe(0);
    expect(hold).not.toHaveProperty('signature');
    expect(await mediaJobQueue.resumeVideoHold(hold.id)).toBe(true);
    expect(mediaJobQueue.listVideoHolds()).toEqual([]);
  });

  it('holds the effective CUDA fallback without rewriting omitted model parameters', async () => {
    const { getDefaultVideoModelId } = await import('../../lib/mediaModels.js');
    getDefaultVideoModelId.mockImplementation((capabilities) => capabilities?.cuda?.maxVramGb === 8
      ? 'example-cuda' : 'example-large-cuda');
    const ids = await submitMany(4, async () => (await mediaJobQueue.enqueueJob({
      kind: 'video', params: { prompt: 'invented clip' },
    })).jobId);
    for (const id of ids.slice(0, 3)) {
      await tick();
      expect(stubs.generateVideo).toHaveBeenLastCalledWith(expect.objectContaining({ jobId: id, modelId: 'example-cuda' }));
      await finish(id);
    }
    await tick();
    expect(stubs.generateVideo).toHaveBeenCalledTimes(3);
    const retained = mediaJobQueue.getJob(ids[3]);
    expect(retained).toMatchObject({ status: 'queued', hold: { modelId: 'example-cuda', runtime: 'cuda_video' } });
    expect(retained.params).not.toHaveProperty('modelId');
    await mediaJobQueue.resumeVideoHold(retained.hold.id);
    await tick();
    expect(stubs.generateVideo).toHaveBeenLastCalledWith(expect.objectContaining({ jobId: ids[3], modelId: 'example-cuda' }));
  });

  it('uses structured signal evidence and ignores advisory text when no cause was found', async () => {
    const { createVideoDiagnosticTail } = await import('../../lib/videoFailure.js');
    const ids = await submitMany(6);
    const causes = ['OutOfMemory', 'InnocentVictim', null, 'Timeout', 'Timeout'];
    for (const [i, cause] of causes.entries()) {
      await tick();
      const tail = createVideoDiagnosticTail();
      if (cause) tail.push('stderr', `kIOGPUCommandBufferCallbackError${cause}`);
      videoGenEvents.emit('failed', { generationId: ids[i], error: 'Render aborted: Metal command-buffer watchdog advice', failure: tail.failure() });
      await flush();
    }
    await tick();
    expect(mediaJobQueue.getJob(ids[5]).status).toBe('running');
  });

  it.each([undefined, null])('loads legacy jobs with holds=%s without counting restart failures', async (videoHolds) => {
    writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify({ videoHolds, jobs: [
      ...[1, 2, 3].map((n) => ({ id: `interrupted-${n}`, kind: 'video', status: 'running', params: { modelId: 'example-mlx' } })),
      { id: 'retained-legacy', kind: 'video', status: 'queued', params: { modelId: 'example-mlx' } },
    ] }));
    await mediaJobQueue.initMediaJobQueue(); await tick();
    expect(mediaJobQueue.getJob('retained-legacy').status).toBe('running');
    await finish('retained-legacy');
    const next = await submit(); await tick();
    expect(mediaJobQueue.getJob(next).status).toBe('running');
  });

  it('withholds dispatch and new admissions when damaged holds block durable snapshots', async () => {
    const file = join(tempDataDir, 'media-jobs.json');
    const savedVideos = ['retained-mlx', 'retained-cuda'];
    const snapshot = JSON.stringify({ jobs: [
      ...savedVideos.map((id, index) => ({ id, kind: 'video', status: 'queued',
        params: { modelId: index ? 'example-cuda' : 'example-mlx' } })),
      { id: 'saved-image', kind: 'image', status: 'queued', params: {} },
      { id: 'saved-cloud', kind: 'video', status: 'queued', params: { mode: 'grok' } },
      { id: 'saved-remote', kind: 'video', status: 'running', params: { remoteMedia: remoteVideoMediaParams() } },
      { id: 'saved-training', kind: 'training', status: 'running', params: { runId: 'example-training' } },
      { id: 'interrupted-video', kind: 'video', status: 'running', params: { modelId: 'example-mlx' } },
    ], videoHolds: [
      { id: 'aaaaaaaa-0000-4000-8000-000000000001', modelId: 'example-cuda', runtime: 'cuda_video',
        classification: 'runtimeerror', cause: 'shader failed', heldAt: new Date().toISOString() },
      { id: 'malformed-hold' },
    ] });
    writeFileSync(file, snapshot);
    stubs.hasSurvivingTrainer.mockResolvedValue(true);
    stubs.runTraining.mockResolvedValue({});
    await expect(mediaJobQueue.initMediaJobQueue()).resolves.toBeUndefined();
    await tick();
    expect(stubs.generateVideo).not.toHaveBeenCalled();
    expect(mediaJobQueue.getJob('interrupted-video').status).toBe('failed');
    for (const generate of [stubs.generateImage, stubs.generateImageCodex, stubs.generateAudioRemote, stubs.runTraining]) {
      expect(generate).not.toHaveBeenCalled();
    }
    await expect(submit('example-other')).rejects.toMatchObject({ code: mediaJobQueue.MEDIA_QUEUE_PERSIST_FAILED });
    expect(readFileSync(file, 'utf8')).toBe(snapshot);
    const [recoveryHold] = mediaJobQueue.listVideoHolds();
    expect(recoveryHold).toMatchObject({ scope: 'local-video' });
    await expect(mediaJobQueue.resumeVideoHold(recoveryHold.id)).rejects.toThrow('storage is blocked');
    expect(readFileSync(file, 'utf8')).toBe(snapshot);
  });
});

// A rejected cohort lookup must settle only its local-video jobs, without
// turning model preparation into an admission gate for other lanes.
describe('local video preparation failures', () => {
  let resolveModel;
  beforeEach(async () => {
    vi.useFakeTimers();
    resolveModel = vi.fn(async () => ({ model: { id: 'example-mlx', runtime: 'mlx_video' } }));
    vi.doMock('../videoGen/modelSelection.js', () => ({ resolveVideoModelSelection: resolveModel }));
    await importFresh();
  });
  afterEach(() => {
    vi.doUnmock('../videoGen/modelSelection.js');
    vi.clearAllTimers();
    vi.useRealTimers();
  });
  const tick = async () => {
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(150);
    await flush();
  };
  const stage = () => {
    const uploads = join(tempDataDir, 'uploads');
    mkdirSync(uploads, { recursive: true });
    const paths = ['frame.png', 'audio.wav', 'extra.png'].map((name) => join(uploads, name));
    paths.forEach((path) => writeFileSync(path, 'synthetic upload'));
    return paths;
  };
  const waitForFailure = async (id) => {
    await vi.waitFor(() => expect(mediaJobQueue.getJob(id).status).toBe('failed'));
    await flush();
  };
  const readJobs = () => JSON.parse(readFileSync(join(tempDataDir, 'media-jobs.json'), 'utf8')).jobs;

  it('fails an omitted-model job once, cleans its inputs, and drains independent lanes without another enqueue', async () => {
    await mediaJobQueue.initMediaJobQueue();
    const paths = stage();
    const failed = vi.fn();
    mediaJobQueue.mediaJobEvents.on('failed', failed);
    resolveModel.mockRejectedValue(new Error('Example settings could not be loaded'));
    const omitted = await mediaJobQueue.enqueueJob({ kind: 'video', params: {
      prompt: 'omitted model', uploadedTempPath: paths[0], audioFilePath: paths[1], uploadedTempPaths: [paths[2]],
    } });
    const explicit = await mediaJobQueue.enqueueJob({ kind: 'video', params: { modelId: 'example-mlx' } });
    const waiting = await mediaJobQueue.enqueueJob({ kind: 'video', params: { modelId: 'example-other' } });
    const cloud = await mediaJobQueue.enqueueJob({ kind: 'image', params: { mode: 'codex' } });
    const remote = await mediaJobQueue.enqueueJob({ kind: 'video', params: { remoteMedia: remoteVideoMediaParams() } });
    await tick();
    await waitForFailure(omitted.jobId);
    await vi.waitFor(() => expect(stubs.generateVideoRemote).toHaveBeenCalled());
    expect(stubs.generateVideo.mock.calls.map(([params]) => params.jobId)).toEqual([explicit.jobId]);
    expect(stubs.generateImageCodex).toHaveBeenCalledWith(expect.objectContaining({ jobId: cloud.jobId }));
    expect(stubs.generateVideoRemote).toHaveBeenCalledWith(expect.objectContaining({ jobId: remote.jobId }));
    expect(mediaJobQueue.getJob(waiting.jobId)).toMatchObject({ status: 'queued', position: 2 });
    expect(mediaJobQueue.getJob(omitted.jobId).error).toContain('Example settings could not be loaded');
    expect(failed).toHaveBeenCalledTimes(1);
    expect(readJobs().filter((job) => job.id === omitted.jobId)).toMatchObject([{ status: 'failed' }]);
    for (const path of paths) expect(existsSync(path)).toBe(false);
    const res = { write: vi.fn(), req: { on: vi.fn() }, writeHead: vi.fn(), flushHeaders: vi.fn(), end: vi.fn() };
    mediaJobQueue.attachSseClient(omitted.jobId, res);
    expect(res.write.mock.calls.flat().join('')).toContain('Could not prepare local video model');
    videoGenEvents.emit('completed', { generationId: explicit.jobId });
    await flush(); // Durable terminal settlement releases the lane before the worker tick.
    await tick();
    expect(mediaJobQueue.getJob(waiting.jobId).status).toBe('running');
    videoGenEvents.emit('completed', { generationId: waiting.jobId });
    await flush();
    resolveModel.mockResolvedValue({ model: { id: 'example-mlx', runtime: 'mlx_video' } });
    const repaired = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'after repair' } });
    await tick();
    expect(mediaJobQueue.getJob(repaired.jobId).status).toBe('running');
    expect(failed).toHaveBeenCalledTimes(1);
    expect(mediaJobQueue.listJobs().filter((job) => job.id === omitted.jobId)).toHaveLength(1);
    mediaJobQueue.mediaJobEvents.off('failed', failed);
  });

  it('restores a mixed snapshot without rejecting boot and resolves the failed default once for the batch', async () => {
    const paths = stage();
    resolveModel.mockRejectedValue(new Error('Example default unavailable'));
    writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify({ jobs: [
      { id: 'saved-omitted', kind: 'video', status: 'queued', params: { uploadedTempPath: paths[0], audioFilePath: paths[1], uploadedTempPaths: [paths[2]] } },
      { id: 'saved-empty', kind: 'video', status: 'queued', params: { modelId: '' } },
      { id: 'saved-explicit', kind: 'video', status: 'queued', params: { modelId: 'example-mlx' } },
      { id: 'saved-null', kind: 'video', status: 'queued', params: { modelId: null } },
      { id: 'saved-cloud', kind: 'image', status: 'queued', params: { mode: 'codex' } },
      { id: 'saved-remote', kind: 'video', status: 'queued', params: { remoteMedia: remoteVideoMediaParams() } },
    ] }));
    await expect(mediaJobQueue.initMediaJobQueue()).resolves.toBeUndefined();
    await tick();
    expect(resolveModel).toHaveBeenCalledTimes(1);
    for (const id of ['saved-omitted', 'saved-empty']) {
      expect(readJobs().filter((job) => job.id === id)).toMatchObject([{ status: 'failed', error: expect.stringContaining('Example default unavailable') }]);
    }
    expect(mediaJobQueue.getJob('saved-explicit').status).toBe('running');
    expect(mediaJobQueue.getJob('saved-cloud').status).toBe('running');
    expect(mediaJobQueue.getJob('saved-remote').status).toBe('running');
    expect(mediaJobQueue.getJob('saved-null')).toMatchObject({ status: 'queued', params: { modelId: null }, position: 2 });
    for (const path of paths) expect(existsSync(path)).toBe(false);
  });

  it('limits catalog failures to local videos while restored cloud and remote work dispatch', async () => {
    const { getVideoModels } = await import('../../lib/mediaModels.js');
    getVideoModels.mockImplementationOnce(() => { throw new Error('Example catalog unavailable'); });
    writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify({ jobs: [
      { id: 'catalog-local', kind: 'video', status: 'queued', params: { modelId: 'example-mlx' } },
      { id: 'catalog-default', kind: 'video', status: 'queued', params: {} },
      { id: 'catalog-cloud', kind: 'image', status: 'queued', params: { mode: 'codex' } },
      { id: 'catalog-remote', kind: 'video', status: 'queued', params: { remoteMedia: remoteVideoMediaParams() } },
    ] }));
    await expect(mediaJobQueue.initMediaJobQueue()).resolves.toBeUndefined();
    await tick();
    for (const id of ['catalog-local', 'catalog-default']) {
      expect(readJobs().filter((job) => job.id === id)).toMatchObject([{ status: 'failed', error: expect.stringContaining('Example catalog unavailable') }]);
    }
    expect(stubs.generateVideo).not.toHaveBeenCalled();
    expect(resolveModel).not.toHaveBeenCalled();
    expect(mediaJobQueue.getJob('catalog-cloud').status).toBe('running');
    expect(mediaJobQueue.getJob('catalog-remote').status).toBe('running');
  });

  it.each(['cancel', 'shutdown'])('preserves %s ownership while default preparation is awaiting', async (action) => {
    await mediaJobQueue.initMediaJobQueue();
    let rejectModel;
    const pending = new Promise((_, reject) => { rejectModel = reject; });
    resolveModel.mockReturnValue(pending);
    const paths = stage();
    const failed = vi.fn();
    mediaJobQueue.mediaJobEvents.on('failed', failed);
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'video', params: { uploadedTempPath: paths[0] } });
    await tick();
    expect(resolveModel).toHaveBeenCalledTimes(1);
    if (action === 'cancel') await mediaJobQueue.cancelJob(jobId);
    else mediaJobQueue.quiesceMediaJobQueue();
    rejectModel(new Error('Example default unavailable'));
    await tick();
    expect(failed).not.toHaveBeenCalled();
    expect(stubs.generateVideo).not.toHaveBeenCalled();
    expect(mediaJobQueue.getJob(jobId).status).toBe(action === 'cancel' ? 'canceled' : 'queued');
    expect(existsSync(paths[0])).toBe(action === 'shutdown');
    expect(readJobs().filter((job) => job.id === jobId)).toHaveLength(1);
    mediaJobQueue.mediaJobEvents.off('failed', failed);
  });

  it('does not prepare or fail an admission before its snapshot settles', async () => {
    await mediaJobQueue.initMediaJobQueue();
    resolveModel.mockRejectedValue(new Error('Example default unavailable'));
    const release = holdNextWrite();
    const admission = mediaJobQueue.enqueueJob({ kind: 'video', params: {} });
    await vi.advanceTimersByTimeAsync(150);
    await vi.dynamicImportSettled();
    expect(resolveModel).not.toHaveBeenCalled();
    expect(mediaJobQueue.listJobs()[0].status).toBe('queued');
    release();
    const { jobId, status } = await admission;
    expect(status).toBe('queued');
    await tick();
    await waitForFailure(jobId);
    expect(stubs.generateVideo).not.toHaveBeenCalled();
  });
});

// #8325: a job id handed to a caller must survive a crash, so admission waits
// for the snapshot that contains the job — and a failed snapshot refuses it.
const persistedJobs = () => JSON.parse(readFileSync(join(tempDataDir, 'media-jobs.json'), 'utf-8')).jobs;
const persistedIds = () => persistedJobs().map((j) => j.id);
// Hold the NEXT snapshot write until the returned release() is called.
const holdNextWrite = () => {
  const realWrite = atomicWriteSpy.getMockImplementation();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  atomicWriteSpy.mockImplementationOnce(async (...args) => {
    await gate;
    return realWrite(...args);
  });
  return () => release();
};

describe('durable remote source-audio settlement', () => {
  const startAudioJob = async (suffix = '001', directory = false) => {
    const path = join(tempDataDir, 'uploads', `mv-source-audio-00000000-0000-4000-8000-000000000${suffix}.wav`);
    mkdirSync(join(tempDataDir, 'uploads'), { recursive: true });
    if (directory) mkdirSync(path); else writeFileSync(path, 'owned fixture');
    const remoteMedia = { ...remoteVideoMediaParams(), peerId: `00000000-0000-4000-8000-000000000${suffix}`,
      inputAssets: [{ role: 'sourceAudio', path }] };
    const job = await mediaJobQueue.enqueueJob({ kind: 'video', params: { remoteMedia, uploadedTempPaths: [path] } });
    await waitFor(() => stubs.generateVideoRemote.mock.calls.some(([params]) => params.jobId === job.jobId));
    return { ...job, path };
  };
  const restoreUnsettledAudioJob = async (directory = false) => {
    const first = await startAudioJob('001', directory);
    const { maintenance } = await import('../../lib/maintenanceAdmission.js');
    await maintenance.recoverOwned('media', first.jobId).run(async () => maintenance.markCurrentUnsettled());
    videoGenEvents.emit('failed', { generationId: first.jobId, error: 'Unknown receipt', remoteInputsDisposable: false });
    await waitFor(() => mediaJobQueue.getJob(first.jobId).status === 'failed');
    await flush();
    mediaJobQueue.quiesceMediaJobQueue();
    await mediaJobQueue.__resetForTests();
    stubs.generateVideoRemote.mockClear();
    await importFresh();
    await mediaJobQueue.initMediaJobQueue();
    await waitFor(() => stubs.generateVideoRemote.mock.calls.some(([params]) => params.jobId === first.jobId));
    return { first, maintenance };
  };

  it('retains the slice until a durable terminal snapshot, then cleans before publishing completion', async () => {
    const job = await startAudioJob();
    const release = holdNextWrite();
    const published = vi.fn(() => expect(existsSync(job.path)).toBe(false));
    mediaJobQueue.mediaJobEvents.once('completed', published);
    videoGenEvents.emit('completed', { generationId: job.jobId, remoteInputsDisposable: true });
    await new Promise(resolve => setImmediate(resolve));
    expect(existsSync(job.path)).toBe(true);
    expect(persistedJobs().find(entry => entry.id === job.jobId).status).toBe('running');
    release();
    await waitFor(() => published.mock.calls.length === 1);
    expect(persistedJobs().find(entry => entry.id === job.jobId).status).toBe('completed');
    expect(mediaJobQueue.getJob(job.jobId).result).not.toHaveProperty('remoteInputsDisposable');
  });

  it('retains uncertain inputs when the executor gives no safe-disposal verdict', async () => {
    const job = await startAudioJob();
    videoGenEvents.emit('failed', { generationId: job.jobId, error: 'Uncertain remote outcome', remoteInputsDisposable: false });
    await waitFor(() => mediaJobQueue.getJob(job.jobId).status === 'failed');
    expect(existsSync(job.path)).toBe(true);
  });
  it('reserves an uncertain peer across lane release and restart, then unblocks only after reconciliation settles', async () => {
    const first = await startAudioJob();
    const { maintenance } = await import('../../lib/maintenanceAdmission.js');
    const admission = maintenance.recoverOwned('media', first.jobId);
    await admission.run(async () => maintenance.markCurrentUnsettled());
    videoGenEvents.emit('failed', { generationId: first.jobId, error: 'Unknown receipt', remoteInputsDisposable: false });
    await waitFor(() => mediaJobQueue.getJob(first.jobId).status === 'failed');
    expect(maintenance.status().blockers).toContainEqual(expect.objectContaining({ resource: first.jobId, unsettled: true }));
    expect(mediaJobQueue.removeArchivedJob(first.jobId)).toBe(false);
    const next = await mediaJobQueue.enqueueJob({ kind: 'video', params: { remoteMedia: remoteVideoMediaParams() } });
    const other = await mediaJobQueue.enqueueJob({ kind: 'video', params: { remoteMedia: { ...remoteVideoMediaParams(), peerId: '00000000-0000-4000-8000-000000000002' } } });
    await waitFor(() => stubs.generateVideoRemote.mock.calls.some(([params]) => params.jobId === other.jobId));
    expect(stubs.generateVideoRemote.mock.calls.some(([params]) => params.jobId === next.jobId)).toBe(false);
    expect(persistedJobs().find((job) => job.id === first.jobId).params.remotePeerReservation).toBe(true);
    videoGenEvents.emit('completed', { generationId: other.jobId, remoteInputsDisposable: true });
    await flush();
    mediaJobQueue.quiesceMediaJobQueue();
    await mediaJobQueue.__resetForTests();
    stubs.generateVideoRemote.mockClear();
    await importFresh();
    await mediaJobQueue.initMediaJobQueue();
    await waitFor(() => stubs.generateVideoRemote.mock.calls.some(([params]) => params.jobId === first.jobId));
    const recovery = stubs.generateVideoRemote.mock.calls.find(([params]) => params.jobId === first.jobId)[0];
    expect(recovery.remoteMedia.reconcile).toBe(true);
    expect(stubs.generateVideoRemote.mock.calls.some(([params]) => params.jobId === next.jobId)).toBe(false);
    // Lane release admits the next peer job before the archive flush completes.
    // Observe maintenance settlement itself instead of treating dispatch as its signal.
    let onMaintenanceChanged;
    const recoveryFinished = new Promise((resolve) => {
      onMaintenanceChanged = ({ blockers }) => {
        if (!blockers.some((entry) => entry.resource === first.jobId)) resolve();
      };
      maintenance.events.on('changed', onMaintenanceChanged);
    });
    try {
      videoGenEvents.emit('completed', { generationId: first.jobId, remoteInputsDisposable: true,
        remoteRecoverySettlement: remoteRecoverySettlement(first.jobId) });
      await waitFor(() => stubs.generateVideoRemote.mock.calls.some(([params]) => params.jobId === next.jobId));
      await recoveryFinished;
      expect(persistedJobs().find((job) => job.id === first.jobId).params.remotePeerReservation).toBe(false);
      expect(maintenance.status().blockers.filter((entry) => entry.resource === first.jobId)).toEqual([]);
      expect(mediaJobQueue.getJob(first.jobId).result).not.toHaveProperty('remoteRecoverySettlement');
      videoGenEvents.emit('completed', { generationId: next.jobId, remoteInputsDisposable: true });
    } finally {
      maintenance.events.off('changed', onMaintenanceChanged);
    }
  });

  it('reconciles a failed reservation in-process, explains the hold, then dispatches the next job to that peer', async () => {
    const first = await startAudioJob();
    stubs.generateVideoRemote.mockClear();
    videoGenEvents.emit('failed', { generationId: first.jobId, error: 'Peer disabled', remoteInputsDisposable: false });
    await waitFor(() => mediaJobQueue.getJob(first.jobId).status === 'failed');
    const next = await mediaJobQueue.enqueueJob({ kind: 'video', params: { remoteMedia: remoteVideoMediaParams() } });
    // No restart: the blocked peer re-enqueues the retained reservation as a reconcile run.
    await waitFor(() => stubs.generateVideoRemote.mock.calls.some(([params]) => params.jobId === first.jobId));
    expect(stubs.generateVideoRemote.mock.calls.find(([params]) => params.jobId === first.jobId)[0].remoteMedia.reconcile).toBe(true);
    await waitFor(() => mediaJobQueue.getJob(next.jobId)?.peerHold);
    expect(mediaJobQueue.getJob(next.jobId)).toMatchObject({
      status: 'queued',
      peerHold: { reason: 'peer-settling', blockingJobId: first.jobId },
    });
    expect(stubs.generateVideoRemote.mock.calls.some(([params]) => params.jobId === next.jobId)).toBe(false);
    videoGenEvents.emit('completed', { generationId: first.jobId, remoteInputsDisposable: true,
      remoteRecoverySettlement: remoteRecoverySettlement(first.jobId) });
    await waitFor(() => stubs.generateVideoRemote.mock.calls.some(([params]) => params.jobId === next.jobId));
    expect(mediaJobQueue.getJob(next.jobId)).not.toHaveProperty('peerHold');
    videoGenEvents.emit('completed', { generationId: next.jobId, remoteInputsDisposable: true });
  });

  it('keeps reconciliation SSE live across the prior attempt cleanup and a reconnect', async () => {
    const first = await startAudioJob();
    const client = () => {
      const frames = [];
      return { frames, writeHead: vi.fn(), end: vi.fn(), req: { on: vi.fn() },
        write: (message) => frames.push(JSON.parse(message.slice('data: '.length).trim())) };
    };
    const original = client();
    mediaJobQueue.attachSseClient(first.jobId, original);
    const { SSE_CLEANUP_DELAY_MS } = await import('../../lib/sseUtils.js');
    const timers = [];
    const realSetTimeout = globalThis.setTimeout;
    // Exercise the real helper callback without sleeping through its grace
    // window or replacing the queue's dispatch and persistence clocks.
    const timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      const timer = realSetTimeout(callback, delay, ...args);
      if (delay === SSE_CLEANUP_DELAY_MS) timers.push({ timer, expire: () => { clearTimeout(timer); callback(...args); } });
      return timer;
    });
    try {
      videoGenEvents.emit('failed', { generationId: first.jobId, error: 'Peer disabled', remoteInputsDisposable: false });
      await waitFor(() => mediaJobQueue.getJob(first.jobId).status === 'failed');
      await flush();
      expect(timers).toHaveLength(1);
      stubs.generateVideoRemote.mockClear();
      const next = await mediaJobQueue.enqueueJob({ kind: 'video', params: { remoteMedia: remoteVideoMediaParams() } });
      await waitFor(() => stubs.generateVideoRemote.mock.calls.some(([params]) => params.jobId === first.jobId));
      const reconciling = client();
      mediaJobQueue.attachSseClient(first.jobId, reconciling);
      timers[0].expire();
      expect(original.end).toHaveBeenCalledOnce();
      expect(reconciling.end).not.toHaveBeenCalled();
      const reconnected = client();
      mediaJobQueue.attachSseClient(first.jobId, reconnected);
      videoGenEvents.emit('progress', { generationId: first.jobId, type: 'progress', progress: 0.5 });
      for (const response of [reconciling, reconnected]) {
        expect(response.frames).toContainEqual(expect.objectContaining({ type: 'progress', progress: 0.5 }));
      }
      videoGenEvents.emit('completed', { generationId: first.jobId, remoteInputsDisposable: true,
        remoteRecoverySettlement: remoteRecoverySettlement(first.jobId) });
      await waitFor(() => mediaJobQueue.getJob(first.jobId).status === 'completed');
      await flush();
      expect(timers).toHaveLength(2);
      for (const response of [reconciling, reconnected]) {
        expect(response.frames).toContainEqual(expect.objectContaining({ type: 'complete' }));
      }
      timers[1].expire();
      expect(reconciling.end).toHaveBeenCalledOnce();
      expect(reconnected.end).toHaveBeenCalledOnce();
      await waitFor(() => stubs.generateVideoRemote.mock.calls.some(([params]) => params.jobId === next.jobId));
      videoGenEvents.emit('completed', { generationId: next.jobId, remoteInputsDisposable: true });
    } finally {
      timerSpy.mockRestore();
      for (const { timer } of timers) clearTimeout(timer);
    }
  });

  it('keeps every later job to the peer waiting while its reservation reconciles', async () => {
    const first = await startAudioJob();
    videoGenEvents.emit('failed', { generationId: first.jobId, error: 'Peer disabled', remoteInputsDisposable: false });
    await waitFor(() => mediaJobQueue.getJob(first.jobId).status === 'failed');
    stubs.generateVideoRemote.mockClear();
    const later = [];
    for (let i = 0; i < 2; i += 1) later.push(await mediaJobQueue.enqueueJob({ kind: 'video', params: { remoteMedia: remoteVideoMediaParams() } }));
    await waitFor(() => stubs.generateVideoRemote.mock.calls.some(([params]) => params.jobId === first.jobId));
    await flush();
    expect(stubs.generateVideoRemote.mock.calls.map(([params]) => params.jobId)).toEqual([first.jobId]);
    videoGenEvents.emit('completed', { generationId: first.jobId, remoteInputsDisposable: true,
      remoteRecoverySettlement: remoteRecoverySettlement(first.jobId) });
    await waitFor(() => stubs.generateVideoRemote.mock.calls.some(([params]) => params.jobId === later[0].jobId));
    videoGenEvents.emit('completed', { generationId: later[0].jobId, remoteInputsDisposable: true });
    await waitFor(() => stubs.generateVideoRemote.mock.calls.some(([params]) => params.jobId === later[1].jobId));
    videoGenEvents.emit('completed', { generationId: later[1].jobId, remoteInputsDisposable: true });
  });

  it('preserves recovered uncertainty when owned cleanup creates a new mark', async () => {
    const { first, maintenance } = await restoreUnsettledAudioJob(true);
    const journal = () => JSON.parse(readFileSync(join(maintenance.directory, 'state.json'), 'utf8'));
    const originalStamp = journal().operations.find(op => op.resource === first.jobId).uncertaintyStamp;
    videoGenEvents.emit('completed', { generationId: first.jobId, remoteInputsDisposable: true,
      remoteRecoverySettlement: remoteRecoverySettlement(first.jobId) });
    await waitFor(() => mediaJobQueue.getJob(first.jobId).status === 'completed');
    await flush();
    expect(journal().operations.find(op => op.resource === first.jobId).uncertaintyStamp).not.toBe(originalStamp);
    expect(maintenance.status().blockers).toContainEqual(expect.objectContaining({ resource: first.jobId, unsettled: true }));
    expect(existsSync(first.path)).toBe(true);
  });

  it.each(['missing', 'wrong-job', 'wrong-peer', 'executor-live'])('requires bound termination and executor teardown (%s)', async (variant) => {
    const { first, maintenance } = await restoreUnsettledAudioJob();
    const proof = variant === 'missing' ? undefined : { ...remoteRecoverySettlement(first.jobId),
      ...(variant === 'wrong-job' ? { jobId: 'another-job' } : {}),
      ...(variant === 'wrong-peer' ? { peerId: 'another-peer' } : {}),
      ...(variant === 'executor-live' ? { executorSettled: false } : {}),
    };
    videoGenEvents.emit('failed', { generationId: first.jobId, error: 'Never submitted is not prior peer termination',
      remoteInputsDisposable: true, remoteRecoverySettlement: proof });
    await waitFor(() => mediaJobQueue.getJob(first.jobId).status === 'failed');
    await flush();
    expect(maintenance.status().blockers).toContainEqual(expect.objectContaining({ resource: first.jobId, unsettled: true }));
  });

  it('retains recovery ownership through durable publication and an archive write failure', async () => {
    const { first, maintenance } = await restoreUnsettledAudioJob();
    const write = atomicWriteSpy.getMockImplementation();
    let terminalWrites = 0;
    atomicWriteSpy.mockImplementation((path, data) => {
      if (data?.jobs?.some(entry => entry.id === first.jobId && entry.status === 'completed') && ++terminalWrites > 1) {
        return Promise.reject(new Error('fixture archive persistence failure'));
      }
      return write(path, data);
    });
    try {
      videoGenEvents.emit('completed', { generationId: first.jobId, remoteInputsDisposable: true,
        remoteRecoverySettlement: remoteRecoverySettlement(first.jobId) });
      await waitFor(() => terminalWrites > 1);
      await flush();
      expect(maintenance.status().blockers).toContainEqual(expect.objectContaining({ resource: first.jobId, unsettled: true }));
      expect(existsSync(first.path)).toBe(false);
    } finally { atomicWriteSpy.mockImplementation(write); }
  });

  it('keeps Run now from bypassing the per-peer GPU cap', async () => {
    const first = await startAudioJob();
    const second = await mediaJobQueue.enqueueJob({ kind: 'video', params: { remoteMedia: remoteVideoMediaParams() } });
    expect(mediaJobQueue.runJobNow(second.jobId)).toMatchObject({ ok: false, code: 'NOT_CODEX' });
    expect(mediaJobQueue.getJob(second.jobId).status).toBe('queued');
    videoGenEvents.emit('completed', { generationId: first.jobId, remoteInputsDisposable: true });
  });

  it('retains the real provider cleanup verdict after a watchdog wins the durable terminal outcome', async () => {
    process.env.MEDIA_JOB_WATCHDOG_VIDEO_MS = '50';
    await importFresh();
    stubs.generateVideoRemote.mockResolvedValue({});
    const job = await startAudioJob();
    const { maintenance } = await import('../../lib/maintenanceAdmission.js');
    const { hold } = maintenance.begin({ reason: 'Await peer settlement', owner: 'Operator' });
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(100);
      await vi.waitFor(() => expect(mediaJobQueue.getJob(job.jobId).status).toBe('failed'));
      expect(existsSync(job.path)).toBe(true);
      expect(maintenance.status().state).toBe('draining');
      videoGenEvents.emit('failed', { generationId: job.jobId, error: 'Peer confirms terminal', remoteInputsDisposable: true });
      await vi.waitFor(() => expect(existsSync(job.path)).toBe(false));
      await vi.waitFor(() => expect(maintenance.status().state).toBe('ready'));
      expect(persistedJobs().find(entry => entry.id === job.jobId).status).toBe('failed');
    } finally {
      videoGenEvents.emit('failed', { generationId: job.jobId, error: 'Fixture teardown' });
      maintenance.resume({ id: hold.id, revision: hold.revision });
      delete process.env.MEDIA_JOB_WATCHDOG_VIDEO_MS;
      vi.clearAllTimers(); vi.useRealTimers();
    }
  });

  // Terminal persist retry policy (#12026): a transient lock earns one retry
  // after a short pause; a non-transient failure surfaces on the first attempt.
  const failSettlementTerminalWrites = (job, code, failures) => {
    const write = atomicWriteSpy.getMockImplementation();
    // Attempts up to and including the first terminal write that lands; the
    // archive snapshot that follows publication is not a retry.
    const attempts = [];
    let landed = false;
    atomicWriteSpy.mockImplementation((path, data) => {
      if (!landed && data?.jobs?.some(entry => entry.id === job.jobId && entry.status === 'completed')) {
        attempts.push(Date.now());
        if (attempts.length <= failures) return Promise.reject(Object.assign(new Error(`fixture ${code}`), { code }));
        landed = true;
      }
      return write(path, data);
    });
    return { attempts, restore: () => atomicWriteSpy.mockImplementation(write) };
  };

  it('surfaces a non-transient terminal persist failure after a single attempt', async () => {
    const job = await startAudioJob();
    const { attempts, restore } = failSettlementTerminalWrites(job, 'ENOSPC', Infinity);
    try {
      videoGenEvents.emit('completed', { generationId: job.jobId, remoteInputsDisposable: true });
      await waitFor(() => mediaJobQueue.getJob(job.jobId).persistenceError === true);
      await new Promise(resolve => setTimeout(resolve, 400));
      expect(attempts).toHaveLength(1);
      expect(persistedJobs().find(entry => entry.id === job.jobId).status).toBe('running');
    } finally {
      restore();
      await mediaJobQueue.flushMediaJobQueue();
    }
  });

  it('retries a transient EBUSY terminal persist once after the backoff', async () => {
    const job = await startAudioJob();
    const { attempts, restore } = failSettlementTerminalWrites(job, 'EBUSY', 1);
    try {
      videoGenEvents.emit('completed', { generationId: job.jobId, remoteInputsDisposable: true });
      await waitFor(() => persistedJobs().find(entry => entry.id === job.jobId)?.status === 'completed');
      expect(attempts).toHaveLength(2);
      expect(attempts[1] - attempts[0]).toBeGreaterThanOrEqual(200);
      await waitFor(() => mediaJobQueue.getJob(job.jobId).persistenceError === undefined);
    } finally {
      restore();
      await mediaJobQueue.flushMediaJobQueue();
    }
  });

  it('preserves replay bytes across a failed terminal write and releases them on storage recovery', async () => {
    const job = await startAudioJob();
    const write = atomicWriteSpy.getMockImplementation();
    let failing = true;
    atomicWriteSpy.mockImplementation((path, data) => failing && data?.jobs?.some(entry => entry.id === job.jobId && entry.status === 'completed')
      ? Promise.reject(new Error('fixture storage unavailable')) : write(path, data));
    try {
      videoGenEvents.emit('completed', { generationId: job.jobId, remoteInputsDisposable: true });
      await waitFor(() => mediaJobQueue.getJob(job.jobId).persistenceError === true);
      expect(existsSync(job.path)).toBe(true);
      expect(persistedJobs().find(entry => entry.id === job.jobId).status).toBe('running');
      failing = false;
      await mediaJobQueue.flushMediaJobQueue();
      await waitFor(() => !existsSync(job.path));
      expect(stubs.generateVideoRemote).toHaveBeenCalledTimes(1);
    } finally { atomicWriteSpy.mockImplementation(write); }
  });

  it('attributes failed cleanup to the correct job during shared terminal persistence and still publishes both outcomes', async () => {
    const bad = await startAudioJob('001', true);
    const good = await startAudioJob('002');
    const { maintenance } = await import('../../lib/maintenanceAdmission.js');
    const published = [];
    const receive = job => published.push(job.id);
    mediaJobQueue.mediaJobEvents.on('completed', receive);
    try {
      videoGenEvents.emit('completed', { generationId: good.jobId, remoteInputsDisposable: true });
      videoGenEvents.emit('completed', { generationId: bad.jobId, remoteInputsDisposable: true });
      await waitFor(() => published.length === 2);
      const blockers = maintenance.status().blockers;
      expect(blockers).toContainEqual(expect.objectContaining({ resource: bad.jobId, unsettled: true }));
      expect(blockers.filter(entry => entry.resource === good.jobId && entry.unsettled)).toEqual([]);
      expect(existsSync(good.path)).toBe(false);
      expect(existsSync(bad.path)).toBe(true);
    } finally { mediaJobQueue.mediaJobEvents.off('completed', receive); }
  });
});

describe('durable admission and shutdown flush', () => {

  beforeEach(async () => {
    stubs.generateVideo.mockImplementation(() => new Promise(() => {}));
    // Boot starts the worker, so dispatch is live before the job is admitted.
    await mediaJobQueue.initMediaJobQueue();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('acknowledges and dispatches a job only once its snapshot is written', async () => {
    const release = holdNextWrite();
    const settled = vi.fn();
    const admission = mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'slow disk' } });
    admission.then(settled);
    await vi.advanceTimersByTimeAsync(1000); // several worker passes
    expect(settled).not.toHaveBeenCalled();
    expect(stubs.generateVideo).not.toHaveBeenCalled();

    release();
    const { jobId, status } = await admission;
    expect(status).toBe('queued');
    expect(persistedIds()).toContain(jobId);
    await vi.advanceTimersByTimeAsync(200);
    await vi.dynamicImportSettled();
    await vi.waitFor(() => expect(stubs.generateVideo).toHaveBeenCalledWith(expect.objectContaining({ jobId })));
  });

  it('refuses the submission and starts no provider work when the snapshot fails', async () => {
    atomicWriteSpy.mockRejectedValueOnce(new Error('disk full'));
    await expect(mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'no room' } }))
      .rejects.toMatchObject({ status: 503, code: mediaJobQueue.MEDIA_QUEUE_PERSIST_FAILED });
    expect(mediaJobQueue.listJobs()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(stubs.generateVideo).not.toHaveBeenCalled();

    // The next admission's snapshot must not resurrect the refused job.
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'retry' } });
    expect(persistedIds()).toEqual([jobId]);
  });

  it('restores an admitted job exactly once after a crash', async () => {
    stubs.generateVideo.mockClear();
    const blocker = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'running' } });
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'waiting' } });
    // Crash straight after the acknowledgement — nothing else gets to write.
    vi.clearAllTimers();
    await mediaJobQueue.__resetForTests();
    await importFresh();
    await mediaJobQueue.initMediaJobQueue();
    const restored = mediaJobQueue.listJobs().filter((j) => j.id === jobId);
    expect(restored).toHaveLength(1);
    expect(restored[0].status).toBe('queued');
    expect(persistedIds().filter((id) => id === jobId)).toHaveLength(1);
    expect(persistedIds()).toContain(blocker.jobId);
  });

  it('flushes within its bound and reports a stalled or failed write', async () => {
    const release = holdNextWrite();
    const stalled = mediaJobQueue.flushMediaJobQueue({ timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    await expect(stalled).resolves.toMatchObject({ ok: false, timedOut: true });
    release();

    atomicWriteSpy.mockRejectedValueOnce(new Error('disk full'));
    await expect(mediaJobQueue.flushMediaJobQueue()).resolves.toEqual({ ok: false, error: 'disk full' });
    await expect(mediaJobQueue.flushMediaJobQueue()).resolves.toEqual({ ok: true });
  });
});

// #8691: once shutdown quiesces the queue, waiting work stays queued on disk for
// the next process — a running record left behind by the exit is failed on
// boot (and its staged upload deleted), while a queued one is restored intact.
describe('shutdown quiesce', () => {
  const tick = async (ms = 1000) => {
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(ms);
    await flush();
  };
  const stageUpload = () => {
    const upload = join(tempDataDir, 'uploads', 'example.png');
    mkdirSync(join(tempDataDir, 'uploads'), { recursive: true });
    writeFileSync(upload, 'synthetic image');
    return upload;
  };
  const restart = async () => {
    vi.clearAllTimers();
    await mediaJobQueue.__resetForTests();
    await importFresh();
    await mediaJobQueue.initMediaJobQueue();
  };

  beforeEach(() => {
    // Kickoff resolves; the provider's terminal event arrives when the test emits it.
    stubs.generateVideo.mockResolvedValue({});
    vi.useFakeTimers();
  });
  afterEach(() => { vi.doUnmock('../videoGen/modelSelection.js'); vi.clearAllTimers(); vi.useRealTimers(); });

  it('keeps a waiting job queued when its lane frees, and restart restores it once with its upload', async () => {
    await mediaJobQueue.initMediaJobQueue();
    const blocker = await mediaJobQueue.enqueueJob({ kind: 'video', params: { modelId: 'example-mlx', prompt: 'running' } });
    await tick();
    expect(mediaJobQueue.getJob(blocker.jobId).status).toBe('running');
    const upload = stageUpload();
    const { jobId } = await mediaJobQueue.enqueueJob({
      kind: 'video', params: { modelId: 'example-mlx', prompt: 'waiting', uploadedTempPath: upload },
    });

    expect(mediaJobQueue.quiesceMediaJobQueue()).toBe(true);
    expect(mediaJobQueue.quiesceMediaJobQueue()).toBe(false);
    // The running job still completes and its transition is flushed.
    videoGenEvents.emit('completed', { generationId: blocker.jobId, filename: `${blocker.jobId}.mp4` });
    await tick();
    expect(mediaJobQueue.getJob(blocker.jobId).status).toBe('completed');
    expect(stubs.generateVideo).toHaveBeenCalledTimes(1);
    expect(mediaJobQueue.getJob(jobId).status).toBe('queued');
    await expect(mediaJobQueue.flushMediaJobQueue()).resolves.toEqual({ ok: true });
    expect(persistedJobs().find((j) => j.id === blocker.jobId).status).toBe('completed');
    expect(persistedJobs().find((j) => j.id === jobId).status).toBe('queued');

    await restart();
    const restored = mediaJobQueue.listJobs().filter((j) => j.id === jobId);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ status: 'queued', params: { uploadedTempPath: upload } });
    expect(existsSync(upload)).toBe(true);
    // The new process dispatches it normally.
    await tick();
    await vi.waitFor(() => expect(stubs.generateVideo).toHaveBeenLastCalledWith(expect.objectContaining({ jobId })));
  });

  it('does not promote when shutdown lands while the worker resolves cohorts', async () => {
    let releaseCohorts;
    const cohortsResolved = new Promise((resolve) => { releaseCohorts = resolve; });
    vi.doMock('../videoGen/modelSelection.js', () => ({
      resolveVideoModelSelection: vi.fn(async () => {
        await cohortsResolved;
        return { model: { id: 'example-mlx', runtime: 'mlx_video' } };
      }),
    }));
    await importFresh();
    await mediaJobQueue.initMediaJobQueue();
    const blocker = await mediaJobQueue.enqueueJob({ kind: 'video', params: { modelId: 'example-mlx', prompt: 'running' } });
    await tick();
    expect(mediaJobQueue.getJob(blocker.jobId).status).toBe('running');
    // An omitted modelId makes the next worker pass await the model resolution.
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'waiting' } });
    await tick();

    // The worker is parked on the resolution; free the lane underneath it.
    videoGenEvents.emit('completed', { generationId: blocker.jobId, filename: `${blocker.jobId}.mp4` });
    await tick();
    expect(mediaJobQueue.getRunningJob()).toBeNull();
    mediaJobQueue.quiesceMediaJobQueue();
    releaseCohorts();
    await tick();
    expect(stubs.generateVideo).toHaveBeenCalledTimes(1);
    expect(mediaJobQueue.getJob(jobId).status).toBe('queued');
  });

  it('reset joins worker preparation before clearing a fixture or reopening dispatch', async () => {
    let enterPreparation;
    let releasePreparation;
    const entered = new Promise(resolve => { enterPreparation = resolve; });
    const preparation = new Promise(resolve => { releasePreparation = resolve; });
    vi.doMock('../videoGen/modelSelection.js', () => ({
      resolveVideoModelSelection: async () => {
        enterPreparation();
        await preparation;
        return { model: { id: 'example-mlx', runtime: 'mlx_video' } };
      },
    }));
    await importFresh();
    await mediaJobQueue.initMediaJobQueue();
    await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'waiting on preparation' } });
    await vi.advanceTimersByTimeAsync(150);
    await entered;
    let resetSettled = false;
    const reset = Promise.resolve(mediaJobQueue.__resetForTests()).then(() => { resetSettled = true; });
    try {
      await Promise.resolve();
      expect(resetSettled).toBe(false);
    } finally {
      releasePreparation();
      await reset;
    }
    expect(stubs.generateVideo).not.toHaveBeenCalled();
    rmSync(tempDataDir, { recursive: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(existsSync(tempDataDir)).toBe(false);
  });

  it('reset detaches abandoned providers and drains progress before removing the fixture', async () => {
    const events = ['progress', 'status', 'completed', 'failed', 'activity'];
    const before = events.map(event => imageGenEvents.listenerCount(event));
    let finishKickoff;
    stubs.generateImageCodex.mockImplementation(() => new Promise(resolve => { finishKickoff = resolve; }));
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'image', params: { mode: 'codex', prompt: 'abandoned render' } });
    await tick();
    expect(stubs.generateImageCodex).toHaveBeenCalledTimes(1);
    imageGenEvents.emit('progress', { generationId: jobId, type: 'progress', progress: 0.5 });
    await mediaJobQueue.__resetForTests();
    expect(events.map(event => imageGenEvents.listenerCount(event))).toEqual(before);
    rmSync(tempDataDir, { recursive: true });
    finishKickoff({});
    imageGenEvents.emit('completed', { generationId: jobId, filename: 'example.png' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(existsSync(tempDataDir)).toBe(false);
  });

  it('refuses Run Now without touching the waiting job', async () => {
    await mediaJobQueue.initMediaJobQueue();
    mediaJobQueue.setCodexParallelLimit(1);
    const first = await mediaJobQueue.enqueueJob({ kind: 'image', params: { mode: 'codex', prompt: 'running' } });
    await tick();
    expect(mediaJobQueue.getJob(first.jobId).status).toBe('running');
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'image', params: { mode: 'codex', prompt: 'waiting' } });

    mediaJobQueue.quiesceMediaJobQueue();
    expect(mediaJobQueue.runJobNow(jobId)).toMatchObject({ ok: false, code: mediaJobQueue.MEDIA_QUEUE_SHUTTING_DOWN });
    await tick();
    expect(stubs.generateImageCodex).toHaveBeenCalledTimes(1);
    expect(mediaJobQueue.getJob(jobId)).toMatchObject({ status: 'queued', position: 2 });
  });

  it('lets an admission settling during shutdown persist without re-arming the worker', async () => {
    // No boot: the settling admission is what would otherwise start the worker.
    const release = holdNextWrite();
    const admission = mediaJobQueue.enqueueJob({ kind: 'video', params: { modelId: 'example-mlx', prompt: 'late' } });
    mediaJobQueue.quiesceMediaJobQueue();
    release();
    const { jobId, status } = await admission;
    expect(status).toBe('queued');
    await tick();
    expect(stubs.generateVideo).not.toHaveBeenCalled();
    expect(persistedJobs().find((j) => j.id === jobId).status).toBe('queued');
  });
});

// #8326: waiting work is bounded across every lane, separately from each
// lane's running concurrency, and the bound never evicts a persisted job.
describe('pending-job ceiling', () => {
  const jobsFile = () => join(tempDataDir, 'media-jobs.json');
  const queueFull = { status: 429, code: 'MEDIA_QUEUE_FULL' };
  const waiting = () => mediaJobQueue.listJobs({ status: 'queued' }).length;

  beforeEach(() => {
    stubs.generateVideo.mockImplementation(() => new Promise(() => {}));
  });

  it('admits exactly the ceiling under concurrent submission and refuses the next without touching state', async () => {
    const { MAX_PENDING_MEDIA_JOBS } = mediaJobQueue;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A running job holds the only GPU slot, so everything below waits.
    const blocker = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'running' } });
    await waitFor(() => mediaJobQueue.getJob(blocker.jobId)?.status === 'running');

    // One synchronous check-and-push per submission: firing them all at once
    // must not let in-flight snapshot writes admit past the ceiling.
    const results = await Promise.allSettled(Array.from({ length: MAX_PENDING_MEDIA_JOBS + 1 },
      (_, i) => mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: `wait-${i}` } })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(MAX_PENDING_MEDIA_JOBS);
    expect(results.filter((r) => r.status === 'rejected').map((r) => r.reason)).toEqual([expect.objectContaining(queueFull)]);
    // The refused submission is backpressure answering the caller (429), not a fault: stdout, never stderr.
    expect(log).toHaveBeenCalledWith(expect.stringContaining('media queue full'));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('media queue full'));
    expect(waiting()).toBe(MAX_PENDING_MEDIA_JOBS);
    await flush();

    const snapshot = readFileSync(jobsFile(), 'utf8');
    const liveCount = mediaJobQueue.listJobs().length;
    const enqueued = vi.fn();
    mediaJobQueue.mediaJobEvents.on('enqueued', enqueued);
    atomicWriteSpy.mockClear();
    await expect(mediaJobQueue.enqueueJob({ kind: 'image', params: { prompt: 'one more' } }))
      .rejects.toMatchObject({ ...queueFull, context: { retryable: true, maxPendingJobs: MAX_PENDING_MEDIA_JOBS } });
    await flush();
    expect(mediaJobQueue.listJobs()).toHaveLength(liveCount);
    expect(enqueued).not.toHaveBeenCalled();
    expect(atomicWriteSpy).not.toHaveBeenCalled();
    expect(readFileSync(jobsFile(), 'utf8')).toBe(snapshot);
    mediaJobQueue.mediaJobEvents.off('enqueued', enqueued);

    // Draining one waiting job frees exactly one slot.
    await mediaJobQueue.cancelJob(mediaJobQueue.listJobs({ status: 'queued' })[0].id);
    await expect(mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'after drain' } }))
      .resolves.toMatchObject({ status: 'queued' });
  });

  // A batch preflight: one that fits is admitted to try, one that could fit
  // after a drain is retryable, one bigger than the ceiling never can be.
  it('distinguishes a batch that must wait from one that can never fit', async () => {
    const { MAX_PENDING_MEDIA_JOBS } = mediaJobQueue;
    expect(() => mediaJobQueue.assertMediaQueueRoom(MAX_PENDING_MEDIA_JOBS)).not.toThrow();
    expect(() => mediaJobQueue.assertMediaQueueRoom(MAX_PENDING_MEDIA_JOBS + 1))
      .toThrow(expect.objectContaining({ status: 400, code: 'MEDIA_BATCH_TOO_LARGE' }));
    await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'running' } });
    await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'waiting' } });
    await waitFor(() => waiting() === 1);
    expect(() => mediaJobQueue.assertMediaQueueRoom(MAX_PENDING_MEDIA_JOBS))
      .toThrow(expect.objectContaining({ ...queueFull, message: expect.stringContaining('room for 249 more') }));
  });

  it('restores a snapshot above the ceiling intact and blocks only new admissions until it drains', async () => {
    const { MAX_PENDING_MEDIA_JOBS } = mediaJobQueue;
    const count = MAX_PENDING_MEDIA_JOBS + 10;
    const ids = Array.from({ length: count }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    writeFileSync(jobsFile(), JSON.stringify({
      jobs: ids.map((id) => ({ id, kind: 'video', status: 'queued', queuedAt: '2026-09-01T00:00:00.000Z', params: { prompt: 'restored' } })),
    }));

    await importFresh();
    await mediaJobQueue.initMediaJobQueue();
    await waitFor(() => stubs.generateVideo.mock.calls.length === 1);
    await flush();

    // Nothing evicted — in memory or on disk.
    expect(mediaJobQueue.listJobs().map((j) => j.id).sort()).toEqual([...ids].sort());
    expect(JSON.parse(readFileSync(jobsFile(), 'utf8')).jobs.map((j) => j.id).sort()).toEqual([...ids].sort());
    expect(waiting()).toBe(count - 1);

    await expect(mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'new' } })).rejects.toMatchObject(queueFull);

    // Drain to one below the ceiling; admission reopens for exactly that room.
    const queuedIds = mediaJobQueue.listJobs({ status: 'queued' }).map((j) => j.id);
    for (const id of queuedIds.slice(0, count - MAX_PENDING_MEDIA_JOBS)) await mediaJobQueue.cancelJob(id);
    expect(waiting()).toBe(MAX_PENDING_MEDIA_JOBS - 1);
    await expect(mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'fits' } })).resolves.toMatchObject({ status: 'queued' });
    await expect(mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'full again' } })).rejects.toMatchObject(queueFull);
  });
});

// #9737: a terminal UI outcome must describe a durable row, and provider
// execution must never outrun the running snapshot that prevents local replay.
describe('durable execution and terminal settlement', () => {
  let storageWrite;
  beforeEach(async () => {
    storageWrite = atomicWriteSpy.getMockImplementation();
    vi.useFakeTimers();
    stubs.generateVideo.mockImplementation(async () => ({}));
    await mediaJobQueue.initMediaJobQueue();
  });
  afterEach(() => { atomicWriteSpy.mockImplementation(storageWrite); vi.clearAllTimers(); vi.useRealTimers(); });

  it('withholds generator execution until the running snapshot succeeds', async () => {
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'video', params: { modelId: 'example-cuda' } });
    const release = holdNextWrite();
    await vi.advanceTimersByTimeAsync(200);
    expect(stubs.generateVideo).not.toHaveBeenCalled();
    expect(persistedJobs().find((j) => j.id === jobId).status).toBe('queued');
    release();
    await flush();
    expect(stubs.generateVideo).toHaveBeenCalledTimes(1);
    expect(persistedJobs().find((j) => j.id === jobId).status).toBe('running');
    videoGenEvents.emit('completed', { generationId: jobId });
    await flush();
  });

  it('never dispatches after a failed running write and recovers only its storage settlement', async () => {
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'video', params: { modelId: 'example-cuda' } });
    const realWrite = atomicWriteSpy.getMockImplementation();
    atomicWriteSpy.mockRejectedValue(new Error('disk full'));
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(stubs.generateVideo).not.toHaveBeenCalled();
    expect(mediaJobQueue.getJob(jobId).status).toBe('running');
    expect(persistedJobs().find((j) => j.id === jobId).status).toBe('queued');
    atomicWriteSpy.mockImplementation(realWrite);
    await expect(mediaJobQueue.flushMediaJobQueue()).resolves.toEqual({ ok: true });
    expect(mediaJobQueue.getJob(jobId).status).toBe('failed');
    expect(persistedJobs().find((j) => j.id === jobId).status).toBe('failed');
    expect(stubs.generateVideo).not.toHaveBeenCalled();
  });

  it('rejects an undurable queued cancellation, retains uploads, and acknowledges once on recovery', async () => {
    mediaJobQueue.quiesceMediaJobQueue();
    const upload = join(tempDataDir, 'uploads', 'example.png');
    mkdirSync(join(tempDataDir, 'uploads'), { recursive: true });
    writeFileSync(upload, 'synthetic image');
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'video', params: { modelId: 'example-cuda', uploadedTempPath: upload } });
    const canceled = vi.fn();
    mediaJobQueue.mediaJobEvents.on('canceled', canceled);
    const realWrite = atomicWriteSpy.getMockImplementation();
    atomicWriteSpy.mockRejectedValue(new Error('disk full'));
    await expect(mediaJobQueue.cancelJob(jobId)).rejects.toMatchObject({ status: 503, code: mediaJobQueue.MEDIA_QUEUE_PERSIST_FAILED });
    expect(canceled).not.toHaveBeenCalled();
    expect(mediaJobQueue.getJob(jobId).status).toBe('queued');
    expect(persistedJobs().find((j) => j.id === jobId).status).toBe('queued');
    expect(existsSync(upload)).toBe(true);
    const { sanitizeJob } = await import('./sanitizeJob.js');
    expect(mediaJobQueue.listQueueJobs().map(sanitizeJob)).toEqual([expect.objectContaining({
      id: jobId, status: 'queued', statusMsg: 'Outcome pending: media queue storage unavailable',
    })]);
    expect(mediaJobQueue.removeArchivedJob(jobId)).toBe(false);
    atomicWriteSpy.mockImplementation(realWrite);
    await expect(mediaJobQueue.cancelJob(jobId)).resolves.toEqual({ ok: true, status: 'canceled' });
    await flush();
    expect(canceled).toHaveBeenCalledTimes(1);
    expect(existsSync(upload)).toBe(false);
    vi.clearAllTimers();
    await mediaJobQueue.__resetForTests();
    await importFresh();
    await mediaJobQueue.initMediaJobQueue();
    await vi.advanceTimersByTimeAsync(200);
    expect(mediaJobQueue.getJob(jobId).status).toBe('canceled');
    expect(stubs.generateVideo).not.toHaveBeenCalled();
  });

  it('withholds completion and its result until storage recovers without generating again', async () => {
    const { maintenance } = await import('../../lib/maintenanceAdmission.js');
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'video', params: { modelId: 'example-cuda' } });
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    const completed = vi.fn();
    mediaJobQueue.mediaJobEvents.on('completed', completed);
    const realWrite = atomicWriteSpy.getMockImplementation();
    const { hold } = maintenance.begin({ reason: 'Storage recovery', owner: 'Operator' });
    try {
      atomicWriteSpy.mockRejectedValue(new Error('disk full'));
      videoGenEvents.emit('completed', { generationId: jobId, output: 'example.mp4' });
      await flush();
      expect(completed).not.toHaveBeenCalled();
      expect(mediaJobQueue.getJob(jobId)).toMatchObject({ status: 'running' });
      expect(mediaJobQueue.getJob(jobId).result).toBeUndefined();
      expect(persistedJobs().find((j) => j.id === jobId).status).toBe('running');
      expect(maintenance.status()).toMatchObject({ state: 'draining', blockers: [expect.objectContaining({ resource: jobId })] });
      atomicWriteSpy.mockImplementation(realWrite);
      await expect(mediaJobQueue.flushMediaJobQueue()).resolves.toEqual({ ok: true });
      expect(completed).toHaveBeenCalledTimes(1);
      expect(stubs.generateVideo).toHaveBeenCalledTimes(1);
      expect(mediaJobQueue.getJob(jobId)).toMatchObject({ status: 'completed', result: { output: 'example.mp4' } });
      await vi.waitFor(() => expect(maintenance.status().state).toBe('ready'));
    } finally {
      atomicWriteSpy.mockImplementation(realWrite);
      maintenance.resume({ id: hold.id, revision: hold.revision });
    }
    vi.clearAllTimers();
    await mediaJobQueue.__resetForTests();
    await importFresh();
    await mediaJobQueue.initMediaJobQueue();
    await vi.advanceTimersByTimeAsync(200);
    expect(mediaJobQueue.getJob(jobId).status).toBe('completed');
    expect(stubs.generateVideo).toHaveBeenCalledTimes(1);
  });
});

// A completion publishes a file (written by the generator before it reports
// done) and rows (the queue snapshot and the attach hooks that name the file).
// A backup cut must never capture one store without the other (#9981).
describe('backup snapshot admission for media completion', () => {
  let boundary;
  let rows;
  let hookGate;
  let hookStarted;
  let storageWrite;
  const onCompleted = (job) => {
    void boundary.withBackupAssetPublication(async () => {
      hookStarted = true;
      await hookGate;
      rows.set(job.id, job.result.filename);
    });
  };
  // What a backup would hold: the files copied, the queue snapshot and attached rows.
  const capture = (jobId) => ({
    files: existsSync(join(tempDataDir, 'videos')) ? readdirSync(join(tempDataDir, 'videos')) : [],
    queueStatus: persistedJobs().find((j) => j.id === jobId)?.status,
    rows: new Map(rows),
  });
  const startJob = async () => {
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'synthetic' } });
    await waitFor(() => stubs.generateVideo.mock.calls.length === 1);
    return jobId;
  };
  const renderFinishes = (jobId) => {
    mkdirSync(join(tempDataDir, 'videos'), { recursive: true });
    writeFileSync(join(tempDataDir, 'videos', `${jobId}.mp4`), 'synthetic clip');
    videoGenEvents.emit('completed', { generationId: jobId, filename: `${jobId}.mp4` });
  };
  // A terminal write fails `times` times with `code`: ENOSPC surfaces on the
  // first attempt, EBUSY earns one retry after the backoff (#12026).
  const failTerminalWrites = (times, code = 'ENOSPC') => {
    const failures = { remaining: times, count: 0 };
    atomicWriteSpy.mockImplementation(async (path, data) => {
      if (failures.remaining > 0 && data?.jobs?.some((j) => j.status === 'completed')) {
        failures.remaining -= 1;
        failures.count += 1;
        throw Object.assign(new Error(code === 'ENOSPC' ? 'disk full' : 'destination busy'), { code });
      }
      return storageWrite(path, data);
    });
    return failures;
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(async () => {
    boundary = await import('../../lib/backupSnapshotBoundary.js');
    rows = new Map();
    hookStarted = false;
    hookGate = Promise.resolve();
    storageWrite = atomicWriteSpy.getMockImplementation();
    stubs.generateVideo.mockImplementation(async () => ({}));
    mediaJobQueue.mediaJobEvents.on('completed', onCompleted);
  });
  afterEach(() => {
    mediaJobQueue.mediaJobEvents.off('completed', onCompleted);
    atomicWriteSpy.mockImplementation(storageWrite);
  });

  it('holds a completion that arrives during the cut away from both stores until it reopens', async () => {
    const jobId = await startJob();
    const release = await boundary.acquireBackupSnapshotCut();
    renderFinishes(jobId);
    // Unadmitted, the completion persists within a few milliseconds of real file I/O.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(mediaJobQueue.getJob(jobId).status).toBe('running');
    expect(capture(jobId)).toEqual({ files: [`${jobId}.mp4`], queueStatus: 'running', rows: new Map() });
    release();
    await waitFor(() => mediaJobQueue.getJob(jobId).status === 'completed');
    await waitFor(() => rows.has(jobId));
    expect(capture(jobId)).toEqual({ files: [`${jobId}.mp4`], queueStatus: 'completed', rows: new Map([[jobId, `${jobId}.mp4`]]) });
  });

  it('says why a finished render waits while the backup cut holds admission, without alarming stderr', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let release;
    try {
      const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'synthetic' } });
      await vi.waitFor(() => expect(stubs.generateVideo).toHaveBeenCalledTimes(1));
      await flush();
      release = await boundary.acquireBackupSnapshotCut();
      renderFinishes(jobId);
      // One notice interval: the hold repeats its reason every minute while the cut is open.
      await vi.advanceTimersByTimeAsync(61_000);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('media-job completion waiting for the backup to finish'));
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('waiting for the backup'));
    } finally {
      release?.();
      await flush();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('releases a finished provider lane after admission times out and recovers its pending result', async () => {
    vi.useFakeTimers();
    const completed = vi.fn();
    mediaJobQueue.mediaJobEvents.on('completed', completed);
    let release;
    let finishProvider;
    stubs.generateVideo.mockImplementationOnce(() => new Promise(resolve => { finishProvider = resolve; }));
    try {
      const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'synthetic' } });
      await vi.waitFor(() => expect(stubs.generateVideo).toHaveBeenCalledTimes(1));
      await flush();
      release = await boundary.acquireBackupSnapshotCut();
      renderFinishes(jobId);
      await vi.advanceTimersByTimeAsync(0);
      // Jump to the final notice interval instead of executing an hour of worker ticks.
      vi.setSystemTime(Date.now() + 59 * 60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      const pending = { status: 'completed', result: { filename: `${jobId}.mp4` } };
      await vi.waitFor(() => expect(mediaJobQueue.getJob(jobId)).toMatchObject({ status: 'running', durabilityPending: pending }));
      expect(mediaJobQueue.getRunningJob().id).toBe(jobId);
      finishProvider({});
      await vi.waitFor(() => expect(mediaJobQueue.getRunningJob()).toBeNull());
      expect(persistedJobs().find(j => j.id === jobId)).toMatchObject({ status: 'running', durabilityPending: pending });
      expect(completed).not.toHaveBeenCalled();
      expect(rows.size).toBe(0);
      const { sanitizeJob } = await import('./sanitizeJob.js');
      const publicJob = sanitizeJob(mediaJobQueue.getJob(jobId));
      expect(publicJob.durabilityPending).toBeUndefined();
      expect(publicJob.result).toBeUndefined();

      const next = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'next synthetic' } });
      await vi.waitFor(() => expect(stubs.generateVideo).toHaveBeenCalledTimes(2));
      expect(mediaJobQueue.getRunningJob().id).toBe(next.jobId);
      release();
      release = null;
      await flush();
      await vi.waitFor(() => expect(rows.get(jobId)).toBe(`${jobId}.mp4`));
      expect(completed).toHaveBeenCalledTimes(1);
      expect(mediaJobQueue.getJob(jobId)).toMatchObject({ status: 'completed', result: pending.result });
      expect(mediaJobQueue.getJob(jobId).durabilityPending).toBeUndefined();
      renderFinishes(next.jobId);
      await flush();
      await expect(mediaJobQueue.flushMediaJobQueue()).resolves.toEqual({ ok: true });
      const { maintenance } = await import('../../lib/maintenanceAdmission.js');
      expect(maintenance.status().blockers).toEqual([]);
    } finally {
      finishProvider?.({});
      release?.();
      await flush();
      vi.clearAllTimers();
      vi.useRealTimers();
      mediaJobQueue.mediaJobEvents.off('completed', completed);
    }
  });

  it.each([false, true])('restores a pending completion without replay or premature publication (uncertain ownership: %s)', async (uncertain) => {
    const jobId = '00000000-0000-4000-8000-000000000091';
    const result = { filename: `${jobId}.mp4` };
    const { maintenance } = await import('../../lib/maintenanceAdmission.js');
    const permit = maintenance.admit('media', jobId);
    if (uncertain) permit.markUnsettled();
    writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify({ jobs: [{
      id: jobId, kind: 'video', status: 'running', params: { prompt: 'synthetic' },
      durabilityPending: { status: 'completed', result, progress: 1, statusMsg: 'Completed', completedAt: new Date().toISOString() },
    }] }));
    const release = await boundary.acquireBackupSnapshotCut();
    try {
      await mediaJobQueue.initMediaJobQueue();
      expect(mediaJobQueue.getJob(jobId)).toMatchObject({ status: 'running', durabilityPending: { status: 'completed', result } });
      expect(mediaJobQueue.getRunningJob()).toBeNull();
      expect(persistedJobs()[0]).toMatchObject({ status: 'running', durabilityPending: { result } });
      expect(rows.size).toBe(0);
      expect(stubs.generateVideo).not.toHaveBeenCalled();
    } finally {
      release();
    }
    await flush();
    await waitFor(() => rows.has(jobId));
    expect(mediaJobQueue.getJob(jobId)).toMatchObject({ status: 'completed', result });
    expect(mediaJobQueue.getJob(jobId).error).toBeUndefined();
    expect(persistedJobs()[0]).toMatchObject({ status: 'completed', result });
    expect(persistedJobs()[0].durabilityPending).toBeUndefined();
    expect(stubs.generateVideo).not.toHaveBeenCalled();
    expect(maintenance.status().blockers).toEqual(uncertain
      ? [expect.objectContaining({ resource: jobId, unsettled: true })] : []);
  });

  it('waits for boot hook registration before recovering a receipt with admission already open', async () => {
    const jobId = '00000000-0000-4000-8000-000000000092';
    const result = { filename: `${jobId}.mp4` };
    writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify({ jobs: [{
      id: jobId, kind: 'video', status: 'running', params: { prompt: 'synthetic' },
      durabilityPending: { status: 'completed', result, completedAt: new Date().toISOString() },
    }] }));
    mediaJobQueue.mediaJobEvents.off('completed', onCompleted);
    const completed = vi.fn();
    const { runPostRouteSequence } = await import('../bootstrapSequence.js');
    const noWork = async () => {};
    const onFatal = vi.fn();
    let beforeHooks;
    await runPostRouteSequence({
      startBackgroundServices: noWork, ensureSelf: noWork, initSyncLog: noWork,
      recoverStuckClassifications: noWork, recoverInterruptedRepoClones: noWork,
      initMediaJobQueue: mediaJobQueue.initMediaJobQueue,
      initLoraTraining: async () => {
        await mediaJobQueue.flushMediaJobQueue();
        beforeHooks = { job: persistedJobs()[0], rowCount: rows.size };
      },
      initMediaJobDependentHooks: () => {
        mediaJobQueue.mediaJobEvents.on('completed', onCompleted);
        mediaJobQueue.mediaJobEvents.on('completed', completed);
      },
      resumeMediaJobCompletions: mediaJobQueue.resumeMediaJobCompletions,
      initSharing: noWork, recoverCreativeDirectorProjects: noWork,
      runDatabasePhase: noWork, loadSeriesCoverBackfill: async () => noWork,
      startListening: noWork, onFatal,
    });
    await flush();
    await waitFor(() => rows.has(jobId));
    expect(onFatal).not.toHaveBeenCalled();
    expect(beforeHooks).toMatchObject({ job: { status: 'running', durabilityPending: { result } }, rowCount: 0 });
    expect(completed).toHaveBeenCalledTimes(1);
    expect(mediaJobQueue.getJob(jobId)).toMatchObject({ status: 'completed', result });
    expect(stubs.generateVideo).not.toHaveBeenCalled();
    mediaJobQueue.mediaJobEvents.off('completed', completed);
  });

  it('drains a completion already publishing its queue row and hook rows before the cut', async () => {
    let finishWrite;
    const writeGate = new Promise((resolve) => { finishWrite = resolve; });
    let finishHook;
    hookGate = new Promise((resolve) => { finishHook = resolve; });
    let writeHeld = false;
    atomicWriteSpy.mockImplementation(async (path, data) => {
      if (data?.jobs?.some((j) => j.status === 'completed')) {
        writeHeld = true;
        await writeGate;
      }
      return storageWrite(path, data);
    });
    const jobId = await startJob();
    renderFinishes(jobId);
    await waitFor(() => writeHeld);
    let cutReady = false;
    const cut = boundary.acquireBackupSnapshotCut().then((release) => { cutReady = true; return release; });
    await settle();
    expect(cutReady).toBe(false);
    finishWrite();
    await waitFor(() => hookStarted);
    await settle();
    expect(cutReady).toBe(false);
    finishHook();
    const release = await cut;
    expect(capture(jobId)).toEqual({ files: [`${jobId}.mp4`], queueStatus: 'completed', rows: new Map([[jobId, `${jobId}.mp4`]]) });
    release();
  });

  it('retries a failed terminal write inside the same admission and releases it after final failure', async () => {
    const retried = await startJob();
    failTerminalWrites(1, 'EBUSY');
    renderFinishes(retried);
    await waitFor(() => rows.has(retried));
    expect(capture(retried).queueStatus).toBe('completed');
    (await boundary.acquireBackupSnapshotCut())();
  });

  it('releases admission after a terminal write fails for good, leaving no half-published outcome', async () => {
    const failed = await startJob();
    const failures = failTerminalWrites(1);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderFinishes(failed);
    try {
      await waitFor(() => failures.count === 1);
      await settle();
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining(`media-job [${failed.slice(0, 8)}] terminal handler failed:`));
      // The abandoned publication holds nothing: a cut opens at once and sees no half-written outcome.
      const release = await boundary.acquireBackupSnapshotCut({ timeoutMs: 50 });
      expect(capture(failed)).toEqual({ files: [`${failed}.mp4`], queueStatus: 'running', rows: new Map() });
      release();
    } finally {
      errorLog.mockRestore();
    }
  });

  it('recovers an abandoned completion only under admission, never from a write landing mid-cut', async () => {
    const recovered = await startJob();
    const failures = failTerminalWrites(1);
    renderFinishes(recovered);
    await waitFor(() => failures.count === 1);
    await settle();
    const release = await boundary.acquireBackupSnapshotCut({ timeoutMs: 50 });
    // Storage is writable again and an unrelated queue write lands during the cut.
    await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'unrelated' } });
    mediaJobQueue.quiesceMediaJobQueue();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(mediaJobQueue.getJob(recovered).status).toBe('running');
    expect(capture(recovered)).toEqual({ files: [`${recovered}.mp4`], queueStatus: 'running', rows: new Map() });
    release();
    await waitFor(() => rows.has(recovered));
    expect(capture(recovered)).toEqual({
      files: [`${recovered}.mp4`], queueStatus: 'completed', rows: new Map([[recovered, `${recovered}.mp4`]]),
    });
  });
  it('shutdown flush waits on a recovery commit held behind an open cut and reports its failure on timeout', async () => {
    const recovered = await startJob();
    const failures = failTerminalWrites(1);
    renderFinishes(recovered);
    await waitFor(() => failures.count === 1);
    await settle();
    const release = await boundary.acquireBackupSnapshotCut({ timeoutMs: 50 });
    await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'unrelated' } });
    mediaJobQueue.quiesceMediaJobQueue();
    const flushed = await mediaJobQueue.flushMediaJobQueue({ timeoutMs: 200 });
    expect(flushed).toMatchObject({ ok: false, timedOut: true });
    release();
    await waitFor(() => rows.has(recovered));
    await expect(mediaJobQueue.flushMediaJobQueue()).resolves.toEqual({ ok: true });
  });
});

// Characterization of the per-kind runtime wiring (module entry point, event
// bus, progress verb, idle-watchdog window). A kind added to JOB_KINDS must
// declare all four; this pins what each existing kind does today, including the
// inherited default window/verb of html-composition and supercollider.
describe('mediaJobQueue per-kind runtime wiring', () => {
  const WINDOWS = { VIDEO: 4000, TRAINING: 6000, AUDIO: 8000, IMAGE: 10000 };
  const KIND_CASES = [
    { kind: 'video', params: {}, entry: 'generateVideo', bus: 'video', verb: 'Rendering', window: WINDOWS.VIDEO },
    { kind: 'video-upscale', params: {}, entry: 'runVideoUpscale', bus: 'video', verb: 'Upscaling', window: WINDOWS.VIDEO },
    { kind: 'video-stitch', params: {}, entry: 'runVideoStitch', bus: 'video', verb: 'Stitching', window: WINDOWS.VIDEO },
    { kind: 'video-sharing', params: { sharingProjectId: 'mv-example', renderHistoryId: 'final-example', sourceHash: 'a'.repeat(64) },
      entry: 'runSharingCopy', bus: 'video', verb: 'Generating', window: WINDOWS.VIDEO },
    { kind: 'html-composition', params: { directory: 'compositions/example' }, entry: 'renderComposition', bus: 'video', verb: 'Generating', window: WINDOWS.IMAGE },
    { kind: 'image', params: {}, entry: 'generateImage', bus: 'image', verb: 'Generating', window: WINDOWS.IMAGE },
    { kind: 'audio', params: {}, entry: 'generateAudio', bus: 'audio', verb: 'Generating', window: WINDOWS.AUDIO },
    { kind: 'supercollider', params: {}, entry: 'renderSuperCollider', bus: 'audio', verb: 'Generating', window: WINDOWS.IMAGE },
  ];
  const busFor = async (name) => ({
    video: videoGenEvents,
    image: imageGenEvents,
    audio: audioGenEvents,
    training: (await import('../loraTraining/events.js')).trainingEvents,
  })[name];

  it('covers every newly dispatchable kind; historical training is recovery-only', () => {
    expect(KIND_CASES.map(c => c.kind).sort()).toEqual(mediaJobQueue.JOB_KINDS.filter(kind => kind !== 'training').sort());
  });

  describe.each(KIND_CASES)('$kind', ({ kind, params, entry, bus, verb, window }) => {
    afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

    it('invokes its entry point and renders progress from its own event bus', async () => {
      const { jobId } = await mediaJobQueue.enqueueJob({ kind, params: { prompt: 'example', ...params } });
      await waitFor(() => stubs[entry].mock.calls.length === 1);
      expect(stubs[entry]).toHaveBeenCalledWith(expect.objectContaining({ jobId }));
      // The three other buses must not move this job; only its own does.
      for (const other of ['video', 'image', 'audio', 'training'].filter(b => b !== bus)) {
        (await busFor(other)).emit('progress', { generationId: jobId, progress: 0.1, step: 1, totalSteps: 4 });
      }
      expect(mediaJobQueue.getJob(jobId).statusMsg).not.toMatch(/step/);
      (await busFor(bus)).emit('progress', { generationId: jobId, progress: 0.5, step: 2, totalSteps: 4 });
      expect(mediaJobQueue.getJob(jobId).statusMsg).toBe(`${verb} step 2/4`);
    });

    it('trips the idle watchdog at its own window', async () => {
      vi.useFakeTimers();
      process.env.MEDIA_JOB_WATCHDOG_VIDEO_MS = String(WINDOWS.VIDEO);
      process.env.MEDIA_JOB_WATCHDOG_TRAINING_MS = String(WINDOWS.TRAINING);
      process.env.MEDIA_JOB_WATCHDOG_AUDIO_MS = String(WINDOWS.AUDIO);
      process.env.MEDIA_JOB_WATCHDOG_IMAGE_MS = String(WINDOWS.IMAGE);
      await importFresh();
      // Await actual provider entry without advancing fake watchdog time or
      // imposing a separate wall-clock deadline on asynchronous setup.
      let signalEntered;
      const entered = new Promise(resolve => { signalEntered = resolve; });
      stubs[entry].mockImplementationOnce(async () => {
        signalEntered();
        return { jobId: 'whatever' };
      });
      let jobId;
      try {
        ({ jobId } = await mediaJobQueue.enqueueJob({ kind, params: { prompt: 'hang', ...params } }));
        await entered;
        expect(stubs[entry]).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(window - 100);
        await flush();
        expect(mediaJobQueue.getJob(jobId).status).toBe('running');
        // One watchdog tick is at most window/4 (capped at 30s) after the limit.
        await vi.advanceTimersByTimeAsync(Math.floor(window / 4) + 200);
        await flush();
        await vi.waitFor(() => expect(mediaJobQueue.getJob(jobId)).toMatchObject({
          status: 'failed', error: expect.stringMatching(/watchdog timeout/),
        }));
      } finally {
        for (const name of ['VIDEO', 'TRAINING', 'AUDIO', 'IMAGE']) delete process.env[`MEDIA_JOB_WATCHDOG_${name}_MS`];
        if (jobId) {
          for (const name of ['video', 'image', 'audio', 'training']) (await busFor(name)).emit('failed', { generationId: jobId, error: 'Fixture teardown' });
        }
        await flush();
      }
    });
  });

  it('scales the video watchdog by chunk count and gives a chained render its own entry point', async () => {
    vi.useFakeTimers();
    process.env.MEDIA_JOB_WATCHDOG_VIDEO_MS = '4000';
    await importFresh();
    let jobId;
    try {
      ({ jobId } = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'hang', chunks: 3 } }));
      await vi.waitFor(() => expect(stubs.generateChainedVideo).toHaveBeenCalledTimes(1), { interval: 1 });
      expect(stubs.generateVideo).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(4000 * 3 - 100);
      await flush();
      expect(mediaJobQueue.getJob(jobId).status).toBe('running');
      await vi.advanceTimersByTimeAsync(4000 * 3 / 4 + 200);
      await flush();
      await vi.waitFor(() => expect(mediaJobQueue.getJob(jobId).status).toBe('failed'));
    } finally {
      delete process.env.MEDIA_JOB_WATCHDOG_VIDEO_MS;
      if (jobId) videoGenEvents.emit('failed', { generationId: jobId, error: 'Fixture teardown' });
      await flush();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe('provider quota cooldowns', () => {
  // Verbatim from this install on 2026-10-17 (redacted of nothing — it carries
  // no private state). The duration is the only machine-readable part.
  const QUOTA_ERROR = 'Agy did not produce an image at the directed path. Agy said: "The `generate_image` tool failed due to a rate-limit / quota exhaustion error: `429 RESOURCE_EXHAUSTED: "You have exhausted your capacity on this model. Your quota will reset after 2h26m1s."`"';

  // No local beforeEach: the file-level one already gives each test a fresh
  // temp data dir and a fresh module instance, so the cooldown map starts
  // empty. Re-importing here would reset modules mid-setup.

  it('holds a later render for the same backend instead of dispatching it into the same 429', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubs.generateImageCodex.mockImplementation(() => new Promise(() => {}));
    const first = await mediaJobQueue.enqueueJob({ kind: 'image', params: { mode: 'codex', prompt: 'page 1' } });
    await waitFor(() => stubs.generateImageCodex.mock.calls.length === 1);

    imageGenEvents.emit('failed', { generationId: first.jobId, error: QUOTA_ERROR });
    await waitFor(() => mediaJobQueue.getJob(first.jobId)?.status === 'failed');

    const second = await mediaJobQueue.enqueueJob({ kind: 'image', params: { mode: 'codex', prompt: 'page 2' } });
    await waitFor(() => (mediaJobQueue.getJob(second.jobId)?.statusMsg || '').startsWith('Waiting for codex quota'));

    // The point of the whole change: it is still queued, not burned.
    expect(mediaJobQueue.getJob(second.jobId).status).toBe('queued');
    expect(stubs.generateImageCodex).toHaveBeenCalledTimes(1);
    expect(mediaJobQueue.getJob(second.jobId).statusMsg).toMatch(/resumes at /);
    // Holding for the provider's quota window is the designed handling: stdout, not stderr.
    expect(log).toHaveBeenCalledWith(expect.stringContaining('codex quota exhausted — holding queued codex renders'));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('quota exhausted'));
  });

  it('keeps one hold message for the window, then promotes the job without it once the reset passes', async () => {
    // Resolve so the first render releases its cloud slot once it fails.
    stubs.generateImageCodex.mockResolvedValue({ jobId: 'codex-job' });
    const first = await mediaJobQueue.enqueueJob({ kind: 'image', params: { mode: 'codex', prompt: 'page 1' } });
    await waitFor(() => stubs.generateImageCodex.mock.calls.length === 1);
    imageGenEvents.emit('failed', { generationId: first.jobId, error: QUOTA_ERROR });
    await waitFor(() => mediaJobQueue.getJob(first.jobId)?.status === 'failed');

    const second = await mediaJobQueue.enqueueJob({ kind: 'image', params: { mode: 'codex', prompt: 'page 2' } });
    await waitFor(() => (mediaJobQueue.getJob(second.jobId)?.statusMsg || '').startsWith('Waiting for codex quota'));
    const waiting = mediaJobQueue.getJob(second.jobId).statusMsg;
    // A later scan in the same window must not rewrite (and re-persist) it.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(mediaJobQueue.getJob(second.jobId).statusMsg).toBe(waiting);

    const realNow = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow + 3 * 60 * 60 * 1000);
    try {
      await waitFor(() => mediaJobQueue.getJob(second.jobId)?.status === 'running');
      expect(mediaJobQueue.getJob(second.jobId).statusMsg).toBe('Starting');
    } finally {
      clock.mockRestore();
    }
  });

  it('leaves a different backend free to run during another backend\'s cooldown', async () => {
    stubs.generateImageCodex.mockImplementation(() => new Promise(() => {}));
    const first = await mediaJobQueue.enqueueJob({ kind: 'image', params: { mode: 'codex', prompt: 'page 1' } });
    await waitFor(() => stubs.generateImageCodex.mock.calls.length === 1);
    imageGenEvents.emit('failed', { generationId: first.jobId, error: QUOTA_ERROR });
    await waitFor(() => mediaJobQueue.getJob(first.jobId)?.status === 'failed');

    stubs.generateImage.mockImplementation(() => new Promise(() => {}));
    const local = await mediaJobQueue.enqueueJob({ kind: 'image', params: { mode: 'local', prompt: 'page 2' } });
    await waitFor(() => stubs.generateImage.mock.calls.length === 1);
    expect(mediaJobQueue.getJob(local.jobId).status).toBe('running');
  });

  it('does not hold anything for an ordinary failure that states no reset', async () => {
    // Resolve rather than hang: the lane is released by the gen call settling,
    // so a hanging stub would keep the cloud slot and mask the assertion.
    stubs.generateImageCodex.mockResolvedValue({ jobId: 'codex-job' });
    const first = await mediaJobQueue.enqueueJob({ kind: 'image', params: { mode: 'codex', prompt: 'page 1' } });
    await waitFor(() => stubs.generateImageCodex.mock.calls.length === 1);
    imageGenEvents.emit('failed', { generationId: first.jobId, error: 'Agy generation failed: Exit code 1' });
    await waitFor(() => mediaJobQueue.getJob(first.jobId)?.status === 'failed');
    await flush();

    const second = await mediaJobQueue.enqueueJob({ kind: 'image', params: { mode: 'codex', prompt: 'page 2' } });
    await waitFor(() => stubs.generateImageCodex.mock.calls.length === 2);
    expect(mediaJobQueue.getJob(second.jobId).status).toBe('running');
  });

  it('keeps the cooldown across a restart so a reboot does not release the queue early', async () => {
    stubs.generateImageCodex.mockResolvedValue({ jobId: 'codex-job' });
    const first = await mediaJobQueue.enqueueJob({ kind: 'image', params: { mode: 'codex', prompt: 'page 1' } });
    await waitFor(() => stubs.generateImageCodex.mock.calls.length === 1);
    imageGenEvents.emit('failed', { generationId: first.jobId, error: QUOTA_ERROR });
    await waitFor(() => mediaJobQueue.getJob(first.jobId)?.status === 'failed');
    await flush();

    const persisted = JSON.parse(readFileSync(join(tempDataDir, 'media-jobs.json'), 'utf8'));
    expect(persisted.quotaCooldowns).toEqual([['codex', expect.any(Number)]]);

    stubs.generateImageCodex.mockClear();
    await importFresh();
    // The restart itself: init is what re-reads the snapshot.
    await mediaJobQueue.initMediaJobQueue();
    const second = await mediaJobQueue.enqueueJob({ kind: 'image', params: { mode: 'codex', prompt: 'page 2' } });
    await waitFor(() => (mediaJobQueue.getJob(second.jobId)?.statusMsg || '').startsWith('Waiting for codex quota'));
    expect(stubs.generateImageCodex).not.toHaveBeenCalled();
  });
});
