import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Stub the service so we assert the route's request → svc-call → response
// wiring (incl. 400/404 mapping) without touching the real file-backed store.
const stubs = {
  getSketch: vi.fn(),
  getSketchPng: vi.fn(),
  saveSketch: vi.fn(),
};

vi.mock('../services/mediaSketches.js', async () => {
  const actual = await vi.importActual('../services/mediaSketches.js');
  return {
    ...actual,
    getSketch: (...a) => stubs.getSketch(...a),
    getSketchPng: (...a) => stubs.getSketchPng(...a),
    saveSketch: (...a) => stubs.saveSketch(...a),
  };
});

const router = (await import('./mediaSketches.js')).default;

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '55mb' }));
  app.use('/api/media/sketches', router);
  app.use(errorMiddleware);
  return app;
}

const KEY = encodeURIComponent('image:foo.png');
const sampleStrokes = [{ mode: 'draw', color: '#ef4444', size: 6, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }];

describe('mediaSketches routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET /:key returns the sketch projection', async () => {
    stubs.getSketch.mockResolvedValue({ key: 'image:foo.png', width: 10, height: 10, strokes: sampleStrokes, updatedAt: 'now', hasPng: true });
    const r = await request(makeApp()).get(`/api/media/sketches/${KEY}`);
    expect(r.status).toBe(200);
    expect(r.body.sketch.strokes).toHaveLength(1);
    expect(stubs.getSketch).toHaveBeenCalledWith('image:foo.png');
  });

  it('GET /:key returns sketch:null when none saved', async () => {
    stubs.getSketch.mockResolvedValue(null);
    const r = await request(makeApp()).get(`/api/media/sketches/${KEY}`);
    expect(r.status).toBe(200);
    expect(r.body.sketch).toBeNull();
  });

  it('PUT /:key round-trips a save and echoes the stored sketch', async () => {
    const stored = { key: 'image:foo.png', width: 100, height: 80, strokes: sampleStrokes, updatedAt: 'now', hasPng: false };
    stubs.saveSketch.mockResolvedValue(stored);
    const r = await request(makeApp())
      .put(`/api/media/sketches/${KEY}`)
      .send({ width: 100, height: 80, strokes: sampleStrokes });
    expect(r.status).toBe(200);
    expect(r.body.key).toBe('image:foo.png');
    expect(r.body.sketch).toEqual(stored);
    expect(stubs.saveSketch).toHaveBeenCalledWith('image:foo.png', expect.objectContaining({ width: 100, height: 80 }));
  });

  it('PUT /:key 400s on a malformed payload before hitting the service', async () => {
    const r = await request(makeApp())
      .put(`/api/media/sketches/${KEY}`)
      .send({ width: 100 }); // missing height + strokes
    expect(r.status).toBe(400);
    expect(stubs.saveSketch).not.toHaveBeenCalled();
  });

  it('GET /:key/png streams the flattened bytes', async () => {
    stubs.getSketchPng.mockResolvedValue(Buffer.from('png-bytes'));
    const r = await request(makeApp()).get(`/api/media/sketches/${KEY}/png`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('image/png');
  });

  it('GET /:key/png 404s when no export exists', async () => {
    stubs.getSketchPng.mockResolvedValue(null);
    const r = await request(makeApp()).get(`/api/media/sketches/${KEY}/png`);
    expect(r.status).toBe(404);
  });

  it('POST / mints a fresh blank-canvas sketch key (phase 3)', async () => {
    const r = await request(makeApp()).post('/api/media/sketches');
    expect(r.status).toBe(201);
    expect(r.body.key).toMatch(/^sketch:[a-f0-9-]{36}$/);
  });
});
