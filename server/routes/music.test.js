import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { ServerError } from '../lib/errorHandler.js';

// Mock the music-gen service: a small engine registry + a generateMusic that the
// tests drive per-case. The route only consumes ENGINES/getEngine/isEngineReady/
// generateMusic + DEFAULT_ENGINE_ID.
const gen = vi.hoisted(() => ({ generateMusic: vi.fn(), ready: true }));
vi.mock('../services/pipeline/musicGen.js', () => {
  const ENGINES = {
    musicgen: { id: 'musicgen', name: 'MusicGen', models: [{ id: 'm', name: 'M' }], defaultModelId: 'm', minDurationSec: 1, maxDurationSec: 30, defaultDurationSec: 12, installEnv: 'INSTALL_MUSICGEN', venvDefault: '/v/mg' },
    acestep: { id: 'acestep', name: 'ACE-Step', models: [{ id: 'a', name: 'A' }], defaultModelId: 'a', minDurationSec: 1, maxDurationSec: 240, defaultDurationSec: 60, installEnv: 'INSTALL_ACESTEP', venvDefault: '/v/ace', lyrics: true },
  };
  return {
    ENGINES,
    DEFAULT_ENGINE_ID: 'musicgen',
    getEngine: (id) => ENGINES[id] || ENGINES.musicgen,
    isEngineReady: () => gen.ready,
    generateMusic: gen.generateMusic,
  };
});

vi.mock('../services/tracks/index.js', () => ({
  getTrack: vi.fn(),
  createTrack: vi.fn(async (input) => ({ id: 'track-new', ...input })),
  updateTrack: vi.fn(async (id, patch) => ({ id, ...patch })),
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
const sse = vi.hoisted(() => ({ run: vi.fn(async ({ res }) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: {"type":"complete"}\n\n'); }) }));
vi.mock('../lib/sseDownload.js', () => ({ startHfDownloadStream: (args) => sse.run(args) }));

import * as tracks from '../services/tracks/index.js';
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
    vi.clearAllMocks();
    gen.ready = true;
    models.list.mockResolvedValue([{ id: 'm', name: 'M', userAdded: false }]);
  });

  it('GET /engines lists engines with readiness + lyric capability + merged models', async () => {
    const r = await request(app).get('/api/music/engines');
    expect(r.status).toBe(200);
    expect(r.body.defaultEngine).toBe('musicgen');
    const ace = r.body.engines.find((e) => e.id === 'acestep');
    expect(ace.lyrics).toBe(true);
    expect(ace.ready).toBe(true);
    expect(ace.models).toEqual([{ id: 'm', name: 'M', userAdded: false }]);
    expect(r.body.engines.find((e) => e.id === 'musicgen').lyrics).toBe(false);
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
    expect(models.add).toHaveBeenCalledWith({ engine: 'musicgen', repo: 'facebook/musicgen-large', name: undefined });
    expect(sse.run).toHaveBeenCalledWith(expect.objectContaining({ repo: 'facebook/musicgen-large' }));
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

  it('POST /generate creates a new track from the result', async () => {
    gen.generateMusic.mockResolvedValueOnce({ filename: 'music-gen-x.wav', durationSec: 61.4, engine: 'acestep', modelId: 'a' });
    const r = await request(app).post('/api/music/generate').send({
      prompt: 'warm folk', lyrics: '[verse] hi', engine: 'acestep', title: 'My Song',
    });
    expect(r.status).toBe(201);
    expect(gen.generateMusic).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'warm folk', lyrics: '[verse] hi', engine: 'acestep' }));
    expect(tracks.createTrack).toHaveBeenCalledWith(expect.objectContaining({
      title: 'My Song', audioFilename: 'music-gen-x.wav', engine: 'acestep', modelId: 'a', durationSec: 61, lyrics: '[verse] hi',
    }));
    expect(r.body.track.id).toBe('track-new');
    expect(r.body.filename).toBe('music-gen-x.wav');
  });

  it('POST /generate with trackId updates the existing track (200)', async () => {
    tracks.getTrack.mockResolvedValueOnce({ id: 'track-1', title: 'Existing' });
    gen.generateMusic.mockResolvedValueOnce({ filename: 'music-gen-y.wav', durationSec: 30, engine: 'musicgen', modelId: 'm' });
    const r = await request(app).post('/api/music/generate').send({ prompt: 'beat', trackId: 'track-1' });
    expect(r.status).toBe(200);
    expect(tracks.updateTrack).toHaveBeenCalledWith('track-1', expect.objectContaining({ audioFilename: 'music-gen-y.wav' }));
    expect(tracks.createTrack).not.toHaveBeenCalled();
  });

  it('POST /generate with an unknown trackId 404s and does not create', async () => {
    tracks.getTrack.mockResolvedValueOnce(null);
    gen.generateMusic.mockResolvedValueOnce({ filename: 'm.wav', durationSec: 10, engine: 'musicgen', modelId: 'm' });
    const r = await request(app).post('/api/music/generate').send({ prompt: 'x', trackId: 'track-missing' });
    expect(r.status).toBe(404);
    expect(tracks.updateTrack).not.toHaveBeenCalled();
    expect(tracks.createTrack).not.toHaveBeenCalled();
  });

  it('POST /generate rejects a missing prompt', async () => {
    const r = await request(app).post('/api/music/generate').send({ engine: 'acestep' });
    expect(r.status).toBe(400);
    expect(gen.generateMusic).not.toHaveBeenCalled();
  });

  it('POST /generate surfaces a 503 when the engine venv is missing', async () => {
    gen.generateMusic.mockRejectedValueOnce(new ServerError('ACE-Step runtime not found. Run `INSTALL_ACESTEP=1 …`', { status: 503, code: 'PIPELINE_MUSIC_RUNTIME_MISSING' }));
    const r = await request(app).post('/api/music/generate').send({ prompt: 'x', engine: 'acestep' });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('PIPELINE_MUSIC_RUNTIME_MISSING');
    expect(tracks.createTrack).not.toHaveBeenCalled();
  });
});
