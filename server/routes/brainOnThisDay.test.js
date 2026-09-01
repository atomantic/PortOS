import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import onThisDayRoutes from './brainOnThisDay.js';

vi.mock('../services/brainOnThisDay.js', () => ({
  getOnThisDay: vi.fn(),
}));

import { getOnThisDay } from '../services/brainOnThisDay.js';

const app = express();
app.use('/api/brain', onThisDayRoutes);

describe('GET /api/brain/on-this-day', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the service payload with the default limit', async () => {
    const payload = { date: '2026-09-01', timezone: 'UTC', total: 1, items: [{ type: 'journal', id: '2025-09-01', date: '2025-09-01', yearsAgo: 1, title: null, snippet: 'a year ago' }] };
    getOnThisDay.mockResolvedValue(payload);

    const response = await request(app).get('/api/brain/on-this-day');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(payload);
    expect(getOnThisDay).toHaveBeenCalledWith({ limit: 8 });
  });

  it('clamps the limit query param to the route maximum', async () => {
    getOnThisDay.mockResolvedValue({ date: '2026-09-01', timezone: 'UTC', total: 0, items: [] });

    const response = await request(app).get('/api/brain/on-this-day?limit=500');

    expect(response.status).toBe(200);
    expect(getOnThisDay).toHaveBeenCalledWith({ limit: 20 });
  });
});
