/**
 * Loop trimmer (#2897): non-destructive re-pack of enabled atlas cells into
 * versioned strip + GIF + manifest. ffmpeg is mocked (the GIF encode is a
 * spawn); the pixel re-pack is asserted for real via sharp.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { writeFile, mkdir, readFile } from 'fs/promises';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'sprite-trim-test-'));

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  Object.assign(actual.PATHS, {
    data: TEST_ROOT,
    sprites: join(TEST_ROOT, 'sprites'),
  });
  return actual;
});

const runFfmpegProcess = vi.fn(async ({ args }) => {
  await writeFile(args[args.length - 1], 'GIF89a-stub');
  return { ok: true };
});
vi.mock('../../lib/ffmpeg.js', () => ({
  findFfmpeg: async () => '/fake/ffmpeg',
  runFfmpegProcess: (...args) => runFfmpegProcess(...args),
}));

const records = await import('./records.js');
const { saveLoopTrim } = await import('./walkTrims.js');

const CELL = 8;
// Four 8×8 cells with distinct solid colors in one row.
const CELL_COLORS = [
  [255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 0, 255],
];

let seq = 0;
const newId = () => `trimmer-${++seq}`;

async function characterWithAtlas(id) {
  await records.createRecord({ kind: 'character', name: 'Trimmer' }, id);
  const width = CELL * CELL_COLORS.length;
  const buf = Buffer.alloc(width * CELL * 4);
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < width; x++) {
      buf.set(CELL_COLORS[Math.floor(x / CELL)], (y * width + x) * 4);
    }
  }
  const dir = join(TEST_ROOT, 'sprites', id, 'grok', 'walk-east-00000000', 'generated');
  await mkdir(dir, { recursive: true });
  await sharp(buf, { raw: { width, height: CELL, channels: 4 } }).png().toFile(join(dir, 'strip.png'));
  return { id, atlasPath: 'grok/walk-east-00000000/generated/strip.png' };
}

const basePayload = (atlasPath) => ({
  slug: 'east-loop',
  atlasPath,
  row: 0,
  cellWidth: CELL,
  cellHeight: CELL,
  fps: 12,
  allColumns: [0, 1, 2, 3],
  enabledColumns: [0, 2, 3],
});

beforeEach(() => {
  runFfmpegProcess.mockClear();
  rmSync(join(TEST_ROOT, 'sprite-records.json'), { force: true });
});
afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

describe('saveLoopTrim', () => {
  it('re-packs only the enabled cells, in order, without resampling', async () => {
    const { id, atlasPath } = await characterWithAtlas(newId());
    const result = await saveLoopTrim(id, basePayload(atlasPath));
    expect(result).toMatchObject({
      strip: 'walk/trims/east-loop-v001-strip.png',
      loop: 'walk/trims/east-loop-v001.gif',
      manifest: 'walk/trims/east-loop-v001.json',
      frameCount: 3,
      disabledFrameCount: 1,
    });
    const { data, info } = await sharp(join(TEST_ROOT, 'sprites', id, result.strip))
      .raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(CELL * 3);
    expect(info.height).toBe(CELL);
    const px = (x) => [...data.subarray(x * 4, x * 4 + 4)];
    expect(px(0)).toEqual(CELL_COLORS[0]);         // column 0
    expect(px(CELL)).toEqual(CELL_COLORS[2]);      // column 2 (1 disabled)
    expect(px(CELL * 2)).toEqual(CELL_COLORS[3]);  // column 3

    const manifest = JSON.parse(await readFile(join(TEST_ROOT, 'sprites', id, result.manifest), 'utf8'));
    expect(manifest).toMatchObject({
      kind: 'animation-loop-trim',
      status: 'candidate',
      sourceAtlasPath: atlasPath,
      row: 0,
      fps: 12,
      allAtlasColumns: [0, 1, 2, 3],
      enabledAtlasColumns: [0, 2, 3],
      disabledAtlasColumns: [1],
    });
    expect(manifest.selectedFrames).toEqual([
      { outputIndex: 0, atlasColumn: 0, sourceFrameIndex: 0, sourceFrameLabel: '0' },
      { outputIndex: 1, atlasColumn: 2, sourceFrameIndex: 2, sourceFrameLabel: '2' },
      { outputIndex: 2, atlasColumn: 3, sourceFrameIndex: 3, sourceFrameLabel: '3' },
    ]);
    expect(manifest.sourceAtlasSha256).toMatch(/^[0-9a-f]{64}$/);
    // GIF encoded through the ffmpeg primitive with the requested fps.
    const gifArgs = runFfmpegProcess.mock.calls[0][0].args;
    expect(gifArgs).toContain('-framerate');
    expect(gifArgs[gifArgs.indexOf('-framerate') + 1]).toBe('12');
  });

  it('versions successive trims of the same slug', async () => {
    const { id, atlasPath } = await characterWithAtlas(newId());
    await saveLoopTrim(id, basePayload(atlasPath));
    const second = await saveLoopTrim(id, basePayload(atlasPath));
    expect(second.strip).toBe('walk/trims/east-loop-v002-strip.png');
  });

  it('rejects a non-subset, mismatched labels, and out-of-bounds cells', async () => {
    const { id, atlasPath } = await characterWithAtlas(newId());
    await expect(saveLoopTrim(id, { ...basePayload(atlasPath), enabledColumns: [0, 9] }))
      .rejects.toMatchObject({ code: 'TRIM_COLUMNS_INVALID' });
    await expect(saveLoopTrim(id, { ...basePayload(atlasPath), sourceFrameLabels: ['only-one'] }))
      .rejects.toMatchObject({ code: 'TRIM_COLUMNS_INVALID' });
    await expect(saveLoopTrim(id, { ...basePayload(atlasPath), allColumns: [0, 1, 2, 3, 4], enabledColumns: [0, 4] }))
      .rejects.toMatchObject({ code: 'TRIM_BOUNDS_INVALID' });
    await expect(saveLoopTrim(id, { ...basePayload(atlasPath), atlasPath: 'grok/nope.png' }))
      .rejects.toMatchObject({ code: 'ATLAS_NOT_FOUND' });
  });
});
