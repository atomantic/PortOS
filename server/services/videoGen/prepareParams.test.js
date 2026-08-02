import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../settings.js', () => ({
  getSettings: vi.fn(async () => ({
    imageGen: { local: { pythonPath: '/usr/bin/python3' }, grok: { enabled: true, grokPath: '/usr/bin/grok', aspectRatio: '16:9' } },
  })),
}));

vi.mock('../musicVideo/projects.js', () => ({ getProject: vi.fn() }));
vi.mock('../tracks/index.js', () => ({ getTrack: vi.fn() }));

vi.mock('./local.js', () => ({
  listVideoModels: vi.fn(() => [{ id: 'ltx2_unified', name: 'LTX-2 Unified', runtime: 'ltx2' }]),
  defaultVideoModelId: vi.fn(() => 'ltx2_unified'),
  loadHistory: vi.fn(async () => []),
  BYOV_VIDEO_RUNTIMES: new Set(['ltx2', 'wan22', 'hunyuan']),
  DEFAULT_NUM_FRAMES: 121,
}));

vi.mock('../../lib/fileUtils.js', () => ({
  PATHS: {
    root: '/mock',
    data: '/mock/data',
    images: '/mock/images',
    videos: '/mock/videos',
    uploads: '/mock/uploads',
    music: '/mock/music',
  },
  ensureDir: vi.fn(async () => {}),
  resolveGalleryImage: vi.fn((name) => {
    if (typeof name !== 'string' || !name) return null;
    const safe = name.split(/[/\\]/).pop();
    if (!safe || safe === '.' || safe === '..') return null;
    return `/mock/images/${safe}`;
  }),
}));

vi.mock('fs', () => ({ existsSync: vi.fn(() => true) }));
vi.mock('fs/promises', () => ({
  unlink: vi.fn(async () => {}),
  copyFile: vi.fn(async () => {}),
}));

import { unlink } from 'fs/promises';
import { getProject as getMusicVideoProject } from '../musicVideo/projects.js';
import { getTrack } from '../tracks/index.js';
import { loadHistory } from './local.js';
import { prepareVideoGenParams, withStagedRollback, cleanupMultipartTemp } from './prepareParams.js';

// Field names the route owns Zod schemas for; the service only needs the keys
// to decide grok eligibility. Mirrors LOCAL_ONLY_VIDEO_PARAMS in the route.
const LOCAL_ONLY_KEYS = ['numFrames', 'fps', 'steps', 'guidanceScale', 'seed', 'imageStrength', 'tiling'];

const upload = (fieldname, name = 'frame.png') => ({
  fieldname,
  originalname: name,
  path: `/tmp/multipart-${fieldname}-${name}`,
});

const prepare = (body, uploads = {}) => prepareVideoGenParams({
  body: { prompt: 'a clip', width: 704, height: 448, ...body },
  uploads,
  localOnlyParamKeys: LOCAL_ONLY_KEYS,
});

// Paths unlinked under PATHS.uploads — i.e. the durable copies the service
// staged, as opposed to the OS temp files the multipart parser wrote.
const unlinkedDurablePaths = () => unlink.mock.calls
  .map(([p]) => p)
  .filter((p) => typeof p === 'string' && p.startsWith('/mock/uploads/'));

describe('withStagedRollback', () => {
  it('returns the value and skips cleanup when nothing throws', async () => {
    const cleanup = vi.fn(async () => {});
    await expect(withStagedRollback(cleanup, async () => 'ok')).resolves.toBe('ok');
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('cleans up and rethrows the original error on a rejected await', async () => {
    const cleanup = vi.fn(async () => {});
    const boom = new Error('db down');
    await expect(withStagedRollback(cleanup, async () => { throw boom; })).rejects.toBe(boom);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('cleans up and rethrows when the callback throws synchronously', async () => {
    // enqueueJob is synchronous — a sync throw must unwind exactly like a
    // rejection, otherwise the route's guard is decorative.
    const cleanup = vi.fn(async () => {});
    const boom = new Error('queue full');
    await expect(withStagedRollback(cleanup, () => { throw boom; })).rejects.toBe(boom);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe('cleanupMultipartTemp', () => {
  it('unlinks every multipart temp path and tolerates an empty/absent map', async () => {
    await cleanupMultipartTemp({ sourceImage: upload('sourceImage'), lastImage: upload('lastImage', 'end.png') });
    expect(unlink).toHaveBeenCalledWith('/tmp/multipart-sourceImage-frame.png');
    expect(unlink).toHaveBeenCalledWith('/tmp/multipart-lastImage-end.png');
    await expect(cleanupMultipartTemp(undefined)).resolves.toBeUndefined();
  });
});

describe('prepareVideoGenParams', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadHistory.mockResolvedValue([]);
  });

  describe('happy paths', () => {
    it('returns local params with the resolved model, chunks and staged upload path', async () => {
      const prepared = await prepare({ mode: 'image', chunks: 2 }, { sourceImage: upload('sourceImage') });
      expect(prepared.backend).toBe('local');
      expect(prepared.effectiveModelId).toBe('ltx2_unified');
      expect(prepared.effectiveChunks).toBe(2);
      expect(prepared.sourceImagePath).toMatch(/^\/mock\/uploads\/video-source-.*\.png$/);
      // The start-frame upload rides the legacy single field so already-persisted
      // jobs from before the array field still clean up correctly.
      expect(prepared.uploadedTempPath).toBe(prepared.sourceImagePath);
      expect(prepared.uploadedTempPaths).toEqual([]);
      expect(unlinkedDurablePaths()).toEqual([]);
    });

    it('short-circuits for grok without staging local-only inputs', async () => {
      const prepared = await prepare({ backend: 'grok', sourceImageFile: 'still.png' });
      expect(prepared.backend).toBe('grok');
      expect(prepared.grok.grokPath).toBe('/usr/bin/grok');
      expect(prepared.sourceImagePath).toBe('/mock/images/still.png');
      // The local-only fields are absent entirely — the route must not read them.
      expect(prepared.effectiveChunks).toBeUndefined();
      expect(prepared.loras).toBeUndefined();
    });

    it('normalizes the parallel lora arrays and defaults a missing scale', async () => {
      const prepared = await prepare({ loraFilenames: ['a.safetensors', 'b.safetensors'], loraScales: [0.4] });
      expect(prepared.loras).toEqual([
        { filename: 'a.safetensors', scale: 0.4 },
        { filename: 'b.safetensors', scale: 1.0 },
      ]);
    });

    it('defaults mode to fflf and pins chunks to 1 for an IC remix', async () => {
      const keyframed = await prepare({ keyframes: [{ file: 'a.png', index: 0 }, { file: 'b.png', index: 40 }] });
      expect(keyframed.mode).toBe('fflf');
      expect(keyframed.resolvedKeyframes).toEqual([
        { path: '/mock/images/a.png', index: 0 },
        { path: '/mock/images/b.png', index: 40 },
      ]);

      loadHistory.mockResolvedValue([{ id: '11111111-1111-4111-8111-111111111111', filename: 'prior.mp4' }]);
      const ic = await prepare({ mode: 'ic-control', icReferenceVideoIds: ['11111111-1111-4111-8111-111111111111'] });
      expect(ic.effectiveChunks).toBe(1);
      expect(ic.icReferencePaths).toEqual(['/mock/videos/prior.mp4']);
    });
  });

  describe('rejected-await rollback (#3326)', () => {
    // Each case stages a durable copy, then makes the NEXT await reject. Without
    // the withStagedRollback guard the rejection bubbles past every explicit
    // cleanupAllStaged() call and the durable copy is orphaned forever.
    const musicVideo = { projectId: 'proj-1', sceneId: 'scene-1' };

    it('unwinds the staged source frame when the music-video project lookup rejects', async () => {
      const boom = new Error('project store unavailable');
      getMusicVideoProject.mockRejectedValue(boom);

      await expect(prepare({ mode: 'a2v', musicVideo }, { sourceImage: upload('sourceImage') }))
        .rejects.toBe(boom);

      expect(unlinkedDurablePaths()).toEqual([expect.stringMatching(/^\/mock\/uploads\/video-source-.*\.png$/)]);
    });

    it('unwinds the staged source frame when the track lookup rejects', async () => {
      const boom = new Error('track store unavailable');
      getMusicVideoProject.mockResolvedValue({ scenes: [{ sceneId: 'scene-1' }], trackId: 'track-1' });
      getTrack.mockRejectedValue(boom);

      await expect(prepare({ mode: 'a2v', musicVideo }, { sourceImage: upload('sourceImage') }))
        .rejects.toBe(boom);

      expect(unlinkedDurablePaths()).toEqual([expect.stringMatching(/^\/mock\/uploads\/video-source-.*\.png$/)]);
    });

    it('unwinds the staged source frame when the history read rejects', async () => {
      const boom = new Error('history file corrupt');
      loadHistory.mockRejectedValue(boom);

      await expect(prepare(
        { extendFromVideoId: '22222222-2222-4222-8222-222222222222' },
        { sourceImage: upload('sourceImage') },
      )).rejects.toBe(boom);

      expect(unlinkedDurablePaths()).toEqual([expect.stringMatching(/^\/mock\/uploads\/video-source-.*\.png$/)]);
    });

    it('unwinds EVERY staged copy, not just the last one', async () => {
      const boom = new Error('history file corrupt');
      loadHistory.mockRejectedValue(boom);

      await expect(prepare(
        { extendFromVideoId: '33333333-3333-4333-8333-333333333333' },
        { sourceImage: upload('sourceImage'), lastImage: upload('lastImage', 'end.png') },
      )).rejects.toBe(boom);

      const durable = unlinkedDurablePaths();
      expect(durable).toHaveLength(2);
      expect(durable).toEqual(expect.arrayContaining([
        expect.stringMatching(/^\/mock\/uploads\/video-source-.*\.png$/),
        expect.stringMatching(/^\/mock\/uploads\/video-last-.*\.png$/),
      ]));
    });

  });

  describe('explicit validation throws still clean up', () => {
    it('rejects an unknown modelId and drops the multipart temp file', async () => {
      await expect(prepare({ modelId: 'nope' }, { sourceImage: upload('sourceImage') }))
        .rejects.toMatchObject({ status: 400, code: 'VIDEO_GEN_UNKNOWN_MODEL' });
      expect(unlink).toHaveBeenCalledWith('/tmp/multipart-sourceImage-frame.png');
      // Rejected BEFORE staging, so nothing durable was written.
      expect(unlinkedDurablePaths()).toEqual([]);
    });

    it('rejects a music-video render whose reference frame will not resolve', async () => {
      await expect(prepare({ musicVideo: { projectId: 'p', sceneId: 's' }, sourceImageFile: '..' }))
        .rejects.toMatchObject({ status: 400, code: 'MUSIC_VIDEO_SOURCE_REQUIRED' });
    });

    it('rejects a history id that is not in the render history', async () => {
      await expect(prepare({ extendFromVideoId: '22222222-2222-4222-8222-222222222222' }))
        .rejects.toMatchObject({ status: 404, code: 'EXTEND_SOURCE_NOT_FOUND' });
    });
  });
});
