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
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { cleanImageBuffer, CLEAN_LEVELS, compositeIgnoreZone, IGNORE_ZONE_FEATHER_DEFAULT } from '../lib/imageClean.js';
import { applyLightRegen, computePixelDelta } from '../services/imageGen/regen.js';

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
// sharp is a hard dependency. `gpu` (the FLUX img2img round-trip) is NOT wired
// on this route yet: it needs the non-gallery render seam factored out of the
// lightbox `/regenerate` flow (async job queue + progress channel), deferred to
// a follow-up. Accepting the token but rejecting it with a clear 501 keeps the
// client contract stable for when that lands. Anything else → the `off` default.
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
    const { metadata, denoise, diffusion, mask: hasMask, feather } = validateRequest(cleanQuerySchema, req.query);

    // The GPU FLUX round-trip needs the non-gallery render seam factored out of
    // the lightbox `/regenerate` flow (async job queue + media-job progress),
    // which this slice defers to a follow-up. Reject it explicitly so a client
    // that asked for it gets an actionable message rather than a silent CPU pass.
    if (diffusion === 'gpu') {
      throw new ServerError('GPU FLUX diffusion is not yet available on the Image Cleaner. Use the CPU light pass (diffusion=light) or run a regeneration from the ImageGen lightbox.', {
        status: 501,
        code: 'NOT_IMPLEMENTED',
      });
    }

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
    const originalBuffer = buffer;

    const result = await cleanImageBuffer(buffer, { metadata, denoise });

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
      const light = await applyLightRegen(result.data);
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

export default router;
