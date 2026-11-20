/**
 * Image Gen — conform a provider's output to the requested aspect ratio.
 *
 * Codex's image_gen takes no size argument, so it sometimes returns the wrong shape (and
 * every downstream clip lane inherits it). Frames within `ASPECT_TOLERANCE` are left
 * byte-for-byte alone; others are cropped to the largest requested-ratio rectangle,
 * positioned by sharp's attention strategy, never upscaling. The fal clip lane applies the
 * same crop box (videoGen/falFrameAspect.js).
 */

import { atomicWrite } from '../../lib/fileUtils.js';

// 2% — 1672x941 (1.7768) is Codex's own 16:9 and must pass untouched against a
// 1.7778 request; the nearest wrong shape it returns (3:2, 1.5) is ~16% off.
const ASPECT_TOLERANCE = 0.02;

const positive = (n) => Number.isFinite(Number(n)) && Number(n) > 0;

/**
 * Crop box conforming a frame to the target ratio, or null when within tolerance or unusable.
 * @returns {{ width: number, height: number }|null}
 */
export function aspectCropSize(srcW, srcH, targetW, targetH, tolerance = ASPECT_TOLERANCE) {
  if (![srcW, srcH, targetW, targetH].every(positive)) return null;
  const target = targetW / targetH;
  const actual = srcW / srcH;
  if (Math.abs(actual / target - 1) <= tolerance) return null;
  // Too wide → keep full height, narrow the width; too tall → the reverse.
  const width = actual > target ? Math.round(srcH * target) : srcW;
  const height = actual > target ? srcH : Math.round(srcW / target);
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

// Crops the PNG in place when off-ratio; returns `{ from, to }` or null. Unreadable frames
// are left for the existing invalid-image paths.
export async function conformImageAspect(pngPath, targetW, targetH) {
  if (!positive(targetW) || !positive(targetH)) return null;
  const { default: sharp } = await import('sharp');
  const meta = await sharp(pngPath).metadata().catch(() => null);
  const crop = aspectCropSize(meta?.width, meta?.height, Number(targetW), Number(targetH));
  if (!crop) return null;
  const buffer = await sharp(pngPath)
    .resize(crop.width, crop.height, { fit: 'cover', position: sharp.strategy.attention })
    .png()
    .toBuffer();
  await atomicWrite(pngPath, buffer);
  return { from: `${meta.width}x${meta.height}`, to: `${crop.width}x${crop.height}` };
}
