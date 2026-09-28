import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { enqueueJob } from '../services/mediaJobQueue/index.js';
import { resolveMusicTrackPath } from '../services/pipeline/audioMux.js';
import { getBeatGrid } from '../lib/beatGrid.js';
import router from './htmlComposition.js';

vi.mock('../services/mediaJobQueue/index.js', () => ({
  enqueueJob: vi.fn(async () => ({ jobId: 'example-job', status: 'queued' })),
  attachSseClient: vi.fn(() => false), cancelJob: vi.fn(),
}));
vi.mock('../services/pipeline/audioMux.js', () => ({ resolveMusicTrackPath: vi.fn(async () => null) }));
vi.mock('../lib/beatGrid.js', () => ({ getBeatGrid: vi.fn(async () => null) }));

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

  it.each([{ directory: 'valid', synthesizeMusic: true, musicTrack: 'example.wav' }, { directory: '../private' }, { directory: '/etc' }, { directory: 'C:\\private' }, { directory: 'valid', musicTrack: '../track.wav' }, {}])('rejects invalid paths before queue admission: %j', async body => {
    enqueueJob.mockClear();
    const response = await request(app).post('/api/html-composition/render').send(body);
    expect(response.status).toBe(400);
    expect(enqueueJob).not.toHaveBeenCalled();
  });
});

describe('GET /api/html-composition/beats (#8958)', () => {
  it('returns the measured beat grid for a resolved library track', async () => {
    resolveMusicTrackPath.mockResolvedValueOnce('/data/music/example.mp3');
    getBeatGrid.mockResolvedValueOnce({ bpm: 120, beats: [0, 0.5], downbeats: [0], hits: [0, 0.25] });
    const response = await request(app).get('/api/html-composition/beats?musicTrack=example.mp3');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ bpm: 120, beats: [0, 0.5], downbeats: [0], hits: [0, 0.25] });
    expect(getBeatGrid).toHaveBeenCalledWith('/data/music/example.mp3');
  });

  it('rejects a musicTrack that is not a Music-library filename', async () => {
    const response = await request(app).get('/api/html-composition/beats?musicTrack=..%2Fetc%2Fpasswd');
    expect(response.status).toBe(400);
    expect(getBeatGrid).not.toHaveBeenCalled();
  });

  it('rejects a musicTrack that does not resolve in the library', async () => {
    const response = await request(app).get('/api/html-composition/beats?musicTrack=missing.wav');
    expect(response.status).toBe(400);
  });

  it('reports 422 when the track resolves but cannot be measured', async () => {
    resolveMusicTrackPath.mockResolvedValueOnce('/data/music/example.mp3');
    getBeatGrid.mockResolvedValueOnce(null);
    const response = await request(app).get('/api/html-composition/beats?musicTrack=example.mp3');
    expect(response.status).toBe(422);
  });
});
