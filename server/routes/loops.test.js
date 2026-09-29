import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware, errorEvents } from '../lib/errorHandler.js';

const created = vi.hoisted(() => ({ writes: 0 }));
vi.mock('../lib/fileUtils.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    tryReadFile: async () => '[]',
    ensureDir: async () => {},
    atomicWrite: async () => { created.writes++; }
  };
});
import loopsRoutes from './loops.js';

const observe = () => {};
beforeAll(() => errorEvents.on('error', observe));
afterAll(() => errorEvents.off('error', observe));

const app = express();
app.use(express.json());
app.use('/api/loops', loopsRoutes);
app.use(errorMiddleware);

describe('loops routes — caller errors are 4xx', () => {
  it.each([
    [{ prompt: 'hi', interval: 5 }],
    [{ prompt: 'hi', interval: 'abc' }],
    [{ prompt: '   ', interval: '1m' }]
  ])('rejects %j with 400 before writing', async (body) => {
    const res = await request(app).post('/api/loops').send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(created.writes).toBe(0);
  });

  it('404s an unknown id on resume, trigger and put', async () => {
    expect((await request(app).post('/api/loops/nope/resume')).status).toBe(404);
    expect((await request(app).put('/api/loops/nope').send({ name: 'x' })).status).toBe(404);
    expect((await request(app).post('/api/loops/nope/trigger')).status).toBe(404);
  });

  it('409s stop on a loop that is not running', async () => {
    const res = await request(app).post('/api/loops/nope/stop');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_STATE');
  });
});
