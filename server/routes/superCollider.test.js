import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cancelJob, enqueueJob, getJob } from '../services/mediaJobQueue/index.js';
import { getSuperColliderStatus, setupSuperColliderRuntime } from '../services/superColliderRuntime.js';
import { readSuperColliderPreview } from '../services/superColliderRender.js';
import router from './superCollider.js';

vi.mock('../services/mediaJobQueue/index.js', () => ({
  enqueueJob: vi.fn(async () => ({ jobId: 'job-1', position: 1, status: 'queued' })),
  getJob: vi.fn(() => null),
  cancelJob: vi.fn(),
  attachSseClient: vi.fn(() => false),
}));
vi.mock('../services/superColliderRuntime.js', () => ({
  getSuperColliderStatus: vi.fn(),
  setupSuperColliderRuntime: vi.fn(),
}));
vi.mock('../services/superColliderRender.js', async (importOriginal) => ({
  ...await importOriginal(),
  readSuperColliderPreview: vi.fn(async () => null),
}));

const app = express();
app.use(express.json());
app.use('/api/music/supercollider', router);
app.use(errorMiddleware);

const READY = { state: 'ready', ready: true, message: 'ready', action: null };
const SOURCE = 'Pbind(\\degree, Pseq([0, 2, 4], inf), \\dur, 0.5)';
const scratch = mkdtempSync(join(tmpdir(), 'portos-sc-route-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

beforeEach(() => {
  vi.clearAllMocks();
  getSuperColliderStatus.mockResolvedValue(READY);
});

describe('POST /api/music/supercollider/render', () => {
  it('queues a job carrying a frozen copy of the source, its hash and an explicit seed', async () => {
    const res = await request(app).post('/api/music/supercollider/render').send({ code: SOURCE, durationSec: 30, seed: 7 });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ jobId: 'job-1', status: 'queued', seed: 7 });
    expect(enqueueJob).toHaveBeenCalledWith({ kind: 'supercollider', params: {
      source: SOURCE, sourceHash: res.body.sourceHash, durationSec: 30, seed: 7,
    } });
    expect(res.body.sourceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('picks a seed when none is given so the render stays reproducible', async () => {
    const res = await request(app).post('/api/music/supercollider/render').send({ code: SOURCE, durationSec: 4 });
    expect(res.status).toBe(202);
    expect(Number.isInteger(res.body.seed)).toBe(true);
    expect(enqueueJob.mock.calls[0][0].params.seed).toBe(res.body.seed);
  });

  it.each([
    ['a duration under the take window', { code: SOURCE, durationSec: 3 }],
    ['a duration over the take window', { code: SOURCE, durationSec: 121 }],
    ['a fractional duration', { code: SOURCE, durationSec: 10.5 }],
    ['empty source', { code: '   ', durationSec: 10 }],
    ['oversized source', { code: 'x'.repeat(20001), durationSec: 10 }],
    // Paths and format belong to the trusted runner; the request cannot name them.
    ['a caller-chosen output path', { code: SOURCE, durationSec: 10, outputPath: '/etc/passwd' }],
  ])('rejects %s', async (_label, body) => {
    const res = await request(app).post('/api/music/supercollider/render').send(body);
    expect(res.status).toBe(400);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('refuses with the setup action instead of queuing when the runtime is not ready', async () => {
    getSuperColliderStatus.mockResolvedValue({ state: 'docker-stopped', ready: false, message: 'Docker is installed but its engine is not reachable.', action: 'Start Docker' });
    const res = await request(app).post('/api/music/supercollider/render').send({ code: SOURCE, durationSec: 10 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'SUPERCOLLIDER_UNAVAILABLE', context: { state: 'docker-stopped', action: 'Start Docker' } });
    expect(enqueueJob).not.toHaveBeenCalled();
  });
});

describe('SuperCollider render jobs', () => {
  it('cancels only SuperCollider jobs, and reports a finished one as a conflict', async () => {
    getJob.mockReturnValue({ id: 'job-1', kind: 'video' });
    expect((await request(app).post('/api/music/supercollider/renders/job-1/cancel')).status).toBe(404);
    expect(cancelJob).not.toHaveBeenCalled();

    getJob.mockReturnValue({ id: 'job-1', kind: 'supercollider' });
    cancelJob.mockResolvedValueOnce({ ok: true, status: 'canceling' });
    const canceling = await request(app).post('/api/music/supercollider/renders/job-1/cancel');
    expect(canceling.body).toEqual({ ok: true, status: 'canceling' });

    cancelJob.mockResolvedValueOnce({ ok: false, code: 'ALREADY_TERMINAL', status: 'completed', error: 'Job is already completed' });
    expect((await request(app).post('/api/music/supercollider/renders/job-1/cancel')).status).toBe(409);
  });

  it('serves a validated preview as WAV and 404s one that never passed', async () => {
    expect((await request(app).get('/api/music/supercollider/renders/job-1/audio')).status).toBe(404);

    const wavPath = join(scratch, 'job-1.wav');
    writeFileSync(wavPath, Buffer.from('RIFF----WAVE'));
    readSuperColliderPreview.mockResolvedValueOnce({ wavPath, preview: { jobId: 'job-1' } });
    const res = await request(app).get('/api/music/supercollider/renders/job-1/audio');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^audio\/wav/);
  });
});

describe('POST /api/music/supercollider/setup', () => {
  const frames = (text) => text.split('\n\n').filter(Boolean).map((frame) => JSON.parse(frame.replace(/^data: /, '')));

  it('streams setup output and finishes with the ready status', async () => {
    setupSuperColliderRuntime.mockImplementation(async ({ onLine }) => {
      onLine('Step 1/9 : FROM debian');
      return { outcome: 'ready', built: true, probed: true, status: READY };
    });
    const res = await request(app).post('/api/music/supercollider/setup').send({ rebuild: true });
    expect(setupSuperColliderRuntime).toHaveBeenCalledWith(expect.objectContaining({ rebuild: true }));
    const events = frames(res.text);
    expect(events).toContainEqual({ type: 'log', message: 'Step 1/9 : FROM debian' });
    expect(events.at(-1)).toMatchObject({ type: 'complete', built: true, status: { state: 'ready' } });
  });

  it('ends with an actionable error, never readiness, when Docker is unavailable', async () => {
    const status = { state: 'docker-missing', ready: false, message: 'Docker is not installed.', action: 'Install Docker' };
    setupSuperColliderRuntime.mockResolvedValue({ outcome: 'docker-unavailable', error: null, status });
    const res = await request(app).post('/api/music/supercollider/setup').send({});
    expect(frames(res.text).at(-1)).toMatchObject({ type: 'error', outcome: 'docker-unavailable', message: 'Docker is not installed.', status });
  });
});
