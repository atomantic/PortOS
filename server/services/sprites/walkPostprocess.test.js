/**
 * Deterministic walk postprocess (#2897): the per-pixel un-key/despill math,
 * cycle selection (including Python round-half-to-even parity), alignment
 * geometry, packing, and validation — all on synthetic raw frames, no ffmpeg.
 * The video-in e2e lives in walkPostprocess.e2e.test.js (ffmpeg-gated).
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import {
  pyRound, pyRoundTo, median, sampleBorderKey, validateMeasuredKey,
  recoverAlphaFrame, despillKeyFrame, imageDistance, selectCycleIndices,
  alphaBbox, rootX, alignFrames, packStrip, validateFrames, buildContrastSheet,
  prepareWalkAnchorInput, WALK_PHASES, WALK_CELL_SIZE, WALK_FRAME_COUNT,
} from './walkPostprocess.js';
import { keyChannelSplit } from './chromaKey.js';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'sprite-walkpp-test-'));
afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

const MAGENTA = keyChannelSplit('#FF00FF');
const GREEN = keyChannelSplit('#00FF00');

function makeFrame(width, height, fill = [0, 0, 0, 0]) {
  const data = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p++) data.set(fill, p * 4);
  return { data, width, height };
}

function setPx(frame, x, y, rgba) {
  frame.data.set(rgba, (y * frame.width + x) * 4);
}

function getPx(frame, x, y) {
  const i = (y * frame.width + x) * 4;
  return [...frame.data.subarray(i, i + 4)];
}

function fillRect(frame, x0, y0, x1, y1, rgba) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) setPx(frame, x, y, rgba);
}

describe('pyRound / pyRoundTo / median', () => {
  it('rounds half to even like Python', () => {
    expect(pyRound(0.5)).toBe(0);
    expect(pyRound(1.5)).toBe(2);
    expect(pyRound(2.5)).toBe(2);
    expect(pyRound(3.5)).toBe(4);
    expect(pyRound(-0.5)).toBe(0);
    expect(pyRound(-1.5)).toBe(-2);
    expect(pyRound(2.4)).toBe(2);
    expect(pyRound(2.6)).toBe(3);
  });

  it('rounds to decimals', () => {
    expect(pyRoundTo(1.23456789, 4)).toBeCloseTo(1.2346, 10);
    expect(pyRoundTo(10.123, 2)).toBeCloseTo(10.12, 10);
  });

  it('median matches statistics.median', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe('sampleBorderKey / validateMeasuredKey', () => {
  it('measures the border matte, ignoring the character', () => {
    const frame = makeFrame(64, 64, [250, 5, 252, 255]);
    fillRect(frame, 20, 20, 44, 44, [10, 200, 30, 255]);
    expect(sampleBorderKey(frame)).toEqual([250, 5, 252]);
  });

  it('accepts a balanced key and rejects dim or lopsided ones', () => {
    expect(() => validateMeasuredKey([250, 5, 252], MAGENTA, '#FF00FF')).not.toThrow();
    expect(() => validateMeasuredKey([120, 60, 120], MAGENTA, '#FF00FF')).toThrow(/matte/);
    expect(() => validateMeasuredKey([255, 0, 100], MAGENTA, '#FF00FF')).toThrow(/matte/);
    expect(() => validateMeasuredKey([5, 250, 8], GREEN, '#00FF00')).not.toThrow();
    // A magenta screen is not a usable green matte.
    expect(() => validateMeasuredKey([250, 5, 252], GREEN, '#00FF00')).toThrow(/matte/);
  });
});

describe('recoverAlphaFrame', () => {
  const key = [255, 0, 255];

  it('zeroes pure key pixels and passes character pixels through opaque', () => {
    const frame = makeFrame(2, 1);
    setPx(frame, 0, 0, [255, 0, 255, 255]);
    setPx(frame, 1, 0, [30, 120, 40, 255]);
    const out = recoverAlphaFrame(frame, key, MAGENTA);
    expect(getPx(out, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(getPx(out, 1, 0)).toEqual([30, 120, 40, 255]);
  });

  it('unmixes an antialiased edge pixel with the alpha ramp', () => {
    const frame = makeFrame(1, 1);
    // 50/50 blend of black character over the key.
    setPx(frame, 0, 0, [128, 0, 128, 255]);
    const [r, g, b, a] = getPx(recoverAlphaFrame(frame, key, MAGENTA), 0, 0);
    const share = 128 / 255;
    const sourceAlpha = 1 - share;
    const expectedAlpha = pyRound(((sourceAlpha - 0.06) * 255) / 0.94);
    expect(a).toBe(expectedAlpha);
    expect(r).toBe(pyRound((128 - share * 255) / sourceAlpha));
    expect(g).toBe(0);
    expect(b).toBe(r);
  });

  it('handles the green key symmetrically', () => {
    const frame = makeFrame(2, 1);
    setPx(frame, 0, 0, [0, 255, 0, 255]);
    setPx(frame, 1, 0, [200, 40, 180, 255]);
    const out = recoverAlphaFrame(frame, [0, 255, 0], GREEN);
    expect(getPx(out, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(getPx(out, 1, 0)).toEqual([200, 40, 180, 255]);
  });
});

describe('despillKeyFrame', () => {
  it('borrows RGB from the nearest clean opaque neighbor, keeping alpha', () => {
    const frame = makeFrame(3, 1);
    setPx(frame, 0, 0, [40, 90, 50, 255]);    // clean opaque
    setPx(frame, 1, 0, [180, 20, 170, 130]);  // key-tinted edge suspect
    setPx(frame, 2, 0, [0, 0, 0, 0]);
    const out = despillKeyFrame(frame, MAGENTA);
    expect(getPx(out, 1, 0)).toEqual([40, 90, 50, 130]);
    expect(getPx(out, 0, 0)).toEqual([40, 90, 50, 255]);
  });

  it('falls back to spill subtraction when no clean neighbor exists', () => {
    const frame = makeFrame(1, 1);
    setPx(frame, 0, 0, [200, 30, 190, 255]); // keyness = min(200,190)-30 = 160
    const out = despillKeyFrame(frame, MAGENTA);
    expect(getPx(out, 0, 0)).toEqual([40, 30, 30, 255]);
  });

  it('clears RGB under the alpha noise floor', () => {
    const frame = makeFrame(1, 1);
    setPx(frame, 0, 0, [90, 10, 80, 2]);
    expect(getPx(despillKeyFrame(frame, MAGENTA), 0, 0)).toEqual([0, 0, 0, 0]);
  });
});

describe('selectCycleIndices', () => {
  const SIG_LEN = 48 * 48 * 3;
  const constSig = (v) => Buffer.alloc(SIG_LEN, v);

  it('finds the periodic window and resamples with banker\'s rounding', () => {
    // Period-12 sawtooth: seam 0 at cycleLength 12, median motion 10.
    const pattern = [0, 10, 20, 30, 40, 50, 60, 50, 40, 30, 20, 10];
    const signatures = Array.from({ length: 25 }, (_, i) => constSig(pattern[i % 12]));
    const { indices, cycle } = selectCycleIndices(signatures);
    expect(cycle.windowStart).toBe(0);
    expect(cycle.windowLength).toBe(12);
    expect(cycle.endpointSeamScore).toBe(0);
    expect(cycle.medianMotionScore).toBe(10);
    // round(i*12/8) = round(i*1.5) — half-to-even: 1.5→2, 4.5→4, 7.5→8, 10.5→10.
    expect(indices).toEqual([0, 2, 3, 4, 6, 8, 9, 10]);
  });

  it('rejects a static clip and too-few frames', () => {
    expect(() => selectCycleIndices(Array.from({ length: 20 }, () => constSig(7))))
      .toThrow(/no detectable moving walk cycle/i);
    expect(() => selectCycleIndices(Array.from({ length: 8 }, () => constSig(0))))
      .toThrow(/at least 9/);
  });

  it('imageDistance is the mean absolute channel difference', () => {
    expect(imageDistance(constSig(10), constSig(10))).toBe(0);
    expect(imageDistance(constSig(0), constSig(30))).toBe(30);
  });
});

describe('alphaBbox / rootX', () => {
  it('finds the visible bbox (exclusive right/bottom) and the hip-band pivot', () => {
    const frame = makeFrame(40, 60);
    fillRect(frame, 10, 5, 30, 55, [50, 50, 50, 255]);
    const bbox = alphaBbox(frame);
    expect(bbox).toEqual({ left: 10, top: 5, right: 30, bottom: 55 });
    expect(rootX(frame, bbox)).toBe(19.5); // symmetric rect → center column median
    expect(alphaBbox(makeFrame(8, 8))).toBeNull();
  });
});

describe('alignFrames / packStrip', () => {
  it('applies one fixed scale and pins pivot x and the feet baseline', async () => {
    const frame = makeFrame(200, 300);
    fillRect(frame, 50, 40, 150, 240, [80, 60, 40, 255]); // 100×200 char
    const { frames, alignment } = await alignFrames([frame]);
    expect(frames[0].width).toBe(WALK_CELL_SIZE);
    expect(alignment.fixedScale).toBe(1); // fits inside 299×314 unscaled
    expect(alignment.operation).toBe('one-fixed-scale-plus-per-frame-translation');
    const [dx, dy] = alignment.translations[0];
    expect(dy).toBe(352 - 200); // feet on the baseline
    expect(dx).toBe(192 - 50);  // hip median (col 99.5 abs → 49.5 rel) → pyRound(192-49.5)=142
    // Feet row is the last opaque row; canvas is transparent below it.
    const feetRowAlpha = frames[0].data[(351 * WALK_CELL_SIZE + 192) * 4 + 3];
    const belowAlpha = frames[0].data[(352 * WALK_CELL_SIZE + 192) * 4 + 3];
    expect(feetRowAlpha).toBe(255);
    expect(belowAlpha).toBe(0);
  });

  it('downsizes an oversized character with an 8dp fixed scale', async () => {
    const frame = makeFrame(500, 600);
    fillRect(frame, 20, 20, 420, 520, [10, 10, 10, 255]); // 400×500
    const { alignment } = await alignFrames([frame]);
    expect(alignment.fixedScale).toBe(pyRoundTo(Math.min((384 * 0.78) / 400, (384 * 0.82) / 500), 8));
    expect(alignment.fixedScale).toBeLessThan(1);
  });

  it('packs 8 cells into one 3072×384 row', () => {
    const frames = Array.from({ length: 8 }, () => makeFrame(WALK_CELL_SIZE, WALK_CELL_SIZE));
    const strip = packStrip(frames);
    expect(strip.width).toBe(WALK_CELL_SIZE * 8);
    expect(strip.height).toBe(WALK_CELL_SIZE);
  });
});

// 8 distinct frames whose rect walks a circle — every position is unique,
// adjacent steps are uniform, and the loop seam (frame7→frame0) matches the
// typical adjacent step.
function oscillatingFrames(paint = [240, 240, 240, 255]) {
  return Array.from({ length: 8 }, (_, i) => {
    const angle = (i * Math.PI) / 4;
    const ox = Math.round(16 * Math.sin(angle));
    const oy = Math.round(16 * Math.cos(angle));
    const f = makeFrame(WALK_CELL_SIZE, WALK_CELL_SIZE);
    fillRect(f, 100 + ox, 80 + oy, 220 + ox, 320 + oy, paint);
    return f;
  });
}

describe('validateFrames', () => {
  it('accepts a clean oscillating cycle', async () => {
    const validation = await validateFrames(oscillatingFrames(), MAGENTA);
    expect(validation.distinctFrames).toBe(true);
    expect(validation.adjacentDifferenceScores).toHaveLength(8);
    expect(validation.keyDominantPixels).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(validation.backgroundsReviewed).toEqual(['light', 'dark', 'checker']);
  });

  it('rejects duplicate frames and visible key residue', async () => {
    const dupes = Array.from({ length: 8 }, () => makeFrame(WALK_CELL_SIZE, WALK_CELL_SIZE, [9, 9, 9, 255]));
    await expect(validateFrames(dupes, MAGENTA)).rejects.toThrow(/duplicate/i);
    const residue = oscillatingFrames();
    fillRect(residue[3], 10, 10, 20, 20, [230, 20, 220, 255]);
    await expect(validateFrames(residue, MAGENTA)).rejects.toThrow(/key color remains/i);
  });

  it('rejects a visible loop seam', async () => {
    const frames = oscillatingFrames();
    // Last frame teleports far from frame 0 → seam >> typical.
    frames[7] = makeFrame(WALK_CELL_SIZE, WALK_CELL_SIZE);
    fillRect(frames[7], 10, 10, 130, 250, [240, 240, 240, 255]);
    await expect(validateFrames(frames, MAGENTA)).rejects.toThrow(/loop seam/i);
  });
});

describe('buildContrastSheet', () => {
  it('renders the 3-row 1024×384 sheet with a checkered bottom row', async () => {
    const sheet = await buildContrastSheet(oscillatingFrames());
    expect(sheet.width).toBe(1024);
    expect(sheet.height).toBe(384);
    // Transparent corner of the checker row shows the checker colors.
    const px = (x, y) => [...sheet.data.subarray((y * 1024 + x) * 3, (y * 1024 + x) * 3 + 3)];
    expect(px(0, 256)).toEqual([222, 227, 229]);
    expect(px(16, 256)).toEqual([171, 181, 185]);
    expect(px(0, 0)).toEqual([244, 241, 232]);
    expect(px(0, 128)).toEqual([22, 28, 31]);
  });
});

describe('prepareWalkAnchorInput', () => {
  it('recovers a transparent despilled input from an opaque keyed anchor', async () => {
    const w = 64; const h = 64;
    const rgb = Buffer.alloc(w * h * 3);
    for (let p = 0; p < w * h; p++) rgb.set([255, 0, 255], p * 3);
    for (let y = 20; y < 50; y++) {
      for (let x = 24; x < 40; x++) rgb.set([30, 110, 60], (y * w + x) * 3);
    }
    const anchorAbs = join(TEST_ROOT, 'anchor.png');
    const destAbs = join(TEST_ROOT, 'input.png');
    await sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).png().toFile(anchorAbs);
    const { preparation } = await prepareWalkAnchorInput(anchorAbs, destAbs, '#FF00FF');
    expect(preparation).toBe('measured-key-alpha-recovery-plus-despill');
    const { data, info } = await sharp(destAbs).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    expect(data[3]).toBe(0); // key corner → transparent
    const charI = ((25 * w) + 30) * 4;
    expect(data[charI + 3]).toBe(255); // character stays opaque
    expect([data[charI], data[charI + 1], data[charI + 2]]).toEqual([30, 110, 60]);
  });
});

describe('constants', () => {
  it('exposes the canonical gait phases in order', () => {
    expect(WALK_PHASES).toEqual([
      'left-contact', 'left-down', 'left-passing', 'left-up',
      'right-contact', 'right-down', 'right-passing', 'right-up',
    ]);
    expect(WALK_FRAME_COUNT).toBe(8);
  });
});
