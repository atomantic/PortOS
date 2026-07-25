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
import { keyChannelSplit, keyness, keyShareFn, hexToRgb } from './chromaKey.js';

// Authoring bounds + pure label/clamp helpers live in a sharp-free leaf module
// so server/lib/validation.js can share the SAME frame-count/fps range without
// pulling this module's native image graph in. Re-exported here so existing
// consumers (walk.js, atlas.js) keep importing them from walkPostprocess.
import {
  WALK_FRAME_COUNT, WALK_DEFAULT_FRAME_COUNT, WALK_DEFAULT_FPS,
} from './walkBounds.js';
import { WALK_TRACK, getAnimationTrack, clampTrackFrameCount, clampTrackFps } from './animationTracks.js';
import { trackColumnLabels } from './atlasGrid.js';

export {
  WALK_PHASES, WALK_FRAME_COUNT, WALK_DEFAULT_FRAME_COUNT, WALK_DEFAULT_FPS,
  WALK_MIN_FRAME_COUNT, WALK_MAX_FRAME_COUNT, WALK_MIN_FPS, WALK_MAX_FPS,
  walkPhaseLabels, clampFrameCount, clampFps,
} from './walkBounds.js';

// Source pipeline constants (animation_postprocess.py) — values are part of
// the cross-install artifact contract (imported manifests carry them).
// WALK_FPS is the source-EXTRACTION sampling rate (how densely we pull frames
// out of grok's clip); it is ALSO the legacy playback-fps fallback for older
// manifests that omit `frameRate`. Playback fps (how fast the packed cycle
// animates) is now a separate, per-run value carried in the manifest.
export const WALK_FPS = 12;
export const MAX_SOURCE_SECONDS = 8;
export const MAX_SOURCE_DIMENSION = 512;
export const WALK_CELL_SIZE = 384;
export const WALK_PIVOT = [WALK_CELL_SIZE / 2, 352]; // [192, 352]

// Border-key acceptance thresholds. The key channels must dominate the dark
// channels by ≥ KEY_DOMINANCE_MIN, and each channel group must be balanced
// within KEY_GROUP_SPREAD_MAX. The spread tolerance was 80 (tuned to the source
// pipeline's near-ideal [255,0,255] magenta). Even when grok is handed the exact
// magenta matte (see prepareWalkAnchorChromaInput), the H.264 4:2:0 chroma
// subsampling in the delivered MP4 shifts saturated magenta at decode — a real
// trailhand clip measured ~[250,56,152] (r-b spread ~98) at the border. That is
// still a perfectly usable matte: the per-channel unmix keys off the MEASURED
// background, so a consistent codec-shifted matte reverses correctly. 120 admits
// it while still rejecting a single-channel-dominant color (e.g. [255,0,100]
// spread 155 = "red with a little blue", not magenta).
const KEY_DOMINANCE_MIN = 80;
const KEY_GROUP_SPREAD_MAX = 120;
const KEY_NOISE_FLOOR = 0.01;        // background share below this → fully opaque
const BACKGROUND_ALPHA_FLOOR = 0.06; // source alpha at/below this → fully transparent
const ALPHA_NOISE_FLOOR = 2;         // output alpha at/below this → zeroed
const KEY_DESPILL_FLOOR = 4;         // keyness above this marks a despill suspect
const KEY_VALIDATION_FLOOR = 8;      // keyness above this fails validation
const KEY_REPAIR_RADIUS = 8;         // despill neighbor-search chebyshev radius
const OPAQUE_EDGE_ALPHA = 245;       // alpha at/above this counts as clean/opaque
const BBOX_ALPHA_THRESHOLD = 24;     // alpha_bbox visibility threshold
const ROOT_ALPHA_THRESHOLD = 48;     // root_x band pixel threshold
// How many opaque pixels a row needs to count as the character's sole rather
// than a stray speck (#3021). A real sole is tens of pixels wide at these
// scales; a despill survivor or shadow remnant is one or two.
export const ROBUST_BASELINE_MIN_PIXELS = 3;
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
 * Is a measured border key a plausible sample of the expected chroma key? Its
 * saturated channels must dominate its dark channels by ≥80, and channels
 * within each group must be balanced within 80 (the source's "balanced
 * magenta" check, generalized). A grok clip that fades in from — or pads with
 * — a black/near-black frame samples as [0,0,0] here and returns false, so the
 * caller can drop that frame rather than fail the whole run on it.
 */
export function isUsableMeasuredKey(measured, split) {
  const minHigh = Math.min(...split.highs.map((i) => measured[i]));
  const maxLow = Math.max(...split.lows.map((i) => measured[i]));
  const groupSpread = (idx) => Math.max(...idx.map((i) => measured[i])) - Math.min(...idx.map((i) => measured[i]));
  return !(minHigh - maxLow < KEY_DOMINANCE_MIN
    || groupSpread(split.highs) > KEY_GROUP_SPREAD_MAX
    || groupSpread(split.lows) > KEY_GROUP_SPREAD_MAX);
}

/**
 * Throwing variant for single-image callers (the anchor input prep), where a
 * non-key measurement is a hard error rather than a droppable frame.
 */
export function validateMeasuredKey(measured, split, keyHex) {
  if (!isUsableMeasuredKey(measured, split)) {
    throw new Error(`Measured background [${measured.join(',')}] is not a usable ${keyHex} matte`);
  }
}

/**
 * The longest run of consecutive usable-matte frames in a decoded clip. Grok
 * clips commonly fade in from (or pad with) a non-key intro/outro frame; the
 * longest contiguous usable span drops that lead-in/lead-out WITHOUT breaking
 * the temporal adjacency selectCycleIndices relies on (dropping an interior
 * frame would make two non-adjacent frames look adjacent). Returns
 * `{ start, length }` into the input array.
 */
export function longestUsableSpan(usableFlags) {
  let best = { start: 0, length: 0 };
  let runStart = 0;
  let runLen = 0;
  for (let i = 0; i < usableFlags.length; i++) {
    if (usableFlags[i]) {
      if (runLen === 0) runStart = i;
      runLen += 1;
      if (runLen > best.length) best = { start: runStart, length: runLen };
    } else {
      runLen = 0;
    }
  }
  return best;
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
 * The shortest gait period a probe will consider. Below this a "cycle" is more
 * likely to be a half-stride or an artifact of AI frame boiling than a real one.
 */
export const GAIT_MIN_PERIOD = 6;

/**
 * How much shorter than the requested phase count a TRUE gait period may be and
 * still be preferred over a longer, non-periodic window (#3052). At 0.8, an
 * 11-frame gait can serve 12 phases by holding one frame; a 6-frame gait cannot,
 * because half the loop would be held frames and a longer window is the better
 * compromise there.
 */
const MIN_PERIOD_RATIO = 0.8;

/**
 * The best-scoring periodic window, by endpoint-seam continuity vs motion.
 *
 * `minLength` is what separates the two callers, and it is the whole point of
 * splitting this out (#3052): the gait's real period is a property of the CLIP
 * and has nothing to do with how many phases the user asked for.
 */
export function findCycleWindow(signatures, frameCount, minLength) {
  const n = signatures.length;
  let best = null; // [score, start, cycleLength, seam, motion]
  // Widen the ceiling with frameCount so a larger requested count can still find
  // a long-enough gait window.
  const maxLen = Math.min(Math.max(18, frameCount + 6), n - 1);
  for (let cycleLength = minLength; cycleLength <= maxLen; cycleLength++) {
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
  return { start, cycleLength, seam, motion };
}

/**
 * Find the best walk-cycle window and resample it onto `frameCount` gait phases.
 * `signatures` is one entry per recovered source frame.
 */
export function selectCycleIndices(signatures, frameCount = WALK_FRAME_COUNT) {
  const n = signatures.length;
  if (n < frameCount + 1) {
    throw new Error(`Need at least ${frameCount + 1} extracted frames, got ${n}`);
  }
  // ONE search, floored at the shortest period worth accepting — not a
  // `frameCount`-floored search with a shorter probe after it. The two-call shape
  // had a hole: the first call THROWS `No detectable moving walk cycle` when no
  // window at/above `frameCount` clears `MIN_CYCLE_MOTION`, so the shorter probe
  // never ran and the short-cycle path rejected exactly the clips it was added to
  // support. Searching `[shortFloor, maxLen]` once is also strictly equivalent
  // for the long case: that range contains `[frameCount, maxLen]`, so when the
  // global best is a long window it IS the long search's best.
  //
  // The floor HIDES any gait whose real period is shorter, and forces
  // a longer window that is not a whole number of cycles (#3052). A real clip's
  // gait ran 11 frames while 12 phases were requested, so the search could only
  // offer a 15-frame window — 1.36 cycles. Its endpoints still matched (a
  // front-facing walk is near-symmetric, so the mirrored pose reads as the same
  // one), which is why the seam score looked fine while the legs visibly jumped
  // mid-loop. Probing without the floor finds the true period; holding one frame
  // to reach the requested count is a far smaller artifact than replaying a third
  // of a stride. The ratio guard keeps this to MILD upsampling — a much shorter
  // period would be mostly held frames, and a longer window wins there.
  const shortFloor = Math.min(frameCount, Math.max(GAIT_MIN_PERIOD, Math.ceil(frameCount * MIN_PERIOD_RATIO)));
  const { start, cycleLength, seam, motion } = findCycleWindow(signatures, frameCount, shortFloor);
  // Even phase distribution, in integer arithmetic (#3050).
  //
  // This is the ONE place that deliberately does not use `pyRound`. Banker's
  // rounding breaks a .5 tie toward the even integer, so the tie's DIRECTION
  // depends on the parity of the integer part — and when `cycleLength /
  // frameCount` puts ties at regular intervals, consecutive ties resolve
  // opposite ways and the phases stop being evenly spaced. A 15-frame gait
  // resampled to 12 landed ties at 2.5→2 (down), 7.5→8 (up), 12.5→12 (down),
  // giving double-steps at positions 2, 5 and 10 — spacings of 3 and 5, an
  // arrhythmic hitch that reads as a limp. Half-up resolves every tie the same
  // way, so the double-steps land at 1, 5 and 9: still 15 source frames over 12
  // phases, but the unavoidable stretch is spread evenly.
  //
  // `(i * cycleLength + frameCount/2) / frameCount` floored IS half-up, and in
  // integers it cannot drift on a float representation. Pixel math keeps
  // `pyRound` — that half is byte-compatibility with the source pipeline, this
  // half is perceptual quality, and only the latter has a tie problem.
  const half = Math.floor(frameCount / 2);
  const indices = Array.from(
    { length: frameCount },
    (_, i) => start + Math.floor((i * cycleLength + half) / frameCount),
  );
  // Every source frame of the window must be used. When the window is at least
  // `frameCount` long that means all-distinct as before; when it is shorter (the
  // mild-upsample path above) the phases hold `frameCount - cycleLength` frames,
  // and the check becomes "no frame of the gait was SKIPPED" — which is the
  // property that actually matters, and which the old all-distinct rule enforced
  // only incidentally.
  const distinct = new Set(indices).size;
  if (distinct !== Math.min(frameCount, cycleLength)) {
    throw new Error(`Cycle window too short to resample ${frameCount} distinct phases`);
  }
  return {
    indices,
    cycle: {
      windowStart: start,
      windowLength: cycleLength,
      endpointSeamScore: pyRoundTo(seam, 4),
      medianMotionScore: pyRoundTo(motion, 4),
      // How many phases repeat a source frame because the gait is shorter than
      // the requested count. 0 for every window at or above `frameCount`, so an
      // existing manifest's shape is unchanged in the common case.
      heldFrames: Math.max(0, frameCount - cycleLength),
    },
  };
}

/**
 * Pick a non-directional ambient-loop window and resample it evenly.
 *
 * A walk needs gait-period detection because a half stride is not a loop. An
 * ambient clip has no gait phases; it needs the two ends to look alike. Search
 * every usable window that can supply the requested frames, rank it first by
 * first/last-frame similarity, then prefer the longer candidate (more temporal
 * coverage), and sample the selected window at even intervals. This preserves
 * image-to-video temporal coherence without pretending wind or water has a
 * two-beat walk cycle.
 */
export function selectAmbientLoopIndices(signatures, frameCount) {
  const n = signatures.length;
  if (n < frameCount + 1) {
    throw new Error(`Need at least ${frameCount + 1} extracted frames, got ${n}`);
  }
  let best = null;
  for (let start = 0; start <= n - frameCount - 1; start++) {
    for (let end = start + frameCount; end < n; end++) {
      const seam = imageDistance(signatures[start], signatures[end]);
      const candidate = [seam, -(end - start), start, end];
      if (!best || candLess(candidate, best)) best = candidate;
    }
  }
  const [seam, , start, end] = best;
  const windowLength = end - start;
  const indices = Array.from(
    { length: frameCount },
    (_, index) => start + Math.floor((index * windowLength + Math.floor(frameCount / 2)) / frameCount),
  );
  return {
    indices,
    cycle: {
      selection: 'ambient-even-resample',
      windowStart: start,
      windowLength,
      endpointSeamScore: pyRoundTo(seam, 4),
      heldFrames: 0,
    },
  };
}

/**
 * The frame's baseline: the lowest row carrying at least `minRun` opaque pixels,
 * returned as a height (exclusive bottom) so it drops into the same arithmetic
 * as `resized.height`.
 *
 * Using the raw bbox bottom made vertical registration hostage to a single
 * pixel (#3021) — one surviving despill speck or a soft shadow below the feet
 * extended the bbox, and pinning that to the baseline lifted the entire body by
 * that much. Requiring a short RUN of opaque pixels ignores stragglers while
 * still finding the real sole, which is many pixels wide. Falls back to the
 * bbox bottom when no row qualifies (a very small or very sparse frame), so a
 * legitimate thin sprite still registers rather than throwing.
 */
export function robustBottomRow(frame, threshold = BBOX_ALPHA_THRESHOLD, minRun = ROBUST_BASELINE_MIN_PIXELS) {
  const { data, width, height } = frame;
  for (let y = height - 1; y >= 0; y--) {
    let count = 0;
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > threshold && ++count >= minRun) return y + 1;
    }
  }
  const bbox = alphaBbox(frame, threshold);
  return bbox ? bbox.bottom : height;
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
 * The measuring band `rootX` uses, as `[topFraction, bottomFraction]` of bbox
 * height. TORSO is current (#3049); HIP is what every manifest packed before it
 * used, and must stay reachable — the atlas measures the idle anchor live with
 * `rootX` while the walk cells carry the pivot their packer baked in, so a set
 * compiled without reprocessing needs the band its frames were packed with or
 * the idle and walk columns anchor on different landmarks and the character pops
 * sideways entering the gait. `alignment.operation` in the run manifest is what
 * distinguishes them; see `ALIGN_OP_TORSO_X`.
 */
export const ROOT_BAND_TORSO = [0.30, 0.58];
export const ROOT_BAND_HIP = [0.42, 0.76];

/** The `alignment.operation` stamp written by the torso-pivot packer (#3049). */
export const ALIGN_OP_TORSO_X = 'one-fixed-scale-per-frame-torso-x-and-baseline-y';

/**
 * The band a packed manifest's frames were aligned with. A manifest that
 * predates #3049 — or carries no `alignment.operation` at all — was packed on
 * the hip band, and re-measuring it as torso would misregister it.
 */
export const rootBandForManifest = (manifest) => (
  manifest?.alignment?.operation === ALIGN_OP_TORSO_X ? ROOT_BAND_TORSO : ROOT_BAND_HIP
);

/**
 * x-center of the character at the TORSO band (30%–58% of bbox height) — the
 * per-frame pivot the alignment pins to x=192.
 *
 * The band is the chest/waist, deliberately ABOVE the knees. Measured in
 * absolute source coordinates across a real 6s clip, the candidate landmarks
 * rank (spread over the cycle, one direction): torso 14px · hip 17px · head 24px
 * · bbox.left 44px · legs 52px. The old 42%–76% band reached into the scissoring
 * legs, which is what made a per-frame anchor migrate — the symptom #3021
 * described. The torso is the visual mass a viewer tracks and the part that is
 * genuinely stationary in a walk-in-place, so pinning it is both the stablest
 * measurement and the right physical model; arms and legs then swing around it.
 */
export function rootX(frame, bbox, band = ROOT_BAND_TORSO) {
  const { data, width } = frame;
  const H = bbox.bottom - bbox.top;
  const bandTop = bbox.top + pyRound(H * band[0]);
  const bandBottom = bbox.top + pyRound(H * band[1]);
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
 * scale that fits the largest bbox into the cell; the TORSO pivot lands on
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

  // Anchor the TORSO of each frame on the pivot (#3049).
  //
  // #3021 replaced a per-frame x anchor with ONE shared offset, because the old
  // hip/leg-band `rootX` migrated as the legs scissored. That treated the
  // symptom: a shared dx positions the CROP, and each frame is cropped to its
  // own alpha bbox, so freezing dx silently pins `bbox.left` — the leading
  // arm/leg extremity, and empirically the second-WORST landmark on the body
  // (44px of travel over a cycle, against 14px for the torso). The result was a
  // 26px left-right lurch, measured on a packed 12-frame strip: bbox.left sat at
  // exactly 122 in all twelve cells while the hip swung 179→205.
  //
  // With `rootX` now measuring the torso (see above), the per-frame anchor is
  // both stable and correct: `dx` is computed from THIS frame's own crop offset
  // so the shared landmark lands on the pivot every time, which cancels the crop
  // variation AND any real drift left in the source clip (grok's "walk in place"
  // still wanders ~14px). Residual is bounded by the torso measurement, not by
  // the silhouette's widest limb.
  const sourceRootXs = frames.map((f, i) => (rootX(f, bboxes[i]) - bboxes[i].left) * scale);

  const aligned = [];
  const translations = [];
  for (let i = 0; i < frames.length; i++) {
    const bbox = bboxes[i];
    const cropped = cropFrame(frames[i], bbox);
    const size = [Math.max(1, pyRound(cropped.width * scale)), Math.max(1, pyRound(cropped.height * scale))];
    const resized = await premultipliedResize(cropped, size[0], size[1]);
    const dx = pyRound(WALK_PIVOT[0] - sourceRootXs[i]);
    // Feet land on the baseline by the frame's ROBUST bottom, not its bbox
    // bottom. `alphaBbox` extends to a single surviving despill speck or a
    // dropped shadow, and pinning that to y=352 lifted the whole body by
    // however far the speck sat below the feet.
    const dy = pyRound(WALK_PIVOT[1] - robustBottomRow(resized));
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
      // Both axes vary per frame again (#3049): x pins this frame's torso to the
      // pivot, y its robust baseline. The distinguishing fact vs the pre-#3021
      // shape is WHICH landmark x uses — the torso band, not the hip/leg band.
      operation: ALIGN_OP_TORSO_X,
      // The per-frame torso measurements the anchor is taken from. Kept for
      // diagnostics: their spread is the drift this alignment cancels, so a
      // regression shows up as `translations[i][0]` going constant while these
      // still move (that is exactly the #3021 shape this replaced).
      hipOffsets: sourceRootXs.map((v) => pyRoundTo(v, 4)),
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
 * Validate the packed candidate: enough distinct frames, tolerable loop seam,
 * no visible key residue.
 *
 * `heldFrames` is how many phases deliberately repeat a source frame because the
 * clip's gait is shorter than the requested count (#3052) — an intentional hold,
 * not the "packer picked the same frame twice" failure this guard exists for. It
 * defaults to 0, so every caller that packs a full-length window keeps the strict
 * all-distinct rule.
 */
export async function validateFrames(frames, split, frameCount = WALK_FRAME_COUNT, heldFrames = 0) {
  if (frames.length !== frameCount) {
    throw new Error(`Expected ${frameCount} frames, got ${frames.length}`);
  }
  const hashes = frames.map((f) => sha256Buffer(f.data));
  const distinct = new Set(hashes).size;
  if (distinct !== frames.length - heldFrames) {
    throw new Error(`Duplicate frames in the packed cycle (${distinct} distinct of ${frames.length}, expected ${frames.length - heldFrames})`);
  }
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
    // The literal `true` was accurate while every pack was all-distinct. Since a
    // gait shorter than the requested count may hold frames (#3052), a hardcoded
    // true would stamp a claim the artifact disproves — record what was actually
    // packed, and the hold count beside it so a reader can tell an intentional
    // hold from a packer bug.
    distinctFrames: distinct === frames.length,
    heldFrames,
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
 * Prepare the i2v motion input for grok as an OPAQUE, chroma-backed frame.
 *
 * grok's image_to_video must receive the character sitting ON the exact chroma
 * matte we key against — NOT a transparent PNG. Handing grok transparency forces
 * it to (a) composite over black (producing black intro/fade frames whose border
 * measures [0,0,0]) and (b) reinvent the "magenta background" from the prompt
 * text. Compositing the anchor over solid chroma hands grok the literal
 * background to extend, so the rendered clip keeps a well-formed matte the
 * postprocess can unkey deterministically (codec chroma subsampling still shifts
 * it a little at decode — handled by the measured-key unmix, not here). An
 * already-opaque, chroma-backed anchor (the common case) is unchanged; a
 * transparent one has its holes filled with the matte color.
 *
 * `flatten` is libvips' native source-over-solid-color compositing (the same op
 * signatureOf uses) — correct and fast over a ~1.7M-pixel anchor without a
 * per-pixel JS loop. `hexToRgb` returns `{ r, g, b }`, exactly flatten's shape.
 */
export async function prepareWalkAnchorChromaInput(anchorAbs, destAbs, chromaKey) {
  const buf = await sharp(anchorAbs).flatten({ background: hexToRgb(chromaKey) }).png().toBuffer();
  await writeFile(destAbs, buf);
  return { preparation: 'composited-over-solid-chroma-matte', sha256: sha256Buffer(buf) };
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
  frameCount = WALK_DEFAULT_FRAME_COUNT, fps = WALK_DEFAULT_FPS, track = WALK_TRACK,
}) {
  const trackRow = getAnimationTrack(track);
  const targetFrames = clampTrackFrameCount(frameCount, track);
  const playbackFps = clampTrackFps(fps, track);
  const phaseLabels = trackColumnLabels(track, targetFrames);
  const split = keyChannelSplit(chromaKey);
  const generatedAbs = join(runAbs, 'generated');
  const generatedRel = `${runRel}/generated`;
  const rawDir = join(generatedAbs, 'raw');

  const rawNames = await extractVideoFrames(videoAbs, rawDir);
  // Decode + measure every frame, then keep only the longest contiguous run of
  // frames whose border is a usable chroma matte. Grok clips routinely open on
  // a black fade-in frame (border measures [0,0,0]) before the magenta-backed
  // walk begins — the old "validate every frame, throw on the first bad one"
  // failed the whole run on that intro frame even though 70+ good frames
  // followed it. `frames`/`measured`/`usable` stay index-aligned with rawNames.
  const decoded = [];
  for (const name of rawNames) {
    const frame = await decodeRgbaFrame(join(rawDir, name));
    const measured = sampleBorderKey(frame);
    decoded.push({ frame, measured, usable: isUsableMeasuredKey(measured, split) });
  }
  const span = longestUsableSpan(decoded.map((d) => d.usable));
  if (span.length < targetFrames + 1) {
    const usableTotal = decoded.filter((d) => d.usable).length;
    throw new Error(usableTotal === 0
      ? `No frame has a usable ${chromaKey} matte (measured e.g. [${decoded[0]?.measured?.join(',')}] across ${decoded.length} frames)`
      : `Only ${span.length} contiguous frames have a usable ${chromaKey} matte (need ${targetFrames + 1}); the ${chromaKey} background is unstable across the clip`);
  }
  // span.start offsets every downstream lookup back into the raw source-%04d
  // numbering, so the manifest's sourceFrameIndex/sourcePath stay correct.
  const usable = decoded.slice(span.start, span.start + span.length);
  const usableRawNames = rawNames.slice(span.start, span.start + span.length);
  const measuredKeys = usable.map((d) => d.measured);
  const recovered = usable.map((d) => recoverAlphaFrame(d.frame, d.measured, split));

  const signatures = await Promise.all(recovered.map(signatureOf));
  const { indices, cycle } = trackRow.directional
    ? selectCycleIndices(signatures, targetFrames)
    : selectAmbientLoopIndices(signatures, targetFrames);
  const selected = indices.map((i) => recovered[i]);

  const { frames: aligned, alignment } = await alignFrames(selected);
  const despilled = aligned.map((f) => despillKeyFrame(f, split));
  const validation = await validateFrames(despilled, split, targetFrames, cycle.heldFrames || 0);

  const framesDir = join(generatedAbs, 'frames');
  await ensureDir(framesDir);
  const frameRecords = [];
  for (let i = 0; i < despilled.length; i++) {
    const phase = phaseLabels[i];
    const name = `${String(i).padStart(2, '0')}-${phase}.png`;
    frameRecords.push({
      outputIndex: i,
      phase,
      // raw frames are 1-based sequential (source-%04d); indices[i] is relative
      // to the usable span, so span.start offsets it back to the raw numbering.
      sourceFrameIndex: span.start + indices[i] + 1,
      sourcePath: `${generatedRel}/raw/${usableRawNames[indices[i]]}`,
      sourceSha256: await sha256File(join(rawDir, usableRawNames[indices[i]])),
      measuredKeyRgb: measuredKeys[indices[i]],
      path: `${generatedRel}/frames/${name}`,
      sha256: await encodePngWithHash(despilled[i], join(framesDir, name)),
    });
  }

  const stripName = `${recordId}-${track}-${direction}-strip.png`;
  const stripSha256 = await encodePngWithHash(packStrip(despilled), join(generatedAbs, stripName));

  const reviewDir = join(generatedAbs, 'review');
  await ensureDir(reviewDir);
  const contrastName = `${recordId}-${track}-${direction}-contrast-review.png`;
  const comparisonSha256 = await encodePngWithHash(await buildContrastSheet(despilled), join(reviewDir, contrastName), 3);

  const manifestName = `${recordId}-${track}-${direction}-manifest.json`;
  const manifest = {
    schemaVersion: 1,
    kind: `deterministically-packaged-grok-${track}-video`,
    status: 'candidate',
    track: trackRow.id,
    characterId: recordId,
    direction,
    chromaKey,
    anchorPath: anchorRel,
    anchorSha256: await sha256File(anchorAbs),
    sourceVideoPath: `${generatedRel}/source-video.mp4`,
    sourceVideoSha256: await sha256File(videoAbs),
    postprocessorPath: 'server/services/sprites/walkPostprocess.js',
    manifestPath: `${generatedRel}/${manifestName}`,
    frameRate: playbackFps,
    frameCount: targetFrames,
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

  // `stripSha256` mirrors the manifest's hash so the client can version the
  // strip's URL (#3020). The packer rewrites this path IN PLACE, so without a
  // content token in the URL the browser keeps painting the strip it already
  // decoded — reprocessing 8f → 12f applies the new stepped geometry to the old
  // 8-cell image and the sprite reads as a jumpy, mis-centered toggle until a
  // manual reload.
  const stripPreview = {
    stripPath: `${generatedRel}/${stripName}`,
    stripSha256,
    frameCount: targetFrames,
    fps: playbackFps,
    cellWidth: WALK_CELL_SIZE,
    cellHeight: WALK_CELL_SIZE,
    row: 0,
    startColumn: 0,
  };
  await atomicWrite(join(generatedAbs, 'review-preview.json'), stripPreview);

  return { manifest, manifestPath: `${generatedRel}/${manifestName}`, stripPreview };
}
