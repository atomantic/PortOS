import { afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Real ingest service over a temp data root: the day file is seeded and
// observed through the service, so the delete is proven to unlink it.
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-apple-health-days-') }));
afterAll(cleanupTempDataRoots);

const { default: appleHealthDaysRoutes } = await import('./appleHealthDays.js');
const { writeDayFile, readDayFile } = await import('../services/appleHealthIngest.js');

const app = express();
app.use('/api/apple-health', appleHealthDaysRoutes);
app.use(errorMiddleware);

const seed = (date) => writeDayFile(date, { date, metrics: { step_count: { data: [{ qty: 1 }] } } });

describe('DELETE /api/apple-health/days/:date', () => {
  it('rejects a non-date without unlinking any day', async () => {
    await seed('2026-04-01');
    const res = await request(app).delete('/api/apple-health/days/today');
    expect(res.status).toBe(400);
    expect((await readDayFile('2026-04-01')).metrics).toHaveProperty('step_count');
  });

  it('reports a missing day', async () => {
    const res = await request(app).delete('/api/apple-health/days/2026-04-02');
    expect(res.status).toBe(404);
  });

  it('removes the stored day and leaves other days intact', async () => {
    await seed('2026-04-03');
    await seed('2026-04-04');
    const res = await request(app).delete('/api/apple-health/days/2026-04-03');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ date: '2026-04-03' });
    expect((await readDayFile('2026-04-03')).metrics).toEqual({});
    expect((await readDayFile('2026-04-04')).metrics).toHaveProperty('step_count');
    expect((await request(app).delete('/api/apple-health/days/2026-04-03')).status).toBe(404);
  });
});
