import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { ServerError } from '../lib/errorHandler.js';

// Mock the music-gen service's engine registry and readiness probes. Generation
// itself is queued through mediaJobQueue and never runs inside this route.
const gen = vi.hoisted(() => ({
  ready: true,
  readyByEngine: null,
  healthy: null,
  healthyByEngine: null,
  unsupportedPlatform: null,
}));
const mediaQueue = vi.hoisted(() => ({ jobs: [], enqueue: vi.fn() }));
const remoteProvider = vi.hoisted(() => ({ peers: [], resolve: vi.fn() }));
const cuda = vi.hoisted(() => ({ status: 'available', maxVramGb: 40 }));
vi.mock('../lib/cudaCapability.js', () => ({
  getCudaCapability: vi.fn(async () => ({ status: cuda.status, gpus: [], maxVramGb: cuda.maxVramGb, error: null })),
}));
vi.mock('../services/pipeline/musicGen.js', () => {
  const ENGINES = {
    musicgen: { id: 'musicgen', name: 'MusicGen', models: [{ id: 'm', name: 'M' }], defaultModelId: 'm', minDurationSec: 1, maxDurationSec: 30, defaultDurationSec: 12, installEnv: 'INSTALL_MUSICGEN', venvDefault: '/v/mg', resolvePython: () => (gen.ready ? '/v/mg/bin/python3' : null), customModels: true },
    acestep: { id: 'acestep', name: 'ACE-Step', models: [{ id: 'a', name: 'A' }], defaultModelId: 'a', minDurationSec: 1, maxDurationSec: 240, defaultDurationSec: 60, installEnv: 'INSTALL_ACESTEP', venvDefault: '/v/ace', resolvePython: () => (gen.ready ? '/v/ace/bin/python3' : null), lyrics: true, customModels: false },
    acestep15: { id: 'acestep15', name: 'ACE-Step 1.5', models: [{ id: 'ace-step-v1.5', repo: 'ACE-Step/Ace-Step1.5', name: 'ACE-Step 1.5' }], defaultModelId: 'ace-step-v1.5', minDurationSec: 1, maxDurationSec: 240, defaultDurationSec: 60, installEnv: 'INSTALL_ACESTEP15', venvDefault: '/v/ace15', resolvePython: () => (gen.ready ? '/v/ace15/bin/python3' : null), lyrics: true, customModels: false, fixedModelInstall: true },
    'minimax-music3': { id: 'minimax-music3', name: 'MiniMax Music 3', models: [{ id: 'minimax-music3', repo: 'MiniMaxAI/MiniMax-Music3', name: 'MiniMax Music 3', downloadIgnore: ['qwen_7B/*', 'flowmatching_vae.pth', 'dav.pth', 'figures/*'], downloadSizeGb: 29 }], defaultModelId: 'minimax-music3', minDurationSec: 1, maxDurationSec: 300, defaultDurationSec: 60, installEnv: 'INSTALL_MINIMAX_MUSIC3', venvDefault: '/v/minimax', resolvePython: () => (gen.ready ? '/v/minimax/bin/python3' : null), lyrics: true, customModels: false, fixedModelInstall: true, cudaRequired: true, autoDuration: true, executionProfile: 'cuda-bf16-single-gpu', vramProfiles: { 'cuda-bf16-single-gpu': { label: 'CUDA BF16 (single GPU)', minVramGb: null, recommendedVramGb: null } } },
    'minimax-music3-mlx': { id: 'minimax-music3-mlx', name: 'MiniMax Music 3 (MLX)', models: [
      { id: 'minimax-music3-mlx-8bit', repo: 'mlx-community/MiniMax-Music3-8bit', revision: '10aa4ca578d04c6f5256c1bc22fc8405a09602b5', downloadSizeGb: 14, name: 'MiniMax Music 3 MLX 8-bit' },
      { id: 'minimax-music3-mlx-bf16', repo: 'mlx-community/MiniMax-Music3-bf16', revision: '83a5f2d365673689df5c8f36e21e108751fd92ea', downloadSizeGb: 29, name: 'MiniMax Music 3 MLX BF16' },
    ], defaultModelId: 'minimax-music3-mlx-8bit', minDurationSec: 1, maxDurationSec: 300, defaultDurationSec: 60, installEnv: 'INSTALL_MINIMAX_MUSIC3_MLX', venvDefault: '/v/minimax-mlx', resolvePython: () => (gen.ready ? '/v/minimax-mlx/bin/python3' : null), lyrics: true, customModels: false, fixedModelInstall: true, autoDuration: true },
  };
  return {
    ENGINES,
    DEFAULT_ENGINE_ID: 'musicgen',
    getEngine: (id) => ENGINES[id] || ENGINES.musicgen,
    getEngineModel: (id, modelId) => (ENGINES[id] || ENGINES.musicgen).models.find((m) => m.id === modelId) || null,
    isEngineReady: (engineId) => (gen.readyByEngine ? gen.readyByEngine[engineId] === true : gen.ready),
    // The route reads readiness through isEngineHealthy (the import probe), so
    // `gen.healthyByEngine` / `gen.healthy` drive it; both default to the same
    // `ready` knobs so existing cases keep their meaning.
    isEnginePlatformSupported: (engineId) => (gen.unsupportedPlatform ? engineId !== gen.unsupportedPlatform : true),
    enginePlatformLabel: () => 'macOS on Apple Silicon (MLX)',
    resolveEngineVramReadiness: (engineId, capability) => {
      const engine = ENGINES[engineId] || ENGINES.musicgen;
      const profile = engine.vramProfiles?.[engine.executionProfile];
      const state = !engine.cudaRequired
        ? 'sufficient'
        : profile?.minVramGb == null || capability.status !== 'available' || !Number.isFinite(capability.maxVramGb)
          ? 'unknown-size'
          : capability.maxVramGb >= profile.minVramGb ? 'sufficient' : 'insufficient';
      return {
        state,
        executionProfile: engine.executionProfile || null,
        profileLabel: profile?.label || null,
        minVramGb: profile?.minVramGb ?? null,
        recommendedVramGb: profile?.recommendedVramGb ?? null,
        maxVramGb: Number.isFinite(capability.maxVramGb) ? capability.maxVramGb : null,
      };
    },
    MUSIC_VRAM_READINESS: { SUFFICIENT: 'sufficient', INSUFFICIENT: 'insufficient', UNKNOWN_SIZE: 'unknown-size' },
    formatEngineVramReadinessMessage: (engineId, readiness, action = 'run') => {
      const engine = ENGINES[engineId] || ENGINES.musicgen;
      if (readiness.state === 'insufficient') return `${engine.name} requires at least ${readiness.minVramGb} GB of VRAM for the ${readiness.profileLabel || 'selected'} profile; this host reports ${readiness.maxVramGb} GB.`;
      if (readiness.state === 'unknown-size') return `${engine.name} cannot be ${action} because the GPU VRAM requirement has not been measured for the ${readiness.profileLabel || 'selected'} execution profile.`;
      return null;
    },
    isEngineHealthy: async (engineId) => {
      if (gen.healthyByEngine) return gen.healthyByEngine[engineId] === true;
      if (gen.healthy !== null) return gen.healthy;
      return gen.readyByEngine ? gen.readyByEngine[engineId] === true : gen.ready;
    },
    invalidateEngineHealth: vi.fn(),
  };
});
vi.mock('../services/mediaJobQueue/index.js', () => ({
  enqueueJob: (...args) => mediaQueue.enqueue(...args),
  listJobs: () => mediaQueue.jobs,
  JOB_KINDS: ['video', 'image', 'training', 'audio'],
  JOB_STATUSES: ['queued', 'running', 'completed', 'failed', 'canceled'],
}));
vi.mock('../services/instances.js', () => ({
  getPeers: vi.fn(async () => remoteProvider.peers),
}));
vi.mock('../services/federatedMediaConsumer.js', () => ({
  resolveFederatedMediaProvider: (...args) => remoteProvider.resolve(...args),
}));

// The install route shells out to scripts/setup-image-video.sh. Stand in a child
// that closes immediately so the SSE stream terminates instead of running a real
// multi-GB bash install under the test.
const setup = vi.hoisted(() => ({ spawn: vi.fn(), exitCode: 0 }));
vi.mock('../lib/setupScriptRunner.js', async () => ({
  // Keep the real SETUP_IMAGE_VIDEO_SCRIPT — the route existsSync-checks it.
  ...(await vi.importActual('../lib/setupScriptRunner.js')),
  stopSetupScript: vi.fn(),
  spawnSetupScript: (env) => {
    setup.spawn(env);
    const listeners = {};
    const child = {
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: (event, cb) => { listeners[event] = cb; },
    };
    Promise.resolve().then(() => listeners.close?.(setup.exitCode));
    return child;
  },
}));

vi.mock('../services/tracks/index.js', () => ({
  getTrack: vi.fn(),
  createTrack: vi.fn(async (input) => ({ id: 'track-new', ...input })),
  updateTrack: vi.fn(async (id, patch) => ({ id, ...patch })),
  buildRenderAppend: vi.fn((track, input) => {
    const render = { id: 'render-x', ...input };
    return { render, renders: [...(track?.renders || []), render] };
  }),
}));

const models = vi.hoisted(() => ({ list: vi.fn(), add: vi.fn(), remove: vi.fn() }));
vi.mock('../services/audioModels.js', () => ({
  listEngineModels: (engineId) => models.list(engineId),
  addAudioModel: (args) => models.add(args),
  removeAudioModel: (args) => models.remove(args),
  isValidRepoId: (r) => typeof r === 'string' && /^[\w.-]+\/[\w./-]+$/.test(r) && !r.includes('..'),
}));

// The SSE download driver writes to the response + ends it; stub it to a quick
// 200 so the route test doesn't spawn Python.
const sse = vi.hoisted(() => ({
  run: vi.fn(async ({ res }) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: {"type":"complete"}\n\n'); }),
  open: vi.fn((res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    return {
      send: (event) => res.write(`data: ${JSON.stringify(event)}\n\n`),
      safeEnd: () => { if (!res.writableEnded) res.end(); },
    };
  }),
}));
vi.mock('../lib/sseDownload.js', () => ({
  startHfDownloadStream: (args) => sse.run(args),
  openSseStream: (res) => sse.open(res),
}));

// Register-after-download gates on whether the repo landed in the cache.
const cache = vi.hoisted(() => ({ cached: true, byRevision: null, calls: [] }));
vi.mock('../lib/hfCache.js', () => ({ inspectModelCache: vi.fn(async (repo, options = {}) => {
  cache.calls.push({ repo, ...options });
  return { cached: cache.byRevision?.[options.revision] ?? cache.cached };
}) }));

vi.mock('../services/albums/index.js', () => ({
  getAlbum: vi.fn(async () => null),
  updateAlbum: vi.fn(async (id, patch) => ({ id, ...patch })),
}));

// The stepped designer's two LLM steps (#4305) — stubbed so the route tests pin
// validation + the exact service call args, not a provider round trip.
vi.mock('../services/musicDesigner.js', () => ({
  describeMusic: vi.fn(),
  writeLyrics: vi.fn(),
}));

import * as tracks from '../services/tracks/index.js';
import * as albums from '../services/albums/index.js';
import * as designer from '../services/musicDesigner.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import musicRoutes from './music.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/music', musicRoutes);
  app.use(errorMiddleware);
  return app;
}

describe('music routes', () => {
  let app;
  beforeEach(() => {
    app = makeApp();
    mediaQueue.enqueue.mockReset().mockImplementation(() => ({ jobId: 'job-1', position: 1, status: 'queued' }));
    mediaQueue.jobs = [];
    remoteProvider.peers = [];
    remoteProvider.resolve.mockReset();
    models.list.mockReset();
    // add/remove return promises by default so the route's `.catch()` chains
    // don't throw on an undefined return (mockReset clears the impl).
    models.add.mockReset().mockResolvedValue({});
    models.remove.mockReset().mockResolvedValue(true);
    tracks.getTrack.mockReset();
    tracks.createTrack.mockReset().mockImplementation(async (input) => ({ id: 'track-new', ...input }));
    tracks.updateTrack.mockReset().mockImplementation(async (id, patch) => ({ id, ...patch }));
    albums.getAlbum.mockReset().mockResolvedValue(null);
    albums.updateAlbum.mockReset().mockImplementation(async (id, patch) => ({ id, ...patch }));
    sse.run.mockReset().mockImplementation(async ({ res }) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: {"type":"complete"}\n\n'); });
    gen.ready = true;
    gen.readyByEngine = null;
    gen.healthy = null;
    gen.healthyByEngine = null;
    gen.unsupportedPlatform = null;
    setup.spawn.mockReset();
    setup.exitCode = 0;
    cache.cached = true;
    cache.byRevision = null;
    cache.calls.length = 0;
    cuda.status = 'available';
    cuda.maxVramGb = 40;
    models.list.mockResolvedValue([{ id: 'm', name: 'M', userAdded: false }]);
    designer.describeMusic.mockReset().mockResolvedValue({ description: 'Lush pads over a broken beat.', llm: { provider: 'fake-provider', model: 'fake-model' } });
    designer.writeLyrics.mockReset().mockResolvedValue({ lyrics: '[verse]\nrain on the window', llm: { provider: 'fake-provider', model: 'fake-model' } });
  });

  describe('POST /describe', () => {
    it('passes every designer field through to describeMusic and returns text + attribution', async () => {
      const r = await request(app).post('/api/music/describe').send({
        concept: 'a rainy downtempo loop',
        guidance: 'under 100 BPM',
        template: 'Be terse.',
        providerId: 'fake-provider',
        model: 'fake-model',
        effort: 'high',
      });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ description: 'Lush pads over a broken beat.', llm: { provider: 'fake-provider', model: 'fake-model' } });
      expect(designer.describeMusic).toHaveBeenCalledWith({
        concept: 'a rainy downtempo loop',
        guidance: 'under 100 BPM',
        template: 'Be terse.',
        providerId: 'fake-provider',
        model: 'fake-model',
        effort: 'high',
      });
    });

    it('normalizes empty picker values to undefined so the service falls back to its defaults', async () => {
      const r = await request(app).post('/api/music/describe').send({
        concept: 'a rainy downtempo loop', providerId: '', model: '   ', effort: '',
      });
      expect(r.status).toBe(200);
      expect(designer.describeMusic).toHaveBeenCalledWith({
        concept: 'a rainy downtempo loop',
        guidance: undefined,
        template: undefined,
        providerId: undefined,
        model: undefined,
        effort: undefined,
      });
    });

    it('rejects a missing/blank concept', async () => {
      const missing = await request(app).post('/api/music/describe').send({});
      expect(missing.status).toBe(400);
      const blank = await request(app).post('/api/music/describe').send({ concept: '   ' });
      expect(blank.status).toBe(400);
      expect(designer.describeMusic).not.toHaveBeenCalled();
    });

    it('rejects a concept past the prompt-field cap', async () => {
      const r = await request(app).post('/api/music/describe').send({ concept: 'x'.repeat(8001) });
      expect(r.status).toBe(400);
      expect(designer.describeMusic).not.toHaveBeenCalled();
    });

    it('surfaces the service NO_PROVIDER error through the error middleware', async () => {
      designer.describeMusic.mockRejectedValue(new ServerError('No AI provider available to describe the music', { status: 503, code: 'NO_PROVIDER' }));
      const r = await request(app).post('/api/music/describe').send({ concept: 'x' });
      expect(r.status).toBe(503);
      expect(r.body.code).toBe('NO_PROVIDER');
    });
  });

  describe('POST /lyrics', () => {
    it('passes every designer field through to writeLyrics and returns lyrics + attribution', async () => {
      const r = await request(app).post('/api/music/lyrics').send({
        description: 'warm rhodes soul',
        guidance: 'about leaving at dawn',
        template: 'Two verses only.',
        providerId: 'fake-provider',
        model: 'fake-model',
        effort: 'low',
      });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ lyrics: '[verse]\nrain on the window', llm: { provider: 'fake-provider', model: 'fake-model' } });
      expect(designer.writeLyrics).toHaveBeenCalledWith({
        description: 'warm rhodes soul',
        guidance: 'about leaving at dawn',
        template: 'Two verses only.',
        providerId: 'fake-provider',
        model: 'fake-model',
        effort: 'low',
      });
    });

    it('rejects a missing description', async () => {
      const r = await request(app).post('/api/music/lyrics').send({ guidance: 'about leaving at dawn' });
      expect(r.status).toBe(400);
      expect(designer.writeLyrics).not.toHaveBeenCalled();
    });

    it('surfaces the service LLM_EMPTY error through the error middleware', async () => {
      designer.writeLyrics.mockRejectedValue(new ServerError('The AI returned empty lyrics.', { status: 502, code: 'LLM_EMPTY' }));
      const r = await request(app).post('/api/music/lyrics').send({ description: 'warm rhodes soul' });
      expect(r.status).toBe(502);
      expect(r.body.code).toBe('LLM_EMPTY');
    });
  });

  it('GET /engines lists engines with readiness + lyric capability + merged models', async () => {
    const r = await request(app).get('/api/music/engines');
    expect(r.status).toBe(200);
    expect(r.body.defaultEngine).toBe('musicgen');
    const ace = r.body.engines.find((e) => e.id === 'acestep');
    expect(ace.lyrics).toBe(true);
    expect(ace.ready).toBe(true);
    expect(ace.customModels).toBe(false); // fixed checkpoint — no custom install
    expect(ace.models).toEqual([{ id: 'm', name: 'M', userAdded: false }]);
    const mg = r.body.engines.find((e) => e.id === 'musicgen');
    expect(mg.lyrics).toBe(false);
    expect(mg.customModels).toBe(true);
    expect(r.body.engines.find((e) => e.id === 'minimax-music3').autoDuration).toBe(true);
  });

  it('GET /engines reports readiness per engine', async () => {
    gen.readyByEngine = { musicgen: true, acestep: false };
    const r = await request(app).get('/api/music/engines');
    expect(r.status).toBe(200);
    expect(r.body.engines.find((e) => e.id === 'musicgen').ready).toBe(true);
    expect(r.body.engines.find((e) => e.id === 'acestep').ready).toBe(false);
  });

  it('GET /engines uses the CUDA capability status to expose installable MiniMax readiness', async () => {
    cache.cached = false;
    const supported = await request(app).get('/api/music/engines');
    expect(supported.body.engines.find((e) => e.id === 'minimax-music3')).toMatchObject({
      cudaState: 'available', vramState: 'unknown-size', fixedModelInstall: true, modelReady: false, runtimeReady: true, ready: false,
      executionProfile: 'cuda-bf16-single-gpu', minVramGb: null, recommendedVramGb: null, maxVramGb: 40,
      // The UI puts this on the install button so the user knows the size of the
      // pull before starting it.
      modelSizeGb: 29,
    });

    cuda.status = 'absent';
    const unsupported = await request(app).get('/api/music/engines');
    expect(unsupported.body.engines.find((e) => e.id === 'minimax-music3')).toMatchObject({
      cudaState: 'absent', vramState: 'unknown-size', ready: false,
    });
  });

  it('refuses MiniMax runtime installation when profile VRAM is unknown', async () => {
    const r = await request(app).get('/api/music/setup/runtime-install?runtime=minimax-music3');
    expect(r.status).toBe(200);
    expect(r.text).toContain('VRAM requirement has not been measured');
    expect(setup.spawn).not.toHaveBeenCalled();
  });

  it('GET /engines reports MLX readiness separately for the 8-bit and BF16 snapshots', async () => {
    cache.byRevision = {
      '10aa4ca578d04c6f5256c1bc22fc8405a09602b5': true,
      '83a5f2d365673689df5c8f36e21e108751fd92ea': false,
    };
    const r = await request(app).get('/api/music/engines');
    expect(r.status).toBe(200);
    expect(r.body.engines.find((e) => e.id === 'minimax-music3-mlx')).toMatchObject({
      modelReady: true,
      modelReadyById: {
        'minimax-music3-mlx-8bit': true,
        'minimax-music3-mlx-bf16': false,
      },
      ready: true,
      platformSupported: true,
      installEnv: 'INSTALL_MINIMAX_MUSIC3_MLX',
    });
    expect(cache.calls).toEqual(expect.arrayContaining([
      { repo: 'mlx-community/MiniMax-Music3-8bit', revision: '10aa4ca578d04c6f5256c1bc22fc8405a09602b5' },
      { repo: 'mlx-community/MiniMax-Music3-bf16', revision: '83a5f2d365673689df5c8f36e21e108751fd92ea' },
    ]));
  });

  it('GET /engines exposes ACE-Step 1.5 as a fixed model install distinct from v1', async () => {
    cache.cached = false;
    const r = await request(app).get('/api/music/engines');
    expect(r.status).toBe(200);
    expect(r.body.engines.find((e) => e.id === 'acestep15')).toMatchObject({
      lyrics: true, customModels: false, fixedModelInstall: true,
      modelReady: false, runtimeReady: true, ready: false,
      installEnv: 'INSTALL_ACESTEP15',
    });
  });

  it('POST /models rejects an engine that does not support custom models (acestep)', async () => {
    const r = await request(app).post('/api/music/models').send({ engine: 'acestep', repo: 'someorg/ace-variant' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('AUDIO_MODEL_ENGINE_FIXED');
    expect(models.add).not.toHaveBeenCalled();
    expect(sse.run).not.toHaveBeenCalled();
  });

  it('GET /setup/runtime-status reports music runtime readiness', async () => {
    gen.ready = false;
    const missing = await request(app).get('/api/music/setup/runtime-status?runtime=acestep');
    expect(missing.status).toBe(200);
    expect(missing.body).toMatchObject({
      runtime: 'acestep',
      label: 'ACE-Step',
      installed: false,
      venvPath: null,
      expectedVenvPath: '/v/ace',
      installEnvVar: 'INSTALL_ACESTEP',
    });

    gen.ready = true;
    const ready = await request(app).get('/api/music/setup/runtime-status?runtime=acestep');
    expect(ready.status).toBe(200);
    expect(ready.body.installed).toBe(true);
    expect(ready.body.venvPath).toBe('/v/ace/bin/python3');
  });

  it('GET /setup/runtime-install completes without spawning when already installed', async () => {
    gen.ready = true;
    const r = await request(app).get('/api/music/setup/runtime-install?runtime=acestep');
    expect(r.status).toBe(200);
    expect(r.text).toContain('"type":"complete"');
    expect(r.text).toContain('Already installed');
  });

  it('GET /setup/runtime-install proceeds when the interpreter exists but the venv is broken', async () => {
    // Regression: a failed install leaves the venv's interpreter behind, so the
    // old interpreter-exists check short-circuited with "already installed" and
    // the engine could never be repaired from the UI.
    gen.ready = true;          // resolvePython() finds the leftover interpreter
    gen.healthy = false;       // ...but the import probe fails
    const r = await request(app).get('/api/music/setup/runtime-install?runtime=acestep');
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('Already installed');
    expect(r.text).toContain('Starting ACE-Step install.');
    expect(setup.spawn).toHaveBeenCalled();
  });

  it('GET /engines reports a broken venv as not ready so the install hint shows', async () => {
    gen.ready = true;
    gen.healthy = false;
    const r = await request(app).get('/api/music/engines');
    expect(r.status).toBe(200);
    const acestep = r.body.engines.find((e) => e.id === 'acestep');
    expect(acestep.runtimeReady).toBe(false);
    expect(acestep.ready).toBe(false);
  });

  it('GET /setup/runtime-install refuses on a host that can never run the engine', async () => {
    // Previously the route spawned the setup script, whose own platform guard
    // printed "Skipping." and exited 0 — surfaced to the user as "installer
    // exited 0 but the engine is still not available".
    gen.unsupportedPlatform = 'musicgen';
    gen.healthy = false;
    const r = await request(app).get('/api/music/setup/runtime-install?runtime=musicgen');
    expect(r.status).toBe(200);
    expect(r.text).toContain('cannot be installed on this host');
    expect(setup.spawn).not.toHaveBeenCalled();
  });

  it('GET /engines flags a host-incompatible engine so the UI can hide Install', async () => {
    gen.unsupportedPlatform = 'musicgen';
    const r = await request(app).get('/api/music/engines');
    const musicgen = r.body.engines.find((e) => e.id === 'musicgen');
    expect(musicgen.platformSupported).toBe(false);
    expect(musicgen.platformLabel).toContain('Apple Silicon');
    expect(r.body.engines.find((e) => e.id === 'acestep').platformSupported).toBe(true);
  });

  it('GET /models/:engine returns the merged model list; 404s for an unknown engine', async () => {
    const r = await request(app).get('/api/music/models/acestep');
    expect(r.status).toBe(200);
    expect(r.body.models).toEqual([{ id: 'm', name: 'M', userAdded: false }]);
    expect((await request(app).get('/api/music/models/nope')).status).toBe(404);
  });

  it('POST /models registers the model then streams the download (SSE)', async () => {
    models.add.mockResolvedValueOnce({ id: 'facebook/musicgen-large', repo: 'facebook/musicgen-large', name: 'musicgen-large' });
    const r = await request(app).post('/api/music/models').send({ engine: 'musicgen', repo: 'facebook/musicgen-large' });
    expect(r.status).toBe(200);
    // A user-added repo has no shipped contract about which paths matter, so it
    // gets the full snapshot (no ignore patterns).
    expect(sse.run).toHaveBeenCalledWith(expect.objectContaining({
      repos: [{ repo: 'facebook/musicgen-large', ignore: [] }],
    }));
    // Registered only AFTER the download landed in the cache.
    expect(models.add).toHaveBeenCalledWith({ engine: 'musicgen', repo: 'facebook/musicgen-large', name: undefined });
  });

  it('POST /models pins a fixed MLX download to the shipped revision', async () => {
    const r = await request(app).post('/api/music/models').send({
      engine: 'minimax-music3-mlx', repo: 'mlx-community/MiniMax-Music3-8bit',
    });
    expect(r.status).toBe(200);
    expect(models.add).not.toHaveBeenCalled();
    expect(sse.run).toHaveBeenCalledWith(expect.objectContaining({
      repos: [{
        repo: 'mlx-community/MiniMax-Music3-8bit',
        ignore: [],
        revision: '10aa4ca578d04c6f5256c1bc22fc8405a09602b5',
      }],
    }));
    expect(cache.calls).toContainEqual({
      repo: 'mlx-community/MiniMax-Music3-8bit',
      revision: '10aa4ca578d04c6f5256c1bc22fc8405a09602b5',
    });
  });

  it('POST /models forwards a shipped fixed model\'s downloadIgnore to the download stream', async () => {
    const r = await request(app).post('/api/music/models').send({ engine: 'minimax-music3', repo: 'MiniMaxAI/MiniMax-Music3' });
    expect(r.status).toBe(200);
    // Skipping the bundled captioner and original-format checkpoints keeps the
    // roughly 29 GB the diffusers pipeline actually loads on the user's disk.
    expect(sse.run).toHaveBeenCalledWith(expect.objectContaining({
      repos: [{
        repo: 'MiniMaxAI/MiniMax-Music3',
        ignore: ['qwen_7B/*', 'flowmatching_vae.pth', 'dav.pth', 'figures/*'],
      }],
    }));
    // A shipped model is already in the engine's list — nothing to register.
    expect(models.add).not.toHaveBeenCalled();
  });

  it('POST /models rolls back the registration when the download did not land', async () => {
    cache.cached = false; // download failed/cancelled → repo not in cache
    const r = await request(app).post('/api/music/models').send({ engine: 'musicgen', repo: 'someorg/typo-repo' });
    expect(r.status).toBe(200); // the SSE stream still completes (with its error frames)
    expect(sse.run).toHaveBeenCalled();
    // Registered up front (durable before the client's refresh), then rolled back
    // because the weights never landed — net: not persisted.
    expect(models.add).toHaveBeenCalled();
    expect(models.remove).toHaveBeenCalledWith({ engine: 'musicgen', id: 'someorg/typo-repo' });
  });

  it('POST /models rejects an unknown engine / invalid repo before downloading', async () => {
    expect((await request(app).post('/api/music/models').send({ engine: 'nope', repo: 'a/b' })).status).toBe(400);
    expect((await request(app).post('/api/music/models').send({ engine: 'musicgen', repo: 'bad' })).status).toBe(400);
    expect(models.add).not.toHaveBeenCalled();
    expect(sse.run).not.toHaveBeenCalled();
  });

  it('DELETE /models/:engine/* de-registers a slash-containing repo id', async () => {
    models.remove.mockResolvedValueOnce(true);
    const r = await request(app).delete('/api/music/models/musicgen/facebook/musicgen-large');
    expect(r.status).toBe(200);
    expect(r.body.removed).toBe(true);
    expect(models.remove).toHaveBeenCalledWith({ engine: 'musicgen', id: 'facebook/musicgen-large' });
  });

  it('POST /generate queues a new track render', async () => {
    const r = await request(app).post('/api/music/generate').send({
      prompt: 'warm folk', lyrics: '[verse] hi', engine: 'acestep', title: 'My Song',
    });
    expect(r.status).toBe(202);
    expect(mediaQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'audio', params: expect.objectContaining({ prompt: 'warm folk', lyrics: '[verse] hi', engine: 'acestep' }),
    }));
  });

  it('POST /generate queues an explicitly selected remote model without resolving it locally', async () => {
    const peer = { id: '00000000-0000-4000-8000-000000000001', enabled: true };
    remoteProvider.peers = [peer];
    remoteProvider.resolve.mockResolvedValueOnce({
      peer,
      capability: {
        kind: 'audio',
        engine: 'remote-audio',
        engineName: 'Remote Audio',
        modelId: 'example/model',
        lyrics: true,
        autoDuration: false,
        minDurationSec: 10,
        maxDurationSec: 120,
      },
    });

    const r = await request(app).post('/api/music/generate').send({
      prompt: 'private idea for alice@example.com',
      engine: 'remote-audio',
      modelId: 'example/model',
      durationSec: 30,
      mediaProviderPeerId: peer.id,
      remoteMusicProfile: {
        style: 'cinematic',
        mood: 'dreamy',
        tempo: 'slow',
        energy: 'medium',
        instruments: ['strings', 'synthesizer'],
      },
    });

    expect(r.status).toBe(202);
    expect(remoteProvider.resolve).toHaveBeenCalledWith(peer, {
      kind: 'audio', engine: 'remote-audio', modelId: 'example/model',
    });
    expect(models.list).not.toHaveBeenCalled();
    expect(mediaQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'audio',
      params: expect.objectContaining({
        engine: 'remote-audio',
        modelId: 'example/model',
        prompt: '',
        lyrics: '',
        remoteMedia: {
          wireVersion: 1,
          peerId: peer.id,
          reconcile: false,
          cancelRequested: false,
          profile: {
            style: 'cinematic',
            mood: 'dreamy',
            tempo: 'slow',
            energy: 'medium',
            instruments: ['strings', 'synthesizer'],
          },
          request: {
            engine: 'remote-audio',
            modelId: 'example/model',
            durationSec: 30,
          },
        },
        musicStudio: expect.objectContaining({ lyricsEnabled: true }),
      }),
    }));
    const remoteMarker = mediaQueue.enqueue.mock.calls[0][0].params.remoteMedia;
    expect(JSON.stringify(remoteMarker)).not.toContain('alice@example.com');
  });

  it('POST /generate fails before queueing when remote routing is incomplete or unavailable', async () => {
    const peer = { id: '00000000-0000-4000-8000-000000000001', enabled: true };
    remoteProvider.peers = [peer];

    const incomplete = await request(app).post('/api/music/generate').send({
      prompt: 'pulse', engine: 'remote-audio', mediaProviderPeerId: peer.id,
    });
    expect(incomplete.status).toBe(400);

    remoteProvider.resolve.mockRejectedValueOnce(new ServerError('Provider busy', {
      status: 429,
      code: 'MEDIA_PROVIDER_BUSY',
    }));
    const busy = await request(app).post('/api/music/generate').send({
      prompt: 'pulse',
      engine: 'remote-audio',
      modelId: 'example/model',
      mediaProviderPeerId: peer.id,
      remoteMusicProfile: { style: 'ambient', mood: 'calm' },
    });
    expect(busy.status).toBe(429);
    expect(busy.body.code).toBe('MEDIA_PROVIDER_BUSY');
    expect(mediaQueue.enqueue).not.toHaveBeenCalled();
  });

  it('POST /generate rejects free-form lyrics before probing a remote provider', async () => {
    const peer = { id: '00000000-0000-4000-8000-000000000001', enabled: true };
    remoteProvider.peers = [peer];

    const r = await request(app).post('/api/music/generate').send({
      prompt: 'private concept',
      lyrics: 'Call alice@example.com',
      engine: 'remote-audio',
      modelId: 'example/model',
      mediaProviderPeerId: peer.id,
      remoteMusicProfile: { style: 'ambient', mood: 'calm' },
    });

    expect(r.status).toBe(400);
    expect(remoteProvider.resolve).not.toHaveBeenCalled();
    expect(mediaQueue.enqueue).not.toHaveBeenCalled();
  });

  it('POST /generate forwards MiniMax auto duration mode to the queue', async () => {
    const r = await request(app).post('/api/music/generate').send({
      prompt: 'warm folk',
      lyrics: `[verse]\n${'word '.repeat(180)}\n[outro]`,
      engine: 'minimax-music3',
      durationMode: 'auto',
    });

    expect(r.status).toBe(202);
    expect(mediaQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({
      engine: 'minimax-music3',
      lyrics: expect.stringContaining('[verse]'),
      durationMode: 'auto',
      }),
    }));
  });

  it('POST /generate queues an existing-track render', async () => {
    tracks.getTrack.mockResolvedValueOnce({ id: 'track-1', title: 'Existing' });
    const r = await request(app).post('/api/music/generate').send({ prompt: 'beat', trackId: 'track-1' });
    expect(r.status).toBe(202);
    expect(mediaQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ musicStudio: expect.objectContaining({ trackId: 'track-1' }) }) }));
  });

  it('POST /generate marks non-lyric jobs as not lyric-enabled', async () => {
    tracks.getTrack.mockResolvedValueOnce({ id: 'track-1', title: 'Has Lyrics', lyrics: 'keep me' });
    // MusicGen is not lyric-aware; even if the client sends lyrics:'' the update must omit lyrics.
    await request(app).post('/api/music/generate').send({ prompt: 'bed', lyrics: '', engine: 'musicgen', trackId: 'track-1' });
    expect(mediaQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ musicStudio: expect.objectContaining({ lyricsEnabled: false }) }) }));
  });

  it('POST /generate records the empty conditioning snapshot when lyrics are absent', async () => {
    tracks.getTrack.mockResolvedValueOnce({ id: 'track-1', title: 'Song', lyrics: 'old words' });
    await request(app).post('/api/music/generate').send({ prompt: 'folk', engine: 'acestep', trackId: 'track-1' }); // no lyrics field
    expect(mediaQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ lyrics: '', musicStudio: expect.objectContaining({ lyricsEnabled: true }) }) }));
  });

  it('POST /generate separates authored text from instrumental engine conditioning', async () => {
    tracks.getTrack.mockResolvedValueOnce({ id: 'track-1', title: 'Song', lyrics: 'keep these words' });
    const r = await request(app).post('/api/music/generate').send({
      prompt: 'warm folk',
      lyrics: '[verse] do not condition with this',
      instrumentalOnly: true,
      engine: 'acestep',
      trackId: 'track-1',
    });

    expect(r.status).toBe(202);
    expect(mediaQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({
        prompt: expect.stringContaining('Instrumental only.'),
        lyrics: '',
        musicStudio: expect.objectContaining({
          authoredPrompt: 'warm folk',
          authoredLyrics: '[verse] do not condition with this',
          lyricsEnabled: true,
          lyricsProvided: true,
          instrumentalOnly: true,
        }),
      }),
    }));
    const queuedPrompt = mediaQueue.enqueue.mock.calls[0][0].params.prompt;
    expect(queuedPrompt).toContain('Do not include sung, spoken, chanted, choir, or background vocals.');
    expect(queuedPrompt).not.toBe('warm folk');
  });

  it('POST /generate keeps the track destination in the job snapshot', async () => {
    tracks.getTrack.mockResolvedValueOnce({ id: 'track-1' });
    await request(app).post('/api/music/generate').send({ prompt: 'beat', engine: 'musicgen', trackId: 'track-1' });
    expect(mediaQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ musicStudio: expect.objectContaining({ trackId: 'track-1' }) }) }));
  });

  it('POST /generate preserves an explicit lyric clear in the job snapshot', async () => {
    tracks.getTrack.mockResolvedValueOnce({ id: 'track-1', title: 'Song', lyrics: 'old words' });
    await request(app).post('/api/music/generate').send({ prompt: 'instrumental', lyrics: '', engine: 'acestep', trackId: 'track-1' });
    expect(mediaQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ lyrics: '', musicStudio: expect.objectContaining({ lyricsEnabled: true }) }) }));
  });

  it('POST /generate validates trackId BEFORE rendering (no wasted render)', async () => {
    tracks.getTrack.mockResolvedValueOnce(null);
    const r = await request(app).post('/api/music/generate').send({ prompt: 'x', trackId: 'gone' });
    expect(r.status).toBe(404);
    expect(mediaQueue.enqueue).not.toHaveBeenCalled();
  });

  it('POST /generate resolves a USER-INSTALLED model id to the queued job', async () => {
    models.list.mockResolvedValueOnce([
      { id: 'm', name: 'M', userAdded: false },
      { id: 'someorg/big-musicgen', name: 'Big', repo: 'someorg/big-musicgen', userAdded: true },
    ]);
    await request(app).post('/api/music/generate').send({ prompt: 'x', engine: 'musicgen', modelId: 'someorg/big-musicgen' });
    expect(mediaQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ repo: 'someorg/big-musicgen', modelId: 'someorg/big-musicgen' }) }));
  });

  it('POST /generate rejects an unknown modelId BEFORE rendering', async () => {
    models.list.mockResolvedValueOnce([{ id: 'm', name: 'M', userAdded: false }]);
    const r = await request(app).post('/api/music/generate').send({ prompt: 'x', engine: 'musicgen', modelId: 'gone/removed' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('PIPELINE_MUSIC_UNKNOWN_MODEL');
    expect(mediaQueue.enqueue).not.toHaveBeenCalled();
  });

  it('POST /generate carries album metadata to the queued job', async () => {
    await request(app).post('/api/music/generate').send({ prompt: 'x', engine: 'musicgen', albumId: 'album-1' });
    expect(mediaQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ musicStudio: expect.objectContaining({ albumId: 'album-1' }) }) }));
  });

  it('POST /generate with an unknown trackId 404s and does not queue', async () => {
    tracks.getTrack.mockResolvedValueOnce(null);
    const r = await request(app).post('/api/music/generate').send({ prompt: 'x', trackId: 'track-missing' });
    expect(r.status).toBe(404);
    expect(tracks.updateTrack).not.toHaveBeenCalled();
    expect(mediaQueue.enqueue).not.toHaveBeenCalled();
  });

  it('POST /generate rejects an unknown engine before queueing (no wrong-backend output)', async () => {
    const r = await request(app).post('/api/music/generate').send({ prompt: 'x', engine: 'acestep-v2' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('PIPELINE_MUSIC_UNKNOWN_ENGINE');
    expect(mediaQueue.enqueue).not.toHaveBeenCalled();
  });

  it('POST /generate rejects a missing prompt', async () => {
    const r = await request(app).post('/api/music/generate').send({ engine: 'acestep' });
    expect(r.status).toBe(400);
    expect(mediaQueue.enqueue).not.toHaveBeenCalled();
  });

  it('POST /generate acknowledges even when rendering will later report a runtime failure', async () => {
    const r = await request(app).post('/api/music/generate').send({ prompt: 'x', engine: 'acestep' });
    expect(r.status).toBe(202);
    expect(mediaQueue.enqueue).toHaveBeenCalled();
  });

  it('POST /generate returns a queued audio job with the Music Studio destination tag', async () => {
    const r = await request(app).post('/api/music/generate').send({
      prompt: 'warm folk', lyrics: '[verse] hi', engine: 'acestep', title: 'My Song', albumId: 'album-1',
    });
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ jobId: 'job-1', position: 1, status: 'queued' });
    expect(mediaQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'audio',
      params: expect.objectContaining({
        prompt: 'warm folk', lyrics: '[verse] hi', engine: 'acestep',
        musicStudio: expect.objectContaining({ trackId: null, title: 'My Song', albumId: 'album-1', lyricsEnabled: true }),
      }),
    }));
  });

  it('POST /generate rejects a duplicate live render for the same track', async () => {
    mediaQueue.jobs = [{ id: 'existing-job', kind: 'audio', status: 'running', params: { musicStudio: { trackId: 'track-1' } } }];
    tracks.getTrack.mockResolvedValueOnce({ id: 'track-1' });
    const r = await request(app).post('/api/music/generate').send({ prompt: 'beat', trackId: 'track-1' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('PIPELINE_MUSIC_BUSY');
    expect(r.body.context.jobId).toBe('existing-job');
    expect(mediaQueue.enqueue).not.toHaveBeenCalled();
  });
});
