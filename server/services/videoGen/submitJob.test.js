import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildFederatedMediaRequest: vi.fn(),
  cleanupMultipartTemp: vi.fn(async () => {}),
  collectRemoteInputAssets: vi.fn(() => []),
  compileFableLoomVisualRequest: vi.fn(),
  enqueueJob: vi.fn(),
  fableLoomVideoCapabilities: vi.fn(),
  getLoom: vi.fn(async () => null),
  prepareRemoteMediaJob: vi.fn(),
  prepareVideoGenParams: vi.fn(),
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
});
