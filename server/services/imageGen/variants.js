/**
 * Image variant helpers — shared logic for the three synchronous variant
 * endpoints: clean, remove-watermark, and light-regen.
 *
 * Each produces an on-disk `_<suffix>.png` + a `_<suffix>.metadata.json`
 * sidecar, auto-files the new copy into every collection that held the source,
 * and returns a gallery-compatible response object. The three operations share
 * an identical persist-variant tail:
 *
 *   await Promise.all([writeFile(outPath, data), writeFile(sidecarPath, …)])
 *   const filed = await autoFileCleanedToSourceCollections(src, out)
 *   console.log(…)
 *   return { …variantMeta, filename, path, width, height, … }
 *
 * `persistVariant` owns that tail; `applyImageClean`, `applyWatermarkRemoval`,
 * and `applyLightRegenVariant` each build the inputs and delegate to it.
 *
 * The route handlers become: validate → read source → call helper → res.json.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'node:path';
import { ServerError } from '../../lib/errorHandler.js';
import { atomicWrite, PATHS } from '../../lib/fileUtils.js';
import { stripPngC2PAChunk } from '../../lib/imageClean.js';
import { removeCornerWatermark } from '../../lib/imageWatermark.js';
import { applyLightRegen, computePixelDelta } from './regen.js';
import { listCollections, addItem, ERR_DUPLICATE } from '../mediaCollections.js';
import { itemKey } from '../../lib/mediaItemKey.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Add `cleanedFilename` to every collection that already contains
 * `sourceFilename`. Returns the ids of collections that received the new
 * entry; silently skips duplicates and swallows per-collection failures so
 * a collection error never blocks the variant write itself.
 */
export async function autoFileCleanedToSourceCollections(sourceFilename, cleanedFilename) {
  const sourceKey = itemKey({ kind: 'image', ref: sourceFilename });
  const all = await listCollections();
  const matching = all.filter((c) => c.items.some((it) => itemKey(it) === sourceKey));
  if (matching.length === 0) return [];
  const results = await Promise.all(matching.map(async (c) => {
    try {
      await addItem(c.id, { kind: 'image', ref: cleanedFilename });
      return c.id;
    } catch (err) {
      if (err?.code === ERR_DUPLICATE) return null;
      console.warn(`⚠️ Auto-file ${cleanedFilename} → collection ${c.id} failed: ${err?.message || err}`);
      return null;
    }
  }));
  return results.filter(Boolean);
}

/**
 * Write the variant PNG + sidecar, auto-file into source collections, and
 * return a gallery-compatible record.
 *
 * @param {object} opts
 * @param {string}   opts.sourceFilename   - original gallery basename (e.g. "abc.png")
 * @param {string}   opts.outFilename      - variant basename (e.g. "abc_clean-aggressive.png")
 * @param {Buffer}   opts.data             - variant PNG bytes
 * @param {object}   opts.variantMeta      - sidecar JSON (already built by caller)
 * @param {number}   [opts.width]          - pixel width from transform result
 * @param {number}   [opts.height]         - pixel height from transform result
 * @param {number}   [opts.sizeBefore]     - source byte size (optional, for response)
 * @param {number}   [opts.sizeAfter]      - variant byte size (optional, for response)
 * @param {string}   opts.logLine          - single console.log message
 * @param {object}   [opts.extraFields]    - additional fields merged into the response
 * @returns {Promise<object>} gallery-compatible record for res.json
 */
export async function persistVariant({
  sourceFilename,
  outFilename,
  data,
  variantMeta,
  width,
  height,
  sizeBefore,
  sizeAfter,
  logLine,
  extraFields = {},
}) {
  const outPath = join(PATHS.images, outFilename);
  const sidecarBase = outFilename.slice(0, -'.png'.length);
  const sidecarPath = join(PATHS.images, `${sidecarBase}.metadata.json`);

  await Promise.all([
    writeFile(outPath, data),
    atomicWrite(sidecarPath, variantMeta),
  ]);

  const filedCollections = await autoFileCleanedToSourceCollections(sourceFilename, outFilename).catch((err) => {
    console.warn(`⚠️ Auto-file ${outFilename} → source collections failed: ${err?.message || err}`);
    return [];
  });

  console.log(`${logLine}${filedCollections.length ? `, filed to ${filedCollections.length} collection(s)` : ''}`);

  return {
    ...variantMeta,
    filename: outFilename,
    path: `/data/images/${outFilename}`,
    ...(width != null ? { width } : {}),
    ...(height != null ? { height } : {}),
    ...(sizeBefore != null ? { sizeBefore } : {}),
    ...(sizeAfter != null ? { sizeAfter, sizeBytes: sizeAfter } : {}),
    ...extraFields,
  };
}

// ---------------------------------------------------------------------------
// Variant operations
// ---------------------------------------------------------------------------

/**
 * Gallery "clean" for /:filename/clean — the CPU resize-squeeze.
 * Reads the source, applies `applyLightRegen` (a downscale→upscale resolution
 * shift that re-encodes to PNG), builds the variant record, and delegates to
 * persistVariant.
 *
 * Why resize-squeeze and not metadata+denoise: the old "aggressive" clean
 * (metadata strip + median/sharpen) did NOT touch SynthID. The resize-squeeze
 * still strips the C2PA provenance chunk (via the PNG re-encode) AND perturbs
 * SynthID's resolution-dependent carriers — a best-effort disruption validated
 * against OpenAI's SynthID detector (issue #1764; detector-dependent, never a
 * guaranteed removal). It runs here (the /clean endpoint), NOT the Regenerate
 * panel's `method:'light'` pass, so the result is tagged as a CLEAN
 * (`cleanLevel: 'resize-squeeze'`) and its lineage reads "Cleaned
 * (resize-squeeze)", distinct from the regen panel's "Regenerated (light)"
 * even though both call the same underlying `applyLightRegen`.
 *
 * @param {object} opts
 * @param {string} opts.filename    - gallery basename
 * @param {object} opts.sourceMeta  - from local.readImageSidecar(filename)
 * @returns {Promise<object>} gallery-compatible record for res.json
 */
export async function applyImageClean({ filename, sourceMeta }) {
  const sourcePath = join(PATHS.images, filename);
  const buffer = await readFile(sourcePath).catch((err) => {
    if (err.code === 'ENOENT') throw new ServerError('Image not found', { status: 404, code: 'NOT_FOUND' });
    throw err;
  });

  // Detect the C2PA chunk BEFORE the re-encode drops it, so the sidecar can
  // report whether provenance was actually stripped (lossless walk, no decode).
  const c2paStripped = stripPngC2PAChunk(buffer).stripped;

  // Resize-squeeze (best-effort SynthID disruption + C2PA strip via re-encode).
  const light = await applyLightRegen(buffer);
  if (!light) {
    throw new ServerError('Invalid or corrupt image', { status: 400, code: 'INVALID_IMAGE' });
  }

  const base = filename.slice(0, -'.png'.length);
  const outFilename = `${base}_clean-resize-squeeze.png`;
  const createdAt = new Date().toISOString();

  // Strip `hidden` so a clean of a hidden source still surfaces in the gallery
  // — cleaning is a deliberate user action that implies wanting to see the result.
  // Strip `filename`/`id` so listGallery's `...metadata` spread doesn't overwrite
  // the disk-derived filename for the cleaned copy with the source's filename.
  const { hidden: _hidden, filename: _srcFilename, id: _srcId, ...sourceMetaForCleaned } = sourceMeta;
  const variantMeta = {
    ...sourceMetaForCleaned,
    createdAt,
    cleanedFrom: filename,
    cleanLevel: 'resize-squeeze',
    c2paStripped,
  };

  return persistVariant({
    sourceFilename: filename,
    outFilename,
    data: light.data,
    variantMeta,
    width: light.width,
    height: light.height,
    sizeBefore: buffer.length,
    sizeAfter: light.data.length,
    logLine: `🧼 Cleaned ${filename} → ${outFilename} (resize-squeeze, ${buffer.length}B → ${light.data.length}B, c2pa=${c2paStripped})`,
    extraFields: {
      // sourceMeta fields already in variantMeta; these explicit fields win on
      // key collisions so createdAt reflects the cleaning, not the original.
      createdAt,
      cleanedFrom: filename,
      cleanLevel: 'resize-squeeze',
      c2paStripped,
    },
  });
}

/**
 * Visible-watermark removal for /:filename/remove-watermark.
 * Reads the source, applies removeCornerWatermark, builds the variant record,
 * and delegates to persistVariant.
 *
 * @param {object} opts
 * @param {string}         opts.filename    - gallery basename
 * @param {object}         opts.sourceMeta  - from local.readImageSidecar(filename)
 * @param {number|undefined} opts.size      - optional override for the corner box side
 * @param {object|undefined} opts.region    - optional explicit bounding box
 * @returns {Promise<object>} gallery-compatible record for res.json
 */
export async function applyWatermarkRemoval({ filename, sourceMeta, size, region }) {
  const sourcePath = join(PATHS.images, filename);
  const buffer = await readFile(sourcePath).catch((err) => {
    if (err.code === 'ENOENT') throw new ServerError('Image not found', { status: 404, code: 'NOT_FOUND' });
    throw err;
  });

  const result = await removeCornerWatermark(buffer, { size, region });

  const base = filename.slice(0, -'.png'.length);
  const outFilename = `${base}_nowatermark.png`;

  // Anchor the variant group at the root original — de-watermarking a
  // cleaned/regenerated variant groups under the root.
  const groupRoot = typeof sourceMeta.cleanedFrom === 'string' && sourceMeta.cleanedFrom
    ? sourceMeta.cleanedFrom : filename;
  const createdAt = new Date().toISOString();

  // Strip hidden/filename/id so listGallery's `...metadata` spread doesn't
  // overwrite the disk-derived filename or re-hide the deliberate variant. Also
  // drop the regen lineage fields: de-watermarking a REGENERATED source would
  // otherwise inherit `regenerated:true` + stale fidelity numbers, and both the
  // lightbox lineage (`describeCleanedLineage`) and variant grouping check
  // `regenerated` BEFORE `watermarkRemoved` — so the variant would mislabel as
  // "Regenerated … % changed" instead of "Watermark removed from …".
  const {
    hidden: _hidden, filename: _srcFilename, id: _srcId,
    regenerated: _regenerated, regenStrength: _regenStrength,
    regenSteps: _regenSteps, regenModelId: _regenModelId,
    regenPixelDeltaPct: _regenPixelDeltaPct, regenPsnr: _regenPsnr,
    regenMethod: _regenMethod,
    ...sourceMetaForVariant
  } = sourceMeta;
  const variantMeta = {
    ...sourceMetaForVariant,
    createdAt,
    cleanedFrom: groupRoot,
    watermarkRemoved: true,
    watermarkRegion: result.region,
  };

  return persistVariant({
    sourceFilename: filename,
    outFilename,
    data: result.data,
    variantMeta,
    width: result.width,
    height: result.height,
    sizeBefore: result.sizeBefore,
    sizeAfter: result.sizeAfter,
    logLine: `✦ Removed watermark ${filename} → ${outFilename} (${result.region.w}×${result.region.h} @ ${result.region.x},${result.region.y})`,
  });
}

/**
 * CPU-only light regen for the `method: 'light'` branch of /:filename/regenerate.
 * Reads the source, applies applyLightRegen, builds the variant record, and
 * delegates to persistVariant.
 *
 * @param {object} opts
 * @param {string} opts.filename        - gallery basename
 * @param {string} opts.sourceAbsPath   - absolute path to the source PNG
 * @param {object} opts.sourceMeta      - from local.readImageSidecar(filename)
 * @returns {Promise<object>} gallery-compatible record for res.json
 */
export async function applyLightRegenVariant({ filename, sourceAbsPath, sourceMeta }) {
  const buffer = await readFile(sourceAbsPath).catch((err) => {
    if (err.code === 'ENOENT') throw new ServerError('Image not found', { status: 404, code: 'NOT_FOUND' });
    throw err;
  });
  const result = await applyLightRegen(buffer);
  if (!result) {
    throw new ServerError('Could not decode image for light regen', { status: 400, code: 'INVALID_IMAGE' });
  }

  const base = filename.slice(0, -'.png'.length);
  const outFilename = `${base}_regen-light.png`;

  // Anchor the variant group at the root original — regenerating a
  // cleaned/regenerated variant must group under the root, not orphan.
  const groupRoot = typeof sourceMeta.cleanedFrom === 'string' && sourceMeta.cleanedFrom
    ? sourceMeta.cleanedFrom : filename;
  const createdAt = new Date().toISOString();

  // Strip hidden/filename/id so the listGallery `...metadata` spread doesn't
  // overwrite the disk-derived filename or re-hide the deliberate variant.
  // Also strip the FLUX-regen-specific fields: when the source is itself a
  // prior FLUX regen, carrying its regenStrength/Steps/ModelId + stale
  // delta into a SPATIAL pass would make the lineage row falsely read
  // "· N% denoise" (a light pass has no denoise) and show a stale fidelity.
  const {
    hidden: _hidden, filename: _srcFilename, id: _srcId,
    regenStrength: _rs, regenSteps: _rst, regenModelId: _rm,
    regenPixelDeltaPct: _rpd, regenPsnr: _rp,
    ...sourceMetaForVariant
  } = sourceMeta;

  // Compare the in-memory source/output buffers — no need to re-read the
  // written file off disk just to measure the delta.
  const delta = await computePixelDelta(buffer, result.data).catch(() => null);
  const variantMeta = {
    ...sourceMetaForVariant,
    createdAt,
    cleanedFrom: groupRoot,
    regenerated: true,
    regenMethod: 'light-spatial',
    ...(delta ? { regenPixelDeltaPct: delta.pixelDeltaPct, regenPsnr: delta.psnr } : {}),
  };

  return persistVariant({
    sourceFilename: filename,
    outFilename,
    data: result.data,
    variantMeta,
    width: result.width,
    height: result.height,
    logLine: `♻️ Light-regen ${filename} → ${outFilename} (${delta ? `${delta.pixelDeltaPct}% changed` : 'fidelity n/a'})`,
  });
}
