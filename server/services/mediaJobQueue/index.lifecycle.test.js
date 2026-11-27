// mediaJobQueue suite (#16215 split): Archive retention, terminal persistence, image finishing, progress forwarding and chained-video launch.
// Shared mocks, stubs and per-test lifecycle live in ./index.test.fixture.js,
// which must stay the first import that can resolve a mocked module.
import { describe, it, expect, vi } from 'vitest';
import { tempDataDir, atomicWriteSpy, currentAdmission, stubs, mediaJobQueue, videoGenEvents, imageGenEvents, importFresh, flush, remoteImageMediaParams, waitFor } from './index.test.fixture.js';
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

describe('mediaJobQueue', () => {
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

  it.each(['image', 'video', 'video-upscale'])('clears the full %s failure archive while retaining protected, completed, active and other-kind jobs', async (kind) => {
    const otherKind = kind === 'image' ? 'video' : 'image';
    const now = new Date().toISOString();
    const failures = Array.from({ length: 12 }, (_, i) => ({
      id: `failed-${i}`, kind, status: i === 0 ? 'canceled' : 'failed', queuedAt: now, completedAt: now, params: {},
    }));
    const retained = [
      { id: 'completed', kind, status: 'completed', queuedAt: now, completedAt: now, params: {} },
      { id: 'other-kind', kind: otherKind, status: 'failed', queuedAt: now, completedAt: now, params: {} },
      { id: 'protected', kind, status: 'failed', queuedAt: now, completedAt: now,
        params: kind === 'video-upscale' ? { mode: 'topaz' } : { remotePeerReservation: true },
        result: kind === 'video-upscale' ? { topazUncertain: true } : undefined },
      ...(kind === 'video-upscale' ? [{ id: 'recoverable', kind, status: 'failed', queuedAt: now, completedAt: now,
        params: { mode: 'topaz', requestId: 'example-request' }, result: { topazRecoveryAvailable: true } }] : []),
      ...(kind === 'video' ? [true, false].map((submissionUncertain) => ({
        id: `production-${submissionUncertain}`, kind, status: 'failed', queuedAt: now, completedAt: now,
        params: { videoProduction: { projectId: 'example', attemptId: 'attempt', submissionUncertain } },
      })) : []),
    ];
    writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify({ jobs: [...failures, ...retained] }));
    await mediaJobQueue.initMediaJobQueue();
    stubs.generateVideo.mockImplementation(() => new Promise(() => {}));
    stubs.generateImage.mockImplementation(() => new Promise(() => {}));
    const params = kind === 'video-upscale' ? { historyId: 'example', sourceFilename: 'example.mp4', runtime: 'ltx25' } : {};
    const first = await mediaJobQueue.enqueueJob({ kind, params });
    const second = await mediaJobQueue.enqueueJob({ kind, params });
    await waitFor(() => mediaJobQueue.getJob(first.jobId).status === 'running');
    await flush();
    const liveStatuses = [first, second].map(({ jobId }) => mediaJobQueue.getJob(jobId).status);
    expect(liveStatuses).toEqual(['running', 'queued']);
    expect(mediaJobQueue.listQueueJobs({ kind })).toHaveLength(kind === 'video-upscale' ? 14 : 12);
    // Simulate a quiet day: clearing failures must not trigger TTL pruning of
    // completed rows or a retained production receipt as a side effect.
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    mediaJobQueue.getJob('completed').completedAt = old;
    if (kind === 'video') mediaJobQueue.getJob('production-false').completedAt = old;

    const result = await mediaJobQueue.removeFailedCanceledJobs({ kind });
    expect(result.deletedIds).toEqual(failures.map((job) => job.id));
    expect(result.skipped).toBe(kind === 'image' ? 1 : kind === 'video' ? 3 : 2);
    for (const job of failures) expect(mediaJobQueue.getJob(job.id)).toBeNull();
    for (const job of retained) expect(mediaJobQueue.getJob(job.id)).not.toBeNull();
    expect([first, second].map(({ jobId }) => mediaJobQueue.getJob(jobId).status)).toEqual(liveStatuses);
    const savedIds = JSON.parse(readFileSync(join(tempDataDir, 'media-jobs.json'), 'utf8')).jobs.map((job) => job.id);
    expect(savedIds).toEqual(expect.arrayContaining([...retained.map((job) => job.id), first.jobId, second.jobId]));
    expect(savedIds).not.toEqual(expect.arrayContaining([failures[0].id]));
    expect(await mediaJobQueue.removeFailedCanceledJobs({ kind })).toEqual({ deletedIds: [], skipped: kind === 'image' ? 1 : kind === 'video' ? 3 : 2 });
  });

  it('retains failed jobs and reports a storage error when a bulk prune cannot be persisted', async () => {
    const now = new Date().toISOString();
    const job = { id: 'failed-save', kind: 'image', status: 'failed', queuedAt: now, completedAt: now, params: {} };
    writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify({ jobs: [job] }));
    await mediaJobQueue.initMediaJobQueue();
    const realWrite = atomicWriteSpy.getMockImplementation();
    atomicWriteSpy.mockRejectedValue(new Error('disk full'));
    await expect(mediaJobQueue.removeFailedCanceledJobs({ kind: 'image' }))
      .rejects.toMatchObject({ status: 503, code: mediaJobQueue.MEDIA_QUEUE_PERSIST_FAILED });
    atomicWriteSpy.mockImplementation(realWrite);
    expect(mediaJobQueue.getJob(job.id)).toMatchObject({ status: 'failed' });
    expect(JSON.parse(readFileSync(join(tempDataDir, 'media-jobs.json'), 'utf8')).jobs).toEqual([expect.objectContaining({ id: job.id })]);
  });

  it('keeps the durable receipt when earlier queued writes succeed and the bulk write fails', async () => {
    const now = new Date().toISOString();
    const jobs = [
      { id: 'failed-save', kind: 'image', status: 'failed', queuedAt: now, completedAt: now, params: {} },
      ...['first-write', 'second-write'].map((id) => ({ id, kind: 'image', status: 'completed', queuedAt: now, completedAt: now, params: {} })),
    ];
    writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify({ jobs }));
    await mediaJobQueue.initMediaJobQueue();
    const realWrite = atomicWriteSpy.getMockImplementation();
    let releaseFirst;
    let startFirst;
    let writeCount = 0;
    const gate = new Promise((resolve) => { releaseFirst = resolve; });
    const started = new Promise((resolve) => { startFirst = resolve; });
    atomicWriteSpy.mockImplementation(async (...args) => {
      writeCount += 1;
      if (writeCount === 1) { startFirst(); await gate; }
      if (writeCount === 3) throw new Error('disk full');
      return realWrite(...args);
    });
    const first = mediaJobQueue.updateJobResult('first-write', { note: 'first' });
    await started;
    const second = mediaJobQueue.updateJobResult('second-write', { note: 'second' });
    await new Promise((resolve) => setImmediate(resolve));
    const pruning = expect(mediaJobQueue.removeFailedCanceledJobs({ kind: 'image' }))
      .rejects.toMatchObject({ status: 503, code: mediaJobQueue.MEDIA_QUEUE_PERSIST_FAILED });
    releaseFirst();
    await Promise.all([first, second, pruning]);
    atomicWriteSpy.mockImplementation(realWrite);
    expect(writeCount).toBe(3);
    expect(mediaJobQueue.getJob('failed-save')).toMatchObject({ status: 'failed' });
    expect(JSON.parse(readFileSync(join(tempDataDir, 'media-jobs.json'), 'utf8')).jobs)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: 'failed-save' })]));
  });

  it('reports a saved clear when another terminal acknowledgement fails after the snapshot write', async () => {
    const now = new Date().toISOString();
    const jobs = [
      { id: 'failed-save', kind: 'image', status: 'failed', queuedAt: now, completedAt: now, params: {} },
      { id: 'hold-write', kind: 'image', status: 'completed', queuedAt: now, completedAt: now, params: {} },
    ];
    writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify({ jobs }));
    await mediaJobQueue.initMediaJobQueue();
    stubs.generateImage.mockImplementation(() => new Promise(() => {}));
    const active = await mediaJobQueue.enqueueJob({ kind: 'image', params: {} });
    await waitFor(() => stubs.generateImage.mock.calls.length === 1);
    const realWrite = atomicWriteSpy.getMockImplementation();
    let releaseWrite;
    let startWrite;
    const gate = new Promise((resolve) => { releaseWrite = resolve; });
    const started = new Promise((resolve) => { startWrite = resolve; });
    atomicWriteSpy.mockImplementationOnce(async (...args) => { startWrite(); await gate; return realWrite(...args); });
    const held = mediaJobQueue.updateJobResult('hold-write', { note: 'holding' });
    await started;
    const clearing = mediaJobQueue.removeFailedCanceledJobs({ kind: 'image' });
    mediaJobQueue.mediaJobEvents.once('failed', () => { throw new Error('example listener failure'); });
    imageGenEvents.emit('failed', { generationId: active.jobId, error: 'example failure' });
    await waitFor(() => mediaJobQueue.getJob(active.jobId)?.durabilityPending?.status === 'failed');
    releaseWrite();
    const result = await clearing;
    await held;
    expect(result).toEqual({ deletedIds: ['failed-save'], skipped: 0,
      warning: 'Another queue update could not finish. Check the queue.' });
    expect(mediaJobQueue.getJob('failed-save')).toBeNull();
    expect(JSON.parse(readFileSync(join(tempDataDir, 'media-jobs.json'), 'utf8')).jobs)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'failed-save' })]));
  });

  it('keeps a successful clear when a queue-change listener throws', async () => {
    const now = new Date().toISOString();
    const job = { id: 'failed-save', kind: 'image', status: 'failed', queuedAt: now, completedAt: now, params: {} };
    writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify({ jobs: [job] }));
    await mediaJobQueue.initMediaJobQueue();
    mediaJobQueue.mediaJobEvents.once('changed', () => { throw new Error('example notification failure'); });
    await expect(mediaJobQueue.removeFailedCanceledJobs({ kind: 'image' }))
      .resolves.toEqual({ deletedIds: ['failed-save'], skipped: 0 });
    expect(mediaJobQueue.getJob('failed-save')).toBeNull();
    expect(JSON.parse(readFileSync(join(tempDataDir, 'media-jobs.json'), 'utf8')).jobs).toEqual([]);
  });

  it('leaves a job whose result is being persisted available for reconciliation', async () => {
    const now = new Date().toISOString();
    const jobs = ['updating', 'removable'].map((id) => ({ id, kind: 'image', status: 'failed', queuedAt: now, completedAt: now, params: {} }));
    writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify({ jobs }));
    await mediaJobQueue.initMediaJobQueue();
    const realWrite = atomicWriteSpy.getMockImplementation();
    let releaseWrite;
    let startedWrite;
    const gate = new Promise((resolve) => { releaseWrite = resolve; });
    const started = new Promise((resolve) => { startedWrite = resolve; });
    atomicWriteSpy.mockImplementationOnce(async (...args) => {
      startedWrite();
      await gate;
      return realWrite(...args);
    });
    const update = mediaJobQueue.updateJobResult('updating', { note: 'example' });
    await started;
    const clearing = mediaJobQueue.removeFailedCanceledJobs({ kind: 'image' });
    await Promise.resolve();
    releaseWrite();
    await update;
    expect(await clearing).toEqual({ deletedIds: ['removable'], skipped: 1 });
    expect(mediaJobQueue.getJob('updating').result).toEqual({ note: 'example' });
    expect(mediaJobQueue.getJob('removable')).toBeNull();
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

  it('only verifies opted-in image jobs and rerolls within budget with the original owner and inputs', async () => {
    stubs.generateImage.mockResolvedValue({});
    const verification = { verdict: 'fail', summary: 'Extra fingers' };
    stubs.verifyImage.mockResolvedValue(verification);
    const unverified = await mediaJobQueue.enqueueJob({ kind: 'image', params: { prompt: 'No verification', verifyImage: false } });
    await waitFor(() => stubs.generateImage.mock.calls.length === 1);
    imageGenEvents.emit('completed', { generationId: unverified.jobId, filename: 'unverified.png' });
    await waitFor(() => mediaJobQueue.getJob(unverified.jobId).status === 'completed');
    expect(stubs.verifyImage).not.toHaveBeenCalled();

    const owner = { type: 'test', id: 'verifier' };
    const params = { prompt: 'A hand', seed: 41, verifyImage: true, maxRerolls: 1, verificationProfileId: 'strict_anatomy' };
    const first = await mediaJobQueue.enqueueJob({ kind: 'image', owner, params });
    await waitFor(() => stubs.generateImage.mock.calls.length === 2);
    imageGenEvents.emit('completed', { generationId: first.jobId, filename: 'first.png' });
    await waitFor(() => stubs.generateImage.mock.calls.length === 3);
    const reroll = mediaJobQueue.listJobs().find(job => job.params.parentJobId === first.jobId);
    expect(reroll).toMatchObject({
      kind: 'image', owner,
      params: { ...params, seed: 42, verificationRerollCount: 1, parentJobId: first.jobId },
    });
    expect(mediaJobQueue.getJob(first.jobId)).toMatchObject({ status: 'completed', result: { verification } });
    imageGenEvents.emit('completed', { generationId: reroll.id, filename: 'reroll.png' });
    await waitFor(() => mediaJobQueue.getJob(reroll.id).status === 'completed');
    expect(stubs.verifyImage).toHaveBeenCalledTimes(2);
    expect(stubs.verifyImage).toHaveBeenLastCalledWith({ filename: 'reroll.png', prompt: params.prompt, profileId: params.verificationProfileId });
    expect(mediaJobQueue.listJobs()).toHaveLength(3);
  });

  it('verifies a profiled peer render and submits a fresh peer reroll with the next seed', async () => {
    const remoteMedia = remoteImageMediaParams();
    remoteMedia.request.seed = 41;
    stubs.generateImageRemote.mockResolvedValue({});
    stubs.finishVisualProfile.mockImplementation(async ({ result }) => ({ ...result }));
    const verification = { verdict: 'fail', summary: 'Extra fingers' };
    stubs.verifyImage.mockResolvedValueOnce(verification).mockResolvedValueOnce({ verdict: 'pass' });
    const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'image', params: {
      remoteMedia, visualProfile: { version: 1 }, verifyImage: true,
    } });

    await waitFor(() => stubs.generateImageRemote.mock.calls.length === 1);
    imageGenEvents.emit('completed', { generationId: jobId, filename: 'peer-render.png', remoteInputsDisposable: true });
    await waitFor(() => stubs.generateImageRemote.mock.calls.length === 2);

    expect(stubs.verifyImage).toHaveBeenCalledWith(expect.objectContaining({
      filename: 'peer-render.png', prompt: remoteMedia.request.prompt,
    }));
    expect(mediaJobQueue.getJob(jobId).result.verification).toEqual(verification);
    const reroll = mediaJobQueue.listJobs().find(job => job.params.parentJobId === jobId);
    expect(reroll.params.remoteMedia.request).toEqual({ ...remoteMedia.request, seed: 42 });
    expect(reroll.params).not.toHaveProperty('visualProfileSource');
    imageGenEvents.emit('completed', { generationId: reroll.id, filename: 'peer-reroll.png', remoteInputsDisposable: true });
    await waitFor(() => mediaJobQueue.getJob(reroll.id).status === 'completed');
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

  it.each([{}, { catalogAttach: { ingredientId: 'example', kind: 'reference' } }, { characterSheet: { entryId: 'example' } }])(
    'finishes under the media owner after provider publication settles, with catalog policy %j', async target => {
      stubs.generateImageCodex.mockResolvedValue({});
      let releaseFinish;
      const delayed = new Promise(resolve => { releaseFinish = resolve; });
      stubs.finishVisualProfile.mockImplementation(async ({ result, applyFilmFinish }) => {
        await delayed;
        return currentAdmission.continueSettlement(() => ({ ...result, applyFilmFinish }));
      });
      const { jobId } = await mediaJobQueue.enqueueJob({ kind: 'image', params: {
        mode: 'codex', prompt: 'Example', visualProfile: { version: 1 }, ...target,
      } });
      await waitFor(() => stubs.generateImageCodex.mock.calls.length === 1);
      // Real providers emit synchronously inside a short-lived publication.
      await currentAdmission.run('settlement', 'provider publication', () => {
        imageGenEvents.emit('completed', { generationId: jobId, filename: 'example-source.png' });
      });
      await waitFor(() => stubs.finishVisualProfile.mock.calls.length === 1);
      releaseFinish();
      await waitFor(() => mediaJobQueue.getJob(jobId).status === 'completed');
      expect(mediaJobQueue.getJob(jobId).result.applyFilmFinish).toBe(!target.catalogAttach && !target.characterSheet);
    },
  );

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
    expect(failed.statusMsg).toBe('Film finishing failed; original image retained');
    // The live failed status is published only after its snapshot is durable.
    const saved = JSON.parse(readFileSync(join(tempDataDir, 'media-jobs.json'), 'utf8')).jobs.find(row => row.id === jobId);
    expect(saved).toMatchObject({ status: 'failed', statusMsg: failed.statusMsg, result: { filename: 'example-source.png' } });
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
    // Structured fields accompany progress and preview frames when present.
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
});
