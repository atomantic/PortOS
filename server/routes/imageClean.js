// HTTP wrapper around the core cleaning primitives in server/lib/imageClean.js.
// All sharp/PNG-walker logic lives in the lib so services can call it directly
// (services importing from routes would be a layering violation).
//
// Transport: raw image bytes in the request body (no base64-in-JSON inflation),
// pipeline options in the query string, cleaned bytes back as the response body
// with the small report in the `X-Clean-Report` header. The global
// express.json() parser in server/index.js is a no-op here because the request
// content-type is image/*, so this route's express.raw() owns the body.

import { Router, raw } from 'express';
import { z } from 'zod';
import sharp from 'sharp';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { cleanImageBuffer, CLEAN_LEVELS, compositeIgnoreZone, IGNORE_ZONE_FEATHER_DEFAULT } from '../lib/imageClean.js';
import { applyLightRegen, computePixelDelta, REGEN_STRENGTH_MIN, REGEN_STRENGTH_MAX } from '../services/imageGen/regen.js';
import { enqueueGpuClean, readGpuCleanResult, getGpuCleanStatus, saveGpuCleanToGallery } from '../services/imageGen/cleanGpu.js';

const router = Router();

// Re-export so existing `import { CLEAN_LEVELS } from './imageClean.js'`
// consumers in the routes layer keep working.
export { cleanImageBuffer, CLEAN_LEVELS };

// Query-string flag → boolean. Accepts the common truthy/falsey string forms a
// browser fetch sends ("1"/"0"/"true"/"false"); anything else falls back to the
// schema default. Mirrors the history.js success-filter pattern.
const queryFlag = (def) => z.preprocess(
  (v) => {
    if (v === undefined) return def;
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
    return v;
  },
  z.boolean(),
);

// Diffusion sub-mode. `off` (default) skips it entirely; `light` runs the
// CPU-only spatial pass (`applyLightRegen`) that actually perturbs SynthID's
// resolution-dependent carriers — the no-GPU fallback, always available since
// sharp is a hard dependency. `gpu` (the FLUX img2img round-trip) is
// GPU-serialized via mediaJobQueue: the route stages the sync-cleaned bytes,
// enqueues a job through the shared regen seam, and returns a `jobId` the
// client tracks via the media-job progress channel (issue #2264). Anything
// else → the `off` default.
const diffusionMode = z.preprocess(
  (v) => {
    if (v === undefined || v === '' || v === '0' || v === 'false' || v === 'off') return 'off';
    if (v === 'light' || v === 'cpu' || v === '1' || v === 'true') return 'light';
    if (v === 'gpu' || v === 'flux') return 'gpu';
    return 'off';
  },
  z.enum(['off', 'light', 'gpu']),
);

// Pipeline steps ride in the query string, not the body (the body is the image).
// `mask=1` signals an ignore-zone preserve-region envelope in the body (see the
// length-prefixed decode below); `feather` is the soft-boundary blur sigma (px)
// clamped in the lib. The mask only has any effect when a diffusion step runs —
// it composites the ORIGINAL pixels back over the diffused result.
const cleanQuerySchema = z.object({
  metadata: queryFlag(true),
  denoise: queryFlag(false),
  diffusion: diffusionMode,
  mask: queryFlag(false),
  feather: z.preprocess(
    (v) => (v === undefined || v === '' ? IGNORE_ZONE_FEATHER_DEFAULT : Number(v)),
    z.number().min(0).max(50),
  ),
  // GPU-diffusion-only knobs (issue #2264), ignored by the sync passes.
  // `strength` is the img2img denoise, clamped to the same [MIN, MAX] the
  // lightbox slider is bound to; absent → the conservative arbitrary-upload
  // default. `maxMp` is the optional per-run render-megapixel budget override.
  strength: z.preprocess(
    (v) => (v === undefined || v === '' ? undefined : Number(v)),
    z.number().min(REGEN_STRENGTH_MIN).max(REGEN_STRENGTH_MAX).optional(),
  ),
  maxMp: z.preprocess(
    (v) => (v === undefined || v === '' ? undefined : Number(v)),
    z.number().min(0.25).max(16).optional(),
  ),
});

// Decode the optional ignore-zone envelope. When `?mask=1`, the body is
// `<uint32 BE maskLen><mask PNG bytes><image bytes>` — a no-dependency framing
// that keeps the whole payload inside express.raw() without pulling in
// multer/busboy for a second multipart field. Returns `{ image, mask }` (mask
// null when absent/malformed — the pipeline just skips the composite, never
// 500s). The mask is small (a 1-channel PNG), so the 4-byte length prefix is
// plenty. Guards against a length that overruns the buffer.
function splitMaskEnvelope(body, hasMask) {
  if (!Buffer.isBuffer(body) || body.length === 0) return { image: null, mask: null };
  if (!hasMask) return { image: body, mask: null };
  if (body.length < 4) return { image: body, mask: null };
  const maskLen = body.readUInt32BE(0);
  const maskEnd = 4 + maskLen;
  // A length that doesn't leave any image bytes (or overruns) is malformed —
  // fall back to treating the whole body as the image so a bad frame degrades to
  // "no mask" rather than a hard failure.
  if (maskLen <= 0 || maskEnd >= body.length) return { image: body, mask: null };
  return { image: body.subarray(maskEnd), mask: body.subarray(4, maskEnd) };
}

// 256 MiB raw-byte ceiling — the transport is the only (generous) size bound now
// that base64 inflation is gone. The decompression-bomb guard (MAX_PIXELS) in
// the lib still protects the process regardless of byte size.
const RAW_LIMIT = '256mb';
// Include the common JPEG MIME aliases (image/jpg, image/pjpeg) so direct API
// callers that send them get parsed; the bundled frontend forces
// application/octet-stream, but other clients shouldn't have to. Format is
// authoritatively decided by the magic-byte sniff, not the content-type.
const RAW_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/pjpeg', 'image/webp', 'application/octet-stream'];

router.post(
  '/',
  raw({ type: RAW_TYPES, limit: RAW_LIMIT }),
  asyncHandler(async (req, res) => {
    const { metadata, denoise, diffusion, mask: hasMask, feather, strength, maxMp } = validateRequest(cleanQuerySchema, req.query);

    const rawBody = Buffer.isBuffer(req.body) ? req.body : null;
    const { image: buffer, mask: maskBuffer } = splitMaskEnvelope(rawBody, hasMask);
    if (!buffer || buffer.length === 0) {
      throw new ServerError('Request body must be raw image bytes', {
        status: 400,
        code: 'VALIDATION_ERROR',
      });
    }

    // The original bytes are captured BEFORE any cleaning so the ignore-zone
    // composite can restore true source pixels into the preserved regions (the
    // whole point is to undo the diffusion inside the mask, not re-diffuse it).
    let originalBuffer = buffer;

    const result = await cleanImageBuffer(buffer, { metadata, denoise });

    // GPU FLUX round-trip (issue #2264). Unlike the sync passes, the GPU render
    // is GPU-serialized through mediaJobQueue and can't run inline — so hand the
    // already-sync-cleaned bytes to the shared regen seam, enqueue a job, and
    // return a `jobId` (HTTP 202). The client tracks progress via the media-job
    // channel, then GETs the finished bytes from the result endpoint. The mask,
    // when present, is staged with the (oriented) original so the result-fetch
    // composites the preserved region back over the diffused frame.
    if (diffusion === 'gpu') {
      // Orientation parity (same rationale as the light-pass block below): bake
      // EXIF orientation into the init + preserved-original so the mask (painted
      // in visual space) aligns with the render.
      let gpuInit = result.data;
      let gpuOriginal = maskBuffer ? originalBuffer : null;
      // Dimensions the render + upscale-back target. `result.width/height` are
      // the (metadata-step) cleaned dims; but when a mask forces the oriented
      // re-encode below, the oriented buffer's dims can differ (EXIF 6/8 swaps
      // W/H) — so read them off the ORIENTED buffer, or FLUX renders at the
      // wrong aspect and the composite misaligns.
      let sourceDims = result.width && result.height ? { width: result.width, height: result.height } : null;
      if (maskBuffer) {
        const oriented = await sharp(result.data).rotate().png().toBuffer({ resolveWithObject: true }).catch(() => null);
        if (oriented) {
          gpuInit = oriented.data;
          gpuOriginal = oriented.data;
          sourceDims = { width: oriented.info.width, height: oriented.info.height };
        }
      }
      const queued = await enqueueGpuClean({
        initBuffer: gpuInit,
        sourceDims,
        strength,
        maxMegapixels: maxMp,
        originalBuffer: maskBuffer ? gpuOriginal : null,
        maskBuffer: maskBuffer || null,
        feather,
      });
      console.log(`🧼 Image clean GPU job queued: ${queued.modelId} (strength=${queued.strength}) → job ${queued.jobId.slice(0, 8)}`);
      return res.status(202).json({
        mode: 'gpu',
        ...queued,
        c2paStripped: result.c2paStripped,
        c2paPresent: result.c2paPresent,
        steps: result.steps,
      });
    }

    // Diffusion (CPU light pass) runs LAST in the pipeline order (metadata →
    // denoise → diffusion), on the already-cleaned bytes. `applyLightRegen` is a
    // pure sharp round-trip (resize-squeeze + micro color nudge + high-freq
    // perturbation) that perturbs SynthID's resolution-dependent carriers — the
    // only step here that touches SynthID at all, and honestly best-effort. It
    // always re-encodes to PNG, so the output format/mime flip to PNG when it
    // runs (regardless of the source format). No gallery/GPU dependency.
    let outData = result.data;
    let outFormat = result.format;
    let outMime = result.mimeType;
    let outWidth = result.width;
    let outHeight = result.height;
    const steps = [...result.steps];

    if (diffusion === 'light') {
      // Orientation parity for the ignore-zone composite: the user paints the
      // mask on the browser preview (EXIF-oriented visual space), but when the
      // metadata step is OFF `cleanImageBuffer` returns the source bytes with
      // their orientation tag intact, and `applyLightRegen` reads UN-oriented
      // dims. Left as-is, the mask (oriented) and the diffused base (stored
      // space) would misalign under the composite's fit:fill resize on an
      // Orientation 6/8 source. Bake orientation into BOTH the diffusion input
      // and the preserved-original buffer so base + original + mask all share
      // one visual space. No-op for the common already-oriented/no-orientation
      // cases (a `.rotate()` re-encode with no EXIF tag just re-emits pixels).
      let diffusionInput = result.data;
      if (maskBuffer) {
        const orientedPng = await sharp(result.data).rotate().png().toBuffer().catch(() => null);
        if (orientedPng) {
          diffusionInput = orientedPng;
          originalBuffer = orientedPng;
        }
      }
      const light = await applyLightRegen(diffusionInput);
      if (!light) {
        throw new ServerError('Invalid or corrupt image', {
          status: 400,
          code: 'INVALID_IMAGE',
        });
      }
      // Fidelity metric so the report can show how much the pass actually moved
      // the pixels (the pixel-delta/PSNR the diffusion research gates on) —
      // "disrupt", never "remove". Skipped silently on a decode failure.
      const delta = await computePixelDelta(result.data, light.data).catch(() => null);
      outData = light.data;
      outFormat = 'png';
      outMime = 'image/png';
      outWidth = light.width;
      outHeight = light.height;
      steps.push({
        step: 'diffusion',
        status: 'applied',
        lossless: false,
        mode: 'light',
        // ASCII-only: this rides in the X-Clean-Report HTTP header, which is
        // latin1 — a stray em-dash or delta glyph makes Node reject the send.
        detail: delta
          ? `CPU light pass - best-effort SynthID disruption (pixel delta ${delta.pixelDeltaPct}%, PSNR ${delta.psnr}dB); does not guarantee removal`
          : 'CPU light pass - best-effort SynthID disruption; does not guarantee removal',
        ...(delta ? { pixelDeltaPct: delta.pixelDeltaPct, psnr: delta.psnr } : {}),
      });

      // Ignore-zone (preserve-region) compositing runs LAST, only after a
      // diffusion pass has actually redrawn the frame. It restores the ORIGINAL
      // pixels into the user-painted mask (feathered edge) so comic dialog /
      // faces / fine text the diffusion garbled are preserved — a deliberate
      // per-region quality-vs-disruption choice (those regions keep their local
      // SynthID). A missing/malformed mask or a decode failure degrades to the
      // un-composited diffused bytes rather than failing the request.
      if (maskBuffer) {
        const composited = await compositeIgnoreZone(outData, originalBuffer, maskBuffer, { feather });
        if (composited) {
          outData = composited.data;
          outFormat = 'png';
          outMime = 'image/png';
          outWidth = composited.width;
          outHeight = composited.height;
          steps.push({
            step: 'ignore-zone',
            status: 'applied',
            lossless: false,
            detail: `preserve-region composite (feather ${feather}px) - masked pixels keep their original SynthID`,
          });
        } else {
          steps.push({
            step: 'ignore-zone',
            status: 'noop',
            lossless: false,
            detail: 'mask could not be applied (decode failed) - returned the un-preserved diffused result',
          });
        }
      }
    }

    const report = {
      format: outFormat,
      sizeBefore: result.sizeBefore,
      sizeAfter: outData.length,
      width: outWidth,
      height: outHeight,
      c2paStripped: result.c2paStripped,
      c2paPresent: result.c2paPresent,
      steps,
    };

    console.log(`🧼 Image cleaned: ${outFormat} ${result.sizeBefore}B → ${outData.length}B (c2pa=${result.c2paStripped}, steps=${steps.map((s) => s.step).join('+') || 'none'})`);

    // Expose the report header so a cross-origin / dev-proxied fetch can read it.
    res.setHeader('Access-Control-Expose-Headers', 'X-Clean-Report');
    res.setHeader('X-Clean-Report', JSON.stringify(report));
    res.setHeader('Content-Type', outMime);
    res.send(outData);
  }),
);

// Validate a clean job id — the mediaJobQueue mints v4 UUIDs, so anything that
// isn't UUID-shaped can't be a real job (and keeps the temp-path resolution
// safe). Reused by the result-fetch + save-to-gallery routes below.
const jobIdSchema = z.object({
  jobId: z.string().uuid('Invalid job id'),
});

// Result-fetch for a GPU FLUX clean job (issue #2264). Returns the finished
// temp render bytes (with any pending ignore-zone composite applied) as the
// response body — the default is NOT to keep them in the gallery. 409 while the
// job is still queued/running (the client keeps polling the media-job channel);
// 404 once past the temp GC / never produced. The result stays ephemeral: the
// caller saves it explicitly via POST below if they want to keep it.
router.get(
  '/result/:jobId',
  asyncHandler(async (req, res) => {
    const { jobId } = validateRequest(jobIdSchema, req.params);
    const status = getGpuCleanStatus(jobId);
    if (status.status === 'failed' || status.status === 'canceled') {
      throw new ServerError(status.error || `Clean job ${status.status}`, { status: 409, code: 'JOB_FAILED' });
    }
    // Never read bytes off disk while the job is still queued/running: the
    // runner writes the render mid-flight (and the completion path upscales it
    // back to source dims AFTER the initial write), so a read before the
    // terminal `completed` state could return a partial or pre-upscale frame.
    // 409 keeps the client polling. (A job that vanished from the queue's 24h
    // archive reads as `unknown` — fall through and let the disk decide 200 vs
    // 404, so a completed-then-forgotten render is still fetchable.)
    if (status.status === 'queued' || status.status === 'running') {
      throw new ServerError('Clean result not ready yet', { status: 409, code: 'RESULT_NOT_READY', severity: 'warning' });
    }
    const result = await readGpuCleanResult(jobId);
    if (!result) {
      // Completed/unknown but no bytes on disk → gone (past the temp GC or an
      // unknown id). A true miss so the client stops polling.
      throw new ServerError('Clean result not found', { status: 404, code: 'NOT_FOUND', severity: 'warning' });
    }
    res.setHeader('Access-Control-Expose-Headers', 'X-Clean-Report');
    res.setHeader('X-Clean-Report', JSON.stringify({
      format: 'png',
      width: result.width,
      height: result.height,
      composited: result.composited,
      mode: 'gpu',
    }));
    res.setHeader('Content-Type', 'image/png');
    res.send(result.data);
  }),
);

// Explicit save-to-gallery for a GPU FLUX clean result (issue #2264). The
// default clean flow never touches the gallery; this promotes the finished
// temp render to a first-class gallery citizen (reusing saveUploadedGalleryImage
// so it lists/deletes like any other). Returns the new gallery `{ filename, path }`.
router.post(
  '/result/:jobId/save',
  asyncHandler(async (req, res) => {
    const { jobId } = validateRequest(jobIdSchema, req.params);
    const saved = await saveGpuCleanToGallery(jobId);
    res.status(201).json(saved);
  }),
);

export default router;
