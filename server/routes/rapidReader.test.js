import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/rapidReader.js', () => ({
  getAccelerandoBook: vi.fn(),
}));

const routes = (await import('./rapidReader.js')).default;
const service = await import('../services/rapidReader.js');

const BOOK = {
  id: 'accelerando',
  title: 'Accelerando',
  text: 'A novel by Charles Stross',
  wordCount: 5,
  cached: true,
};

function makeApp() {
  const app = express();
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
