import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorEvents, errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/mediaAnnotations.js', () => ({
  ERR_VALIDATION: 'VALIDATION_ERROR',
  NOTE_MAX_LENGTH: 2000,
  MEDIA_RATINGS: ['good', 'bad'],
  listAnnotations: vi.fn(),
  setAnnotation: vi.fn(),
}));

import * as svc from '../services/mediaAnnotations.js';
import mediaAnnotationsRoutes from './mediaAnnotations.js';

// With an io on the app, the error middleware also raises errorEvents 'error',
// which throws on an EventEmitter with no listener; the server registers one at boot.
errorEvents.on('error', () => {});
const io = { emit: vi.fn() };
const notBroadcast = () => expect(io.emit).not.toHaveBeenCalledWith('media:annotation:updated', expect.anything());
const app = express();
app.set('io', io);
app.use(express.json());
app.use('/api/media/annotations', mediaAnnotationsRoutes);
app.use(errorMiddleware);

beforeEach(() => vi.clearAllMocks());

describe('/api/media/annotations', () => {
  it('writes the local entry and broadcasts it so other open views update', async () => {
    const entry = { own: { starred: true, note: '' }, others: [] };
    svc.setAnnotation.mockResolvedValue(entry);
    const res = await request(app).patch('/api/media/annotations/image:a.png').send({ starred: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ key: 'image:a.png', entry });
    expect(svc.setAnnotation).toHaveBeenCalledWith('image:a.png', { starred: true });
    expect(io.emit).toHaveBeenCalledWith('media:annotation:updated', { key: 'image:a.png', entry });
  });

  it('refuses an empty or over-long patch before touching the store', async () => {
    expect((await request(app).patch('/api/media/annotations/image:a.png').send({})).status).toBe(400);
    expect((await request(app).patch('/api/media/annotations/image:a.png').send({ note: 'x'.repeat(2001) })).status).toBe(400);
    // "Rejected" is a music video take state, never a media rating.
    expect((await request(app).patch('/api/media/annotations/image:a.png').send({ rating: 'rejected' })).status).toBe(400);
    expect(svc.setAnnotation).not.toHaveBeenCalled();
    notBroadcast();
  });

  it('maps a service validation refusal (bad key) to 400 and broadcasts nothing', async () => {
    svc.setAnnotation.mockRejectedValue(Object.assign(new Error('Invalid key: nope'), { code: 'VALIDATION_ERROR' }));
    const res = await request(app).patch('/api/media/annotations/nope').send({ starred: false });
    expect(res.status).toBe(400);
    notBroadcast();
  });
});
