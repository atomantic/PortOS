/**
 * Image Gen — conform a provider's output to the requested aspect ratio.
 *
 * Codex's built-in image_gen tool takes no size argument: the requested canvas
 * rides the prompt as a hint and the model picks one of its native sizes. Most
 * of the time that lands on the asked-for shape, but not always — a 16:9 music
 * video production came back with 1254x1254 squares (mostly performance
 * close-ups), near-4:3 frames and 1536x1024 3:2 frames mixed in with its
 * 1672x941 widescreen stills, and every clip lane downstream inherited the
 * wrong shape (an OmniHuman lip-sync clip from a square still is 1080x1080).
 *
 * So the provider's completion handler runs the written frame through here
 * before the sidecar is written: a frame within `ASPECT_TOLERANCE` of the
 * requested ratio is left byte-for-byte alone; anything else is cropped to the
 * largest rectangle of the requested ratio, positioned by sharp's attention
 * strategy so a close-up keeps the face rather than a geometric centre. The
 * crop never upscales — it keeps the provider's native resolution on the long
 * side it can afford.
 */

import sharp from 'sharp';
import { atomicWrite } from '../../lib/fileUtils.js';

// 2% — 1672x941 (1.7768) is Codex's own 16:9 and must pass untouched against a
// 1.7778 request; the nearest wrong shape it returns (3:2, 1.5) is ~16% off.
const ASPECT_TOLERANCE = 0.02;

const positive = (n) => Number.isFinite(Number(n)) && Number(n) > 0;

/**
 * The crop box that conforms a `srcW`x`srcH` frame to `targetW:targetH`, or
 * `null` when the frame is already within tolerance (or the input is unusable).
 *
 * @returns {{ width: number, height: number }|null}
 */
function aspectCropSize(srcW, srcH, targetW, targetH, tolerance = ASPECT_TOLERANCE) {
  if (![srcW, srcH, targetW, targetH].every(positive)) return null;
  const target = targetW / targetH;
  const actual = srcW / srcH;
  if (Math.abs(actual / target - 1) <= tolerance) return null;
  // Too wide → keep full height, narrow the width; too tall → the reverse.
  const width = actual > target ? Math.round(srcH * target) : srcW;
  const height = actual > target ? srcH : Math.round(srcW / target);
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

/**
 * Crop the PNG at `pngPath` in place to the requested aspect ratio when it is
 * off. Returns `{ from, to }` (`"WxH"` strings) when it cropped, else `null`.
 * A frame sharp cannot read is left for the existing invalid-image paths.
 */
export async function conformImageAspect(pngPath, targetW, targetH) {
  if (!positive(targetW) || !positive(targetH)) return null;
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
