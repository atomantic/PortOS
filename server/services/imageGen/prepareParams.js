/**
 * prepareGenerateParams — pre-dispatch preparation for POST /image-gen/generate.
 *
 * Handles everything between Zod validation and the final dispatch branch:
 *   - resolve effective backend mode + per-render cleaners
 *   - gate reference-image uploads to local FLUX.2 only
 *   - stage multer temp uploads into PATHS.images / PATHS.imageRefs
 *   - resolve initImagePath from upload or gallery filename
 *   - enforce the Codex text-to-image prompt requirement
 *
 * Returns:
 *   {
 *     data            - mutated validated body (initImageFile/referenceStrengths
 *                       stripped; initImagePath/referenceImagePaths/Strengths added)
 *     mode            - resolved IMAGE_GEN_MODE string
 *     settings        - raw settings object (caller reuses for dispatch)
 *     uploadedTempPaths - multer temp paths to unlink after the response closes
 *   }
 *
 * On validation failure throws ServerError so the route's asyncHandler
 * middleware translates it to a 4xx response.
 */

import { copyFile, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';
import { join } from 'node:path';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS, ensureDir, resolveGalleryImage } from '../../lib/fileUtils.js';
import { getSettings } from '../settings.js';
import { IMAGE_GEN_MODE, CLOUD_IMAGE_GEN_MODES, resolveImageCleaners } from './index.js';
import { getImageModels, isFlux2 } from '../../lib/mediaModels.js';

// Only the formats mflux can decode — mirrors the route's MIME_TO_EXT map
// so the route never silently relabels (e.g. HEIC) bytes as ".png".
const MIME_TO_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

/**
 * @param {object} opts
 * @param {object} opts.data    - validated + coerced body from Zod (mutated in place)
 * @param {object} opts.files   - req.files from multer (may be undefined)
 * @param {string[]} opts.referenceImageFields - field names for multi-ref slots
 * @returns {Promise<{ data, mode, settings, uploadedTempPaths }>}
 */
export async function prepareGenerateParams({ data, files, referenceImageFields }) {
  let initImagePath = null;
  const uploadedTempPaths = [];
  const initUpload = files?.initImage;
  const referenceImagePaths = [];
  const referenceImageStrengths = [];

  // Pair strengths by PACK position (post-filter), not slot position — the
  // client renumbers populated slots into `referenceImage1..N` and sends a
  // parallel `referenceStrengths` array sized N. A curl user could leave a
  // gap (`referenceImage2` + `referenceImage4` only); the strength at index 0
  // still pairs with the first surviving upload in slot order.
  const referenceUploads = referenceImageFields
    .map((field) => files?.[field])
    .filter(Boolean)
    .map((upload, packedIndex) => ({ upload, strength: data.referenceStrengths?.[packedIndex] }));

  // Best-effort cleanup of every multer-staged file currently on `files`.
  // The multipart parser writes uploads to `os.tmpdir()` as they stream in,
  // so a 400 thrown from validation BEFORE we've registered the `res.on('close')`
  // sweep would otherwise leak those temp files. Call this from any pre-stage
  // throw site (FLUX.2-only gate, non-local-backend gate).
  const cleanupReqFilesTemp = () => {
    if (!files) return;
    for (const f of Object.values(files)) {
      if (f?.path) unlink(f.path).catch(() => {});
    }
  };

  // Resolve the effective backend BEFORE staging reference uploads — only the
  // local FLUX.2 runner consumes `referenceImagePaths`; an `external` or `codex`
  // request that uploaded refs would otherwise stage files under
  // `PATHS.imageRefs` and write sidecar metadata claiming references were used,
  // while the actual generation silently ignored them. (Reading settings here
  // is cheap — it's already read again below for the per-mode dispatch.)
  const settings = await getSettings();
  const mode = data.mode || settings.imageGen?.mode || IMAGE_GEN_MODE.EXTERNAL;

  // Resolve cleaners ONCE at the route layer so all three dispatch paths
  // (synchronous external, codex queue, local queue) see the same values.
  // Stamp onto `data` so they flow through the spread-into-params calls
  // below verbatim.
  const cleaners = resolveImageCleaners(data, settings, mode);
  data.cleanC2PA = cleaners.cleanC2PA;
  data.denoise = cleaners.denoise;
  delete data.autoClean; // legacy field — already mapped into both flags above

  // Multi-reference is a FLUX.2-only, local-backend-only feature — local.js's
  // buildArgs only emits --reference-images/--reference-strengths inside the
  // isFlux2 branch, and codex/external backends don't read these fields at all.
  // Reject up-front rather than copying the uploads to PATHS.imageRefs and
  // silently dropping them downstream (which would orphan files on disk and
  // produce metadata sidecars that lie about how the render was conditioned).
  if (referenceUploads.length) {
    if (mode !== IMAGE_GEN_MODE.LOCAL) {
      cleanupReqFilesTemp();
      throw new ServerError(
        'Reference images are only supported for local FLUX.2 renders',
        { status: 400, code: 'REFERENCE_IMAGES_LOCAL_ONLY' },
      );
    }
    const candidate = getImageModels().find((m) => m.id === data.modelId)
      ?? getImageModels().find((m) => m.id === 'dev')
      ?? getImageModels()[0];
    if (!isFlux2(candidate)) {
      cleanupReqFilesTemp();
      throw new ServerError(
        'Reference images are only supported for FLUX.2 models',
        { status: 400, code: 'REFERENCE_IMAGES_FLUX2_ONLY' },
      );
    }
  }

  if (initUpload || referenceUploads.length) await ensureDir(PATHS.imageRefs);
  if (initUpload) {
    // Trust the validated mimetype from the fileFilter — picking the ext
    // off the original filename can mismatch the bytes (e.g. HEIC saved
    // as .jpg). MIME_TO_EXT only contains formats the fileFilter accepts.
    const ext = MIME_TO_EXT[(initUpload.mimetype || '').toLowerCase()] || '.png';
    const initFilename = `init-${randomUUID()}${ext}`;
    // Stage into PATHS.imageRefs (sibling of the gallery), NOT PATHS.images —
    // listGallery() enumerates every .png in PATHS.images, so an init upload
    // landing there surfaces as a duplicate "(no prompt)" card in the gallery
    // on every i2i/edit render. The runner re-anchors init paths through
    // resolveImageInputPath, which accepts the refs dir.
    initImagePath = join(PATHS.imageRefs, initFilename);
    await copyFile(initUpload.path, initImagePath);
    uploadedTempPaths.push(initUpload.path);
  } else if (data.initImageFile) {
    const resolved = resolveGalleryImage(data.initImageFile);
    if (!resolved) {
      throw new ServerError('Init image not found in gallery', { status: 400, code: 'INIT_IMAGE_NOT_FOUND' });
    }
    initImagePath = resolved;
  }

  // Multi-reference editing (FLUX.2). Walk packed slot entries in submit
  // order — each contributes a path + its parallel strength. Empty slots
  // are filtered out above so the runner sees `referenceImagePaths: [p1, ...]`
  // and aligns strengths by index.
  for (const { upload, strength } of referenceUploads) {
    const ext = MIME_TO_EXT[(upload.mimetype || '').toLowerCase()] || '.png';
    const refFilename = `ref-${randomUUID()}${ext}`;
    const refPath = join(PATHS.imageRefs, refFilename);
    await copyFile(upload.path, refPath);
    uploadedTempPaths.push(upload.path);
    referenceImagePaths.push(refPath);
    // Default to 1.0 when the client didn't send a parallel strength entry,
    // matching the "full influence" intent of an uploaded reference.
    referenceImageStrengths.push(typeof strength === 'number' ? strength : 1.0);
  }

  // Strip the route-only fields — providers expect normalized `…Path(s)`.
  delete data.initImageFile;
  delete data.referenceStrengths;
  if (initImagePath) data.initImagePath = initImagePath;
  if (referenceImagePaths.length) {
    data.referenceImagePaths = referenceImagePaths;
    data.referenceImageStrengths = referenceImageStrengths;
  }

  // Empty prompt is allowed for i2i / local / external, but cloud-CLI
  // text-to-image (codex/grok, no init image) still needs one — reject
  // synchronously here so direct API callers get a 400 instead of a
  // 200-then-async-job-failure. Mirrors the guards in codex.js/grok.js and
  // the client's needs-prompt gate.
  if (CLOUD_IMAGE_GEN_MODES.includes(mode) && !initImagePath && !data.prompt?.trim()) {
    throw new ServerError(`Prompt is required for ${mode === IMAGE_GEN_MODE.CODEX ? 'Codex' : 'Grok'} text-to-image`, { status: 400, code: 'VALIDATION_ERROR' });
  }

  if (data.guidance == null && data.cfgScale != null) {
    data.guidance = data.cfgScale;
  }

  return { data, mode, settings, uploadedTempPaths };
}
