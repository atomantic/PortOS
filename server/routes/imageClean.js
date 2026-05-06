// Mirrors void-private's CodexImagegenService.cleanImage — strips C2PA
// provenance + median-filters pixel-level noise from gpt-image-1 output.

import { Router } from 'express';
import { z } from 'zod';
import sharp from 'sharp';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';

const router = Router();

const MAX_INPUT_BYTES = 50 * 1024 * 1024;

export const CLEAN_LEVELS = ['light', 'aggressive'];

const cleanBodySchema = z.object({
  data: z.string().min(1, 'data is required (base64)'),
  level: z.enum(CLEAN_LEVELS).optional().default('light'),
});

// Magic-byte sniff so we re-encode as the source format and emit the right
// MIME type — extension/header is supplied by the client and not trustworthy.
function detectFormat(buf) {
  if (buf.length >= 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return 'png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'jpeg';
  }
  if (buf.length >= 12 &&
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return 'webp';
  }
  return null;
}

// Walks PNG chunks once for the `caBX` provenance chunk emitted by gpt-image-1.
// Sharp's default re-encode drops it; we detect it explicitly so the response
// can flag what was stripped.
function pngHasC2PA(buf) {
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    if (type === 'caBX') return true;
    if (type === 'IEND') return false;
    offset += 8 + length + 4;
  }
  return false;
}

const MIME_TYPES = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

function buildPipeline(buffer, format, level) {
  let pipeline = sharp(buffer);
  if (level === 'light') {
    pipeline = pipeline.median(1);
  } else {
    pipeline = pipeline.median(3).sharpen();
  }
  if (format === 'png') return pipeline.png({ compressionLevel: 9 });
  if (format === 'jpeg') return pipeline.jpeg({ quality: 92, mozjpeg: true });
  return pipeline.webp({ quality: 92 });
}

router.post('/', asyncHandler(async (req, res) => {
  const { data, level } = validateRequest(cleanBodySchema, req.body);

  const buffer = Buffer.from(data, 'base64');
  if (buffer.length === 0) {
    throw new ServerError('Decoded payload is empty', { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (buffer.length > MAX_INPUT_BYTES) {
    throw new ServerError(`Image exceeds ${MAX_INPUT_BYTES / 1024 / 1024}MB limit`, {
      status: 400,
      code: 'FILE_TOO_LARGE',
    });
  }

  const format = detectFormat(buffer);
  if (!format) {
    throw new ServerError('Unsupported image format (expected PNG, JPEG, or WebP)', {
      status: 400,
      code: 'UNSUPPORTED_FORMAT',
    });
  }

  const c2paStripped = format === 'png' && pngHasC2PA(buffer);

  const [meta, cleaned] = await Promise.all([
    sharp(buffer).metadata(),
    buildPipeline(buffer, format, level).toBuffer(),
  ]);

  console.log(`🧼 Image cleaned: ${format} ${buffer.length}B → ${cleaned.length}B (level=${level}, c2pa=${c2paStripped})`);

  res.json({
    data: cleaned.toString('base64'),
    mimeType: MIME_TYPES[format],
    format,
    level,
    sizeBefore: buffer.length,
    sizeAfter: cleaned.length,
    width: meta.width || null,
    height: meta.height || null,
    c2paStripped,
  });
}));

export default router;
