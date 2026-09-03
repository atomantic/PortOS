/**
 * Solid-background keying for image-to-3D source images.
 *
 * OPT-IN, and deliberately so. TRELLIS.2's `preprocess_image` uses a real alpha
 * channel directly when one is present and only falls back to RMBG-2.0 matting when
 * there isn't — so keying a source does not *augment* the learned matte, it REPLACES
 * it. That trade is a loss on any ordinary photo or render: a flood fill from the
 * border cannot remove anything that isn't near the border color, so a cast shadow
 * survives as opaque mid-grey and the decoder faithfully reconstructs it as its own
 * disconnected mass of geometry. RMBG-2.0 removes it.
 *
 * What remains worth keying is the narrow case the caller knows and the segmentation
 * model doesn't: a synthetic image on a flat chroma backdrop, where matting produces
 * soft, uncertain edges (color spill, fuzzy fur) that turn into hallucinated geometry,
 * and a deterministic key is strictly cleaner. Hence `keyBackground` defaults to
 * false and this module runs only when a run asks for it.
 *
 * The pixel work is pure (raw RGBA buffers in/out) so it's unit-testable on tiny
 * synthetic images; `prepareSourceImage` is the one sharp/file boundary. The prepared
 * copy is written into the RECORD's render directory — the shared gallery file is
 * never mutated (other features reference it).
 *
 * The same boundary also owns the OTHER opt-in source preprocessing step, subject
 * framing (`subjectScale`): centring the subject on a square canvas at a fraction of
 * its size, so a full-body pose with outstretched limbs reaches the decoder with
 * empty margin beyond its extremities instead of running to the edge of the frame.
 * Extremities with no margin are what come back clipped or fused. It shares this
 * function because it shares the decode, the record-local output file, and the cache
 * — and because it must run AFTER keying, never before (see `prepareSourceImage`).
 *
 * A deliberately simpler edge model than the sprites lane's chroma unmix
 * (`services/sprites/chromaKey.js`): that lane reverses source-over compositing
 * against a known pure-channel key; this one only needs "background gone, 1px
 * anti-spill feather" for an arbitrary measured background color. The shared
 * border/median primitives live in `server/lib/borderKey.js`; this module retains
 * only the image-to-3D flood fill and its conservative sanity gates.
 *
 * Algorithm (deliberately conservative — "not sure" means "don't touch it"):
 *  1. Sample the border pixels; take the per-channel median as the candidate
 *     background color. If less than `KEY_MIN_BORDER_COVERAGE` of the border sits
 *     within `KEY_TOLERANCE` of it, the background isn't solid → pass through.
 *  2. Flood-fill from every matching border pixel (4-neighborhood) → alpha 0.
 *  3. Key enclosed pockets (background color trapped between limbs, unreachable
 *     from the border) with the tighter `KEY_TIGHT_TOLERANCE`, so a subject that
 *     merely contains a similar color isn't punched full of holes.
 *  4. Feather: foreground pixels adjacent to keyed ones get partial alpha scaled
 *     by their color distance to the background — a 1px anti-spill edge, not a
 *     full matte.
 *  5. Sanity-gate the result: if almost nothing or almost everything got keyed,
 *     the detection was wrong → pass through untouched.
 */

import { stat } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import sharp from 'sharp';
import {
  hasMeaningfulAlpha as hasMeaningfulAlphaShared,
} from '../../lib/borderKey.js';
import { DEFAULT_SUBJECT_SCALE, isValidSubjectScale } from './renderOptions.js';
import { atomicWrite, readJSONFile, sha256File } from '../../lib/fileUtils.js';
import { decodeRgbaFrame, encodePng } from '../../lib/imageRgba.js';
import {
  detectSolidBorderColor,
  KEY_TOLERANCE,
  KEY_TIGHT_TOLERANCE,
  KEY_MIN_BORDER_COVERAGE,
  KEY_SOFT_BAND,
  KEY_MIN_KEYED_RATIO,
  KEY_MAX_KEYED_RATIO,
} from './sourceKeyingKernel.js';

export {
  detectSolidBorderColor,
  keySolidBackground,
  KEY_TOLERANCE,
  KEY_TIGHT_TOLERANCE,
  KEY_MIN_BORDER_COVERAGE,
  KEY_SOFT_BAND,
  KEY_MIN_KEYED_RATIO,
  KEY_MAX_KEYED_RATIO,
} from './sourceKeyingKernel.js';

/** Sources above this pixel count skip Node-side keying entirely: the raw
 * decode plus the flood/queue/output buffers scale at ~20 bytes per pixel
 * (a 96 MP gallery image would hold >1 GB and stall the event loop), while
 * TRELLIS.2 downscales its input to 1024px anyway — the pipeline's own
 * matting handles oversized sources. */
export const KEY_MAX_PIXELS = 16_000_000;

// Bump the leading version when the kernel changes. The numeric inputs are
// included so changing a tolerance invalidates fresh keyed output without
// relying on a developer to remember a second, separate cache edit.
//
// v2: the prepared source is now key-then-frame rather than key-only, and the
// decode honours EXIF orientation — both change the bytes for the same input, so
// every v1 artifact has to be recomputed. The framing SCALE is per-run rather
// than a module constant, so it cannot ride in this string; it is written into
// the cache metadata beside the version and compared there (see
// `freshPreparedSource`), which is what stops a re-render at a new scale from
// silently reusing the previously prepared image.
export const KEYING_CACHE_VERSION = [
  'source-keying-v2',
  KEY_TOLERANCE,
  KEY_TIGHT_TOLERANCE,
  KEY_MIN_BORDER_COVERAGE,
  KEY_SOFT_BAND,
  KEY_MIN_KEYED_RATIO,
  KEY_MAX_KEYED_RATIO,
  KEY_MAX_PIXELS,
].join(':');

/** Whether an RGBA buffer already carries a meaningful (non-opaque) alpha channel. */
export const hasMeaningfulAlpha = hasMeaningfulAlphaShared;

const runKeySolidBackground = (frame) => {
  const source = frame.data instanceof Uint8Array ? frame.data : Uint8Array.from(frame.data);
  // Always copy the exact view into a fresh ArrayBuffer. Native image decoders
  // and test runners may expose pooled/shared backing stores that Node refuses
  // to transfer, while this copy keeps the worker contract deterministic.
  const transferable = new Uint8Array(source.byteLength);
  transferable.set(source);

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./sourceKeyingWorker.js', import.meta.url), {
      workerData: {
        data: transferable.buffer,
        width: frame.width,
        height: frame.height,
      },
      transferList: [transferable.buffer],
    });
    let settled = false;
    const settle = (handler, value) => {
      if (settled) return;
      settled = true;
      handler(value);
    };
    worker.on('message', (message) => {
      if (message?.type === 'complete') settle(resolve, message.result);
      if (message?.type === 'error') {
        settle(reject, new Error(message.error || 'Background keying worker failed'));
      }
    });
    worker.once('error', (error) => settle(reject, error));
    worker.once('exit', (code) => {
      if (code !== 0) settle(reject, new Error(`Background keying worker exited with code ${code}`));
    });
  });
};

const preparedCacheMetadataPath = (targetPath) => `${targetPath}.meta.json`;

/** The neutral pad colour for an opaque source whose own border isn't solid. */
const FRAME_FALLBACK_BACKGROUND = [255, 255, 255];

const padColor = ([r, g, b]) => ({ r, g, b, alpha: 1 });

/**
 * Where a source lands on the square subject-framing canvas.
 *
 * The canvas is the source's LONGEST side, so framing never upsamples: the
 * subject is scaled down to `subjectScale` of that and centred, and the margin is
 * the remainder. A landscape and a portrait source of the same longest side
 * therefore produce the same canvas and the same margin beyond the subject's
 * extremities, which is the whole point — the decoder wants context past the
 * fingertips, not a particular output resolution.
 *
 * Pure (numbers in, numbers out) so the arithmetic is unit-testable without sharp.
 * Both dimensions floor at 1px: a scale small enough to round a thin source's short
 * side to zero would otherwise hand sharp an invalid resize.
 *
 * @param {{width: number, height: number, subjectScale: number}} opts
 * @returns {{canvasSize: number, innerWidth: number, innerHeight: number, left: number, top: number}}
 */
export function subjectFrameLayout({ width, height, subjectScale }) {
  const canvasSize = Math.max(width, height);
  const innerWidth = Math.max(1, Math.round(width * subjectScale));
  const innerHeight = Math.max(1, Math.round(height * subjectScale));
  return {
    canvasSize,
    innerWidth,
    innerHeight,
    left: Math.round((canvasSize - innerWidth) / 2),
    top: Math.round((canvasSize - innerHeight) / 2),
  };
}

/**
 * Composite an RGBA frame centred on the square framing canvas and return PNG bytes.
 *
 * The canvas background is the one detail that cannot be got wrong: a KEYED or
 * already-transparent source must not gain an opaque backdrop (that would undo the
 * matte the pipeline is about to consume), and an ordinary photo must not gain a
 * transparent one (TRELLIS.2 reads any non-opaque alpha as "already matted" and
 * skips RMBG-2.0, so a transparent pad would silently disable its own background
 * removal — exactly the trap `keyBackground` documents). For the opaque case the
 * pad takes the source's own measured border colour when it has one, so the added
 * margin is indistinguishable from the background already there.
 */
async function frameSubject(frame, { subjectScale, transparent }) {
  const layout = subjectFrameLayout({ width: frame.width, height: frame.height, subjectScale });
  const resized = await sharp(frame.data, {
    raw: { width: frame.width, height: frame.height, channels: 4 },
  })
    // Explicit target dimensions, already aspect-derived above — `fill` just honors
    // them rather than re-deriving a fit, so the layout math has a single owner.
    .resize(layout.innerWidth, layout.innerHeight, { fit: 'fill' })
    .raw()
    .toBuffer();
  const background = transparent
    ? { r: 0, g: 0, b: 0, alpha: 0 }
    : padColor(detectSolidBorderColor(frame) ?? FRAME_FALLBACK_BACKGROUND);
  return sharp({
    create: {
      width: layout.canvasSize, height: layout.canvasSize, channels: 4, background,
    },
  })
    .composite([{
      input: resized,
      raw: { width: layout.innerWidth, height: layout.innerHeight, channels: 4 },
      left: layout.left,
      top: layout.top,
    }])
    .png()
    .toBuffer();
}

const freshPreparedSource = async (sourcePath, targetPath, request) => {
  const sourceStats = await stat(sourcePath);
  const targetStats = await stat(targetPath).catch(() => null);
  if (!targetStats?.isFile() || targetStats.mtimeMs <= sourceStats.mtimeMs) return null;

  const metadata = await readJSONFile(preparedCacheMetadataPath(targetPath), null, { logError: false });
  if (metadata?.version !== KEYING_CACHE_VERSION || !metadata.sourceSha256) return null;
  // The per-run framing/keying request is part of the cache identity: the same
  // source at a different subjectScale is a DIFFERENT prepared image.
  if (metadata.keyBackground !== request.keyBackground) return null;
  if (metadata.subjectScale !== request.subjectScale) return null;
  if (metadata.sourceSha256 !== await sha256File(sourcePath)) return null;
  return { path: targetPath, keyed: metadata.keyed === true, framed: metadata.framed === true };
};

/**
 * Resolve whether a render should consume a PREPARED copy of its source, and
 * write one when it should.
 *
 * Two independent, independently-opt-in steps, in this order:
 *  1. `keyBackground` — flood-fill a solid backdrop to transparency (see the
 *     module header for why that is opt-in and usually a downgrade).
 *  2. `subjectScale < 1` — centre the result on a square canvas at that fraction
 *     so extremities gain margin (see `frameSubject`).
 *
 * ORDER MATTERS and is not interchangeable: reframing first would move the border
 * pixels the flood fill samples, so the keyer's own "is this background solid"
 * gate would be measuring the pad colour instead of the image's.
 *
 * Returns null in every case where the render should consume the ORIGINAL: neither
 * step was requested, the source is too large to process affordably, or keying was
 * asked for and declined (real alpha already present — the pipeline uses it
 * directly — or no solid background, or the sanity gates tripped) with no framing
 * to do either.
 *
 * I/O failures (unreadable file) reject; the caller treats preparation as
 * best-effort (a failure here must never fail a render the model could still
 * attempt on the raw image).
 *
 * @param {{sourcePath: string, targetPath: string, keyBackground?: boolean,
 *          subjectScale?: number}} opts
 * @returns {Promise<{path: string, keyed: boolean, framed: boolean}|null>}
 */
export async function prepareSourceImage({
  sourcePath,
  targetPath,
  keyBackground = true,
  subjectScale = DEFAULT_SUBJECT_SCALE,
}) {
  const scale = isValidSubjectScale(subjectScale) ? subjectScale : DEFAULT_SUBJECT_SCALE;
  const wantsFraming = scale < DEFAULT_SUBJECT_SCALE;
  const wantsKeying = keyBackground === true;
  if (!wantsKeying && !wantsFraming) return null;

  const request = { keyBackground: wantsKeying, subjectScale: scale };
  const cached = await freshPreparedSource(sourcePath, targetPath, request);
  if (cached) return cached;

  // Header-only probe: bail before the full decode when the source is too
  // large to process affordably (KEY_MAX_PIXELS), and when it has no alpha channel
  // at all, skip the full-buffer meaningful-alpha scan below (ensureAlpha
  // fabricates the channel).
  const { hasAlpha, width, height } = await sharp(sourcePath).metadata();
  if (!width || !height || width * height > KEY_MAX_PIXELS) return null;
  // Measure AFTER EXIF transposition: raw pixels carry no orientation tag and the
  // PNG written below records none, so a rotated source framed on its stored
  // dimensions would be both mis-measured and handed to the decoder sideways.
  const frame = await decodeRgbaFrame(sourcePath, { autoOrient: true });
  const sourceHasAlpha = hasAlpha === true && hasMeaningfulAlpha(frame.data);

  const keyed = wantsKeying && !sourceHasAlpha ? await runKeySolidBackground(frame) : null;
  const current = keyed
    ? { data: keyed.data, width: frame.width, height: frame.height }
    : frame;
  const framed = wantsFraming
    ? await frameSubject(current, {
      subjectScale: scale,
      // A keyed or natively-transparent subject pads transparent; anything else
      // pads opaque, so the pipeline's own matting still runs.
      transparent: Boolean(keyed) || sourceHasAlpha,
    })
    : null;
  if (!keyed && !framed) return null;

  await atomicWrite(targetPath, framed ?? await encodePng(current));
  await atomicWrite(preparedCacheMetadataPath(targetPath), {
    version: KEYING_CACHE_VERSION,
    sourceSha256: await sha256File(sourcePath),
    ...request,
    keyed: Boolean(keyed),
    framed: Boolean(framed),
  }).catch((error) => {
    console.error(`❌ Image-to-3D source cache metadata failed for ${targetPath}: ${error.message}`);
  });
  return { path: targetPath, keyed: Boolean(keyed), framed: Boolean(framed) };
}
