import { afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Real dailyDriver service (and settings-backed timezone) over a temp data root.
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-daily-driver-routes-') }));
afterAll(cleanupTempDataRoots);

const { default: dailyDriverRoutes } = await import('./dailyDriver.js');

const app = express();
app.use(express.json());
app.use('/api/daily-driver', dailyDriverRoutes);
app.use(errorMiddleware);

describe('/api/daily-driver', () => {
  it('records the visit on read: first landing is first, the next read is not', async () => {
    const first = await request(app).get('/api/daily-driver');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ firstVisitToday: true, handledToday: false });

    const second = await request(app).get('/api/daily-driver');
    expect(second.body).toEqual({ ...first.body, firstVisitToday: false });
  });

  it('persists handled-today from POST /handled across later reads', async () => {
    const handled = await request(app).post('/api/daily-driver/handled');
    expect(handled.status).toBe(200);
    expect(handled.body.handledToday).toBe(true);
    expect((await request(app).get('/api/daily-driver')).body).toMatchObject({ handledToday: true, firstVisitToday: false });
  });
});
