import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

vi.mock('../services/artists/index.js', () => ({
  NAME_MAX: 120,
  GENRE_MAX: 120,
  BIO_MAX: 4000,
  MUSICAL_STYLE_MAX: 4000,
  PHYSICAL_DESCRIPTION_MAX: 2000,
  PORTRAIT_STYLE_MAX: 2000,
  PORTRAIT_IMAGE_URL_MAX: 1000,
  ARTIST_ID_RE: /^artist-/,
  listArtists: vi.fn(async () => [{ id: 'artist-1', name: 'Nova' }]),
  getArtist: vi.fn(),
  createArtist: vi.fn(async (input) => ({ id: 'artist-new', ...input })),
  updateArtist: vi.fn(async (id, patch) => ({ id, ...patch })),
  deleteArtist: vi.fn(async (id) => ({ id })),
}));

import * as artists from '../services/artists/index.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import artistsRoutes from './artists.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/artists', artistsRoutes);
  app.use(errorMiddleware);
  return app;
}

describe('artists routes', () => {
  let app;
  beforeEach(() => {
    app = makeApp();
    vi.clearAllMocks();
  });

  it('GET / returns the artist list', async () => {
    const r = await request(app).get('/api/artists');
    expect(r.status).toBe(200);
    expect(r.body).toEqual([{ id: 'artist-1', name: 'Nova' }]);
  });

  // Regression guard: every client caller (ArtistsManager, ArtistPicker) calls
  // listArtists() with no query params. If this ever returns an envelope instead
  // of a bare array, those lists silently render empty.
  it('GET / without pagination params returns the unbounded bare array', async () => {
    artists.listArtists.mockResolvedValueOnce(
      Array.from({ length: 120 }, (_, i) => ({ id: `artist-${i}`, name: `N${i}` }))
    );
    const r = await request(app).get('/api/artists');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body).toHaveLength(120);
  });

  it('GET / returns a bounded envelope when pagination is requested', async () => {
    artists.listArtists.mockResolvedValueOnce(
      Array.from({ length: 5 }, (_, i) => ({ id: `artist-${i}`, name: `N${i}` }))
    );
    const r = await request(app).get('/api/artists?limit=2&offset=1');
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(2);
    expect(r.body.items[0].id).toBe('artist-1');
    expect(r.body.total).toBe(5);
    expect(r.body.limit).toBe(2);
    expect(r.body.offset).toBe(1);
  });

  it('POST / creates an artist', async () => {
    const r = await request(app).post('/api/artists').send({ name: 'Nova', genre: 'indie folk' });
    expect(r.status).toBe(201);
    expect(artists.createArtist).toHaveBeenCalledWith(expect.objectContaining({ name: 'Nova', genre: 'indie folk' }));
    expect(r.body.id).toBe('artist-new');
  });

  it('POST / rejects a missing name', async () => {
    const r = await request(app).post('/api/artists').send({ genre: 'no name' });
    expect(r.status).toBe(400);
    expect(artists.createArtist).not.toHaveBeenCalled();
  });

  it('GET /:id returns 404 when absent', async () => {
    artists.getArtist.mockResolvedValueOnce(null);
    const r = await request(app).get('/api/artists/artist-missing');
    expect(r.status).toBe(404);
  });

  it('GET /:id returns the artist when found', async () => {
    artists.getArtist.mockResolvedValueOnce({ id: 'artist-1', name: 'Nova' });
    const r = await request(app).get('/api/artists/artist-1');
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('Nova');
  });

  it('PATCH /:id rejects an empty patch', async () => {
    const r = await request(app).patch('/api/artists/artist-1').send({});
    expect(r.status).toBe(400);
    expect(artists.updateArtist).not.toHaveBeenCalled();
  });

  it('PATCH /:id updates an artist', async () => {
    const r = await request(app).patch('/api/artists/artist-1').send({ name: 'Nova Star' });
    expect(r.status).toBe(200);
    expect(artists.updateArtist).toHaveBeenCalledWith('artist-1', { name: 'Nova Star' });
  });

  it('DELETE /:id soft-deletes an artist', async () => {
    const r = await request(app).delete('/api/artists/artist-1');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: 'artist-1' });
  });
});
