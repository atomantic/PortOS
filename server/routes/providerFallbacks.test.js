import { afterAll, describe, it, expect, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Real fallback-chain service (settings.json) over a temp data root.
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-provider-fallbacks-routes-') }));
afterAll(cleanupTempDataRoots);

const routes = (await import('./providerFallbacks.js')).default;
const app = express();
app.use(express.json());
app.use('/api/provider-fallbacks', routes);
app.use(errorMiddleware);

describe('provider fallback list routes', () => {
  it('saves an ordered list that repeats a preset with different models and reads it back', async () => {
    const entries = [{ providerId: 'codex', model: 'm1', effort: 'max' }, { providerId: 'codex', model: 'm2' }, { providerId: 'agy' }];
    const res = await request(app).put('/api/provider-fallbacks').send({ entries });
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual(entries);
    expect((await request(app).get('/api/provider-fallbacks')).body.entries).toEqual(entries);
  });

  it('rejects a malformed provider reference without touching the saved list', async () => {
    const before = (await request(app).get('/api/provider-fallbacks')).body.entries;
    const res = await request(app).put('/api/provider-fallbacks').send({ entries: [{ providerId: 'Not A Preset!' }] });
    expect(res.status).toBe(400);
    expect((await request(app).get('/api/provider-fallbacks')).body.entries).toEqual(before);
  });
});
