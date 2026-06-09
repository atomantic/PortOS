import { describe, it, expect, beforeAll } from 'vitest';
import sharp from 'sharp';
import {
  resolveSparkleRoi,
  buildCandidateMask,
  connectedComponents,
  selectSparkleComponent,
  removeGeminiSparkle,
} from './geminiSparkle.js';

// Paint a soft four-pointed star (the Gemini sparkle) into an RGB raw buffer at
// (cx, cy). Intensity falls off along the two diagonals-ish point shape so the
// fixture looks like the real anti-aliased mark, not a hard square.
function paintStar(raw, width, height, channels, cx, cy, radius) {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = Math.abs(x - cx);
      const dy = Math.abs(y - cy);
      // 4-point star: bright near the axes, pinched on the diagonals.
      const axis = Math.min(dx, dy);
      const ext = Math.max(dx, dy);
      if (ext > radius) continue;
      const falloff = 1 - ext / radius;
      const pinch = 1 - axis / Math.max(1, radius * 0.5);
      const intensity = Math.max(0, falloff * pinch);
      if (intensity <= 0) continue;
      const i = (y * width + x) * channels;
      const v = Math.round(255 * intensity);
      raw[i] = Math.max(raw[i], v);
      raw[i + 1] = Math.max(raw[i + 1], v);
      raw[i + 2] = Math.max(raw[i + 2], v);
    }
  }
}

// Build a PNG with a dark textured background and a sparkle in the bottom-right
// corner (where Gemini always places it).
async function makeSparkledPng(width, height, { withStar = true } = {}) {
  const channels = 3;
  const raw = Buffer.alloc(width * height * channels);
  // Dark, mildly varying background — well below the sparkle so the residual
  // test has clear separation, but textured enough to be realistic.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const base = 40 + ((x * 3 + y * 5) % 30); // 40..70
      raw[i] = base;
      raw[i + 1] = base - 8;
      raw[i + 2] = base - 15;
    }
  }
  if (withStar) {
    const cx = Math.round(width - width * 0.07);
    const cy = Math.round(height - height * 0.05);
    paintStar(raw, width, height, channels, cx, cy, Math.round(Math.min(width, height) * 0.04));
  }
  return sharp(raw, { raw: { width, height, channels } }).png().toBuffer();
}

describe('resolveSparkleRoi', () => {
  it('returns a bottom-right ROI anchored to the image edges', () => {
    const roi = resolveSparkleRoi(1000, 800);
    expect(roi.left + roi.width).toBe(1000);
    expect(roi.top + roi.height).toBe(800);
    expect(roi.width).toBe(Math.round(1000 * 0.22));
    expect(roi.height).toBe(Math.round(800 * 0.16));
  });

  it('clamps the ROI to a minimum side for tiny images', () => {
    const roi = resolveSparkleRoi(120, 120);
    expect(roi.width).toBe(80);
    expect(roi.height).toBe(80);
    expect(roi.left).toBe(40);
    expect(roi.top).toBe(40);
  });

  it('never exceeds the image bounds', () => {
    const roi = resolveSparkleRoi(50, 50);
    expect(roi.width).toBe(50);
    expect(roi.height).toBe(50);
    expect(roi.left).toBe(0);
    expect(roi.top).toBe(0);
  });

  it('returns null for non-positive dimensions', () => {
    expect(resolveSparkleRoi(0, 100)).toBeNull();
    expect(resolveSparkleRoi(100, NaN)).toBeNull();
  });
});

describe('buildCandidateMask', () => {
  it('marks bright low-saturation pixels above the background', () => {
    // 4×1 strip: dark bg, bright white (sparkle), bright but saturated (rim
    // light — rejected), dim (rejected).
    const width = 4;
    const height = 1;
    const channels = 3;
    const rgb = Buffer.from([
      40, 32, 25, // dark
      240, 240, 240, // bright white → candidate
      240, 40, 40, // bright but saturated red → reject
      90, 90, 90, // mid grey, low residual → reject
    ]);
    const bg = Buffer.from([
      45, 36, 28,
      50, 42, 35, // background under the sparkle is dark → big residual
      60, 30, 30,
      88, 88, 88, // background ~= pixel → tiny residual
    ]);
    const mask = buildCandidateMask({ rgb, width, height, channels, bg, bgChannels: 3 });
    expect(Array.from(mask)).toEqual([0, 1, 0, 0]);
  });
});

describe('connectedComponents + selectSparkleComponent', () => {
  it('groups a single blob and reports its shape', () => {
    // 5×5 with a 3×3 filled square (a too-solid blob — high fill).
    const w = 5;
    const h = 5;
    const mask = new Uint8Array(w * h);
    for (let y = 1; y <= 3; y++) for (let x = 1; x <= 3; x++) mask[y * w + x] = 1;
    const { components } = connectedComponents(mask, w, h);
    expect(components).toHaveLength(1);
    expect(components[0].area).toBe(9);
    expect(components[0].bw).toBe(3);
    expect(components[0].bh).toBe(3);
    expect(components[0].fill).toBe(1);
  });

  it('separates disconnected blobs', () => {
    const w = 5;
    const h = 1;
    const mask = Uint8Array.from([1, 1, 0, 0, 1]);
    const { components } = connectedComponents(mask, w, h);
    expect(components).toHaveLength(2);
  });

  it('rejects a fully-filled square (fill too high) but accepts a star-shaped blob', () => {
    const w = 40;
    const h = 40;
    // Solid square fills its bbox → rejected by MAX_FILL.
    const solid = new Uint8Array(w * h);
    for (let y = 5; y < 25; y++) for (let x = 5; x < 25; x++) solid[y * w + x] = 1;
    const solidComps = connectedComponents(solid, w, h).components;
    expect(selectSparkleComponent(solidComps, w, h)).toBeNull();

    // Plus/diamond shape ~ fills < half its bbox → accepted.
    const star = new Uint8Array(w * h);
    const cx = 20;
    const cy = 20;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (Math.abs(x - cx) + Math.abs(y - cy) <= 8) star[y * w + x] = 1;
    }
    const starComps = connectedComponents(star, w, h).components;
    const picked = selectSparkleComponent(starComps, w, h);
    expect(picked).not.toBeNull();
    expect(picked.fill).toBeLessThan(0.9);
  });
});

describe('removeGeminiSparkle (end-to-end)', () => {
  let sparkled;
  let clean;

  beforeAll(async () => {
    sparkled = await makeSparkledPng(500, 700, { withStar: true });
    clean = await makeSparkledPng(500, 700, { withStar: false });
  });

  it('detects and inpaints a corner sparkle, returning a PNG', async () => {
    const res = await removeGeminiSparkle(sparkled);
    expect(res.removed).toBe(true);
    expect(res.width).toBe(500);
    expect(res.height).toBe(700);
    expect(res.bbox).toBeTruthy();
    // The bbox lands in the bottom-right quadrant.
    expect(res.bbox.left).toBeGreaterThan(250);
    expect(res.bbox.top).toBeGreaterThan(350);
    // Output is a valid PNG.
    const meta = await sharp(res.data).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(500);
    expect(meta.height).toBe(700);
  });

  it('actually darkens the watermark region after removal', async () => {
    const res = await removeGeminiSparkle(sparkled);
    const { left, top, width, height } = res.bbox;
    const meanLum = async (buf) => {
      const { data, info } = await sharp(buf).extract({ left, top, width, height })
        .removeAlpha().raw().toBuffer({ resolveWithObject: true });
      let sum = 0;
      const px = info.width * info.height;
      for (let p = 0; p < px; p++) {
        const i = p * info.channels;
        sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      }
      return sum / px;
    };
    const before = await meanLum(sparkled);
    const after = await meanLum(res.data);
    // The bright sparkle is gone, so the region's mean luminance drops sharply
    // toward the dark background.
    expect(after).toBeLessThan(before - 20);
  });

  it('returns removed:false and the input untouched when there is no sparkle', async () => {
    const res = await removeGeminiSparkle(clean);
    expect(res.removed).toBe(false);
    expect(res.data).toBe(clean);
    expect(res.bbox).toBeNull();
  });

  it('returns removed:false for an empty or non-image buffer', async () => {
    const empty = await removeGeminiSparkle(Buffer.alloc(0));
    expect(empty.removed).toBe(false);
    const garbage = await removeGeminiSparkle(Buffer.from('not an image'));
    expect(garbage.removed).toBe(false);
  });
});
