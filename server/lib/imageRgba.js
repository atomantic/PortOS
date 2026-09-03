/**
 * Small sharp-backed RGBA helpers shared by image-processing lanes.
 *
 * Pixel algorithms belong in sharp-free modules; this file is the deliberate
 * boundary for decoding encoded images and producing PNG bytes.
 */

import sharp from 'sharp';

/**
 * Decode an image to a raw RGBA frame `{ data, width, height }`.
 *
 * `autoOrient` applies the source's EXIF orientation tag before the pixels are
 * handed back, so `width`/`height` describe the image as a viewer would see it.
 * It is OPT-IN because raw output carries no EXIF of its own: a lane that
 * decodes, edits and re-encodes silently DROPS the tag, so a rotated JPEG comes
 * back sideways unless the rotation was baked in here. It stays off by default
 * only so existing callers keep their pixel-for-pixel behaviour.
 */
export async function decodeRgbaFrame(src, { autoOrient = false } = {}) {
  const pipeline = sharp(src);
  const { data, info } = await (autoOrient ? pipeline.rotate() : pipeline)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Encode a raw frame as PNG bytes without choosing a destination. */
export async function encodePng({ data, width, height }, channels = 4) {
  return sharp(data, { raw: { width, height, channels } })
    .png()
    .toBuffer();
}
