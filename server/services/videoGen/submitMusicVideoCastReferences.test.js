import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  settings: null,
  enqueue: vi.fn(),
  localReferences: vi.fn(),
  hostedReferences: vi.fn(async () => []),
  renderPool: vi.fn((body) => body),
  copy: vi.fn(async () => {}),
  unlink: vi.fn(async () => {}),
}));

vi.mock('../../lib/maintenanceAdmission.js', () => ({ maintenance: { run: (_kind, _resource, fn) => fn() } }));
vi.mock('../settings.js', () => ({ getSettings: async () => m.settings }));
vi.mock('./local.js', () => ({
  listVideoModels: () => [{
    id: 'omni', name: 'Omni', runtime: 'fastvideo', supportedModes: ['image'],
    maxReferenceImages: 4, maxReferenceTotal: 3, maxReferenceAudios: 3,
  }, {
    id: 'ltx25_mlx_q8', name: 'LTX 2.5', runtime: 'ltx25',
    supportedModes: ['text', 'image'], defaultFrames: 121,
  }],
  defaultVideoModelId: (_capabilities, preferredId) => preferredId || 'omni',
  loadHistory: async () => [],
  BYOV_VIDEO_RUNTIMES: new Set(['fastvideo', 'ltx25']),
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
vi.mock('../musicVideo/renderPool.js', () => ({ applyProjectRenderPool: async (body) => m.renderPool(body) }));
vi.mock('../musicVideo/clipCastReferences.js', () => ({
  musicVideoLocalReferencePaths: m.localReferences,
  musicVideoHostedClipReferences: m.hostedReferences,
  musicVideoClipReferences: m.hostedReferences,
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
    videoGen: { defaultModelId: 'omni', fal: { apiKey: 'test-key' } } };
  m.localReferences.mockImplementation(async (_tag, limit, { excludePath } = {}) => ['/mock/images/still.png', '/mock/images/lead.png', '/mock/images/guest.png']
    .filter((path) => path !== excludePath).slice(0, limit));
  m.hostedReferences.mockResolvedValue([]);
  m.renderPool.mockImplementation((body) => body);
  m.enqueue.mockResolvedValue({ jobId: 'job', status: 'queued', position: 1 });
});

describe('Music Video cast references at video submission', () => {
  it('queues an LTX 2.5 shot with its opening frame and selected cast sheet', async () => {
    m.hostedReferences.mockResolvedValue([{ path: '/mock/image-refs/lead.png', label: 'Lead' }]);
    await submitVideoGenJob(body({ backend: 'local', modelId: 'ltx25_mlx_q8',
      mode: 'ic-ingredients-25', numFrames: 121, icReferenceImageFiles: ['lead.png'],
      musicVideo: { ...tag, expectedClipReferenceFiles: ['lead.png'] } }), {});
    expect(m.enqueue.mock.calls[0][0].params).toMatchObject({
      mode: 'ic-ingredients-25', sourceImagePath: '/mock/images/still.png',
      icReferencePaths: ['/mock/image-refs/lead.png'], numFrames: 121,
    });
  });

  it('rejects an LTX shot when its selected references changed before queueing', async () => {
    m.hostedReferences.mockResolvedValue([{ path: '/mock/image-refs/new.png', label: 'Lead' }]);
    await expect(submitVideoGenJob(body({ backend: 'local', modelId: 'ltx25_mlx_q8',
      mode: 'ic-ingredients-25', numFrames: 121, icReferenceImageFiles: ['old.png'] }), {}))
      .rejects.toMatchObject({ code: 'MUSIC_VIDEO_CLIP_REFERENCES_CHANGED' });
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it('queues the default local model with cast sheets within its combined limit', async () => {
    await expect(submitVideoGenJob(body({ backend: 'local' }), {})).resolves.toMatchObject({ mode: 'local', model: 'omni' });
    expect(m.localReferences).toHaveBeenCalledWith(tag, 2, { excludePath: '/mock/images/still.png' });
    expect(m.enqueue.mock.calls[0][0].params.referenceImagePaths).toEqual(['/mock/images/lead.png', '/mock/images/guest.png']);
  });

  it('also augments a request that resolves to local without an explicit backend', async () => {
    await expect(submitVideoGenJob(body(), {})).resolves.toMatchObject({ mode: 'local', model: 'omni' });
    expect(m.enqueue.mock.calls[0][0].params.referenceImagePaths).toEqual(['/mock/images/lead.png', '/mock/images/guest.png']);
  });

  it('excludes the staged upload path without discarding a different gallery file', async () => {
    const sourceImage = { path: '/tmp/source.png', originalname: 'source.png' };
    await submitVideoGenJob(body({ backend: 'local' }), { sourceImage });
    const params = m.enqueue.mock.calls[0][0].params;
    expect(params.sourceImagePath).toMatch(/^\/mock\/uploads\/video-source-/);
    expect(m.localReferences).toHaveBeenCalledWith(tag, 2, { excludePath: params.sourceImagePath });
    expect(params.referenceImagePaths).toEqual(['/mock/images/still.png', '/mock/images/lead.png']);
  });

  it('does not replace caller-supplied reference images', async () => {
    await submitVideoGenJob(body({ backend: 'local', referenceImageFiles: ['chosen.png'] }), {});
    expect(m.localReferences).not.toHaveBeenCalled();
    expect(m.enqueue.mock.calls[0][0].params.referenceImagePaths).toEqual(['/mock/images/chosen.png']);
  });

  it('passes an internally resolved cast guide outside the gallery to the local job', async () => {
    m.localReferences.mockResolvedValue(['/mock/image-refs/guide.png']);
    await submitVideoGenJob(body({ backend: 'local' }), {});
    expect(m.enqueue.mock.calls[0][0].params.referenceImagePaths).toEqual(['/mock/image-refs/guide.png']);
  });

  it('keeps an inherited Grok route even when the local default accepts cast sheets', async () => {
    m.settings.videoGen.mode = 'grok';
    await expect(submitVideoGenJob(body(), {})).resolves.toMatchObject({ mode: 'grok' });
    expect(m.localReferences).not.toHaveBeenCalled();
    expect(m.hostedReferences).toHaveBeenCalledWith(tag, 7, { excludePath: '/mock/images/still.png' });
    expect(m.enqueue.mock.calls[0][0].params.mode).toBe('grok');
  });

  // Uniquely catches the hosted-reference guard refusing a Gemini shot whose greybox plate the render pool adds.
  it('queues a Gemini shot with its greybox plate leading the clip references', async () => {
    m.settings.videoGen.gemini = { enabled: true };
    m.renderPool.mockImplementation((request) => ({ ...request, referenceImageFiles: ['layout.png'] }));
    const refs = [{ path: '/mock/images/layout.png', label: 'Rink · Wide', role: 'set', greybox: true }, { path: '/mock/images/lead.png', label: 'Lead' }];
    m.hostedReferences.mockResolvedValue(refs);
    await expect(submitVideoGenJob(body({ backend: 'gemini' }), {})).resolves.toMatchObject({ mode: 'gemini' });
    expect(m.enqueue.mock.calls[0][0].params).toMatchObject({ mode: 'gemini', castReferences: refs, sourceImagePath: '/mock/images/still.png' });
  });

  it('appends caller-uploaded reference images after the Music Video sheets on a Grok render', async () => {
    m.hostedReferences.mockResolvedValue([{ path: '/mock/images/lead.png', label: 'Lead' }]);
    const referenceImage1 = { path: '/tmp/one.png', originalname: 'one.png' };
    const referenceImage2 = { path: '/tmp/two.png', originalname: 'two.png' };
    await submitVideoGenJob(body({ backend: 'grok', referenceLabel1: 'first', referenceLabel2: 'second' }), { referenceImage2, referenceImage1 });
    const { castReferences, uploadedTempPaths } = m.enqueue.mock.calls[0][0].params;
    expect(castReferences).toEqual([
      { path: '/mock/images/lead.png', label: 'Lead' },
      { path: expect.stringMatching(/^\/mock\/uploads\/video-reference-/), label: 'first' },
      { path: expect.stringMatching(/^\/mock\/uploads\/video-reference-/), label: 'second' },
    ]);
    expect(uploadedTempPaths).toEqual(castReferences.slice(1).map((ref) => ref.path));
    expect(m.copy.mock.calls.map(([from]) => from)).toEqual(['/tmp/one.png', '/tmp/two.png']);
  });

  it('refuses a combined Grok reference set beyond the supported limit before queuing', async () => {
    m.hostedReferences.mockResolvedValue(Array.from({ length: 7 }, (_, i) => ({ path: `/mock/images/${i}.png`, label: `Person ${i}` })));
    const referenceImage1 = { path: '/tmp/one.png', originalname: 'one.png' };
    await expect(submitVideoGenJob(body({ backend: 'grok' }), { referenceImage1 }))
      .rejects.toMatchObject({ code: 'VIDEO_REFERENCE_IMAGES_TOO_MANY' });
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it('queues a fal reference model with its pinned frame and the selected reference images', async () => {
    m.hostedReferences.mockResolvedValue([{ path: '/mock/images/rider.png', label: 'Rider' }, { path: '/mock/images/bike.png', label: 'Bike', role: 'prop' }]);
    await submitVideoGenJob(body({ backend: 'fal', falModelId: 'minimax/h3-max/reference-to-video', falDuration: 5 }), {});
    expect(m.hostedReferences).toHaveBeenCalledWith(tag, 9, { excludePath: '/mock/images/still.png' });
    expect(m.enqueue.mock.calls[0][0].params).toMatchObject({
      sourceImagePath: '/mock/images/still.png',
      referenceImagePaths: ['/mock/images/rider.png', '/mock/images/bike.png'],
      clipReferenceLabels: [{ label: 'Rider' }, { label: 'Bike', role: 'prop' }],
    });
  });

  it('queues a Runway Seedance clip with its frame and the selected reference images', async () => {
    m.settings.videoGen.runway = { apiKey: 'test-key' };
    m.hostedReferences.mockResolvedValue([{ path: '/mock/images/rider.png', label: 'Rider' }]);
    await submitVideoGenJob(body({ backend: 'runway', runwayModelId: 'seedance2_5', runwayDuration: 5 }), {});
    expect(m.hostedReferences).toHaveBeenCalledWith(tag, 16, { excludePath: '/mock/images/still.png' });
    expect(m.enqueue.mock.calls[0][0].params).toMatchObject({
      sourceImagePath: '/mock/images/still.png',
      referenceImagePaths: ['/mock/images/rider.png'],
      clipReferenceLabels: [{ label: 'Rider' }],
    });
  });

  it('leaves room for an end frame on a Runway model that keeps its frames', async () => {
    m.settings.videoGen.runway = { apiKey: 'test-key' };
    await submitVideoGenJob(body({ backend: 'runway', runwayModelId: 'klingO3_pro', runwayDuration: 5, lastImageFile: 'end.png' }), {});
    expect(m.hostedReferences).toHaveBeenCalledWith(tag, 5, { excludePath: '/mock/images/still.png' });
  });

  describe('Runway Video Gen form picks', () => {
    const form = (extra) => ({ prompt: 'A dancer turns', mode: 'image', sourceImageFile: 'still.png', width: 704, height: 448,
      backend: 'runway', runwayDuration: 5, referenceImageFiles: ['one.png'], ...extra });
    beforeEach(() => { m.settings.videoGen.runway = { apiKey: 'test-key' }; });

    it('queues gallery picks with the start frame', async () => {
      await submitVideoGenJob(form({ runwayModelId: 'seedance2_5' }), {});
      expect(m.enqueue.mock.calls[0][0].params).toMatchObject({
        referenceImagePaths: ['/mock/images/one.png'], clipReferenceLabels: [{ label: 'what it shows' }],
      });
    });

    it.each([
      ['a model that takes none', { runwayModelId: 'gen4.5' }, /takes no reference images/],
      ['an end frame where the model cannot mix them', { runwayModelId: 'seedance2_5', lastImageFile: 'end.png' }, /cannot combine an end frame/],
      ['more images than the model takes', { runwayModelId: 'klingO3_pro', lastImageFile: 'end.png', referenceImageFiles: Array(6).fill('one.png') }, /at most 7 images/],
    ])('refuses %s before queueing', async (_name, extra, message) => {
      await expect(submitVideoGenJob(form(extra), {})).rejects.toThrow(message);
      expect(m.enqueue).not.toHaveBeenCalled();
    });
  });

  it('sends no references on a Runway model that takes none', async () => {
    m.settings.videoGen.runway = { apiKey: 'test-key' };
    await submitVideoGenJob(body({ backend: 'runway', runwayModelId: 'gen4.5', runwayDuration: 5 }), {});
    expect(m.hostedReferences).not.toHaveBeenCalled();
    expect(m.enqueue.mock.calls[0][0].params).not.toHaveProperty('referenceImagePaths');
  });

  it('does not claim extra references for a fal model that cannot accept them', async () => {
    await submitVideoGenJob(body({ backend: 'fal', falModelId: 'fal-ai/minimax/hailuo-02/standard/image-to-video', falDuration: 6 }), {});
    expect(m.hostedReferences).not.toHaveBeenCalled();
    expect(m.enqueue.mock.calls[0][0].params).not.toHaveProperty('referenceImagePaths');
  });

  it('keeps a chained local shot renderable without adding incompatible references', async () => {
    await submitVideoGenJob(body({ backend: 'local', chunks: 2 }), {});
    expect(m.localReferences).not.toHaveBeenCalled();
    expect(m.enqueue.mock.calls[0][0].params).toMatchObject({ chunks: 2 });
    expect(m.enqueue.mock.calls[0][0].params).not.toHaveProperty('referenceImagePaths');
  });

  it('does not inject local reference paths when a peer-capable pool disabled them', async () => {
    await submitVideoGenJob(body({ backend: 'local', musicVideo: { ...tag, clipReferencesDisabled: true } }), {});
    expect(m.localReferences).not.toHaveBeenCalled();
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
