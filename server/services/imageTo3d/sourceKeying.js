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
 * synthetic images; `prepareSourceImage` is the one sharp/file boundary. The keyed
 * copy is written into the RECORD's render directory — the shared gallery file is
 * never mutated (other features reference it).
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
import { atomicWrite, readJSONFile, sha256File } from '../../lib/fileUtils.js';
import { decodeRgbaFrame, encodePng } from '../../lib/imageRgba.js';
import {
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
export const KEYING_CACHE_VERSION = [
  'source-keying-v1',
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

const keyedCacheMetadataPath = (targetPath) => `${targetPath}.meta.json`;

const hasFreshKeyedSource = async (sourcePath, targetPath) => {
  const sourceStats = await stat(sourcePath);
  const targetStats = await stat(targetPath).catch(() => null);
  if (!targetStats?.isFile() || targetStats.mtimeMs <= sourceStats.mtimeMs) return false;

  const metadata = await readJSONFile(keyedCacheMetadataPath(targetPath), null, { logError: false });
  if (metadata?.version !== KEYING_CACHE_VERSION || !metadata.sourceSha256) return false;
  return metadata.sourceSha256 === await sha256File(sourcePath);
};

/**
 * Resolve whether a render should consume a keyed copy of its source. Reads
 * `sourcePath`; when it has no meaningful alpha and sits on a solid background,
 * writes a keyed PNG to `targetPath` and returns that path. Returns null in
 * every non-keyable case (real alpha already present — the pipeline uses it
 * directly — or no solid background, or the sanity gates tripped): the caller
 * renders the original.
 *
 * I/O failures (unreadable file) reject; the caller treats keying as
 * best-effort (a keying failure must never fail a render the model could still
 * attempt on the raw image).
 *
 * @param {{sourcePath: string, targetPath: string}} opts
 * @returns {Promise<string|null>} the keyed image path, or null to use the original
 */
export async function prepareSourceImage({ sourcePath, targetPath }) {
  if (await hasFreshKeyedSource(sourcePath, targetPath)) return targetPath;

  // Header-only probe: bail before the full decode when the source is too
  // large to key affordably (KEY_MAX_PIXELS), and when it has no alpha channel
  // at all, skip the full-buffer meaningful-alpha scan below (ensureAlpha
  // fabricates the channel).
  const { hasAlpha, width, height } = await sharp(sourcePath).metadata();
  if (!width || !height || width * height > KEY_MAX_PIXELS) return null;
  const frame = await decodeRgbaFrame(sourcePath);
  if (hasAlpha && hasMeaningfulAlpha(frame.data)) return null;
  const result = await runKeySolidBackground(frame);
  if (!result) return null;
  await atomicWrite(targetPath, await encodePng({
    data: result.data,
    width: frame.width,
    height: frame.height,
  }));
  await atomicWrite(keyedCacheMetadataPath(targetPath), {
    version: KEYING_CACHE_VERSION,
    sourceSha256: await sha256File(sourcePath),
  }).catch((error) => {
    console.error(`❌ Image-to-3D keying cache metadata failed for ${targetPath}: ${error.message}`);
  });
  return targetPath;
}
