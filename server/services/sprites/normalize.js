/**
 * Sprites — reference-frame normalization + palette extraction (issue #2896).
 *
 * Node/sharp port of the source pipeline's `normalize_anchor_frame` (Pillow):
 * mask the character out of the generated candidate by per-pixel difference
 * from the background key color, then re-composite ONLY the masked pixels
 * onto a fresh solid-key square canvas. Because the composite always starts
 * from a clean canvas, switching key colors at lock time (mask on the
 * generation key, fill with the selected key) is free — that's what makes the
 * dynamic chroma-key selection possible without regenerating.
 *
 * Geometry contract (verbatim from the source): character height is 80% of
 * the square side (or width fits inside 10% side margins, whichever needs a
 * bigger canvas), feet baseline sits 7% above the bottom edge, pixels are
 * never rescaled — only the canvas is sized around them. Mask threshold: a
 * pixel is foreground when max-channel |pixel − key| > 40 — a DELIBERATE
 * deviation from the source's luma metric, which is blind to black-vs-blue
 * (see MASK_CHANNEL_THRESHOLD).
 */

import sharp from 'sharp';
import { copyFile } from 'fs/promises';
import { hexToRgb } from './chromaKey.js';

const FRAME_HEIGHT_FRAC = 0.80;
const FRAME_BOTTOM_FRAC = 0.07;
const FRAME_SIDE_FRAC = 0.10;
// Max-channel distance from the key, NOT the source pipeline's luma-of-diff:
// luma weights blue at 0.114, so against the blue key a BLACK pixel scores
// 255·0.114 ≈ 29 — under any usable threshold — and black outlines/hair
// would be silently erased. Luma was safe only because the source pipeline
// hardcoded magenta; the dynamic key set (#2895) makes the metric wrong.
// Max-channel treats all three keys symmetrically (black vs any pure key
// differs by 255 in at least one channel).
const MASK_CHANNEL_THRESHOLD = 40;

// Re-export for existing consumers/tests; the definition lives in the pure
// color-math module so chromaKey.js can use it without importing sharp.
export { hexToRgb };

/**
 * Decode `src` as flat RGB (alpha dropped over white like Pillow's
 * convert("RGB"); generated candidates are opaque PNGs so this is a no-op in
 * practice) and compute the foreground mask + tight bounding box vs the key
 * color. The lock path runs palette extraction AND normalization off ONE
 * analysis so a multi-MP candidate is decoded and scanned once.
 */
export async function analyzeForeground(src, maskKeyHex) {
  const key = hexToRgb(maskKeyHex);
  const { data, info } = await sharp(src)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const mask = new Uint8Array(width * height);
  let left = width; let top = height; let right = -1; let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const dr = Math.abs(data[i] - key.r);
      const dg = Math.abs(data[i + 1] - key.g);
      const db = Math.abs(data[i + 2] - key.b);
      if (Math.max(dr, dg, db) > MASK_CHANNEL_THRESHOLD) {
        mask[y * width + x] = 1;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  const bbox = right >= 0 ? { left, top, right: right + 1, bottom: bottom + 1 } : null;
  return { data, width, height, mask, bbox };
}

/**
 * Histogram the foreground (non-key) pixels of an analysis, quantized to 4
 * bits per channel so anti-aliased shades collapse into their parent color.
 * Returns `[{ r, g, b, count }]` sorted by count desc — pickChromaKey's input.
 */
export function paletteFromAnalysis({ data, width, height, mask }) {
  const counts = new Map();
  for (let p = 0; p < width * height; p++) {
    if (!mask[p]) continue;
    const i = p * 3;
    const bucket = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    counts.set(bucket, (counts.get(bucket) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([bucket, count]) => ({
      // Bucket midpoint (e.g. 0xF? → 0xF8) so hue math sees representative values.
      r: (((bucket >> 8) & 0xf) << 4) | 0x8,
      g: (((bucket >> 4) & 0xf) << 4) | 0x8,
      b: ((bucket & 0xf) << 4) | 0x8,
      count,
    }))
    .sort((a, b) => b.count - a.count);
}

/** One-shot palette extraction (decode + histogram). */
export async function extractForegroundPalette(src, maskKeyHex) {
  return paletteFromAnalysis(await analyzeForeground(src, maskKeyHex));
}

/**
 * Composite a pre-analyzed candidate onto the canonical key-color square.
 * `src` is still needed for the no-foreground copy-through path.
 */
export async function normalizeFromAnalysis(analysis, src, dest, canvasKeyHex) {
  const { data, width, mask, bbox } = analysis;
  if (!bbox) {
    await copyFile(src, dest);
    return { copiedThrough: true };
  }
  const charW = bbox.right - bbox.left;
  const charH = bbox.bottom - bbox.top;
  const side = Math.max(
    Math.round(charH / FRAME_HEIGHT_FRAC),
    Math.round(charW / (1 - 2 * FRAME_SIDE_FRAC)),
  );
  const fill = hexToRgb(canvasKeyHex);
  const canvas = Buffer.alloc(side * side * 3, Buffer.from([fill.r, fill.g, fill.b]));
  const offsetX = Math.floor((side - charW) / 2);
  const feetY = side - Math.round(side * FRAME_BOTTOM_FRAC);
  const offsetY = feetY - charH;
  for (let y = bbox.top; y < bbox.bottom; y++) {
    for (let x = bbox.left; x < bbox.right; x++) {
      if (!mask[y * width + x]) continue;
      const srcI = (y * width + x) * 3;
      const dstI = ((offsetY + (y - bbox.top)) * side + offsetX + (x - bbox.left)) * 3;
      canvas[dstI] = data[srcI];
      canvas[dstI + 1] = data[srcI + 1];
      canvas[dstI + 2] = data[srcI + 2];
    }
  }
  await sharp(canvas, { raw: { width: side, height: side, channels: 3 } }).png().toFile(dest);
  return { side, charW, charH };
}

/**
 * One-shot normalize: mask `src` against the key it was GENERATED on, then
 * composite onto the SELECTED key. An image with no detectable foreground
 * copies through unchanged, mirroring the source behavior.
 */
export async function normalizeAnchorFrame(src, dest, { maskKeyHex, canvasKeyHex }) {
  return normalizeFromAnalysis(await analyzeForeground(src, maskKeyHex), src, dest, canvasKeyHex);
}
