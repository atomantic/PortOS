import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

vi.mock('../services/albums/index.js', () => ({
  TITLE_MAX: 200,
  ARTIST_ID_MAX: 80,
  ARTIST_NAME_MAX: 120,
  DESCRIPTION_MAX: 4000,
  GENRE_MAX: 120,
  COVER_IMAGE_URL_MAX: 1000,
  TRACK_IDS_MAX: 200,
  TRACK_ID_MAX: 80,
  RELEASE_YEAR_MIN: 1850,
  RELEASE_YEAR_MAX: 2200,
  ALBUM_ID_RE: /^album-/,
  listAlbums: vi.fn(async () => [{ id: 'album-1', title: 'Debut' }]),
  getAlbum: vi.fn(),
  createAlbum: vi.fn(async (input) => ({ id: 'album-new', trackIds: [], ...input })),
  updateAlbum: vi.fn(async (id, patch) => ({ id, trackIds: [], ...patch })),
  deleteAlbum: vi.fn(async (id) => ({ id })),
}));

vi.mock('../services/tracks/index.js', () => ({
  listTracks: vi.fn(async () => []),
  updateTrack: vi.fn(async (id, patch) => ({ id, ...patch })),
}));

import * as albums from '../services/albums/index.js';
import * as tracks from '../services/tracks/index.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import albumsRoutes from './albums.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/albums', albumsRoutes);
  app.use(errorMiddleware);
  return app;
}

describe('albums routes', () => {
  let app;
  beforeEach(() => { app = makeApp(); vi.clearAllMocks(); });

  it('GET / returns the album list', async () => {
    const r = await request(app).get('/api/albums');
    expect(r.status).toBe(200);
    expect(r.body).toEqual([{ id: 'album-1', title: 'Debut' }]);
  });

  // Regression guard: every client caller (AlbumsManager, TracksManager) calls
  // listAlbums() with no query params. If this ever returns an envelope instead
  // of a bare array, those lists silently render empty.
  it('GET / without pagination params returns the unbounded bare array', async () => {
    albums.listAlbums.mockResolvedValueOnce(
      Array.from({ length: 120 }, (_, i) => ({ id: `album-${i}`, title: `T${i}` }))
    );
    const r = await request(app).get('/api/albums');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body).toHaveLength(120);
  });

  it('GET / returns a bounded envelope when pagination is requested', async () => {
    albums.listAlbums.mockResolvedValueOnce(
      Array.from({ length: 5 }, (_, i) => ({ id: `album-${i}`, title: `T${i}` }))
    );
    const r = await request(app).get('/api/albums?limit=2&offset=1');
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(2);
    expect(r.body.items[0].id).toBe('album-1');
    expect(r.body.total).toBe(5);
    expect(r.body.limit).toBe(2);
    expect(r.body.offset).toBe(1);
  });

  it('POST / creates an album', async () => {
    const r = await request(app).post('/api/albums').send({ title: 'Debut', genre: 'folk' });
    expect(r.status).toBe(201);
    expect(albums.createAlbum).toHaveBeenCalledWith(expect.objectContaining({ title: 'Debut', genre: 'folk' }));
    expect(r.body.id).toBe('album-new');
  });

  it('POST / rejects a missing title', async () => {
    const r = await request(app).post('/api/albums').send({ genre: 'no title' });
    expect(r.status).toBe(400);
    expect(albums.createAlbum).not.toHaveBeenCalled();
  });

  it('POST / rejects a garbage release year', async () => {
    const r = await request(app).post('/api/albums').send({ title: 'X', releaseYear: 99999 });
    expect(r.status).toBe(400);
  });

  it('GET /:id 404s when absent; returns the album when found', async () => {
    albums.getAlbum.mockResolvedValueOnce(null);
    expect((await request(app).get('/api/albums/album-x')).status).toBe(404);
    albums.getAlbum.mockResolvedValueOnce({ id: 'album-1', title: 'Debut' });
    const r = await request(app).get('/api/albums/album-1');
    expect(r.status).toBe(200);
    expect(r.body.title).toBe('Debut');
  });

  it('PATCH /:id rejects an empty patch; updates otherwise', async () => {
    expect((await request(app).patch('/api/albums/album-1').send({})).status).toBe(400);
    const r = await request(app).patch('/api/albums/album-1').send({ trackIds: ['track-2', 'track-1'] });
    expect(r.status).toBe(200);
    expect(albums.updateAlbum).toHaveBeenCalledWith('album-1', { trackIds: ['track-2', 'track-1'] });
  });

  it('DELETE /:id soft-deletes an album', async () => {
    const r = await request(app).delete('/api/albums/album-1');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: 'album-1' });
  });

  it('PATCH /:id with trackIds reconciles track.albumId (stamp added, clear removed)', async () => {
    // The album will list track-1 + track-2; track-3 used to belong here and
    // must be cleared, track-1 already points here (no-op), track-2 is added.
    tracks.listTracks.mockResolvedValueOnce([
      { id: 'track-1', albumId: 'album-1' },
      { id: 'track-2', albumId: '' },
      { id: 'track-3', albumId: 'album-1' },
    ]);
    const r = await request(app).patch('/api/albums/album-1').send({ trackIds: ['track-1', 'track-2'] });
    expect(r.status).toBe(200);
    expect(tracks.updateTrack).toHaveBeenCalledWith('track-3', { albumId: '' });
    expect(tracks.updateTrack).toHaveBeenCalledWith('track-2', { albumId: 'album-1' });
    expect(tracks.updateTrack).not.toHaveBeenCalledWith('track-1', expect.anything());
  });

  it('PATCH /:id WITHOUT trackIds does not reconcile membership', async () => {
    await request(app).patch('/api/albums/album-1').send({ genre: 'jazz' });
    expect(tracks.listTracks).not.toHaveBeenCalled();
  });

  it('PATCH /:id stealing a track from another album drops it from that album\'s tracklist', async () => {
    // track-7 currently belongs to album-2; adding it to album-1 must remove it
    // from album-2's ordered trackIds (not just flip its albumId).
    tracks.listTracks.mockResolvedValueOnce([{ id: 'track-7', albumId: 'album-2' }]);
    albums.getAlbum.mockResolvedValueOnce({ id: 'album-2', trackIds: ['track-7', 'track-8'] });
    const r = await request(app).patch('/api/albums/album-1').send({ trackIds: ['track-7'] });
    expect(r.status).toBe(200);
    expect(tracks.updateTrack).toHaveBeenCalledWith('track-7', { albumId: 'album-1' });
    expect(albums.updateAlbum).toHaveBeenCalledWith('album-2', { trackIds: ['track-8'] });
  });

  it('DELETE /:id orphans the album\'s tracks (clears their albumId)', async () => {
    tracks.listTracks.mockResolvedValueOnce([{ id: 'track-9', albumId: 'album-1' }]);
    await request(app).delete('/api/albums/album-1');
    expect(tracks.updateTrack).toHaveBeenCalledWith('track-9', { albumId: '' });
  });
});
