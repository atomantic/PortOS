/**
 * Image Gen — the crop box that conforms a frame to a requested aspect ratio.
 *
 * Image backends do not always return the asked-for shape (Codex answered a
 * 16:9 music video request with 1254x1254 close-ups, near-4:3 and 3:2 frames),
 * and every clip lane downstream inherits that shape: an OmniHuman lip-sync clip
 * from a square still is 1080x1080. A frame within `ASPECT_TOLERANCE` of the
 * requested ratio is left alone; anything else is cropped to the largest
 * rectangle of that ratio, never upscaled. The fal clip lane applies it to the
 * frames it uploads (videoGen/falFrameAspect.js).
 */

// 2% — 1672x941 (1.7768) is Codex's own 16:9 and must pass untouched against a
// 1.7778 request; the nearest wrong shape it returns (3:2, 1.5) is ~16% off.
export const ASPECT_TOLERANCE = 0.02;

const positive = (n) => Number.isFinite(Number(n)) && Number(n) > 0;

/**
 * The crop box that conforms a `srcW`x`srcH` frame to `targetW:targetH`, or
 * `null` when the frame is already within tolerance (or the input is unusable).
 * Pure — exported for the unit test.
 *
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
