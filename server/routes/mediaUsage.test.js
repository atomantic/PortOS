import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const service = vi.hoisted(() => ({ getMediaUsageIndex: vi.fn() }));
vi.mock('../services/mediaUsage.js', () => service);

const { default: mediaUsageRoutes } = await import('./mediaUsage.js');

const app = express();
app.use('/api/media/usages', mediaUsageRoutes);
app.use(errorMiddleware);

describe('/api/media/usages', () => {
  it('returns the usage index keyed like media cards', async () => {
    const items = { 'image:a.png': [{ source: 'storyboard', label: 'Storyboard', id: 'sb-1', title: 'Board', role: 'Panel 1', href: '/storyboards/sb-1/panel/p-1' }] };
    service.getMediaUsageIndex.mockResolvedValue(items);
    const res = await request(app).get('/api/media/usages');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items });
  });
});
