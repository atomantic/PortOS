import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { join, resolve } from 'path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEFAULT_CONTEXT_FRAMES, MAX_CONTEXT_FRAMES } from '../lib/videoContinuity.js';

const installProcess = vi.hoisted(() => {
  const spawn = vi.fn();
  const makeChild = () => {
    const listeners = {};
    const child = {
      pid: 4242,
      killed: false,
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      kill: vi.fn(() => true),
      on: vi.fn((event, handler) => {
        listeners[event] = handler;
        if (event === 'close') setImmediate(() => handler(0));
        return child;
      }),
    };
    return child;
  };
  return { spawn, makeChild };
});
vi.mock('../lib/childProcess.js', async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: installProcess.spawn,
}));

// The enqueue gate resolves the runtime's LoRA capability for real (it is
// imported straight from the leaf so a mocked service can't fake it), which
// would spawn a venv python — and the suite's shared spawn mock reports every
// child as a clean exit, i.e. "capable". Pin the verdict explicitly so each
// test states the capability it is exercising.
const loraCapability = vi.hoisted(() => ({ capable: false }));
vi.mock('../services/videoGen/runtimes.js', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveByovRuntimeLoraCapable: vi.fn(async (runtime) => runtime === 'minimax_h3' && loraCapability.capable),
}));

vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn(async () => ({ imageGen: { local: { pythonPath: '/usr/bin/python3' } } })),
  updateSettingsWith: vi.fn(async (mutate) => mutate({ imageGen: { local: { pythonPath: '/usr/bin/python3' } } })),
}));

vi.mock('../services/musicVideo/projects.js', () => ({
  getProject: vi.fn(),
}));

vi.mock('../services/tracks/index.js', () => ({
  getTrack: vi.fn(),
}));

vi.mock('../lib/pythonSetup.js', () => ({
  checkPackages: vi.fn(async () => ({ installed: ['mflux', 'mlx'], missing: [], missingPip: [] })),
  isAllowedPython: vi.fn(() => true),
  detectPythonSync: vi.fn(() => null),
  // setupScriptRunner presets PYTHON_BIN from the venv-base picker on Windows.
  detectVenvBasePythonSync: vi.fn(() => null),
}));

vi.mock('../services/videoGen/local.js', () => ({
  // The route checks `runtime` on the default model when validating a2v —
  // include it so the a2v happy-path tests don't trip the A2V_REQUIRES_LTX2
  // guard. Tests that need to exercise the legacy runtime override the mock
  // per-test via mockReturnValueOnce.
  listVideoModels: vi.fn(() => [{ id: 'ltx2_unified', name: 'LTX-2 Unified', runtime: 'ltx2' }]),
  defaultVideoModelId: vi.fn(() => 'ltx2_unified'),
  loadHistory: vi.fn(async () => []),
  getHistoryItem: vi.fn(async () => null),
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
  BYOV_VIDEO_RUNTIMES: new Set(['ltx2', 'wan22', 'minimax_h3', 'hunyuan']),
  // The route's /status response now surfaces the BYOV runtime list so the
  // client can drop its hardcoded copy. Mirror the real shape — only the
  // `id` and a couple of UI-display fields are read by /status.
  BYOV_RUNTIME_INFO: {
    minimax_h3: {
      id: 'minimax_h3', label: 'MiniMax H3 MLX', venvPython: '/tmp/minimax-h3.py',
      installEnvVar: 'INSTALL_MINIMAX_H3', pinEnvVar: 'MINIMAX_H3_PIN',
      expectedRevision: 'fcd9e9b79a1d6018d91ac477c0968de1fa067e49',
      repoUrl: 'x', repoDir: '/tmp',
    },
    // No `expectedRevision`: this runtime is installed wheels, not a checkout,
    // which is why it carries an installSourceLabel instead of a clone URL.
    minimax_h3_cuda: {
      id: 'minimax_h3_cuda', label: 'MiniMax H3 CUDA', venvPython: '/tmp/minimax-h3-cuda.py',
      installEnvVar: 'INSTALL_MINIMAX_H3_CUDA', repoUrl: 'x', repoDir: '/tmp',
      installSourceLabel: 'pinned PyPI wheels',
    },
    ltx2: { id: 'ltx2', label: 'LTX-2 MLX', venvPython: '/tmp/ltx2.py', installEnvVar: 'INSTALL_LTX2', repoUrl: 'x', repoDir: '/tmp' },
    wan22: {
      id: 'wan22', label: 'Wan 2.2 MLX', venvPython: '/tmp/wan22.py',
      installEnvVar: 'INSTALL_WAN22', pinEnvVar: 'WAN22_PIN',
      expectedRevision: '2452f0c12edcc8886eebf15772205ce9c417a618',
      repoUrl: 'x', repoDir: '/tmp',
    },
    hunyuan: { id: 'hunyuan', label: 'HunyuanVideo MLX', venvPython: '/tmp/hunyuan.py', installEnvVar: 'INSTALL_HUNYUAN', repoUrl: 'x', repoDir: '/tmp' },
  },
  isByovRuntimeInstalled: vi.fn(() => false),
  isByovRuntimeReady: vi.fn(async () => false),
  isByovRuntimeCurrent: vi.fn(async () => false),
  invalidateByovReadyCache: vi.fn(),
  invalidateByovLoraCapabilityCache: vi.fn(),
  invalidateRuntimeFingerprintCache: vi.fn(),
  // /status now surfaces a runtime block (host chip/os + per-runtime versions).
  // Mock returns a fixed shape so the status test can assert it's wired through.
  resolveRuntimeFingerprint: vi.fn(async () => ({
    host: { chip: 'Apple M5 Max', os: 'Darwin 25.5.0', platform: 'darwin', arch: 'arm64', node: 'v22' },
    runtimes: { ltx2: { runtime: 'ltx2', versions: { mlx: '0.22.0' }, chip: 'Apple M5 Max' } },
  })),
}));

const sseDownload = vi.hoisted(() => ({
  start: vi.fn(async ({ res }) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"type":"complete"}\n\n');
  }),
}));
vi.mock('../lib/sseDownload.js', () => ({
  startHfDownloadStream: sseDownload.start,
  openSseStream: (res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    return {
      send: (event) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); },
      safeEnd: () => { if (!res.writableEnded) res.end(); },
    };
  },
}));

// Render submissions go through the mediaJobQueue. Mock its surface so the
// route tests stay synchronous and don't kick off the worker loop.
// The federated branch resolves the peer + capacity preflight through this
// helper; mock it so the route test asserts its own validation and enqueue
// wiring without standing up a peer registry.
const federatedPeerId = '00000000-0000-4000-8000-0000000000f2';
vi.mock('../services/federatedMedia/remoteSubmission.js', () => ({
  prepareRemoteMediaJob: vi.fn(async ({ peerId, kind, request }) => ({
    peer: { id: peerId },
    capability: { kind, engine: request.engine, modelId: request.modelId },
    remoteMedia: { wireVersion: 1, peerId, reconcile: false, cancelRequested: false, request },
  })),
}));

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
// reaching into vi mock internals. Several files may be staged in one request
// (`setPendingUpload(a, b)`) — the rollback cases need more than one durable
// copy in flight to prove a later failure unwinds the earlier ones.
const pendingUpload = { current: null };
const setPendingUpload = (...files) => { pendingUpload.current = files.flat(); };

vi.mock('../lib/multipart.js', () => ({
  // Bypass the streaming parser. If a test set a pending upload via
  // setPendingUpload(), inject it under req.files keyed by fieldname so the
  // route exercises the upload-staging path; otherwise pass through.
  uploadFields: () => (req, _res, next) => {
    if (pendingUpload.current) {
      req.files = Object.fromEntries(pendingUpload.current.map((f) => [f.fieldname, f]));
      pendingUpload.current = null;
    }
    next();
  },
}));

vi.mock('../lib/fileUtils.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  PATHS: {
    root: '/mock',
    data: '/mock/data',
    images: '/mock/images',
    videos: '/mock/videos',
    uploads: '/mock/uploads',
    music: '/mock/music',
  },
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

import { copyFile, unlink } from 'fs/promises';
import * as videoGenService from '../services/videoGen/local.js';
import * as mediaJobQueue from '../services/mediaJobQueue/index.js';
import { prepareRemoteMediaJob } from '../services/federatedMedia/remoteSubmission.js';
import { getProject as getMusicVideoProject } from '../services/musicVideo/projects.js';
import { getTrack } from '../services/tracks/index.js';
import { resolveGalleryImage } from '../lib/fileUtils.js';
import { listIcLoraWeights } from '../lib/icLoraWeights.js';
import videoGenRoutes, { isAudioMime, LOCAL_ONLY_VIDEO_PARAMS } from './videoGen.js';

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
    loraCapability.capable = false;
    app = express();
    app.use(express.json());
    app.use('/api/video-gen', videoGenRoutes);
    app.use(errorMiddleware);
    vi.clearAllMocks();
    // Reset the upload holder so a test that set a pending upload but
    // bailed before the route consumed it can't leak into the next test.
    pendingUpload.current = null;
    installProcess.spawn.mockReset().mockImplementation(() => installProcess.makeChild());
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

    // #3674 — the backend policy-scope wording is server-owned so the UI can't
    // drift into ranking language ("less restrictive", "uncensored", …).
    it('serializes the local + hosted backend disclosures', async () => {
      const r = await request(app).get('/api/video-gen/status');
      expect(r.body.backendDisclosures.map((b) => b.id)).toEqual(['local', 'grok']);
      const local = r.body.backendDisclosures.find((b) => b.id === 'local');
      expect(local.execution).toBe('local');
      expect(local.facts.join(' ')).toMatch(/does not send your prompt/i);
      expect(local.facts.join(' ')).toMatch(/no model-level prompt filter/i);
      expect(local.facts.join(' ')).toMatch(/license/i);
      const grok = r.body.backendDisclosures.find((b) => b.id === 'grok');
      expect(grok.execution).toBe('hosted');
      expect(grok.provider).toBe('xAI');
      expect(grok.facts.join(' ')).toMatch(/sent to xAI/i);
      for (const link of grok.links) expect(link.url).toMatch(/^https:\/\//);
      for (const backend of r.body.backendDisclosures) {
        expect([backend.summary, ...backend.facts].join(' '))
          .not.toMatch(/uncensored|unrestricted|less restrictive/i);
      }
    });

    it('passes each model entry through with its registry disclosure block', async () => {
      videoGenService.listVideoModels.mockReturnValueOnce([
        {
          id: 'ltx2_unified',
          name: 'LTX-2 Unified',
          runtime: 'ltx2',
          disclosure: { modelCardUrl: 'https://huggingface.co/example-org/example-video', reviewedAt: '2026-08-09' },
        },
        { id: 'custom', name: 'Custom', runtime: 'ltx2', source: 'user' },
      ]);
      const r = await request(app).get('/api/video-gen/status');
      expect(r.body.models[0].disclosure.modelCardUrl).toBe('https://huggingface.co/example-org/example-video');
      // Custom models carry no disclosure — the UI renders Unknown rather than
      // inheriting a shipped model's licensing.
      expect('disclosure' in r.body.models[1]).toBe(false);
    });
  });

  describe('GET /setup/runtime-status', () => {
    it('reports a missing runtime without probing readiness or revision', async () => {
      const r = await request(app).get('/api/video-gen/setup/runtime-status?runtime=wan22');
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        runtime: 'wan22', installed: false, binaryPresent: false,
        packagesReady: false, current: false, upgradeAvailable: false,
      });
      expect(videoGenService.isByovRuntimeReady).not.toHaveBeenCalled();
      expect(videoGenService.isByovRuntimeCurrent).not.toHaveBeenCalled();
    });

    it('reports a ready runtime as installed only when its checkout is current', async () => {
      videoGenService.isByovRuntimeInstalled.mockReturnValueOnce(true);
      videoGenService.isByovRuntimeReady.mockResolvedValueOnce(true);
      videoGenService.isByovRuntimeCurrent.mockResolvedValueOnce(true);
      const r = await request(app).get('/api/video-gen/setup/runtime-status?runtime=wan22');
      expect(r.body).toMatchObject({
        installed: true, binaryPresent: true, packagesReady: true,
        current: true, upgradeAvailable: false,
      });
    });

    it('offers an upgrade without importing an outdated checkout', async () => {
      videoGenService.isByovRuntimeInstalled.mockReturnValueOnce(true);
      videoGenService.isByovRuntimeCurrent.mockResolvedValueOnce(false);
      const r = await request(app).get('/api/video-gen/setup/runtime-status?runtime=wan22');
      expect(r.body).toMatchObject({
        installed: false, binaryPresent: true, packagesReady: false,
        current: false, upgradeAvailable: true,
      });
      expect(videoGenService.isByovRuntimeReady).not.toHaveBeenCalled();
    });

    // The install banner renders "PortOS can fetch and install it from X". For a
    // runtime that clones its repoUrl, X is that URL; for minimax_h3_cuda the
    // repoUrl is DOCUMENTATION (there is no checkout, only a venv), so the label
    // has to reach the client or the banner tells the user PortOS downloads the
    // runtime from a docs page.
    it.each([
      ['wan22', undefined],
      ['minimax_h3_cuda', 'pinned PyPI wheels'],
    ])('surfaces the install source label for %s', async (runtime, expected) => {
      const r = await request(app).get(`/api/video-gen/setup/runtime-status?runtime=${runtime}`);
      expect(r.status).toBe(200);
      expect(r.body.installSourceLabel).toBe(expected);
    });
  });

  describe('GET /setup/runtime-install', () => {
    it('short-circuits only when the runtime packages and pinned revision are current', async () => {
      videoGenService.isByovRuntimeInstalled.mockReturnValueOnce(true);
      videoGenService.isByovRuntimeReady.mockResolvedValueOnce(true);
      videoGenService.isByovRuntimeCurrent.mockResolvedValueOnce(true);
      const r = await request(app).get('/api/video-gen/setup/runtime-install?runtime=wan22');
      expect(r.status).toBe(200);
      expect(r.text).toContain('"type":"complete"');
      expect(r.text).toContain('Already installed');
      expect(videoGenService.invalidateByovReadyCache).not.toHaveBeenCalled();
    });

    it('upgrades an outdated checkout with the pinned revision in the installer environment', async () => {
      videoGenService.isByovRuntimeInstalled
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true);
      videoGenService.isByovRuntimeReady
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);
      videoGenService.isByovRuntimeCurrent
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      const r = await request(app).get('/api/video-gen/setup/runtime-install?runtime=wan22');
      expect(r.status).toBe(200);
      expect(r.text).toContain('"type":"complete"');
      expect(r.text).toContain('Wan 2.2 MLX ready');
      const [bin, argv, opts] = installProcess.spawn.mock.calls.at(-1);
      // A bash, but never the WSL one PM2's PATH may resolve first, and never a
      // backslash path — bash reads those as escapes and exits 127.
      expect(bin).toMatch(/bash(.exe)?$/i);
      expect(bin.toLowerCase()).not.toContain('system32');
      expect(argv).toEqual(['/mock/scripts/setup-image-video.sh']);
      expect(opts).toMatchObject({
        detached: process.platform !== 'win32',
        env: expect.objectContaining({
          INSTALL_WAN22: '1',
          WAN22_PIN: '2452f0c12edcc8886eebf15772205ce9c417a618',
        }),
      });
    });
  });

  describe('GET /models', () => {
    it('returns the static catalog', async () => {
      const r = await request(app).get('/api/video-gen/models');
      expect(r.status).toBe(200);
      expect(r.body).toEqual([{ id: 'ltx2_unified', name: 'LTX-2 Unified', runtime: 'ltx2' }]);
    });
  });

  describe('GET /models/:modelId/download — restricted terms', () => {
    const h3CheckpointFiles = ['LICENSE', 'FL2VA/model_index.json', 'FL2VA/video_vae/source/model.safetensors'];
    const h3 = {
      id: 'minimax_h3_8bit',
      name: 'MiniMax H3 MLX 8-bit',
      runtime: 'minimax_h3',
      repo: 'pipenetwork/MiniMax-H3-MLX-8bit',
      revision: '3ac52081470b0488921c3ec3ba84a39097bf2361',
      termsGate: { id: 'minimax-h3-community-license-2026-08-02' },
      supportedModes: ['text'],
      defaultFrames: 124,
      frameOptions: [107, 124, 141, 158],
      fpsOptions: [24],
      defaultWidth: 1344,
      defaultHeight: 768,
      resolutionStep: 32,
      steps: 8,
      guidance: 0,
      samplerLocked: true,
      requiredWeights: [{
        repo: 'MiniMaxAI/MiniMax-H3',
        revision: '6818f6c32d12b210915e44ad56a4228c2608f160',
        files: h3CheckpointFiles,
      }],
    };

    it('downloads both exact snapshots without a recorded acknowledgement', async () => {
      videoGenService.listVideoModels.mockReturnValueOnce([h3]);
      const accepted = await request(app).get('/api/video-gen/models/minimax_h3_8bit/download');
      expect(accepted.status).toBe(200);
      expect(sseDownload.start).toHaveBeenCalledWith(expect.objectContaining({
        repos: [
          {
            repo: 'pipenetwork/MiniMax-H3-MLX-8bit',
            revision: '3ac52081470b0488921c3ec3ba84a39097bf2361',
            only: [],
          },
          {
            repo: 'MiniMaxAI/MiniMax-H3',
            revision: '6818f6c32d12b210915e44ad56a4228c2608f160',
            only: h3CheckpointFiles,
          },
        ],
      }));
    });

    it('queues an H3 render without a recorded acknowledgement', async () => {
      videoGenService.listVideoModels.mockReturnValue([h3]);
      const render = await request(app).post('/api/video-gen/').send({
        prompt: 'a fox watches the rain',
        modelId: h3.id,
        mode: 'text',
        numFrames: 107,
        fps: 24,
        width: 1536,
        height: 672,
      });
      expect(render.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({
          modelId: h3.id,
          numFrames: 107,
          fps: 24,
          width: 1536,
          height: 672,
        }),
      }));
      expect(mediaJobQueue.enqueueJob.mock.calls.at(-1)[0].params)
        .not.toHaveProperty('termsAcceptance');
      videoGenService.listVideoModels.mockReset();
    });
  });

  describe('POST /model-terms — install-wide acknowledgement', () => {
    const h3 = {
      id: 'minimax_h3_8bit',
      name: 'MiniMax H3 MLX 8-bit',
      termsGate: { id: 'minimax-h3-community-license-2026-08-02' },
    };

    it('records and withdraws the acknowledgement for a known gate id', async () => {
      const { updateSettingsWith } = await import('../services/settings.js');
      videoGenService.listVideoModels.mockReturnValueOnce([h3]);
      updateSettingsWith.mockImplementationOnce(async (mutate) => mutate({}));
      const accept = await request(app)
        .post('/api/video-gen/model-terms')
        .send({ termsId: h3.termsGate.id, accepted: true });
      expect(accept.status).toBe(200);
      expect(accept.body.accepted).toEqual([h3.termsGate.id]);

      videoGenService.listVideoModels.mockReturnValueOnce([h3]);
      updateSettingsWith.mockImplementationOnce(async (mutate) =>
        mutate({ videoGen: { acceptedModelTerms: [h3.termsGate.id] } }));
      const withdraw = await request(app)
        .post('/api/video-gen/model-terms')
        .send({ termsId: h3.termsGate.id, accepted: false });
      expect(withdraw.status).toBe(200);
      expect(withdraw.body.accepted).toEqual([]);
    });

    it('rejects an id no shipped model declares rather than storing a no-op acceptance', async () => {
      videoGenService.listVideoModels.mockReturnValueOnce([h3]);
      const bogus = await request(app)
        .post('/api/video-gen/model-terms')
        .send({ termsId: 'not-a-real-license', accepted: true });
      expect(bogus.status).toBe(400);
      expect(bogus.body.code).toBe('VIDEO_MODEL_TERMS_UNKNOWN_ID');
    });

    it('reports the persisted acknowledgements', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce({ videoGen: { acceptedModelTerms: [h3.termsGate.id, ''] } });
      const listed = await request(app).get('/api/video-gen/model-terms');
      expect(listed.status).toBe(200);
      expect(listed.body.accepted).toEqual([h3.termsGate.id]);
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

  describe('POST / — video pin ladder (#3231 Phase 4)', () => {
    const grokReady = { grok: { enabled: true, grokPath: '/opt/grok' } };

    it('routes an unpinned-request render to grok via settings.videoGen.mode', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce({ imageGen: grokReady, videoGen: { mode: 'grok' } });
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a fox' });
      expect(r.status).toBe(200);
      expect(r.body.mode).toBe('grok');
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({ mode: 'grok', videoMode: 'text', grokPath: '/opt/grok' }),
      }));
    });

    it('an explicit backend outranks the install pin', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce({
        imageGen: { ...grokReady, local: { pythonPath: '/usr/bin/python3' } },
        videoGen: { mode: 'grok' },
      });
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a fox', backend: 'local' });
      expect(r.status).toBe(200);
      const [call] = mediaJobQueue.enqueueJob.mock.calls;
      expect(call[0].params.mode).not.toBe('grok');
    });

    it('a named local model anchors a no-backend request local, even under a grok pin', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce({
        imageGen: { ...grokReady, local: { pythonPath: '/usr/bin/python3' } },
        videoGen: { mode: 'grok' },
      });
      // A media requeue rebuilds a local render's config (modelId, no backend)
      // — grok has no model knob, so the pin must not discard the model.
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a fox', modelId: 'ltx2_unified' });
      expect(r.status).toBe(200);
      const [call] = mediaJobQueue.enqueueJob.mock.calls;
      expect(call[0].params.mode).not.toBe('grok');
      expect(call[0].params.modelId).toBe('ltx2_unified');
    });

    it.each(Object.entries({
      numFrames: 49,
      fps: 24,
      steps: 25,
      guidanceScale: 3,
      seed: 0,
      imageStrength: 0.5,
      tiling: 'auto',
    }))('keeps %s on the local path under a grok pin', async (param, value) => {
      expect(Object.keys(LOCAL_ONLY_VIDEO_PARAMS)).toEqual([
        'numFrames',
        'fps',
        'steps',
        'guidanceScale',
        'seed',
        'imageStrength',
        'tiling',
        // Not in the it.each table above: the route deliberately DROPS the
        // stock value from persisted params, so the generic round-trip
        // assertion can't cover it. Its own case is below.
        'textEncoderId',
      ]);
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce({ imageGen: grokReady, videoGen: { mode: 'grok' } });
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a fox', [param]: value });
      expect(r.status).toBe(200);
      const [call] = mediaJobQueue.enqueueJob.mock.calls;
      expect(call[0].params.mode).not.toBe('grok');
      expect(call[0].params[param]).toBe(value);
    });

    // grok has no conditioner knob, so naming one must keep the render local —
    // even for the stock id, which the route then drops from persisted params
    // (an unswapped render's job params stay byte-identical to a request that
    // never sent the field). Both halves matter: keeping it local without
    // dropping it would persist a knob that never applied.
    it('keeps textEncoderId on the local path under a grok pin, without persisting the stock value', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce({ imageGen: grokReady, videoGen: { mode: 'grok' } });
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a fox', textEncoderId: 'stock' });
      expect(r.status).toBe(200);
      const [call] = mediaJobQueue.enqueueJob.mock.calls;
      expect(call[0].params.mode).not.toBe('grok');
      expect(call[0].params.textEncoderId).toBeUndefined();
    });

    it('a grok pin degrades to local when the request carries local-only machinery', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce({
        imageGen: { ...grokReady, local: { pythonPath: '/usr/bin/python3' } },
        videoGen: { mode: 'grok' },
      });
      // 'fflf' is a local-runtime semantic — the pin must not hijack it to grok
      // (which would silently drop the keyframe machinery).
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a fox', mode: 'fflf' });
      expect(r.status).toBe(200);
      const [call] = mediaJobQueue.enqueueJob.mock.calls;
      expect(call[0].params.mode).not.toBe('grok');
    });

    it('a disabled grok install pin degrades to local instead of erroring', async () => {
      const { getSettings } = await import('../services/settings.js');
      getSettings.mockResolvedValueOnce({
        imageGen: { grok: { enabled: false }, local: { pythonPath: '/usr/bin/python3' } },
        videoGen: { mode: 'grok' },
      });
      const r = await request(app).post('/api/video-gen/').send({ prompt: 'a fox' });
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

    // H3 CAN take LoRAs — it's the pinned runner that can't apply them to the
    // quantized DiT. "Use an LTX-2.x model" would be wrong advice, so the
    // rejection carries its own code and reason.
    it('rejects LoRAs on an H3 model whose runtime has no applicator, with an H3-specific code', async () => {
      videoGenService.listVideoModels.mockReturnValueOnce([
        { id: 'minimax_h3_8bit', name: 'MiniMax H3', runtime: 'minimax_h3', defaultFrames: 141, frameOptions: [141], fpsOptions: [24], runtimeLoraCapable: false },
      ]);
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'clip',
        modelId: 'minimax_h3_8bit',
        loraFilenames: ['a.safetensors'],
      });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('MINIMAX_H3_LORA_UNSUPPORTED');
    });

    // The decoration is a SYNC cache read, so a capable install still reports
    // `runtimeLoraCapable: false` until the probe lands. The gate must resolve
    // it rather than trust that snapshot — otherwise the first LoRA render after
    // boot is refused and only succeeds on a retry.
    it('resolves the probe rather than trusting a cold decoration on the model payload', async () => {
      loraCapability.capable = true;
      videoGenService.listVideoModels.mockReturnValueOnce([
        { id: 'minimax_h3_8bit', name: 'MiniMax H3', runtime: 'minimax_h3', defaultFrames: 141, frameOptions: [141], fpsOptions: [24], runtimeLoraCapable: false },
      ]);
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'clip',
        modelId: 'minimax_h3_8bit',
        loraFilenames: ['a.safetensors'],
      });
      expect(r.status).toBe(200);
    });

    it('accepts LoRAs on an H3 model once the runtime probe proved it capable', async () => {
      loraCapability.capable = true;
      videoGenService.listVideoModels.mockReturnValueOnce([
        { id: 'minimax_h3_8bit', name: 'MiniMax H3', runtime: 'minimax_h3', defaultFrames: 141, frameOptions: [141], fpsOptions: [24], runtimeLoraCapable: true },
      ]);
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'clip',
        modelId: 'minimax_h3_8bit',
        loraFilenames: ['a.safetensors'],
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        params: expect.objectContaining({ loras: [{ filename: 'a.safetensors', scale: 1.0 }] }),
      }));
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

    it('defaults the continuation context window on a chained request', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a long shot',
        chunks: 3,
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        params: expect.objectContaining({ chunks: 3, contextFrames: DEFAULT_CONTEXT_FRAMES }),
      }));
    });

    it('forwards an explicit context window', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a long shot',
        chunks: 2,
        contextFrames: 45,
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        params: expect.objectContaining({ contextFrames: 45 }),
      }));
    });

    it('preserves contextFrames: 0 — last-frame chaining, not "unset"', async () => {
      // Dropping the 0 would silently upgrade the render back to a window and
      // give the user a materially different clip than they asked for.
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a long shot',
        chunks: 2,
        contextFrames: 0,
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        params: expect.objectContaining({ contextFrames: 0 }),
      }));
    });

    it('omits contextFrames entirely when the request does not chain', async () => {
      // Persisting a knob that could never have applied would replay into the
      // form on resume as if the user had chosen it.
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a single render',
        contextFrames: 45,
      });
      expect(r.status).toBe(200);
      const { params } = mediaJobQueue.enqueueJob.mock.calls.at(-1)[0];
      expect(params.chunks).toBe(1);
      expect(params).not.toHaveProperty('contextFrames');
    });

    it('rejects a context window past the cap', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a long shot',
        chunks: 2,
        contextFrames: MAX_CONTEXT_FRAMES + 1,
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/contextFrames/i);
    });

    it('forwards per-chunk prompt beats, keeping a blank entry as a fallback marker', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a long shot',
        chunks: 3,
        chunkPrompts: ['she opens the door', '', 'the storm breaks'],
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        params: expect.objectContaining({
          chunks: 3,
          chunkPrompts: ['she opens the door', null, 'the storm breaks'],
        }),
      }));
    });

    it('accepts a JSON-encoded beat list (the multipart submit shape)', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a long shot',
        chunks: 2,
        chunkPrompts: JSON.stringify(['first beat', 'second beat']),
      });
      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        params: expect.objectContaining({ chunkPrompts: ['first beat', 'second beat'] }),
      }));
    });

    it('omits beats entirely from a single-chunk render', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a single render',
        chunkPrompts: ['a stale beat'],
      });
      expect(r.status).toBe(200);
      const { params } = mediaJobQueue.enqueueJob.mock.calls.at(-1)[0];
      expect(params.chunks).toBe(1);
      expect('chunkPrompts' in params).toBe(false);
    });

    it('rejects a beat list longer than the chunk cap', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'too many beats',
        chunks: 2,
        chunkPrompts: Array.from({ length: 9 }, (_, i) => `beat ${i}`),
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/chunkPrompts/i);
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
          audioFilePath: expect.stringMatching(/[\\/]mock[\\/]uploads[\\/]video-audio-.*\.wav$/),
          // and threaded into uploadedTempPaths (array) for worker cleanup —
          // uploadedTempPath (singular) stays reserved for the start-frame
          // upload so legacy persisted jobs replay correctly.
          uploadedTempPaths: expect.arrayContaining([
            expect.stringMatching(/[\\/]mock[\\/]uploads[\\/]video-audio-.*\.wav$/),
          ]),
        }),
      }));
    });

    it('stages project audio and forwards the scene song offset for music-video a2v', async () => {
      getMusicVideoProject.mockResolvedValue({
        id: 'mv-example',
        trackId: 'track-example',
        scenes: [{ sceneId: 'scene-example' }],
      });
      getTrack.mockResolvedValue({ id: 'track-example', audioFilename: 'example-song.wav' });

      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'rain pulses with the percussion; no performers',
        mode: 'a2v',
        sourceImageFile: 'reference.png',
        audioStartSec: 42.5,
        disableAudio: true,
        musicVideo: { projectId: 'mv-example', sceneId: 'scene-example' },
      });

      expect(r.status).toBe(200);
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'video',
        params: expect.objectContaining({
          mode: 'a2v',
          sourceImagePath: '/mock/images/reference.png',
          audioStartSec: 42.5,
          disableAudio: true,
          audioFilePath: expect.stringMatching(/[\\/]mock[\\/]uploads[\\/]video-audio-.*\.wav$/),
          uploadedTempPaths: expect.arrayContaining([
            expect.stringMatching(/[\\/]mock[\\/]uploads[\\/]video-audio-.*\.wav$/),
          ]),
          musicVideo: { projectId: 'mv-example', sceneId: 'scene-example' },
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

    // ── IC-LoRA remix modes (#3100) ─────────────────────────────────────────
    // The reference channel is what makes an IC render meaningful, so every
    // pairing rule fails fast at the route rather than in the worker.
    describe('IC-LoRA remix modes (#3100)', () => {
      const icUpload = {
        fieldname: 'icReference',
        path: '/tmp/upload-fake.mp4',
        originalname: 'depth.mp4',
        mimetype: 'video/mp4',
        size: 4321,
      };

      it('rejects ic-control with no reference (IC_LORA_REFERENCE_REQUIRED)', async () => {
        const r = await request(app).post('/api/video-gen/').send({
          prompt: 'follow the depth clip', mode: 'ic-control',
        });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/requires a reference video/i);
        expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      });

      it('stages an icReference upload and forwards icReferencePaths', async () => {
        setPendingUpload(icUpload);
        const r = await request(app).post('/api/video-gen/').send({
          prompt: 'follow the depth clip', mode: 'ic-control', icStrength: 0.8,
        });
        expect(r.status).toBe(200);
        expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
          params: expect.objectContaining({
            mode: 'ic-control',
            icStrength: 0.8,
            icReferencePaths: [expect.stringMatching(/[\\/]mock[\\/]uploads[\\/]video-ic-ref-.*\.mp4$/)],
            // Tracked for worker cleanup the same way the audio upload is.
            uploadedTempPaths: expect.arrayContaining([
              expect.stringMatching(/[\\/]mock[\\/]uploads[\\/]video-ic-ref-.*\.mp4$/),
            ]),
            // Chaining is meaningless for a reference-anchored render.
            chunks: 1,
          }),
        }));
      });

      it('resolves an icReferenceVideoIds history pick to its on-disk path', async () => {
        const id = '33333333-3333-4333-8333-333333333333';
        videoGenService.loadHistory.mockResolvedValueOnce([{ id, filename: `${id}.mp4` }]);
        const r = await request(app).post('/api/video-gen/').send({
          prompt: 'follow the prior render', mode: 'ic-control', icReferenceVideoIds: id,
        });
        expect(r.status).toBe(200);
        expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
          params: expect.objectContaining({
            icReferencePaths: [resolve('/mock/videos', `${id}.mp4`)],
          }),
        }));
      });

      it('rejects an icReferenceVideoIds id that is not in history', async () => {
        videoGenService.loadHistory.mockResolvedValueOnce([]);
        const r = await request(app).post('/api/video-gen/').send({
          prompt: 'follow it', mode: 'ic-control',
          icReferenceVideoIds: '44444444-4444-4444-8444-444444444444',
        });
        expect(r.status).toBe(404);
        expect(r.body.error).toMatch(/not found in history/i);
        expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      });

      it('rejects an upload combined with a history pick (IC_LORA_REFERENCE_CONFLICT)', async () => {
        setPendingUpload(icUpload);
        const r = await request(app).post('/api/video-gen/').send({
          prompt: 'follow it', mode: 'ic-control',
          icReferenceVideoIds: '55555555-5555-4555-8555-555555555555',
        });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/one reference shape per request/i);
        expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      });

      it('rejects more picks than the weight accepts (IC_LORA_REFERENCE_COUNT)', async () => {
        // Control is single-reference; the bounds come from the registry, so this
        // fires before any staging or history I/O.
        const r = await request(app).post('/api/video-gen/').send({
          prompt: 'follow them', mode: 'ic-control',
          icReferenceVideoIds: [
            '66666666-6666-4666-8666-666666666666',
            '77777777-7777-4777-8777-777777777777',
          ],
        });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/needs exactly 1 reference video/i);
        expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      });

      it('rejects an IC reference outside an IC mode (IC_LORA_MODE_MISMATCH)', async () => {
        setPendingUpload(icUpload);
        const r = await request(app).post('/api/video-gen/').send({
          prompt: 'plain render', mode: 'text',
        });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/only valid with an IC remix mode/i);
        expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      });

      it('rejects an IC mode on a non-ltx2 model (IC_LORA_REQUIRES_LTX2)', async () => {
        videoGenService.listVideoModels.mockReturnValueOnce([
          { id: 'ltx_legacy', name: 'LTX legacy', runtime: 'mlx_video' },
        ]);
        setPendingUpload(icUpload);
        const r = await request(app).post('/api/video-gen/').send({
          prompt: 'follow it', mode: 'ic-control', modelId: 'ltx_legacy',
        });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/ltx2-runtime model/i);
        expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      });

      it('rejects an IC mode on the grok backend (IC_LORA_REQUIRES_LOCAL_BACKEND)', async () => {
        // The grok short-circuit runs before IC staging, so without this guard
        // the reference clip would be silently dropped and a plain grok render
        // queued instead.
        setPendingUpload(icUpload);
        const r = await request(app).post('/api/video-gen/').send({
          prompt: 'follow it', mode: 'ic-control', backend: 'grok',
        });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/isn't available on the Grok backend/i);
        expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      });

      it('rejects an IC mode combined with chunks > 1 (IC_LORA_CHUNKS_CONFLICT)', async () => {
        setPendingUpload(icUpload);
        const r = await request(app).post('/api/video-gen/').send({
          prompt: 'follow it', mode: 'ic-control', chunks: 3,
        });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/chunks > 1/i);
        expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      });

      // ── Ingredients: 2-8 gallery STILLS (#3112) ──────────────────────────
      // A separate input surface from the clip fields above. The counts are the
      // weight's contract — a wrong one yields plausible garbage rather than an
      // error inside the pipeline, so the route asserts them before enqueue.
      describe('ic-ingredients image references (#3112)', () => {
        const stills = (n) => Array.from({ length: n }, (_, i) => `ref-${i}.png`);

        it('resolves 2-8 gallery stills to absolute paths', async () => {
          for (const n of [2, 5, 8]) {
            mediaJobQueue.enqueueJob.mockClear();
            const r = await request(app).post('/api/video-gen/').send({
              prompt: 'the owl greets the camera outside the store',
              mode: 'ic-ingredients', icReferenceImageFiles: stills(n),
            });
            expect(r.status).toBe(200);
            expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
              params: expect.objectContaining({
                mode: 'ic-ingredients',
                icReferencePaths: stills(n).map((f) => `/mock/images/${f}`),
                chunks: 1,
              }),
            }));
          }
        });

        it('rejects fewer than 2 references', async () => {
          const r = await request(app).post('/api/video-gen/').send({
            prompt: 'recompose', mode: 'ic-ingredients', icReferenceImageFiles: stills(1),
          });
          expect(r.status).toBe(400);
          expect(r.body.error).toMatch(/needs 2-8 reference image/i);
          expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
        });

        it('rejects more references than any registered weight accepts', async () => {
          // The schema ceiling is DERIVED from the registry (the largest
          // maxReferences declared), not a second hardcoded 8 that would pre-empt
          // the per-weight check with a 422 the moment a weight raised its limit.
          const ceiling = Math.max(...listIcLoraWeights().map((w) => w.maxReferences));
          const r = await request(app).post('/api/video-gen/').send({
            prompt: 'recompose', mode: 'ic-ingredients', icReferenceImageFiles: stills(ceiling + 1),
          });
          expect(r.status).toBe(400);
          expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
        });

        it('lets the registry bound speak at the ceiling rather than the schema', async () => {
          // At exactly the registry maximum the request must reach the per-mode
          // assertion (and pass), proving the coarse schema bound isn't the one
          // enforcing the weight contract.
          const ceiling = Math.max(...listIcLoraWeights().map((w) => w.maxReferences));
          const r = await request(app).post('/api/video-gen/').send({
            prompt: 'recompose', mode: 'ic-ingredients', icReferenceImageFiles: stills(ceiling),
          });
          expect(r.status).toBe(200);
        });

        it('rejects no references with an actionable message', async () => {
          const r = await request(app).post('/api/video-gen/').send({
            prompt: 'recompose', mode: 'ic-ingredients',
          });
          expect(r.status).toBe(400);
          // Names the field to use — "needs 2-8; got 0" alone doesn't say HOW.
          expect(r.body.error).toMatch(/icReferenceImageFiles/);
          expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
        });

        it('rejects a gallery miss before enqueue', async () => {
          vi.mocked(resolveGalleryImage).mockImplementation((f) => (f === 'gone.png' ? null : `/mock/images/${f}`));
          const r = await request(app).post('/api/video-gen/').send({
            prompt: 'recompose', mode: 'ic-ingredients',
            icReferenceImageFiles: ['ref-0.png', 'gone.png'],
          });
          expect(r.status).toBe(400);
          expect(r.body.error).toMatch(/icReferenceImageFiles\[1\] not found in gallery/);
          expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
          vi.mocked(resolveGalleryImage).mockImplementation((name) => `/mock/images/${name}`);
        });

        it('rejects clip inputs on an image-kind weight (IC_LORA_REFERENCE_KIND_MISMATCH)', async () => {
          // Feeding a clip to an image-kind weight does NOT error in the pipeline —
          // it produces plausible-looking garbage. So reject rather than drop.
          setPendingUpload(icUpload);
          const r = await request(app).post('/api/video-gen/').send({
            prompt: 'recompose', mode: 'ic-ingredients', icReferenceImageFiles: stills(2),
          });
          expect(r.status).toBe(400);
          expect(r.body.error).toMatch(/conditions on still images/i);
          expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
        });

        it('rejects image references on a video-kind weight (IC_LORA_REFERENCE_KIND_MISMATCH)', async () => {
          const r = await request(app).post('/api/video-gen/').send({
            prompt: 'follow the depth clip', mode: 'ic-control',
            icReferenceImageFiles: stills(2),
          });
          expect(r.status).toBe(400);
          expect(r.body.error).toMatch(/conditions on a reference clip/i);
          expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
        });

        it('rejects image references outside an IC mode', async () => {
          const r = await request(app).post('/api/video-gen/').send({
            prompt: 'plain render', mode: 'text', icReferenceImageFiles: stills(2),
          });
          expect(r.status).toBe(400);
          expect(r.body.error).toMatch(/only valid with an IC remix mode/i);
          expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
        });
      });
    });
  });

  // Every throw path in POST / runs cleanupAllStaged()/cleanupTempUploads()
  // before it rethrows, and stageUploadDurable rolls its own half-written
  // destination back when copyFile rejects. None of that was asserted anywhere
  // — a regression that dropped the cleanup entirely would still return the
  // same status/body while leaking a 100MB durable copy under data/uploads on
  // every rejected request (#3289).
  describe('POST / — upload staging rollback (#3289)', () => {
    const sourceUpload = {
      fieldname: 'sourceImage',
      path: '/tmp/upload-frame.png',
      originalname: 'frame.png',
      mimetype: 'image/png',
      size: 2048,
    };
    const lastImageUpload = {
      fieldname: 'lastImage',
      path: '/tmp/upload-end-frame.png',
      originalname: 'end-frame.png',
      mimetype: 'image/png',
      size: 3072,
    };
    const audioUpload = {
      fieldname: 'audioFile',
      path: '/tmp/upload-beats.wav',
      originalname: 'beats.wav',
      mimetype: 'audio/wav',
      size: 1234,
    };
    const icUpload = {
      fieldname: 'icReference',
      path: '/tmp/upload-depth.mp4',
      originalname: 'depth.mp4',
      mimetype: 'video/mp4',
      size: 4321,
    };
    const unlinkedPaths = () => unlink.mock.calls.map(([p]) => p);
    // Durable copies live under PATHS.uploads (mocked to /mock/uploads); the
    // multipart temp files live under /tmp. Splitting them keeps the
    // "durable survives" assertion below from being satisfied by a temp unlink.
    const durableUnlinks = () => unlinkedPaths().filter((p) => /^[\\/]mock[\\/]uploads[\\/]/.test(p));

    it('unlinks the half-written destination AND every earlier staged copy when copyFile rejects', async () => {
      // sourceImage stages fine, audioFile's copy blows up — the failure has
      // to take BOTH the destination it was writing and the already-staged
      // sourceImage copy with it, since the job is never enqueued and the
      // worker's cleanup therefore never runs.
      copyFile
        .mockImplementationOnce(async () => {})
        .mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));
      setPendingUpload(sourceUpload, audioUpload);
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'beat-synced dancer',
        mode: 'a2v',
      });
      expect(r.status).toBe(500);
      expect(r.body.code).toBe('VIDEO_GEN_UPLOAD_STAGE_FAILED');
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      const unlinked = unlinkedPaths();
      expect(unlinked).toEqual(expect.arrayContaining([
        // the destination the failed copy may have partially written
        expect.stringMatching(/^[\\/]mock[\\/]uploads[\\/]video-audio-[^\\/]+\.wav$/),
        // …and the durable copy staged before it (stagedDurablePaths)
        expect.stringMatching(/^[\\/]mock[\\/]uploads[\\/]video-source-[^\\/]+\.png$/),
        // …and both multipart temp files
        sourceUpload.path,
        audioUpload.path,
      ]));
    });

    it('unlinks the pre-staged reference frame when the music-video scene lookup 404s', async () => {
      // Late-stage throw: the scene lookup runs AFTER the source frame has
      // already been copied into data/uploads.
      getMusicVideoProject.mockResolvedValueOnce(null);
      setPendingUpload(sourceUpload);
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'rain pulses with the percussion',
        mode: 'a2v',
        musicVideo: { projectId: 'mv-example', sceneId: 'scene-missing' },
      });
      expect(r.status).toBe(404);
      expect(r.body.code).toBe('NOT_FOUND');
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      expect(unlinkedPaths()).toEqual(expect.arrayContaining([
        expect.stringMatching(/^[\\/]mock[\\/]uploads[\\/]video-source-[^\\/]+\.png$/),
        sourceUpload.path,
      ]));
    });

    it('unlinks the pre-staged IC reference and source frame when a later validation throws', async () => {
      // keyframes are rejected for any non-fflf mode — by then both the source
      // frame and the IC reference clip are staged under data/uploads.
      setPendingUpload(sourceUpload, icUpload);
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'follow the depth clip',
        mode: 'ic-control',
        keyframes: [{ file: 'a.png', index: 0 }, { file: 'b.png', index: 24 }],
      });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('KEYFRAMES_MODE_MISMATCH');
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      expect(unlinkedPaths()).toEqual(expect.arrayContaining([
        expect.stringMatching(/^[\\/]mock[\\/]uploads[\\/]video-source-[^\\/]+\.png$/),
        expect.stringMatching(/^[\\/]mock[\\/]uploads[\\/]video-ic-ref-[^\\/]+\.mp4$/),
        sourceUpload.path,
        icUpload.path,
      ]));
    });

    it('unlinks both staged frames when an FFLF request mixes legacy inputs with keyframes', async () => {
      // lastImage is the one upload field with no rollback coverage above —
      // it stages between the source frame and the audio/IC fields, so a
      // durable copy that never made it into stagedDurablePaths would leak
      // here alone while every other case stayed green.
      setPendingUpload(sourceUpload, lastImageUpload);
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'morph between the anchors',
        mode: 'fflf',
        keyframes: [{ file: 'a.png', index: 0 }, { file: 'b.png', index: 24 }],
      });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('KEYFRAMES_LEGACY_INPUTS_CONFLICT');
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      expect(unlinkedPaths()).toEqual(expect.arrayContaining([
        expect.stringMatching(/^[\\/]mock[\\/]uploads[\\/]video-source-[^\\/]+\.png$/),
        expect.stringMatching(/^[\\/]mock[\\/]uploads[\\/]video-last-[^\\/]+\.png$/),
        sourceUpload.path,
        lastImageUpload.path,
      ]));
    });

    it('drops only the OS temp file on the happy path — the durable copy survives for the worker', async () => {
      setPendingUpload(sourceUpload);
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a fox running through snow',
        mode: 'image',
      });
      expect(r.status).toBe(200);
      // Pin the durable copy as actually having happened, and to the exact
      // destination the job was handed. Asserting only "nothing under
      // /mock/uploads was unlinked" would pass just as well if staging were
      // skipped altogether — there'd be no durable path to unlink.
      expect(copyFile).toHaveBeenCalledWith(
        sourceUpload.path,
        expect.stringMatching(/^[\\/]mock[\\/]uploads[\\/]video-source-[^\\/]+\.png$/),
      );
      const [, durableDest] = copyFile.mock.calls[0];
      expect(mediaJobQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
        params: expect.objectContaining({
          sourceImagePath: durableDest,
          uploadedTempPath: durableDest,
        }),
      }));
      expect(unlinkedPaths()).toContain(sourceUpload.path);
      // The queue worker owns the durable copy's lifetime — unlinking it here
      // would hand the worker a path that no longer exists.
      expect(durableUnlinks()).toEqual([]);
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

    it('resumes a federated render from its marker, not the blanked local fields', async () => {
      // The routed job's top-level prompt/model are blanked so a downgraded
      // build fails closed (#4683). Without reading through to the wire
      // request, a reload mid-render would repopulate the form with an empty
      // prompt and the LOCAL default model instead of the peer's.
      mediaJobQueue.listJobs.mockImplementation(listJobsByFilter([{
        id: 'remote-running',
        kind: 'video',
        status: 'running',
        position: 1,
        params: {
          prompt: '',
          modelId: null,
          pythonPath: null,
          remoteMedia: {
            wireVersion: 1,
            peerId: federatedPeerId,
            request: {
              kind: 'video', engine: 'local', modelId: 'ltx2', prompt: 'a slow pan across a harbour',
            },
          },
        },
      }]));
      const r = await request(app).get('/api/video-gen/active');
      expect(r.status).toBe(200);
      expect(r.body.activeJob.params.prompt).toBe('a slow pan across a harbour');
      expect(r.body.activeJob.params.modelId).toBe('ltx2');
      // The marker itself stays off this surface — it carries peer routing state.
      expect(r.body.activeJob.params).not.toHaveProperty('remoteMedia');
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

  describe('GET /history/:id', () => {
    // The point of the route (#4165): a timeline render's history id is a
    // randomUUID() that has nothing to do with its `timeline-*.mp4` filename,
    // so a client holding only the id learns the real file from HERE instead of
    // downloading the whole history list to find one row.
    it('returns the one entry, resolving an id whose filename is unrelated to it', async () => {
      const entry = { id: 'final-1', filename: 'timeline-abcd1234-1700000000000.mp4', thumbnail: 'final-1.jpg' };
      videoGenService.getHistoryItem.mockResolvedValueOnce(entry);
      const r = await request(app).get('/api/video-gen/history/final-1');
      expect(r.status).toBe(200);
      expect(r.body).toEqual(entry);
      expect(videoGenService.getHistoryItem).toHaveBeenCalledWith('final-1');
      // Never the full list — that fan-out is exactly what this replaced.
      expect(videoGenService.loadHistory).not.toHaveBeenCalled();
    });

    it('404s for an id that is not in history', async () => {
      videoGenService.getHistoryItem.mockResolvedValueOnce(null);
      const r = await request(app).get('/api/video-gen/history/gone-1');
      expect(r.status).toBe(404);
      expect(videoGenService.getHistoryItem).toHaveBeenCalledWith('gone-1');
    });

    it('decodes a percent-encoded id before looking it up', async () => {
      videoGenService.getHistoryItem.mockResolvedValueOnce(null);
      await request(app).get(`/api/video-gen/history/${encodeURIComponent('a b/c')}`);
      expect(videoGenService.getHistoryItem).toHaveBeenCalledWith('a b/c');
    });

    it('rejects an absurdly long id without touching the service', async () => {
      const r = await request(app).get(`/api/video-gen/history/${'x'.repeat(201)}`);
      expect(r.status).toBe(400);
      expect(videoGenService.getHistoryItem).not.toHaveBeenCalled();
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

  describe('POST /last-frame/:id', () => {
    it('forwards a shared-gallery upload id to extractLastFrame', async () => {
      const uploadId = 'upload-ab12cd34';
      videoGenService.extractLastFrame.mockResolvedValue({ filename: `anchor-${uploadId}.png` });

      const r = await request(app).post(`/api/video-gen/last-frame/${uploadId}`).send({});

      expect(r.status).toBe(200);
      expect(videoGenService.extractLastFrame).toHaveBeenCalledWith(uploadId);
    });

    it('rejects malformed ids before extracting a frame', async () => {
      const r = await request(app).post('/api/video-gen/last-frame/not-a-history-id').send({});

      expect(r.status).toBe(400);
      expect(videoGenService.extractLastFrame).not.toHaveBeenCalled();
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

    it('accepts a shared-gallery upload history id', async () => {
      videoGenService.stitchVideos.mockResolvedValue({ id: 's1', filename: 's1.mp4' });
      const uploadId = 'upload-ab12cd34';
      const r = await request(app).post('/api/video-gen/stitch').send({ videoIds: [uploadId, validId(2)] });
      expect(r.status).toBe(200);
      expect(videoGenService.stitchVideos).toHaveBeenCalledWith([uploadId, validId(2)]);
    });
  });

  describe('POST /upscale/:id', () => {
    const validHistoryId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1';
    const otherValidId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbb2';

    it('rejects history ids outside known render and upload shapes', async () => {
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

    it('forwards a shared-gallery upload id to upscaleHistoryItem', async () => {
      const uploadId = 'upload-ab12cd34';
      videoGenService.upscaleHistoryItem.mockResolvedValue({ id: otherValidId, filename: `${otherValidId}.mp4`, upscaledFrom: uploadId });
      const r = await request(app).post(`/api/video-gen/upscale/${uploadId}`).send({});
      expect(r.status).toBe(200);
      expect(videoGenService.upscaleHistoryItem).toHaveBeenCalledWith(uploadId);
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

  describe('POST / — federated media provider', () => {
    it('submits to the selected peer and keeps the prompt inside the versioned marker', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a slow pan across a harbour',
        modelId: 'ltx2',
        numFrames: 121,
        fps: 24,
        mediaProviderPeerId: federatedPeerId,
      });

      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        jobId: 'mock-video-job',
        // No local backend renders this, so `mode` must not name one.
        mode: null,
        model: 'ltx2',
        mediaProviderPeerId: federatedPeerId,
      });
      expect(prepareRemoteMediaJob).toHaveBeenCalledWith({
        peerId: federatedPeerId,
        kind: 'video',
        request: {
          kind: 'video',
          engine: 'local',
          modelId: 'ltx2',
          prompt: 'a slow pan across a harbour',
          numFrames: 121,
          fps: 24,
        },
        // A text-to-video render carries none, but the field is always passed —
        // an empty list and an absent one must read the same to the submitter.
        inputAssets: [],
      });

      const [{ params }] = mediaJobQueue.enqueueJob.mock.calls[0];
      // Prompt and dials ride only inside the versioned marker; no local render
      // input is carried over at all. enqueueJob owns blanking the rest (#4683)
      // — its own suites cover that, and enqueueJob is mocked here.
      expect(params).toEqual({ remoteMedia: expect.objectContaining({ peerId: federatedPeerId }) });
      expect(params.remoteMedia.request.prompt).toBe('a slow pan across a harbour');
      expect(params.remoteMedia.request.modelId).toBe('ltx2');
    });

    it('requires an explicit provider model instead of falling back to a local default', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a slow pan across a harbour',
        mediaProviderPeerId: federatedPeerId,
      });

      expect(r.status).toBe(400);
      expect(r.body.code).toBe('MEDIA_PROVIDER_MODEL_REQUIRED');
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    // A start frame is single-render conditioning and now crosses (ADR
    // docs/decisions/2026-08-22-federated-media-input-assets.md rule 1) — as a
    // LOCAL path handed to the submitter, which uploads it through the
    // provider's digest-verified asset endpoint immediately before submitting.
    it('routes a start frame to the peer as conditioning rather than refusing it', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a slow pan across a harbour',
        modelId: 'ltx2',
        sourceImageFile: 'frame.png',
        mediaProviderPeerId: federatedPeerId,
      });

      expect(r.status).toBe(200);
      expect(prepareRemoteMediaJob).toHaveBeenCalledWith(expect.objectContaining({
        inputAssets: [{ role: 'sourceImage', path: 'frame.png' }],
      }));
    });

    // The end frame alone would render a plain text-to-video clip with the
    // supplied frame silently discarded — a valid-looking render of a different
    // thing, which is the failure the whole guard exists to prevent.
    it('refuses an end frame with no start frame', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a slow pan across a harbour',
        modelId: 'ltx2',
        lastImageFile: 'end.png',
        mediaProviderPeerId: federatedPeerId,
      });

      expect(r.status).toBe(400);
      expect(r.body.code).toBe('MEDIA_PROVIDER_INPUT_UNSUPPORTED');
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });

    // A LoRA is a MODEL, not conditioning, and remote model installation is out
    // of scope for federation (rule 3). This one stays a refusal on purpose.
    it('refuses a federated render that carries LoRA weights', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a slow pan across a harbour',
        modelId: 'ltx2',
        loraFilenames: ['style.safetensors'],
        mediaProviderPeerId: federatedPeerId,
      });

      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/LoRA weights/);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
      expect(prepareRemoteMediaJob).not.toHaveBeenCalled();
    });

    it('refuses a federated chained render rather than shipping one unchained clip', async () => {
      const r = await request(app).post('/api/video-gen/').send({
        prompt: 'a slow pan across a harbour',
        modelId: 'ltx2',
        chunks: 3,
        mediaProviderPeerId: federatedPeerId,
      });

      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/chained chunks/);
      expect(mediaJobQueue.enqueueJob).not.toHaveBeenCalled();
    });
  });

});
