import { recordingOperatorIo } from '../test/recordingOperatorIo.js';
import { afterAll, describe, it, expect, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorEvents, errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Real mediaSketches service (sidecar JSON + PNG files) over a temp data root.
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-media-sketches-') }));
afterAll(cleanupTempDataRoots);

const router = (await import('./mediaSketches.js')).default;

// With an io on the app the error middleware raises errorEvents 'error'; the server registers a listener at boot.
errorEvents.on('error', () => {});
const io = recordingOperatorIo();
const app = express();
app.set('io', io);
app.use(express.json({ limit: '55mb' }));
app.use('/api/media/sketches', router);
app.use(errorMiddleware);

const url = (key, suffix = '') => `/api/media/sketches/${encodeURIComponent(key)}${suffix}`;
const strokes = [{ mode: 'draw', color: '#ef4444', size: 6, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }];
// 1x1 transparent PNG
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('mediaSketches routes', () => {
  it('persists a save so it reads back, broadcasts it, and serves the flattened PNG', async () => {
    const key = 'image:foo.png';
    expect((await request(app).get(url(key))).body.sketch).toBeNull();
    expect((await request(app).get(url(key, '/png'))).status).toBe(404);

    const saved = await request(app).put(url(key)).send({ width: 100, height: 80, strokes, png: `data:image/png;base64,${PNG_B64}` });
    expect(saved.status).toBe(200);
    expect(saved.body.sketch).toMatchObject({ key, width: 100, height: 80, hasPng: true });
    expect(io.emit).toHaveBeenCalledWith('media:sketch:updated', { key, sketch: saved.body.sketch });

    const read = await request(app).get(url(key));
    expect(read.body.sketch).toEqual(saved.body.sketch);
    expect(read.body.sketch.strokes).toHaveLength(1);

    const png = await request(app).get(url(key, '/png'));
    expect(png.status).toBe(200);
    expect(png.headers['content-type']).toContain('image/png');
  });

  it('removes the sidecar when a re-save carries no strokes', async () => {
    const key = 'image:erased.png';
    await request(app).put(url(key)).send({ width: 10, height: 10, strokes });
    const cleared = await request(app).put(url(key)).send({ width: 10, height: 10, strokes: [] });
    expect(cleared.status).toBe(200);
    expect((await request(app).get(url(key))).body.sketch).toBeNull();
  });

  it('refuses a malformed payload, a video key and an invalid key without persisting anything', async () => {
    const key = 'image:bad.png';
    expect((await request(app).put(url(key)).send({ width: 100 })).status).toBe(400);
    expect((await request(app).put(url('video:clip.mp4')).send({ width: 10, height: 10, strokes })).status).toBe(400);
    expect((await request(app).get(url('not-a-key'))).status).toBe(400);
    expect((await request(app).get(url(key))).body.sketch).toBeNull();
  });

  it('mints a blank-canvas key that can be saved and read back', async () => {
    const minted = await request(app).post('/api/media/sketches');
    expect(minted.status).toBe(201);
    expect(minted.body.key).toMatch(/^sketch:[a-f0-9-]{36}$/);
    await request(app).put(url(minted.body.key)).send({ width: 5, height: 5, strokes });
    expect((await request(app).get(url(minted.body.key))).body.sketch.strokes).toHaveLength(1);
  });
});
