import { describe, it, expect, beforeEach, vi } from 'vitest';

const fileStore = new Map();

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { data: '/mock/data' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn(async (path, data) => { fileStore.set(path, data); }),
  readJSONFile: vi.fn(async (path, fallback) => (fileStore.has(path) ? fileStore.get(path) : fallback)),
  tryReadFile: vi.fn(async (path) => (fileStore.has(path) ? fileStore.get(path) : null)),
}));

vi.mock('fs/promises', () => ({
  unlink: vi.fn(async (path) => { fileStore.delete(path); }),
}));

const svc = await import('./mediaSketches.js');

const KEY = 'image:foo.png';
const PNG_DATA_URL = `data:image/png;base64,${Buffer.from('fake-png-bytes').toString('base64')}`;

const sampleStrokes = [
  { mode: 'draw', color: '#ef4444', size: 6, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] },
  { mode: 'erase', color: '#000000', size: 12, points: [{ x: 5, y: 6 }] },
];

describe('mediaSketches service', () => {
  beforeEach(() => { fileStore.clear(); });

  it('getSketch returns null for a fresh key', async () => {
    expect(await svc.getSketch(KEY)).toBeNull();
  });

  it('saveSketch → getSketch round-trips strokes + dimensions', async () => {
    const saved = await svc.saveSketch(KEY, { width: 100, height: 80, strokes: sampleStrokes, png: PNG_DATA_URL });
    expect(saved.strokes).toHaveLength(2);
    expect(saved.width).toBe(100);
    expect(saved.hasPng).toBe(true);
    expect(saved.updatedAt).toBeTruthy();

    const loaded = await svc.getSketch(KEY);
    expect(loaded.strokes).toEqual(saved.strokes);
    expect(loaded.width).toBe(100);
    expect(loaded.height).toBe(80);
    expect(loaded.hasPng).toBe(true);
  });

  it('saveSketch persists the flattened PNG as decoded bytes', async () => {
    await svc.saveSketch(KEY, { width: 10, height: 10, strokes: sampleStrokes, png: PNG_DATA_URL });
    const png = await svc.getSketchPng(KEY);
    expect(Buffer.isBuffer(png)).toBe(true);
    expect(png.toString()).toBe('fake-png-bytes');
  });

  it('saveSketch with empty strokes removes the sidecar', async () => {
    await svc.saveSketch(KEY, { width: 10, height: 10, strokes: sampleStrokes, png: PNG_DATA_URL });
    expect(await svc.getSketch(KEY)).not.toBeNull();
    const cleared = await svc.saveSketch(KEY, { width: 10, height: 10, strokes: [] });
    expect(cleared.strokes).toEqual([]);
    expect(await svc.getSketch(KEY)).toBeNull();
  });

  it('sanitizeSketchInput drops malformed strokes/points and clamps size', () => {
    const clean = svc.sanitizeSketchInput({
      width: 50,
      height: 50,
      strokes: [
        { points: [] },                                   // dropped: no points
        { points: [{ x: 'bad', y: 1 }] },                 // dropped: non-numeric → no valid points
        { mode: 'weird', points: [{ x: 1, y: 1 }] },      // mode coerced to draw
        { size: 9999, points: [{ x: 2, y: 2 }] },         // size clamped to 512
      ],
    });
    expect(clean.strokes).toHaveLength(2);
    expect(clean.strokes[0].mode).toBe('draw');
    expect(clean.strokes[1].size).toBe(512);
    expect(clean.png).toBeNull();
  });

  it('rejects a non-image key', async () => {
    await expect(svc.saveSketch('video:abc', { width: 1, height: 1, strokes: sampleStrokes }))
      .rejects.toMatchObject({ code: svc.ERR_VALIDATION });
  });

  it('rejects an invalid key', async () => {
    await expect(svc.getSketch('not-a-key')).rejects.toMatchObject({ code: svc.ERR_VALIDATION });
  });

  it('rejects a non-PNG data URL', () => {
    expect(() => svc.sanitizeSketchInput({ width: 1, height: 1, strokes: [], png: 'data:image/jpeg;base64,AAAA' }))
      .toThrowError();
  });
});
