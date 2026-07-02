import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

vi.mock('../services/videoDownload.js', () => ({
  startVideoDownload: vi.fn(async () => ({ jobId: 'job-1' })),
  attachDownloadSseClient: vi.fn(() => true),
  cancelVideoDownload: vi.fn(() => true),
  listDownloads: vi.fn(async () => [{ id: 'dl-1', filename: 'downloaded-dl-1.mp4', source: 'download' }]),
  deleteDownload: vi.fn(async () => ({ ok: true })),
}));

import * as svc from '../services/videoDownload.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import videoDownloadRoutes from './videoDownload.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/devtools/video-download', videoDownloadRoutes);
  app.use(errorMiddleware);
  return app;
}

describe('video download routes (#1946)', () => {
  let app;
  beforeEach(() => { app = makeApp(); vi.clearAllMocks(); });

  it('POST / starts a job for a valid URL', async () => {
    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const r = await request(app).post('/api/devtools/video-download').send({ url });
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ jobId: 'job-1' });
    expect(svc.startVideoDownload).toHaveBeenCalledWith(url);
  });

  it('POST / rejects a non-URL body before reaching the service', async () => {
    const r = await request(app).post('/api/devtools/video-download').send({ url: 'not a url' });
    expect(r.status).toBe(400);
    expect(svc.startVideoDownload).not.toHaveBeenCalled();
  });

  it('GET /downloads lists downloaded videos (not read as a jobId)', async () => {
    const r = await request(app).get('/api/devtools/video-download/downloads');
    expect(r.status).toBe(200);
    expect(r.body[0].id).toBe('dl-1');
    expect(svc.attachDownloadSseClient).not.toHaveBeenCalled();
  });

  it('DELETE /downloads/:id deletes a download', async () => {
    const r = await request(app).delete('/api/devtools/video-download/downloads/dl-1');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(svc.deleteDownload).toHaveBeenCalledWith('dl-1');
  });

  it('GET /:jobId/events 404s when the job is unknown', async () => {
    svc.attachDownloadSseClient.mockReturnValueOnce(false);
    const r = await request(app).get('/api/devtools/video-download/missing/events');
    expect(r.status).toBe(404);
  });

  it('POST /:jobId/cancel proxies to the service', async () => {
    const r = await request(app).post('/api/devtools/video-download/job-1/cancel');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(svc.cancelVideoDownload).toHaveBeenCalledWith('job-1');
  });
});
