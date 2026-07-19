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
import { basename } from 'node:path';
import { ServerError } from './errorHandler.js';
import { tryReadFile, safeJSONParse, atomicWrite, detectImageFormat } from './fileUtils.js';

/**
 * Read cleaner flags off a per-mode settings record. Pure: no I/O, no
 * body-override layer (that's the resolver's job — this is the shared
 * "what did the user save" rule that resolver + Settings UI + ImageGen
 * page + test mocks all need to agree on).
 *
 * Defaults are mode-aware: `cleanC2PA` defaults on only for backends that
 * actually emit C2PA chunks today — `codex` (gpt-image-2) and `external`
 * (A1111 / Forge proxies that may re-encode through ComfyUI's C2PA stamp
 * node). Allow-list rather than deny-list: a future 4th backend defaults
 * off until someone confirms it emits caBX. `denoise` defaults to false
 * everywhere (lossy, blurs text — must be explicitly opted into).
 *
 * Mirrored verbatim in `client/src/lib/imageCleaners.js` — keep the two
 * copies in sync; the client tree can't import from server/lib.
 */
export function resolveCleanersFromConfig(modeCfg, mode) {
  const cfg = modeCfg || {};
  const cleanC2PADefault = mode === 'codex' || mode === 'external';
  return {
    cleanC2PA: typeof cfg.cleanC2PA === 'boolean' ? cfg.cleanC2PA : cleanC2PADefault,
    denoise: typeof cfg.denoise === 'boolean' ? cfg.denoise : false,
  };
}

// There is intentionally no decoded-byte cap. The HTTP route streams raw bytes
// through `express.raw({ limit })`, so the transport itself is the (generous)
// byte ceiling — the old base64-in-JSON cap (40 MiB sized to fit a 55 MiB JSON
// body parser) only existed to bound the ~33% base64 inflation, which the raw
// transport removes. The decompression-bomb guard below stays: it protects the
// process regardless of how the buffer arrived.
//
// Cap decoded pixel count to prevent decompression-bomb images: a small payload
// can declare gigantic dimensions and OOM the process during sharp decode. ~96MP
// covers reasonable photos (12000×8000) without allowing pathological inputs.
const MAX_PIXELS = 96 * 1000 * 1000;

// Clean-level tags stamped on a cleaned gallery variant's sidecar (read by the
// lightbox lineage row). `aggressive` = the legacy metadata+denoise clean;
// `resize-squeeze` = the gallery Clean button's CPU resize-squeeze pass
// (issue #1764). Kept as an array so the Zod enum shape stays stable if a
// future variant is added.
export const CLEAN_LEVELS = ['aggressive', 'resize-squeeze'];

// Magic-byte sniff so we re-encode as the source format and emit the right
// MIME type — extension/header is supplied by the client and not trustworthy.
// Delegates to the shared sniffer in fileUtils; cleaning only handles the three
// formats sharp re-encodes here, so a detected GIF is treated as unsupported.
function detectFormat(buf) {
  const format = detectImageFormat(buf)?.format ?? null;
  return format === 'gif' ? null : format;
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
// force millions of iterations on a large input.
const MAX_PNG_CHUNKS = 10000;

// Chunk types the metadata-strip pass removes. `caBX` is the gpt-image C2PA
// provenance chunk; the text chunks (`tEXt`/`zTXt`/`iTXt`) carry XMP, IPTC and
// arbitrary author/comment key-values (PNG stores XMP as an `iTXt` keyed
// `XML:com.adobe.xmp`), and `eXIf` is the PNG-native EXIF block. All four are
// ancillary — none affect rendering — so dropping them is lossless. Critical and
// color/gamma chunks (IHDR/PLTE/IDAT/IEND, gAMA/cHRM/sRGB/iCCP/tRNS/…) are left
// untouched so pixels and color reproduction are byte-identical.
const C2PA_CHUNK_TYPES = new Set(['caBX']);
const METADATA_CHUNK_TYPES = new Set(['caBX', 'tEXt', 'zTXt', 'iTXt', 'eXIf']);

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
 * Lossless PNG-chunk strip — walks PNG chunks and emits a NEW buffer containing
 * every chunk except those whose type is in `dropTypes`. Pixels untouched, no
 * decode, no re-encode. Output is byte-identical to input modulo the removed
 * chunk(s).
 *
 * Returns `{ data, stripped, droppedTypes, sizeBefore, sizeAfter }`:
 *  - `data` is the new buffer (or the input buffer when no strip happened).
 *  - `stripped` is true only when at least one matching chunk was removed.
 *  - `droppedTypes` lists the distinct chunk types actually removed.
 *  - sizes reflect input vs output buffer lengths.
 *
 * Returns the input untouched (`stripped: false`) on non-PNG / malformed PNG /
 * chunk-count overrun. Never throws — caller decides whether to write the
 * result back or skip.
 */
function stripPngChunks(buffer, dropTypes) {
  const passThrough = {
    data: buffer, stripped: false, droppedTypes: [],
    sizeBefore: buffer?.length || 0, sizeAfter: buffer?.length || 0,
  };
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || detectFormat(buffer) !== 'png') {
    return passThrough;
  }
  // First pass: locate every droppable chunk's start/end so we can splice them
  // out into a single new buffer allocation. Real PNGs only carry one of each
  // but the PNG spec doesn't forbid duplicates — handle it anyway so a defective
  // producer can't leave provenance fragments behind.
  const ranges = []; // [{ start, end }] of chunk bytes (length+type+data+crc) to drop
  const dropped = new Set();
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
    if (dropTypes.has(type)) { ranges.push({ start: offset, end: chunkEnd }); dropped.add(type); }
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
  return { data: out, stripped: true, droppedTypes: [...dropped], sizeBefore: buffer.length, sizeAfter: out.length };
}

/**
 * Lossless C2PA strip — removes only the gpt-image `caBX` provenance chunk.
 * Kept as a focused wrapper so the post-generation auto-clean hook (which only
 * wants the provenance gone, not author metadata) and its tests stay stable.
 * Returns `{ data, stripped, sizeBefore, sizeAfter }`.
 */
export function stripPngC2PAChunk(buffer) {
  const { data, stripped, sizeBefore, sizeAfter } = stripPngChunks(buffer, C2PA_CHUNK_TYPES);
  return { data, stripped, sizeBefore, sizeAfter };
}

/**
 * Lossless metadata strip — removes C2PA (`caBX`) plus the ancillary metadata
 * chunks (`tEXt`/`zTXt`/`iTXt`/`eXIf`, which carry EXIF/XMP/IPTC/comments).
 * Pixels and color chunks are untouched. Returns the full
 * `{ data, stripped, droppedTypes, sizeBefore, sizeAfter }` shape so callers can
 * report exactly what was removed.
 */
export function stripPngMetadataChunks(buffer) {
  return stripPngChunks(buffer, METADATA_CHUNK_TYPES);
}

const MIME_TYPES = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

// Feather (Gaussian blur sigma, px) applied to the preserve-region mask edge so
// the composited boundary is soft rather than a hard cut. Bounded: 0 disables
// feathering (hard edge); sharp rejects a sigma below ~0.3, and a huge sigma on
// a small mask just washes the whole mask grey — 50px is a generous ceiling.
export const IGNORE_ZONE_FEATHER_DEFAULT = 3;
const IGNORE_ZONE_FEATHER_MAX = 50;

/**
 * Ignore-zone (preserve-region) compositing — pure sharp round-trip, no runner
 * or GPU dependency. After a lossy SynthID-disruption pass (CPU light or GPU
 * FLUX) redraws the whole frame — garbling comic dialog, faces, and fine text —
 * this composites the ORIGINAL pixels back into the user-painted mask regions
 * with a feathered (Gaussian-blurred) edge so the boundary is soft.
 *
 * `base` is the diffused/disrupted buffer; `original` is the pre-diffusion image
 * whose pixels are preserved inside the mask; `mask` is an image where WHITE
 * (255) marks preserve-original regions and BLACK (0) keeps the diffused result.
 * The mask is greyscaled and resized (fit: fill) to the base's dimensions, so a
 * client can paint it at any convenient resolution.
 *
 * Honest tradeoff (surfaced in the UI): SynthID is spatially distributed, so a
 * region preserved verbatim keeps its ORIGINAL watermark locally — the mask is a
 * deliberate per-region quality-vs-disruption choice.
 *
 * Returns `{ data, width, height }` (always PNG, to carry the alpha-accurate
 * composite losslessly), or null on any decode failure so the caller can fall
 * back to the un-composited diffused buffer instead of failing the request.
 * `sharpImpl` is injectable for tests.
 */
export async function compositeIgnoreZone(base, original, mask, { feather = IGNORE_ZONE_FEATHER_DEFAULT, sharpImpl = sharp } = {}) {
  if (!Buffer.isBuffer(base) || !Buffer.isBuffer(original) || !Buffer.isBuffer(mask)) return null;
  // Cap every decode at MAX_PIXELS — the mask (and, via the length-framed
  // envelope, the original) can be independently sized, so the decompression-
  // bomb guard the main cleaner enforces must extend to this pass too.
  const opts = { limitInputPixels: MAX_PIXELS };
  const meta = await sharpImpl(base, opts).metadata().catch(() => null);
  const w = Math.round(Number(meta?.width));
  const h = Math.round(Number(meta?.height));
  if (!(w > 0) || !(h > 0)) return null;

  // Clamp the feather sigma into sharp's valid range. A 0 (or sub-threshold)
  // request means "hard edge" — skip the blur entirely rather than let sharp
  // throw on an out-of-range sigma.
  const sigma = Math.min(IGNORE_ZONE_FEATHER_MAX, Math.max(0, Number(feather) || 0));

  const run = async () => {
    // Greyscale + resize the mask to the base dims so the client can paint at any
    // resolution; blur the edge for a soft boundary when feathering is on.
    let maskPipeline = sharpImpl(mask, opts)
      .resize(w, h, { fit: 'fill', kernel: 'cubic' })
      .greyscale();
    if (sigma >= 0.3) maskPipeline = maskPipeline.blur(sigma);
    const alpha = await maskPipeline.toColourspace('b-w').raw().toBuffer();

    // The user paints the mask on the browser preview, which honours EXIF
    // orientation — and the diffused `base` is already in that orientation. Bake
    // the same orientation into the ORIGINAL (`.rotate()`) before sampling its
    // pixels, or an oriented JPEG/PNG would restore rotated/wrong pixels into
    // the masked regions. `.ensureAlpha()` (NOT removeAlpha) keeps the original's
    // own transparency; the mask is then MULTIPLIED into that alpha below so a
    // transparent source region stays transparent instead of turning opaque.
    const originalRgba = await sharpImpl(original, opts)
      .rotate()
      .resize(w, h, { fit: 'fill', kernel: 'cubic' })
      .ensureAlpha()
      .raw()
      .toBuffer();
    // Fold the feathered mask into the original's alpha: preserved (white) keeps
    // the source alpha, unmasked (black) → 0 so `base` shows through.
    for (let i = 0; i < w * h; i += 1) {
      originalRgba[i * 4 + 3] = Math.round((originalRgba[i * 4 + 3] * alpha[i]) / 255);
    }

    const overlay = await sharpImpl(originalRgba, { raw: { width: w, height: h, channels: 4 } })
      .png()
      .toBuffer();

    const data = await sharpImpl(base, opts)
      .png()
      .composite([{ input: overlay, blend: 'over' }])
      .png({ compressionLevel: 6 })
      .toBuffer();
    return { data, width: w, height: h };
  };

  return run().catch(() => null);
}

function applyDenoise(pipeline) {
  return pipeline.median(3).sharpen();
}

function applyEncoder(pipeline, format) {
  if (format === 'png') return pipeline.png({ compressionLevel: 9 });
  if (format === 'jpeg') return pipeline.jpeg({ quality: 92, mozjpeg: true });
  return pipeline.webp({ quality: 92 });
}

/**
 * Composable clean — runs an opt-in subset of the cleaning steps, in order:
 *   1. metadata (default ON, lossless)  — strip C2PA + EXIF/XMP/IPTC/text
 *   2. denoise  (default OFF, lossy)    — median(3) + sharpen
 *
 * `denoise` re-encodes through sharp, which drops ALL ancillary metadata as a
 * side effect — so when denoise runs it implicitly satisfies the metadata step
 * regardless of the `metadata` flag (both off is the only way to keep metadata).
 *
 * Returns the cleaned bytes plus a per-step `steps[]` report so the route/UI can
 * tell the user exactly what ran. Throws ServerError (400) on invalid input so
 * callers get a consistent status instead of a sharp stack trace surfacing as a
 * 500. No byte cap — see the MAX_PIXELS note above; the transport bounds size.
 */
export async function cleanImageBuffer(buffer, options = {}) {
  const { metadata = true, denoise = false } = options;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ServerError('Decoded payload is empty', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const format = detectFormat(buffer);
  if (!format) {
    throw new ServerError('Unsupported image format (expected PNG, JPEG, or WebP)', {
      status: 400,
      code: 'UNSUPPORTED_FORMAT',
    });
  }

  const sizeBefore = buffer.length;
  const hadC2PA = format === 'png' && pngHasC2PA(buffer);
  const steps = [];
  let outData = buffer;
  let width = null;
  let height = null;
  let c2paStripped = false;

  try {
    if (denoise) {
      // Single decode for EXIF auto-orient + denoise + encode. .rotate() with no
      // args bakes the EXIF Orientation tag into pixels so the cleaned image
      // matches what the browser showed (browsers honor EXIF orientation, sharp
      // does not by default). The re-encode drops every ancillary chunk, so the
      // metadata step is implicitly satisfied here too.
      const base = sharp(buffer, { limitInputPixels: MAX_PIXELS }).rotate();
      const { data, info } = await applyEncoder(applyDenoise(base), format)
        .toBuffer({ resolveWithObject: true });
      outData = data;
      width = info.width || null;
      height = info.height || null;
      c2paStripped = hadC2PA;
      // The re-encode drops all metadata unconditionally. Report it even when the
      // user left the metadata step OFF — otherwise the report implies metadata
      // survived a denoise pass, which it never does. Honest > misleading.
      steps.push({
        step: 'metadata',
        status: 'applied',
        lossless: false,
        detail: metadata ? 'dropped via re-encode' : 'dropped as an unavoidable side effect of denoise re-encode',
      });
      steps.push({ step: 'denoise', status: 'applied', lossless: false, detail: 'median(3) + sharpen' });
    } else if (metadata && format === 'png') {
      const meta = await sharp(buffer, { limitInputPixels: MAX_PIXELS }).metadata();
      if (meta.orientation && meta.orientation > 1) {
        // The PNG carries a non-default EXIF Orientation (in its eXIf chunk). A
        // pure chunk strip would drop that tag and visibly rotate/flip the image
        // in viewers that honor PNG orientation. Bake the rotation into pixels
        // (re-encode → lossy) before dropping metadata, exactly like the
        // JPEG/WebP path — correctness wins over losslessness here.
        const base = sharp(buffer, { limitInputPixels: MAX_PIXELS }).rotate();
        const { data, info } = await applyEncoder(base, format).toBuffer({ resolveWithObject: true });
        outData = data;
        width = info.width || null;
        height = info.height || null;
        c2paStripped = hadC2PA;
        steps.push({ step: 'metadata', status: 'applied', lossless: false, detail: 'orientation baked + dropped via re-encode (lossy)' });
      } else {
        // Validate the pixel data decodes before returning the (lossless)
        // original bytes — `.metadata()` only reads headers, so a PNG with a
        // readable header but corrupt IDAT would otherwise pass through as a
        // broken "cleaned" download. A raw decode (no re-encode) rejects the
        // corruption while keeping the output byte-lossless, and yields the
        // post-decode dims in the same pass.
        const { info } = await sharp(buffer, { limitInputPixels: MAX_PIXELS })
          .raw().toBuffer({ resolveWithObject: true });
        // Lossless strip: walk chunks and emit a new buffer minus the metadata
        // chunks. Pixels byte-identical, no re-encode.
        const stripped = stripPngMetadataChunks(buffer);
        outData = stripped.data;
        c2paStripped = stripped.droppedTypes.includes('caBX');
        width = info.width || null;
        height = info.height || null;
        steps.push({
          step: 'metadata',
          status: stripped.stripped ? 'applied' : 'noop',
          lossless: true,
          detail: stripped.stripped ? `dropped ${stripped.droppedTypes.join(', ')}` : 'no metadata chunks found',
        });
      }
    } else if (metadata) {
      // JPEG/WebP have no cheap lossless chunk-walk; re-encode through sharp,
      // which drops metadata by default. .rotate() bakes EXIF orientation into
      // pixels first so the image still displays right-side-up after the tag is
      // dropped. This is a re-encode, NOT lossless — the format carries no
      // separate lossless metadata path here, so the step is flagged lossy and
      // the UI surfaces that (don't claim pixels are untouched for these).
      const base = sharp(buffer, { limitInputPixels: MAX_PIXELS }).rotate();
      const { data, info } = await applyEncoder(base, format).toBuffer({ resolveWithObject: true });
      outData = data;
      width = info.width || null;
      height = info.height || null;
      steps.push({ step: 'metadata', status: 'applied', lossless: false, detail: 'dropped via re-encode (lossy)' });
    } else {
      // No steps selected — return the input untouched, but still decode-validate
      // (raw, no re-encode) so the endpoint never hands back known-corrupt bytes
      // as a success, and report the post-decode dims. Mirrors the lossless PNG
      // path's header-only validation gap fix.
      const { info } = await sharp(buffer, { limitInputPixels: MAX_PIXELS })
        .raw().toBuffer({ resolveWithObject: true });
      width = info.width || null;
      height = info.height || null;
    }
  } catch (err) {
    // Wrap sharp errors (truncated/corrupt buffer that still passed the
    // magic-byte sniff) into a 400 so bad input doesn't surface as a 500.
    throw new ServerError('Invalid or corrupt image', {
      status: 400,
      code: 'INVALID_IMAGE',
      context: { details: { format, reason: err.message } },
    });
  }

  return {
    data: outData,
    format,
    mimeType: MIME_TYPES[format],
    sizeBefore,
    sizeAfter: outData.length,
    width,
    height,
    c2paStripped,
    // Whether a C2PA chunk was present in the source — distinct from whether it
    // was stripped. Lets the UI distinguish "present but kept" (metadata step
    // off) from "none found", instead of conflating both as c2paStripped:false.
    c2paPresent: hadC2PA,
    steps,
  };
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

  const buffer = await tryReadFile(pngPath, null);
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
    const result = await cleanImageBuffer(buffer, { metadata: true, denoise: true }).catch((err) => {
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
