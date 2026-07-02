import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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
  generateChainedVideo: vi.fn(async () => ({ jobId: 'whatever' })),
  generateImage: vi.fn(async () => ({ jobId: 'whatever' })),
  generateImageCodex: vi.fn(async () => ({ jobId: 'whatever' })),
  generateAudio: vi.fn(async () => ({ jobId: 'whatever' })),
  cancelVideo: vi.fn(),
  cancelImage: vi.fn(),
  cancelImageCodex: vi.fn(),
  cancelAudio: vi.fn(),
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

const flush = () => new Promise((r) => setTimeout(r, 250));

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
    // CLAUDE.md forbids. We pin the coalescing by counting atomicWrite calls
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

    audioGenEvents.emit('completed', { generationId: job.jobId, filename: `${job.jobId}.wav`, durationSec: 12 });
    await waitFor(() => mediaJobQueue.getJob(job.jobId)?.status === 'completed');

    const settled = mediaJobQueue.getJob(job.jobId);
    expect(settled.result).toEqual({ generationId: job.jobId, filename: `${job.jobId}.wav`, durationSec: 12 });
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

async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 30 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor: predicate never became true within timeout');
}
