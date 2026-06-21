import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

vi.mock('../services/tracks/index.js', () => ({
  TITLE_MAX: 200,
  ALBUM_ID_MAX: 80,
  ARTIST_ID_MAX: 80,
  ARTIST_NAME_MAX: 120,
  LYRICS_MAX: 20000,
  PROMPT_MAX: 8000,
  ENGINE_MAX: 60,
  MODEL_ID_MAX: 120,
  AUDIO_FILENAME_MAX: 256,
  DURATION_MIN_SEC: 1,
  DURATION_MAX_SEC: 3600,
  TRACK_ID_RE: /^track-/,
  listTracks: vi.fn(async () => [{ id: 'track-1', title: 'Intro' }]),
  getTrack: vi.fn(),
  createTrack: vi.fn(async (input) => ({ id: 'track-new', ...input })),
  updateTrack: vi.fn(async (id, patch) => ({ id, ...patch })),
  deleteTrack: vi.fn(async (id) => ({ id })),
}));

const lib = vi.hoisted(() => ({
  store: new Map(),
}));
vi.mock('../services/pipeline/musicLibrary.js', () => ({
  MUSIC_UPLOAD_MAX_BYTES: 50 * 1024 * 1024,
  isSupportedMusicUpload: () => true,
  assertSafeMusicFilename: (f) => { if (f.includes('..') || f.includes('/')) throw Object.assign(new Error('bad'), { status: 400, code: 'X' }); },
  listMusicLibrary: vi.fn(async () => [{ filename: 'music-1.mp3', label: 'theme', sizeBytes: 10, updatedAt: '2026-05-15T00:00:00.000Z' }]),
  importUploadedTrack: vi.fn(async () => ({ filename: 'music-up.mp3', sizeBytes: 11 })),
  statMusicTrack: vi.fn(async (f) => (lib.store.has(f) ? { filename: f, label: f, sizeBytes: 10 } : null)),
}));

import * as tracks from '../services/tracks/index.js';
import * as musicLibrary from '../services/pipeline/musicLibrary.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import tracksRoutes from './tracks.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/tracks', tracksRoutes);
  app.use(errorMiddleware);
  return app;
}

describe('tracks routes', () => {
  let app;
  beforeEach(() => { app = makeApp(); vi.clearAllMocks(); lib.store.clear(); });

  it('GET / returns the track list', async () => {
    const r = await request(app).get('/api/tracks');
    expect(r.status).toBe(200);
    expect(r.body).toEqual([{ id: 'track-1', title: 'Intro' }]);
  });

  it('GET /library returns the shared music library (not read as an id)', async () => {
    const r = await request(app).get('/api/tracks/library');
    expect(r.status).toBe(200);
    expect(r.body.tracks[0].filename).toBe('music-1.mp3');
    expect(tracks.getTrack).not.toHaveBeenCalled();
  });

  it('POST / creates a track', async () => {
    const r = await request(app).post('/api/tracks').send({ title: 'Intro', engine: 'acestep' });
    expect(r.status).toBe(201);
    expect(tracks.createTrack).toHaveBeenCalledWith(expect.objectContaining({ title: 'Intro', engine: 'acestep' }));
    expect(r.body.id).toBe('track-new');
  });

  it('POST / rejects a missing title', async () => {
    expect((await request(app).post('/api/tracks').send({ engine: 'x' })).status).toBe(400);
    expect(tracks.createTrack).not.toHaveBeenCalled();
  });

  it('PATCH /:id rejects an empty patch; updates otherwise', async () => {
    tracks.getTrack.mockResolvedValue({ id: 'track-1', title: 'Intro' });
    expect((await request(app).patch('/api/tracks/track-1').send({})).status).toBe(400);
    const r = await request(app).patch('/api/tracks/track-1').send({ prompt: 'warm folk' });
    expect(r.status).toBe(200);
    expect(tracks.updateTrack).toHaveBeenCalledWith('track-1', { prompt: 'warm folk' });
  });

  it('DELETE /:id soft-deletes a track', async () => {
    tracks.getTrack.mockResolvedValue({ id: 'track-1', title: 'Intro' });
    const r = await request(app).delete('/api/tracks/track-1');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: 'track-1' });
  });

  it('POST /:id/audio/attach 404s when the track is missing', async () => {
    tracks.getTrack.mockResolvedValueOnce(null);
    const r = await request(app).post('/api/tracks/track-x/audio/attach').send({ filename: 'music-1.mp3' });
    expect(r.status).toBe(404);
  });

  it('POST /:id/audio/attach 404s when the file is not in the library', async () => {
    tracks.getTrack.mockResolvedValue({ id: 'track-1', title: 'Intro' });
    const r = await request(app).post('/api/tracks/track-1/audio/attach').send({ filename: 'missing.mp3' });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('TRACK_AUDIO_NOT_IN_LIBRARY');
  });

  it('POST /:id/audio/attach attaches an existing library track', async () => {
    tracks.getTrack.mockResolvedValue({ id: 'track-1', title: 'Intro' });
    lib.store.set('music-1.mp3', true);
    const r = await request(app).post('/api/tracks/track-1/audio/attach').send({ filename: 'music-1.mp3' });
    expect(r.status).toBe(200);
    expect(tracks.updateTrack).toHaveBeenCalledWith('track-1', { audioFilename: 'music-1.mp3' });
  });

  it('DELETE /:id/audio clears the pointer', async () => {
    tracks.getTrack.mockResolvedValue({ id: 'track-1', title: 'Intro' });
    const r = await request(app).delete('/api/tracks/track-1/audio');
    expect(r.status).toBe(200);
    expect(tracks.updateTrack).toHaveBeenCalledWith('track-1', { audioFilename: '' });
  });
});
