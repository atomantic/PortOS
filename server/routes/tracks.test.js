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
  buildRenderAppend: vi.fn((track, input) => {
    const render = { id: 'render-x', ...input };
    return { render, renders: [...(track?.renders || []), render] };
  }),
  selectRenderPatch: vi.fn((track, renderId) => {
    const r = (track.renders || []).find((x) => x.id === renderId);
    return r ? { audioFilename: r.audioFilename, engine: r.engine, modelId: r.modelId, durationSec: r.durationSec } : null;
  }),
  deleteRenderPatch: vi.fn((track, renderId) => {
    const renders = track.renders || [];
    if (!renders.some((x) => x.id === renderId)) return null;
    return { renders: renders.filter((x) => x.id !== renderId) };
  }),
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
vi.mock('../services/albums/index.js', () => ({
  getAlbum: vi.fn(async () => null),
  updateAlbum: vi.fn(async (id, patch) => ({ id, ...patch })),
}));
vi.mock('../services/trackYoutubeImport.js', () => ({
  YOUTUBE_URL_RE: /^https?:\/\/(www\.|m\.)?(youtube\.com\/watch\?[^\s#]*\bv=[\w-]{6,}|youtu\.be\/[\w-]{6,})/i,
  startYoutubeImport: vi.fn(async () => ({ jobId: 'job-1' })),
  attachImportSseClient: vi.fn(() => true),
  cancelYoutubeImport: vi.fn(() => true),
}));

import * as musicLibrary from '../services/pipeline/musicLibrary.js';
import * as albums from '../services/albums/index.js';
import * as ytImport from '../services/trackYoutubeImport.js';
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

  describe('YouTube import (#1945)', () => {
    it('POST /import/youtube starts a job for a valid URL', async () => {
      const r = await request(app).post('/api/tracks/import/youtube').send({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
      expect(r.status).toBe(202);
      expect(r.body).toEqual({ jobId: 'job-1' });
      expect(ytImport.startYoutubeImport).toHaveBeenCalledWith('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    });

    it('POST /import/youtube accepts a youtu.be short link', async () => {
      const r = await request(app).post('/api/tracks/import/youtube').send({ url: 'https://youtu.be/dQw4w9WgXcQ' });
      expect(r.status).toBe(202);
    });

    it('POST /import/youtube rejects a non-YouTube URL (never reaches the service)', async () => {
      const r = await request(app).post('/api/tracks/import/youtube').send({ url: 'https://vimeo.com/12345' });
      expect(r.status).toBe(400);
      expect(ytImport.startYoutubeImport).not.toHaveBeenCalled();
    });

    it('GET /import/:jobId/events 404s when the job is unknown', async () => {
      ytImport.attachImportSseClient.mockReturnValueOnce(false);
      const r = await request(app).get('/api/tracks/import/missing/events');
      expect(r.status).toBe(404);
    });

    it('POST /import/:jobId/cancel proxies to the service', async () => {
      const r = await request(app).post('/api/tracks/import/job-1/cancel');
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true });
      expect(ytImport.cancelYoutubeImport).toHaveBeenCalledWith('job-1');
    });
  });

  it('POST / creates a track', async () => {
    const r = await request(app).post('/api/tracks').send({ title: 'Intro', engine: 'acestep' });
    expect(r.status).toBe(201);
    expect(tracks.createTrack).toHaveBeenCalledWith(expect.objectContaining({ title: 'Intro', engine: 'acestep' }));
    expect(r.body.id).toBe('track-new');
  });

  it('POST / rejects a path-ish audioFilename (same guard as /audio/attach)', async () => {
    const r = await request(app).post('/api/tracks').send({ title: 'Intro', audioFilename: '../escape.mp3' });
    expect(r.status).toBe(400);
    expect(tracks.createTrack).not.toHaveBeenCalled();
  });

  it('POST / accepts an empty audioFilename (clears the pointer)', async () => {
    const r = await request(app).post('/api/tracks').send({ title: 'Intro', audioFilename: '' });
    expect(r.status).toBe(201);
  });

  it('POST / with albumId appends the track to the album tracklist', async () => {
    albums.getAlbum.mockResolvedValueOnce({ id: 'album-1', trackIds: ['track-0'] });
    tracks.createTrack.mockResolvedValueOnce({ id: 'track-new', title: 'Intro', albumId: 'album-1' });
    const r = await request(app).post('/api/tracks').send({ title: 'Intro', albumId: 'album-1' });
    expect(r.status).toBe(201);
    expect(albums.updateAlbum).toHaveBeenCalledWith('album-1', { trackIds: ['track-0', 'track-new'] });
  });

  it('PATCH /:id moving albums drops from the old tracklist and appends to the new', async () => {
    tracks.getTrack.mockResolvedValueOnce({ id: 'track-1', title: 'Intro', albumId: 'album-old' });
    tracks.updateTrack.mockResolvedValueOnce({ id: 'track-1', title: 'Intro', albumId: 'album-new' });
    albums.getAlbum.mockImplementation(async (id) => (
      id === 'album-old' ? { id, trackIds: ['track-1'] } : { id, trackIds: [] }
    ));
    const r = await request(app).patch('/api/tracks/track-1').send({ albumId: 'album-new' });
    expect(r.status).toBe(200);
    expect(albums.updateAlbum).toHaveBeenCalledWith('album-old', { trackIds: [] });
    expect(albums.updateAlbum).toHaveBeenCalledWith('album-new', { trackIds: ['track-1'] });
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

  it('POST /:id/audio/attach attaches an existing library track and records it as a render', async () => {
    tracks.getTrack.mockResolvedValue({ id: 'track-1', title: 'Intro' });
    lib.store.set('music-1.mp3', true);
    const r = await request(app).post('/api/tracks/track-1/audio/attach').send({ filename: 'music-1.mp3' });
    expect(r.status).toBe(200);
    expect(tracks.updateTrack).toHaveBeenCalledWith('track-1', expect.objectContaining({
      audioFilename: 'music-1.mp3',
      engine: '',
      renders: expect.arrayContaining([expect.objectContaining({ audioFilename: 'music-1.mp3' })]),
    }));
  });

  it('POST /:id/audio/attach re-selects (no duplicate card) when the file is already in the history', async () => {
    tracks.getTrack.mockResolvedValue({
      id: 'track-1', title: 'Intro', audioFilename: 'other.mp3',
      renders: [{ id: 'render-1', audioFilename: 'music-1.mp3', engine: 'musicgen', modelId: 'm', durationSec: 5 }],
    });
    lib.store.set('music-1.mp3', true);
    const r = await request(app).post('/api/tracks/track-1/audio/attach').send({ filename: 'music-1.mp3' });
    expect(r.status).toBe(200);
    // Re-select path: no `renders` key in the patch (the take already exists).
    expect(tracks.updateTrack).toHaveBeenCalledWith('track-1', { audioFilename: 'music-1.mp3', engine: 'musicgen', modelId: 'm', durationSec: 5 });
  });

  it('POST /:id/audio/attach appends onto the FRESHEST track state (re-reads before write)', async () => {
    // A render added to this track between the route's initial load and the write
    // (e.g. a long generation finishing) must not be dropped — the append must
    // build on the re-read track, not the snapshot from requireTrack.
    const stale = { id: 'track-1', title: 'S', renders: [{ id: 'r-old', audioFilename: 'old.mp3' }] };
    const fresh = { id: 'track-1', title: 'S', renders: [{ id: 'r-old', audioFilename: 'old.mp3' }, { id: 'r-concurrent', audioFilename: 'concurrent.mp3' }] };
    tracks.getTrack.mockResolvedValueOnce(stale).mockResolvedValueOnce(fresh);
    lib.store.set('music-1.mp3', true);
    const r = await request(app).post('/api/tracks/track-1/audio/attach').send({ filename: 'music-1.mp3' });
    expect(r.status).toBe(200);
    expect(tracks.buildRenderAppend).toHaveBeenCalledWith(fresh, expect.objectContaining({ audioFilename: 'music-1.mp3' }));
  });

  it('DELETE /:id/audio clears the pointer', async () => {
    tracks.getTrack.mockResolvedValue({ id: 'track-1', title: 'Intro' });
    const r = await request(app).delete('/api/tracks/track-1/audio');
    expect(r.status).toBe(200);
    expect(tracks.updateTrack).toHaveBeenCalledWith('track-1', { audioFilename: '' });
  });

  it('POST /:id/renders/:renderId/select makes a past render active', async () => {
    tracks.getTrack.mockResolvedValue({
      id: 'track-1', title: 'Intro', audioFilename: 'b.wav',
      renders: [{ id: 'render-a', audioFilename: 'a.wav', engine: 'musicgen', modelId: 'm1', durationSec: 10 }],
    });
    const r = await request(app).post('/api/tracks/track-1/renders/render-a/select');
    expect(r.status).toBe(200);
    expect(tracks.updateTrack).toHaveBeenCalledWith('track-1', { audioFilename: 'a.wav', engine: 'musicgen', modelId: 'm1', durationSec: 10 });
  });

  it('POST /:id/renders/:renderId/select 404s for an unknown render', async () => {
    tracks.getTrack.mockResolvedValue({ id: 'track-1', title: 'Intro', renders: [] });
    const r = await request(app).post('/api/tracks/track-1/renders/missing/select');
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('TRACK_RENDER_NOT_FOUND');
  });

  it('DELETE /:id/renders/:renderId removes a render', async () => {
    tracks.getTrack.mockResolvedValue({
      id: 'track-1', title: 'Intro', audioFilename: 'a.wav',
      renders: [{ id: 'render-a', audioFilename: 'a.wav' }, { id: 'render-b', audioFilename: 'b.wav' }],
    });
    const r = await request(app).delete('/api/tracks/track-1/renders/render-a');
    expect(r.status).toBe(200);
    expect(tracks.updateTrack).toHaveBeenCalledWith('track-1', { renders: [{ id: 'render-b', audioFilename: 'b.wav' }] });
  });

  it('DELETE /:id/renders/:renderId 404s for an unknown render', async () => {
    tracks.getTrack.mockResolvedValue({ id: 'track-1', title: 'Intro', renders: [] });
    const r = await request(app).delete('/api/tracks/track-1/renders/missing');
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('TRACK_RENDER_NOT_FOUND');
  });
});
