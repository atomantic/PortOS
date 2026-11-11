import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import sharp from 'sharp';

const files = vi.hoisted(() => ({ dir: '' }));
vi.mock('../lib/pathSafety.js', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveImageInputPath: (path) => (basename(path).startsWith('sheet-') ? join(files.dir, basename(path)) : null),
}));

const { COMPARISON_HALF_ROLE, COMPARISON_SHEET_ROLE, publishComparisonSheet } = await import('./catalogComparisonSheet.js');

// A catalog that accepts every attach, for the cases that only watch the cut.
const openDb = { getIngredient: async (id) => ({ id }), attachGeneratedMedia: async () => ({ attached: true }) };

// Left half red, right half blue, so a cut one column off shows in the pixels.
async function writeSheet(name, width, height = 8) {
  const centre = Math.floor(width / 2);
  const half = (w, background) => sharp({ create: { width: w, height, channels: 3, background } }).png().toBuffer();
  await sharp({ create: { width, height, channels: 3, background: '#000000' } })
    .composite([{ input: await half(centre, '#ff0000'), left: 0, top: 0 }, { input: await half(width - centre, '#0000ff'), left: centre, top: 0 }])
    .png().toFile(join(files.dir, name));
}

const describeHalf = async (base64) => {
  const buffer = Buffer.from(base64, 'base64');
  const { width, height } = await sharp(buffer).metadata();
  const { data } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixel = (x) => [...data.subarray(x * 3, x * 3 + 3)];
  return { width, height, first: pixel(0), last: pixel(width - 1) };
};

describe('comparison sheet', () => {
  beforeAll(async () => { files.dir = await mkdtemp(join(tmpdir(), 'comparison-sheet-')); });
  afterAll(async () => { await rm(files.dir, { recursive: true, force: true }); });

  // The halves are the solo references: a cut off the centre column would put
  // a sliver of the other character on one of them.
  it('cuts a sheet at its exact vertical centre, giving an odd column to the right half', async () => {
    const saved = [];
    const saveImage = async (base64) => { saved.push(await describeHalf(base64)); return { filename: `half-${saved.length}.png` }; };
    const cut = (filename) => publishComparisonSheet({ ingredientId: 'a', partnerId: 'b', filename }, { db: openDb, saveImage });
    await writeSheet('sheet-even.png', 20);
    expect(await cut('sheet-even.png')).toEqual({ partner: 'b', left: 'half-1.png', right: 'half-2.png' });
    expect(saved[0]).toEqual({ width: 10, height: 8, first: [255, 0, 0], last: [255, 0, 0] });
    expect(saved[1]).toEqual({ width: 10, height: 8, first: [0, 0, 255], last: [0, 0, 255] });
    await writeSheet('sheet-odd.png', 21);
    await cut('sheet-odd.png');
    expect(saved.slice(2).map((half) => half.width)).toEqual([10, 11]);
    await expect(cut('missing.png')).rejects.toMatchObject({ status: 404 });
  });

  // Three images from one render: the whole sheet on the partner too, and each
  // record's own half. A repeated completion must not cut and file them twice.
  it('files the shared sheet on the partner and one half on each record, once', async () => {
    await writeSheet('sheet-pair.png', 20);
    const rows = [];
    const db = {
      getIngredient: async (id) => (id === 'gone' ? null : { id }),
      attachGeneratedMedia: async (ingredientId, mediaKey, options) => {
        if (rows.some((row) => row.ingredientId === ingredientId && row.mediaKey === mediaKey)) return { attached: false };
        rows.push({ ingredientId, mediaKey, role: options.role, kind: options.kind, derivedFrom: options.library?.derivedFrom?.mediaKey ?? null, comparedWith: options.library?.comparedWith ?? null });
        return { attached: true };
      },
    };
    let n = 0;
    const saveImage = async () => ({ filename: `half-${++n}.png` });
    const input = { ingredientId: 'a', partnerId: 'b', filename: 'sheet-pair.png' };
    expect(await publishComparisonSheet(input, { db, saveImage })).toEqual({ partner: 'b', left: 'half-1.png', right: 'half-2.png' });
    expect(rows).toEqual([
      { ingredientId: 'b', mediaKey: 'sheet-pair.png', role: COMPARISON_SHEET_ROLE, kind: 'reference', derivedFrom: null, comparedWith: null },
      { ingredientId: 'a', mediaKey: 'half-1.png', role: COMPARISON_HALF_ROLE, kind: 'reference', derivedFrom: 'sheet-pair.png', comparedWith: null },
      { ingredientId: 'b', mediaKey: 'half-2.png', role: COMPARISON_HALF_ROLE, kind: 'reference', derivedFrom: 'sheet-pair.png', comparedWith: null },
    ]);
    expect(await publishComparisonSheet(input, { db, saveImage })).toBeNull();
    expect(await publishComparisonSheet({ ...input, partnerId: 'gone' }, { db, saveImage })).toBeNull();
    expect(await publishComparisonSheet({ ...input, partnerId: 'a' }, { db, saveImage })).toBeNull();
    expect(rows).toHaveLength(3);
  });
});
