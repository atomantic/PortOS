import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildFederatedMediaRequest: vi.fn(),
  cleanupMultipartTemp: vi.fn(async () => {}),
  collectRemoteInputAssets: vi.fn(() => []),
  compileFableLoomVisualRequest: vi.fn(),
  enqueueJob: vi.fn(),
  fableLoomVideoCapabilities: vi.fn(),
  getMusicVideoProject: vi.fn(async () => null),
  getLoom: vi.fn(async () => null),
  prepareRemoteMediaJob: vi.fn(),
  prepareVideoGenParams: vi.fn(),
  preparePerformanceShot: vi.fn(async () => null),
  assertRevisionOpen: vi.fn(async () => {}),
  assertProductionSubmission: vi.fn(async () => {}),
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

  it('submits a local job with the effective model response contract', async () => {
    mocks.prepareVideoGenParams.mockResolvedValue(localPrepared({ effectiveContextFrames: 0 }));

    await expect(submitVideoGenJob({
      prompt: 'Example shot',
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
      }),
    }));
    const params = mocks.enqueueJob.mock.calls[0][0].params;
    for (const key of ['textEncoderId', 'speedProfileId', 'draftDecode', 'i2vReferenceMode', 'chunkPrompts']) {
      expect(params).not.toHaveProperty(key);
    }
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

    it('refuses a performance shot the backend cannot render and releases what was staged', async () => {
      const prepared = { ...falPrepared(), backend: 'grok', grok: { grokPath: '/example/grok' } };
      mocks.prepareVideoGenParams.mockResolvedValue(prepared);
      const refusal = Object.assign(new Error('Grok video is cutaway-only'), { status: 400, code: 'MUSIC_VIDEO_PERFORMANCE_UNSUPPORTED' });
      mocks.preparePerformanceShot.mockRejectedValue(refusal);

      await expect(submitVideoGenJob({ prompt: 'singer', backend: 'grok', musicVideo }, {})).rejects.toBe(refusal);
      expect(prepared.cleanupStaged).toHaveBeenCalledTimes(1);
      expect(mocks.enqueueJob).not.toHaveBeenCalled();
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

  it('queues current action/reaction, actual words/onsets and immutable intent even when the client omitted it', async () => {
    await submitVideoGenJob({ prompt: 'Legacy free text', musicVideo: { projectId: 'p', sceneId: 's' } }, {});
    const { params } = mocks.enqueueJob.mock.calls[0][0];
    expect(params.prompt).toContain('Legacy free text');
    expect(params.prompt).toContain('Reaction 1.000s–2.000s: Listener');
    expect(params.prompt).toContain('Word 0.500s–1.500s: Stay');
    expect(params.prompt).toContain('Musical onsets: 0.750s');
    expect(params.shotInstruction.actionContract).toEqual(contract);
  });

  it('shifts contract and words into a padded performance window exactly once', async () => {
    mocks.prepareVideoGenParams.mockResolvedValue({ backend: 'fal', cleanupStaged: vi.fn(), sourceImagePath: '/example/frame.png' });
    mocks.preparePerformanceShot.mockResolvedValue({ audioFilePath: '/example/audio.wav', modelId: 'lip-sync', resolution: '1080P',
      shotInstruction: { version: 1, shotMode: 'performance', songInterval: { startSec: 10, endSec: 14 }, edit: { inSec: 1.5, outSec: 5.5 } } });
    await submitVideoGenJob({ prompt: 'Legacy\nShot intent (clip-relative seconds):\nstale intent\nEnd shot intent.. Keep moving', backend: 'fal', musicVideo: { projectId: 'p', sceneId: 's' } }, {});
    const { params } = mocks.enqueueJob.mock.calls[0][0];
    expect(params.prompt).toContain('Action 1.500s–2.500s: Singer');
    expect(params.prompt).toContain('Word 2.000s–3.000s: Stay');
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
