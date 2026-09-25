import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const listIngests = vi.fn();

vi.mock('../services/youtubeIngest.js', () => ({ listIngests }));

const { default: routes } = await import('./brainYoutube.js');

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/brain/youtube', routes);
  app.use(errorMiddleware);
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/brain/youtube/ingests', () => {
  it('returns the legacy full-history array for a query-less request', async () => {
    listIngests.mockResolvedValue([{ videoId: 'v1' }, { videoId: 'v2' }]);

    const response = await request(makeApp()).get('/api/brain/youtube/ingests');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ingests: [{ videoId: 'v1' }, { videoId: 'v2' }] });
    expect(listIngests).toHaveBeenCalledWith();
  });

  it('opts into a bounded page when limit is passed, defaulting cursor to undefined', async () => {
    listIngests.mockResolvedValue({ items: [{ videoId: 'v1' }], nextCursor: 'opaque-token' });

    const response = await request(makeApp()).get('/api/brain/youtube/ingests?limit=1');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ingests: [{ videoId: 'v1' }], nextCursor: 'opaque-token' });
    expect(listIngests).toHaveBeenCalledWith({ limit: 1, cursor: undefined });
  });

  it('omits nextCursor once no more records remain', async () => {
    listIngests.mockResolvedValue({ items: [{ videoId: 'v1' }], nextCursor: null });

    const response = await request(makeApp()).get('/api/brain/youtube/ingests?limit=50');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ingests: [{ videoId: 'v1' }] });
    expect(response.body.nextCursor).toBeUndefined();
  });

  it('forwards a cursor and defaults the limit to 50 when only cursor is given', async () => {
    listIngests.mockResolvedValue({ items: [], nextCursor: null });

    const response = await request(makeApp()).get('/api/brain/youtube/ingests?cursor=opaque-token');

    expect(response.status).toBe(200);
    expect(listIngests).toHaveBeenCalledWith({ limit: 50, cursor: 'opaque-token' });
  });

  it('rejects a limit above the cap before the service is called', async () => {
    const response = await request(makeApp()).get('/api/brain/youtube/ingests?limit=101');

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(listIngests).not.toHaveBeenCalled();
  });

  it('propagates an INVALID_CURSOR error from the service as a 400', async () => {
    listIngests.mockRejectedValue(Object.assign(new Error('Invalid ingest cursor'), { status: 400, code: 'INVALID_CURSOR' }));

    const response = await request(makeApp()).get('/api/brain/youtube/ingests?limit=10&cursor=garbage');

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_CURSOR');
  });
});
