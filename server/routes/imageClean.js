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
import { cleanImageBuffer, CLEAN_LEVELS } from '../lib/imageClean.js';

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

// Pipeline steps ride in the query string, not the body (the body is the image).
const cleanQuerySchema = z.object({
  metadata: queryFlag(true),
  denoise: queryFlag(false),
});

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
    const { metadata, denoise } = validateRequest(cleanQuerySchema, req.query);

    const buffer = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buffer || buffer.length === 0) {
      throw new ServerError('Request body must be raw image bytes', {
        status: 400,
        code: 'VALIDATION_ERROR',
      });
    }

    const result = await cleanImageBuffer(buffer, { metadata, denoise });

    const report = {
      format: result.format,
      sizeBefore: result.sizeBefore,
      sizeAfter: result.sizeAfter,
      width: result.width,
      height: result.height,
      c2paStripped: result.c2paStripped,
      c2paPresent: result.c2paPresent,
      steps: result.steps,
    };

    console.log(`🧼 Image cleaned: ${result.format} ${result.sizeBefore}B → ${result.sizeAfter}B (c2pa=${result.c2paStripped}, steps=${result.steps.map((s) => s.step).join('+') || 'none'})`);

    // Expose the report header so a cross-origin / dev-proxied fetch can read it.
    res.setHeader('Access-Control-Expose-Headers', 'X-Clean-Report');
    res.setHeader('X-Clean-Report', JSON.stringify(report));
    res.setHeader('Content-Type', result.mimeType);
    res.send(result.data);
  }),
);

export default router;
