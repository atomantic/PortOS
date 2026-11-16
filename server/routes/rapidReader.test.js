import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Real shelf service (one JSON record per entry) over a temp data root. Doubled: the Accelerando
// book (a network download) and the SSRF-guarded page fetch, the shelf's only external boundaries.
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-rapid-reader-') }));
vi.mock('../lib/safeUrlFetch.js', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchPublicText: vi.fn(),
}));
vi.mock('../services/rapidReader.js', () => ({
  getAccelerandoBook: vi.fn(),
}));
afterAll(cleanupTempDataRoots);

const routes = (await import('./rapidReader.js')).default;
const service = await import('../services/rapidReader.js');
const { fetchPublicText } = await import('../lib/safeUrlFetch.js');

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

const app = makeApp();
const SHELF = '/api/rapid-reader/library';
const shelfIds = async () => (await request(app).get(SHELF)).body.map((e) => e.id);

describe('rapid reader shelf routes', () => {
  it('persists a pasted entry so it lists without its text and reads back with it', async () => {
    const created = await request(app).post(SHELF).send({ title: 'Notes', text: 'alpha bravo' });
    expect(created.status).toBe(201);
    const { id } = created.body;
    expect(created.body).toMatchObject({ title: 'Notes', sourceType: 'paste', wordCount: 2 });

    const listed = (await request(app).get(SHELF)).body.find((e) => e.id === id);
    expect(listed).toMatchObject({ title: 'Notes', sourceType: 'paste' });
    expect(listed).not.toHaveProperty('text');

    const one = await request(app).get(`${SHELF}/${id}`);
    expect(one.status).toBe(200);
    expect(one.body.text).toBe('alpha bravo');
  });

  it('404s an unknown id', async () => {
    expect((await request(app).get(`${SHELF}/nope`)).status).toBe(404);
  });

  it('rejects an invalid body without persisting anything', async () => {
    const before = await shelfIds();
    expect((await request(app).post(SHELF).send({ title: '', text: '' })).status).toBe(400);
    expect(await shelfIds()).toEqual(before);
  });

  it('routes /library/fetch to the importer, storing the page text under the page title', async () => {
    fetchPublicText.mockResolvedValue('<html><head><title>Saved Article</title></head><body><p>alpha bravo</p></body></html>');

    const response = await request(app).post(`${SHELF}/fetch`).send({ url: 'https://example.com/a' });

    expect(response.status).toBe(201);
    expect(fetchPublicText).toHaveBeenCalledWith('https://example.com/a', expect.objectContaining({ blockPrivate: true }));
    expect(response.body).toMatchObject({ title: 'Saved Article', sourceType: 'fetch', sourceUrl: 'https://example.com/a' });
    expect((await request(app).get(`${SHELF}/${response.body.id}`)).body.text).toContain('alpha bravo');
  });

  it('rejects a non-http URL before fetching, and stores nothing for an unsafe target', async () => {
    const before = await shelfIds();
    expect((await request(app).post(`${SHELF}/fetch`).send({ url: 'file:///etc/passwd' })).status).toBe(400);
    expect(fetchPublicText).not.toHaveBeenCalled();

    fetchPublicText.mockRejectedValueOnce(Object.assign(new Error('Refused to fetch a private address'), { status: 400, code: 'UNSAFE_URL' }));
    const unsafe = await request(app).post(`${SHELF}/fetch`).send({ url: 'http://192.0.2.10/a' });
    expect(unsafe.status).toBe(400);
    expect(unsafe.body.code).toBe('UNSAFE_URL');
    expect(await shelfIds()).toEqual(before);
  });

  it('deletes one entry with no content, after which it is gone', async () => {
    const { id } = (await request(app).post(SHELF).send({ title: 'Doomed', text: 'x y z' })).body;

    expect((await request(app).delete(`${SHELF}/${id}`)).status).toBe(204);

    expect((await request(app).get(`${SHELF}/${id}`)).status).toBe(404);
    expect(await shelfIds()).not.toContain(id);
  });
});
