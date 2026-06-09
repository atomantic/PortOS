// Visible-watermark removal — erases the Gemini / Nano-Banana "✦" sparkle that
// Google stamps into the BOTTOM-RIGHT corner of its image-gen output.
//
// This is a DIFFERENT problem from SynthID (handled by `imageGen/regen.js`):
//   - SynthID is an *invisible* per-pixel signal → defeated by a generative
//     img2img round-trip / spatial resample.
//   - The sparkle is a *visible*, fixed-position opaque logo → no amount of
//     low-denoise img2img reliably erases a baked-in mark, and the local FLUX
//     runner has no masked-inpaint path. The honest fix is to localize the
//     corner box and reconstruct it from its surroundings.
//
// Method (dependency-free, sharp only — no GPU, runs on every install): solve
// Laplace's equation over the corner box with the surrounding ring as a fixed
// (Dirichlet) boundary. The result is the smooth harmonic membrane that the
// background gradient/texture implies — seamless on plain/gradient corners
// (sky, walls, bokeh), a soft smear on busy ones, but always far better than
// the bright star. We extract only a small patch around the box so memory cost
// is independent of the source resolution.
//
// Scope: post-hoc, gallery-only — a sibling action to "Clean" in the lightbox.
// Never auto-applied. The corner box defaults to the sparkle's typical
// footprint but the caller may override `region` for off-spec placements.

import sharp from 'sharp';
import { ServerError } from './errorHandler.js';

// Cap decoded pixels to guard against decompression-bomb inputs (mirrors the
// limit in imageClean.js — the patch extract reads from the same decode).
const MAX_PIXELS = 96 * 1000 * 1000;

// Default sparkle footprint as a fraction of the image's short side, clamped to
// a sane pixel range. Google's mark sits flush-ish to the bottom-right with a
// small inset; a box anchored to the corner (touching the right + bottom edges)
// guarantees coverage regardless of the exact inset, while the left + top
// borders supply the fill. Tuned generous enough to swallow the star + its
// halo without eating a large slice of real content.
const DEFAULT_REGION_FRACTION = 0.11;
const DEFAULT_REGION_MIN_PX = 56;
const DEFAULT_REGION_MAX_PX = 220;

// Ring of real pixels kept around the box as the fill's boundary condition.
// Proportional to the box so larger images get a proportionally thicker (and
// thus more representative) boundary sample.
const RING_FRACTION = 0.25;
const RING_MIN_PX = 12;

// Gauss-Seidel relaxation sweeps. The box is small (≤220px) so even a few
// hundred sweeps are a few ms; 200 is comfortably past visual convergence for
// this size. Over-relaxation (ω>1) speeds convergence without artifacts.
const SOLVER_ITERATIONS = 200;
const SOLVER_OMEGA = 1.8;

const clampInt = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(n)));

/**
 * Resolve the bottom-right corner box to inpaint. Pure. Returns
 * `{ x, y, w, h }` in image pixel coordinates, anchored to the bottom-right
 * (so the box always touches the right + bottom edges where the sparkle lives).
 *
 * `opts.region` (any subset of `{ x, y, w, h }`) overrides the computed box —
 * each field is clamped to stay within the image. `opts.size` overrides just
 * the square side length (still corner-anchored). The default size scales with
 * the image's short side and is clamped to [MIN, MAX] px.
 */
export function resolveWatermarkRegion(width, height, opts = {}) {
  const W = Math.round(Number(width));
  const H = Math.round(Number(height));
  if (!(W > 0) || !(H > 0)) return { x: 0, y: 0, w: 0, h: 0 };

  const short = Math.min(W, H);
  const defaultSize = clampInt(short * DEFAULT_REGION_FRACTION, DEFAULT_REGION_MIN_PX, DEFAULT_REGION_MAX_PX);
  const size = opts.size != null ? clampInt(opts.size, 1, short) : Math.min(defaultSize, W, H);

  // Corner-anchored default: bottom-right square of `size`.
  let w = Math.min(size, W);
  let h = Math.min(size, H);
  let x = W - w;
  let y = H - h;

  // Optional explicit override — clamp every field into the image bounds so a
  // hand-supplied region can't index outside the decoded buffer.
  const r = opts.region;
  if (r && typeof r === 'object') {
    if (Number.isFinite(r.w)) w = clampInt(r.w, 1, W);
    if (Number.isFinite(r.h)) h = clampInt(r.h, 1, H);
    x = Number.isFinite(r.x) ? clampInt(r.x, 0, W - w) : W - w;
    y = Number.isFinite(r.y) ? clampInt(r.y, 0, H - h) : H - h;
  }
  return { x, y, w, h };
}

/**
 * Harmonic (Laplace) inpaint of a rectangular target inside a raw pixel patch.
 * Pure: mutates `raw` in place for the target pixels and returns it.
 *
 * The target's surrounding pixels (still original) act as fixed boundary
 * values; out-of-patch neighbors (the image edge, on the corner sides) are
 * Neumann (zero-flux) — they contribute nothing, so the fill is driven only by
 * the valid interior borders. Each channel is solved independently.
 *
 *  - `raw`      Uint8(Clamped)Array of the patch, row-major, `channels` deep.
 *  - `pw`/`ph`  patch dimensions in pixels.
 *  - `channels` samples per pixel (3=RGB, 4=RGBA).
 *  - target     `{ x, y, w, h }` rectangle WITHIN the patch to reconstruct.
 */
export function inpaintRegion(raw, pw, ph, channels, target) {
  const { x: tx, y: ty, w: tw, h: th } = target;
  if (!(tw > 0) || !(th > 0)) return raw;
  const at = (px, py, c) => (py * pw + px) * channels + c;

  for (let c = 0; c < channels; c++) {
    // Seed the interior with the mean of the valid boundary ring so relaxation
    // starts near the answer (fewer sweeps to converge).
    let sum = 0;
    let count = 0;
    for (let px = tx; px < tx + tw; px++) {
      if (ty - 1 >= 0) { sum += raw[at(px, ty - 1, c)]; count++; }
      if (ty + th < ph) { sum += raw[at(px, ty + th, c)]; count++; }
    }
    for (let py = ty; py < ty + th; py++) {
      if (tx - 1 >= 0) { sum += raw[at(tx - 1, py, c)]; count++; }
      if (tx + tw < pw) { sum += raw[at(tx + tw, py, c)]; count++; }
    }
    const seed = count ? sum / count : raw[at(tx, ty, c)] || 0;
    for (let py = ty; py < ty + th; py++) {
      for (let px = tx; px < tx + tw; px++) raw[at(px, py, c)] = seed;
    }

    // Gauss-Seidel with successive over-relaxation. Neighbors outside the patch
    // (image edge) are skipped (Neumann); in-bounds neighbors — whether fixed
    // boundary or still-relaxing interior — are averaged.
    for (let iter = 0; iter < SOLVER_ITERATIONS; iter++) {
      for (let py = ty; py < ty + th; py++) {
        for (let px = tx; px < tx + tw; px++) {
          let acc = 0;
          let n = 0;
          if (px - 1 >= 0) { acc += raw[at(px - 1, py, c)]; n++; }
          if (px + 1 < pw) { acc += raw[at(px + 1, py, c)]; n++; }
          if (py - 1 >= 0) { acc += raw[at(px, py - 1, c)]; n++; }
          if (py + 1 < ph) { acc += raw[at(px, py + 1, c)]; n++; }
          if (!n) continue;
          const i = at(px, py, c);
          const next = raw[i] + SOLVER_OMEGA * (acc / n - raw[i]);
          raw[i] = next < 0 ? 0 : next > 255 ? 255 : next;
        }
      }
    }
  }
  return raw;
}

/**
 * Remove the bottom-right Gemini/Nano-Banana sparkle from a PNG/JPEG/WebP
 * buffer. Throws ServerError(400) on invalid input. Returns
 * `{ data, format, width, height, region, sizeBefore, sizeAfter }` where `data`
 * is the re-encoded PNG and `region` is the box that was reconstructed.
 *
 * Only a small patch around the corner box is decoded/inpainted/composited, so
 * cost stays flat regardless of source resolution.
 */
export async function removeCornerWatermark(buffer, opts = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ServerError('Decoded payload is empty', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const meta = await sharp(buffer, { limitInputPixels: MAX_PIXELS }).metadata().catch(() => null);
  const width = meta?.width;
  const height = meta?.height;
  if (!(width > 0) || !(height > 0)) {
    throw new ServerError('Invalid or corrupt image', { status: 400, code: 'INVALID_IMAGE' });
  }

  const region = resolveWatermarkRegion(width, height, opts);
  if (!(region.w > 0) || !(region.h > 0)) {
    throw new ServerError('Could not resolve a watermark region for this image', {
      status: 400,
      code: 'INVALID_IMAGE',
    });
  }

  // Patch = the box grown by a boundary ring, clamped to the image. The ring is
  // the fixed boundary the fill interpolates from. On the corner sides (right /
  // bottom) the ring is zero-width — those neighbors are the image edge.
  const ring = Math.max(RING_MIN_PX, Math.round(Math.max(region.w, region.h) * RING_FRACTION));
  const px0 = Math.max(0, region.x - ring);
  const py0 = Math.max(0, region.y - ring);
  const px1 = Math.min(width, region.x + region.w + ring);
  const py1 = Math.min(height, region.y + region.h + ring);
  const pw = px1 - px0;
  const ph = py1 - py0;

  // Decode just the patch to raw pixels (preserving any alpha channel).
  const { data: raw, info } = await sharp(buffer, { limitInputPixels: MAX_PIXELS })
    .extract({ left: px0, top: py0, width: pw, height: ph })
    .raw()
    .toBuffer({ resolveWithObject: true })
    .catch(() => ({ data: null, info: null }));
  if (!raw || !info) {
    throw new ServerError('Invalid or corrupt image', { status: 400, code: 'INVALID_IMAGE' });
  }

  // Target rectangle expressed in patch-local coordinates.
  const target = { x: region.x - px0, y: region.y - py0, w: region.w, h: region.h };
  inpaintRegion(raw, pw, ph, info.channels, target);

  // Re-encode the filled patch and composite it back over the original at the
  // patch offset. Compositing only the patch keeps the rest byte-faithful.
  const patchPng = await sharp(raw, { raw: { width: pw, height: ph, channels: info.channels } })
    .png()
    .toBuffer();
  const out = await sharp(buffer, { limitInputPixels: MAX_PIXELS })
    .composite([{ input: patchPng, left: px0, top: py0 }])
    .png({ compressionLevel: 9 })
    .toBuffer()
    .catch((err) => {
      throw new ServerError('Failed to composite cleaned region', {
        status: 400,
        code: 'INVALID_IMAGE',
        context: { details: { reason: err.message } },
      });
    });

  return {
    data: out,
    format: 'png',
    width,
    height,
    region,
    sizeBefore: buffer.length,
    sizeAfter: out.length,
  };
}
