import { beforeEach, describe, expect, it, vi } from 'vitest';
import { submitVideoGenJob } from './submitJob.js';
import { captureMusicVideoEvidence, musicVideoDependencyChanges } from '../../lib/musicVideoDependencies.js';

const peerId = '00000000-0000-4000-8000-000000000123';
const m = vi.hoisted(() => ({ project: null, enqueue: vi.fn(), slice: vi.fn(), discard: vi.fn(), revision: vi.fn(), currentAudio: vi.fn() }));
vi.mock('../../lib/maintenanceAdmission.js', () => ({ maintenance: { run: (_kind, _resource, fn) => fn() } }));
vi.mock('../musicVideo/projects.js', () => ({ getProject: async () => m.project }));
vi.mock('../instances.js', () => ({ getPeers: async () => [{ id: '00000000-0000-4000-8000-000000000123' }] }));
vi.mock('../mediaJobQueue/index.js', () => ({ listJobs: () => [], enqueueJob: (...args) => m.enqueue(...args) }));
vi.mock('../federatedMediaConsumer.js', () => ({ resolveFederatedMediaProvider: async () => ({
  capability: { hardwareEligible: true, memory: { requiredGb: 1, totalGb: 64, freeGb: 48 },
    inputAssets: { roles: ['sourceImage'] }, supportedModes: ['image', 'a2v'], sourceAudio: { requiresImage: true } },
  status: { features: ['sourceAudio'], queue: { totalActive: 0, maintenanceHeld: false } },
}) }));
vi.mock('../federatedMedia/remoteSubmission.js', async (load) => ({ ...await load(),
  prepareRemoteMediaJob: async ({ peerId, request, inputAssets }) => ({ request,
    capability: { fpsOptions: [24], frameStride: 8, maxNumFrames: 121 },
    remoteMedia: { wireVersion: 1, peerId, request, inputAssets },
  }),
}));
vi.mock('../federatedMedia/sourceAudio.js', async (load) => ({ ...await load(),
  prepareSourceAudioWindow: (...args) => m.slice(...args), discardSourceAudioWindow: (...args) => m.discard(...args),
  assertCurrentSourceAudioWindow: (...args) => m.currentAudio(...args),
}));
vi.mock('../musicVideo/performanceShot.js', () => ({ preparePerformanceShot: async () => null }));
vi.mock('../musicVideo/revisionService.js', () => ({ assertRevisionOpen: (...args) => m.revision(...args) }));

const audio = { audioFilePath: '/example/uploads/mv-source-audio-00000000-0000-4000-8000-000000000456.wav',
  songInterval: { startSec: 2, endSec: 3 },
  audioConditioning: { sourceSha256: 'a'.repeat(64), clipSha256: 'b'.repeat(64), sampleRate: 48000,
    channels: 2, startSample: 96000, endSample: 144000, sampleCount: 48000 } };
const body = () => ({ prompt: 'A lighthouse in fog', backend: 'local', mode: 'a2v', sourceImageFile: 'example-frame.png',
  fps: 24, numFrames: 25, musicVideo: { projectId: 'project', sceneId: 'scene', revisionId: 'revision' } });
beforeEach(() => {
  vi.clearAllMocks();
  m.project = { id: 'project', videoSettings: { generationMode: 'suppliedAudio',
    renderPool: { mode: 'peers', peers: [{ peerId, modelId: 'ltx-example' }] } },
  scenes: [{ sceneId: 'scene', referenceImageId: 'example-frame.png', prompt: 'A lighthouse in fog', startSec: 2, endSec: 3, shotMode: 'cutaway' }] };
  m.slice.mockResolvedValue({ ...structuredClone(audio), audioDependencies: captureMusicVideoEvidence(m.project, { sceneIds: [], composition: false }) });
  m.enqueue.mockResolvedValue({ jobId: 'job', status: 'queued', position: 1 });
  m.revision.mockResolvedValue(undefined);
  m.currentAudio.mockResolvedValue(undefined);
});

describe('Music Video supplied-audio submission integration', () => {
  it('keeps the selected target, exact provenance, scene binding and revision guard in the normal queue path', async () => {
    await expect(submitVideoGenJob(body(), {})).resolves.toMatchObject({ mediaProviderPeerId: peerId, status: 'queued' });
    expect(m.slice).toHaveBeenCalledWith(expect.objectContaining({ fps: 24, numFrames: 25 }));
    expect(m.revision).toHaveBeenCalledWith('project', 'revision', { sceneId: 'scene', kind: 'video' });
    const { params } = m.enqueue.mock.calls[0][0];
    expect(params).toMatchObject({ musicVideo: body().musicVideo, audioConditioning: audio.audioConditioning,
      shotInstruction: { songInterval: audio.songInterval },
      remoteMedia: { peerId, request: { modelId: 'ltx-example', fps: 24, numFrames: 25, audioConditioning: audio.audioConditioning } },
      uploadedTempPaths: [audio.audioFilePath] });
    expect(params.musicVideoDependencies.references).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'song' })]));
    expect(musicVideoDependencyChanges({ ...m.project, trackId: 'changed-song' }, params.musicVideoDependencies)).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'song' })]));
    expect(params.remoteMedia.inputAssets).toContainEqual({ role: 'sourceAudio', path: audio.audioFilePath });
    expect(m.discard).not.toHaveBeenCalled();
  });
  it('releases the owned slice when a revision closes before the queue write', async () => {
    m.revision.mockRejectedValueOnce(Object.assign(new Error('Revision closed'), { code: 'REVISION_CLOSED' }));
    await expect(submitVideoGenJob(body(), {})).rejects.toMatchObject({ code: 'REVISION_CLOSED' });
    expect(m.enqueue).not.toHaveBeenCalled();
    expect(m.discard).toHaveBeenCalledWith(audio.audioFilePath);
  });
  it('refuses changed scene timing after audio preparation without dispatching', async () => {
    m.slice.mockImplementationOnce(async () => { m.project.scenes[0].startSec = 2.5; return structuredClone(audio); });
    await expect(submitVideoGenJob(body(), {})).rejects.toMatchObject({ code: 'MUSIC_VIDEO_SHOT_TIMING_CHANGED' });
    expect(m.enqueue).not.toHaveBeenCalled();
    expect(m.discard).toHaveBeenCalledWith(audio.audioFilePath);
  });
  it('refuses a source song changed during audio preparation and releases the owned window', async () => {
    const audioDependencies = captureMusicVideoEvidence(m.project, { sceneIds: [], composition: false });
    m.slice.mockImplementationOnce(async () => { m.project.trackId = 'changed-song'; return { ...structuredClone(audio), audioDependencies }; });
    await expect(submitVideoGenJob(body(), {})).rejects.toMatchObject({ code: 'MUSIC_VIDEO_AUDIO_SOURCE_CHANGED' });
    expect(m.enqueue).not.toHaveBeenCalled();
    expect(m.discard).toHaveBeenCalledWith(audio.audioFilePath);
  });
});
