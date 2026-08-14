import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve as resolvePath } from 'path';

// These assertions describe the COMPOSITION of a staged path, not its
// separator. prepareParams builds them with path.join/resolve, which emit '\'
// on Windows, so compare against a separator-normalized copy.
const posix = (p) => String(p).split('\\').join('/');

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
  BYOV_VIDEO_RUNTIMES: new Set(['ltx2', 'wan22', 'minimax_h3', 'hunyuan']),
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
import { resolveGalleryImage } from '../../lib/fileUtils.js';
import { getProject as getMusicVideoProject } from '../musicVideo/projects.js';
import { getTrack } from '../tracks/index.js';
import { getSettings } from '../settings.js';
import { listVideoModels, defaultVideoModelId, loadHistory } from './local.js';
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

const H3_TERMS = 'minimax-h3-community-license-2026-08-02';
const H3_MODEL = {
  id: 'minimax_h3_8bit',
  name: 'MiniMax H3 MLX 8-bit',
  runtime: 'minimax_h3',
  supportedModes: ['text', 'image', 'fflf'],
  defaultFrames: 124,
  frameOptions: [107, 124, 141, 158],
  fpsOptions: [24],
  termsGate: { id: H3_TERMS },
};

// Paths unlinked under PATHS.uploads — i.e. the durable copies the service
// staged, as opposed to the OS temp files the multipart parser wrote.
// Normalize BEFORE filtering: the staged paths are built with path.join, so on
// Windows they are '\mock\uploads\…' and a startsWith('/mock/uploads/') filter
// matches nothing — which silently emptied this list and made every assertion
// below compare against [] instead of the paths it meant to check.
const unlinkedDurablePaths = () => unlink.mock.calls
  .map(([p]) => posix(p))
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
    listVideoModels.mockReturnValue([{ id: 'ltx2_unified', name: 'LTX-2 Unified', runtime: 'ltx2' }]);
    loadHistory.mockResolvedValue([]);
  });

  describe('happy paths', () => {
    it('returns local params with the resolved model, chunks and staged upload path', async () => {
      const prepared = await prepare({ mode: 'image', chunks: 2 }, { sourceImage: upload('sourceImage') });
      expect(prepared.backend).toBe('local');
      expect(prepared.effectiveModelId).toBe('ltx2_unified');
      expect(prepared.effectiveChunks).toBe(2);
      expect(posix(prepared.sourceImagePath)).toMatch(/^\/mock\/uploads\/video-source-.*\.png$/);
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
      // resolve() stamps a drive letter on Windows, so build the expectation the
      // same way rather than hardcoding a POSIX absolute path.
      expect(ic.icReferencePaths).toEqual([resolvePath('/mock/videos/prior.mp4')]);
    });
  });

  describe('per-chunk prompt beats (#3695)', () => {
    it('normalizes beats and keeps a blank entry in position as a fallback marker', async () => {
      const prepared = await prepare({ mode: 'image', chunks: 3, chunkPrompts: ['  opens the door  ', '', 'the storm breaks'] });
      expect(prepared.effectiveChunkPrompts).toEqual(['opens the door', null, 'the storm breaks']);
    });

    it('truncates a stale overlong list to the resolved chunk count', async () => {
      // The user typed four beats, then lowered Chunks to 2 — the extra beats
      // must not ride along and desync the list from the chain.
      const prepared = await prepare({ mode: 'image', chunks: 2, chunkPrompts: ['a', 'b', 'c', 'd'] });
      expect(prepared.effectiveChunkPrompts).toEqual(['a', 'b']);
    });

    it('leaves a short list short — uncovered chunks fall back to the main prompt', async () => {
      const prepared = await prepare({ mode: 'image', chunks: 3, chunkPrompts: ['a'] });
      expect(prepared.effectiveChunkPrompts).toEqual(['a']);
    });

    it('drops the list entirely for a single-chunk render', async () => {
      const prepared = await prepare({ mode: 'image', chunks: 1, chunkPrompts: ['a', 'b'] });
      expect(prepared.effectiveChunkPrompts).toBeUndefined();
    });

    it('drops the list for a mode pinned to one chunk', async () => {
      // An IC remix anchors a single clip, so chunks is pinned to 1 — a beat
      // list sent anyway must not persist into job params.
      loadHistory.mockResolvedValue([{ id: '11111111-1111-4111-8111-111111111111', filename: 'prior.mp4' }]);
      const prepared = await prepare({
        mode: 'ic-control',
        icReferenceVideoIds: ['11111111-1111-4111-8111-111111111111'],
        chunkPrompts: ['a', 'b'],
      });
      expect(prepared.effectiveChunks).toBe(1);
      expect(prepared.effectiveChunkPrompts).toBeUndefined();
    });

    it('collapses an all-blank list to undefined', async () => {
      // "every beat cleared" and "no beats sent" must persist identically —
      // otherwise a resume replays an array of nulls into the form.
      const prepared = await prepare({ mode: 'image', chunks: 3, chunkPrompts: ['', '  ', ''] });
      expect(prepared.effectiveChunkPrompts).toBeUndefined();
    });

    it('is undefined when no beats were supplied', async () => {
      const prepared = await prepare({ mode: 'image', chunks: 2 });
      expect(prepared.effectiveChunkPrompts).toBeUndefined();
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

    // Rejected here rather than in the worker: the request that named the bad
    // conditioner is the only place that can report it, and a persisted job
    // would otherwise sit in the queue only to die on dispatch.
    it('rejects a text encoder the selected model cannot load, before staging', async () => {
      await expect(prepare(
        { textEncoderId: 'heretic-bf16' },
        { sourceImage: upload('sourceImage') },
      )).rejects.toMatchObject({ status: 400, code: 'VIDEO_TEXT_ENCODER_UNSUPPORTED' });
      expect(unlink).toHaveBeenCalledWith('/tmp/multipart-sourceImage-frame.png');
      expect(unlinkedDurablePaths()).toEqual([]);
    });

    // 'stock' and absence are the same request, so neither may reject — the
    // route drops the sentinel from persisted params, which means a resumed
    // render sends absence where the original sent 'stock'.
    it.each([undefined, 'stock'])('accepts %j on a model with no substitutions', async (textEncoderId) => {
      await expect(prepare({ textEncoderId })).resolves.toMatchObject({ effectiveModelId: 'ltx2_unified' });
    });

    it('rejects a history id that is not in the render history', async () => {
      await expect(prepare({ extendFromVideoId: '22222222-2222-4222-8222-222222222222' }))
        .rejects.toMatchObject({ status: 404, code: 'EXTEND_SOURCE_NOT_FOUND' });
    });

    it('rejects an unsupported Wan mode before staging its upload', async () => {
      listVideoModels.mockReturnValue([{
        id: 'wan_t2v', name: 'Wan T2V', runtime: 'wan22',
        supportedModes: ['text'], frameStride: 4,
      }]);

      await expect(prepare(
        { modelId: 'wan_t2v', mode: 'image' },
        { sourceImage: upload('sourceImage') },
      )).rejects.toMatchObject({ status: 400, code: 'WAN22_MODE_UNSUPPORTED' });

      expect(unlinkedDurablePaths()).toEqual([]);
      expect(unlink).toHaveBeenCalledWith('/tmp/multipart-sourceImage-frame.png');
    });

    it('rejects a non-4n+1 Wan frame count before enqueue', async () => {
      listVideoModels.mockReturnValue([{
        id: 'wan_ti2v', name: 'Wan TI2V', runtime: 'wan22',
        supportedModes: ['text', 'image'], frameStride: 4,
      }]);

      await expect(prepare({ modelId: 'wan_ti2v', mode: 'text', numFrames: 120 }))
        .rejects.toMatchObject({ status: 400, code: 'WAN22_INVALID_FRAME_COUNT' });
    });

    it('rejects Wan image mode without a declared source before staging', async () => {
      listVideoModels.mockReturnValue([{
        id: 'wan_ti2v', name: 'Wan TI2V', runtime: 'wan22',
        supportedModes: ['text', 'image'], frameStride: 4,
      }]);

      await expect(prepare({ modelId: 'wan_ti2v', mode: 'image', numFrames: 121 }))
        .rejects.toMatchObject({ status: 400, code: 'WAN22_I2V_REQUIRES_IMAGE' });
      expect(unlinkedDurablePaths()).toEqual([]);
    });

    it('rejects Wan image mode when its gallery source no longer resolves', async () => {
      listVideoModels.mockReturnValue([{
        id: 'wan_ti2v', name: 'Wan TI2V', runtime: 'wan22',
        supportedModes: ['text', 'image'], frameStride: 4,
      }]);
      vi.mocked(resolveGalleryImage).mockReturnValueOnce(null);

      await expect(prepare({
        modelId: 'wan_ti2v', mode: 'image', numFrames: 121, sourceImageFile: 'missing.png',
      })).rejects.toMatchObject({ status: 400, code: 'WAN22_I2V_REQUIRES_IMAGE' });
    });

    it('rejects an explicit Wan text render that also supplies a source', async () => {
      listVideoModels.mockReturnValue([{
        id: 'wan_ti2v', name: 'Wan TI2V', runtime: 'wan22',
        supportedModes: ['text', 'image'], frameStride: 4,
      }]);

      await expect(prepare(
        { modelId: 'wan_ti2v', mode: 'text', numFrames: 121 },
        { sourceImage: upload('sourceImage') },
      )).rejects.toMatchObject({ status: 400, code: 'WAN22_TEXT_MODE_SOURCE_CONFLICT' });
      expect(unlink).toHaveBeenCalledWith('/tmp/multipart-sourceImage-frame.png');
    });

    it('rejects chunks on a T2V-only Wan model before staging', async () => {
      listVideoModels.mockReturnValue([{
        id: 'wan_t2v', name: 'Wan T2V', runtime: 'wan22',
        supportedModes: ['text'], frameStride: 4,
      }]);

      await expect(prepare({ modelId: 'wan_t2v', mode: 'text', numFrames: 121, chunks: 2 }))
        .rejects.toMatchObject({ status: 400, code: 'WAN22_CHAIN_REQUIRES_IMAGE_MODE' });
      expect(unlinkedDurablePaths()).toEqual([]);
    });
  });
});

describe('prepareVideoGenParams — MiniMax H3 contract', () => {
  // H3 is license-gated, and the only authorization is the acknowledgement
  // recorded in settings — so every test below that is about H3's *mode*
  // contract runs on an install that has already accepted its terms.
  const settingsWith = (acceptedModelTerms) => ({
    imageGen: {
      local: { pythonPath: '/usr/bin/python3' },
      grok: { enabled: true, grokPath: '/usr/bin/grok', aspectRatio: '16:9' },
    },
    videoGen: { acceptedModelTerms },
  });
  beforeEach(() => {
    vi.clearAllMocks();
    listVideoModels.mockReturnValue([H3_MODEL]);
    loadHistory.mockResolvedValue([]);
    getSettings.mockResolvedValue(settingsWith([H3_TERMS]));
  });

  // A render kicked off from a surface with no terms UI of its own (the music
  // video board, a pipeline stage) is authorized by the acknowledgement the
  // user recorded once — anywhere — rather than 403ing with nowhere to go.
  it('requires the install to have recorded this exact reviewed license', async () => {
    getSettings.mockResolvedValueOnce(settingsWith(undefined));
    await expect(prepare({ modelId: H3_MODEL.id, mode: 'text' }))
      .rejects.toMatchObject({ status: 403, code: 'VIDEO_MODEL_TERMS_ACCEPTANCE_REQUIRED' });

    // A superseded license revision does not carry forward to this one.
    getSettings.mockResolvedValueOnce(settingsWith(['some-older-license']));
    await expect(prepare({ modelId: H3_MODEL.id, mode: 'text' }))
      .rejects.toMatchObject({ status: 403, code: 'VIDEO_MODEL_TERMS_ACCEPTANCE_REQUIRED' });

    const prepared = await prepare({ modelId: H3_MODEL.id, mode: 'text' });
    expect(prepared.effectiveModelId).toBe(H3_MODEL.id);
    expect(prepared.effectiveChunks).toBe(1);
  });

  it('does not apply the local MiniMax gate to an explicit Grok render', async () => {
    defaultVideoModelId.mockReturnValueOnce(H3_MODEL.id);
    const prepared = await prepare({ backend: 'grok' });
    expect(prepared.backend).toBe('grok');
    expect(prepared.grok).toMatchObject({ grokPath: '/usr/bin/grok' });
  });

  it.each([
    [{ mode: 'extend' }, 'MINIMAX_H3_MODE_UNSUPPORTED'],
    [{ extendFromVideoId: '00000000-0000-4000-8000-000000000001' }, 'MINIMAX_H3_MODE_UNSUPPORTED'],
    [{ mode: 'image' }, 'MINIMAX_H3_I2V_REQUIRES_IMAGE'],
    [{ mode: 'text', sourceImageFile: 'first.png' }, 'MINIMAX_H3_TEXT_MODE_SOURCE_CONFLICT'],
    [{ mode: 'image', sourceImageFile: 'first.png', lastImageFile: 'last.png' }, 'MINIMAX_H3_I2V_LAST_IMAGE_CONFLICT'],
    [{ mode: 'fflf' }, 'MINIMAX_H3_FFLF_REQUIRES_IMAGE'],
    [{ negativePrompt: 'blur' }, 'MINIMAX_H3_NEGATIVE_PROMPT_UNSUPPORTED'],
    [{ disableAudio: true }, 'MINIMAX_H3_AUDIO_REQUIRED'],
    [{ tiling: 'full' }, 'MINIMAX_H3_TILING_UNSUPPORTED'],
    [{ numFrames: 125 }, 'MINIMAX_H3_INVALID_FRAME_COUNT'],
    [{ fps: 30 }, 'MINIMAX_H3_INVALID_FPS'],
  ])('rejects an unsupported H3 request (%o)', async (fields, code) => {
    await expect(prepare({
      modelId: H3_MODEL.id,

      ...fields,
    })).rejects.toMatchObject({ status: 400, code });
  });

  it('rejects chunks > 1 only while the entry lacks image-to-video', async () => {
    listVideoModels.mockReturnValue([{ ...H3_MODEL, supportedModes: ['text'] }]);
    await expect(prepare({
      modelId: H3_MODEL.id, mode: 'text', chunks: 2,
    })).rejects.toMatchObject({ status: 400, code: 'VIDEO_CHAIN_REQUIRES_IMAGE_MODE' });

    listVideoModels.mockReturnValue([H3_MODEL]);
    const prepared = await prepare({
      modelId: H3_MODEL.id, mode: 'text', chunks: 2,
    });
    expect(prepared.effectiveChunks).toBe(2);
  });

  it.each([
    ['image', { mode: 'image', sourceImageFile: 'first.png' }],
    ['fflf', { mode: 'fflf', sourceImageFile: 'first.png', lastImageFile: 'last.png' }],
  ])('accepts %s keyframe conditioning', async (_label, fields) => {
    const prepared = await prepare({
      modelId: H3_MODEL.id,

      ...fields,
    });
    expect(prepared.effectiveModelId).toBe(H3_MODEL.id);
    expect(prepared.sourceImagePath).toBe('/mock/images/first.png');
  });

  it('accepts another supported temporal shape at fixed 24 fps', async () => {
    const prepared = await prepare({
      modelId: H3_MODEL.id,
      mode: 'text',

      numFrames: 158,
      fps: 24,
    });
    expect(prepared.effectiveModelId).toBe(H3_MODEL.id);
  });
});
