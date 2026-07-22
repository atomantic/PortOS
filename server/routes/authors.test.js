import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

vi.mock('../services/authors/index.js', () => ({
  NAME_MAX: 120,
  WRITING_STYLE_MAX: 4000,
  BIO_MAX: 4000,
  PHYSICAL_DESCRIPTION_MAX: 2000,
  HEADSHOT_STYLE_MAX: 2000,
  HEADSHOT_IMAGE_URL_MAX: 1000,
  AUTHOR_ID_RE: /^auth-/,
  listAuthors: vi.fn(async () => [{ id: 'auth-1', name: 'Jane' }]),
  getAuthor: vi.fn(),
  createAuthor: vi.fn(async (input) => ({ id: 'auth-new', ...input })),
  updateAuthor: vi.fn(async (id, patch) => ({ id, ...patch })),
  deleteAuthor: vi.fn(async (id) => ({ id })),
}));

import * as authors from '../services/authors/index.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import authorsRoutes from './authors.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/authors', authorsRoutes);
  app.use(errorMiddleware);
  return app;
}

describe('authors routes', () => {
  let app;
  beforeEach(() => {
    app = makeApp();
    vi.clearAllMocks();
  });

  it('GET / returns the author list', async () => {
    const r = await request(app).get('/api/authors');
    expect(r.status).toBe(200);
    expect(r.body).toEqual([{ id: 'auth-1', name: 'Jane' }]);
  });

  it('GET / returns a bounded envelope when pagination is requested', async () => {
    authors.listAuthors.mockResolvedValueOnce(
      Array.from({ length: 5 }, (_, i) => ({ id: `auth-${i}`, name: `A${i}` }))
    );
    const r = await request(app).get('/api/authors?limit=2&offset=1');
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(2);
    expect(r.body.items[0].id).toBe('auth-1');
    expect(r.body.total).toBe(5);
    expect(r.body.limit).toBe(2);
    expect(r.body.offset).toBe(1);
  });

  it('POST / creates an author', async () => {
    const r = await request(app).post('/api/authors').send({ name: 'Jane', bio: 'blurb' });
    expect(r.status).toBe(201);
    expect(authors.createAuthor).toHaveBeenCalledWith(expect.objectContaining({ name: 'Jane', bio: 'blurb' }));
    expect(r.body.id).toBe('auth-new');
  });

  it('POST / rejects a missing name', async () => {
    const r = await request(app).post('/api/authors').send({ bio: 'no name' });
    expect(r.status).toBe(400);
    expect(authors.createAuthor).not.toHaveBeenCalled();
  });

  it('GET /:id returns 404 when absent', async () => {
    authors.getAuthor.mockResolvedValueOnce(null);
    const r = await request(app).get('/api/authors/auth-missing');
    expect(r.status).toBe(404);
  });

  it('GET /:id returns the author when found', async () => {
    authors.getAuthor.mockResolvedValueOnce({ id: 'auth-1', name: 'Jane' });
    const r = await request(app).get('/api/authors/auth-1');
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('Jane');
  });

  it('PATCH /:id rejects an empty patch', async () => {
    const r = await request(app).patch('/api/authors/auth-1').send({});
    expect(r.status).toBe(400);
    expect(authors.updateAuthor).not.toHaveBeenCalled();
  });

  it('PATCH /:id updates an author', async () => {
    const r = await request(app).patch('/api/authors/auth-1').send({ name: 'Janet' });
    expect(r.status).toBe(200);
    expect(authors.updateAuthor).toHaveBeenCalledWith('auth-1', { name: 'Janet' });
  });

  it('DELETE /:id soft-deletes an author', async () => {
    const r = await request(app).delete('/api/authors/auth-1');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: 'auth-1' });
  });
});
