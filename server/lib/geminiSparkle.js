// Visible Gemini / "nano-banana" sparkle removal.
//
// Gemini (Gemini 2.5 Flash Image, a.k.a. "nano-banana") stamps a small,
// soft-edged four-pointed white star in the bottom-right corner of every
// render. That is a VISIBLE overlay watermark — entirely separate from the
// INVISIBLE SynthID signal that `server/services/imageGen/regen.js` defeats by
// round-tripping pixels through a local FLUX model. This module removes only
// the visible sparkle, and does it with a pure CPU (sharp) detect-and-inpaint
// pass — no GPU, no model, no network — so it works on every install.
//
// This is the "Visible-watermark removal (Gemini sparkle)" item the SynthID
// evaluation deliberately deferred (see
// `docs/plans/2026-06-05-synthid-removal-eval.md`, "Considered, NOT pursued").
//
// Approach (all in the bottom-right ROI where Gemini always places the mark):
//   1. Estimate the local background with a large-radius blur of the ROI.
//   2. Mark pixels that are brighter than that background (the additive white
//      sparkle) AND low-saturation AND bright in absolute terms.
//   3. Group the marked pixels into connected components and pick the one that
//      looks like the star: compact, ~square bbox, ~35% fill (a 4-point star
//      is concave so it fills roughly a third of its bounding box), near the
//      corner. No match → report "not found" and leave the image untouched.
//   4. Inpaint the selected region by diffusion (seed the masked pixels with
//      the blurred background, then iterate blur+restore-known), feather the
//      mask edge, and alpha-blend the fill back over the original ROI.
//
// Kept in lib/ (not routes/) and self-contained (sharp + node builtins only) so
// services can call it without crossing the routes→services direction, mirroring
// `imageClean.js`.

import sharp from 'sharp';

// The sparkle always sits in the bottom-right. Search a generous corner ROI
// rather than the whole frame: it bounds the cost, and it keeps a bright
// compact object elsewhere in the image (a lone star in the sky, a logo) from
// being mistaken for the watermark.
export const ROI_WIDTH_FRACTION = 0.22;
export const ROI_HEIGHT_FRACTION = 0.16;
// ROI never smaller than this many px on a side, so a tiny thumbnail still has
// room for the blur-background estimate to mean anything.
const ROI_MIN_SIDE = 80;

// Luminance residual (pixel minus blurred-background) above which a pixel is a
// watermark candidate. The sparkle is additive white, so it reads clearly
// brighter than whatever it sits on. Tuned on real Gemini output.
export const SPARKLE_RESIDUAL_THRESHOLD = 22;
// The mark is near-white: low saturation, high absolute luminance. These reject
// bright-but-colored highlights (a metal rivet, a warm rim-light) that also
// clear the residual test.
const SPARKLE_MAX_SATURATION = 0.35;
const SPARKLE_MIN_LUMINANCE = 120;

// Component-shape gates for "is this blob the star". Areas are fractions of the
// ROI pixel count; a four-pointed star is a compact, near-square, ~1/3-filled
// blob. Anything thin (aspect), tiny/huge (area), or solid (a filled square /
// sky patch fills its bbox) is rejected.
const MIN_AREA_FRACTION = 0.004;
const MAX_AREA_FRACTION = 0.25;
const MAX_ASPECT = 2.2;
const MIN_FILL = 0.22;
const MAX_FILL = 0.9;

const luminanceAt = (data, i) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

// Resolve the bottom-right search ROI for an image of the given dimensions.
// Pure. Clamped so the ROI never exceeds the image and never falls below
// ROI_MIN_SIDE (unless the image itself is smaller).
export function resolveSparkleRoi(width, height) {
  const w = Math.round(Number(width));
  const h = Math.round(Number(height));
  if (!(w > 0) || !(h > 0)) return null;
  const roiW = Math.min(w, Math.max(ROI_MIN_SIDE, Math.round(w * ROI_WIDTH_FRACTION)));
  const roiH = Math.min(h, Math.max(ROI_MIN_SIDE, Math.round(h * ROI_HEIGHT_FRACTION)));
  return { left: w - roiW, top: h - roiH, width: roiW, height: roiH };
}

// Mark watermark-candidate pixels in an RGB raster against a same-size blurred
// background raster. Returns a Uint8Array (1 = candidate). Pure.
//   `rgb`/`bg` are raw pixel buffers; `channels`/`bgChannels` their strides
//   (sharp emits 3 for an opaque blur, but accept whatever it reports).
export function buildCandidateMask({ rgb, width, height, channels, bg, bgChannels }) {
  const mask = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p++) {
    const i = p * channels;
    const r = rgb[i];
    const g = rgb[i + 1];
    const b = rgb[i + 2];
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const sat = mx === 0 ? 0 : (mx - mn) / mx;
    const lum = luminanceAt(rgb, i);
    const bgLum = luminanceAt(bg, p * bgChannels);
    if (lum - bgLum > SPARKLE_RESIDUAL_THRESHOLD && sat < SPARKLE_MAX_SATURATION && lum > SPARKLE_MIN_LUMINANCE) {
      mask[p] = 1;
    }
  }
  return mask;
}

// 4-connected components of a binary mask. Returns `{ label, components }` where
// `label` is an Int32Array of component ids (1-based; 0 = background) and each
// component carries its bbox, area, centroid, and derived shape metrics. Pure.
export function connectedComponents(mask, width, height) {
  const label = new Int32Array(width * height);
  const queue = new Int32Array(width * height); // BFS frontier of flat pixel indices
  const components = [];
  let next = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = y * width + x;
      if (!mask[start] || label[start]) continue;
      next++;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      label[start] = next;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let area = 0;
      let sumX = 0;
      let sumY = 0;
      while (head < tail) {
        const p = queue[head++];
        const px = p % width;
        const py = (p - px) / width;
        area++;
        sumX += px;
        sumY += py;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        // 4-neighbours; bounds-checked before indexing.
        if (px + 1 < width) { const n = p + 1; if (mask[n] && !label[n]) { label[n] = next; queue[tail++] = n; } }
        if (px - 1 >= 0) { const n = p - 1; if (mask[n] && !label[n]) { label[n] = next; queue[tail++] = n; } }
        if (py + 1 < height) { const n = p + width; if (mask[n] && !label[n]) { label[n] = next; queue[tail++] = n; } }
        if (py - 1 >= 0) { const n = p - width; if (mask[n] && !label[n]) { label[n] = next; queue[tail++] = n; } }
      }
      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      const cx = sumX / area;
      const cy = sumY / area;
      components.push({
        label: next, area, minX, maxX, minY, maxY, bw, bh, cx, cy,
        aspect: Math.max(bw, bh) / Math.max(1, Math.min(bw, bh)),
        fill: area / (bw * bh),
        // Distance from the ROI's bottom-right corner — Gemini insets the mark
        // slightly, so the closest qualifying blob to the corner is the star.
        cornerDist: Math.hypot(width - cx, height - cy),
      });
    }
  }
  return { label, components };
}

// Choose the component that is the Gemini sparkle, or null when none qualifies.
// Pure. Applies the shape gates, then prefers the candidate nearest the corner.
export function selectSparkleComponent(components, width, height) {
  const total = width * height;
  const minArea = Math.round(total * MIN_AREA_FRACTION);
  const maxArea = Math.round(total * MAX_AREA_FRACTION);
  const candidates = components
    .filter((c) => c.area >= minArea && c.area <= maxArea && c.aspect < MAX_ASPECT && c.fill >= MIN_FILL && c.fill <= MAX_FILL)
    .sort((a, b) => a.cornerDist - b.cornerDist);
  return candidates[0] || null;
}

// Blur a single-channel mask and return one channel of the result as a
// Uint8Array. NOTE: sharp's blur on a 1-channel raw buffer emits a 3-channel
// result, so we read the reported channel stride rather than assuming 1 — the
// subtle bit both callers below depend on.
async function blurMaskChannel(mask, width, height, radius, sharpImpl) {
  const blurred = await sharpImpl(Buffer.from(mask), { raw: { width, height, channels: 1 } })
    .blur(Math.max(0.3, radius))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { data } = blurred;
  const ch = blurred.info.channels;
  const out = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p++) out[p] = data[p * ch];
  return out;
}

// Grow a binary mask by `radius` px (a cheap blur + low-threshold dilate).
// Returns a Uint8Array of 0/255.
async function dilateMask(mask, width, height, radius, sharpImpl) {
  const blurred = await blurMaskChannel(mask, width, height, radius, sharpImpl);
  const out = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p++) out[p] = blurred[p] > 10 ? 255 : 0;
  return out;
}

// Feather a 0/255 mask into a soft 0..255 alpha for blending.
const featherMask = (mask, width, height, radius, sharpImpl) =>
  blurMaskChannel(mask, width, height, radius, sharpImpl);

// Diffusion inpaint: seed the masked pixels with the blurred background, then
// iterate (blur whole ROI, restore the known pixels) so colour bleeds inward
// from the mask boundary. Returns the filled RGB buffer. `sharpImpl` injectable.
async function diffusionInpaint({ rgb, width, height, channels, bg, bgChannels, grown, radius, iterations, sharpImpl }) {
  const work = Buffer.from(rgb);
  // Seed masked pixels from the background estimate so the first blur has a
  // sane starting colour instead of the bright watermark.
  for (let p = 0; p < width * height; p++) {
    if (!grown[p]) continue;
    const i = p * channels;
    const j = p * bgChannels;
    work[i] = bg[j];
    work[i + 1] = bg[j + 1];
    work[i + 2] = bg[j + 2];
  }
  for (let it = 0; it < iterations; it++) {
    const blurred = await sharpImpl(work, { raw: { width, height, channels } }).blur(radius).raw().toBuffer();
    for (let p = 0; p < width * height; p++) {
      if (!grown[p]) continue;
      const i = p * channels;
      work[i] = blurred[i];
      work[i + 1] = blurred[i + 1];
      work[i + 2] = blurred[i + 2];
    }
  }
  return work;
}

/**
 * Detect + remove the visible Gemini sparkle from a PNG/JPEG/WebP buffer.
 *
 * Returns `{ removed, data, width, height, bbox }`:
 *   - `removed: false` (with `data` === the input buffer) when no sparkle is
 *     found — the caller should NOT write a variant in that case.
 *   - `removed: true` with `data` = a new PNG buffer that has the sparkle
 *     inpainted, plus the detected `bbox` (in full-image coordinates) for logs.
 * Never throws on a decode miss — returns `removed: false` so a bad upload
 * degrades to a no-op rather than a 500. `sharpImpl` is injectable for tests.
 */
export async function removeGeminiSparkle(buffer, { sharpImpl = sharp } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { removed: false, data: buffer, width: null, height: null, bbox: null };
  }
  const meta = await sharpImpl(buffer).metadata().catch(() => null);
  const width = meta?.width;
  const height = meta?.height;
  if (!(width > 0) || !(height > 0)) {
    return { removed: false, data: buffer, width: null, height: null, bbox: null };
  }

  const roi = resolveSparkleRoi(width, height);
  const extracted = await sharpImpl(buffer)
    .extract(roi)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
    .catch(() => null);
  if (!extracted) return { removed: false, data: buffer, width, height, bbox: null };

  const rgb = extracted.data;
  const rw = extracted.info.width;
  const rh = extracted.info.height;
  const channels = extracted.info.channels;

  // Background estimate: a large blur of the ROI (sigma scales with ROI size so
  // it stays "much larger than the sparkle" at every resolution).
  const bgSigma = Math.max(8, Math.round(Math.min(rw, rh) / 6));
  const bgBuf = await sharpImpl(rgb, { raw: { width: rw, height: rh, channels } })
    .blur(bgSigma)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const mask = buildCandidateMask({
    rgb, width: rw, height: rh, channels, bg: bgBuf.data, bgChannels: bgBuf.info.channels,
  });
  const { label, components } = connectedComponents(mask, rw, rh);
  const star = selectSparkleComponent(components, rw, rh);
  if (!star) return { removed: false, data: buffer, width, height, bbox: null };

  // Isolate the chosen component, grow it to cover the soft anti-aliased points,
  // and feather for a seamless blend.
  const selected = new Uint8Array(rw * rh);
  for (let p = 0; p < rw * rh; p++) if (label[p] === star.label) selected[p] = 255;
  // Dilate generously (~30% of the blob's short side): the star's anti-aliased
  // points fade below the detection threshold before they fully end, so the
  // connected component is a touch smaller than the visible mark. Over-growing
  // the mask swallows those faint tips; the feathered alpha keeps the larger
  // fill from showing a hard edge.
  const dilateRadius = Math.max(3, Math.round(Math.min(star.bw, star.bh) * 0.3));
  const grown = await dilateMask(selected, rw, rh, dilateRadius, sharpImpl);
  const alpha = await featherMask(grown, rw, rh, Math.max(2, dilateRadius / 1.2), sharpImpl);

  const filled = await diffusionInpaint({
    rgb, width: rw, height: rh, channels,
    bg: bgBuf.data, bgChannels: bgBuf.info.channels,
    grown, radius: Math.max(2, dilateRadius * 0.8), iterations: 8, sharpImpl,
  });

  // Alpha-blend the inpaint over the original ROI so only the masked region
  // changes and its edge fades smoothly into untouched pixels.
  const blended = Buffer.from(rgb);
  for (let p = 0; p < rw * rh; p++) {
    const a = alpha[p] / 255;
    if (a === 0) continue;
    const i = p * channels;
    for (let c = 0; c < 3; c++) blended[i + c] = Math.round(rgb[i + c] * (1 - a) + filled[i + c] * a);
  }

  const roiPng = await sharpImpl(blended, { raw: { width: rw, height: rh, channels } }).png().toBuffer();
  const data = await sharpImpl(buffer)
    .composite([{ input: roiPng, left: roi.left, top: roi.top }])
    .png()
    .toBuffer();

  return {
    removed: true,
    data,
    width,
    height,
    bbox: {
      left: roi.left + star.minX,
      top: roi.top + star.minY,
      width: star.bw,
      height: star.bh,
    },
  };
}
