/**
 * Loop trimmer (#2897): non-destructive re-pack of enabled strip cells into
 * versioned strip + GIF + manifest, with all geometry derived from the run's
 * packaged manifest. ffmpeg is mocked (the GIF encode is a spawn); the pixel
 * re-pack is asserted for real via sharp.
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
const PHASES4 = ['left-contact', 'left-down', 'left-passing', 'left-up'];
const RUN_ID = 'walk-east-00000000';

let seq = 0;
const newId = () => `trimmer-${++seq}`;

async function characterWithRun(id) {
  await records.createRecord({ kind: 'character', name: 'Trimmer' }, id);
  const width = CELL * CELL_COLORS.length;
  const buf = Buffer.alloc(width * CELL * 4);
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < width; x++) {
      buf.set(CELL_COLORS[Math.floor(x / CELL)], (y * width + x) * 4);
    }
  }
  const runDir = join(TEST_ROOT, 'sprites', id, 'grok', RUN_ID);
  await mkdir(join(runDir, 'generated'), { recursive: true });
  const stripRel = `grok/${RUN_ID}/generated/strip.png`;
  await sharp(buf, { raw: { width, height: CELL, channels: 4 } }).png()
    .toFile(join(runDir, 'generated', 'strip.png'));
  const manifestRel = `grok/${RUN_ID}/generated/manifest.json`;
  await writeFile(join(runDir, 'generated', 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    stripPath: stripRel,
    frameRate: 12,
    frameCount: 4,
    alignment: { cellSize: CELL },
    frames: PHASES4.map((phase, outputIndex) => ({ outputIndex, phase })),
  }));
  await writeFile(join(runDir, 'animation-run.json'), JSON.stringify({
    schemaVersion: 1, id: RUN_ID, status: 'candidate', direction: 'east', postprocessManifest: manifestRel,
  }));
  return id;
}

// An imagegen redraw run (source pipeline's video-first path): a real packed
// strip under imagegen/vN plus a redraw manifest and an approved selection
// entry — no grok/ run record. getWalkState synthesizes the run from these.
const REDRAW_CELL = 8;
const REDRAW_COLORS = [
  [255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255],
  [255, 255, 0, 255], [255, 0, 255, 255], [0, 255, 255, 255],
];
async function characterWithRedrawRun(id, { frameCount = 6 } = {}) {
  await records.createRecord({ kind: 'character', name: 'Redraw' }, id);
  const width = REDRAW_CELL * frameCount;
  const buf = Buffer.alloc(width * REDRAW_CELL * 4);
  for (let y = 0; y < REDRAW_CELL; y++) {
    for (let x = 0; x < width; x++) {
      buf.set(REDRAW_COLORS[Math.floor(x / REDRAW_CELL)], (y * width + x) * 4);
    }
  }
  const igDir = join(TEST_ROOT, 'sprites', id, 'imagegen', 'v1');
  await mkdir(igDir, { recursive: true });
  await sharp(buf, { raw: { width, height: REDRAW_CELL, channels: 4 } }).png()
    .toFile(join(igDir, 'clean-alpha.png'));
  const manifestRel = 'imagegen/v1/redraw-manifest.json';
  await writeFile(join(TEST_ROOT, 'sprites', id, manifestRel), JSON.stringify({
    schemaVersion: 1, characterId: id, direction: 'east', cellSize: REDRAW_CELL,
    cycle: { frameCount, referenceFps: 10, stripAlpha: 'imagegen/v1/clean-alpha.png' },
  }));
  await mkdir(join(TEST_ROOT, 'sprites', id, 'walk'), { recursive: true });
  await writeFile(join(TEST_ROOT, 'sprites', id, 'walk', `${id}-walk-selection-v1.json`), JSON.stringify({
    schemaVersion: 1, kind: 'reviewed-directional-walk-selection', characterId: id, status: 'in-progress',
    directions: { east: { status: 'approved', runId: `${id}-redraw-east`, runManifest: manifestRel, approvedAt: 'v1' } },
  }));
  return `${id}-redraw-east`;
}

beforeEach(() => {
  runFfmpegProcess.mockClear();
  rmSync(join(TEST_ROOT, 'sprite-records.json'), { force: true });
});
afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

describe('saveLoopTrim', () => {
  it('re-packs only the enabled cells with manifest-derived geometry and labels', async () => {
    const id = await characterWithRun(newId());
    const result = await saveLoopTrim(id, { runId: RUN_ID, enabledColumns: [0, 2, 3] });
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
      runId: RUN_ID,
      sourceAtlasPath: `grok/${RUN_ID}/generated/strip.png`,
      row: 0,
      cellWidth: CELL,
      fps: 12, // derived from the run manifest's frameRate
      allAtlasColumns: [0, 1, 2, 3],
      enabledAtlasColumns: [0, 2, 3],
      disabledAtlasColumns: [1],
    });
    expect(manifest.selectedFrames).toEqual([
      { outputIndex: 0, atlasColumn: 0, sourceFrameIndex: 0, sourceFrameLabel: 'left-contact' },
      { outputIndex: 1, atlasColumn: 2, sourceFrameIndex: 2, sourceFrameLabel: 'left-passing' },
      { outputIndex: 2, atlasColumn: 3, sourceFrameIndex: 3, sourceFrameLabel: 'left-up' },
    ]);
    expect(manifest.sourceAtlasSha256).toMatch(/^[0-9a-f]{64}$/);
    // GIF encoded through the ffmpeg primitive with the manifest fps.
    const gifArgs = runFfmpegProcess.mock.calls[0][0].args;
    expect(gifArgs[gifArgs.indexOf('-framerate') + 1]).toBe('12');
  });

  it('versions successive trims and honors fps/slug overrides', async () => {
    const id = await characterWithRun(newId());
    await saveLoopTrim(id, { runId: RUN_ID, enabledColumns: [0, 1] });
    const second = await saveLoopTrim(id, { runId: RUN_ID, enabledColumns: [0, 1], fps: 6, slug: 'custom' });
    expect(second.strip).toBe('walk/trims/custom-v001-strip.png');
    const gifArgs = runFfmpegProcess.mock.calls[1][0].args;
    expect(gifArgs[gifArgs.indexOf('-framerate') + 1]).toBe('6');
    const third = await saveLoopTrim(id, { runId: RUN_ID, enabledColumns: [0, 1] });
    expect(third.strip).toBe('walk/trims/east-loop-v002-strip.png');
  });

  // The whole point of the vendor-neutral trim path: a direction whose art came
  // from the source pipeline's imagegen redraw (e.g. pioneer's east) has no
  // grok/ run behind it, yet its packed strip is trimmable all the same —
  // geometry now comes from the run's stripPreview, resolved layout-agnostically.
  it('trims an imagegen-redraw run resolved by stripPreview (no grok/ dir)', async () => {
    const id = newId();
    const runId = await characterWithRedrawRun(id, { frameCount: 6 });

    const result = await saveLoopTrim(id, { runId, enabledColumns: [0, 2, 4] });
    expect(result).toMatchObject({
      strip: 'walk/trims/east-loop-v001-strip.png',
      frameCount: 3,
      disabledFrameCount: 3,
    });
    const { data, info } = await sharp(join(TEST_ROOT, 'sprites', id, result.strip))
      .raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(REDRAW_CELL * 3);
    const px = (x) => [...data.subarray(x * 4, x * 4 + 4)];
    expect(px(0)).toEqual(REDRAW_COLORS[0]);           // column 0
    expect(px(REDRAW_CELL)).toEqual(REDRAW_COLORS[2]); // column 2
    expect(px(REDRAW_CELL * 2)).toEqual(REDRAW_COLORS[4]); // column 4

    const manifest = JSON.parse(await readFile(join(TEST_ROOT, 'sprites', id, result.manifest), 'utf8'));
    expect(manifest).toMatchObject({
      runId, // the redraw run id round-trips (not a walk-<dir>-<hex> shape)
      sourceAtlasPath: 'imagegen/v1/clean-alpha.png',
      fps: 10, // from the redraw cycle's referenceFps
      allAtlasColumns: [0, 1, 2, 3, 4, 5],
      enabledAtlasColumns: [0, 2, 4],
    });
    // No named gait phases on a redraw cycle → columns label numerically.
    expect(manifest.selectedFrames.map((f) => f.sourceFrameLabel)).toEqual(['0', '2', '4']);
  });

  it('rejects unknown runs, unpackaged runs, and out-of-strip columns', async () => {
    const id = await characterWithRun(newId());
    await expect(saveLoopTrim(id, { runId: 'walk-east-deadbeef', enabledColumns: [0, 1] }))
      .rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
    await expect(saveLoopTrim(id, { runId: RUN_ID, enabledColumns: [0, 9] }))
      .rejects.toMatchObject({ code: 'TRIM_COLUMNS_INVALID' });
    const runDir = join(TEST_ROOT, 'sprites', id, 'grok', RUN_ID);
    await writeFile(join(runDir, 'animation-run.json'), JSON.stringify({
      schemaVersion: 1, id: RUN_ID, status: 'queued', direction: 'east',
    }));
    await expect(saveLoopTrim(id, { runId: RUN_ID, enabledColumns: [0, 1] }))
      .rejects.toMatchObject({ code: 'RUN_NOT_CANDIDATE' });
  });
});
