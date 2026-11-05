import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/catalogPhotoreal.js', () => ({
  getPhotorealStatus: vi.fn(), openPhotorealBlend: vi.fn(), photorealBlendPath: vi.fn(), startPhotorealRender: vi.fn(),
}));
vi.mock('../services/catalogPhotorealLook.js', () => ({
  draftPhotorealLook: vi.fn(), previewPhotorealLookPrompt: vi.fn(), savePhotorealLook: vi.fn(),
}));
vi.mock('../services/photorealTextures.js', () => ({
  installTexture: vi.fn(), listInstalledTextures: vi.fn(), searchTextures: vi.fn(),
}));
const { openPhotorealBlend, photorealBlendPath, startPhotorealRender } = await import('../services/catalogPhotoreal.js');
const { installTexture, searchTextures } = await import('../services/photorealTextures.js');
const { savePhotorealLook } = await import('../services/catalogPhotorealLook.js');
const router = (await import('./catalog.js')).default;
const app = express();
app.use(express.json());
app.use('/api/catalog', router);
app.use(errorMiddleware);
const base = '/api/catalog/ingredients/example-place/photoreal';

describe('photoreal routes', () => {
  // Catches a texture id that could name a path outside the texture folder.
  it('searches and installs CC0 textures only by preset and slug id', async () => {
    searchTextures.mockResolvedValue([{ id: 'oak_planks' }]);
    installTexture.mockResolvedValue({ id: 'oak_planks' });
    const found = await request(app).get('/api/catalog/photoreal/textures/search?preset=wood-floor&q=oak');
    expect(found.body).toEqual({ results: [{ id: 'oak_planks' }] });
    expect(searchTextures).toHaveBeenCalledWith({ preset: 'wood-floor', query: 'oak' });
    expect((await request(app).get('/api/catalog/photoreal/textures/search?preset=mirror')).status).toBe(400);
    expect((await request(app).post('/api/catalog/photoreal/textures/oak_planks/install').send({})).status).toBe(200);
    expect((await request(app).post('/api/catalog/photoreal/textures/..%2Fetc/install').send({})).status).toBe(400);
    expect(installTexture).toHaveBeenCalledTimes(1);
  });

  // Catches the open route taking a caller-named file or executable.
  it('opens the kept scene in Blender and takes no path or executable from the caller', async () => {
    openPhotorealBlend.mockResolvedValue({ opened: true, blenderVersion: '5.2.3' });
    const opened = await request(app).post(`${base}/open`).send({});
    expect(opened.status).toBe(200);
    expect(openPhotorealBlend).toHaveBeenCalledWith('example-place');
    expect((await request(app).post(`${base}/open`).send({ path: '/etc/passwd' })).status).toBe(400);
    expect((await request(app).post(`${base}/open`).send({ executable: '/bin/sh' })).status).toBe(400);
    expect(openPhotorealBlend).toHaveBeenCalledTimes(1);
  });

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
