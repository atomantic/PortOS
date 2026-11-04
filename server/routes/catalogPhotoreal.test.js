import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/catalogPhotoreal.js', () => ({
  getPhotorealStatus: vi.fn(), photorealBlendPath: vi.fn(), startPhotorealRender: vi.fn(),
}));
vi.mock('../services/catalogPhotorealLook.js', () => ({
  draftPhotorealLook: vi.fn(), previewPhotorealLookPrompt: vi.fn(), savePhotorealLook: vi.fn(),
}));
const { photorealBlendPath, startPhotorealRender } = await import('../services/catalogPhotoreal.js');
const { savePhotorealLook } = await import('../services/catalogPhotorealLook.js');
const router = (await import('./catalog.js')).default;
const app = express();
app.use(express.json());
app.use('/api/catalog', router);
app.use(errorMiddleware);
const base = '/api/catalog/ingredients/example-place/photoreal';

describe('photoreal routes', () => {
  it('starts a render from saved camera ids only, refusing scripts, paths and unknown engines', async () => {
    startPhotorealRender.mockResolvedValue({ id: 'pr-1', state: 'running' });
    const started = await request(app).post(`${base}/render`).send({ shotIds: ['wide'], engine: 'cycles', samples: 64 });
    expect(started.status).toBe(202);
    expect(startPhotorealRender).toHaveBeenCalledWith('example-place', { shotIds: ['wide'], engine: 'cycles', samples: 64 });
    for (const body of [
      { shotIds: ['wide'], engine: 'cycles', script: 'import os' },
      { shotIds: ['wide'], engine: 'workbench' },
      { shotIds: ['wide', 'wide'], engine: 'eevee' },
      { shotIds: [], engine: 'eevee' },
      { shotIds: ['wide'], engine: 'eevee', flythroughSeconds: 8 },
      { shotIds: ['wide', 'booth'], engine: 'eevee', flythroughSeconds: 600 },
    ]) expect((await request(app).post(`${base}/render`).send(body)).status).toBe(400);
    expect(startPhotorealRender).toHaveBeenCalledTimes(1);
  });

  it('answers 404 for a .blend that has not been built', async () => {
    photorealBlendPath.mockResolvedValue(null);
    expect((await request(app).get(`${base}/blend`)).status).toBe(404);
  });

  it('saves only allowlisted look presets and clears with null', async () => {
    savePhotorealLook.mockResolvedValue({ id: 'example-place', payload: {} });
    const bad = await request(app).put(`${base}/look`).send({ look: { materials: [{ id: 'm', zone: 'floor', preset: 'shader-code', color: '#ffffff' }] } });
    expect(bad.status).toBe(400);
    expect((await request(app).put(`${base}/look`).send({ look: null })).status).toBe(200);
    expect(savePhotorealLook).toHaveBeenCalledWith('example-place', null, { source: undefined });
  });
});
