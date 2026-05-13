// Mirrors void-private's CodexImagegenService.cleanImage — strips C2PA
// provenance + median-filters pixel-level noise from gpt-image (Codex) output.

import { Router } from 'express';
import { z } from 'zod';
import sharp from 'sharp';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';

const router = Router();

// All sizes here are MiB (1024*1024). 40 MiB decoded → ~53.3 MiB base64 (4*ceil(n/3))
// + small JSON envelope, which fits under the 55mb (= 55 MiB) body parser limit
// in server/index.js. Keep these aligned — raising the decoded cap requires
// raising the body parser limit too.
const MAX_INPUT_BYTES = 40 * 1024 * 1024;
// Reject oversized payloads before allocating the decoded Buffer.
const MAX_BASE64_CHARS = Math.ceil((MAX_INPUT_BYTES * 4) / 3) + 4;
// Cap decoded pixel count to prevent decompression-bomb images: a small payload
// can declare gigantic dimensions and OOM the process during sharp decode. ~96MP
// covers reasonable photos (12000×8000) without allowing pathological inputs.
const MAX_PIXELS = 96 * 1000 * 1000;

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

// PNG chunk type bytes must be ASCII letters per the PNG spec (RFC 2083 §3.2).
// Validating this lets us bail out of the walker on garbage payloads that
// happen to start with the PNG signature, instead of looping millions of times.
function isPngChunkType(buf, offset) {
  for (let i = 0; i < 4; i++) {
    const b = buf[offset + i];
    if (!((b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a))) return false;
  }
  return true;
}

// Real PNGs have well under 50 chunks. Cap the walk so a buffer crafted with
// the PNG signature followed by many tiny ASCII-typed zero-length chunks can't
// force millions of iterations at the 40MiB input limit.
const MAX_PNG_CHUNKS = 10000;

// Walks PNG chunks once for the `caBX` provenance chunk emitted by gpt-image.
// Sharp's default re-encode drops it; we detect it explicitly so the response
// can flag what was stripped. Bails on invalid chunk type, truncated chunk, or
// chunk-count overrun — a buffer that only matches the PNG signature but is
// otherwise garbage could otherwise trigger millions of loop iterations
// (CPU/event-loop DoS).
function pngHasC2PA(buf) {
  let offset = 8;
  let count = 0;
  while (offset + 8 <= buf.length) {
    if (++count > MAX_PNG_CHUNKS) return false;
    if (!isPngChunkType(buf, offset + 4)) return false;
    const length = buf.readUInt32BE(offset);
    if (offset + 8 + length + 4 > buf.length) return false;
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

function applyDenoise(pipeline, level) {
  if (level === 'light') return pipeline.median(1);
  return pipeline.median(3).sharpen();
}

function applyEncoder(pipeline, format) {
  if (format === 'png') return pipeline.png({ compressionLevel: 9 });
  if (format === 'jpeg') return pipeline.jpeg({ quality: 92, mozjpeg: true });
  return pipeline.webp({ quality: 92 });
}

// Throws ServerError (400) on invalid input so callers get a consistent
// status instead of a sharp stack trace surfacing as a 500.
export async function cleanImageBuffer(buffer, level = 'light') {
  if (!CLEAN_LEVELS.includes(level)) {
    throw new ServerError(`Invalid clean level "${level}" (expected one of: ${CLEAN_LEVELS.join(', ')})`, {
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
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

  // Single decode for both EXIF auto-orient + denoise/encode. .rotate() with no
  // args applies the EXIF Orientation tag so the cleaned pixels match what the
  // browser showed in the Before preview (browsers honor EXIF orientation but
  // sharp does not by default). resolveWithObject gives us output dimensions
  // (post-rotation), avoiding a second decode for metadata.
  const base = sharp(buffer, { limitInputPixels: MAX_PIXELS }).rotate();
  try {
    const { data, info } = await applyEncoder(applyDenoise(base, level), format)
      .toBuffer({ resolveWithObject: true });
    return {
      data,
      format,
      mimeType: MIME_TYPES[format],
      sizeBefore: buffer.length,
      sizeAfter: data.length,
      width: info.width || null,
      height: info.height || null,
      c2paStripped,
    };
  } catch (err) {
    // Wrap sharp errors (truncated/corrupt buffer that still passed the
    // magic-byte sniff) into a 400 so bad input doesn't surface as a 500.
    throw new ServerError('Invalid or corrupt image', {
      status: 400,
      code: 'INVALID_IMAGE',
      context: { details: { format, reason: err.message } },
    });
  }
}

router.post('/', asyncHandler(async (req, res) => {
  const { data, level } = validateRequest(cleanBodySchema, req.body);

  // Cap by base64 length BEFORE allocating the decoded Buffer so an oversized
  // payload doesn't briefly balloon RSS.
  if (data.length > MAX_BASE64_CHARS) {
    throw new ServerError(`Image exceeds ${MAX_INPUT_BYTES / 1024 / 1024}MB limit`, {
      status: 400,
      code: 'FILE_TOO_LARGE',
    });
  }

  const buffer = Buffer.from(data, 'base64');
  const result = await cleanImageBuffer(buffer, level);

  console.log(`🧼 Image cleaned: ${result.format} ${result.sizeBefore}B → ${result.sizeAfter}B (level=${level}, c2pa=${result.c2paStripped})`);

  res.json({
    data: result.data.toString('base64'),
    mimeType: result.mimeType,
    format: result.format,
    level,
    sizeBefore: result.sizeBefore,
    sizeAfter: result.sizeAfter,
    width: result.width,
    height: result.height,
    c2paStripped: result.c2paStripped,
  });
}));

export default router;
