// Real-sharp tests for the regen pixel/spatial helpers (issue #912). Kept in a
// SEPARATE file from regen.test.js because that suite mocks `sharp` for the
// pure param-assembly tests — computePixelDelta and applyLightRegen need the
// genuine decoder/encoder. sharp accepts a Buffer or a path, so the fixtures
// are in-memory PNG buffers (no temp files).
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { computePixelDelta, applyLightRegen, REGEN_SQUEEZE_FACTOR, PSNR_IDENTICAL } from './regen.js';

// Solid-color PNG of the given size — a deterministic fixture for delta math.
const solidPng = (w, h, { r, g, b }) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r, g, b } } }).png().toBuffer();

describe('computePixelDelta', () => {
  it('reports zero delta / finite sentinel PSNR for an identical image', async () => {
    const buf = await solidPng(128, 128, { r: 120, g: 64, b: 200 });
    const delta = await computePixelDelta(buf, buf);
    expect(delta.pixelDeltaPct).toBe(0);
    // Finite (not Infinity) so it survives JSON serialization.
    expect(delta.psnr).toBe(PSNR_IDENTICAL);
    expect(Number.isFinite(delta.psnr)).toBe(true);
  });

  it('reports a large delta for opposite solid colors', async () => {
    const black = await solidPng(128, 128, { r: 0, g: 0, b: 0 });
    const white = await solidPng(128, 128, { r: 255, g: 255, b: 255 });
    const delta = await computePixelDelta(black, white);
    expect(delta.pixelDeltaPct).toBeGreaterThan(95); // ~100% of full range
    expect(delta.psnr).toBeLessThan(5); // near-worst-case
  });

  it('returns null when an input cannot be decoded', async () => {
    const ok = await solidPng(64, 64, { r: 10, g: 10, b: 10 });
    const delta = await computePixelDelta(ok, Buffer.from('not an image'));
    expect(delta).toBeNull();
  });
});

describe('applyLightRegen', () => {
  it('returns a re-encoded PNG at the SOURCE dimensions (squeeze is upscaled back)', async () => {
    const src = await solidPng(256, 192, { r: 80, g: 160, b: 240 });
    const out = await applyLightRegen(src);
    expect(Buffer.isBuffer(out.data)).toBe(true);
    expect(out.width).toBe(256);
    expect(out.height).toBe(192);
    // Output decodes back at the original dimensions, not the squeezed render size.
    const meta = await sharp(out.data).metadata();
    expect(meta.width).toBe(256);
    expect(meta.height).toBe(192);
  });

  it('actually changes the pixels (it is a disruption pass, not a copy)', async () => {
    // A non-uniform image so the spatial stages have detail to perturb.
    const src = await sharp({
      create: { width: 256, height: 256, channels: 3, background: { r: 30, g: 90, b: 180 } },
    }).composite([{
      input: { create: { width: 128, height: 256, channels: 3, background: { r: 220, g: 60, b: 60 } } },
      left: 0, top: 0,
    }]).png().toBuffer();
    const out = await applyLightRegen(src);
    const delta = await computePixelDelta(src, out.data);
    expect(delta.pixelDeltaPct).toBeGreaterThan(0);
  });

  it('actually applies the resize-squeeze, not just the color/sharpen ops', async () => {
    // Regression guard: sharp collapses chained .resize() calls to the last one,
    // so a single-pipeline implementation silently skips the downscale→upscale
    // squeeze. Build a 1px-stripe (max high-frequency) image where the squeeze
    // measurably blurs, and assert the real output differs from the same ops
    // WITHOUT the squeeze — if the squeeze regresses, the two become identical.
    const w = 256, h = 64;
    const raw = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = x % 2 ? 255 : 0;
        const o = (y * w + x) * 3;
        raw[o] = raw[o + 1] = raw[o + 2] = v;
      }
    }
    const stripes = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
    const withSqueeze = (await applyLightRegen(stripes)).data;
    const noSqueeze = await sharp(stripes)
      .modulate({ brightness: 1.01, saturation: 0.99, hue: 1 })
      .linear(1.02, -2)
      .median(2)
      .sharpen()
      .png({ compressionLevel: 6 })
      .toBuffer();
    const delta = await computePixelDelta(withSqueeze, noSqueeze);
    expect(delta.pixelDeltaPct).toBeGreaterThan(0);
  });

  it('returns null for an undecodable buffer', async () => {
    expect(await applyLightRegen(Buffer.from('nope'))).toBeNull();
  });

  it('squeeze factor is a sane fraction below 1', () => {
    expect(REGEN_SQUEEZE_FACTOR).toBeGreaterThan(0.5);
    expect(REGEN_SQUEEZE_FACTOR).toBeLessThan(1);
  });
});
