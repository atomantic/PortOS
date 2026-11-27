// mediaJobQueue suite (#16215 split): The audio and Codex lanes, input sanitization, chunked dispatch, an unreadable snapshot and archived-job import.
// Shared mocks, stubs and per-test lifecycle live in ./index.test.fixture.js,
// which must stay the first import that can resolve a mocked module.
import { describe, it, expect, vi } from 'vitest';
import { tempDataDir, atomicWriteSpy, stubs, mediaJobQueue, videoGenEvents, imageGenEvents, audioGenEvents, importFresh, flush, remoteMediaParams, remoteImageMediaParams, remoteVideoMediaParams, waitFor, persistedJobs } from './index.test.fixture.js';
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { IMAGE_GEN_MODE } from '../imageGen/modes.js';

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

  it('records referenceImageFilenames handed to a Codex run on the queue job record across failures', async () => {
    stubs.generateImageCodex.mockResolvedValue({
      jobId: 'codex-ref-job',
      referenceImageFilenames: ['cast.png', 'set.png'],
    });

    const job = await mediaJobQueue.enqueueJob({
      kind: 'image',
      params: { prompt: 'codex refs test', mode: 'codex', referenceImagePaths: ['/tmp/cast.png', '/tmp/set.png'] },
    });
    await waitFor(() => mediaJobQueue.getJob(job.jobId)?.referenceImageFilenames?.length === 2);
    expect(mediaJobQueue.getJob(job.jobId).referenceImageFilenames).toEqual(['cast.png', 'set.png']);

    imageGenEvents.emit('failed', {
      generationId: job.jobId,
      error: 'Codex did not produce an image.',
      referenceImageFilenames: ['cast.png', 'set.png'],
    });
    await waitFor(() => mediaJobQueue.getJob(job.jobId).status === 'failed');
    expect(mediaJobQueue.getJob(job.jobId).referenceImageFilenames).toEqual(['cast.png', 'set.png']);
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
    expect(mediaJobQueue.getMediaRecoveryActivity().trusted).toBe(false);
    await expect(mediaJobQueue.initMediaJobQueue()).resolves.toBeUndefined();
    expect(mediaJobQueue.listJobs()).toEqual([]);
    expect(mediaJobQueue.getMediaRecoveryActivity().trusted).toBe(false);
  });

  it('keeps a malformed jobs field untrusted and preserves the snapshot', async () => {
    const file = join(tempDataDir, 'media-jobs.json');
    const malformed = JSON.stringify({ jobs: {} });
    writeFileSync(file, malformed);
    await importFresh();
    await mediaJobQueue.initMediaJobQueue();
    expect(mediaJobQueue.getMediaRecoveryActivity().trusted).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(malformed);
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
