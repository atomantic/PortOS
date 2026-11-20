import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import { request } from './testHelper.js';
import { createLazyRouter } from './lazyRouter.js';

describe('lazy route mounts', () => {
  it('shares the first load while preserving upstream gates, mount paths and fallthrough', async () => {
    const app = express();
    const router = express.Router();
    router.get('/hit', (req, res) => res.json({ path: req.baseUrl + req.path }));
    const bothAdmitted = Promise.withResolvers();
    let admitted = 0;
    const load = vi.fn(async () => {
      await bothAdmitted.promise;
      return { default: router };
    });
    app.use('/feature', (req, res, next) => req.get('x-allow') ? next() : res.sendStatus(403));
    app.use('/feature', (_req, _res, next) => {
      if (++admitted === 2) bothAdmitted.resolve();
      next();
    });
    app.use('/feature', createLazyRouter(load));
    app.use('/feature', (_req, res) => res.sendStatus(204));
    expect((await request(app).get('/feature/hit')).status).toBe(403);
    expect(load).not.toHaveBeenCalled();
    const [hit, miss] = await Promise.all(
      ['hit', 'miss'].map(path => request(app).get('/feature/' + path).set('x-allow', '1')),
    );
    expect(hit.body).toEqual({ path: '/feature/hit' });
    expect(miss.status).toBe(204);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('forwards a failed import to the error middleware and allows another request to load it', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('load failed'))
      .mockResolvedValue({ default: (_req, res) => res.sendStatus(204) });
    const app = express();
    app.use('/feature', createLazyRouter(load));
    app.use((error, _req, res, _next) => res.status(500).json({ message: error.message }));
    expect((await request(app).get('/feature')).body).toEqual({ message: 'load failed' });
    expect((await request(app).get('/feature')).status).toBe(204);
  });
});
