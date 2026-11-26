// mediaJobQueue suite (#16215 split): Backup snapshot admission for media completion, per-kind runtime wiring and provider quota cooldowns.
// Shared mocks, stubs and per-test lifecycle live in ./index.test.fixture.js,
// which must stay the first import that can resolve a mocked module.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tempDataDir, atomicWriteSpy, queueSnapshotJobs, currentAdmission, stubs, mediaJobQueue, videoGenEvents, imageGenEvents, audioGenEvents, importFresh, flush, waitFor, persistedJobs } from './index.test.fixture.js';
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { once } from 'node:events';

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
      if (failures.remaining > 0 && queueSnapshotJobs(path, data).some((j) => j.status === 'completed')) {
        failures.remaining -= 1;
        failures.count += 1;
        throw Object.assign(new Error(code === 'ENOSPC' ? 'disk full' : 'destination busy'), { code });
      }
      return storageWrite(path, data);
    });
    return failures;
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  // Settles once the next admitted publication is parked behind the open cut.
  // continueSettlement runs synchronously up to the cut wait, so its commit
  // has started by return only if it published through the cut.
  const nextPublicationParked = () => new Promise((resolve, reject) => {
    const continueSettlement = currentAdmission.continueSettlement;
    vi.spyOn(currentAdmission, 'continueSettlement').mockImplementationOnce((work, options) => {
      const result = continueSettlement(work, options);
      if (options?.hasStarted?.()) reject(new Error('A media publication started inside an open backup cut'));
      else resolve();
      return result;
    });
  });

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
    const parked = nextPublicationParked();
    renderFinishes(jobId);
    // Unadmitted, the completion would persist within a few milliseconds of real file I/O.
    await parked;
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
      id: jobId, kind: 'video', status: 'running', params: { prompt: 'synthetic', musicVideoProjectId: 'project-example' },
      durabilityPending: { status: 'completed', result, completedAt: new Date().toISOString() },
    }] }));
    mediaJobQueue.mediaJobEvents.off('completed', onCompleted);
    const completed = vi.fn();
    const { runPostRouteSequence } = await import('../bootstrapSequence.js');
    const { createMediaJobHookLoader } = await import('./hookRegistry.js');
    const loadHook = vi.fn(() => {
      mediaJobQueue.mediaJobEvents.on('completed', onCompleted);
      mediaJobQueue.mediaJobEvents.on('completed', completed);
    });
    const prepareTerminalHooks = createMediaJobHookLoader([[job => job.params.musicVideoProjectId, loadHook]]);
    const noWork = async () => {};
    const onFatal = vi.fn();
    let beforeHooks;
    await runPostRouteSequence({
      startBackgroundServices: noWork, ensureSelf: noWork, initSyncLog: noWork,
      recoverStuckClassifications: noWork, recoverInterruptedRepoClones: noWork,
      initMediaJobQueue: options => mediaJobQueue.initMediaJobQueue({ ...options, prepareTerminalHooks }),
      initLoraTraining: async () => {
        await mediaJobQueue.flushMediaJobQueue();
        beforeHooks = { job: persistedJobs()[0], rowCount: rows.size };
      },
      initMediaJobDependentHooks: () => expect(loadHook).not.toHaveBeenCalled(),
      recoverStoryboardRuns: noWork,
      resumeMediaJobCompletions: mediaJobQueue.resumeMediaJobCompletions,
      initSharing: noWork, recoverCreativeDirectorProjects: noWork,
      runDatabasePhase: noWork, loadSeriesCoverBackfill: async () => noWork,
      startListening: noWork, onFatal,
    });
    await flush();
    await waitFor(() => rows.has(jobId));
    expect(onFatal).not.toHaveBeenCalled();
    expect(beforeHooks).toMatchObject({ job: { status: 'running', durabilityPending: { result } }, rowCount: 0 });
    expect(loadHook).toHaveBeenCalledTimes(1);
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
      if (queueSnapshotJobs(path, data).some((j) => j.status === 'completed')) {
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
    // The successful write opens the recovery commit, which must wait out the cut.
    const parked = nextPublicationParked();
    // Storage is writable again and an unrelated queue write lands during the cut.
    await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'unrelated' } });
    mediaJobQueue.quiesceMediaJobQueue();
    await parked;
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
    { kind: 'video-vertical', params: {}, entry: 'runVideoVertical', bus: 'video', verb: 'Reframing', window: WINDOWS.VIDEO },
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

  it('does not count a host sleep as runner idle time', async () => {
    vi.useFakeTimers();
    process.env.MEDIA_JOB_WATCHDOG_IMAGE_MS = String(WINDOWS.IMAGE);
    await importFresh();
    let signalEntered;
    const entered = new Promise(resolve => { signalEntered = resolve; });
    stubs.generateImage.mockImplementationOnce(async () => {
      signalEntered();
      return { jobId: 'whatever' };
    });
    let jobId;
    try {
      ({ jobId } = await mediaJobQueue.enqueueJob({ kind: 'image', params: { prompt: 'hang' } }));
      await entered;
      await vi.advanceTimersByTimeAsync(WINDOWS.IMAGE / 2);
      // Wall clock jumps 15 minutes with no timer firing — what a laptop sleep
      // looks like to Node — then the first post-wake tick runs.
      vi.setSystemTime(Date.now() + 15 * 60 * 1000);
      await vi.advanceTimersByTimeAsync(Math.floor(WINDOWS.IMAGE / 4));
      await flush();
      expect(mediaJobQueue.getJob(jobId).status).toBe('running');
      // A genuinely silent runner still trips the watchdog after waking.
      await vi.advanceTimersByTimeAsync(WINDOWS.IMAGE + Math.floor(WINDOWS.IMAGE / 4));
      await flush();
      await vi.waitFor(() => expect(mediaJobQueue.getJob(jobId)).toMatchObject({
        status: 'failed', error: expect.stringMatching(/watchdog timeout/),
      }));
    } finally {
      delete process.env.MEDIA_JOB_WATCHDOG_IMAGE_MS;
      if (jobId) imageGenEvents.emit('failed', { generationId: jobId, error: 'Fixture teardown' });
      await flush();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
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

describe('media queue worker wakeups', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('sleeps without a timer while idle and dispatches on durable enqueue', async () => {
    await mediaJobQueue.initMediaJobQueue();
    expect(vi.getTimerCount()).toBe(0);
    const checks = vi.spyOn(currentAdmission, 'held');
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(checks).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      checks.mockRestore();
    }

    stubs.generateImage.mockResolvedValue({});
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'image', params: { prompt: 'frame' } });
    await flush();
    expect(stubs.generateImage).toHaveBeenCalledWith(expect.objectContaining({ jobId }));
    imageGenEvents.emit('completed', { generationId: jobId, filename: 'frame.png' });
  });

  it('dispatches on maintenance resume, limit changes and lane completion without a clock tick', async () => {
    stubs.generateImageGrok.mockResolvedValue({});
    const { hold } = currentAdmission.begin({ reason: 'Fixture hold', owner: 'Operator' });
    const enqueue = () => mediaJobQueue.enqueueJob({ kind: 'image', params: { mode: 'grok', prompt: 'frame' } });
    const first = await enqueue();
    const second = await enqueue();
    const third = await enqueue();
    await flush();
    expect(stubs.generateImageGrok).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    const triggerAndWaitForStart = async (trigger) => {
      const started = once(mediaJobQueue.mediaJobEvents, 'started');
      trigger();
      const [job] = await started;
      await flush();
      return job.id;
    };
    expect(await triggerAndWaitForStart(() => currentAdmission.resume({ id: hold.id, revision: hold.revision }))).toBe(first.jobId);
    expect(await triggerAndWaitForStart(() => mediaJobQueue.setParallelLimit('image', 'grok', 2))).toBe(second.jobId);
    expect(await triggerAndWaitForStart(() => imageGenEvents.emit('completed', {
      generationId: first.jobId, filename: 'first.png',
    }))).toBe(third.jobId);
  });

  it('interrupts a later timer for an earlier start and expires a waiting job at its stop-by time', async () => {
    const now = Date.now();
    const at = (ms) => new Date(now + ms).toISOString();
    const enqueue = (schedule) => mediaJobQueue.enqueueJob({ kind: 'image', params: { prompt: 'frame', schedule } });
    stubs.generateImage.mockResolvedValue({});
    const later = await enqueue({ startAt: at(60_000), stopBy: at(90_000) });
    await flush();
    expect(vi.getTimerCount()).toBe(1);

    const earlier = await enqueue({ startAt: at(30_000) });
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(stubs.generateImage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(stubs.generateImage).toHaveBeenCalledWith(expect.objectContaining({ jobId: earlier.jobId }));

    // The first render still holds the GPU lane at the second job's start.
    await vi.advanceTimersByTimeAsync(59_999);
    expect(mediaJobQueue.getJob(later.jobId).status).toBe('queued');
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(mediaJobQueue.getJob(later.jobId)).toMatchObject({
      status: 'canceled', error: 'Its stop-by time passed before it started',
    });
    expect(stubs.generateImage).toHaveBeenCalledTimes(1);
    imageGenEvents.emit('completed', { generationId: earlier.jobId, filename: 'frame.png' });
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
    vi.useFakeTimers();
    try {
      stubs.generateImageCodex.mockResolvedValue({ jobId: 'codex-job' });
      const first = await mediaJobQueue.enqueueJob({ kind: 'image', params: { mode: 'codex', prompt: 'page 1' } });
      await flush();
      expect(stubs.generateImageCodex).toHaveBeenCalledTimes(1);
      imageGenEvents.emit('failed', { generationId: first.jobId, error: QUOTA_ERROR });
      await flush();

      const second = await mediaJobQueue.enqueueJob({ kind: 'image', params: { mode: 'codex', prompt: 'page 2' } });
      await flush();
      const waiting = mediaJobQueue.getJob(second.jobId).statusMsg;
      expect(waiting).toMatch(/^Waiting for codex quota/);
      const snapshot = JSON.parse(readFileSync(join(tempDataDir, 'media-jobs.json'), 'utf8'));
      const resumeAt = snapshot.quotaCooldowns.find(([mode]) => mode === 'codex')[1];
      await vi.advanceTimersByTimeAsync(resumeAt - Date.now() - 1);
      expect(mediaJobQueue.getJob(second.jobId)).toMatchObject({ status: 'queued', statusMsg: waiting });
      await vi.advanceTimersByTimeAsync(1);
      await flush();
      expect(mediaJobQueue.getJob(second.jobId)).toMatchObject({ status: 'running', statusMsg: 'Starting' });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
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

  describe('per-provider parallel limits and 429 rate limit cooldowns (#15593)', () => {
    it('keeps an unset image-provider limit at its default when the same video provider is configured wider', async () => {
      mediaJobQueue.syncParallelLimits({ videoGen: { grok: { parallelLimit: 3 } } });
      expect(mediaJobQueue.laneConcurrencyFor({ kind: 'image', params: { mode: 'grok' } })).toBe(1);
      expect(mediaJobQueue.laneConcurrencyFor({ kind: 'video', params: { mode: 'grok' } })).toBe(3);
      stubs.generateImageGrok.mockResolvedValue({ jobId: 'grok-img-job' });
      const first = await mediaJobQueue.enqueueJob({ kind: 'image', params: { mode: 'grok', prompt: 'frame 1' } });
      const second = await mediaJobQueue.enqueueJob({ kind: 'image', params: { mode: 'grok', prompt: 'frame 2' } });
      await waitFor(() => stubs.generateImageGrok.mock.calls.length === 1);
      expect(mediaJobQueue.getJob(second.jobId).status).toBe('queued');
      imageGenEvents.emit('completed', { generationId: first.jobId, filename: 'first.png' });
      await waitFor(() => stubs.generateImageGrok.mock.calls.length === 2);
      imageGenEvents.emit('completed', { generationId: second.jobId, filename: 'second.png' });
    });

    it('holds a one-slot lane after a bare 429, preserves other lanes and resumes after the cooldown', async () => {
      vi.useFakeTimers();
      try {
        stubs.generateVideoGrok.mockResolvedValue({ jobId: 'grok-video-job' });
        stubs.generateImageGrok.mockResolvedValue({ jobId: 'grok-image-job' });
        const first = await mediaJobQueue.enqueueJob({ kind: 'video', params: { mode: 'grok', prompt: 'clip 1' } });
        const second = await mediaJobQueue.enqueueJob({ kind: 'video', params: { mode: 'grok', prompt: 'clip 2' } });
        await flush();
        expect(stubs.generateVideoGrok).toHaveBeenCalledTimes(1);
        videoGenEvents.emit('failed', { generationId: first.jobId, error: 'HTTP 429 Too Many Requests', status: 429 });
        await flush();
        expect(mediaJobQueue.getJob(second.jobId)).toMatchObject({
          status: 'queued', statusMsg: expect.stringMatching(/^Rate-limited \(429\)/),
        });
        const image = await mediaJobQueue.enqueueJob({ kind: 'image', params: { mode: 'grok', prompt: 'frame' } });
        await flush();
        expect(stubs.generateImageGrok).toHaveBeenCalledWith(expect.objectContaining({ jobId: image.jobId }));
        imageGenEvents.emit('completed', { generationId: image.jobId, filename: 'frame.png' });
        const { expiresAt } = mediaJobQueue.getRateLimitCooldown('video', 'grok');
        await vi.advanceTimersByTimeAsync(expiresAt - Date.now() - 1);
        expect(stubs.generateVideoGrok).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await flush();
        expect(stubs.generateVideoGrok).toHaveBeenCalledTimes(2);
        expect(mediaJobQueue.getJob(second.jobId).statusMsg).toBe('Starting');
        videoGenEvents.emit('completed', { generationId: second.jobId, filename: 'second.mp4' });
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    });

    it('runs Grok video up to its parallel limit and queues beyond it', async () => {
      stubs.generateVideoGrok.mockResolvedValue({ jobId: 'grok-job' });
      mediaJobQueue.setParallelLimit('video', 'grok', 2);

      const j1 = await mediaJobQueue.enqueueJob({ kind: 'video', params: { mode: 'grok', prompt: 'clip 1' } });
      const j2 = await mediaJobQueue.enqueueJob({ kind: 'video', params: { mode: 'grok', prompt: 'clip 2' } });
      const j3 = await mediaJobQueue.enqueueJob({ kind: 'video', params: { mode: 'grok', prompt: 'clip 3' } });

      await waitFor(() => stubs.generateVideoGrok.mock.calls.length === 2);
      expect(mediaJobQueue.getJob(j1.jobId).status).toBe('running');
      expect(mediaJobQueue.getJob(j2.jobId).status).toBe('running');
      expect(mediaJobQueue.getJob(j3.jobId).status).toBe('queued');

      videoGenEvents.emit('completed', { generationId: j1.jobId, filename: 'j1.mp4' });
      await waitFor(() => stubs.generateVideoGrok.mock.calls.length === 3);
      expect(mediaJobQueue.getJob(j3.jobId).status).toBe('running');

      videoGenEvents.emit('completed', { generationId: j2.jobId, filename: 'j2.mp4' });
      videoGenEvents.emit('completed', { generationId: j3.jobId, filename: 'j3.mp4' });
    });

    it('runs Grok video and Grok image in independent swimlanes', async () => {
      stubs.generateVideoGrok.mockResolvedValue({ jobId: 'grok-v-job' });
      stubs.generateImageGrok.mockResolvedValue({ jobId: 'grok-img-job' });
      mediaJobQueue.setParallelLimit('video', 'grok', 1);
      mediaJobQueue.setParallelLimit('image', 'grok', 1);

      const vJob = await mediaJobQueue.enqueueJob({ kind: 'video', params: { mode: 'grok', prompt: 'grok video' } });
      const imgJob = await mediaJobQueue.enqueueJob({ kind: 'image', params: { mode: 'grok', prompt: 'grok image' } });

      await waitFor(() => stubs.generateVideoGrok.mock.calls.length === 1 && stubs.generateImageGrok.mock.calls.length === 1);
      expect(mediaJobQueue.getJob(vJob.jobId).status).toBe('running');
      expect(mediaJobQueue.getJob(imgJob.jobId).status).toBe('running');

      videoGenEvents.emit('completed', { generationId: vJob.jobId, filename: 'v.mp4' });
      imageGenEvents.emit('completed', { generationId: imgJob.jobId, filename: 'img.png' });
    });

    it('lowers effective parallel limit on 429 rate limit and annotates waiting jobs', async () => {
      mediaJobQueue.setParallelLimit('video', 'grok', 3);
      expect(mediaJobQueue.getEffectiveParallelLimit({ kind: 'video', params: { mode: 'grok' } })).toBe(3);

      mediaJobQueue.recordRateLimitCooldown('video', 'grok', 60000);
      expect(mediaJobQueue.getEffectiveParallelLimit({ kind: 'video', params: { mode: 'grok' } })).toBe(2);

      const cooldown = mediaJobQueue.getRateLimitCooldown('video', 'grok');
      expect(cooldown.active).toBe(true);
      expect(cooldown.penalty).toBe(1);
    });

    it('leaves local GPU lanes at their memory-governed limit (1) and says so', () => {
      const cap = mediaJobQueue.getQueueCapacity();
      expect(cap.lanes.gpu.limit).toBe(1);
      expect(cap.lanes.gpu.limitReason).toBe('memory-governed');
      expect(mediaJobQueue.laneConcurrencyFor({ kind: 'video', params: { mode: 'local' } })).toBe(1);
    });
  });
});
