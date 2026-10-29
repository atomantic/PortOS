import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const service = vi.hoisted(() => ({ listMediaHolders: vi.fn(), makeMediaPrimary: vi.fn() }));
vi.mock('../services/mediaHolders.js', () => service);

const { default: mediaHoldersRoutes } = await import('./mediaHolders.js');

const app = express();
app.use(express.json());
app.use('/api/media/holders', mediaHoldersRoutes);
app.use(errorMiddleware);

beforeEach(() => {
  service.listMediaHolders.mockReset();
  service.makeMediaPrimary.mockReset();
});

describe('/api/media/holders', () => {
  it('lists the holders map', async () => {
    service.listMediaHolders.mockResolvedValue({ self: 'inst-self', items: {} });
    const res = await request(app).get('/api/media/holders');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ self: 'inst-self', items: {} });
  });

  it('passes a valid Make primary request through and refuses a path-like file name', async () => {
    service.makeMediaPrimary.mockResolvedValue({ primaryInstanceId: 'inst-a', released: [], pending: [], kept: [] });
    const ok = await request(app).post('/api/media/holders/primary').send({ kind: 'video', filename: 'v1.mp4', instanceId: 'inst-a' });
    expect(ok.status).toBe(200);
    expect(service.makeMediaPrimary).toHaveBeenCalledWith({ kind: 'video', filename: 'v1.mp4', instanceId: 'inst-a' });

    const bad = await request(app).post('/api/media/holders/primary').send({ kind: 'video', filename: '../history.json', instanceId: 'inst-a' });
    expect(bad.status).toBe(400);
    expect(service.makeMediaPrimary).toHaveBeenCalledTimes(1);
  });
});
