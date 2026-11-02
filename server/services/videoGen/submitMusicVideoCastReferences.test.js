import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  settings: null,
  enqueue: vi.fn(),
  localReferences: vi.fn(),
  hostedReferences: vi.fn(async () => []),
  copy: vi.fn(async () => {}),
  unlink: vi.fn(async () => {}),
}));

vi.mock('../../lib/maintenanceAdmission.js', () => ({ maintenance: { run: (_kind, _resource, fn) => fn() } }));
vi.mock('../settings.js', () => ({ getSettings: async () => m.settings }));
vi.mock('./local.js', () => ({
  listVideoModels: () => [{
    id: 'omni', name: 'Omni', runtime: 'fastvideo', supportedModes: ['image'],
    maxReferenceImages: 4, maxReferenceTotal: 3, maxReferenceAudios: 3,
  }],
  defaultVideoModelId: (_capabilities, preferredId) => preferredId || 'omni',
  loadHistory: async () => [],
  BYOV_VIDEO_RUNTIMES: new Set(['fastvideo']),
  DEFAULT_NUM_FRAMES: 121,
}));
vi.mock('../../lib/fileUtils.js', async (load) => ({
  ...await load(),
  PATHS: { root: '/mock', data: '/mock/data', images: '/mock/images', videos: '/mock/videos', uploads: '/mock/uploads' },
  resolveGalleryImage: (name) => name ? `/mock/images/${name}` : null,
  ensureDir: async () => {},
  copyFileGuarded: m.copy,
  unlinkGuarded: m.unlink,
  assertFileNotMediaManifest: async () => {},
}));
vi.mock('../musicVideo/renderPool.js', () => ({ applyProjectRenderPool: async (body) => body }));
vi.mock('../musicVideo/clipCastReferences.js', () => ({
  musicVideoLocalReferenceFiles: m.localReferences,
  musicVideoClipCastReferences: m.hostedReferences,
}));
vi.mock('../musicVideo/performanceShot.js', () => ({ preparePerformanceShot: async () => null }));
vi.mock('../musicVideo/submissionGuards.js', () => ({ applyMusicVideoSubmissionGuards: async () => [] }));
vi.mock('../mediaJobQueue/index.js', () => ({ enqueueJob: m.enqueue }));

import { submitVideoGenJob } from './submitJob.js';

const tag = { projectId: 'project', sceneId: 'shot' };
const body = (extra = {}) => ({ prompt: 'A dancer turns', mode: 'image', sourceImageFile: 'still.png',
  width: 704, height: 448, musicVideo: tag, ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  m.settings = { imageGen: { local: { pythonPath: '/example/python' }, grok: { enabled: true, grokPath: '/example/grok' } },
    videoGen: { defaultModelId: 'omni' } };
  m.localReferences.mockImplementation(async (_tag, limit) => ['lead.png', 'guest.png', 'third.png'].slice(0, limit));
  m.hostedReferences.mockResolvedValue([]);
  m.enqueue.mockResolvedValue({ jobId: 'job', status: 'queued', position: 1 });
});

describe('Music Video cast references at video submission', () => {
  it('queues the default local model with cast sheets within its combined limit', async () => {
    await expect(submitVideoGenJob(body({ backend: 'local' }), {})).resolves.toMatchObject({ mode: 'local', model: 'omni' });
    expect(m.localReferences).toHaveBeenCalledWith(tag, 2);
    expect(m.enqueue.mock.calls[0][0].params.referenceImagePaths).toEqual(['/mock/images/lead.png', '/mock/images/guest.png']);
  });

  it('also augments a request that resolves to local without an explicit backend', async () => {
    await expect(submitVideoGenJob(body(), {})).resolves.toMatchObject({ mode: 'local', model: 'omni' });
    expect(m.enqueue.mock.calls[0][0].params.referenceImagePaths).toEqual(['/mock/images/lead.png', '/mock/images/guest.png']);
  });

  it('keeps an inherited Grok route even when the local default accepts cast sheets', async () => {
    m.settings.videoGen.mode = 'grok';
    await expect(submitVideoGenJob(body(), {})).resolves.toMatchObject({ mode: 'grok' });
    expect(m.localReferences).not.toHaveBeenCalled();
    expect(m.hostedReferences).toHaveBeenCalledWith(tag);
    expect(m.enqueue.mock.calls[0][0].params.mode).toBe('grok');
  });

  it('keeps a chained local shot renderable without adding incompatible references', async () => {
    await submitVideoGenJob(body({ backend: 'local', chunks: 2 }), {});
    expect(m.localReferences).not.toHaveBeenCalled();
    expect(m.enqueue.mock.calls[0][0].params).toMatchObject({ chunks: 2 });
    expect(m.enqueue.mock.calls[0][0].params).not.toHaveProperty('referenceImagePaths');
  });

  it('preserves a caller-supplied voice reference without adding cast sheets', async () => {
    const voice = { path: '/tmp/voice.wav', originalname: 'voice.wav' };
    await submitVideoGenJob(body({ backend: 'local' }), { referenceAudio0: voice });
    expect(m.localReferences).not.toHaveBeenCalled();
    expect(m.enqueue.mock.calls[0][0].params.referenceAudioPaths).toHaveLength(1);
    expect(m.enqueue.mock.calls[0][0].params).not.toHaveProperty('referenceImagePaths');
  });
});
