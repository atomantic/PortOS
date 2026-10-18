import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/dailyDriver.js', () => ({
  getAndRecordVisit: vi.fn(), getDriverState: vi.fn(), markDriverHandled: vi.fn(),
}));

import * as dailyDriver from '../services/dailyDriver.js';
import dailyDriverRoutes from './dailyDriver.js';

const app = express();
app.use(express.json());
app.use('/api/daily-driver', dailyDriverRoutes);
app.use(errorMiddleware);

beforeEach(() => vi.clearAllMocks());

describe('/api/daily-driver', () => {
  it('records the visit on read, so the next read of the day is no longer the first', async () => {
    dailyDriver.getAndRecordVisit.mockResolvedValue({ today: '2026-01-02', firstVisitToday: true, handledToday: false });
    const res = await request(app).get('/api/daily-driver');
    expect(res.body).toEqual({ today: '2026-01-02', firstVisitToday: true, handledToday: false });
    expect(dailyDriver.getAndRecordVisit).toHaveBeenCalledTimes(1);
    expect(dailyDriver.getDriverState).not.toHaveBeenCalled();
  });

  it('marks the day handled on POST /handled and surfaces a store failure', async () => {
    dailyDriver.markDriverHandled.mockResolvedValue({ today: '2026-01-02', firstVisitToday: false, handledToday: true });
    expect((await request(app).post('/api/daily-driver/handled')).body.handledToday).toBe(true);

    dailyDriver.markDriverHandled.mockRejectedValue(new Error('write failed'));
    expect((await request(app).post('/api/daily-driver/handled')).status).toBe(500);
  });
});
