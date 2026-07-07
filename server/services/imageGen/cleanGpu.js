/**
 * Image Cleaner — GPU FLUX round-trip orchestration (issue #2264).
 *
 * The synchronous Image Cleaner route (`server/routes/imageClean.js`) runs the
 * metadata / median-sharpen / CPU-light passes inline and returns the bytes.
 * The GPU FLUX img2img round-trip can't run inline: it's GPU-serialized through
 * `mediaJobQueue` (two concurrent FLUX renders OOM the box). So for
 * `?diffusion=gpu` the route hands the (already sync-cleaned) bytes to this
 * service, which:
 *
 *   1. Stages the init bytes to `PATHS.imageCleanTmp` (a non-gallery temp dir).
 *   2. Resolves the local FLUX backend + assembles the img2img params, reusing
 *      `resolveRegenBackend` / `buildRegenParams` / `clampRegenDimensions` from
 *      `regen.js` — the SAME seam the lightbox `/regenerate` flow uses.
 *   3. Enqueues a `kind: 'image'` job with a NON-GALLERY `outputTarget`
 *      (`generateImage` writes the render to the temp dir with NO sidecar, so
 *      the gallery is never polluted by default).
 *   4. Returns a `jobId` the client tracks via the existing media-job progress
 *      channel (`useMediaJobProgress`), then fetches the finished bytes.
 *
 * When an ignore-zone mask rode along, the original (pre-diffusion, oriented)
 * bytes + the mask are staged next to the render so the result-fetch can
 * composite the ORIGINAL pixels back into the masked regions (feathered) after
 * the GPU redraws the frame — the same preserve-region behavior the CPU light
 * pass applies inline.
 *
 * The finished bytes are consumed by an explicit result-fetch; the default is
 * NOT to keep them. An optional save-to-gallery action promotes the result to a
 * first-class gallery citizen (reusing `saveUploadedGalleryImage`).
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import sharp from 'sharp';
import { PATHS, ensureDir, atomicWrite, tryReadFile, resolveImageCleanTmp } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { compositeIgnoreZone, IGNORE_ZONE_FEATHER_DEFAULT } from '../../lib/imageClean.js';
import { resolveRegenBackend, buildRegenParams, resolveRegenStrengthDefault } from './regen.js';
import { enqueueJob, getJob } from '../mediaJobQueue/index.js';

// Small JSON sidecar written next to the temp render so the result-fetch knows
// whether an ignore-zone composite is pending (and the feather sigma). Kept out
// of the gallery sidecar shape on purpose — this is ephemeral working state,
// not a gallery record.
const cleanMetaPath = (jobId) => join(PATHS.imageCleanTmp, `${jobId}-clean.json`);

/**
 * Enqueue a GPU FLUX clean round-trip. `initBuffer` is the already-sync-cleaned
 * image bytes; `originalBuffer`/`maskBuffer` (optional) drive the post-render
 * ignore-zone composite. Returns `{ jobId, position, status, modelId, strength,
 * width, height, scaled }` on success. Throws a 400 ServerError with an
 * actionable message when no local FLUX runner is available (the hardware gate).
 */
export async function enqueueGpuClean({
  initBuffer,
  sourceDims = null,
  strength = null,
  maxMegapixels,
  originalBuffer = null,
  maskBuffer = null,
  feather = IGNORE_ZONE_FEATHER_DEFAULT,
}) {
  if (!Buffer.isBuffer(initBuffer) || initBuffer.length === 0) {
    throw new ServerError('No image bytes to render', { status: 400, code: 'VALIDATION_ERROR' });
  }

  // Hardware gate — no source model to bias the pick (an arbitrary upload has
  // no lineage), so resolveRegenBackend chooses the best installed FLUX runner.
  const backend = await resolveRegenBackend({});
  if (!backend.available) {
    throw new ServerError(backend.reason, { status: 400, code: 'REGEN_BACKEND_UNAVAILABLE' });
  }

  await ensureDir(PATHS.imageCleanTmp);
  // Stage the init bytes under an `init-<uuid>` name so the shared image-input
  // resolver accepts them and the tmp GC can sweep them. The render itself
  // lands at `<jobId>.png` (jobId is assigned by enqueueJob below).
  const initName = `init-${randomUUID()}.png`;
  const initAbsPath = join(PATHS.imageCleanTmp, initName);
  // Normalize to PNG so the runner's init-image decode is stable regardless of
  // the source format, then write the raw bytes (atomicWrite is JSON-only).
  const initPng = await sharp(initBuffer).png().toBuffer();
  const { writeFile } = await import('node:fs/promises');
  await writeFile(initAbsPath, initPng);

  // Conservative default for an arbitrary upload (no SynthID-bearing lineage
  // to key on) — mirrors the lightbox's resolveRegenStrengthDefault({}).
  const useStrength = typeof strength === 'number' && Number.isFinite(strength)
    ? strength
    : resolveRegenStrengthDefault({});

  const params = buildRegenParams({
    // No gallery filename — this render has no gallery lineage. `regenOf` stays
    // absent so `generateImage` writes no `cleanedFrom`/variant lineage.
    filename: initName,
    sourceAbsPath: initAbsPath,
    sourceDims,
    model: backend.model,
    pythonPath: backend.pythonPath,
    strength: useStrength,
    initImageAbsPath: initAbsPath,
    ...(typeof maxMegapixels === 'number' && maxMegapixels > 0 ? { maxMegapixels } : {}),
  });
  // Strip the regen lineage stamp — a clean render is NOT a gallery variant of
  // anything, and there's no source gallery filename to anchor a group at.
  delete params.regenOf;
  // Render to the temp dir with no sidecar so the gallery stays clean.
  params.outputTarget = { dir: PATHS.imageCleanTmp, skipSidecar: true };

  const queued = enqueueJob({ kind: 'image', params });
  const jobId = queued.jobId;

  // Stage the preserve-region inputs (only when a mask rode along) so the
  // result-fetch can composite the ORIGINAL pixels back over the diffused
  // render. Named by the (now-known) jobId. Best-effort — a failed stage just
  // means the composite is skipped, never a failed enqueue.
  let hasMask = false;
  if (Buffer.isBuffer(originalBuffer) && Buffer.isBuffer(maskBuffer)) {
    await writeFile(join(PATHS.imageCleanTmp, `${jobId}-original.png`), originalBuffer).catch(() => {});
    await writeFile(join(PATHS.imageCleanTmp, `${jobId}-mask.png`), maskBuffer).catch(() => {});
    hasMask = true;
  }
  await atomicWrite(cleanMetaPath(jobId), { hasMask, feather, initName }).catch(() => {});

  console.log(`🧪 GPU clean enqueued via ${backend.model.id} (strength=${useStrength}${hasMask ? ', ignore-zone mask' : ''}) → job ${jobId.slice(0, 8)}`);
  return {
    jobId,
    position: queued.position,
    status: queued.status,
    modelId: backend.model.id,
    strength: useStrength,
    width: params.width,
    height: params.height,
    scaled: !!params.upscaleTo,
  };
}

// Resolve the finished temp render for a clean job. Returns `null` when the job
// hasn't completed (or produced no output) yet — the caller maps that to a 409
// so the client keeps polling. On success returns `{ data, width, height }`
// with any pending ignore-zone composite applied.
export async function readGpuCleanResult(jobId) {
  const resultPath = resolveImageCleanTmp(`${jobId}.png`);
  if (!resultPath) return null;
  const rendered = await tryReadFile(resultPath, null);
  if (!rendered || rendered.length === 0) return null;

  // Apply the deferred ignore-zone composite, if one was staged. The mask
  // restores the ORIGINAL pixels into the painted regions over the diffused
  // frame — the GPU redrew the whole image, garbling any text/faces the user
  // wanted preserved. Missing/failed composite falls back to the raw render.
  const meta = await tryReadFile(cleanMetaPath(jobId), null);
  let cleanMeta = null;
  if (meta) { try { cleanMeta = JSON.parse(meta); } catch { cleanMeta = null; } }
  if (cleanMeta?.hasMask) {
    const [original, mask] = await Promise.all([
      tryReadFile(join(PATHS.imageCleanTmp, `${jobId}-original.png`), null),
      tryReadFile(join(PATHS.imageCleanTmp, `${jobId}-mask.png`), null),
    ]);
    if (Buffer.isBuffer(original) && Buffer.isBuffer(mask)) {
      const composited = await compositeIgnoreZone(rendered, original, mask, {
        feather: typeof cleanMeta.feather === 'number' ? cleanMeta.feather : IGNORE_ZONE_FEATHER_DEFAULT,
      });
      if (composited) return { data: composited.data, width: composited.width, height: composited.height, composited: true };
    }
  }

  const dims = await sharp(rendered).metadata().catch(() => ({}));
  return { data: rendered, width: dims.width || null, height: dims.height || null, composited: false };
}

// Whether a clean job is finished (its render is on disk). Distinguishes
// "not done yet" (keep polling) from "done" for the result-fetch route.
export function getGpuCleanStatus(jobId) {
  const job = getJob(jobId);
  if (!job) return { status: 'unknown' };
  return { status: job.status, error: job.error || null };
}

// Save a finished clean result to the gallery (the explicit opt-in — the
// default is NOT to keep it). Reuses `saveUploadedGalleryImage` so the saved
// file is a first-class gallery citizen (lists/deletes like any other). Returns
// the new gallery `{ filename, path }`.
export async function saveGpuCleanToGallery(jobId) {
  const result = await readGpuCleanResult(jobId);
  if (!result) {
    throw new ServerError('Clean result not ready or not found', { status: 409, code: 'RESULT_NOT_READY' });
  }
  const { saveUploadedGalleryImage } = await import('./local.js');
  const saved = await saveUploadedGalleryImage(result.data.toString('base64'));
  console.log(`💾 Saved GPU clean result to gallery: ${saved.filename} (from job ${jobId.slice(0, 8)})`);
  return saved;
}
