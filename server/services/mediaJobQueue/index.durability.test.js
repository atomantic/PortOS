// mediaJobQueue suite (#16215 split): Durable remote source-audio settlement, admission and shutdown flush, quiesce, the pending-job ceiling and terminal settlement.
// Shared mocks, stubs and per-test lifecycle live in ./index.test.fixture.js,
// which must stay the first import that can resolve a mocked module.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tempDataDir, atomicWriteSpy, queueSnapshotJobs, stubs, mediaJobQueue, videoGenEvents, imageGenEvents, importFresh, flush, remoteVideoMediaParams, remoteRecoverySettlement, waitFor, persistedJobs, persistedIds, holdNextWrite } from './index.test.fixture.js';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

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
    expect(await mediaJobQueue.removeFailedCanceledJobs({ kind: 'video' })).toEqual({ deletedIds: [], skipped: 1 });
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
      if (queueSnapshotJobs(path, data).some(entry => entry.id === first.jobId && entry.status === 'completed') && ++terminalWrites > 1) {
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
      if (!landed && queueSnapshotJobs(path, data).some(entry => entry.id === job.jobId && entry.status === 'completed')) {
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
      // The terminal persist (and any retry it schedules) is a tracked terminal
      // operation, so draining joins a retry that would follow the backoff.
      await flush();
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
    atomicWriteSpy.mockImplementation((path, data) => failing && queueSnapshotJobs(path, data).some(entry => entry.id === job.jobId && entry.status === 'completed')
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

  it('reset detaches abandoned providers without leaving progress work behind', async () => {
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
