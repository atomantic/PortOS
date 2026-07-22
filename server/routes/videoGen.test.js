import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn(async () => ({ imageGen: { local: { pythonPath: '/usr/bin/python3' } } })),
}));

vi.mock('../lib/pythonSetup.js', () => ({
  checkPackages: vi.fn(async () => ({ installed: ['mflux', 'mlx'], missing: [], missingPip: [] })),
  isAllowedPython: vi.fn(() => true),
}));

vi.mock('../services/videoGen/local.js', () => ({
  // The route checks `runtime` on the default model when validating a2v —
  // include it so the a2v happy-path tests don't trip the A2V_REQUIRES_LTX2
  // guard. Tests that need to exercise the legacy runtime override the mock
  // per-test via mockReturnValueOnce.
  listVideoModels: vi.fn(() => [{ id: 'ltx2_unified', name: 'LTX-2 Unified', runtime: 'ltx2' }]),
  defaultVideoModelId: vi.fn(() => 'ltx2_unified'),
  loadHistory: vi.fn(async () => []),
  deleteHistoryItem: vi.fn(async (id) => ({ ok: true, id })),
  // The route imports setHistoryItemHidden too — without this entry, ESM
  // module linking fails when the route is loaded inside the test process.
  setHistoryItemHidden: vi.fn(async (id, hidden) => ({ ok: true, id, hidden })),
  extractLastFrame: vi.fn(),
  stitchVideos: vi.fn(),
  upscaleHistoryItem: vi.fn(),
  // Mirrors the real export — keeps the route's keyframe-range check in
  // sync with whatever the service actually defaults to.
  DEFAULT_NUM_FRAMES: 121,
  // /status advertises the FFLF pixel-frame budget so the client can mirror
  // the keyframe-index clamp. Mock returns the real default so the status
  // shape test sees a concrete number.
  resolveFflfLtx2PixelBudget: vi.fn(() => 704 * 448 * 25),
  // The route gates pythonPath enforcement on this allowlist (ltx2/wan22/
  // hunyuan bring their own venv). Mirror the real export so the
  // "accepts BYOV-runtime when pythonPath missing" case passes and the
  // negative case (legacy mlx_video model) still 400s.
  BYOV_VIDEO_RUNTIMES: new Set(['ltx2', 'wan22', 'hunyuan']),
  // The route's /status response now surfaces the BYOV runtime list so the
  // client can drop its hardcoded copy. Mirror the real shape — only the
  // `id` and a couple of UI-display fields are read by /status.
  BYOV_RUNTIME_INFO: {
    ltx2: { id: 'ltx2', label: 'LTX-2 MLX', venvPython: '/tmp/ltx2.py', installEnvVar: 'INSTALL_LTX2', repoUrl: 'x', repoDir: '/tmp' },
    wan22: { id: 'wan22', label: 'Wan 2.2 MLX', venvPython: '/tmp/wan22.py', installEnvVar: 'INSTALL_WAN22', repoUrl: 'x', repoDir: '/tmp' },
    hunyuan: { id: 'hunyuan', label: 'HunyuanVideo MLX', venvPython: '/tmp/hunyuan.py', installEnvVar: 'INSTALL_HUNYUAN', repoUrl: 'x', repoDir: '/tmp' },
  },
  isByovRuntimeInstalled: vi.fn(() => false),
  isByovRuntimeReady: vi.fn(async () => false),
  invalidateByovReadyCache: vi.fn(),
  invalidateRuntimeFingerprintCache: vi.fn(),
  // /status now surfaces a runtime block (host chip/os + per-runtime versions).
  // Mock returns a fixed shape so the status test can assert it's wired through.
  resolveRuntimeFingerprint: vi.fn(async () => ({
    host: { chip: 'Apple M5 Max', os: 'Darwin 25.5.0', platform: 'darwin', arch: 'arm64', node: 'v22' },
    runtimes: { ltx2: { runtime: 'ltx2', versions: { mlx: '0.22.0' }, chip: 'Apple M5 Max' } },
  })),
}));

// Render submissions go through the mediaJobQueue. Mock its surface so the
// route tests stay synchronous and don't kick off the worker loop.
vi.mock('../services/mediaJobQueue/index.js', () => ({
  enqueueJob: vi.fn(({ kind, params }) => ({ jobId: `mock-${kind}-job`, position: 1, status: 'queued' })),
  attachSseClient: vi.fn(() => false),
  cancelJob: vi.fn(async () => ({ ok: true, status: 'canceling' })),
  listJobs: vi.fn(() => []),
}));

// Pending file metadata for tests that need to simulate an upload. Tests set
// this via `setPendingUpload({ fieldname, ... })` before issuing the request;
// the mocked uploadFields middleware reads it off the holder, attaches it as
// req.files keyed by fieldname, and clears it. Mutable wrapper avoids
// reaching into vi mock internals.
const pendingUpload = { current: null };
const setPendingUpload = (file) => { pendingUpload.current = file; };

vi.mock('../lib/multipart.js', () => ({
  // Bypass the streaming parser. If a test set a pending upload via
  // setPendingUpload(), inject it under req.files keyed by fieldname so the
  // route exercises the upload-staging path; otherwise pass through.
  uploadFields: () => (req, _res, next) => {
    if (pendingUpload.current) {
      const f = pendingUpload.current;
      req.files = { [f.fieldname]: f };
      pendingUpload.current = null;
    }
    next();
  },
}));

vi.mock('../lib/fileUtils.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  PATHS: { root: '/mock', data: '/mock/data', images: '/mock/images', videos: '/mock/videos', uploads: '/mock/uploads' },
  // Route awaits ensureDir before staging the upload; no-op for tests since
  // we mock copyFile too.
  ensureDir: vi.fn(async () => {}),
  // The route resolves user-supplied basenames through this helper before
  // handing them to the renderer. Mirror the real helper's basename-strip
  // + dot-segment rejection so the "strips path-traversal" test below
  // genuinely exercises the documented behavior (otherwise the mock would
  // happily forward `../../etc/passwd` through unchanged).
  resolveGalleryImage: vi.fn((name) => {
    if (typeof name !== 'string' || !name) return null;
    const safe = name.split(/[/\\]/).pop();
    if (!safe || safe === '.' || safe === '..') return null;
    return `/mock/images/${safe}`;
  }),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
}));
vi.mock('fs/promises', () => ({
  unlink: vi.fn(async () => {}),
  // The route stages multipart uploads to data/uploads/ via copyFile. Stub
  // the copy so tests that simulate req.file don't actually touch disk.
  copyFile: vi.fn(async () => {}),
}));

import * as videoGenService from '../services/videoGen/local.js';
import * as mediaJobQueue from '../services/mediaJobQueue/index.js';
import { resolveGalleryImage } from '../lib/fileUtils.js';
import videoGenRoutes, { isAudioMime } from './videoGen.js';

// isAudioMime is the gating function inside the fileFilter callback. The
// multipart mock in these route tests bypasses fileFilter entirely, so we
// unit-test the helper directly to cover all the MIME / extension cases.
describe('isAudioMime', () => {
  it('accepts standard audio/* types', () => {
    expect(isAudioMime('audio/wav', 'clip.wav')).toBe(true);
    expect(isAudioMime('audio/mpeg', 'song.mp3')).toBe(true);
    expect(isAudioMime('audio/ogg', 'clip.ogg')).toBe(true);
    expect(isAudioMime('audio/flac', 'clip.flac')).toBe(true);
  });

  it('accepts audio/mp4 (Chrome/Firefox label for M4A)', () => {
    expect(isAudioMime('audio/mp4', 'song.m4a')).toBe(true);
  });

  it('accepts audio/x-m4a', () => {
    expect(isAudioMime('audio/x-m4a', 'song.m4a')).toBe(true);
  });

  it('accepts audio/aac', () => {
    expect(isAudioMime('audio/aac', 'clip.aac')).toBe(true);
  });

  it('accepts video/mp4 + .m4a extension (Safari label for M4A)', () => {
    expect(isAudioMime('video/mp4', 'song.m4a')).toBe(true);
  });

  it('accepts video/mp4 + .aac extension', () => {
    expect(isAudioMime('video/mp4', 'clip.aac')).toBe(true);
  });

  it('rejects video/mp4 when extension is .mp4 (genuine video)', () => {
    expect(isAudioMime('video/mp4', 'movie.mp4')).toBe(false);
  });

  it('rejects video/mp4 with no filename (no extension to confirm)', () => {
    expect(isAudioMime('video/mp4', '')).toBe(false);
    expect(isAudioMime('video/mp4', undefined)).toBe(false);
  });

  it('rejects image/* and video/* (non-audio) types', () => {
    expect(isAudioMime('image/jpeg', 'photo.jpg')).toBe(false);
    expect(isAudioMime('video/webm', 'clip.webm')).toBe(false);
  });

  it('rejects null/undefined mime', () => {
    expect(isAudioMime(null, 'clip.wav')).toBe(false);
    expect(isAudioMime(undefined, 'clip.wav')).toBe(false);
  });
});

describe('videoGen routes', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/video-gen', videoGenRoutes);
    app.use(errorMiddleware);
    vi.clearAllMocks();
    // Reset the upload holder so a test that set a pending upload but
    // bailed before the route consumed it can't leak into the next test.
    pendingUpload.current = null;
  });

  describe('GET /status', () => {
    it('reports connected when pythonPath is set AND required packages all import', async () => {
      const r = await request(app).get('/api/video-gen/status');
      expect(r.status).toBe(200);
      expect(r.body.connected).toBe(true);
      expect(r.body.pythonPath).toBe('/usr/bin/python3');
      expect(r.body.missingPackages).toEqual([]);
      expect(r.body.defaultModel).toBe('ltx2_unified');
      // systemMemoryGb drives the client's a2v auto-select (largest model
      // that fits in `systemMemoryGb - 16 GB` headroom). Pin the field's
      // presence + type so a future accidental removal is caught here.
      expect(typeof r.body.systemMemoryGb).toBe('number');
      expect(r.body.systemMemoryGb).toBeGreaterThan(0);
      // fflfLtx2PixelBudget lets the client mirror the FFLF keyframe-index
      // clamp without hardcoding the constant. Pin presence + type.
      expect(typeof r.body.fflfLtx2PixelBudget).toBe('number');
      expect(r.body.fflfLtx2PixelBudget).toBeGreaterThan(0);
      // runtime fingerprint block — host chip/os + per-runtime resolved
      // versions so the UI (and bug reports) can show the exact stack (#1325).
      expect(r.body.runtime?.host?.chip).toBe('Apple M5 Max');
      expect(r.body.runtime?.runtimes?.ltx2?.versions?.mlx).toBe('0.22.0');
    });

    it('reports disconnected with reason + missingPackages when packages fail to import', async () => {
      const { checkPackages } = await import('../lib/pythonSetup.js');
      checkPackages.mockResolvedValueOnce({
        installed: ['numpy', 'tqdm'],
        missing: ['mflux', 'mlx', 'mlx_video'],
        missingPip: ['mflux', 'mlx', 'mlx_video'],
      });
      const r = await request(app).get('/api/video-gen/status');
      expect(r.status).toBe(200);
      expect(r.body.connected).toBe(false);
      expect(r.body.pythonPath).toBe('/usr/bin/python3');
      expect(r.body.missingPackages).toEqual(['mflux', 'mlx', 'mlx_video']);
      expect(r.body.reason).toMatch(/3 python packages missing/);
    });
  });

  describe('GET /models', () => {
    it('returns the static catalog', async () => {
      const r = await request(app).get('/api/video-gen/models');
      expect(r.status).toBe(200);
      expect(r.body).toEqual([{ id: 'ltx2_unified', name: 'LTX-2 Unified', runtime: 'ltx2' }]);
    });
  });

  describe('POST / — grok backend (#2859 phase 2)', () => {
    it('enqueues a grok video job with the saved grok config and no local-python dependency', async () => {
      const { getSettings } = await import('../services/settings.js');
      // No local pythonPath at all — grok must not trip VIDEO_GEN_NOT_CONFIGURED.
      getSettings.mockResolvedValueOnce({ imageGen: { grok: { enabled: true, grokPath: '/opt/grok', aspectRatio: '16:9' } } });
      const r = await request(app).post('/api/video-gen/').send({
        backend: 'grok',
        prompt: 'a fox running through snow',
        grokDuration: '10',
        width: 1920,
        height: 1080,
      });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('queued');
      expect(r.body.mode).toBe('grok');
      expect(r.body.model).toBe('grok');
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({
          mode: 'grok',
          videoMode: 'text',
          grokPath: '/opt/grok',
          aspectRatio: '16:9',
          prompt: 'a fox running through snow',
          duration: 10,
          width: 1920,
          height: 1080,
        }),
      }));
    });

    it('rejects when the grok toggle is disabled', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce({ imageGen: { grok: { enabled: false } } });
      const r = await request(app).post('/api/video-gen/').send({ backend: 'grok', prompt: 'a fox' });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/disabled/i);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    it('rejects an unsupported grokDuration', async () => {
      const r = await request(app).post('/api/video-gen/').send({ backend: 'grok', prompt: 'a fox', grokDuration: 7 });
      expect(r.status).toBe(400);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    it('does not touch the grok path for default local renders', async () => {
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a cat' });
      expect(r.status).toBe(200);
      const [call] = mediaJobQueue.enqueueJob.mock.calls;
      expect(call[0].params.mode).not.toBe('grok');
    });
  });

  describe('POST /', () => {
    it('rejects missing prompt', async () => {
      const r = await request(app).post('/api/video-gen/').send({ width: 512 });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/prompt/i);
    });

    it('rejects out-of-range width', async () => {
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a cat', width: 99999 });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/width/i);
    });

    it('rejects bad tiling enum value', async () => {
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a cat', tiling: 'wrong' });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/tiling/i);
    });

    it('accepts empty-string numerics as undefined (multipart preprocess fix)', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a cat',
        width: '',
        height: '',
        seed: '',
      });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('queued');
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({
          prompt: 'a cat',
          width: undefined,
          height: undefined,
          seed: undefined,
        }),
      }));
    });

    it('translates the universal loraFilenames/loraScales contract into internal { filename, scale } params', async () => {
      // This is the contract a history requeue (getRenderConfigForItem) emits,
      // so it must round-trip without a bespoke shape.
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'styled clip',
        loraFilenames: ['a.safetensors', 'b.safetensors'],
        loraScales: [0.7, 1.0],
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({
          loras: [
            { filename: 'a.safetensors', scale: 0.7 },
            { filename: 'b.safetensors', scale: 1.0 },
          ],
        }),
      }));
    });

    it('defaults a missing scale to 1.0 when fewer loraScales than loraFilenames', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'clip',
        loraFilenames: ['a.safetensors'],
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        params: expect.objectContaining({ loras: [{ filename: 'a.safetensors', scale: 1.0 }] }),
      }));
    });

    it('rejects LoRAs on a non-ltx2 runtime with LORAS_REQUIRE_LTX2', async () => {
      videoGenService.listVideoModels.mockReturnValueOnce([
        { id: 'ltx_legacy', name: 'LTX legacy', runtime: 'mlx_video' },
      ]);
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'clip',
        modelId: 'ltx_legacy',
        loraFilenames: ['a.safetensors'],
      });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('LORAS_REQUIRE_LTX2');
    });

    it('strips path-traversal segments from sourceImageFile via basename + prefix-check', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a cat',
        sourceImageFile: '../../etc/passwd',
      });
      // Documented-safe behavior: `basename()` strips dirs so the resolved
      // path is `/mock/images/passwd` (under PATHS.images). The route does
      // NOT 400 — it just consumes whatever's safely under the images root.
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({
          prompt: 'a cat',
          sourceImagePath: '/mock/images/passwd',
        }),
      }));
    });

    it('forwards a musicVideo i2v tag into job.params alongside the resolved frame (#1760 Phase 1)', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'slow dolly across the skyline',
        mode: 'image',
        sourceImageFile: 'scene-frame.png',
        musicVideo: JSON.stringify({ projectId: 'mv-1', sceneId: 'mvs-1' }),
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({
          sourceImagePath: '/mock/images/scene-frame.png',
          musicVideo: { projectId: 'mv-1', sceneId: 'mvs-1' },
        }),
      }));
    });

    it('rejects a musicVideo i2v render when the reference frame cannot be resolved (no silent t2v)', async () => {
      // A stale/deleted gallery file resolves to null (mustExist defaults true).
      resolveGalleryImage.mockReturnValueOnce(null);
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'slow dolly across the skyline',
        mode: 'image',
        sourceImageFile: 'gone.png',
        musicVideo: JSON.stringify({ projectId: 'mv-1', sceneId: 'mvs-1' }),
      });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('MUSIC_VIDEO_SOURCE_REQUIRED');
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    it('forwards lastImageFile + mode for FFLF', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'morph between two scenes',
        sourceImageFile: 'first.png',
        lastImageFile: 'last.png',
        mode: 'fflf',
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({
          prompt: 'morph between two scenes',
          sourceImagePath: '/mock/images/first.png',
          lastImagePath: '/mock/images/last.png',
          mode: 'fflf',
        }),
      }));
    });

    it('forwards multi-keyframe array (resolved to gallery paths) under params.keyframes', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'four-pose shot',
        mode: 'fflf',
        numFrames: 121,
        keyframes: [
          { file: 'pose-a.png', index: 0 },
          { file: 'pose-b.png', index: 40 },
          { file: 'pose-c.png', index: 80 },
          { file: 'pose-d.png', index: 120 },
        ],
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({
          mode: 'fflf',
          keyframes: [
            { path: '/mock/images/pose-a.png', index: 0 },
            { path: '/mock/images/pose-b.png', index: 40 },
            { path: '/mock/images/pose-c.png', index: 80 },
            { path: '/mock/images/pose-d.png', index: 120 },
          ],
        }),
      }));
    });

    it('parses keyframes when sent as a JSON-encoded string (multipart bodies)', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'multipart-style submission',
        mode: 'fflf',
        numFrames: 49,
        keyframes: JSON.stringify([
          { file: 'a.png', index: 0 },
          { file: 'b.png', index: 48 },
        ]),
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        params: expect.objectContaining({
          keyframes: [
            { path: '/mock/images/a.png', index: 0 },
            { path: '/mock/images/b.png', index: 48 },
          ],
        }),
      }));
    });

    it("defaults mode to 'fflf' when keyframes is set without an explicit mode", async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'mode-default coercion',
        numFrames: 49,
        keyframes: [
          { file: 'a.png', index: 0 },
          { file: 'b.png', index: 48 },
        ],
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        params: expect.objectContaining({ mode: 'fflf' }),
      }));
    });

    it('rejects keyframes when paired with mode != fflf', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'wrong mode',
        mode: 'image',
        keyframes: [
          { file: 'a.png', index: 0 },
          { file: 'b.png', index: 24 },
        ],
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/keyframes is only valid with mode='fflf'/);
    });

    it('rejects keyframes when chunks > 1 (no defined chained semantic)', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'chained keyframes',
        mode: 'fflf',
        chunks: 3,
        keyframes: [
          { file: 'a.png', index: 0 },
          { file: 'b.png', index: 24 },
        ],
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/keyframes cannot be combined with chunks/);
    });

    it('rejects keyframes when an index is outside [0, numFrames-1]', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'out of range index',
        mode: 'fflf',
        numFrames: 25,
        keyframes: [
          { file: 'a.png', index: 0 },
          { file: 'b.png', index: 25 }, // == numFrames, must be < numFrames
        ],
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/>= numFrames/);
    });

    it('rejects keyframes paired with a non-ltx2 modelId (KEYFRAMES_REQUIRE_LTX2)', async () => {
      // Multi-keyframe FFLF is an LTX-2 primitive — the route must reject
      // up-front rather than enqueue and let the worker fail asynchronously.
      videoGenService.listVideoModels.mockReturnValueOnce([
        { id: 'ltx_legacy', name: 'LTX legacy', runtime: 'mlx_video' },
      ]);
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'multi-keyframe on the wrong runtime',
        modelId: 'ltx_legacy',
        keyframes: [
          { file: 'a.png', index: 0 },
          { file: 'b.png', index: 24 },
        ],
      });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('KEYFRAMES_REQUIRE_LTX2');
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    it('rejects keyframes paired with sourceImageFile (KEYFRAMES_LEGACY_INPUTS_CONFLICT)', async () => {
      // Mixing keyframes with the legacy 2-keyframe inputs has ambiguous
      // precedence — force callers to pick one shape per request so the
      // worker doesn't silently drop one.
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'ambiguous inputs',
        sourceImageFile: 'first.png',
        keyframes: [
          { file: 'a.png', index: 0 },
          { file: 'b.png', index: 24 },
        ],
      });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('KEYFRAMES_LEGACY_INPUTS_CONFLICT');
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    it('rejects keyframes paired with lastImageFile (KEYFRAMES_LEGACY_INPUTS_CONFLICT)', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'ambiguous inputs 2',
        lastImageFile: 'last.png',
        keyframes: [
          { file: 'a.png', index: 0 },
          { file: 'b.png', index: 24 },
        ],
      });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('KEYFRAMES_LEGACY_INPUTS_CONFLICT');
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    it('rejects keyframes with index > default numFrames when numFrames is omitted', async () => {
      // generateVideo() defaults numFrames to 121 — the route must reject
      // out-of-range indices up-front instead of letting them queue and
      // fail late inside the worker / Python helper.
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'no numframes specified',
        mode: 'fflf',
        keyframes: [
          { file: 'a.png', index: 0 },
          { file: 'b.png', index: 500 }, // way past default of 121
        ],
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/default numFrames 121/);
    });

    it('rejects keyframes with non-ascending indices', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'bad order',
        mode: 'fflf',
        numFrames: 121,
        keyframes: [
          { file: 'a.png', index: 50 },
          { file: 'b.png', index: 30 }, // < previous
        ],
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/strictly ascending/);
    });

    it('forwards chunks > 1 so the queue dispatches the chain orchestrator', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a long shot',
        chunks: 4,
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({ chunks: 4 }),
      }));
    });

    it('coerces chunks=1 (and missing) to 1 — the non-chained path', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a single render',
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({ chunks: 1 }),
      }));
    });

    it('forces audio-to-video submissions to a single chunk', async () => {
      setPendingUpload({
        fieldname: 'audioFile',
        originalname: 'song.wav',
        mimetype: 'audio/wav',
        path: '/tmp/song.wav',
      });
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'sync to the track',
        mode: 'a2v',
        chunks: 4,
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({ mode: 'a2v', chunks: 1 }),
      }));
    });

    it('rejects chunks above the 1..8 cap', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'too long',
        chunks: 99,
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/chunks/i);
    });

    it('forwards extendFromVideoId by resolving to a real disk path under data/videos/', async () => {
      const id = '11111111-1111-4111-8111-111111111111';
      const videoSvc = await import('../services/videoGen/local.js');
      videoSvc.loadHistory.mockResolvedValueOnce([{ id, filename: `${id}.mp4` }]);
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'continue the scene',
        mode: 'extend',
        extendFromVideoId: id,
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({
          mode: 'extend',
          // The route resolves the id to an absolute path under PATHS.videos
          // (mocked to /mock/images for these tests; videos root is taken
          // from PATHS.videos which is also /mock-rooted).
          extendFromVideoPath: expect.stringContaining(`${id}.mp4`),
        }),
      }));
    });

    it('returns 404 when extendFromVideoId is not in history', async () => {
      const id = '22222222-2222-4222-8222-222222222222';
      const videoSvc = await import('../services/videoGen/local.js');
      videoSvc.loadHistory.mockResolvedValueOnce([]); // empty history
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'continue',
        mode: 'extend',
        extendFromVideoId: id,
      });
      expect(r.status).toBe(404);
      expect(r.body.error).toMatch(/not found in history/i);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    it('rejects malformed extendFromVideoId at the schema layer', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'continue',
        mode: 'extend',
        extendFromVideoId: 'not-a-uuid',
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/extendFromVideoId/i);
    });

    it('rejects an unknown mode value', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a cat',
        mode: 'bogus',
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/mode/i);
    });

    // a2v mode requires an audio upload. Without one the route fails fast
    // with VIDEO_GEN_AUDIO_REQUIRED (400) instead of queueing a job that
    // would fail late on the python helper's audio_path check.
    it('rejects a2v without an audio upload (VIDEO_GEN_AUDIO_REQUIRED)', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'beat-synced dancer',
        mode: 'a2v',
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/audioFile/i);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    // Audio upload present + mode='a2v': route stages the audio under
    // data/uploads/ and forwards the staged audioFilePath into enqueue
    // params. The python helper picks it up via --audio.
    it('stages audioFile upload and forwards audioFilePath for a2v mode', async () => {
      setPendingUpload({
        fieldname: 'audioFile',
        path: '/tmp/upload-fake.wav',
        originalname: 'beats.wav',
        mimetype: 'audio/wav',
        size: 1234,
      });
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'beat-synced dancer',
        mode: 'a2v',
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({
          mode: 'a2v',
          // audio is staged into PATHS.uploads with the video-audio prefix
          audioFilePath: expect.stringMatching(/\/mock\/uploads\/video-audio-.*\.wav$/),
          // and threaded into uploadedTempPaths (array) for worker cleanup —
          // uploadedTempPath (singular) stays reserved for the start-frame
          // upload so legacy persisted jobs replay correctly.
          uploadedTempPaths: expect.arrayContaining([
            expect.stringMatching(/\/mock\/uploads\/video-audio-.*\.wav$/),
          ]),
        }),
      }));
    });

    // a2v on a non-ltx2 model would fail later inside the worker
    // (buildArgs throws A2V_REQUIRES_LTX2). The route catches it up front so
    // a typo / stale UI state doesn't pollute the persisted queue with a
    // doomed entry.
    it('rejects mode=a2v paired with a non-ltx2 modelId (A2V_REQUIRES_LTX2)', async () => {
      // Override the default ltx2-runtime model with a legacy mlx_video entry
      // for this single request.
      videoGenService.listVideoModels.mockReturnValueOnce([
        { id: 'ltx_legacy', name: 'LTX legacy', runtime: 'mlx_video' },
      ]);
      setPendingUpload({
        fieldname: 'audioFile',
        path: '/tmp/upload-fake.wav',
        originalname: 'beats.wav',
        mimetype: 'audio/wav',
        size: 1234,
      });
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'beat-synced dancer',
        mode: 'a2v',
        modelId: 'ltx_legacy',
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/ltx2-runtime/i);
      expect(r.body.code).toBe('A2V_REQUIRES_LTX2');
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    // Defense-in-depth: an audio upload paired with the wrong mode would
    // otherwise be silently dropped (queued as text-to-video). Reject so
    // the caller can't accidentally pay for the wrong generation path.
    it('rejects audioFile upload paired with a non-a2v mode (VIDEO_GEN_AUDIO_MODE_MISMATCH)', async () => {
      setPendingUpload({
        fieldname: 'audioFile',
        path: '/tmp/upload-fake.wav',
        originalname: 'beats.wav',
        mimetype: 'audio/wav',
        size: 1234,
      });
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a cat',
        mode: 'text',
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/a2v/i);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    // Pre-enqueue config validation: without pythonPath the queue would
    // accept the job, return 200/queued, then fail asynchronously over SSE
    // and pollute the persisted queue with a doomed entry. Skipped for
    // ltx2/wan22/hunyuan runtimes which bring their own venv (see the
    // BYOV_RUNTIMES allowlist mirrored in services/videoGen/local.js).
    it('rejects 400 VIDEO_GEN_NOT_CONFIGURED when pythonPath is missing and the model needs it', async () => {
      const settingsMock = await import('../services/settings.js');
      settingsMock.getSettings.mockResolvedValueOnce({ imageGen: { local: {} } });
      // Override the default `ltx2` mock with a legacy mlx_video runtime so
      // the pythonPath gate actually fires — ltx2/wan22/hunyuan are exempt.
      videoGenService.listVideoModels.mockReturnValueOnce([
        { id: 'legacy_mlx', name: 'legacy mlx_video', runtime: 'mlx_video' },
      ]);
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a cat', modelId: 'legacy_mlx' });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/not configured/i);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    // The matching positive case: an ltx2/wan22/hunyuan model bypasses the
    // pythonPath gate because buildArgs resolves its own venv.
    it('accepts a BYOV-runtime model (ltx2) when pythonPath is missing', async () => {
      const settingsMock = await import('../services/settings.js');
      settingsMock.getSettings.mockResolvedValueOnce({ imageGen: { local: {} } });
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a cat', modelId: 'ltx2_unified' });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledTimes(1);
    });
  });

  describe('GET /active', () => {
    const listJobsByFilter = (jobs) => ({ status, kind } = {}) => jobs.filter((j) => {
      if (status && j.status !== status) return false;
      if (kind && j.kind !== kind) return false;
      return true;
    });

    it('returns { activeJob: null } when no video jobs exist', async () => {
      mediaJobQueue.listJobs.mockReturnValue([]);
      const r = await request(app).get('/api/video-gen/active');
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ activeJob: null });
    });

    it('prefers the running job over queued jobs', async () => {
      mediaJobQueue.listJobs.mockImplementation(listJobsByFilter([
        { id: 'running-1', kind: 'video', status: 'running', position: 1, params: { prompt: 'P running' } },
        { id: 'queued-1',  kind: 'video', status: 'queued',  position: 2, params: { prompt: 'P queued' } },
      ]));
      const r = await request(app).get('/api/video-gen/active');
      expect(r.status).toBe(200);
      expect(r.body.activeJob.jobId).toBe('running-1');
      expect(r.body.activeJob.status).toBe('running');
      expect(r.body.activeJob.params.prompt).toBe('P running');
    });

    // Selection of the newest queued (not oldest) matches /cancel's fallback
    // selection — see the surrounding comment in routes/videoGen.js. Diverging
    // would mean Cancel from a resumed-queued page targets a different job.
    it('returns newest queued when nothing is running (matches /cancel order)', async () => {
      mediaJobQueue.listJobs.mockImplementation(listJobsByFilter([
        { id: 'queued-old', kind: 'video', status: 'queued', position: 1, params: { prompt: 'P old' } },
        { id: 'queued-new', kind: 'video', status: 'queued', position: 2, params: { prompt: 'P new' } },
      ]));
      const r = await request(app).get('/api/video-gen/active');
      expect(r.status).toBe(200);
      expect(r.body.activeJob.jobId).toBe('queued-new');
      expect(r.body.activeJob.status).toBe('queued');
    });

    // params is a whitelist — never leak server-internal absolute file paths
    // (sourceImagePath, audioFilePath, uploadedTempPath(s), extendFromVideoPath)
    // or the resolved pythonPath to the browser.
    it('whitelists params and never leaks server-internal file paths', async () => {
      mediaJobQueue.listJobs.mockImplementation(listJobsByFilter([
        { id: 'running-1', kind: 'video', status: 'running', position: 1, params: {
          prompt: 'safe prompt',
          modelId: 'ltx2_unified',
          width: 768, height: 512,
          numFrames: 121, fps: 24,
          steps: 25, guidanceScale: 3, seed: 42,
          tiling: 'auto', disableAudio: false, mode: 'text', chunks: 1,
          // sensitive fields that must NOT round-trip:
          pythonPath: '/Users/secret/venv/bin/python',
          sourceImagePath: '/Users/secret/data/uploads/source.png',
          audioFilePath: '/Users/secret/data/uploads/voice.wav',
          uploadedTempPath: '/tmp/upload-xyz',
          uploadedTempPaths: ['/tmp/last-abc'],
          extendFromVideoPath: '/Users/secret/data/videos/prev.mp4',
        } },
      ]));
      const r = await request(app).get('/api/video-gen/active');
      expect(r.status).toBe(200);
      const p = r.body.activeJob.params;
      expect(p.prompt).toBe('safe prompt');
      expect(p.modelId).toBe('ltx2_unified');
      expect(p.width).toBe(768);
      expect(p.pythonPath).toBeUndefined();
      expect(p.sourceImagePath).toBeUndefined();
      expect(p.audioFilePath).toBeUndefined();
      expect(p.uploadedTempPath).toBeUndefined();
      expect(p.uploadedTempPaths).toBeUndefined();
      expect(p.extendFromVideoPath).toBeUndefined();
    });

    // keyframes are stored as { path, index } (absolute gallery paths) but
    // must surface to the resuming client as { file, index } (basename only)
    // — same internal-path-leak rule as sourceImagePath, plus the client
    // picker's submit shape uses gallery filenames.
    it('maps stored keyframes { path, index } -> { file, index } without leaking the absolute path', async () => {
      mediaJobQueue.listJobs.mockImplementation(listJobsByFilter([
        { id: 'running-kf', kind: 'video', status: 'running', position: 1, params: {
          prompt: 'kf prompt', modelId: 'ltx2_unified', mode: 'fflf',
          keyframes: [
            { path: '/Users/secret/data/images/a.png', index: 0 },
            { path: '/Users/secret/data/images/b.png', index: 24 },
          ],
        } },
      ]));
      const r = await request(app).get('/api/video-gen/active');
      expect(r.status).toBe(200);
      const p = r.body.activeJob.params;
      expect(p.keyframes).toEqual([
        { file: 'a.png', index: 0 },
        { file: 'b.png', index: 24 },
      ]);
      // The absolute server path must never round-trip.
      expect(JSON.stringify(p.keyframes)).not.toMatch(/secret/);
    });

    // Defensive: malformed keyframe entries (missing path / non-integer index)
    // are dropped rather than surfaced as half-formed picker rows. When every
    // entry is malformed, keyframes is omitted entirely (no empty array).
    it('drops malformed keyframe entries and omits keyframes when none survive', async () => {
      mediaJobQueue.listJobs.mockImplementation(listJobsByFilter([
        { id: 'running-bad-kf', kind: 'video', status: 'running', position: 1, params: {
          prompt: 'p', modelId: 'ltx2_unified',
          keyframes: [{ index: 0 }, { path: '/x/y.png', index: 'nope' }, null],
        } },
      ]));
      const r = await request(app).get('/api/video-gen/active');
      expect(r.status).toBe(200);
      expect(r.body.activeJob.params.keyframes).toBeUndefined();
    });
  });

  describe('GET /:jobId/events', () => {
    it('returns 404 when the job is unknown', async () => {
      mediaJobQueue.attachSseClient.mockReturnValue(false);
      const r = await request(app).get('/api/video-gen/unknown-job/events');
      expect(r.status).toBe(404);
      expect(r.body.error).toMatch(/not found/i);
    });
  });

  describe('POST /cancel', () => {
    it('reports nothing to cancel when no video render is running', async () => {
      mediaJobQueue.listJobs.mockReturnValue([]);
      const r = await request(app).post('/api/video-gen/cancel').send({});
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(false);
    });

    it('cancels the running video render through the queue', async () => {
      mediaJobQueue.listJobs.mockReturnValue([{ id: 'running-job', kind: 'video', status: 'running' }]);
      mediaJobQueue.cancelJob.mockResolvedValue({ ok: true, status: 'canceling' });
      const r = await request(app).post('/api/video-gen/cancel').send({});
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(mediaJobQueue.cancelJob).toHaveBeenCalledWith('running-job');
    });

    // jobId in the body cancels a specific job, even if it's still queued.
    it('cancels a specific queued job when jobId is supplied', async () => {
      const jobs = [
        { id: 'running-1', kind: 'video', status: 'running' },
        { id: 'queued-2',  kind: 'video', status: 'queued' },
      ];
      // The route calls listJobs({ kind: 'video' }) — replicate the production
      // queue's filter semantics (status filter is optional).
      mediaJobQueue.listJobs.mockImplementation(({ status, kind } = {}) => jobs.filter((j) => {
        if (status && j.status !== status) return false;
        if (kind && j.kind !== kind) return false;
        return true;
      }));
      mediaJobQueue.cancelJob.mockResolvedValue({ ok: true, status: 'canceled' });
      const r = await request(app).post('/api/video-gen/cancel').send({ jobId: 'queued-2' });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(mediaJobQueue.cancelJob).toHaveBeenCalledWith('queued-2');
    });

    // No running job and no jobId — fall back to newest queued so the user
    // can pull back a recent submission before it starts.
    it('falls back to newest queued video when no jobId and nothing is running', async () => {
      const jobs = [
        { id: 'queued-old', kind: 'video', status: 'queued' },
        { id: 'queued-new', kind: 'video', status: 'queued' },
      ];
      mediaJobQueue.listJobs.mockImplementation(({ status, kind } = {}) => jobs.filter((j) => {
        if (status && j.status !== status) return false;
        if (kind && j.kind !== kind) return false;
        return true;
      }));
      mediaJobQueue.cancelJob.mockResolvedValue({ ok: true, status: 'canceled' });
      const r = await request(app).post('/api/video-gen/cancel').send({});
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(mediaJobQueue.cancelJob).toHaveBeenCalledWith('queued-new');
    });
  });

  describe('GET /history', () => {
    it('returns the full history list', async () => {
      videoGenService.loadHistory.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
      const r = await request(app).get('/api/video-gen/history');
      expect(r.status).toBe(200);
      expect(r.body).toHaveLength(2);
    });
  });

  describe('DELETE /history/:id', () => {
    it('proxies to deleteHistoryItem', async () => {
      videoGenService.deleteHistoryItem.mockResolvedValue({ ok: true, id: 'abc' });
      const r = await request(app).delete('/api/video-gen/history/abc');
      expect(r.status).toBe(200);
      expect(videoGenService.deleteHistoryItem).toHaveBeenCalledWith('abc');
    });
  });

  describe('POST /stitch', () => {
    const validId = (n) => `aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa${n}`;

    it('rejects when videoIds is not an array', async () => {
      const r = await request(app).post('/api/video-gen/stitch').send({ videoIds: 'not-array' });
      expect(r.status).toBe(400);
    });

    it('rejects when videoIds contains malformed history ids', async () => {
      const r = await request(app).post('/api/video-gen/stitch').send({ videoIds: ['../etc/passwd', 'b'] });
      expect(r.status).toBe(400);
    });

    it('rejects when videoIds has fewer than 2 entries', async () => {
      const r = await request(app).post('/api/video-gen/stitch').send({ videoIds: [validId(1)] });
      expect(r.status).toBe(400);
    });

    it('proxies array of ids to stitchVideos and wraps result', async () => {
      videoGenService.stitchVideos.mockResolvedValue({ id: 's1', filename: 's1.mp4' });
      const r = await request(app).post('/api/video-gen/stitch').send({ videoIds: [validId(1), validId(2)] });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.video.id).toBe('s1');
      expect(videoGenService.stitchVideos).toHaveBeenCalledWith([validId(1), validId(2)]);
    });
  });

  describe('POST /upscale/:id', () => {
    const validHistoryId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1';
    const otherValidId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbb2';

    it('rejects history ids that do not match the UUID shape', async () => {
      const r = await request(app).post('/api/video-gen/upscale/not-a-uuid').send({});
      expect(r.status).toBe(400);
      expect(videoGenService.upscaleHistoryItem).not.toHaveBeenCalled();
    });

    it('forwards id to upscaleHistoryItem and wraps the new entry', async () => {
      const upscaled = { id: otherValidId, filename: `${otherValidId}.mp4`, width: 1536, height: 1024, upscaledFrom: validHistoryId };
      videoGenService.upscaleHistoryItem.mockResolvedValue(upscaled);
      const r = await request(app).post(`/api/video-gen/upscale/${validHistoryId}`).send({});
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.video).toEqual(upscaled);
      expect(videoGenService.upscaleHistoryItem).toHaveBeenCalledWith(validHistoryId);
    });

    it('returns the ServerError status when the service rejects', async () => {
      videoGenService.upscaleHistoryItem.mockRejectedValue(
        Object.assign(new Error('Video not found'), { status: 404, code: 'NOT_FOUND' }),
      );
      const r = await request(app).post(`/api/video-gen/upscale/${validHistoryId}`).send({});
      expect(r.status).toBe(404);
      expect(r.body.error).toMatch(/not found/i);
    });
  });
});
