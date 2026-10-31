import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const deleteHealthDay = vi.hoisted(() => vi.fn());
vi.mock('../services/appleHealthIngest.js', () => ({
  ingestHealthData: vi.fn(),
  deleteHealthDay,
}));

const { default: appleHealthDaysRoutes } = await import('./appleHealthDays.js');

const app = express();
app.use('/api/apple-health', appleHealthDaysRoutes);
app.use(errorMiddleware);

describe('DELETE /api/apple-health/days/:date', () => {
  it('rejects a non-date without unlinking', async () => {
    deleteHealthDay.mockClear();
    const res = await request(app).delete('/api/apple-health/days/today');
    expect(res.status).toBe(400);
    expect(deleteHealthDay).not.toHaveBeenCalled();
  });

  it('reports a missing day', async () => {
    deleteHealthDay.mockResolvedValue(null);
    const res = await request(app).delete('/api/apple-health/days/2026-04-02');
    expect(res.status).toBe(404);
    expect(deleteHealthDay).toHaveBeenCalledWith('2026-04-02');
  });

  it('returns the removed day', async () => {
    deleteHealthDay.mockResolvedValue({ date: '2026-04-02' });
    const res = await request(app).delete('/api/apple-health/days/2026-04-02');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ date: '2026-04-02' });
  });
});
