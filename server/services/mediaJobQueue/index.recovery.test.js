// mediaJobQueue suite (#16215 split): Segment launch refusals, live progress, cancellation, boot recovery and the job watchdog.
// Shared mocks, stubs and per-test lifecycle live in ./index.test.fixture.js,
// which must stay the first import that can resolve a mocked module.
import { describe, it, expect, vi } from 'vitest';
import { tempDataDir, atomicWriteSpy, queueSnapshotJobs, stubs, mediaJobQueue, videoGenEvents, imageGenEvents, importFresh, flush, waitFor } from './index.test.fixture.js';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

describe('mediaJobQueue', () => {
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
      if (rejectReceipt && queueSnapshotJobs(file, data).some(job => job.videoExecutions?.length)) {
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

  it('retains the a2v lip-sync verdict beside termination evidence across restart (#15409)', async () => {
    const meta = { seed: 42, modelId: 'example-mlx', width: 512, height: 512, numFrames: 97, fps: 24, steps: 9, mode: 'a2v' };
    const { recordVideoExecution, recordVideoExecutionDiagnostics } = await import('../videoGen/executionRecorder.js');
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'video', params: { modelId: 'example-mlx', prompt: 'Synthetic singer' } });
    await waitFor(() => stubs.generateVideo.mock.calls.some(([params]) => params.jobId === jobId));
    await recordVideoExecution(jobId, meta);
    const lipsyncAlign = { shiftFrames: 2, lag: 2, peakScore: 0.61, reason: 'mouth-lead' };
    await recordVideoExecutionDiagnostics(jobId, { lipsyncAlign });
    await expect(recordVideoExecutionDiagnostics(jobId, { lipsyncAlign: { ...lipsyncAlign, reason: 'ffmpeg exit 1: /tmp/x.mp4' } })).rejects.toThrow();
    await recordVideoExecutionDiagnostics(jobId, { termination: {
      exitCode: 0, signal: null, reason: 'completed', observedAt: new Date().toISOString(),
    } });
    videoGenEvents.emit('completed', { generationId: jobId, filename: `${jobId}.mp4`, path: `/data/videos/${jobId}.mp4` });
    await waitFor(() => mediaJobQueue.getJob(jobId)?.status === 'completed');
    await importFresh();
    await mediaJobQueue.initMediaJobQueue();
    expect(mediaJobQueue.getJob(jobId).videoExecution.diagnostics).toMatchObject({ lipsyncAlign, termination: { reason: 'completed' } });
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
      if (rejectDiagnostic && queueSnapshotJobs(file, data).some(job => job.id === jobId && job.videoExecution?.diagnostics?.termination)) {
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
      if (rejectReceipt && queueSnapshotJobs(file, data).some(j => j.status === 'running' && j.videoExecution)) {
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

  it('serves live progress and ETA without writes or queue invalidation until shutdown flush', async () => {
    const file = join(tempDataDir, 'media-jobs.json');
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'live render' } });
    await waitFor(() => stubs.generateVideo.mock.calls.length === 1);
    await flush();
    const runningSnapshot = readFileSync(file, 'utf8');
    atomicWriteSpy.mockClear();

    const changed = vi.fn();
    const progressEvents = vi.fn();
    mediaJobQueue.mediaJobEvents.on('changed', changed);
    mediaJobQueue.mediaJobEvents.on('progress', progressEvents);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      videoGenEvents.emit('progress', { generationId: jobId, progress: 0.25, message: 'Rendering', etaMs: 90_000 });
      videoGenEvents.emit('progress', { generationId: jobId, progress: 0.37, message: 'Upscaling', etaMs: 80_000 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(atomicWriteSpy).not.toHaveBeenCalled();
      expect(changed).not.toHaveBeenCalled();
      expect(readFileSync(file, 'utf8')).toBe(runningSnapshot);

      const { startedAt } = mediaJobQueue.getJob(jobId);
      const expected = { id: jobId, startedAt, progress: 0.37, statusMsg: 'Upscaling', etaMs: 80_000 };
      expect(mediaJobQueue.getJob(jobId)).toMatchObject(expected);
      expect(progressEvents).toHaveBeenLastCalledWith(expected);

      const response = { writeHead: vi.fn(), write: vi.fn(), req: { on: vi.fn() } };
      expect(mediaJobQueue.attachSseClient(jobId, response)).toBe(true);
      expect(response.write).toHaveBeenCalledWith('data: ' + JSON.stringify({
        type: 'progress', progress: 0.37, message: 'Upscaling', etaMs: 80_000,
      }) + '\n\n');
    } finally {
      vi.useRealTimers();
      mediaJobQueue.mediaJobEvents.off('changed', changed);
      mediaJobQueue.mediaJobEvents.off('progress', progressEvents);
    }

    await expect(mediaJobQueue.flushMediaJobQueue()).resolves.toMatchObject({ ok: true });
    const saved = readFileSync(file, 'utf8');
    const snapshot = JSON.parse(saved);
    expect(saved).toBe(JSON.stringify(snapshot));
    expect(snapshot.jobs).toContainEqual(expect.objectContaining({
      id: jobId, status: 'running', progress: 0.37, statusMsg: 'Upscaling', etaMs: 80_000,
    }));
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

  it('records a running Gemini production cancellation as an uncertain submission', async () => {
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'video', params: {
      mode: 'gemini', prompt: 'A lighthouse', videoProduction: { submissionUncertain: false },
    } });
    await waitFor(() => stubs.generateVideoGemini.mock.calls.some(([params]) => params.jobId === jobId));
    stubs.cancelVideo.mockReturnValueOnce(true);
    await expect(mediaJobQueue.cancelJob(jobId)).resolves.toMatchObject({ ok: true, status: 'canceling' });
    const snapshot = JSON.parse(readFileSync(join(tempDataDir, 'media-jobs.json'), 'utf8'));
    expect(snapshot.jobs.find(entry => entry.id === jobId)?.params.videoProduction.submissionUncertain).toBe(true);
    videoGenEvents.emit('failed', { generationId: jobId, error: 'Canceled' });
    await waitFor(() => mediaJobQueue.getJob(jobId)?.status === 'canceled');
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
      params: { mode: 'local', videoProduction: { projectId: 'example-video', attemptId: `example-attempt-${index}` } } }));
    writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify({ jobs }));
    await importFresh();
    await mediaJobQueue.initMediaJobQueue();
    expect(mediaJobQueue.getJob(jobs[0].id)).toMatchObject({ status: 'failed', params: { videoProduction: { submissionUncertain: false } } });
    expect(mediaJobQueue.getJob(jobs[1].id)).toMatchObject({ status: 'failed', params: { videoProduction: { submissionUncertain: true } } });
    expect(mediaJobQueue.getMediaRecoveryActivity()).toMatchObject({ trusted: true, pending: false });
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

  // #14440: restart arms that no other replay test pinned.
  it('boot recovery: a film-finishing cancel keeps its original image and releases its staged uploads', async () => {
    const id = '00000000-0000-4000-8000-000000000101';
    const uploads = join(tempDataDir, 'uploads');
    mkdirSync(uploads, { recursive: true });
    const staged = ['example-frame.png', 'example-audio.wav', 'example-extra.png'].map(name => join(uploads, name));
    for (const path of staged) writeFileSync(path, 'staged');
    writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify({ jobs: [{
      id, kind: 'image', status: 'running', cancelRequested: true,
      queuedAt: '2026-04-30T10:00:00.000Z', startedAt: '2026-04-30T10:00:01.000Z',
      params: { prompt: 'finish', visualProfile: { version: 1 }, visualProfileSource: { filename: 'example-source.png' },
        uploadedTempPath: staged[0], audioFilePath: staged[1], uploadedTempPaths: [staged[2]] },
    }] }));

    await importFresh();
    await mediaJobQueue.initMediaJobQueue();

    expect(mediaJobQueue.getJob(id)).toMatchObject({ status: 'canceled', result: { filename: 'example-source.png' },
      error: 'Canceled during film finishing; original image retained' });
    await waitFor(() => staged.every(path => !existsSync(path)));
  });

  it('boot recovery: an interrupted sharing export fails and cleans its partial copy', async () => {
    const id = '00000000-0000-4000-8000-000000000102';
    writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify({ jobs: [{
      id, kind: 'video-sharing', status: 'running',
      queuedAt: '2026-04-30T10:00:00.000Z', startedAt: '2026-04-30T10:00:01.000Z', params: {},
    }] }));

    await importFresh();
    await mediaJobQueue.initMediaJobQueue();

    expect(mediaJobQueue.getJob(id)).toMatchObject({ status: 'failed', error: 'interrupted by restart' });
    const { cleanupInterruptedSharingCopy } = await import('../musicVideo/sharingCopy.js');
    expect(cleanupInterruptedSharingCopy).toHaveBeenCalledWith(id);
  });

  it.each([true, false])('manual update recovery: training survivor=%s is observed or failed, never left indefinitely running', async survives => {
    const id = '00000000-0000-4000-8000-000000000304';
    writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify({ jobs: [{ id, kind: 'training', status: 'running',
      queuedAt: '2026-04-30T10:00:00.000Z', params: { runId: 'training-example' } }] }));
    const { maintenance } = await import('../../lib/maintenanceAdmission.js');
    const { hold } = maintenance.begin({ reason: 'Update acknowledged', owner: 'manual-update' });
    try {
      await importFresh(); stubs.hasSurvivingTrainer.mockResolvedValue(survives);
      await mediaJobQueue.initMediaJobQueue();
      if (survives) {
        await waitFor(() => expect(stubs.runTraining).toHaveBeenCalledWith(expect.objectContaining({ jobId: id, reattach: true })));
      } else {
        expect(mediaJobQueue.getJob(id)).toMatchObject({ status: 'failed', error: 'interrupted by restart' });
        expect(stubs.runTraining).not.toHaveBeenCalled();
      }
    } finally { maintenance.resume({ id: hold.id, revision: hold.revision }); }
  });

  it('manual update recovery fails an interrupted local video and leaves queued work queued', async () => {
    const video = '00000000-0000-4000-8000-000000000305', queued = '00000000-0000-4000-8000-000000000306';
    writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify({ jobs: [
      { id: video, kind: 'video', status: 'running', params: {} }, { id: queued, kind: 'image', status: 'queued', params: {} },
    ] }));
    const { maintenance } = await import('../../lib/maintenanceAdmission.js');
    const { hold } = maintenance.begin({ reason: 'Update acknowledged', owner: 'manual-update' });
    try {
      await importFresh(); await mediaJobQueue.initMediaJobQueue();
      expect(mediaJobQueue.getJob(video)).toMatchObject({ status: 'failed', error: 'interrupted by restart' });
      expect(mediaJobQueue.getJob(queued).status).toBe('queued');
      expect(stubs.generateVideo).not.toHaveBeenCalled();
    } finally { maintenance.resume({ id: hold.id, revision: hold.revision }); }
  });

  it('boot recovery: a running job under a maintenance hold is archived with its inputs, never failed or replayed', async () => {
    const id = '00000000-0000-4000-8000-000000000103';
    const uploads = join(tempDataDir, 'uploads');
    mkdirSync(uploads, { recursive: true });
    const staged = join(uploads, 'held-frame.png');
    writeFileSync(staged, 'staged');
    writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify({ jobs: [{
      id, kind: 'video', status: 'running',
      queuedAt: '2026-04-30T10:00:00.000Z', startedAt: '2026-04-30T10:00:01.000Z',
      params: { prompt: 'held render', uploadedTempPath: staged },
    }] }));
    const { maintenance } = await import('../../lib/maintenanceAdmission.js');
    const { hold } = maintenance.begin({ reason: 'Restart under maintenance', owner: 'Operator' });
    try {
      await importFresh();
      await mediaJobQueue.initMediaJobQueue();
      expect(mediaJobQueue.getJob(id)).toMatchObject({ status: 'running' });
      expect(mediaJobQueue.getJob(id).error).toBeUndefined();
      expect(existsSync(staged)).toBe(true);
      expect(stubs.generateVideo).not.toHaveBeenCalled();
    } finally { maintenance.resume({ id: hold.id, revision: hold.revision }); }
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
    // Fake timers drive the watchdog interval deterministically: a NaN window
    // would tick every millisecond and fail on its first tick.
    vi.useFakeTimers();
    try {
      await importFresh();
      let signalEntered;
      const entered = new Promise(resolve => { signalEntered = resolve; });
      stubs.generateVideo.mockImplementation(() => { signalEntered(); return new Promise(() => {}); }); // hang forever

      const job = await mediaJobQueue.enqueueJob({ kind: 'video', params: { prompt: 'guard' } });
      await entered;

      // A beat of watchdog time — long enough that a NaN-driven watchdog would have fired.
      await vi.advanceTimersByTimeAsync(100);
      await flush();
      expect(mediaJobQueue.getJob(job.jobId)?.status).toBe('running');
    } finally {
      delete process.env.MEDIA_JOB_WATCHDOG_VIDEO_MS;
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
