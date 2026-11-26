import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import express from 'express';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';
import { request } from '../../lib/testHelper.js';

const dataRoot = () => lazyTempDataRoot('portos-app-sprite-bindings-');
vi.mock('../../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot }));

vi.mock('../../services/apps.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getAllApps: async () => [],
  getAppById: async () => ({ id: 'example-app' }),
}));

vi.mock('../../services/sprites/records.js', async (importOriginal) => ({
  ...(await importOriginal()),
  listRecords: async () => [
    {
      id: 'example-sprite',
      name: 'Example sprite',
      kind: 'character',
      publishBinding: { appId: 'example-app', atlasDestPath: 'assets/sprite.png' },
    },
    { id: 'other-sprite', publishBinding: { appId: 'other-app' } },
  ],
}));

describe('Apps sprite bindings and the animation track store', () => {
  beforeEach(() => vi.resetModules());
  afterAll(cleanupTempDataRoots);

  async function mountApps(trackStore) {
    const spritesDir = join(dataRoot(), 'sprites');
    mkdirSync(spritesDir, { recursive: true });
    writeFileSync(join(spritesDir, 'animation-tracks.json'), trackStore);

    const { default: appsRoutes } = await import('./index.js');
    const app = express();
    app.use('/api/apps', appsRoutes);
    return app;
  }

  it('keeps the Apps list available when sprite track JSON is corrupt', async () => {
    const app = await mountApps('{"tracks":');

    const list = await request(app).get('/api/apps');
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);

    const bindings = await request(app).get('/api/apps/example-app/sprite-bindings');
    expect(bindings.status).toBe(500);
    expect(bindings.body.error).toMatch(/^sprites\/animation-tracks\.json: .* is not valid JSON/);

    expect((await request(app).get('/api/apps')).status).toBe(200);
  });

  it('returns the existing binding payload with a valid sprite track store', async () => {
    const seed = readFileSync(new URL('../../../data.reference/sprites/animation-tracks.json', import.meta.url));
    const app = await mountApps(seed);

    const bindings = await request(app).get('/api/apps/example-app/sprite-bindings');
    expect(bindings.status).toBe(200);
    expect(bindings.body).toEqual({
      bindings: [{
        recordId: 'example-sprite',
        name: 'Example sprite',
        kind: 'character',
        atlasDestPath: 'assets/sprite.png',
        portraitDestPath: null,
        presentationIdleDestPath: null,
        codeBindingPath: null,
      }],
    });
  });
});
