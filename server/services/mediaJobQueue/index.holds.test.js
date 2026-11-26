// mediaJobQueue suite (#16215 split): Local video failure holds and preparation failures.
// Shared mocks, stubs and per-test lifecycle live in ./index.test.fixture.js,
// which must stay the first import that can resolve a mocked module.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tempDataDir, stubs, mediaJobQueue, videoGenEvents, imageGenEvents, audioGenEvents, importFresh, flush, remoteVideoMediaParams, holdNextWrite } from './index.test.fixture.js';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

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
      await vi.waitFor(() => expect(stubs.generateVideo).toHaveBeenLastCalledWith(expect.objectContaining({ jobId: id, modelId: 'example-cuda' })));
      await finish(id);
    }
    await tick();
    expect(stubs.generateVideo).toHaveBeenCalledTimes(3);
    const retained = mediaJobQueue.getJob(ids[3]);
    expect(retained).toMatchObject({ status: 'queued', hold: { modelId: 'example-cuda', runtime: 'cuda_video' } });
    expect(retained.params).not.toHaveProperty('modelId');
    await mediaJobQueue.resumeVideoHold(retained.hold.id);
    await tick();
    await vi.waitFor(() => expect(stubs.generateVideo).toHaveBeenLastCalledWith(expect.objectContaining({ jobId: ids[3], modelId: 'example-cuda' })));
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
    await expect(mediaJobQueue.initMediaJobQueue()).resolves.toBeUndefined();
    await tick();
    expect(stubs.generateVideo).not.toHaveBeenCalled();
    expect(mediaJobQueue.getJob('interrupted-video').status).toBe('failed');
    expect(mediaJobQueue.getJob('saved-training').status).toBe('canceled');
    for (const generate of [stubs.generateImage, stubs.generateImageCodex, stubs.generateAudioRemote]) {
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
