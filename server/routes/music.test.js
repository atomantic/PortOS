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
    musicgen: { id: 'musicgen', name: 'MusicGen', models: [{ id: 'm', name: 'M' }], defaultModelId: 'm', minDurationSec: 1, maxDurationSec: 30, defaultDurationSec: 12, installEnv: 'INSTALL_MUSICGEN', venvDefault: '/v/mg', customModels: true },
    acestep: { id: 'acestep', name: 'ACE-Step', models: [{ id: 'a', name: 'A' }], defaultModelId: 'a', minDurationSec: 1, maxDurationSec: 240, defaultDurationSec: 60, installEnv: 'INSTALL_ACESTEP', venvDefault: '/v/ace', lyrics: true, customModels: false },
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

// Register-after-download gates on whether the repo landed in the cache.
const cache = vi.hoisted(() => ({ cached: true }));
vi.mock('../lib/hfCache.js', () => ({ inspectModelCache: vi.fn(async () => ({ cached: cache.cached })) }));

vi.mock('../services/albums/index.js', () => ({
  getAlbum: vi.fn(async () => null),
  updateAlbum: vi.fn(async (id, patch) => ({ id, ...patch })),
}));

import * as tracks from '../services/tracks/index.js';
import * as albums from '../services/albums/index.js';
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
    // mockReset clears queued *Once implementations too (clearAllMocks only
    // clears call history) — otherwise an unconsumed mockResolvedValueOnce on
    // generateMusic leaks into the next test.
    gen.generateMusic.mockReset();
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
    cache.cached = true;
    models.list.mockResolvedValue([{ id: 'm', name: 'M', userAdded: false }]);
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
  });

  it('POST /models rejects an engine that does not support custom models (acestep)', async () => {
    const r = await request(app).post('/api/music/models').send({ engine: 'acestep', repo: 'someorg/ace-variant' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('AUDIO_MODEL_ENGINE_FIXED');
    expect(models.add).not.toHaveBeenCalled();
    expect(sse.run).not.toHaveBeenCalled();
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
    expect(sse.run).toHaveBeenCalledWith(expect.objectContaining({ repo: 'facebook/musicgen-large' }));
    // Registered only AFTER the download landed in the cache.
    expect(models.add).toHaveBeenCalledWith({ engine: 'musicgen', repo: 'facebook/musicgen-large', name: undefined });
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

  it('POST /generate on a non-lyric engine does NOT write lyrics (no erasure)', async () => {
    tracks.getTrack.mockResolvedValueOnce({ id: 'track-1', title: 'Has Lyrics', lyrics: 'keep me' });
    gen.generateMusic.mockResolvedValueOnce({ filename: 'm.wav', durationSec: 12, engine: 'musicgen', modelId: 'm' });
    // MusicGen is not lyric-aware; even if the client sends lyrics:'' the update must omit lyrics.
    await request(app).post('/api/music/generate').send({ prompt: 'bed', lyrics: '', engine: 'musicgen', trackId: 'track-1' });
    const patch = tracks.updateTrack.mock.calls[0][1];
    expect(patch).not.toHaveProperty('lyrics');
  });

  it('POST /generate on a lyric engine with ABSENT lyrics leaves the track lyrics untouched', async () => {
    tracks.getTrack.mockResolvedValueOnce({ id: 'track-1', title: 'Song', lyrics: 'old words' });
    gen.generateMusic.mockResolvedValueOnce({ filename: 'm.wav', durationSec: 60, engine: 'acestep', modelId: 'a' });
    await request(app).post('/api/music/generate').send({ prompt: 'folk', engine: 'acestep', trackId: 'track-1' }); // no lyrics field
    const patch = tracks.updateTrack.mock.calls[0][1];
    expect(patch).not.toHaveProperty('lyrics');
    // The sidecar still renders (with empty lyrics) — engine.lyrics coalesces to ''.
    expect(gen.generateMusic).toHaveBeenCalledWith(expect.objectContaining({ lyrics: '' }));
  });

  it('POST /generate on a lyric engine with an EXPLICIT empty lyrics persists the clear', async () => {
    tracks.getTrack.mockResolvedValueOnce({ id: 'track-1', title: 'Song', lyrics: 'old words' });
    gen.generateMusic.mockResolvedValueOnce({ filename: 'm.wav', durationSec: 60, engine: 'acestep', modelId: 'a' });
    await request(app).post('/api/music/generate').send({ prompt: 'instrumental', lyrics: '', engine: 'acestep', trackId: 'track-1' });
    const patch = tracks.updateTrack.mock.calls[0][1];
    expect(patch.lyrics).toBe(''); // audio was rendered WITHOUT lyrics → persist the clear
  });

  it('POST /generate validates trackId BEFORE rendering (no wasted render)', async () => {
    tracks.getTrack.mockResolvedValueOnce(null);
    const r = await request(app).post('/api/music/generate').send({ prompt: 'x', trackId: 'gone' });
    expect(r.status).toBe(404);
    expect(gen.generateMusic).not.toHaveBeenCalled(); // render never started
  });

  it('POST /generate resolves a USER-INSTALLED model id to its repo for the sidecar', async () => {
    models.list.mockResolvedValueOnce([
      { id: 'm', name: 'M', userAdded: false },
      { id: 'someorg/big-musicgen', name: 'Big', repo: 'someorg/big-musicgen', userAdded: true },
    ]);
    gen.generateMusic.mockResolvedValueOnce({ filename: 'm.wav', durationSec: 12, engine: 'musicgen', modelId: 'someorg/big-musicgen' });
    await request(app).post('/api/music/generate').send({ prompt: 'x', engine: 'musicgen', modelId: 'someorg/big-musicgen' });
    expect(gen.generateMusic).toHaveBeenCalledWith(expect.objectContaining({ repo: 'someorg/big-musicgen', modelId: 'someorg/big-musicgen' }));
  });

  it('POST /generate rejects an unknown modelId BEFORE rendering', async () => {
    models.list.mockResolvedValueOnce([{ id: 'm', name: 'M', userAdded: false }]);
    const r = await request(app).post('/api/music/generate').send({ prompt: 'x', engine: 'musicgen', modelId: 'gone/removed' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('PIPELINE_MUSIC_UNKNOWN_MODEL');
    expect(gen.generateMusic).not.toHaveBeenCalled();
  });

  it('POST /generate creating a track with albumId appends it to the album tracklist', async () => {
    albums.getAlbum.mockResolvedValueOnce({ id: 'album-1', trackIds: ['track-0'] });
    tracks.createTrack.mockResolvedValueOnce({ id: 'track-gen', title: 'x', albumId: 'album-1' });
    gen.generateMusic.mockResolvedValueOnce({ filename: 'm.wav', durationSec: 12, engine: 'musicgen', modelId: 'm' });
    await request(app).post('/api/music/generate').send({ prompt: 'x', engine: 'musicgen', albumId: 'album-1' });
    expect(albums.updateAlbum).toHaveBeenCalledWith('album-1', { trackIds: ['track-0', 'track-gen'] });
  });

  it('POST /generate with an unknown trackId 404s and does not create', async () => {
    tracks.getTrack.mockResolvedValueOnce(null);
    gen.generateMusic.mockResolvedValueOnce({ filename: 'm.wav', durationSec: 10, engine: 'musicgen', modelId: 'm' });
    const r = await request(app).post('/api/music/generate').send({ prompt: 'x', trackId: 'track-missing' });
    expect(r.status).toBe(404);
    expect(tracks.updateTrack).not.toHaveBeenCalled();
    expect(tracks.createTrack).not.toHaveBeenCalled();
  });

  it('POST /generate rejects an unknown engine before rendering (no wrong-backend output)', async () => {
    const r = await request(app).post('/api/music/generate').send({ prompt: 'x', engine: 'acestep-v2' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('PIPELINE_MUSIC_UNKNOWN_ENGINE');
    expect(gen.generateMusic).not.toHaveBeenCalled();
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
