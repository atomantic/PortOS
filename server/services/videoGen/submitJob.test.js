import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';
import { PATHS } from '../../lib/paths.js';

vi.mock('../../lib/paths.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-greybox-video-') }));
afterAll(cleanupTempDataRoots);

vi.mock('../../lib/maintenanceAdmission.js', () => ({ maintenance: { run: (_kind, _resource, fn) => fn() } }));

const mocks = vi.hoisted(() => ({
  buildFederatedMediaRequest: vi.fn(),
  cleanupMultipartTemp: vi.fn(async () => {}),
  collectRemoteInputAssets: vi.fn(() => []),
  compileFableLoomVisualRequest: vi.fn(),
  enqueueJob: vi.fn(),
  fableLoomVideoCapabilities: vi.fn(),
  getIngredient: vi.fn(),
  listMediaForIngredient: vi.fn(),
  getMusicVideoProject: vi.fn(async () => null),
  getLoom: vi.fn(async () => null),
  prepareRemoteMediaJob: vi.fn(),
  prepareVideoGenParams: vi.fn(),
  preparePerformanceShot: vi.fn(async () => null),
  assertRevisionOpen: vi.fn(async () => {}),
  assertProductionSubmission: vi.fn(async () => {}),
  resolveVideoModelSelection: vi.fn(),
  prepareSourceAudioWindow: vi.fn(),
  discardSourceAudioWindow: vi.fn(async () => ({ ok: true })),
  unlink: vi.fn(async () => {}),
  musicVideoClipCastReferences: vi.fn(async () => []),
}));

vi.mock('../catalogDB.js', () => ({ getIngredient: mocks.getIngredient, listMediaForIngredient: mocks.listMediaForIngredient }));

vi.mock('fs/promises', async (load) => ({ ...await load(), unlink: mocks.unlink }));
vi.mock('./modelSelection.js', () => ({ resolveVideoModelSelection: mocks.resolveVideoModelSelection }));
vi.mock('../federatedMedia/sourceAudio.js', async (load) => ({
  ...await load(),
  prepareSourceAudioWindow: mocks.prepareSourceAudioWindow,
  discardSourceAudioWindow: mocks.discardSourceAudioWindow,
}));

vi.mock('../../lib/federatedMediaRequest.js', () => ({
  buildFederatedMediaRequest: mocks.buildFederatedMediaRequest,
}));
vi.mock('../federatedMedia/inputAssets.js', () => ({
  collectRemoteInputAssets: mocks.collectRemoteInputAssets,
}));
vi.mock('../federatedMedia/remoteSubmission.js', () => ({
  prepareRemoteMediaJob: mocks.prepareRemoteMediaJob,
}));
vi.mock('../fableLoom/records.js', () => ({ getLoom: mocks.getLoom }));
vi.mock('../fableLoom/visualConditioning.js', () => ({
  compileFableLoomVisualRequest: mocks.compileFableLoomVisualRequest,
  fableLoomVideoCapabilities: mocks.fableLoomVideoCapabilities,
}));
vi.mock('../mediaJobQueue/index.js', () => ({ enqueueJob: mocks.enqueueJob }));
vi.mock('../musicVideo/projects.js', () => ({ getProject: mocks.getMusicVideoProject }));
vi.mock('../musicVideo/clipCastReferences.js', () => ({ musicVideoClipCastReferences: mocks.musicVideoClipCastReferences }));
vi.mock('../musicVideo/performanceShot.js', () => ({ preparePerformanceShot: mocks.preparePerformanceShot }));
vi.mock('../musicVideo/revisionService.js', () => ({ assertRevisionOpen: mocks.assertRevisionOpen }));
vi.mock('../musicVideo/productionService.js', () => ({ assertProductionSubmission: mocks.assertProductionSubmission }));
vi.mock('./prepareParams.js', async (importOriginal) => ({
  ...await importOriginal(),
  cleanupMultipartTemp: mocks.cleanupMultipartTemp,
  prepareVideoGenParams: mocks.prepareVideoGenParams,
}));

import { submitVideoGenJob } from './submitJob.js';

const queued = { jobId: 'job-123', position: 2, status: 'queued' };

const localPrepared = (overrides = {}) => ({
  backend: 'local',
  cleanupStaged: vi.fn(async () => {}),
  pythonPath: '/example/python',
  effectiveModelId: 'local-model',
  effectiveNumFrames: 121,
  mode: 'text',
  sourceImagePath: null,
  lastImagePath: null,
  audioFilePath: null,
  icReferencePaths: [],
  resolvedKeyframes: [],
  extendFromVideoPath: null,
  uploadedTempPath: null,
  uploadedTempPaths: [],
  loras: [],
  effectiveChunks: 1,
  effectiveChunkPrompts: undefined,
  effectiveContextFrames: undefined,
  ...overrides,
});

describe('submitVideoGenJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enqueueJob.mockReturnValue(queued);
    mocks.preparePerformanceShot.mockResolvedValue(null);
    mocks.getMusicVideoProject.mockResolvedValue(null);
  });

  it('submits a federated job with only the remote-media marker', async () => {
    const request = { engine: 'video', modelId: 'remote-model' };
    const remoteMedia = { wireVersion: 1, peerId: 'peer-1', request };
    mocks.buildFederatedMediaRequest.mockReturnValue(request);
    mocks.prepareRemoteMediaJob.mockResolvedValue({
      peer: { id: 'peer-1' },
      remoteMedia,
    });

    await expect(submitVideoGenJob({
      prompt: 'Example shot',
      mediaProviderPeerId: 'peer-1',
      modelId: 'remote-model',
    }, {})).resolves.toEqual({
      ...queued,
      generationId: queued.jobId,
      filename: `${queued.jobId}.mp4`,
      model: 'remote-model',
      mode: null,
      mediaProviderPeerId: 'peer-1',
    });
    expect(mocks.enqueueJob).toHaveBeenCalledWith({
      kind: 'video',
      params: { remoteMedia },
    });
    expect(mocks.prepareVideoGenParams).not.toHaveBeenCalled();
  });

  it('refuses temporal intent that the federated wire cannot express', async () => {
    await expect(submitVideoGenJob({ prompt: 'a clip', mediaProviderPeerId: 'peer-1', continuityStrategy: 'window' }, {}))
      .rejects.toMatchObject({ status: 400, code: 'MEDIA_PROVIDER_INPUT_UNSUPPORTED' });
    expect(mocks.prepareRemoteMediaJob).not.toHaveBeenCalled();
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
  });

  it('submits a Grok job with the cloud response contract', async () => {
    const cleanupStaged = vi.fn(async () => {});
    mocks.prepareVideoGenParams.mockResolvedValue({
      backend: 'grok',
      cleanupStaged,
      grok: { grokPath: '/example/grok', aspectRatio: '16:9' },
      sourceImagePath: null,
      uploadedTempPath: null,
    });

    await expect(submitVideoGenJob({
      prompt: 'Example shot',
      backend: 'grok',
      width: 1280,
      height: 720,
      grokDuration: 10,
    }, {})).resolves.toEqual({
      ...queued,
      generationId: queued.jobId,
      filename: `${queued.jobId}.mp4`,
      model: 'grok',
      mode: 'grok',
    });
    expect(mocks.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'video',
      params: expect.objectContaining({ mode: 'grok', videoMode: 'text' }),
    }));
  });

  it('sends a Music Video shot cast sheets with its Grok still', async () => {
    const cast = [{ path: '/example/guest.png', label: 'Guest — cast sheet' }];
    mocks.musicVideoClipCastReferences.mockResolvedValueOnce(cast);
    mocks.prepareVideoGenParams.mockResolvedValue({
      backend: 'grok', cleanupStaged: vi.fn(async () => {}), grok: { grokPath: '/example/grok' },
      sourceImagePath: '/example/still.png', uploadedTempPath: null,
    });
    const tag = { projectId: 'mv-1', sceneId: 'shot-example' };
    await submitVideoGenJob({ prompt: 'a subject steps into view', backend: 'grok', mode: 'image', sourceImageFile: 'still.png', musicVideo: tag }, {});
    expect(mocks.musicVideoClipCastReferences).toHaveBeenCalledWith(tag);
    expect(mocks.enqueueJob.mock.calls[0][0].params).toEqual(expect.objectContaining({ castReferences: cast, sourceImagePath: '/example/still.png' }));
  });

  it('submits a local job with the effective model response contract', async () => {
    const continuation = { requestedStrategy: 'frame', effectiveStrategy: 'frame', contextFrames: 0,
      actualHistoryFrames: 0, runtime: 'minimax_h3', capability: false, backendPin: null, unavailableReason: 'hardware evidence pending' };
    mocks.prepareVideoGenParams.mockResolvedValue(localPrepared({ effectiveContextFrames: 0, continuation }));

    await expect(submitVideoGenJob({
      prompt: 'Example shot',
      continuityStrategy: 'frame',
      width: 1280,
      height: 720,
    }, {})).resolves.toEqual({
      ...queued,
      generationId: queued.jobId,
      filename: `${queued.jobId}.mp4`,
      model: 'local-model',
      mode: 'local',
    });
    expect(mocks.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'video',
      params: expect.objectContaining({
        pythonPath: '/example/python',
        numFrames: 121,
        mode: 'text',
        contextFrames: 0,
        continuityStrategy: 'frame',
        continuation,
      }),
    }));
    const params = mocks.enqueueJob.mock.calls[0][0].params;
    for (const key of ['textEncoderId', 'speedProfileId', 'draftDecode', 'i2vReferenceMode', 'chunkPrompts']) {
      expect(params).not.toHaveProperty(key);
    }
  });

  it('persists prepared chunk beats byte-for-byte into queued params', async () => {
    const chunkPrompts = [' \topening beat\n ', null, 'closing beat  '];
    mocks.prepareVideoGenParams.mockResolvedValue(localPrepared({ effectiveChunkPrompts: chunkPrompts }));

    await submitVideoGenJob({ prompt: 'Example shot', width: 1280, height: 720 }, {});
    expect(mocks.enqueueJob.mock.calls[0][0].params.chunkPrompts).toEqual(chunkPrompts);
  });

  it('cleans multipart uploads exactly once when submission fails', async () => {
    const failure = new Error('staging failed');
    const uploads = { sourceImage: { path: '/tmp/example-upload' } };
    mocks.prepareVideoGenParams.mockRejectedValue(failure);

    await expect(submitVideoGenJob({ prompt: 'Example shot' }, uploads)).rejects.toBe(failure);
    expect(mocks.cleanupMultipartTemp).toHaveBeenCalledTimes(1);
    expect(mocks.cleanupMultipartTemp).toHaveBeenCalledWith(uploads);
  });

  it('rolls staged assets back when enqueueing throws', async () => {
    const failure = new Error('queue full');
    const prepared = localPrepared();
    mocks.prepareVideoGenParams.mockResolvedValue(prepared);
    mocks.enqueueJob.mockImplementation(() => { throw failure; });

    await expect(submitVideoGenJob({ prompt: 'Example shot' }, {})).rejects.toBe(failure);
    expect(prepared.cleanupStaged).toHaveBeenCalledTimes(1);
  });

  // Uniquely catches a dependency read rejecting after durable inputs exist but
  // before any queue job could own them (#12394).
  describe('releases every owned input when a project read rejects before enqueue (#12394)', () => {
    const ltx = { id: 'ltx25-example', name: 'LTX-2.5 Example', runtime: 'ltx25', frameStride: 8, maxNumFrames: 1017, supportedModes: ['image', 'a2v'] };
    const project = { id: 'mv-1', videoSettings: { generationMode: 'suppliedAudio' }, scenes: [{ sceneId: 'mvs-1', startSec: 2, endSec: 3, shotMode: 'cutaway' }] };

    it('a local supplied-audio clip releases its staged frame', async () => {
      const failure = new Error('project store unavailable');
      const uploads = { sourceImage: { path: '/example/tmp/upload' } };
      const prepared = localPrepared({ effectiveModel: ltx, mode: 'image', sourceImagePath: '/example/uploads/frame.png' });
      mocks.resolveVideoModelSelection.mockResolvedValue({ model: ltx, modelId: ltx.id });
      mocks.prepareVideoGenParams.mockResolvedValue(prepared);
      // The render-pool and model reads succeed; the read after staging rejects.
      mocks.getMusicVideoProject.mockResolvedValueOnce(project).mockResolvedValueOnce(project).mockRejectedValueOnce(failure);

      await expect(submitVideoGenJob({ prompt: 'skyline', backend: 'local', modelId: ltx.id, mode: 'a2v', fps: 24,
        _suppliedAudio: true, musicVideo: { projectId: 'mv-1', sceneId: 'mvs-1' } }, uploads)).rejects.toBe(failure);
      expect(prepared.cleanupStaged).toHaveBeenCalledTimes(1);
      expect(mocks.cleanupMultipartTemp).toHaveBeenCalledWith(uploads);
      expect(mocks.prepareSourceAudioWindow).not.toHaveBeenCalled();
      expect(mocks.enqueueJob).not.toHaveBeenCalled();
    });

    it('a hosted performance shot releases its staged frame and sliced song excerpt', async () => {
      const failure = new Error('project store unavailable');
      const slice = '/example/uploads/mv-performance-1.wav';
      const prepared = { backend: 'fal', cleanupStaged: vi.fn(async () => {}), sourceImagePath: '/example/images/frame.png', uploadedTempPath: null };
      mocks.prepareVideoGenParams.mockResolvedValue(prepared);
      mocks.preparePerformanceShot.mockResolvedValue({ audioFilePath: slice, modelId: 'fal-lipsync-example', resolution: '1080P',
        enableTranscription: true, shotInstruction: { version: 1, shotMode: 'performance', edit: { inSec: 0 } } });
      // The render-pool read succeeds; the project-aspect read rejects.
      mocks.getMusicVideoProject.mockResolvedValueOnce(null).mockRejectedValueOnce(failure);

      await expect(submitVideoGenJob({ prompt: 'singer', backend: 'fal', mode: 'image',
        musicVideo: { projectId: 'mv-1', sceneId: 'mvs-1' } }, {})).rejects.toBe(failure);
      expect(prepared.cleanupStaged).toHaveBeenCalledTimes(1);
      expect(mocks.unlink).toHaveBeenCalledWith(slice);
      expect(mocks.unlink).not.toHaveBeenCalledWith('/example/images/frame.png');
      expect(mocks.enqueueJob).not.toHaveBeenCalled();
    });

    it('keeps owned inputs for the worker once the job is queued', async () => {
      const slice = '/example/uploads/mv-performance-1.wav';
      const prepared = { backend: 'fal', cleanupStaged: vi.fn(async () => {}), sourceImagePath: '/example/images/frame.png', uploadedTempPath: null };
      mocks.prepareVideoGenParams.mockResolvedValue(prepared);
      mocks.preparePerformanceShot.mockResolvedValue({ audioFilePath: slice, modelId: 'fal-lipsync-example', resolution: '1080P',
        enableTranscription: true, shotInstruction: { version: 1, shotMode: 'performance', edit: { inSec: 0 } } });

      await submitVideoGenJob({ prompt: 'singer', backend: 'fal', mode: 'image', musicVideo: { projectId: 'mv-1', sceneId: 'mvs-1' } }, {});
      expect(mocks.enqueueJob).toHaveBeenCalledTimes(1);
      expect(prepared.cleanupStaged).not.toHaveBeenCalled();
      expect(mocks.unlink).not.toHaveBeenCalled();
    });
  });

  it('rolls staged assets back when FableLoom compilation rejects', async () => {
    const failure = new Error('conditioning failed');
    const prepared = localPrepared();
    mocks.getLoom.mockResolvedValue({ renderSettings: {} });
    mocks.prepareVideoGenParams.mockResolvedValue(prepared);
    mocks.fableLoomVideoCapabilities.mockReturnValue({ modes: ['text'] });
    mocks.compileFableLoomVisualRequest.mockRejectedValue(failure);

    await expect(submitVideoGenJob({
      prompt: 'Example shot',
      fableLoom: { loomId: 'loom-example', sceneId: 'scene-example' },
    }, {})).rejects.toBe(failure);
    expect(prepared.cleanupStaged).toHaveBeenCalledTimes(1);
  });

  // Uniquely catches a hosted backend losing its conditioning stub, or a local one stopping at the resolved model.
  it.each([
    ['grok', { id: 'grok-video', supportedModes: ['image'] }],
    ['fal', { id: 'fal-video', supportedModes: ['text', 'image'] }],
    ['runway', { id: 'runway-video', supportedModes: ['text', 'image'] }],
    ['reactor', { id: 'reactor-video', supportedModes: ['text', 'image'] }],
    ['local', { id: 'local-ltx', supportedModes: ['text'], revision: 'r1' }],
  ])('tells the FableLoom compile which model the %s backend renders with', async (backend, model) => {
    mocks.prepareVideoGenParams.mockResolvedValue(backend === 'local'
      ? localPrepared({ effectiveModel: model })
      : { backend, cleanupStaged: vi.fn(async () => {}), grok: { grokPath: '/example/grok' }, sourceImagePath: null, uploadedTempPath: null });
    mocks.fableLoomVideoCapabilities.mockReturnValue({ modes: ['text'] });
    mocks.compileFableLoomVisualRequest.mockResolvedValue({ prompt: 'p', negativePrompt: 'n', sourceImagePath: null, visualConditioning: { version: 1 } });

    await submitVideoGenJob({ prompt: 'Example shot', fableLoom: { loomId: 'loom-example', sceneId: 'scene-example' }, width: 640, height: 360 }, {});
    expect(mocks.fableLoomVideoCapabilities).toHaveBeenCalledWith({ backend, model });
    const { visualConditioning } = mocks.enqueueJob.mock.calls.at(-1)[0].params;
    expect(visualConditioning.render).toMatchObject({ provider: backend, modelId: model.id, modelRevision: model.revision ?? null });
  });

  it('enqueues a standalone fal lip sync with the staged voice clip, owned by the queue', async () => {
    mocks.prepareVideoGenParams.mockResolvedValue({
      backend: 'fal', cleanupStaged: vi.fn(async () => {}), sourceImagePath: '/example/images/face.png', uploadedTempPath: null,
      audioFilePath: '/example/uploads/video-audio-1.wav', uploadedTempPaths: ['/example/uploads/video-audio-1.wav'],
    });
    await submitVideoGenJob({ prompt: 'lip sync', backend: 'fal', falModelId: 'minimax/h3-max/lip-sync/image-to-video', mode: 'image' }, {});
    const { params } = mocks.enqueueJob.mock.calls.at(-1)[0];
    expect(params).toMatchObject({
      mode: 'fal', modelId: 'minimax/h3-max/lip-sync/image-to-video', sourceImagePath: '/example/images/face.png',
      audioFilePath: '/example/uploads/video-audio-1.wav', uploadedTempPaths: ['/example/uploads/video-audio-1.wav'],
      lipSync: { enableTranscription: false },
    });
  });

  describe('music-video performance shots (#8977)', () => {
    const musicVideo = { projectId: 'mv-1', sceneId: 'mvs-1' };
    const falPrepared = () => ({
      backend: 'fal', cleanupStaged: vi.fn(async () => {}),
      sourceImagePath: '/example/images/frame.png', uploadedTempPath: null,
    });

    it('enqueues the lip-sync model, song slice and shot instruction instead of a clip-length pin', async () => {
      const shotInstruction = { version: 1, shotMode: 'performance', edit: { inSec: 1.775, outSec: 3.275 } };
      mocks.prepareVideoGenParams.mockResolvedValue(falPrepared());
      mocks.preparePerformanceShot.mockResolvedValue({
        audioFilePath: '/example/uploads/mv-performance-1.wav', shotInstruction,
        modelId: 'minimax/h3-max/lip-sync/image-to-video', resolution: '1080P', enableTranscription: true,
      });

      // A cutaway model/resolution pin and an audio request ride the same body;
      // the performance plan's lip-sync model and resolution replace them.
      await submitVideoGenJob({
        prompt: 'singer', backend: 'fal', falDuration: 6, falModelId: 'minimax/h3-max/image-to-video',
        falResolution: '1080p', falGenerateAudio: true, musicVideo, mode: 'image',
      }, {});
      expect(mocks.preparePerformanceShot).toHaveBeenCalledWith({
        musicVideo, backend: 'fal', sourceImagePath: '/example/images/frame.png', mode: 'image', resolution: '1080p',
        // A music-driven shot's picked model; a lip-sync scene ignores it.
        musicModelId: 'minimax/h3-max/image-to-video',
      });
      const { params } = mocks.enqueueJob.mock.calls[0][0];
      expect(params).toMatchObject({
        mode: 'fal', modelId: 'minimax/h3-max/lip-sync/image-to-video', resolution: '1080P',
        audioFilePath: '/example/uploads/mv-performance-1.wav',
        lipSync: { enableTranscription: true }, shotInstruction, musicVideo,
      });
      expect(params.duration).toBeUndefined();
      expect(params.generateAudio).toBeUndefined();
    });

    it('asks for the project aspect and crops the clip frames to it (a 9:16 project)', async () => {
      mocks.prepareVideoGenParams.mockResolvedValue(falPrepared());
      mocks.getMusicVideoProject.mockResolvedValue({ id: 'mv-1', scenes: [{ sceneId: 'mvs-1' }], treatment: { brief: { aspectRatio: '9:16' } } });
      await submitVideoGenJob({ prompt: 'singer', backend: 'fal', falModelId: 'fal-ai/bytedance/omnihuman/v1.5', musicVideo, mode: 'image' }, {});
      expect(mocks.enqueueJob.mock.calls[0][0].params).toMatchObject({ aspectRatio: '9:16', frameAspect: '9:16' });
    });

    // Uniquely catches the server composing a shot clip differently from the shot card, or
    // adding look words and song timing a take that hears nothing would act out (#11317).
    it('composes a board clip from the director\'s text, adding each block as a labeled addition', async () => {
      const scene = {
        sceneId: 'mvs-1', startSec: 0, endSec: 4, camera: { move: 'fast-dolly-in', speed: 'fast', onBeat: true },
        direction: { motionClause: 'slow drift', actionContract: { version: 1, purpose: 'She leaves',
          actions: [{ startSec: 0, endSec: 1, subject: 'Singer', description: 'Offers a hand' }] } },
      };
      const project = { id: 'mv-1', scenes: [scene], concept: { style: 'grainy 16mm' },
        lyricCues: [{ startSec: 0.5, endSec: 1.5, text: 'hold on', words: [] }] };
      mocks.getMusicVideoProject.mockResolvedValue(project);
      mocks.prepareVideoGenParams.mockResolvedValue(falPrepared());
      await submitVideoGenJob({ prompt: 'she turns away', backend: 'fal', mode: 'image', musicVideo: { ...musicVideo, compose: true } }, {});
      const silent = mocks.enqueueJob.mock.calls[0][0].params;
      expect(silent.prompt.startsWith('she turns away, slow drift, ')).toBe(true);
      expect(silent.prompt).toContain('Action 0.000s–1.000s: Singer');
      expect(silent.prompt).not.toContain('grainy 16mm');
      expect(silent.prompt).not.toContain('Lyric');
      expect(silent.prompt).not.toContain('downbeat');
      expect(silent.promptAdditions.map((item) => item.id)).toEqual(['shot-direction', 'lighting-continuity', 'camera-move', 'shot-actions']);

      // A take that hears the song gets the project look and the lyric timing, each listed.
      mocks.prepareVideoGenParams.mockResolvedValue({ ...falPrepared(), audioFilePath: '/example/uploads/song.wav' });
      await submitVideoGenJob({ prompt: 'she turns away', backend: 'fal', mode: 'image', musicVideo: { ...musicVideo, compose: true } }, {});
      const hearing = mocks.enqueueJob.mock.calls[1][0].params;
      expect(hearing.prompt).toContain('grainy 16mm');
      expect(hearing.prompt).toContain('Lyric 0.500s–1.500s: hold on');
      expect(hearing.prompt).toContain('land the move exactly on the downbeat');
      expect(hearing.promptAdditions.map((item) => item.id)).toContain('project-style');

      // A music-driven take on a reference model is told which reference is the song.
      mocks.prepareVideoGenParams.mockResolvedValue(falPrepared());
      mocks.preparePerformanceShot.mockResolvedValue({
        audioFilePath: '/example/uploads/mv-performance-2.wav', modelId: 'minimax/h3-max/reference-to-video', resolution: '768P',
        shotInstruction: { version: 2, shotMode: 'performance', performanceStyle: 'music', songInterval: { startSec: 0, endSec: 4 }, edit: { inSec: 0 } },
      });
      await submitVideoGenJob({ prompt: 'she turns away', backend: 'fal', mode: 'image', musicVideo: { ...musicVideo, compose: true } }, {});
      const music = mocks.enqueueJob.mock.calls[2][0].params;
      expect(music).toMatchObject({ modelId: 'minimax/h3-max/reference-to-video', audioFilePath: '/example/uploads/mv-performance-2.wav' });
      expect(music.promptAdditions).toContainEqual({ id: 'audio-reference', label: 'Song audio reference',
        text: 'Audio 1 is the song playing under this shot: time the movement to its beat.' });
      expect(music.prompt.endsWith('. Audio 1 is the song playing under this shot: time the movement to its beat.')).toBe(true);
    });

    it('leaves a clip outside a music video at its own aspect', async () => {
      mocks.prepareVideoGenParams.mockResolvedValue(falPrepared());
      await submitVideoGenJob({ prompt: 'a fox', backend: 'fal', mode: 'image' }, {});
      expect(mocks.enqueueJob.mock.calls[0][0].params).not.toHaveProperty('frameAspect');
    });

    it('refuses a performance shot the backend cannot render and releases what was staged', async () => {
      const prepared = { ...falPrepared(), backend: 'grok', grok: { grokPath: '/example/grok' } };
      mocks.prepareVideoGenParams.mockResolvedValue(prepared);
      const refusal = Object.assign(new Error('Grok video is cutaway-only'), { status: 400, code: 'MUSIC_VIDEO_PERFORMANCE_UNSUPPORTED' });
      mocks.preparePerformanceShot.mockRejectedValue(refusal);

      await expect(submitVideoGenJob({ prompt: 'singer', backend: 'grok', musicVideo }, {})).rejects.toBe(refusal);
      expect(prepared.cleanupStaged).toHaveBeenCalledTimes(1);
      expect(mocks.enqueueJob).not.toHaveBeenCalled();
    });

    describe('on local LTX', () => {
      const ltx = { id: 'ltx25-example', name: 'LTX-2.5 Example', runtime: 'ltx25', frameStride: 8, maxNumFrames: 1017 };
      const slice = '/example/uploads/mv-performance-2.wav';
      const shotInstruction = {
        version: 2, shotMode: 'performance', audioWindow: { startSec: 2.003, endSec: 6.203, durationSec: 4.2 },
        edit: { inSec: 0, outSec: 4.2, targetSec: 4.2 },
      };
      beforeEach(() => {
        mocks.preparePerformanceShot.mockResolvedValue({ audioFilePath: slice, shotInstruction, modelId: null, resolution: null, enableTranscription: false });
      });

      it('renders the song window as LTX audio-to-video on a canvas that covers it', async () => {
        mocks.prepareVideoGenParams.mockResolvedValue(localPrepared({
          effectiveModel: ltx, mode: 'image', sourceImagePath: '/example/images/frame.png', uploadedTempPaths: ['/example/uploads/frame.png'],
        }));
        await submitVideoGenJob({ prompt: 'singer', backend: 'local', modelId: ltx.id, mode: 'image', disableAudio: true, fps: 24, musicVideo }, {});
        const { params } = mocks.enqueueJob.mock.calls[0][0];
        // 4.2 s at 24 fps needs 102 frames; the LTX 8n+1 grid rounds that to 105.
        expect(params).toMatchObject({
          mode: 'a2v', numFrames: 105, audioFilePath: slice, audioStartSec: 0, disableAudio: false, shotInstruction,
          uploadedTempPaths: ['/example/uploads/frame.png', slice],
        });
        expect(params).not.toHaveProperty('lipSync');
      });

      // Uniquely catches MiniMax H3 Ref2VA (image + audio only) being refused
      // for lip-sync, or sent a frame count off its 17n+5 grid.
      it('renders the song window on MiniMax H3 Ref2VA at its covering frame count', async () => {
        const ref2va = { id: 'ref2va-example', name: 'Ref2VA Example', runtime: 'minimax_h3_ref2va', supportedModes: ['a2v'], frameOptions: [107, 124, 141], fpsOptions: [24] };
        mocks.prepareVideoGenParams.mockResolvedValue(localPrepared({ effectiveModel: ref2va, mode: 'image', sourceImagePath: '/example/images/frame.png' }));
        await submitVideoGenJob({ prompt: 'singer', backend: 'local', modelId: ref2va.id, mode: 'image', fps: 24, musicVideo }, {});
        expect(mocks.enqueueJob.mock.calls[0][0].params).toMatchObject({ mode: 'a2v', numFrames: 107, audioFilePath: slice, audioStartSec: 0, disableAudio: false });
      });

      it('renders a local cutaway silent unless the song conditions it', async () => {
        mocks.preparePerformanceShot.mockResolvedValue(null);
        mocks.prepareVideoGenParams.mockResolvedValue(localPrepared({ effectiveModel: ltx, mode: 'image' }));
        await submitVideoGenJob({ prompt: 'skyline', backend: 'local', mode: 'image', musicVideo }, {});
        mocks.prepareVideoGenParams.mockResolvedValue(localPrepared({ effectiveModel: ltx, mode: 'a2v' }));
        await submitVideoGenJob({ prompt: 'skyline', backend: 'local', mode: 'a2v', musicVideo }, {});
        await submitVideoGenJob({ prompt: 'skyline', backend: 'local', mode: 'a2v' }, {});
        expect(mocks.enqueueJob.mock.calls.map(([job]) => job.params.disableAudio)).toEqual([true, false, false]);
      });

      it('refuses a local model without audio-to-video and releases the slice and staged inputs', async () => {
        const prepared = localPrepared({ effectiveModel: { id: 'wan-example', name: 'Example Wan', runtime: 'wan22' }, mode: 'image' });
        mocks.prepareVideoGenParams.mockResolvedValue(prepared);
        await expect(submitVideoGenJob({ prompt: 'singer', backend: 'local', mode: 'image', musicVideo }, {}))
          .rejects.toMatchObject({ status: 400, code: 'MUSIC_VIDEO_PERFORMANCE_UNSUPPORTED', message: expect.stringMatching(/Example Wan cannot lip-sync/) });
        expect(prepared.cleanupStaged).toHaveBeenCalledTimes(1);
        expect(mocks.enqueueJob).not.toHaveBeenCalled();
      });
    });

    it('refuses a kickoff tagged for a revision that has since closed, as the last step before the queue write (#9011)', async () => {
      const closed = Object.assign(new Error('This revision is already canceled'), { status: 409, code: 'REVISION_CLOSED' });
      mocks.assertRevisionOpen.mockRejectedValueOnce(closed);
      const tagged = { ...musicVideo, revisionId: 'mvr-1' };
      const prepared = falPrepared();
      mocks.prepareVideoGenParams.mockResolvedValue(prepared);

      await expect(submitVideoGenJob({ prompt: 'singer', backend: 'fal', musicVideo: tagged }, {})).rejects.toBe(closed);
      expect(mocks.assertRevisionOpen).toHaveBeenCalledWith('mv-1', 'mvr-1', { sceneId: musicVideo.sceneId, kind: 'video' });
      // The check runs immediately before enqueueJob — after staging, not before
      // it — so the race window against a concurrent cancel is as small as this
      // request can make it; a refusal there still rolls back what was staged.
      expect(mocks.prepareVideoGenParams).toHaveBeenCalledTimes(1);
      expect(prepared.cleanupStaged).toHaveBeenCalledTimes(1);
      expect(mocks.enqueueJob).not.toHaveBeenCalled();
    });

    it('does not check for a revision when the tag carries no revisionId', async () => {
      mocks.prepareVideoGenParams.mockResolvedValue(falPrepared());
      await submitVideoGenJob({ prompt: 'singer', backend: 'fal', musicVideo }, {});
      expect(mocks.assertRevisionOpen).not.toHaveBeenCalled();
    });

    it('refuses generated footage when the brief names tools and none makes video, and queues once a video tool is selected', async () => {
      const prepared = falPrepared();
      mocks.prepareVideoGenParams.mockResolvedValue(prepared);
      mocks.getMusicVideoProject.mockResolvedValue({ id: 'mv-1', scenes: [], automation: { tools: ['image:codex', 'code:render'] }, productionPolicy: { strategy: 'code-first', maxGeneratedVideoPercent: 0 } });
      await expect(submitVideoGenJob({ prompt: 'selected shot', backend: 'fal', musicVideo }, {})).rejects.toMatchObject({ status: 409, code: 'MUSIC_VIDEO_NO_VIDEO_TOOL' });
      expect(mocks.enqueueJob).not.toHaveBeenCalled();
      expect(prepared.cleanupStaged).toHaveBeenCalledTimes(1);

      // A brief naming no tools restricts nothing; one naming a video tool dispatches.
      for (const automation of [undefined, { tools: [] }, { tools: ['image:codex', 'video:fal'] }]) {
        mocks.enqueueJob.mockReturnValue(queued);
        mocks.getMusicVideoProject.mockResolvedValue({ id: 'mv-1', scenes: [{ sceneId: 'mvs-1' }], automation });
        await expect(submitVideoGenJob({ prompt: 'selected shot', backend: 'fal', musicVideo }, {})).resolves.toMatchObject({ jobId: 'job-123' });
      }
    });

    it('records the quoted fal estimate on a board-started clip but not on a production-run step (#10157)', async () => {
      mocks.prepareVideoGenParams.mockResolvedValue(falPrepared());
      mocks.getMusicVideoProject.mockResolvedValue({ id: 'mv-1', scenes: [{ sceneId: 'mvs-1', startSec: 0, endSec: 5 }] });
      await submitVideoGenJob({ prompt: 'selected shot', backend: 'fal', musicVideo }, {});
      expect(mocks.enqueueJob.mock.calls.at(-1)[0].params.musicVideoCostUsd).toBeGreaterThan(0);
      await submitVideoGenJob({ prompt: 'selected shot', backend: 'fal', musicVideo: { ...musicVideo, productionRunId: 'mvpr-1', productionStepKey: 'k' } }, {});
      expect(mocks.enqueueJob.mock.calls.at(-1)[0].params).not.toHaveProperty('musicVideoCostUsd');
    });

    it('stamps the quoted runway estimate on a board-started clip but not on a production-run step (#10157)', async () => {
      mocks.prepareVideoGenParams.mockResolvedValue({ ...falPrepared(), backend: 'runway' });
      mocks.getMusicVideoProject.mockResolvedValue({ id: 'mv-1', scenes: [{ sceneId: 'mvs-1', startSec: 0, endSec: 5 }] });
      await submitVideoGenJob({ prompt: 'selected shot', backend: 'runway', musicVideo }, {});
      const { params } = mocks.enqueueJob.mock.calls.at(-1)[0];
      expect(params.musicVideoCostUsd).toBeGreaterThan(0);
      expect(params.musicVideoCostModelId).toEqual(expect.any(String));
      await submitVideoGenJob({ prompt: 'selected shot', backend: 'runway', musicVideo: { ...musicVideo, productionRunId: 'mvpr-1', productionStepKey: 'k' } }, {});
      expect(mocks.enqueueJob.mock.calls.at(-1)[0].params).not.toHaveProperty('musicVideoCostUsd');
    });

    it('refuses a performance slice cut for a scene whose timing has since changed', async () => {
      const prepared = falPrepared();
      mocks.prepareVideoGenParams.mockResolvedValue(prepared);
      mocks.preparePerformanceShot.mockResolvedValue({ audioFilePath: '/example/uploads/mv-performance-1.wav', modelId: 'lip-sync', resolution: '1080P',
        enableTranscription: true, shotInstruction: { version: 1, shotMode: 'performance', songInterval: { startSec: 0, endSec: 4 }, edit: { inSec: 0 } } });
      mocks.getMusicVideoProject.mockResolvedValue({ id: 'mv-1', scenes: [{ sceneId: 'mvs-1', startSec: 0, endSec: 5 }] });

      await expect(submitVideoGenJob({ prompt: 'singer', backend: 'fal', mode: 'image', musicVideo }, {}))
        .rejects.toMatchObject({ status: 409, code: 'MUSIC_VIDEO_SHOT_TIMING_CHANGED' });
      expect(mocks.enqueueJob).not.toHaveBeenCalled();
      expect(prepared.cleanupStaged).toHaveBeenCalledTimes(1);
    });

    it('refuses supplied audio prepared against a song that has since changed', async () => {
      const prepared = { ...falPrepared(), audio: { audioDependencies: null, audioConditioning: { startSample: 0 } } };
      mocks.prepareVideoGenParams.mockResolvedValue(prepared);
      mocks.getMusicVideoProject.mockResolvedValue({ id: 'mv-1', scenes: [{ sceneId: 'mvs-1', startSec: 0, endSec: 5 }] });

      await expect(submitVideoGenJob({ prompt: 'selected shot', backend: 'fal', musicVideo }, {}))
        .rejects.toMatchObject({ status: 409, code: 'MUSIC_VIDEO_AUDIO_SOURCE_CHANGED' });
      expect(mocks.enqueueJob).not.toHaveBeenCalled();
      expect(prepared.cleanupStaged).toHaveBeenCalledTimes(1);
    });

    it('checks the current production policy after video preparation, before queueing', async () => {
      const changed = Object.assign(new Error('The approved plan changed'), { status: 409, code: 'PRODUCTION_BASIS_CHANGED' });
      const prepared = falPrepared();
      mocks.prepareVideoGenParams.mockResolvedValue(prepared);
      mocks.assertProductionSubmission.mockRejectedValueOnce(changed);
      const tagged = { ...musicVideo, productionRunId: 'mvpr-1', productionStepKey: 'clip:scene:base:1' };

      await expect(submitVideoGenJob({ prompt: 'selected shot', backend: 'fal', musicVideo: tagged }, {})).rejects.toBe(changed);
      expect(mocks.prepareVideoGenParams).toHaveBeenCalledTimes(1);
      expect(mocks.assertProductionSubmission).toHaveBeenCalledWith('mv-1', 'mvpr-1', tagged.productionStepKey,
        { sceneId: musicVideo.sceneId, kind: 'video' });
      expect(prepared.cleanupStaged).toHaveBeenCalledTimes(1);
      expect(mocks.enqueueJob).not.toHaveBeenCalled();
    });
  });
});

// Regression: client-built prompts could bypass current shot timing and lose padded-window intent.
describe('shot intent at the video submission boundary', () => {
  const contract = { version: 1, purpose: 'The listener decides to stay',
    actions: [{ startSec: 0, endSec: 1, subject: 'Singer', description: 'Offers a hand' }],
    reactions: [{ startSec: 1, endSec: 2, subject: 'Listener', description: 'Accepts' }],
    acceptanceCriteria: ['Both actions are visible'],
  };
  const project = () => ({ scenes: [{ sceneId: 's', startSec: 10, endSec: 14, direction: { actionContract: contract } }],
    lyricCues: [{ text: 'Stay', startSec: 10.5, endSec: 11.5, words: [{ w: 'Stay', startSec: 10.5, endSec: 11.5 }] }],
    audioAnalysis: { features: { onsets: { low: [10.75], mid: [], high: [] } } },
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enqueueJob.mockReturnValue(queued);
    mocks.prepareVideoGenParams.mockResolvedValue(localPrepared());
    mocks.preparePerformanceShot.mockResolvedValue(null);
    mocks.getMusicVideoProject.mockResolvedValue(project());
  });

  it('queues current action/reaction and immutable intent even when the client omitted it', async () => {
    await submitVideoGenJob({ prompt: 'Legacy free text', musicVideo: { projectId: 'p', sceneId: 's' } }, {});
    const { params } = mocks.enqueueJob.mock.calls[0][0];
    expect(params.prompt).toContain('Legacy free text');
    expect(params.prompt).toContain('Reaction 1.000s–2.000s: Listener');
    expect(params.shotInstruction.actionContract).toEqual(contract);
  });

  // Regression: a model that hears no audio acted out song cues and look words ("film falling onto the bed").
  it('sends a take that hears no audio plain physical motion, without song cues or look words', async () => {
    mocks.getMusicVideoProject.mockResolvedValue({ ...project(), concept: { style: 'grainy 35mm Kodak look' } });
    await submitVideoGenJob({ prompt: 'Her head drops onto the pillow on "Sleep", grainy 35mm Kodak look, camera holds', musicVideo: { projectId: 'p', sceneId: 's' } }, {});
    const { params } = mocks.enqueueJob.mock.calls[0][0];
    expect(params.prompt).toContain('Her head drops onto the pillow, camera holds');
    expect(params.prompt).toContain('Action 0.000s–1.000s: Singer — Offers a hand');
    expect(params.prompt).not.toMatch(/Sleep|Kodak|grain|Word \d|Musical onsets/);
  });

  // Adam: the shot card's Render sends what the card shows, nothing the director cannot see.
  it('sends a shot card Render prompt exactly as typed', async () => {
    mocks.getMusicVideoProject.mockResolvedValue({ ...project(), concept: { style: 'grainy 35mm Kodak look' } });
    const prompt = 'She shakes her head on "Sleep", grainy 35mm Kodak look';
    await submitVideoGenJob({ prompt, musicVideo: { projectId: 'p', sceneId: 's', promptAsTyped: true } }, {});
    const { params } = mocks.enqueueJob.mock.calls[0][0];
    expect(params.prompt).toBe(prompt);
    expect(params.shotInstruction.actionContract).toEqual(contract);
  });

  it('still re-times a card-typed performance prompt to its padded song slice', async () => {
    mocks.prepareVideoGenParams.mockResolvedValue({ backend: 'fal', cleanupStaged: vi.fn(), sourceImagePath: '/example/frame.png' });
    mocks.preparePerformanceShot.mockResolvedValue({ audioFilePath: '/example/audio.wav', modelId: 'lip-sync', resolution: '1080P',
      shotInstruction: { version: 1, shotMode: 'performance', songInterval: { startSec: 10, endSec: 14 }, edit: { inSec: 1.5, outSec: 5.5 } } });
    await submitVideoGenJob({ prompt: 'Typed\nShot intent (clip-relative seconds):\nAction 0.000s–1.000s: Singer\nEnd shot intent.', backend: 'fal',
      musicVideo: { projectId: 'p', sceneId: 's', promptAsTyped: true } }, {});
    const { params } = mocks.enqueueJob.mock.calls[0][0];
    expect(params.prompt.startsWith('Typed\n')).toBe(true);
    expect(params.prompt).toContain('Action 1.500s–2.500s: Singer');
    expect(params.prompt).not.toContain('Action 0.000s–1.000s');
  });

  it('shifts contract and words into a padded performance window exactly once', async () => {
    mocks.prepareVideoGenParams.mockResolvedValue({ backend: 'fal', cleanupStaged: vi.fn(), sourceImagePath: '/example/frame.png' });
    mocks.preparePerformanceShot.mockResolvedValue({ audioFilePath: '/example/audio.wav', modelId: 'lip-sync', resolution: '1080P',
      shotInstruction: { version: 1, shotMode: 'performance', songInterval: { startSec: 10, endSec: 14 }, edit: { inSec: 1.5, outSec: 5.5 } } });
    await submitVideoGenJob({ prompt: 'Legacy\nShot intent (clip-relative seconds):\nstale intent\nEnd shot intent.. Keep moving', backend: 'fal', musicVideo: { projectId: 'p', sceneId: 's' } }, {});
    const { params } = mocks.enqueueJob.mock.calls[0][0];
    expect(params.prompt).toContain('Action 1.500s–2.500s: Singer');
    expect(params.prompt).toContain('Word 2.000s–3.000s: Stay');
    expect(params.prompt).toContain('Musical onsets: 2.250s');
    expect(params.prompt).not.toContain('stale intent');
    expect(params.prompt).toContain('Keep moving');
    expect(params.shotInstruction.edit.inSec).toBe(1.5);
  });

  it('refuses a provider clip shorter than the final action before enqueue', async () => {
    mocks.prepareVideoGenParams.mockResolvedValue({ backend: 'fal', cleanupStaged: vi.fn(), sourceImagePath: '/example/frame.png' });
    await expect(submitVideoGenJob({ prompt: 'Legacy', backend: 'fal', falDuration: 1, musicVideo: { projectId: 'p', sceneId: 's' } }, {})).rejects.toMatchObject({ code: 'MUSIC_VIDEO_ACTION_CONTRACT_INVALID' });
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
  });

  it('refuses a later shortened scene before queue spend and rolls back staged inputs', async () => {
    const changed = project(); changed.scenes[0].endSec = 11;
    mocks.getMusicVideoProject.mockResolvedValue(changed);
    const prepared = localPrepared(); mocks.prepareVideoGenParams.mockResolvedValue(prepared);
    await expect(submitVideoGenJob({ prompt: 'Legacy', musicVideo: { projectId: 'p', sceneId: 's' } }, {})).rejects.toMatchObject({ code: 'MUSIC_VIDEO_ACTION_CONTRACT_INVALID' });
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
    expect(prepared.cleanupStaged).toHaveBeenCalledTimes(1);
  });
});

// Catches an omitted layout at the video submission boundary, and a removed capture.
it('queues a video with the live layout and recorded figures, and queues nothing when the capture is removed', async () => {
  vi.clearAllMocks();
  mocks.enqueueJob.mockReturnValue(queued);
  mocks.preparePerformanceShot.mockResolvedValue(null);
  mkdirSync(PATHS.images, { recursive: true });
  writeFileSync(join(PATHS.images, 'layout.png'), 'fixture');
  const selected = { sceneId: 's1', prompt: 'She waves', setReference: { subjectId: 'rink', greyboxShotId: 'wide' } };
  mocks.getMusicVideoProject.mockResolvedValue({ id: 'mv-1', concept: { subjects: [{ id: 'rink', name: 'Example Rink', kind: 'place', ingredientId: 'cat-rink' }] }, scenes: [selected] });
  mocks.getIngredient.mockResolvedValue({ type: 'place', payload: { greybox: { anchors: [{ id: 'rail', label: 'Singer' }], shots: [{ id: 'wide', figures: [{ anchorId: 'rail', pose: 'waving' }] }] } } });
  mocks.listMediaForIngredient.mockResolvedValue([{ kind: 'reference', role: 'greybox-shot:wide', mediaKey: 'layout.png' }]);
  mocks.prepareVideoGenParams.mockResolvedValue(localPrepared({ referenceImagePaths: [join(PATHS.images, 'layout.png')] }));
  const body = { prompt: 'She waves', backend: 'local', musicVideo: { projectId: 'mv-1', sceneId: 's1', compose: true, promptAsTyped: true } };
  await submitVideoGenJob(body, {});
  expect(mocks.prepareVideoGenParams.mock.calls[0][0].body.referenceImageFiles).toEqual(['layout.png']);
  const params = mocks.enqueueJob.mock.calls[0][0].params;
  expect(params.referenceImagePaths).toEqual([join(PATHS.images, 'layout.png')]);
  expect(params.prompt).toContain('Singer stands at the "rail" mark, waving');
  expect(params.promptAdditions).toContainEqual(expect.objectContaining({ id: 'greybox-figure-0' }));
  mocks.enqueueJob.mockClear();
  mocks.listMediaForIngredient.mockResolvedValue([]);
  await expect(submitVideoGenJob(body, {})).rejects.toMatchObject({ code: 'MUSIC_VIDEO_GREYBOX_UNAVAILABLE' });
  expect(mocks.enqueueJob).not.toHaveBeenCalled();
});
