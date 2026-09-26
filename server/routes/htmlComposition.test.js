import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { enqueueJob } from '../services/mediaJobQueue/index.js';
import router from './htmlComposition.js';

vi.mock('../services/mediaJobQueue/index.js', () => ({
  enqueueJob: vi.fn(async () => ({ jobId: 'example-job', status: 'queued' })),
  attachSseClient: vi.fn(() => false), cancelJob: vi.fn(),
}));

const app = express();
app.use(express.json());
app.use('/api/html-composition', router);
app.use(errorMiddleware);

describe('HTML composition admission', () => {
  it('accepts local composition assets and optional library music as a local-only media job', async () => {
    const params = { directory: 'compositions/example', musicTrack: 'example.wav' };
    const response = await request(app).post('/api/html-composition/render').send(params);
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ jobId: 'example-job' });
    expect(enqueueJob).toHaveBeenCalledWith({ kind: 'html-composition', params });
  });

  it.each([{ directory: '../private' }, { directory: '/etc' }, { directory: 'C:\\private' }, { directory: 'valid', musicTrack: '../track.wav' }, {}])('rejects invalid paths before queue admission: %j', async body => {
    enqueueJob.mockClear();
    const response = await request(app).post('/api/html-composition/render').send(body);
    expect(response.status).toBe(400);
    expect(enqueueJob).not.toHaveBeenCalled();
  });
});
