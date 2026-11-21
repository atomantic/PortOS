import { createHash } from 'crypto';
import { fetchPublicBinary } from '../lib/safeUrlFetch.js';

const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;
const MAX_PIXELS = 20_000_000;
const MAX_EDGE = 4_096;
const MAX_NORMALIZED_BYTES = 8 * 1024 * 1024;
const SAFE_INPUT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export const hashRemoteMediaUrl = (url) => createHash('sha256').update(String(url)).digest('hex');

// Raw remote bytes exist only in this call. Active/vector formats are rejected,
// pixel limits are applied while decoding, and Ollama receives a newly encoded
// single-frame PNG rather than the original payload.
export async function fetchAndNormalizeStackerNewsImage(url) {
  const fetched = await fetchPublicBinary(url, {
    timeoutMs: 15_000,
    maxBytes: MAX_DOWNLOAD_BYTES,
    blockPrivate: true,
  });
  if (!fetched) throw new Error('Remote image was unavailable, unsafe, or larger than 5 MB');
  const mimeType = fetched.contentType.split(';')[0].trim().toLowerCase();
  if (!SAFE_INPUT_TYPES.has(mimeType)) throw new Error(`Unsupported remote image type: ${mimeType || 'unknown'}`);

  const { default: sharp } = await import('sharp');
  const pipeline = sharp(fetched.buffer, { limitInputPixels: MAX_PIXELS, animated: false }).rotate();
  const metadata = await pipeline.metadata();
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_PIXELS) throw new Error('Remote image exceeds the pixel limit');
  const png = await pipeline.resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  if (png.byteLength > MAX_NORMALIZED_BYTES) throw new Error('Normalized remote image exceeds the 8 MB analysis limit');
  const normalized = await sharp(png).metadata();
  return {
    sourceUrlHash: hashRemoteMediaUrl(url),
    contentHash: createHash('sha256').update(png).digest('hex'),
    mimeType: 'image/png',
    width: normalized.width,
    height: normalized.height,
    byteLength: png.byteLength,
    base64: png.toString('base64'),
  };
}
