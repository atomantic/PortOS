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
  createAlbum: vi.fn(async (input) => ({ id: 'album-new', ...input })),
  updateAlbum: vi.fn(async (id, patch) => ({ id, ...patch })),
  deleteAlbum: vi.fn(async (id) => ({ id })),
}));

import * as albums from '../services/albums/index.js';
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
});
