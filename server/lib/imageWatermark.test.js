import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { resolveWatermarkRegion, inpaintRegion, removeCornerWatermark } from './imageWatermark.js';

// Build an RGB PNG of `w×h` filled with `bg`, then stamp a bright `fg` square
// in the bottom-right corner to simulate the Gemini ✦ sparkle.
async function makeWatermarkedPng(w, h, { bg = [40, 60, 90], fg = [255, 255, 255], box = 24 } = {}) {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const inBox = x >= w - box && y >= h - box;
      const [r, g, b] = inBox ? fg : bg;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b;
    }
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

describe('resolveWatermarkRegion', () => {
  it('anchors the box to the bottom-right corner', () => {
    const r = resolveWatermarkRegion(1000, 800);
    expect(r.x + r.w).toBe(1000);
    expect(r.y + r.h).toBe(800);
    expect(r.w).toBeGreaterThan(0);
    expect(r.h).toBeGreaterThan(0);
  });

  it('scales the default box with the short side, within clamp bounds', () => {
    const small = resolveWatermarkRegion(200, 200);
    const large = resolveWatermarkRegion(4000, 4000);
    expect(small.w).toBeGreaterThanOrEqual(56); // DEFAULT_REGION_MIN_PX
    expect(large.w).toBeLessThanOrEqual(220); // DEFAULT_REGION_MAX_PX
    expect(large.w).toBeGreaterThan(small.w);
  });

  it('honors an explicit size override (still corner-anchored)', () => {
    const r = resolveWatermarkRegion(1000, 1000, { size: 100 });
    expect(r.w).toBe(100);
    expect(r.h).toBe(100);
    expect(r.x).toBe(900);
    expect(r.y).toBe(900);
  });

  it('clamps an explicit region into the image bounds', () => {
    const r = resolveWatermarkRegion(500, 500, { region: { x: 9999, y: 9999, w: 100, h: 100 } });
    expect(r.x).toBe(400);
    expect(r.y).toBe(400);
    expect(r.x + r.w).toBeLessThanOrEqual(500);
    expect(r.y + r.h).toBeLessThanOrEqual(500);
  });

  it('returns a zero box for degenerate dimensions', () => {
    expect(resolveWatermarkRegion(0, 100)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe('inpaintRegion', () => {
  it('replaces target pixels with a value interpolated from the boundary', () => {
    // 5×5 single-channel patch, all 100 except the center pixel = 255.
    const pw = 5; const ph = 5;
    const raw = new Uint8ClampedArray(pw * ph).fill(100);
    raw[2 * pw + 2] = 255;
    inpaintRegion(raw, pw, ph, 1, { x: 2, y: 2, w: 1, h: 1 });
    // Surrounded entirely by 100 → the harmonic solution is 100.
    expect(raw[2 * pw + 2]).toBeCloseTo(100, 0);
  });

  it('is a no-op for a zero-area target', () => {
    const raw = new Uint8ClampedArray(9).fill(50);
    const before = Array.from(raw);
    inpaintRegion(raw, 3, 3, 1, { x: 0, y: 0, w: 0, h: 0 });
    expect(Array.from(raw)).toEqual(before);
  });
});

describe('removeCornerWatermark', () => {
  it('erases a bright corner mark, blending it into the background', async () => {
    const w = 256; const h = 256; const box = 24;
    const png = await makeWatermarkedPng(w, h, { box });
    const result = await removeCornerWatermark(png);
    expect(result.format).toBe('png');
    expect(result.width).toBe(w);
    expect(result.height).toBe(h);

    // Decode the result and sample a pixel that WAS inside the bright box.
    const { data, info } = await sharp(result.data).raw().toBuffer({ resolveWithObject: true });
    const px = w - 5; const py = h - 5;
    const i = (py * info.width + px) * info.channels;
    // The corner should now be near the background (40,60,90), not white (255).
    expect(data[i]).toBeLessThan(160);
    expect(data[i + 1]).toBeLessThan(180);
  });

  it('leaves a far-from-corner pixel byte-faithful', async () => {
    const w = 256; const h = 256;
    const png = await makeWatermarkedPng(w, h);
    const result = await removeCornerWatermark(png);
    const { data, info } = await sharp(result.data).raw().toBuffer({ resolveWithObject: true });
    // Top-left pixel is well outside the inpaint patch → unchanged background.
    const i = 0;
    expect(data[i]).toBe(40);
    expect(data[i + 1]).toBe(60);
    expect(data[i + 2]).toBe(90);
    expect(info.width).toBe(w);
  });

  it('records the region it reconstructed', async () => {
    const png = await makeWatermarkedPng(300, 200);
    const result = await removeCornerWatermark(png);
    expect(result.region.x + result.region.w).toBe(300);
    expect(result.region.y + result.region.h).toBe(200);
  });

  it('rejects an empty buffer', async () => {
    await expect(removeCornerWatermark(Buffer.alloc(0))).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a non-image buffer', async () => {
    await expect(removeCornerWatermark(Buffer.from('not an image'))).rejects.toMatchObject({ status: 400 });
  });

  it('respects an explicit region override', async () => {
    const png = await makeWatermarkedPng(256, 256, { box: 24 });
    const result = await removeCornerWatermark(png, { region: { x: 200, y: 200, w: 56, h: 56 } });
    expect(result.region).toEqual({ x: 200, y: 200, w: 56, h: 56 });
  });
});
