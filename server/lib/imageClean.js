// Image cleaning primitives — removes the C2PA `caBX` metadata chunk (when
// present) and runs a median(3) + sharpen pass to reduce visible AI-generation
// artifacts on gpt-image / FLUX output. Lives in lib/ (not routes/) so services
// can call it without crossing the routes→services dependency direction. The
// HTTP route in `server/routes/imageClean.js` is a thin wrapper that just
// imports `cleanImageBuffer` from here.
//
// Scope caveat: this is NOT a watermark stripper. SynthID (used by gpt-image,
// Imagen, Gemini) is embedded in pixel values and Google's published claims
// state it survives median filters, sharpen, and re-encode by design — cleaned
// gpt-image renders remain detectable by openai.com/synthid. Keep UI copy
// honest about that distinction.

import sharp from 'sharp';
import { readFile } from 'fs/promises';
import { basename } from 'node:path';
import { ServerError } from './errorHandler.js';
import { tryReadFile, safeJSONParse, atomicWrite } from './fileUtils.js';

/**
 * Read cleaner flags off a per-mode settings record. Pure: no I/O, no
 * body-override layer (that's the resolver's job — this is the shared
 * "what did the user save" rule that resolver + Settings UI + ImageGen
 * page + test mocks all need to agree on).
 *
 * Migration: legacy `autoClean: true` (single boolean, pre-split) maps to
 * BOTH new flags. Users who opted into denoising before the split don't
 * silently lose it on upgrade. `cleanC2PA` defaults to true (safe, lossless);
 * `denoise` defaults to false (lossy, blurs text).
 *
 * Mirrored verbatim in `client/src/lib/imageCleaners.js` — keep the two
 * copies in sync; the client tree can't import from server/lib.
 */
export function resolveCleanersFromConfig(modeCfg) {
  const cfg = modeCfg || {};
  const legacy = cfg.autoClean === true;
  return {
    cleanC2PA: typeof cfg.cleanC2PA === 'boolean' ? cfg.cleanC2PA : true,
    denoise: typeof cfg.denoise === 'boolean' ? cfg.denoise : legacy,
  };
}

// All sizes here are MiB (1024*1024). 40 MiB decoded → ~53.3 MiB base64 (4*ceil(n/3))
// + small JSON envelope, which fits under the 55mb (= 55 MiB) body parser limit
// in server/index.js. Keep these aligned — raising the decoded cap requires
// raising the body parser limit too.
export const MAX_INPUT_BYTES = 40 * 1024 * 1024;
// Reject oversized payloads before allocating the decoded Buffer.
export const MAX_BASE64_CHARS = Math.ceil((MAX_INPUT_BYTES * 4) / 3) + 4;
// Cap decoded pixel count to prevent decompression-bomb images: a small payload
// can declare gigantic dimensions and OOM the process during sharp decode. ~96MP
// covers reasonable photos (12000×8000) without allowing pathological inputs.
const MAX_PIXELS = 96 * 1000 * 1000;

// Exported as a single-value array so the Zod enum shape stays stable if a
// future variant is added.
export const CLEAN_LEVELS = ['aggressive'];

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

/**
 * Lossless C2PA strip — walks PNG chunks and emits a NEW buffer containing
 * every chunk except `caBX`. Pixels untouched, no decode, no re-encode.
 * Output is byte-identical to input modulo the removed chunk(s).
 *
 * Returns `{ data, stripped, sizeBefore, sizeAfter }`:
 *  - `data` is the new buffer (or the input buffer when no strip happened).
 *  - `stripped` is true only when a `caBX` chunk was actually found and removed.
 *  - sizes reflect input vs output buffer lengths.
 *
 * Returns the input untouched (`stripped: false`) on non-PNG / malformed PNG /
 * chunk-count overrun. Never throws — caller decides whether to write the
 * result back or skip.
 */
export function stripPngC2PAChunk(buffer) {
  const passThrough = { data: buffer, stripped: false, sizeBefore: buffer?.length || 0, sizeAfter: buffer?.length || 0 };
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || detectFormat(buffer) !== 'png') {
    return passThrough;
  }
  // First pass: locate every `caBX` chunk's start/end so we can splice them
  // out into a single new buffer allocation. Real PNGs only carry one but the
  // PNG spec doesn't forbid duplicates — handle it anyway so a defective
  // producer can't leave provenance fragments behind.
  const ranges = []; // [{ start, end }] of chunk bytes (length+type+data+crc) to drop
  let offset = 8;
  let count = 0;
  let sawIEND = false;
  while (offset + 8 <= buffer.length) {
    if (++count > MAX_PNG_CHUNKS) return passThrough;
    if (!isPngChunkType(buffer, offset + 4)) return passThrough;
    const length = buffer.readUInt32BE(offset);
    const chunkEnd = offset + 8 + length + 4;
    if (chunkEnd > buffer.length) return passThrough;
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'caBX') ranges.push({ start: offset, end: chunkEnd });
    if (type === 'IEND') { sawIEND = true; break; }
    offset = chunkEnd;
  }
  // If we never reached IEND the file is truncated — don't risk emitting a
  // bad buffer. Pass through untouched and let the caller / downstream
  // pipeline surface the corruption (e.g. via a separate decode).
  if (!sawIEND) return passThrough;
  if (ranges.length === 0) return passThrough;

  const droppedBytes = ranges.reduce((sum, r) => sum + (r.end - r.start), 0);
  const out = Buffer.allocUnsafe(buffer.length - droppedBytes);
  let writeOffset = 0;
  let readOffset = 0;
  for (const { start, end } of ranges) {
    buffer.copy(out, writeOffset, readOffset, start);
    writeOffset += start - readOffset;
    readOffset = end;
  }
  // Copy the tail after the last dropped chunk.
  buffer.copy(out, writeOffset, readOffset);
  return { data: out, stripped: true, sizeBefore: buffer.length, sizeAfter: out.length };
}

const MIME_TYPES = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

function applyDenoise(pipeline) {
  return pipeline.median(3).sharpen();
}

function applyEncoder(pipeline, format) {
  if (format === 'png') return pipeline.png({ compressionLevel: 9 });
  if (format === 'jpeg') return pipeline.jpeg({ quality: 92, mozjpeg: true });
  return pipeline.webp({ quality: 92 });
}

// Throws ServerError (400) on invalid input so callers get a consistent
// status instead of a sharp stack trace surfacing as a 500.
export async function cleanImageBuffer(buffer) {
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
    const { data, info } = await applyEncoder(applyDenoise(base), format)
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

// Post-generation cleaners. Reads the just-written PNG, applies the requested
// passes (lossless C2PA chunk strip and/or lossy denoise), atomically
// replaces the file in place, and patches the sidecar to record what ran.
//
// Two independent flags:
//   - `cleanC2PA: true`  → strip the gpt-image `caBX` provenance chunk via
//     `stripPngC2PAChunk`. Pure byte-level metadata removal, no decode,
//     pixels untouched.
//   - `denoise: true`    → median(3) + sharpen pass via `cleanImageBuffer`.
//     LOSSY: blurs annotation text, halos small details. Opt-in only.
//
// When `denoise` is on, C2PA is stripped implicitly by sharp's re-encode
// regardless of `cleanC2PA` — both flags off short-circuits to a no-op.
// `mode` is one of 'codex' | 'local' | 'external'; only used in log lines.
// Logs and swallows errors — a clean failure must never fail the underlying
// generation (the un-cleaned PNG stays on disk).
export async function autoCleanGeneratedImage({ cleanC2PA = false, denoise = false, pngPath, sidecarPath, mode = 'unknown' }) {
  if (!cleanC2PA && !denoise) return { cleaned: false };
  // Backends that can't produce a `caBX` chunk (local FLUX, external SD-API)
  // shouldn't pay readFile + walk on every render when the user enabled
  // cleanC2PA defensively. Only codex (gpt-image-2) emits the chunk in
  // current production. Denoise still has to run regardless because it's a
  // pixel pass, not a metadata pass.
  if (!denoise && cleanC2PA && mode !== 'codex') return { cleaned: false };

  // Sidecar read has no data dependency on the PNG read/write — kick it off
  // before the readFile so the two disk ops overlap.
  const sidecarReadP = sidecarPath ? tryReadFile(sidecarPath) : Promise.resolve(null);

  const buffer = await readFile(pngPath).catch(() => null);
  if (!buffer) {
    console.warn(`⚠️ Auto-clean skipped (source missing): ${pngPath}`);
    return { cleaned: false };
  }

  let outputData = buffer;
  let c2paStripped = false;
  let denoised = false;
  let sizeBefore = buffer.length;
  let sizeAfter = buffer.length;

  if (denoise) {
    // Denoise re-encodes through sharp, which incidentally drops every
    // ancillary chunk (including caBX). So a denoise pass implicitly
    // satisfies the cleanC2PA flag too — no separate strip needed.
    const result = await cleanImageBuffer(buffer).catch((err) => {
      console.warn(`⚠️ Auto-clean denoise failed for ${basename(pngPath)}: ${err?.message || err}`);
      return null;
    });
    if (!result || result.format !== 'png') return { cleaned: false };
    outputData = result.data;
    c2paStripped = result.c2paStripped;
    denoised = true;
    sizeAfter = result.sizeAfter;
  } else if (cleanC2PA) {
    // Lossless path: walk the PNG chunks and emit a new buffer with caBX
    // removed. No decode, no re-encode, pixel-identical to input.
    const result = stripPngC2PAChunk(buffer);
    if (!result.stripped) {
      // No-op (chunk absent / non-PNG / malformed) — leave the file as-is.
      return { cleaned: false };
    }
    outputData = result.data;
    c2paStripped = true;
    sizeAfter = result.sizeAfter;
  }
  const replaced = await atomicWrite(pngPath, outputData)
    .then(() => true)
    .catch((err) => {
      console.warn(`⚠️ Auto-clean write failed for ${basename(pngPath)}: ${err?.message || err}`);
      return false;
    });
  if (!replaced) return { cleaned: false };

  // Best-effort sidecar patch — a missing sidecar is fine, the clean still
  // happened. Merge so other fields aren't dropped.
  if (sidecarPath) {
    const raw = await sidecarReadP;
    const patched = {
      ...safeJSONParse(raw, {}),
      autoCleaned: true,
      c2paStripped,
      // Granular flags so MediaLightbox / sidecar consumers can show which
      // passes ran. `cleanLevel` kept for back-compat with existing readers
      // — 'aggressive' when denoise ran, 'metadata' when only the lossless
      // strip ran.
      denoised,
      cleanLevel: denoised ? 'aggressive' : 'metadata',
    };
    await atomicWrite(sidecarPath, patched).catch(() => {});
  }

  console.log(`🧼 Cleaned ${basename(pngPath)} (mode=${mode}, ${sizeBefore}B → ${sizeAfter}B, c2pa=${c2paStripped}, denoise=${denoised})`);
  return { cleaned: true, c2paStripped, denoised };
}
