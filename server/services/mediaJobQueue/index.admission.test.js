// mediaJobQueue suite (#16215 split): Reviewed-reference snapshots, policy rechecks before delayed dispatch, queue admission, per-kind dispatch, capacity and lane concurrency.
// Shared mocks, stubs and per-test lifecycle live in ./index.test.fixture.js,
// which must stay the first import that can resolve a mocked module.
import { describe, it, expect, vi } from 'vitest';
import { catalogDispatch, tempDataDir, atomicWriteSpy, queueSnapshotJobs, stubs, mediaJobQueue, videoGenEvents, imageGenEvents, audioGenEvents, importFresh, flush, remoteMediaParams, remoteImageMediaParams, remoteVideoMediaParams, waitFor, persistedJobs } from './index.test.fixture.js';
import { mkdirSync, rmSync, writeFileSync, readFileSync, renameSync, lstatSync } from 'fs';
import { createHash } from 'node:crypto';
import { join } from 'path';
import { IMAGE_GEN_MODE } from '../imageGen/modes.js';

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

  // Uniquely catches an unapproved catalog check-in refusing the owner's render, or a catalog edit while queued slipping through.
  it('dispatches on an unapproved catalog check-in but refuses one whose catalog changed while queued', async () => {
    const { getProject } = await import('../musicVideo/projects.js');
    const project = { castAndSets: { source: 'catalog', catalogCheckin: { approved: true, problems: [], basis: 'original' } } };
    const unapproved = { castAndSets: { source: 'catalog', catalogCheckin: { approved: false, problems: [], basis: 'original' } } };
    const request = { kind: 'image', params: { prompt: 'Synthetic scene', musicVideo: { projectId: 'mv-example', sceneId: 'scene-example' } } };
    stubs.generateImage.mockClear();
    getProject.mockResolvedValueOnce(unapproved).mockResolvedValueOnce(unapproved);
    catalogDispatch.hydrate.mockResolvedValueOnce(unapproved).mockResolvedValueOnce(unapproved);
    const admitted = await mediaJobQueue.enqueueJob(request);
    await waitFor(() => stubs.generateImage.mock.calls.length === 1);
    imageGenEvents.emit('failed', { generationId: admitted.jobId, error: 'synthetic finish', inputProcessSettled: true });
    await waitFor(() => mediaJobQueue.getJob(admitted.jobId).status === 'failed');
    stubs.generateImage.mockClear();
    getProject.mockResolvedValueOnce(project).mockResolvedValueOnce(project);
    catalogDispatch.hydrate.mockResolvedValueOnce(project).mockResolvedValueOnce({ ...project,
      castAndSets: { source: 'catalog', catalogCheckin: { approved: true, problems: [], basis: 'changed' } } });
    const changed = await mediaJobQueue.enqueueJob(request);
    await waitFor(() => mediaJobQueue.getJob(changed.jobId).status === 'failed');
    expect(mediaJobQueue.getJob(changed.jobId).error).toContain('after these render inputs were prepared');
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
      if (queueSnapshotJobs(path, data).some(job => job.id === jobId && job.status === 'completed')) {
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

  it.each([
    { initImagePath: 'init.png', initImageStrength: 0.35 },
    { loraFilenames: ['example.safetensors'] },
    { loraPaths: ['example.safetensors'] },
  ])('refuses incompatible FLUX.2 selections before queue acceptance: %j', async extra => {
    expect(mediaJobQueue.listJobs()).toEqual([]);
    await expect(mediaJobQueue.enqueueJob({ kind: 'image', params: {
      modelId: 'flux2-example', referenceImagePaths: ['reference.png'], ...extra,
    } })).rejects.toMatchObject({ code: 'IMAGE_GEN_FLUX2_INPUTS_INCOMPATIBLE' });
    expect(mediaJobQueue.listJobs()).toEqual([]);
  });

  it('keeps cloud and unquantized image selections outside the incompatible FLUX.2 queue refusal', async () => {
    const params = { modelId: 'flux2-example-bf16', referenceImagePaths: ['reference.png'], loraFilenames: ['example.safetensors'] };
    const local = await mediaJobQueue.enqueueJob({ kind: 'image', params });
    const cloud = await mediaJobQueue.enqueueJob({ kind: 'image', params: {
      ...params, modelId: 'flux2-example', mode: 'codex', initImagePath: 'init.png',
    } });
    expect(mediaJobQueue.getJob(local.jobId)).toMatchObject({ params });
    expect(mediaJobQueue.getJob(cloud.jobId).params).toMatchObject({ mode: 'codex', initImagePath: 'init.png' });
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

    it('retains an expired uncertain Topaz job when saving its terminal status fails', async () => {
      const id = '00000000-0000-4000-8000-000000000098';
      writeFileSync(join(tempDataDir, 'media-jobs.json'), JSON.stringify({ jobs: [{ id, kind: 'video-upscale',
        status: 'failed', queuedAt: '2020-01-01T00:00:00Z', completedAt: '2020-01-01T00:00:00Z',
        params: { mode: 'topaz', requestId: '22222222-2222-4222-8222-222222222222' }, result: { topazUncertain: true } }] }));
      await importFresh();
      await mediaJobQueue.initMediaJobQueue();
      const realWrite = atomicWriteSpy.getMockImplementation();
      atomicWriteSpy.mockRejectedValueOnce(new Error('synthetic result write failure'));
      try {
        const first = mediaJobQueue.updateJobResult(id, { topazUncertain: false, topazProviderStatus: 'failed' });
        const second = mediaJobQueue.updateJobResult(id, { topazPhase: 'checking' });
        await expect(first).rejects.toThrow('synthetic result write failure');
        await expect(second).resolves.toBe(true);
        expect(mediaJobQueue.getJob(id)?.result.topazUncertain).toBe(true);
        expect(mediaJobQueue.getJob(id)?.result.topazPhase).toBe('checking');
        expect(JSON.parse(readFileSync(join(tempDataDir, 'media-jobs.json'), 'utf8')).jobs[0].result.topazUncertain).toBe(true);
        await expect(mediaJobQueue.updateJobResult(id, { topazUncertain: false, topazProviderStatus: 'failed' })).resolves.toBe(true);
      } finally { atomicWriteSpy.mockImplementation(realWrite); }
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
});
