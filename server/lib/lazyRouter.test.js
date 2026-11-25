import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from './testHelper.js';

describe('lazy route mounts', () => {
  let createLazyRouter;
  let warmLazyRouters;

  beforeEach(async () => {
    vi.resetModules();
    ({ createLazyRouter, warmLazyRouters } = await import('./lazyRouter.js'));
  });

  afterEach(() => vi.restoreAllMocks());

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

  it('serves both warmed routers from the loaded revision after their files change', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'portos-lazy-router-'));
    const features = ['first', 'second'];
    const source = revision => `export default (_req, res) => res.json({ revision: '${revision}' });`;
    try {
      const app = express();
      for (const feature of features) {
        const file = join(dir, feature + '.mjs');
        await writeFile(file, source('boot'));
        const url = pathToFileURL(file).href;
        app.use('/' + feature, createLazyRouter(() => import(/* @vite-ignore */ url)));
      }
      await warmLazyRouters();
      for (const feature of features) {
        await writeFile(join(dir, feature + '.mjs'), source('updated'));
      }
      for (const feature of features) {
        expect((await request(app).get('/' + feature)).body).toEqual({ revision: 'boot' });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('shares the in-flight warmup with a request and yields before starting the next router', async () => {
    const app = express();
    const loadStarted = Promise.withResolvers();
    const releaseLoad = Promise.withResolvers();
    const requestAdmitted = Promise.withResolvers();
    const loaded = { default: (_req, res) => res.sendStatus(204) };
    let yielded = false;
    let yieldedBeforeSecondLoad;
    const first = vi.fn(async () => {
      loadStarted.resolve();
      await releaseLoad.promise;
      setImmediate(() => { yielded = true; });
      return loaded;
    });
    const second = vi.fn(async () => {
      yieldedBeforeSecondLoad = yielded;
      return loaded;
    });
    app.use('/first', (_req, _res, next) => {
      next();
      requestAdmitted.resolve();
    }, createLazyRouter(first));
    app.use('/second', createLazyRouter(second));

    const warming = warmLazyRouters();
    await loadStarted.promise;
    const response = request(app).get('/first').then(result => result);
    await requestAdmitted.promise;
    releaseLoad.resolve();
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();

    expect((await response).status).toBe(204);
    await warming;
    expect(yieldedBeforeSecondLoad).toBe(true);
    expect((await request(app).get('/second')).status).toBe(204);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it('logs one warmup failure and continues loading later routers', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = vi.fn().mockRejectedValue(new Error('module could not link\nmissing export'));
    const healthy = vi.fn().mockResolvedValue({ default: (_req, res) => res.sendStatus(204) });
    const app = express();
    app.use('/failed', createLazyRouter(failed));
    app.use('/healthy', createLazyRouter(healthy));

    await warmLazyRouters();

    expect(log).toHaveBeenCalledExactlyOnceWith('❌ Lazy router warmup failed: module could not link missing export');
    expect(failed).toHaveBeenCalledOnce();
    expect((await request(app).get('/healthy')).status).toBe(204);
    expect(healthy).toHaveBeenCalledOnce();
  });
});
