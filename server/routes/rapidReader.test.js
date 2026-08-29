import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/rapidReader.js', () => ({
  getAccelerandoBook: vi.fn(),
}));

vi.mock('../services/rapidReaderLibrary.js', () => ({
  listRapidReaderLibrary: vi.fn(),
  getRapidReaderLibraryEntry: vi.fn(),
  createPastedRapidReaderEntry: vi.fn(),
  fetchRapidReaderEntry: vi.fn(),
  deleteRapidReaderLibraryEntry: vi.fn(),
}));

const routes = (await import('./rapidReader.js')).default;
const service = await import('../services/rapidReader.js');
const library = await import('../services/rapidReaderLibrary.js');

const BOOK = {
  id: 'accelerando',
  title: 'Accelerando',
  text: 'A novel by Charles Stross',
  wordCount: 5,
  cached: true,
};

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/rapid-reader', routes);
  app.use(errorMiddleware);
  return app;
}

beforeEach(() => vi.clearAllMocks());

describe('GET /api/rapid-reader/accelerando', () => {
  it('returns the book and prevents shared HTTP caching', async () => {
    service.getAccelerandoBook.mockResolvedValue(BOOK);

    const response = await request(makeApp()).get('/api/rapid-reader/accelerando');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toEqual(BOOK);
  });
});

const SHELF_META = {
  id: 'shelf-1', title: 'Saved Article', author: null, sourceUrl: 'https://example.com/a',
  sourceType: 'fetch', wordCount: 2, addedAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
};

describe('rapid reader shelf routes', () => {
  it('lists shelf metadata', async () => {
    library.listRapidReaderLibrary.mockResolvedValue([SHELF_META]);

    const response = await request(makeApp()).get('/api/rapid-reader/library');

    expect(response.status).toBe(200);
    expect(response.body).toEqual([SHELF_META]);
  });

  it('returns one entry with its text, and 404s an unknown id', async () => {
    library.getRapidReaderLibraryEntry.mockResolvedValueOnce({ ...SHELF_META, text: 'alpha bravo' });
    const found = await request(makeApp()).get('/api/rapid-reader/library/shelf-1');
    expect(found.status).toBe(200);
    expect(found.body.text).toBe('alpha bravo');
    expect(library.getRapidReaderLibraryEntry).toHaveBeenCalledWith('shelf-1');

    library.getRapidReaderLibraryEntry.mockRejectedValueOnce(Object.assign(new Error('Shelf entry not found'), { status: 404, code: 'NOT_FOUND' }));
    const missing = await request(makeApp()).get('/api/rapid-reader/library/nope');
    expect(missing.status).toBe(404);
  });

  it('creates a pasted entry and rejects an invalid body without calling the service', async () => {
    library.createPastedRapidReaderEntry.mockResolvedValue({ ...SHELF_META, id: 'shelf-2', sourceType: 'paste', text: 'alpha bravo' });

    const created = await request(makeApp()).post('/api/rapid-reader/library').send({ title: 'Notes', text: 'alpha bravo' });
    expect(created.status).toBe(201);
    expect(library.createPastedRapidReaderEntry).toHaveBeenCalledWith({ title: 'Notes', text: 'alpha bravo' });

    const invalid = await request(makeApp()).post('/api/rapid-reader/library').send({ title: '', text: '' });
    expect(invalid.status).toBe(400);
    expect(library.createPastedRapidReaderEntry).toHaveBeenCalledTimes(1);
  });

  it('routes /library/fetch to the importer rather than treating "fetch" as an id', async () => {
    library.fetchRapidReaderEntry.mockResolvedValue({ ...SHELF_META, text: 'alpha bravo' });

    const response = await request(makeApp()).post('/api/rapid-reader/library/fetch').send({ url: 'https://example.com/a' });

    expect(response.status).toBe(201);
    expect(library.fetchRapidReaderEntry).toHaveBeenCalledWith({ url: 'https://example.com/a' });
    expect(library.getRapidReaderLibraryEntry).not.toHaveBeenCalled();
  });

  it('rejects a non-http URL before fetching, and surfaces an unsafe target', async () => {
    const rejected = await request(makeApp()).post('/api/rapid-reader/library/fetch').send({ url: 'file:///etc/passwd' });
    expect(rejected.status).toBe(400);
    expect(library.fetchRapidReaderEntry).not.toHaveBeenCalled();

    library.fetchRapidReaderEntry.mockRejectedValueOnce(Object.assign(new Error('Refused to fetch a private address'), { status: 400, code: 'UNSAFE_URL' }));
    const unsafe = await request(makeApp()).post('/api/rapid-reader/library/fetch').send({ url: 'http://192.0.2.10/a' });
    expect(unsafe.status).toBe(400);
    expect(unsafe.body.code).toBe('UNSAFE_URL');
  });

  it('deletes one entry with no content', async () => {
    library.deleteRapidReaderLibraryEntry.mockResolvedValue(undefined);

    const response = await request(makeApp()).delete('/api/rapid-reader/library/shelf-1');

    expect(response.status).toBe(204);
    expect(library.deleteRapidReaderLibraryEntry).toHaveBeenCalledWith('shelf-1');
  });
});
