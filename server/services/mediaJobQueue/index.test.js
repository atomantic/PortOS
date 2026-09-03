import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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
        return actual.PATHS[key];
      },
    }),
    atomicWrite: (...args) => atomicWriteSpy(...args),
  };
});

// Mock the gen modules so the worker's dynamic imports return controllable
// stubs. The dispatcher relies on videoGenEvents / imageGenEvents to fire
// 'completed' or 'failed' for the worker to advance — we drive those events
// directly from each test.
const stubs = {
  generateVideo: vi.fn(async () => ({
tryReadFile: vi.fn().mockResolvedValue(null), jobId: 'whatever' })),
  generateVideoGrok: vi.fn(async () => ({ jobId: 'whatever' })),
  generateChainedVideo: vi.fn(async () => ({ jobId: 'whatever' })),
  generateImage: vi.fn(async () => ({ jobId: 'whatever' })),
  generateImageCodex: vi.fn(async () => ({ jobId: 'whatever' })),
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
};

vi.mock('../videoGen/local.js', () => ({
  generateVideo: (...args) => stubs.generateVideo(...args),
  generateChainedVideo: (...args) => stubs.generateChainedVideo(...args),
  cancel: (...args) => stubs.cancelVideo(...args),
}));

vi.mock('../videoGen/grok.js', () => ({
  generateVideo: (...args) => stubs.generateVideoGrok(...args),
  cancel: (...args) => stubs.cancelVideo(...args),
}));

vi.mock('../imageGen/local.js', () => ({
  generateImage: (...args) => stubs.generateImage(...args),
  cancel: (...args) => stubs.cancelImage(...args),
}));

vi.mock('../imageGen/codex.js', () => ({
  generateImage: (...args) => stubs.generateImageCodex(...args),
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

async function importFresh() {
  vi.resetModules();
  mediaJobQueue = await import('./index.js');
  videoGenEvents = (await import('../videoGen/events.js')).videoGenEvents;
  imageGenEvents = (await import('../imageGenEvents.js')).imageGenEvents;
  audioGenEvents = (await import('../audioGen/events.js')).audioGenEvents;
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

beforeEach(async () => {
  tempDataDir = mkdtempSync(join(tmpdir(), 'mediaJobQueue-test-'));
  Object.values(stubs).forEach((fn) => fn.mockReset());
  // Default codex stub: hang (matches video/local defaults so tests that
  // don't care about codex don't accidentally complete too fast).
  stubs.generateImageCodex.mockImplementation(() => new Promise(() => {}));
  // #1332 training stubs lose their implementations on mockReset above; restore
  // safe defaults (no survivor; runTraining hangs so a re-attached run stays
  // 'running'). Individual tests override hasSurvivingTrainer as needed.
  stubs.runTraining.mockImplementation(() => new Promise(() => {}));
  stubs.hasSurvivingTrainer.mockResolvedValue(false);
  await importFresh();
});

afterEach(async () => {
  await flush();
  mediaJobQueue?.__resetForTests();
  if (tempDataDir && existsSync(tempDataDir)) {
    rmSync(tempDataDir, { recursive: true, force: true });
  }
});

describe('mediaJobQueue', () => {
  it('enqueueJob returns jobId + queued status + position', () => {
    // Block the worker so the second enqueue lands behind the first in the
    // pipeline rather than entering an empty queue after the first ran.
    stubs.generateVideo.mockImplementation(() => new Promise(() => {}));
    const r1 = mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'a' } });
    const r2 = mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'b' } });
    expect(r1.status).toBe('queued');
    expect(r1.jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r1.position).toBe(1);
    expect(r2.position).toBe(2);
  });

  describe('getQueueCapacity', () => {
    it('separates the serialized GPU lane from the parallel remote lane', async () => {
      // Both lanes run concurrently, so a remote job must NOT be reported as
      // waiting behind the local GPU render — that conflation is what made two
      // idle peers each read as busy while waiting on the other.
      stubs.generateVideo.mockImplementation(() => new Promise(() => {}));
      stubs.generateAudioRemote.mockImplementation(() => new Promise(() => {}));
      mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'local' } });
      mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'waiting' } });
      mediaJobQueue.enqueueJob({
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
      const local = mediaJobQueue.enqueueJob({ kind: 'video', params: { mode: 'text', prompt: 'local' } });
      const grok = mediaJobQueue.enqueueJob({
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
      mediaJobQueue.enqueueJob({ kind: 'video', params: {} });
      mediaJobQueue.enqueueJob({ kind: 'video', params: {} });
      mediaJobQueue.enqueueJob({ kind: 'image', params: {} });
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
      expect(mediaJobQueue.laneConcurrencyFor({
        kind: 'audio', params: { remoteMedia: remoteMediaParams() },
      })).toBe(mediaJobQueue.REMOTE_MEDIA_PARALLEL_LIMIT);
    });

    it('tracks the cloud lane limit as configured rather than a snapshot of it', () => {
      mediaJobQueue.setCodexParallelLimit(5);
      expect(mediaJobQueue.laneConcurrencyFor({
        kind: 'image', params: { mode: IMAGE_GEN_MODE.CODEX },
      })).toBe(5);
    });
  });

  it('rejects unknown kinds', () => {
    expect(() => mediaJobQueue.enqueueJob({ kind: 'bogus', params: {} })).toThrow(/invalid kind/);
  });

  it('listJobs filters by kind / status / owner', async () => {
    // Pin the first dequeued job in 'running' indefinitely so the rest of
    // the assertions see the queue + running set we expect.
    stubs.generateVideo.mockImplementation(() => new Promise(() => {}));
    stubs.generateImage.mockImplementation(() => new Promise(() => {}));
    mediaJobQueue.enqueueJob({ kind: 'video', params: {}, owner: 'creative-director:cd-1' });
    mediaJobQueue.enqueueJob({ kind: 'image', params: {}, owner: 'voice' });
    mediaJobQueue.enqueueJob({ kind: 'video', params: {}, owner: 'creative-director:cd-2' });
    expect(mediaJobQueue.listJobs({ kind: 'video' })).toHaveLength(2);
    expect(mediaJobQueue.listJobs({ kind: 'image' })).toHaveLength(1);
    expect(mediaJobQueue.listJobs({ owner: 'voice' })).toHaveLength(1);
    // One job is 'running' (worker dequeued it), the other two are still 'queued'.
    expect(mediaJobQueue.listJobs({ status: 'queued' })).toHaveLength(2);
    expect(mediaJobQueue.listJobs({ status: 'running' })).toHaveLength(1);
  });

  it('cancelQueuedJobs cancels every queued job, leaves running ones alone', async () => {
    // Block the worker so subsequent enqueues stay queued.
    let resolveBlocker;
    stubs.generateVideo.mockImplementation(() => new Promise((r) => { resolveBlocker = r; }));
    const blocker = mediaJobQueue.enqueueJob({ kind: 'video', params: {} });
    const a = mediaJobQueue.enqueueJob({ kind: 'video', params: {} });
    const b = mediaJobQueue.enqueueJob({ kind: 'image', params: {} });
    const c = mediaJobQueue.enqueueJob({ kind: 'video', params: {} });

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

  it('cancelQueuedJobs respects a kind filter', async () => {
    let resolveBlocker;
    stubs.generateVideo.mockImplementation(() => new Promise((r) => { resolveBlocker = r; }));
    const blocker = mediaJobQueue.enqueueJob({ kind: 'video', params: {} });
    const v = mediaJobQueue.enqueueJob({ kind: 'video', params: {} });
    const i = mediaJobQueue.enqueueJob({ kind: 'image', params: {} });

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
    const blocker = mediaJobQueue.enqueueJob({ kind: 'video', params: {} });
    const target = mediaJobQueue.enqueueJob({ kind: 'video', params: {} });

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

  it('worker drains a queued video job and marks it completed on the gen completed event', async () => {
    const job = mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'hi' } });
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
  });

  it('progress/status events update the live job record for non-SSE readers', async () => {
    const file = join(tempDataDir, 'media-jobs.json');
    const job = mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'progress please' } });
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
    const job = mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'how long' } });
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
    const job = mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'metrics' } });
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
    const job = mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'what are you doing' } });
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

  it('debounce-persists live progress before a terminal transition', async () => {
    const file = join(tempDataDir, 'media-jobs.json');
    const job = mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'restart snapshot' } });
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
    const job = mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'burst' } });
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

  it('cancel during the terminal drain window is refused, not "canceling"', async () => {
    const job = mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'finishing race' } });
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
    const job = mediaJobQueue.enqueueJob({ kind: 'video', params: {} });
    await waitFor(() => existsSync(file));
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
    const job = mediaJobQueue.enqueueJob({ kind: 'image', params: { prompt: 'hi' } });
    await waitFor(() => stubs.generateImage.mock.calls.length === 1);
    imageGenEvents.emit('failed', { generationId: job.jobId, error: 'OOM' });
    await waitFor(() => mediaJobQueue.getJob(job.jobId).status === 'failed');

    const failed = mediaJobQueue.getJob(job.jobId);
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('OOM');
  });

  it('pre-gen sanitizer nulls uploadedTempPath that resolves outside PATHS.uploads', async () => {
    // Any path that is not under the uploads root should be nulled out so the
    // gen module never sees it (defense-in-depth against corrupted job params).
    const job = mediaJobQueue.enqueueJob({
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

  it('watchdog fires and marks the job failed when gen never emits a terminal event', async () => {
    // Use a very short watchdog for this test by overriding the env var before
    // the module is loaded. Re-import the module with MEDIA_JOB_WATCHDOG_VIDEO_MS=50.
    process.env.MEDIA_JOB_WATCHDOG_VIDEO_MS = '50';
    await importFresh();
    // generateVideo hangs forever — never emits completed/failed.
    stubs.generateVideo.mockImplementation(() => new Promise(() => {}));

    const job = mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'hang' } });
    await waitFor(() => stubs.generateVideo.mock.calls.length === 1);

    // The watchdog should fire within 50 ms and fail the job.
    await waitFor(() => mediaJobQueue.getJob(job.jobId)?.status === 'failed', { timeoutMs: 2000 });

    const failed = mediaJobQueue.getJob(job.jobId);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/watchdog timeout/);

    delete process.env.MEDIA_JOB_WATCHDOG_VIDEO_MS;
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

    const job = mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'double-terminal' } });
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

    const job = mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'guard' } });
    await waitFor(() => stubs.generateVideo.mock.calls.length === 1);

    // Wait a beat — long enough that a NaN-driven watchdog would have fired.
    await new Promise((r) => setTimeout(r, 100));
    expect(mediaJobQueue.getJob(job.jobId)?.status).toBe('running');

    delete process.env.MEDIA_JOB_WATCHDOG_VIDEO_MS;
  });
});

describe('Audio kind (#1928)', () => {
  it('dispatches an audio job to audioGen/local.js#generateAudio and completes', async () => {
    const job = mediaJobQueue.enqueueJob({
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

  it('runs remote audio in its own lane without occupying the local GPU', async () => {
    stubs.generateVideo.mockImplementation(() => new Promise(() => {}));
    stubs.generateAudioRemote.mockImplementation(() => new Promise(() => {}));

    const video = mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'local render' } });
    const remote = mediaJobQueue.enqueueJob({
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
    const remote = mediaJobQueue.enqueueJob({
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

  it('leaves a training job carrying a stray marker on the local path', () => {
    // Bypass probe for the normalization above: `training` has no federated
    // contract, so a marker on one is corrupt state — blanking its params would
    // destroy a real local run.
    const job = mediaJobQueue.enqueueJob({
      kind: 'training',
      params: { runId: 'run-1', runtime: 'mflux', modelId: 'dev', remoteMedia: remoteImageMediaParams() },
    });

    expect(mediaJobQueue.getJob(job.jobId).params.modelId).toBe('dev');
  });

  it('persists cancellation intent before signaling a running remote adapter', async () => {
    stubs.generateAudioRemote.mockImplementation(() => new Promise(() => {}));
    const remote = mediaJobQueue.enqueueJob({
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


  it('routes an image remote job to the remote adapter and the remote lane, not the GPU', async () => {
    stubs.generateImage.mockImplementation(() => new Promise(() => {}));
    stubs.generateImageRemote.mockImplementation(() => new Promise(() => {}));

    // A local image render occupies the single GPU slot; the federated one must
    // still start, because it renders on the peer's hardware.
    const local = mediaJobQueue.enqueueJob({ kind: 'image', params: { prompt: 'local render' } });
    const remote = mediaJobQueue.enqueueJob({
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

    const local = mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'local render' } });
    const remote = mediaJobQueue.enqueueJob({
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
  it('dispatches a Codex job to imageGen/codex.js#generateImage, not local', async () => {
    // Allow the codex job to resolve immediately so the worker can settle.
    stubs.generateImageCodex.mockResolvedValue({ jobId: 'whatever' });

    const job = mediaJobQueue.enqueueJob({
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

    const videoJob = mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'video' } });
    const codexJob = mediaJobQueue.enqueueJob({
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

  it('queued Codex job reports position within the Codex lane (not counting GPU jobs)', async () => {
    // GPU job hangs so the GPU slot is occupied but separate from the Codex lane.
    stubs.generateVideo.mockImplementation(() => new Promise(() => {}));
    // First Codex job hangs so a second Codex job lands in the queue.
    stubs.generateImageCodex.mockImplementation(() => new Promise(() => {}));

    // Enqueue one GPU video job (occupies the GPU lane, should not affect Codex positions).
    const videoJob = mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'video blocker' } });

    // First Codex job: worker picks it up immediately (codexRunning slot).
    const codex1 = mediaJobQueue.enqueueJob({
      kind: 'image',
      params: { prompt: 'codex first', mode: 'codex' },
    });

    // Wait until the first Codex job is actually running so codexRunning is set.
    await waitFor(() => stubs.generateImageCodex.mock.calls.length === 1);

    // Second Codex job: lands in queue behind the running Codex job (position 2 in Codex lane).
    const codex2 = mediaJobQueue.enqueueJob({
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

    const codex1 = mediaJobQueue.enqueueJob({
      kind: 'image', params: { prompt: 'codex first', mode: 'codex' },
    });
    await waitFor(() => stubs.generateImageCodex.mock.calls.length === 1);

    const codex2 = mediaJobQueue.enqueueJob({
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

  it('runJobNow rejects GPU (non-Codex) queued jobs with NOT_CODEX', async () => {
    // Block the GPU lane with one running job and queue a second so we have a
    // queued GPU job to attempt run-now on.
    stubs.generateVideo.mockImplementation(() => new Promise(() => {}));
    const v1 = mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'first' } });
    await waitFor(() => stubs.generateVideo.mock.calls.length === 1);
    const v2 = mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'second' } });
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
    const job = mediaJobQueue.enqueueJob({
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
    const job = mediaJobQueue.enqueueJob({
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
    const job = mediaJobQueue.enqueueJob({
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
    const job = mediaJobQueue.enqueueJob({
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
    const job = mediaJobQueue.enqueueJob({
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

    const job = mediaJobQueue.enqueueJob({
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
    mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'after a bad boot' } });
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
    const job = mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'good boot' } });
    await flush();
    const written = JSON.parse(readFileSync(file, 'utf8'));
    expect(written.jobs.map((j) => j.id)).toContain(job.jobId);
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
async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 30 } = {}) {
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

// Contract test for the helper above. The bug it guards (#5512) only surfaces
// under timing luck on a slow runner, so it is pinned deterministically here
// rather than left to the flake that found it. One short real timeout, not a
// repeated sleep.
describe('waitFor test helper (#5512)', () => {
  it('treats a throwing predicate as not-yet-true and keeps polling', async () => {
    let calls = 0;
    await waitFor(() => {
      calls += 1;
      if (calls < 3) throw new Error('ENOENT: no such file or directory');
      return true;
    }, { timeoutMs: 1000, intervalMs: 1 });
    expect(calls).toBe(3);
  });

  it('still fails loudly on timeout, naming the predicate and the last error', async () => {
    await expect(waitFor(
      () => { throw new Error('ENOENT: no such file or directory'); },
      { timeoutMs: 20, intervalMs: 5 },
    )).rejects.toThrow(/never became true within 20ms.*last error: ENOENT/s);
  });

  it('reports a cleanly-false predicate without inventing an error', async () => {
    await expect(waitFor(() => false, { timeoutMs: 20, intervalMs: 5 }))
      .rejects.toThrow(/never became true within 20ms(?!.*last error)/s);
  });
});
