import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import sharp from 'sharp';
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Sandbox PATHS.images and PATHS.data (the bake stages its page under data) the
// way imageGen.clean.test.js does, so the endpoint reads and writes real files
// without touching data/.
let sandbox;

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return {
    ...actual,
    get PATHS() {
      return { ...actual.PATHS, images: join(sandbox, 'images'), data: sandbox };
    },
  };
});

// The composition browser is a fake page: the test asserts what the bake asks
// of it (the staged page, the viewport it sizes, one screenshot) and hands back
// a PNG as the "rendered" frame.
const browser = vi.hoisted(() => ({ opened: [], commands: [], screenshot: null, closed: 0 }));
vi.mock('../services/htmlComposition/browser.js', () => ({
  openComposition: vi.fn(async (directory, options) => {
    const { readFile: read } = await import('fs/promises');
    const { join: j } = await import('path');
    browser.opened.push({ directory, options, page: await read(j(sandbox, directory, 'index.html'), 'utf8') });
    return {
      evaluate: vi.fn(async () => true),
      send: vi.fn(async (method, params) => {
        browser.commands.push({ method, params });
        return method === 'Page.captureScreenshot' ? { data: browser.screenshot.toString('base64') } : {};
      }),
      check: () => {},
      close: vi.fn(async () => { browser.closed += 1; }),
    };
  }),
}));

vi.mock('../services/imageGen/index.js', async () => {
  const actual = await vi.importActual('../services/imageGen/index.js');
  return { ...actual, checkConnection: vi.fn(), generateImage: vi.fn(), generateAvatar: vi.fn(), attachSseClient: vi.fn(() => false), cancel: vi.fn(() => false) };
});
vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn(async () => ({ imageGen: { mode: 'external' } })),
  settingsEvents: { on: () => {}, emit: () => {} },
}));
vi.mock('../services/mediaJobQueue/index.js', () => ({ enqueueJob: vi.fn(), attachSseClient: vi.fn(() => false), cancelJob: vi.fn(), listJobs: vi.fn(() => []) }));
const { listCollectionsMock, addItemMock } = vi.hoisted(() => ({ listCollectionsMock: vi.fn(async () => []), addItemMock: vi.fn(async () => ({})) }));
vi.mock('../services/mediaCollections.js', () => ({ listCollections: listCollectionsMock, addItem: addItemMock, ERR_DUPLICATE: 'DUPLICATE' }));

let imageGenRoutes;
const png = (r, g, b) => sharp({ create: { width: 64, height: 48, channels: 3, background: { r, g, b } } }).png().toBuffer();

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'portos-film-look-'));
  await (await import('fs/promises')).mkdir(join(sandbox, 'images'), { recursive: true });
  ({ default: imageGenRoutes } = await import('./imageGen.js'));
});
afterAll(async () => { await rm(sandbox, { recursive: true, force: true }); });

describe('POST /api/image-gen/:filename/film-look', () => {
  let app;
  beforeEach(async () => {
    app = express();
    app.use(express.json());
    app.use('/api/image-gen', imageGenRoutes);
    app.use(errorMiddleware);
    browser.opened.length = 0;
    browser.commands.length = 0;
    browser.closed = 0;
    browser.screenshot = await png(200, 120, 60);
    await writeFile(join(sandbox, 'images', 'still-1.png'), await png(30, 40, 50));
    await writeFile(join(sandbox, 'images', 'still-1.metadata.json'), JSON.stringify({ prompt: 'a rainy window', seed: 3, modelId: 'example-model', regenerated: true, regenStrength: 0.4 }));
  });

  it('renders the look in the composition browser at the image size and saves it as a variant beside the original', async () => {
    const look = { preset: 'neon-rain', grain: 0.6, halation: 0.8 };
    const res = await request(app).post('/api/image-gen/still-1.png/film-look').send({ look });
    expect(res.status).toBe(200);
    expect(res.body.filename).toMatch(/^still-1_look-neon-rain-[0-9a-f]{8}\.png$/);
    expect(res.body).toMatchObject({ cleanedFrom: 'still-1.png', filmLookFrom: 'still-1.png', prompt: 'a rainy window', modelId: 'example-model', width: 64, height: 48 });
    expect(res.body.filmLook).toMatchObject({ preset: 'neon-rain', grain: 0.6, halation: 0.8, version: 1 });
    expect(res.body.filmLookWords).toMatch(/halation/);
    // The regen lineage would mislabel the copy (the lightbox reads it first), so it does not carry over.
    expect(res.body.regenerated).toBeUndefined();
    expect(res.body.regenStrength).toBeUndefined();

    // What the browser was asked: the staged one-image page with the filter on the image, sized to it, one capture, then closed.
    expect(browser.opened).toHaveLength(1);
    expect(browser.opened[0].directory).toMatch(/^film-look-bakes\//);
    expect(browser.opened[0].options).toMatchObject({ ownedBrowser: true });
    expect(browser.opened[0].page).toContain('<img src="source.png"');
    expect(browser.opened[0].page).toContain('filter:url(#portos-film-look)');
    expect(browser.opened[0].page).toContain('feTurbulence');
    expect(browser.commands.map((c) => c.method)).toEqual(['Emulation.setDeviceMetricsOverride', 'Page.captureScreenshot']);
    expect(browser.commands[0].params).toMatchObject({ width: 64, height: 48 });
    expect(browser.closed).toBe(1);

    // The copy is the captured frame; the original and the staging folder are as they were.
    const saved = await readFile(join(sandbox, 'images', res.body.filename));
    expect(saved.equals(browser.screenshot)).toBe(true);
    expect((await readFile(join(sandbox, 'images', 'still-1.png'))).equals(await png(30, 40, 50))).toBe(true);
    expect(existsSync(join(sandbox, browser.opened[0].directory))).toBe(false);
    const sidecar = JSON.parse(await readFile(join(sandbox, 'images', res.body.filename.replace(/\.png$/, '.metadata.json')), 'utf8'));
    expect(sidecar).toMatchObject({ filmLookFrom: 'still-1.png', cleanedFrom: 'still-1.png' });
  });

  it('refuses a look that changes nothing, an unknown control, and a missing image without opening a browser', async () => {
    expect((await request(app).post('/api/image-gen/still-1.png/film-look').send({ look: { preset: 'none' } })).status).toBe(422);
    expect((await request(app).post('/api/image-gen/still-1.png/film-look').send({ look: { grain: 0.5, sharpen: 1 } })).status).toBe(400);
    expect((await request(app).post('/api/image-gen/still-1.png/film-look').send({})).status).toBe(400);
    expect((await request(app).post('/api/image-gen/missing.png/film-look').send({ look: { grain: 0.5 } })).status).toBe(404);
    expect(browser.opened).toHaveLength(0);
  });
});
