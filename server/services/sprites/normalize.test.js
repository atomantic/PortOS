/**
 * Sharp port of the source pipeline's normalize_anchor_frame — geometry and
 * keying verified against the Pillow reference implementation's contract:
 * 80% height square, 7% bottom margin, mask = luma(diff vs key) > 40, pixels
 * never rescaled, composite always lands on a fresh solid-key canvas.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import {
  normalizeAnchorFrame, extractForegroundPalette, hexToRgb, recompositeOnKey, analyzeForeground,
} from './normalize.js';

let dir;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'sprite-normalize-test-')); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const MAGENTA = { r: 255, g: 0, b: 255 };
const GREEN = { r: 0, g: 255, b: 0 };

// 64×64 key-color canvas with a green rectangle at x∈[20,30), y∈[10,30).
async function writeCandidate(path, { bg = MAGENTA, fg = GREEN } = {}) {
  const w = 64; const h = 64;
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inRect = x >= 20 && x < 30 && y >= 10 && y < 30;
      const c = inRect ? fg : bg;
      const i = (y * w + x) * 3;
      buf[i] = c.r; buf[i + 1] = c.g; buf[i + 2] = c.b;
    }
  }
  await sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toFile(path);
}

// 64×64 magenta bg + green rect, with one anti-aliased fringe column (0.8
// magenta / 0.2 green = (204,51,204)) just left of the rect — a blend that
// survives the hard mask but still carries the magenta key's tint.
async function writeFringeCandidate(path) {
  const w = 64; const h = 64;
  const FRINGE = { r: 204, g: 51, b: 204 };
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c = MAGENTA;
      if (x >= 20 && x < 30 && y >= 10 && y < 30) c = GREEN;
      else if (x === 19 && y >= 10 && y < 30) c = FRINGE;
      const i = (y * w + x) * 3;
      buf[i] = c.r; buf[i + 1] = c.g; buf[i + 2] = c.b;
    }
  }
  await sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toFile(path);
}

async function readRaw(path) {
  const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

const px = ({ data, width }, x, y) => ({
  r: data[(y * width + x) * 3],
  g: data[(y * width + x) * 3 + 1],
  b: data[(y * width + x) * 3 + 2],
});

describe('normalizeAnchorFrame', () => {
  it('centers the character on the canonical square with the feet baseline', async () => {
    const src = join(dir, 'cand.png');
    const dest = join(dir, 'locked.png');
    await writeCandidate(src);
    const result = await normalizeAnchorFrame(src, dest, { maskKeyHex: '#FF00FF', canvasKeyHex: '#FF00FF' });

    // charH=20 → side = round(20/0.8) = 25; feet at 25 - round(25*0.07) = 23.
    expect(result).toMatchObject({ side: 25, charW: 10, charH: 20 });
    const img = await readRaw(dest);
    expect(img.width).toBe(25);
    expect(img.height).toBe(25);
    expect(px(img, 0, 0)).toEqual(MAGENTA);              // corner is clean key
    expect(px(img, 7, 3)).toEqual(GREEN);                // char top-left at (7, 3)
    expect(px(img, 16, 22)).toEqual(GREEN);              // char bottom-right at (16, 22)
    expect(px(img, 12, 23)).toEqual(MAGENTA);            // below the feet baseline
    expect(px(img, 6, 3)).toEqual(MAGENTA);              // left of the character
  });

  it('switches key color at composite time (mask on generation key, fill with selected key)', async () => {
    const src = join(dir, 'cand2.png');
    const dest = join(dir, 'locked2.png');
    await writeCandidate(src);
    await normalizeAnchorFrame(src, dest, { maskKeyHex: '#FF00FF', canvasKeyHex: '#0000FF' });
    const img = await readRaw(dest);
    expect(px(img, 0, 0)).toEqual({ r: 0, g: 0, b: 255 }); // background re-keyed to blue
    expect(px(img, 7, 3)).toEqual(GREEN);                  // character pixels untouched
  });

  it('preserves black pixels against the blue key (max-channel mask, not luma)', async () => {
    const src = join(dir, 'blue-black.png');
    const dest = join(dir, 'blue-black-out.png');
    const BLUE = { r: 0, g: 0, b: 255 };
    const BLACK = { r: 0, g: 0, b: 0 };
    await writeCandidate(src, { bg: BLUE, fg: BLACK });
    const result = await normalizeAnchorFrame(src, dest, { maskKeyHex: '#0000FF', canvasKeyHex: '#0000FF' });
    // Under the source pipeline's luma metric this black rect scores
    // 255·0.114 ≈ 29 < 40 and would vanish entirely (copiedThrough).
    expect(result).toMatchObject({ charW: 10, charH: 20 });
    const img = await readRaw(dest);
    expect(px(img, 7, 3)).toEqual(BLACK);
    expect(px(img, 0, 0)).toEqual(BLUE);
  });

  it('decontaminates anti-aliased key fringe when re-keying magenta → blue', async () => {
    const src = join(dir, 'fringe.png');
    const dest = join(dir, 'fringe-out.png');
    await writeFringeCandidate(src);
    await normalizeAnchorFrame(src, dest, { maskKeyHex: '#FF00FF', canvasKeyHex: '#0000FF' });
    const img = await readRaw(dest);
    let magentaHalo = 0; let greenKept = 0;
    for (let p = 0; p < img.width * img.height; p++) {
      const r = img.data[p * 3]; const g = img.data[p * 3 + 1]; const b = img.data[p * 3 + 2];
      if (r > 150 && b > 150 && g < 120) magentaHalo++; // residual old-key ring
      if (g > 200 && r < 80 && b < 80) greenKept++;      // character pixels
    }
    expect(magentaHalo).toBe(0);              // no magenta halo survives the re-key
    expect(greenKept).toBeGreaterThan(0);     // the character itself is untouched
  });

  it('copies fringe through verbatim when the key is not swapped', async () => {
    const src = join(dir, 'fringe2.png');
    const dest = join(dir, 'fringe2-out.png');
    await writeFringeCandidate(src);
    await normalizeAnchorFrame(src, dest, { maskKeyHex: '#FF00FF', canvasKeyHex: '#FF00FF' });
    const img = await readRaw(dest);
    let fringe = 0;
    for (let p = 0; p < img.width * img.height; p++) {
      const r = img.data[p * 3]; const g = img.data[p * 3 + 1]; const b = img.data[p * 3 + 2];
      if (r === 204 && g === 51 && b === 204) fringe++;
    }
    expect(fringe).toBeGreaterThan(0); // same-key composite leaves the blend as-is
  });

  it('copies through an image with no detectable foreground', async () => {
    const src = join(dir, 'blank.png');
    const dest = join(dir, 'blank-out.png');
    await writeCandidate(src, { fg: MAGENTA }); // rectangle same as background
    const result = await normalizeAnchorFrame(src, dest, { maskKeyHex: '#FF00FF', canvasKeyHex: '#FF00FF' });
    expect(result.copiedThrough).toBe(true);
    const img = await readRaw(dest);
    expect(img.width).toBe(64); // untouched original
  });
});

describe('extractForegroundPalette', () => {
  it('histograms only non-key pixels, bucketed to 4 bits per channel', async () => {
    const src = join(dir, 'palette.png');
    await writeCandidate(src);
    const palette = await extractForegroundPalette(src, '#FF00FF');
    expect(palette).toHaveLength(1);
    expect(palette[0]).toEqual({ r: 8, g: 248, b: 8, count: 200 }); // 10×20 green rect
  });
});

describe('hexToRgb', () => {
  it('parses with or without the leading #', () => {
    expect(hexToRgb('#FF00FF')).toEqual(MAGENTA);
    expect(hexToRgb('00ff00')).toEqual(GREEN);
  });

  it('throws on junk', () => {
    expect(() => hexToRgb('red')).toThrow(/Invalid hex/);
  });
});

describe('recompositeOnKey (#2979 — turnaround sheet re-key)', () => {
  it('preserves the original canvas instead of reframing onto a square', async () => {
    // A wide multi-figure sheet: normalizeFromAnalysis would crop to the
    // figures' bbox and rebuild an 80%-height square, which is meaningless for
    // a model sheet. The re-key must leave geometry alone.
    const src = join(dir, 'sheet.png');
    const dest = join(dir, 'sheet-out.png');
    const w = 128; const h = 48;
    const buf = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Four green figures spread across the sheet.
        const inFigure = (x % 32) >= 12 && (x % 32) < 20 && y >= 8 && y < 40;
        const c = inFigure ? GREEN : MAGENTA;
        const i = (y * w + x) * 3;
        buf[i] = c.r; buf[i + 1] = c.g; buf[i + 2] = c.b;
      }
    }
    await sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toFile(src);

    const analysis = await analyzeForeground(src, '#FF00FF');
    const result = await recompositeOnKey(analysis, src, dest, '#0000FF');
    expect(result).toMatchObject({ width: w, height: h });

    const img = await readRaw(dest);
    expect(img.width).toBe(w);
    expect(img.height).toBe(h);
    // Background is exactly the new key; every figure pixel survives untouched.
    const at = (x, y) => [img.data[(y * w + x) * 3], img.data[(y * w + x) * 3 + 1], img.data[(y * w + x) * 3 + 2]];
    expect(at(0, 0)).toEqual([0, 0, 255]);
    expect(at(64, 0)).toEqual([0, 0, 255]);
    expect(at(14, 20)).toEqual([0, 255, 0]);
    expect(at(110, 20)).toEqual([0, 255, 0]); // the last panel, not cropped away
  });

  it('decontaminates fringe carrying the old key on a swap', async () => {
    const src = join(dir, 'sheet-fringe.png');
    const dest = join(dir, 'sheet-fringe-out.png');
    await writeFringeCandidate(src);
    const analysis = await analyzeForeground(src, '#FF00FF');
    await recompositeOnKey(analysis, src, dest, '#0000FF');
    const img = await readRaw(dest);
    let magentaTinted = 0;
    for (let p = 0; p < img.width * img.height; p++) {
      const [r, g, b] = [img.data[p * 3], img.data[p * 3 + 1], img.data[p * 3 + 2]];
      if (r === 204 && g === 51 && b === 204) magentaTinted++;
    }
    // The 0.8-magenta blend is shifted toward the new key, not left as a
    // magenta halo around the figure.
    expect(magentaTinted).toBe(0);
  });

  it('is a plain re-encode when the key does not change', async () => {
    const src = join(dir, 'sheet-samekey.png');
    const dest = join(dir, 'sheet-samekey-out.png');
    await writeCandidate(src);
    const analysis = await analyzeForeground(src, '#FF00FF');
    await recompositeOnKey(analysis, src, dest, '#FF00FF');
    const before = await readRaw(src);
    const after = await readRaw(dest);
    expect(after.width).toBe(before.width);
    expect(Buffer.compare(Buffer.from(after.data), Buffer.from(before.data))).toBe(0);
  });

  it('copies through a sheet with no detectable foreground', async () => {
    const src = join(dir, 'sheet-blank.png');
    const dest = join(dir, 'sheet-blank-out.png');
    await writeCandidate(src, { fg: MAGENTA });
    const analysis = await analyzeForeground(src, '#FF00FF');
    expect((await recompositeOnKey(analysis, src, dest, '#00FF00')).copiedThrough).toBe(true);
  });
});
