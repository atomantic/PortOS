import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/signalSync.js', () => ({ checkSetup: vi.fn(), getStatus: vi.fn(), runSync: vi.fn() }));

import * as signalSync from '../services/signalSync.js';
import signalRoutes from './signal.js';

const app = express();
app.use(express.json());
app.use('/api/signal', signalRoutes);
app.use(errorMiddleware);

beforeEach(() => vi.clearAllMocks());

describe('/api/signal', () => {
  it('runs one sync pass on POST /sync and returns its summary', async () => {
    signalSync.runSync.mockResolvedValue({ ok: true, imported: 3 });
    const res = await request(app).post('/api/signal/sync');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, imported: 3 });
    expect(signalSync.runSync).toHaveBeenCalledTimes(1);
  });

  it('returns a blocked setup report as data rather than an error', async () => {
    const report = { ok: false, error: 'Signal database key could not be read', code: 'KEY_UNAVAILABLE' };
    signalSync.checkSetup.mockResolvedValue(report);
    const res = await request(app).get('/api/signal/setup-check');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(report);
  });

  it('turns an unexpected sync failure into the standard error envelope', async () => {
    signalSync.runSync.mockRejectedValue(new Error('snapshot copy failed'));
    const res = await request(app).post('/api/signal/sync');
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: expect.any(String) });
  });

  it('reports status without opening the database', async () => {
    signalSync.getStatus.mockResolvedValue({ enabled: true, intervalMinutes: 15 });
    const res = await request(app).get('/api/signal/status');
    expect(res.body).toEqual({ enabled: true, intervalMinutes: 15 });
    expect(signalSync.checkSetup).not.toHaveBeenCalled();
    expect(signalSync.runSync).not.toHaveBeenCalled();
  });
});
