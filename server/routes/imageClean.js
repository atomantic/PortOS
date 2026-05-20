// HTTP wrapper around the core cleaning primitives in server/lib/imageClean.js.
// All sharp/PNG-walker logic lives in the lib so services can call it directly
// (services importing from routes would be a layering violation).

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  cleanImageBuffer, CLEAN_LEVELS, MAX_INPUT_BYTES, MAX_BASE64_CHARS,
} from '../lib/imageClean.js';

const router = Router();

// Re-export so existing `import { CLEAN_LEVELS } from './imageClean.js'`
// consumers in the routes layer keep working.
export { cleanImageBuffer, CLEAN_LEVELS };

const cleanBodySchema = z.object({
  data: z.string().min(1, 'data is required (base64)'),
});

router.post('/', asyncHandler(async (req, res) => {
  const { data } = validateRequest(cleanBodySchema, req.body);

  // Cap by base64 length BEFORE allocating the decoded Buffer so an oversized
  // payload doesn't briefly balloon RSS.
  if (data.length > MAX_BASE64_CHARS) {
    throw new ServerError(`Image exceeds ${MAX_INPUT_BYTES / 1024 / 1024}MB limit`, {
      status: 400,
      code: 'FILE_TOO_LARGE',
    });
  }

  const buffer = Buffer.from(data, 'base64');
  const result = await cleanImageBuffer(buffer);

  console.log(`🧼 Image cleaned: ${result.format} ${result.sizeBefore}B → ${result.sizeAfter}B (c2pa=${result.c2paStripped})`);

  res.json({
    data: result.data.toString('base64'),
    mimeType: result.mimeType,
    format: result.format,
    sizeBefore: result.sizeBefore,
    sizeAfter: result.sizeAfter,
    width: result.width,
    height: result.height,
    c2paStripped: result.c2paStripped,
  });
}));

export default router;
