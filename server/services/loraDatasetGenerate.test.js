import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the data deps so getDatasetVariationAxes can be exercised without a
// real universe/dataset store — it's a thin getDataset → live-subject →
// deriveVariationAxes wrapper, and the live-subject lookup is the part the
// pure-function tests above can't cover.
vi.mock('./loraDatasets.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getDataset: vi.fn(),
  updateDataset: vi.fn(async () => ({})),
  datasetImagesDir: vi.fn(() => '/tmp/ds-images'),
  datasetImagePath: vi.fn((id, file) => `/tmp/ds-images/${file}`),
}));
vi.mock('./universeBuilder.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getUniverse: vi.fn(),
}));

// sharp is only exercised by the slice path — stub the metadata() probe and the
// extract().png().toFile() crop chain so the grid-fallback test never touches a
// real image. The chainable mock records each extract rect for assertions, and
// `sheetMeta` lets a test set the reported sheet dimensions.
const extractCalls = [];
const sheetMeta = { width: 900, height: 600 };
vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    metadata: vi.fn(async () => ({ ...sheetMeta })),
    extract: vi.fn(function extract(rect) { extractCalls.push(rect); return this; }),
    png: vi.fn(function png() { return this; }),
    toFile: vi.fn(async () => ({})),
  })),
}));

import {
  buildDatasetImagePrompt, deriveVariationAxes, getDatasetVariationAxes,
  normalizeCropProposals, proposeCropRegions, sliceReferenceSheet,
} from './loraDatasetGenerate.js';
import { getDataset, updateDataset } from './loraDatasets.js';
import { getUniverse } from './universeBuilder.js';

// Pure-function coverage for the kind-aware prompt builder + variation axes.
// These are the highest-risk new logic in the object/place feature: a
// regression in the subject block or negative-prompt selection would ship
// silently because the renders themselves are non-deterministic.

const UNIVERSE = { artStyle: 'gritty ink-and-wash fantasy' };

describe('buildDatasetImagePrompt', () => {
  it('renders a single-figure character prompt (default kind)', () => {
    const { prompt, negativePrompt } = buildDatasetImagePrompt(
      UNIVERSE,
      { name: 'Kessa', role: 'ranger' },
      {},
    );
    expect(prompt).toContain('Character: Kessa.');
    expect(prompt).toContain('Solo subject');
    expect(prompt).toContain('full body in frame');
    expect(negativePrompt).toContain('distorted anatomy');
    // Character branch never emits the object/location subject markers.
    expect(prompt).not.toContain('Single object only');
    expect(prompt).not.toContain('Single location focus');
  });

  it('renders a single-object prompt with the object negative prompt', () => {
    const subject = {
      name: 'Northwind Truthbreaker',
      description: 'A rune-bitten greataxe.',
      tags: ['weapon', 'relic'],
    };
    const { prompt, negativePrompt } = buildDatasetImagePrompt(UNIVERSE, subject, {}, 'objects');
    expect(prompt).toContain('Object: Northwind Truthbreaker.');
    expect(prompt).toContain('Description: A rune-bitten greataxe.');
    expect(prompt).toContain('Tags: weapon, relic.');
    expect(prompt).toContain('Single object only');
    expect(prompt).toContain('full object in frame');
    expect(negativePrompt).toContain('multiple objects');
    expect(negativePrompt).toContain('hands covering the object');
    expect(prompt).not.toContain('Character:');
  });

  it('renders a single-location prompt with the place negative prompt', () => {
    const subject = { name: 'Moonsea Shore', description: 'Black water under cold stars.' };
    const { prompt, negativePrompt } = buildDatasetImagePrompt(UNIVERSE, subject, {}, 'places');
    expect(prompt).toContain('Place: Moonsea Shore.');
    expect(prompt).toContain('Single location focus');
    expect(prompt).toContain('no prominent characters');
    expect(negativePrompt).toContain('prominent character');
    expect(negativePrompt).toContain('distorted perspective');
    expect(prompt).not.toContain('Single object only');
  });

  it('falls back to slugline + Unnamed and tolerates absent canon fields', () => {
    const { prompt } = buildDatasetImagePrompt(UNIVERSE, { slugline: 'INT. CRYPT' }, {}, 'places');
    expect(prompt).toContain('Place: INT. CRYPT.');
    const empty = buildDatasetImagePrompt(UNIVERSE, {}, {}, 'objects');
    expect(empty.prompt).toContain('Object: Unnamed.');
  });

  it('applies variation overrides to the object subject block', () => {
    const { prompt } = buildDatasetImagePrompt(
      UNIVERSE,
      { name: 'Truthbreaker' },
      { view: 'top-down view', expression: 'warm firelight', outfit: 'weathered wooden table' },
      'objects',
    );
    expect(prompt).toContain('top-down view');
    expect(prompt).toContain('warm firelight');
    expect(prompt).toContain('setting: weathered wooden table');
  });

  it('treats an unknown kind as characters', () => {
    const { negativePrompt } = buildDatasetImagePrompt(UNIVERSE, { name: 'X' }, {}, 'bogus');
    expect(negativePrompt).toContain('distorted anatomy');
  });
});

describe('deriveVariationAxes', () => {
  it('returns lighting/setting axes for objects', () => {
    const axes = deriveVariationAxes({ entryKind: 'objects' });
    expect(axes.expressions).toContain('soft studio lighting');
    expect(axes.outfits).toContain('plain studio plinth');
  });

  it('returns lighting/setting axes for places', () => {
    const axes = deriveVariationAxes({ entryKind: 'places' });
    expect(axes.expressions).toContain('clear daylight');
    expect(axes.outfits).toContain('signature environment');
  });

  it('derives character axes from canon expressions/wardrobes', () => {
    const axes = deriveVariationAxes({
      entryKind: 'characters',
      expressions: [{ name: 'smiling' }, { name: 'scowling' }],
      wardrobes: [{ name: 'battle armor' }],
    });
    expect(axes.expressions).toEqual(['smiling', 'scowling']);
    expect(axes.outfits).toEqual(['battle armor']);
  });

  it('falls back to default character axes when canon is empty', () => {
    const axes = deriveVariationAxes({});
    expect(axes.expressions.length).toBeGreaterThan(0);
    expect(axes.outfits).toEqual(['signature outfit']);
  });
});

describe('getDatasetVariationAxes', () => {
  beforeEach(() => {
    getDataset.mockReset();
    getUniverse.mockReset();
  });

  it('returns lighting/setting axes for an object subject', async () => {
    getDataset.mockResolvedValue({ character: { entryKind: 'objects', universeId: 'u1', entryId: 'o1' } });
    getUniverse.mockResolvedValue({ objects: [{ id: 'o1', name: 'Runed Blade' }] });

    const axes = await getDatasetVariationAxes('ds1');
    expect(axes.expressions).toContain('soft studio lighting');
    expect(axes.outfits).toContain('plain studio plinth');
  });

  it('derives character axes from the live canon subject', async () => {
    getDataset.mockResolvedValue({ character: { entryKind: 'characters', universeId: 'u1', entryId: 'c1' } });
    getUniverse.mockResolvedValue({
      characters: [{ id: 'c1', name: 'Kessa', expressions: [{ name: 'smiling' }], wardrobes: [{ name: 'ranger cloak' }] }],
    });

    const axes = await getDatasetVariationAxes('ds1');
    expect(axes.expressions).toEqual(['smiling']);
    expect(axes.outfits).toEqual(['ranger cloak']);
  });

  it('throws 409 when the subject was deleted from the universe', async () => {
    getDataset.mockResolvedValue({ character: { entryKind: 'places', universeId: 'u1', entryId: 'gone' } });
    getUniverse.mockResolvedValue({ places: [] });

    await expect(getDatasetVariationAxes('ds1')).rejects.toMatchObject({ status: 409 });
  });
});

describe('normalizeCropProposals', () => {
  const dims = { width: 1000, height: 800 };

  it('scales normalized boxes to pixel extract rects', () => {
    const rects = normalizeCropProposals({ boxes: [{ x: 0, y: 0, w: 0.5, h: 0.5 }] }, dims);
    expect(rects).toEqual([{ left: 0, top: 0, width: 500, height: 400 }]);
  });

  it('accepts a bare array of boxes (no wrapper object)', () => {
    const rects = normalizeCropProposals([{ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }], dims);
    expect(rects).toEqual([{ left: 500, top: 400, width: 500, height: 400 }]);
  });

  it('clamps a box that overhangs the sheet edge instead of throwing', () => {
    const rects = normalizeCropProposals({ boxes: [{ x: 0.8, y: 0.8, w: 0.5, h: 0.5 }] }, dims);
    // x+w = 1.3 → clamped to 1.0; rect spans the bottom-right corner.
    expect(rects).toEqual([{ left: 800, top: 640, width: 200, height: 160 }]);
  });

  it('drops sub-64px boxes (label strips / palette swatches)', () => {
    const rects = normalizeCropProposals({
      boxes: [
        { x: 0, y: 0, w: 0.01, h: 0.5 }, // 10px wide → rejected
        { x: 0, y: 0, w: 0.5, h: 0.5 },  // kept
      ],
    }, dims);
    expect(rects).toHaveLength(1);
    expect(rects[0]).toMatchObject({ width: 500 });
  });

  it('drops boxes with non-finite or missing coordinates', () => {
    const rects = normalizeCropProposals({
      boxes: [
        { x: 0, y: 0, w: 0.5 },            // missing h
        { x: NaN, y: 0, w: 0.5, h: 0.5 },  // NaN
        { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, // kept
      ],
    }, dims);
    expect(rects).toHaveLength(1);
  });

  it('returns [] for garbage, non-array boxes, or zero dims', () => {
    expect(normalizeCropProposals(null, dims)).toEqual([]);
    expect(normalizeCropProposals({ boxes: 'nope' }, dims)).toEqual([]);
    expect(normalizeCropProposals({ boxes: [{ x: 0, y: 0, w: 0.5, h: 0.5 }] }, { width: 0, height: 0 })).toEqual([]);
  });
});

describe('proposeCropRegions', () => {
  const dims = { width: 900, height: 600 };
  // Inject readImage so we don't touch disk — the function reads the sheet to
  // base64 it before the (also-injected) vision call.
  const readImage = vi.fn().mockResolvedValue(Buffer.from('fake-png'));

  it('returns pixel rects from a clean vision reply', async () => {
    const describeImage = vi.fn().mockResolvedValue({
      text: '{"boxes":[{"x":0,"y":0,"w":0.5,"h":1.0}]}',
    });
    const resolveModel = vi.fn().mockResolvedValue({ providerId: 'lmstudio', model: 'qwen2.5-vl' });
    const rects = await proposeCropRegions('/sheet.png', dims, { describeImage, resolveModel, readImage });
    expect(rects).toEqual([{ left: 0, top: 0, width: 450, height: 600 }]);
    expect(describeImage).toHaveBeenCalledOnce();
  });

  it('tolerates a CLI-banner-prefixed / code-fenced reply', async () => {
    const describeImage = vi.fn().mockResolvedValue({
      text: 'session id: abc\n```json\n{"boxes":[{"x":0.5,"y":0,"w":0.5,"h":1}]}\n```',
    });
    const resolveModel = vi.fn().mockResolvedValue({ providerId: 'codex', model: 'gpt-5' });
    const rects = await proposeCropRegions('/sheet.png', dims, { describeImage, resolveModel, readImage });
    expect(rects).toEqual([{ left: 450, top: 0, width: 450, height: 600 }]);
  });

  it('parses the bare top-level array form (not just {boxes:[…]})', async () => {
    const describeImage = vi.fn().mockResolvedValue({
      text: '[{"x":0,"y":0,"w":0.5,"h":1.0}]',
    });
    const resolveModel = vi.fn().mockResolvedValue({ providerId: 'lmstudio', model: 'qwen2.5-vl' });
    const rects = await proposeCropRegions('/sheet.png', dims, { describeImage, resolveModel, readImage });
    expect(rects).toEqual([{ left: 0, top: 0, width: 450, height: 600 }]);
  });

  it('returns [] (→ grid fallback) when no vision model resolves', async () => {
    const describeImage = vi.fn();
    const resolveModel = vi.fn().mockRejectedValue(new Error('no vision model'));
    const rects = await proposeCropRegions('/sheet.png', dims, { describeImage, resolveModel, readImage });
    expect(rects).toEqual([]);
    expect(describeImage).not.toHaveBeenCalled();
  });

  it('returns [] when the vision call throws (transport error)', async () => {
    const describeImage = vi.fn().mockRejectedValue(new Error('timeout'));
    const resolveModel = vi.fn().mockResolvedValue({ providerId: 'lmstudio', model: 'qwen2.5-vl' });
    const rects = await proposeCropRegions('/sheet.png', dims, { describeImage, resolveModel, readImage });
    expect(rects).toEqual([]);
  });

  it('returns [] when the reply has no parseable boxes', async () => {
    const describeImage = vi.fn().mockResolvedValue({ text: 'I could not find any figures.' });
    const resolveModel = vi.fn().mockResolvedValue({ providerId: 'lmstudio', model: 'qwen2.5-vl' });
    const rects = await proposeCropRegions('/sheet.png', dims, { describeImage, resolveModel, readImage });
    expect(rects).toEqual([]);
  });
});

describe('sliceReferenceSheet — grid fallback path', () => {
  beforeEach(() => {
    extractCalls.length = 0;
    sheetMeta.width = 900;
    sheetMeta.height = 600;
    getDataset.mockReset();
    getUniverse.mockReset();
    updateDataset.mockClear();
  });

  // The load-bearing path: most installs have no vision model, so `useVision:
  // false` (or an empty vision result) falls through to the fixed cols×rows
  // grid. Stubbed sharp reports 900×600; a 3×2 grid yields six 300×300 crops.
  const wireSubject = () => {
    getDataset.mockResolvedValue({
      id: 'ds1',
      character: { entryKind: 'characters', universeId: 'u1', entryId: 'c1' },
      images: [],
    });
    getUniverse.mockResolvedValue({
      characters: [{ id: 'c1', name: 'Kessa', referenceSheetImageRef: 'kessa-sheet.png' }],
    });
  };

  it('emits cols×rows grid crops when useVision is false', async () => {
    wireSubject();
    const result = await sliceReferenceSheet('ds1', { cols: 3, rows: 2, useVision: false });
    expect(result.method).toBe('grid');
    expect(result.images).toHaveLength(6);
    // Every crop is a 300×300 grid cell.
    expect(extractCalls).toHaveLength(6);
    expect(extractCalls.every((r) => r.width === 300 && r.height === 300)).toBe(true);
    expect(result.images.every((img) => img.source === 'refsheet-slice' && img.status === 'ready')).toBe(true);
    expect(updateDataset).toHaveBeenCalledOnce();
  });

  it('rejects a 400 when the grid cells would be smaller than 64px', async () => {
    wireSubject();
    // A small sheet: 300/6 = 50px cells, below the 64px MIN_CROP floor.
    sheetMeta.width = 300;
    sheetMeta.height = 300;
    await expect(sliceReferenceSheet('ds1', { cols: 6, rows: 6, useVision: false }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('throws 409 when the subject has no reference sheet', async () => {
    getDataset.mockResolvedValue({
      id: 'ds1', character: { entryKind: 'characters', universeId: 'u1', entryId: 'c1' }, images: [],
    });
    getUniverse.mockResolvedValue({ characters: [{ id: 'c1', name: 'Kessa' }] }); // no referenceSheetImageRef
    await expect(sliceReferenceSheet('ds1', { useVision: false }))
      .rejects.toMatchObject({ status: 409, code: 'LORA_DATASET_NO_SHEET' });
  });
});
