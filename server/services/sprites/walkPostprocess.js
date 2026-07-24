/**
 * Sprites — deterministic walk-animation postprocess (issue #2897, phase 3).
 *
 * Node/sharp/ffmpeg port of the source pipeline's `animation_postprocess.py`:
 * extract frames from the one grok walk video → recover straight alpha from
 * the keyed matte (measured border key, per-channel unmix) → select the best
 * walk cycle by image distance → one-fixed-scale translation-only pivot
 * alignment onto 384×384 cells → key-vector despill → validate → pack the 8
 * named gait-phase strip + contrast review sheet + run manifest with
 * per-frame sha256s. Everything after the video is deterministic local work —
 * no AI calls.
 *
 * Deviations from the source (deliberate, per the #2895 decisions):
 * - All "magenta" math is key-parameterized via keyChannelSplit (the record's
 *   chroma key may be magenta, green, or blue). For magenta the formulas
 *   reduce to the source's exactly (highs r+b, low g).
 * - Python `round()` is half-to-even (banker's); `pyRound` replicates it
 *   because cycle resampling (`round(i*len/8)`) and channel math genuinely
 *   pick different frames/values under Math.round's half-up.
 */

import sharp from 'sharp';
import { join } from 'path';
import { readdir, writeFile } from 'fs/promises';
import { createHash } from 'crypto';
import { ensureDir, atomicWrite, sha256File } from '../../lib/fileUtils.js';
import { findFfmpeg, runFfmpegProcess } from '../../lib/ffmpeg.js';
import { keyChannelSplit, keyness, keyShareFn } from './chromaKey.js';

// Source pipeline constants (animation_postprocess.py) — values are part of
// the cross-install artifact contract (imported manifests carry them).
export const WALK_FPS = 12;
export const WALK_FRAME_COUNT = 8;
export const MAX_SOURCE_SECONDS = 8;
export const MAX_SOURCE_DIMENSION = 512;
export const WALK_CELL_SIZE = 384;
export const WALK_PIVOT = [WALK_CELL_SIZE / 2, 352]; // [192, 352]
export const WALK_PHASES = [
  'left-contact', 'left-down', 'left-passing', 'left-up',
  'right-contact', 'right-down', 'right-passing', 'right-up',
];

const KEY_NOISE_FLOOR = 0.01;        // background share below this → fully opaque
const BACKGROUND_ALPHA_FLOOR = 0.06; // source alpha at/below this → fully transparent
const ALPHA_NOISE_FLOOR = 2;         // output alpha at/below this → zeroed
const KEY_DESPILL_FLOOR = 4;         // keyness above this marks a despill suspect
const KEY_VALIDATION_FLOOR = 8;      // keyness above this fails validation
const KEY_REPAIR_RADIUS = 8;         // despill neighbor-search chebyshev radius
const OPAQUE_EDGE_ALPHA = 245;       // alpha at/above this counts as clean/opaque
const BBOX_ALPHA_THRESHOLD = 24;     // alpha_bbox visibility threshold
const ROOT_ALPHA_THRESHOLD = 48;     // root_x band pixel threshold
const SIGNATURE_SIZE = 48;
const SIGNATURE_BACKGROUND = { r: 48, g: 52, b: 54 };
const MIN_CYCLE_MOTION = 0.75;
const MAX_KEY_MASS = 2500;

/** Python round(): half-to-even. Exported for tests. */
export function pyRound(x) {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Python round(x, dp): half-to-even at dp decimals (manifest floats). */
export function pyRoundTo(x, dp) {
  const scale = 10 ** dp;
  return pyRound(x * scale) / scale;
}

const clampChannel = (v) => Math.max(0, Math.min(255, pyRound(v)));

/** statistics.median: middle value, or mean of the two middles. */
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export const sha256Buffer = (buf) => createHash('sha256').update(buf).digest('hex');

/** Decode a PNG to a raw RGBA frame `{ data, width, height }`. */
export async function decodeRgbaFrame(src) {
  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

// Encode + write + hash in one pass — hashing the in-memory PNG buffer saves
// reading every just-written artifact back off disk purely to checksum it.
async function encodePngWithHash(frame, dest, channels = 4) {
  const buf = await sharp(frame.data, { raw: { width: frame.width, height: frame.height, channels } })
    .png()
    .toBuffer();
  await writeFile(dest, buf);
  return sha256Buffer(buf);
}

/**
 * Measure the actual background key of a frame: per-channel median over a
 * thin border band (the generated video's matte is close to, but rarely
 * exactly, the requested key — codecs shift it).
 */
export function sampleBorderKey(frame) {
  const { data, width, height } = frame;
  const minDim = Math.min(width, height);
  const band = Math.max(4, Math.floor(minDim / 120));
  const step = Math.max(1, Math.floor(minDim / 320));
  const rs = []; const gs = []; const bs = [];
  const push = (x, y) => {
    const i = (y * width + x) * 4;
    rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
  };
  for (let x = 0; x < width; x += step) {
    for (let o = 0; o < band && o < height; o++) {
      push(x, o);
      push(x, height - 1 - o);
    }
  }
  for (let y = 0; y < height; y += step) {
    for (let o = 0; o < band && o < width; o++) {
      push(o, y);
      push(width - 1 - o, y);
    }
  }
  return [pyRound(median(rs)), pyRound(median(gs)), pyRound(median(bs))];
}

/**
 * Reject a measured border key that isn't a plausible sample of the expected
 * chroma key: its saturated channels must dominate its dark channels by ≥80,
 * and channels within each group must be balanced within 80 (the source's
 * "balanced magenta" check, generalized).
 */
export function validateMeasuredKey(measured, split, keyHex) {
  const minHigh = Math.min(...split.highs.map((i) => measured[i]));
  const maxLow = Math.max(...split.lows.map((i) => measured[i]));
  const groupSpread = (idx) => Math.max(...idx.map((i) => measured[i])) - Math.min(...idx.map((i) => measured[i]));
  if (minHigh - maxLow < 80 || groupSpread(split.highs) > 80 || groupSpread(split.lows) > 80) {
    throw new Error(`Measured background [${measured.join(',')}] is not a usable ${keyHex} matte`);
  }
}

/**
 * Chroma un-key: reverse antialiased source-over-key compositing into a
 * straight-alpha RGBA frame. Per-pixel math is the source's, generalized to
 * (high, low) channel pairs of the record's key.
 */
export function recoverAlphaFrame(frame, measuredKey, split) {
  const { data, width, height } = frame;
  const out = Buffer.alloc(width * height * 4);
  const shareOf = keyShareFn(measuredKey, split);
  const px = [0, 0, 0];
  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    px[0] = data[i]; px[1] = data[i + 1]; px[2] = data[i + 2];
    const share = shareOf(px);
    if (share < KEY_NOISE_FLOOR) {
      out[i] = px[0]; out[i + 1] = px[1]; out[i + 2] = px[2]; out[i + 3] = 255;
      continue;
    }
    const sourceAlpha = 1 - share;
    if (sourceAlpha <= BACKGROUND_ALPHA_FLOOR) continue; // stays (0,0,0,0)
    const outputAlpha = clampChannel(((sourceAlpha - BACKGROUND_ALPHA_FLOOR) * 255) / (1 - BACKGROUND_ALPHA_FLOOR));
    if (outputAlpha <= ALPHA_NOISE_FLOOR) continue;
    out[i] = clampChannel((px[0] - share * measuredKey[0]) / sourceAlpha);
    out[i + 1] = clampChannel((px[1] - share * measuredKey[1]) / sourceAlpha);
    out[i + 2] = clampChannel((px[2] - share * measuredKey[2]) / sourceAlpha);
    out[i + 3] = outputAlpha;
  }
  return { data: out, width, height };
}

const lowMean = (data, i, split) => {
  let sum = 0;
  for (const l of split.lows) sum += data[i + l];
  return sum / split.lows.length;
};

/**
 * Key-vector despill: repair codec-spread key spill by borrowing RGB from
 * the nearest clean opaque neighbor (ring search), falling back to direct
 * spill subtraction from the key's high channels. Alpha is preserved.
 */
export function despillKeyFrame(frame, split) {
  const { data, width, height } = frame;
  const out = Buffer.from(data);
  const suspects = new Uint8Array(width * height);
  const px = [0, 0, 0];
  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    const a = data[i + 3];
    if (a <= ALPHA_NOISE_FLOOR) continue;
    px[0] = data[i]; px[1] = data[i + 1]; px[2] = data[i + 2];
    if (a < OPAQUE_EDGE_ALPHA || keyness(px, split) > KEY_DESPILL_FLOOR) suspects[p] = 1;
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (!suspects[p]) continue;
      const i = p * 4;
      const pixLow = lowMean(data, i, split);
      let best = null; // [dist2, -alpha, lowDist, r, g, b]
      for (let radius = 1; radius <= KEY_REPAIR_RADIUS && !best; radius++) {
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
            const nx = x + dx; const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const np = ny * width + nx;
            if (suspects[np]) continue;
            const ni = np * 4;
            const na = data[ni + 3];
            if (na < OPAQUE_EDGE_ALPHA) continue;
            const cand = [
              dx * dx + dy * dy, -na, Math.abs(lowMean(data, ni, split) - pixLow),
              data[ni], data[ni + 1], data[ni + 2],
            ];
            if (!best || candLess(cand, best)) best = cand;
          }
        }
      }
      if (best) {
        out[i] = best[3]; out[i + 1] = best[4]; out[i + 2] = best[5];
      } else {
        px[0] = data[i]; px[1] = data[i + 1]; px[2] = data[i + 2];
        const spill = Math.max(0, keyness(px, split));
        for (const h of split.highs) out[i + h] = Math.max(0, data[i + h] - spill);
      }
    }
  }
  // Final sweep: fully clear noise-floor alpha so transparent pixels carry
  // no stray RGB into premultiplied resizes downstream.
  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    if (out[i + 3] <= ALPHA_NOISE_FLOOR) {
      out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 0;
    }
  }
  return { data: out, width, height };
}

function candLess(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

/**
 * 48×48 RGB comparison signature: composite over the neutral gray, bilinear
 * downscale. Drives cycle selection and loop-seam validation.
 */
export async function signatureOf(frame) {
  return sharp(frame.data, { raw: { width: frame.width, height: frame.height, channels: 4 } })
    .flatten({ background: SIGNATURE_BACKGROUND })
    .resize(SIGNATURE_SIZE, SIGNATURE_SIZE, { kernel: 'linear', fit: 'fill' })
    .raw()
    .toBuffer();
}

/** Mean absolute RGB difference between two signatures (PIL ImageStat semantics). */
export function imageDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/**
 * Find the best walk-cycle window by endpoint-seam continuity vs motion, and
 * resample it onto the 8 gait phases. `signatures` is one entry per recovered
 * source frame.
 */
export function selectCycleIndices(signatures) {
  const n = signatures.length;
  if (n < WALK_FRAME_COUNT + 1) {
    throw new Error(`Need at least ${WALK_FRAME_COUNT + 1} extracted frames, got ${n}`);
  }
  let best = null; // [score, start, cycleLength, seam, motion]
  const maxLen = Math.min(18, n - 1);
  for (let cycleLength = WALK_FRAME_COUNT; cycleLength <= maxLen; cycleLength++) {
    for (let start = 0; start < n - cycleLength; start++) {
      const seam = imageDistance(signatures[start], signatures[start + cycleLength]);
      const motionSamples = [];
      for (let i = start; i < start + cycleLength; i++) {
        motionSamples.push(imageDistance(signatures[i], signatures[i + 1]));
      }
      const motion = median(motionSamples);
      if (motion < MIN_CYCLE_MOTION) continue;
      const score = seam + Math.abs(cycleLength - WALK_FPS) * 0.2 - Math.min(motion, 12) * 0.12;
      const cand = [score, start, cycleLength, seam, motion];
      if (!best || candLess(cand, best)) best = cand;
    }
  }
  if (!best) throw new Error('No detectable moving walk cycle in the source video');
  const [, start, cycleLength, seam, motion] = best;
  const indices = Array.from({ length: WALK_FRAME_COUNT }, (_, i) => start + pyRound((i * cycleLength) / WALK_FRAME_COUNT));
  if (new Set(indices).size !== WALK_FRAME_COUNT) {
    throw new Error('Cycle window too short to resample 8 distinct phases');
  }
  return {
    indices,
    cycle: {
      windowStart: start,
      windowLength: cycleLength,
      endpointSeamScore: pyRoundTo(seam, 4),
      medianMotionScore: pyRoundTo(motion, 4),
    },
  };
}

/** Tight bbox of visible (alpha > threshold) pixels; exclusive right/bottom. */
export function alphaBbox(frame, threshold = BBOX_ALPHA_THRESHOLD) {
  const { data, width, height } = frame;
  let left = width; let top = height; let right = -1; let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > threshold) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < 0) return null;
  return { left, top, right: right + 1, bottom: bottom + 1 };
}

/**
 * x-center of the character at the hip/leg band (42%–76% of bbox height) —
 * the per-frame pivot the alignment pins to x=192.
 */
export function rootX(frame, bbox) {
  const { data, width } = frame;
  const H = bbox.bottom - bbox.top;
  const bandTop = bbox.top + pyRound(H * 0.42);
  const bandBottom = bbox.top + pyRound(H * 0.76);
  const xs = [];
  for (let y = bandTop; y < bandBottom; y++) {
    for (let x = bbox.left; x < bbox.right; x++) {
      if (data[(y * width + x) * 4 + 3] > ROOT_ALPHA_THRESHOLD) xs.push(x);
    }
  }
  return xs.length ? median(xs) : (bbox.left + bbox.right) / 2;
}

function cropFrame(frame, bbox) {
  const w = bbox.right - bbox.left;
  const h = bbox.bottom - bbox.top;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcStart = ((bbox.top + y) * frame.width + bbox.left) * 4;
    frame.data.copy(out, y * w * 4, srcStart, srcStart + w * 4);
  }
  return { data: out, width: w, height: h };
}

// sharp premultiplies alpha before resampling and unpremultiplies after —
// the same alpha-weighted LANCZOS the source's premultiplied_resize does.
export async function premultipliedResize(frame, width, height) {
  const data = await sharp(frame.data, { raw: { width: frame.width, height: frame.height, channels: 4 } })
    .resize(width, height, { kernel: 'lanczos3', fit: 'fill' })
    .raw()
    .toBuffer();
  return { data, width, height };
}

export function compositeOnto(canvas, frame, dx, dy) {
  // Straight-alpha source-over; destinations may be clipped at canvas edges.
  const { data, width, height } = frame;
  for (let y = 0; y < height; y++) {
    const cy = dy + y;
    if (cy < 0 || cy >= canvas.height) continue;
    for (let x = 0; x < width; x++) {
      const cx = dx + x;
      if (cx < 0 || cx >= canvas.width) continue;
      const si = (y * width + x) * 4;
      const sa = data[si + 3] / 255;
      if (sa === 0) continue;
      const di = (cy * canvas.width + cx) * 4;
      const da = canvas.data[di + 3] / 255;
      const oa = sa + da * (1 - sa);
      for (let c = 0; c < 3; c++) {
        canvas.data[di + c] = oa === 0 ? 0 : pyRound((data[si + c] * sa + canvas.data[di + c] * da * (1 - sa)) / oa);
      }
      canvas.data[di + 3] = pyRound(oa * 255);
    }
  }
}

const blankFrame = (width, height) => ({ data: Buffer.alloc(width * height * 4), width, height });

/**
 * One fixed scale + per-frame integer translation: every frame shares the
 * scale that fits the largest bbox into the cell; the hip pivot lands on
 * x=192 and the feet baseline on y=352.
 */
export async function alignFrames(frames) {
  const bboxes = frames.map((f) => {
    const bbox = alphaBbox(f);
    if (!bbox) throw new Error('Frame has no visible character');
    return bbox;
  });
  const maxWidth = Math.max(...bboxes.map((b) => b.right - b.left));
  const maxHeight = Math.max(...bboxes.map((b) => b.bottom - b.top));
  const scale = Math.min(1, (WALK_CELL_SIZE * 0.78) / maxWidth, (WALK_CELL_SIZE * 0.82) / maxHeight);
  const aligned = [];
  const translations = [];
  for (let i = 0; i < frames.length; i++) {
    const bbox = bboxes[i];
    const cropped = cropFrame(frames[i], bbox);
    const size = [Math.max(1, pyRound(cropped.width * scale)), Math.max(1, pyRound(cropped.height * scale))];
    const resized = await premultipliedResize(cropped, size[0], size[1]);
    const sourceRootX = (rootX(frames[i], bbox) - bbox.left) * scale;
    const dx = pyRound(WALK_PIVOT[0] - sourceRootX);
    const dy = pyRound(WALK_PIVOT[1] - resized.height);
    const canvas = blankFrame(WALK_CELL_SIZE, WALK_CELL_SIZE);
    compositeOnto(canvas, resized, dx, dy);
    aligned.push(canvas);
    translations.push([dx, dy]);
  }
  return {
    frames: aligned,
    alignment: {
      cellSize: WALK_CELL_SIZE,
      fixedScale: pyRoundTo(scale, 8),
      targetPivot: WALK_PIVOT,
      operation: 'one-fixed-scale-plus-per-frame-translation',
      translations,
    },
  };
}

/** Pack the 8 aligned frames into the single-row 3072×384 strip. */
export function packStrip(frames) {
  const strip = blankFrame(WALK_CELL_SIZE * frames.length, WALK_CELL_SIZE);
  frames.forEach((frame, i) => compositeOnto(strip, frame, i * WALK_CELL_SIZE, 0));
  return strip;
}

function keyMass(frame, split) {
  const { data } = frame;
  const px = [0, 0, 0];
  let mass = 0;
  for (let i = 0; i < data.length; i += 4) {
    px[0] = data[i]; px[1] = data[i + 1]; px[2] = data[i + 2];
    mass += Math.max(0, keyness(px, split)) * (data[i + 3] / 255);
  }
  return pyRoundTo(mass, 3);
}

function keyDominantPixels(frame, split) {
  const { data } = frame;
  const px = [0, 0, 0];
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] <= ALPHA_NOISE_FLOOR) continue;
    px[0] = data[i]; px[1] = data[i + 1]; px[2] = data[i + 2];
    if (keyness(px, split) > KEY_VALIDATION_FLOOR) count++;
  }
  return count;
}

/**
 * Validate the packed candidate: 8 distinct frames, tolerable loop seam,
 * no visible key residue.
 */
export async function validateFrames(frames, split) {
  if (frames.length !== WALK_FRAME_COUNT) {
    throw new Error(`Expected ${WALK_FRAME_COUNT} frames, got ${frames.length}`);
  }
  const hashes = frames.map((f) => sha256Buffer(f.data));
  if (new Set(hashes).size !== frames.length) throw new Error('Duplicate frames in the packed cycle');
  const signatures = await Promise.all(frames.map(signatureOf));
  const adjacent = signatures.map((sig, i) => pyRoundTo(imageDistance(sig, signatures[(i + 1) % frames.length]), 4));
  const seam = adjacent[adjacent.length - 1];
  const typical = median(adjacent.slice(0, -1));
  if (seam > Math.max(12, typical * 2.5)) {
    throw new Error(`Loop seam too visible (seam ${seam} vs typical ${pyRoundTo(typical, 4)})`);
  }
  const dominant = frames.map((f) => keyDominantPixels(f, split));
  const masses = frames.map((f) => keyMass(f, split));
  if (dominant.some((c) => c > 0)) throw new Error('Visible key color remains after despill');
  if (masses.some((m) => m > MAX_KEY_MASS)) throw new Error('Excess alpha-weighted key mass after despill');
  return {
    distinctFrames: true,
    adjacentDifferenceScores: adjacent,
    loopSeamScore: seam,
    medianAdjacentScore: pyRoundTo(typical, 4),
    keyDominantPixels: dominant,
    alphaWeightedKeyMass: masses,
    backgroundsReviewed: ['light', 'dark', 'checker'],
  };
}

const CONTRAST_THUMB = 128;
const CONTRAST_ROWS = [
  { key: 'light', color: [244, 241, 232] },
  { key: 'dark', color: [22, 28, 31] },
  { key: 'checker', color: null },
];
const CHECKER_LIGHT = [222, 227, 229];
const CHECKER_DARK = [171, 181, 185];
const CHECKER_SQUARE = 16;

/** 3-row (light/dark/checker) contrast review sheet, RGB 1024×384. */
export async function buildContrastSheet(frames) {
  const width = CONTRAST_THUMB * frames.length;
  const height = CONTRAST_THUMB * CONTRAST_ROWS.length;
  const sheet = Buffer.alloc(width * height * 3);
  const thumbs = await Promise.all(frames.map((f) => premultipliedResize(f, CONTRAST_THUMB, CONTRAST_THUMB)));
  CONTRAST_ROWS.forEach((row, rowIdx) => {
    thumbs.forEach((thumb, col) => {
      for (let y = 0; y < CONTRAST_THUMB; y++) {
        for (let x = 0; x < CONTRAST_THUMB; x++) {
          const bg = row.color
            || ((Math.floor(x / CHECKER_SQUARE) + Math.floor(y / CHECKER_SQUARE)) % 2 === 0 ? CHECKER_LIGHT : CHECKER_DARK);
          const si = (y * CONTRAST_THUMB + x) * 4;
          const a = thumb.data[si + 3] / 255;
          const di = ((rowIdx * CONTRAST_THUMB + y) * width + col * CONTRAST_THUMB + x) * 3;
          for (let c = 0; c < 3; c++) {
            sheet[di + c] = clampChannel(thumb.data[si + c] * a + bg[c] * (1 - a));
          }
        }
      }
    });
  });
  return { data: sheet, width, height };
}

/**
 * Extract raw frames from the walk video: 12fps, longest side capped at 512
 * (decrease-only), first 8 seconds. Returns the sorted raw PNG filenames.
 */
export async function extractVideoFrames(videoPath, rawDir) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new Error('ffmpeg not found — install ffmpeg to postprocess walk videos');
  await ensureDir(rawDir);
  const result = await runFfmpegProcess({
    bin: ffmpeg,
    args: [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', videoPath,
      '-vf', `fps=${WALK_FPS},scale=w='min(${MAX_SOURCE_DIMENSION},iw)':h='min(${MAX_SOURCE_DIMENSION},ih)':force_original_aspect_ratio=decrease`,
      '-t', String(MAX_SOURCE_SECONDS),
      join(rawDir, 'source-%04d.png'),
    ],
  });
  if (!result.ok) throw new Error(`Frame extraction failed: ${result.reason}`);
  const names = (await readdir(rawDir)).filter((n) => /^source-\d{4}\.png$/.test(n)).sort();
  if (!names.length) throw new Error('Frame extraction produced no frames');
  return names;
}

/**
 * Prepare the transparent i2v motion input from a locked anchor (opaque on
 * its key): measured-key alpha recovery + despill, saved as a straight-alpha
 * PNG. An anchor that already carries transparency is passed through.
 */
export async function prepareWalkAnchorInput(anchorAbs, destAbs, chromaKey) {
  const split = keyChannelSplit(chromaKey);
  const frame = await decodeRgbaFrame(anchorAbs);
  let alreadyTransparent = false;
  for (let i = 3; i < frame.data.length; i += 4) {
    if (frame.data[i] < 255) { alreadyTransparent = true; break; }
  }
  let prepared = frame;
  if (!alreadyTransparent) {
    const measured = sampleBorderKey(frame);
    validateMeasuredKey(measured, split, chromaKey);
    prepared = recoverAlphaFrame(frame, measured, split);
  }
  prepared = despillKeyFrame(prepared, split);
  const sha256 = await encodePngWithHash(prepared, destAbs);
  return { preparation: 'measured-key-alpha-recovery-plus-despill', sha256 };
}

/**
 * The full deterministic postprocess for one completed walk video.
 *
 * `runRel` is the record-relative run root (`runs/walk-<dir>-<jobId>`); all
 * artifacts are written under `<runAbs>/generated/` and all manifest paths
 * are record-relative, matching what the phase-1 importer expects.
 */
export async function runWalkPostprocess({
  recordId, direction, chromaKey, runAbs, runRel, anchorRel, anchorAbs, videoAbs,
}) {
  const split = keyChannelSplit(chromaKey);
  const generatedAbs = join(runAbs, 'generated');
  const generatedRel = `${runRel}/generated`;
  const rawDir = join(generatedAbs, 'raw');

  const rawNames = await extractVideoFrames(videoAbs, rawDir);
  const recovered = [];
  const measuredKeys = [];
  for (const name of rawNames) {
    const frame = await decodeRgbaFrame(join(rawDir, name));
    const measured = sampleBorderKey(frame);
    validateMeasuredKey(measured, split, chromaKey);
    measuredKeys.push(measured);
    recovered.push(recoverAlphaFrame(frame, measured, split));
  }

  const signatures = await Promise.all(recovered.map(signatureOf));
  const { indices, cycle } = selectCycleIndices(signatures);
  const selected = indices.map((i) => recovered[i]);

  const { frames: aligned, alignment } = await alignFrames(selected);
  const despilled = aligned.map((f) => despillKeyFrame(f, split));
  const validation = await validateFrames(despilled, split);

  const framesDir = join(generatedAbs, 'frames');
  await ensureDir(framesDir);
  const frameRecords = [];
  for (let i = 0; i < despilled.length; i++) {
    const phase = WALK_PHASES[i];
    const name = `${String(i).padStart(2, '0')}-${phase}.png`;
    frameRecords.push({
      outputIndex: i,
      phase,
      sourceFrameIndex: indices[i] + 1, // 1-based, matches raw source-%04d numbering
      sourcePath: `${generatedRel}/raw/${rawNames[indices[i]]}`,
      sourceSha256: await sha256File(join(rawDir, rawNames[indices[i]])),
      measuredKeyRgb: measuredKeys[indices[i]],
      path: `${generatedRel}/frames/${name}`,
      sha256: await encodePngWithHash(despilled[i], join(framesDir, name)),
    });
  }

  const stripName = `${recordId}-walk-${direction}-strip.png`;
  const stripSha256 = await encodePngWithHash(packStrip(despilled), join(generatedAbs, stripName));

  const reviewDir = join(generatedAbs, 'review');
  await ensureDir(reviewDir);
  const contrastName = `${recordId}-walk-${direction}-contrast-review.png`;
  const comparisonSha256 = await encodePngWithHash(await buildContrastSheet(despilled), join(reviewDir, contrastName), 3);

  const manifestName = `${recordId}-walk-${direction}-manifest.json`;
  const manifest = {
    schemaVersion: 1,
    kind: 'deterministically-packaged-grok-walk-video',
    status: 'candidate',
    characterId: recordId,
    direction,
    chromaKey,
    anchorPath: anchorRel,
    anchorSha256: await sha256File(anchorAbs),
    sourceVideoPath: `${generatedRel}/source-video.mp4`,
    sourceVideoSha256: await sha256File(videoAbs),
    postprocessorPath: 'server/services/sprites/walkPostprocess.js',
    manifestPath: `${generatedRel}/${manifestName}`,
    frameRate: WALK_FPS,
    frameCount: WALK_FRAME_COUNT,
    cycleSelection: cycle,
    chromaCleanup: {
      method: 'measured-key-unmixing-plus-key-vector-despill',
      keyColor: chromaKey,
      despillFloor: KEY_DESPILL_FLOOR,
      validationFloor: KEY_VALIDATION_FLOOR,
    },
    alignment,
    validation,
    frames: frameRecords,
    stripPath: `${generatedRel}/${stripName}`,
    stripSha256,
    comparisonPath: `${generatedRel}/review/${contrastName}`,
    comparisonSha256,
  };
  await atomicWrite(join(generatedAbs, manifestName), manifest);

  const stripPreview = {
    stripPath: `${generatedRel}/${stripName}`,
    frameCount: WALK_FRAME_COUNT,
    fps: WALK_FPS,
    cellWidth: WALK_CELL_SIZE,
    cellHeight: WALK_CELL_SIZE,
    row: 0,
    startColumn: 0,
  };
  await atomicWrite(join(generatedAbs, 'review-preview.json'), stripPreview);

  return { manifest, manifestPath: `${generatedRel}/${manifestName}`, stripPreview };
}
