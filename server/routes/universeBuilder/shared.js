/**
 * Shared plumbing for the universe-builder sub-routers: the service-error →
 * HTTP status map, the zod fragments that more than one router composes into
 * its own schema, and the two gallery/upload image resolvers the vision +
 * style-reference routes both need.
 */

import { z } from 'zod';
import { existsSync } from 'fs';
import { join } from 'path';
import { ServerError, createServiceErrorMapper } from '../../lib/errorHandler.js';
import { optionalBooleanMap } from '../../lib/validation.js';
import { BIBLE_KINDS } from '../../lib/storyBible.js';
import { sanitizeFilename, PATHS, resolveGalleryImage } from '../../lib/fileUtils.js';
import * as svc from '../../services/universeBuilder.js';
import { buildCascadeContext } from '../../services/recordMerge.js';

const SERVICE_ERROR_STATUS = {
  [svc.ERR_NOT_FOUND]: 404,
  [svc.ERR_VALIDATION]: 400,
  // Block-until-empty: deleting a universe with live series → 409 (the
  // lock-conflict idiom) so the client can show "move these N series first".
  [svc.ERR_HAS_LIVE_SERIES]: 409,
  // recordMerge validation (unresolved conflicts, bad ids).
  MERGE_VALIDATION: 400,
  // recordMerge cascade partially completed (a child re-point failed) → 409 so
  // the client can surface "merge incomplete, re-run to finish".
  MERGE_CASCADE_INCOMPLETE: 409,
};

// Propagate diagnostic context onto the response body via `context`: the
// blocking-series list for a delete-guard 409, or the survivor/loser ids +
// which children failed to re-point for an incomplete merge cascade.
export const mapServiceError = createServiceErrorMapper(SERVICE_ERROR_STATUS, (err) =>
  err?.blockingSeries ? { blockingSeries: err.blockingSeries } : buildCascadeContext(err),
);

// ---- shared zod fragments ----
// `id` is optional on input — the service-layer sanitizer mints one with a
// `var-`/`sheet-` prefix when absent. Existing non-empty ids are normalized
// on read/write (trimmed + capped to 80 chars) so renames + bucket-moves
// preserve the link to imageRefs[]; callers should treat the normalized
// form as the canonical id rather than the raw value they supplied.
export const entryIdField = z.string().trim().min(1).max(80).optional();
export const entryImageRefField = z.string().trim().min(1).max(svc.IMAGE_REF_FILENAME_MAX);
export const entryImageRefsField = z.array(entryImageRefField).max(svc.IMAGE_REFS_PER_ENTRY_MAX).optional();
export const variationSchema = z.object({
  id: entryIdField,
  label: z.string().trim().min(1).max(svc.VARIATION_LABEL_MAX),
  prompt: z.string().trim().min(1).max(svc.PROMPT_FRAGMENT_MAX),
  // Per-item lock — when true, expand preserves this variation across
  // re-runs instead of letting the LLM regenerate it.
  locked: z.boolean().optional(),
  // Render history (newest last). Server stamps this via the collection hook
  // when a render completes; clients echo it back on PATCH-the-whole-list flows
  // so the sanitizer can preserve it across rename/bucket-move.
  imageRefs: entryImageRefsField,
});
export const compositeSheetSchema = z.object({
  id: entryIdField,
  kind: z.enum(svc.COMPOSITE_SHEET_KINDS).optional(),
  label: z.string().trim().min(1).max(svc.VARIATION_LABEL_MAX),
  prompt: z.string().trim().min(1).max(svc.COMPOSITE_PROMPT_MAX),
  // Per-item lock for composite boards (same semantics as variations).
  locked: z.boolean().optional(),
  imageRefs: entryImageRefsField,
});
const categoryShape = z.object({
  // Tags this bucket to one of the 3 canon trunks (or 'other' as the
  // un-classified sink). Optional on input — sanitizeCategories resolves a
  // sensible default from the built-in map (landscapes→places etc.) or
  // falls to 'other'. Added in schema v4.
  kind: z.enum(svc.CATEGORY_KINDS).optional(),
  variations: z.array(variationSchema).max(svc.VARIATIONS_PER_CATEGORY_MAX),
});
export const categoriesSchema = z.record(
  z.string().trim().min(1).max(svc.WORLD_CATEGORY_KEY_MAX),
  categoryShape,
).refine((categories) => Object.keys(categories).length <= svc.WORLD_CATEGORY_COUNT_MAX, {
  message: `categories cannot exceed ${svc.WORLD_CATEGORY_COUNT_MAX} buckets`,
});

// `locked` is a sparse map of `{ field: true }` for the LOCKABLE_FIELDS list.
// `false` is treated the same as omitted — only `true` records a lock so the
// stored shape stays minimal and additive. Accept legacy `influences` key as
// an alias for both `influencesEmbrace` and `influencesAvoid` so older clients
// PATCHing a previously saved lock map still pass validation (sanitizeLocked
// rewrites it on read into the per-list keys).
export const lockedSchema = z.object({
  ...optionalBooleanMap(svc.LOCKABLE_FIELDS),
  influences: z.boolean().optional(),
}).strict();

const influenceEntrySchema = z.string().trim().min(1).max(svc.INFLUENCE_ENTRY_MAX);
export const influencesSchema = z.object({
  embrace: z.array(influenceEntrySchema).max(svc.INFLUENCES_PER_LIST_MAX).optional().default([]),
  avoid: z.array(influenceEntrySchema).max(svc.INFLUENCES_PER_LIST_MAX).optional().default([]),
}).strict();
export const styleReferenceSchema = z.object({
  id: entryIdField,
  title: z.string().trim().min(1).max(svc.STYLE_REFERENCE_TITLE_MAX),
  prompt: z.string().trim().min(1).max(svc.STYLE_REFERENCE_PROMPT_MAX),
  imageRefs: z.array(entryImageRefField).min(1).max(1),
  createdAt: z.string().trim().min(1).max(64).optional(),
}).strict();
export const styleReferencesField = z.array(styleReferenceSchema).max(svc.STYLE_REFERENCES_MAX).optional();

// Legacy prose prompts: the v2 universe template carried `stylePrompt` /
// `negativePrompt` as comma-separated prose strings; v3 collapses them into
// the chip-based `influences` lists. Accepting them here (as optional) lets
// a stale client (or an importer of a v2 share-bucket payload) hand us the
// legacy shape — the service-layer sanitizer splits + merges the tokens into
// influences. New callers should send `influences` directly.
export const legacyStylePromptField = z.string().trim().max(svc.PROMPT_FRAGMENT_MAX).optional();
export const legacyNegativePromptField = z.string().trim().max(svc.PROMPT_FRAGMENT_MAX).optional();

// Canon arrays go through `sanitizeBibleList` in the service layer where
// each entry is validated structurally — accept them loosely here so
// patch-the-whole-list flows (e.g. inline canon edits, render-ref hooks)
// don't fail Zod for legitimately rich shapes. Cap at the bible-wide entry
// limit so a malicious payload can't blow up memory.
// Hard cap mirrors BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX (200) with headroom
// — sanitizer truncates anyway, so this just protects the JSON-parse layer.
export const canonArrayField = z.array(z.record(z.unknown())).max(500).optional();

// Canon-entry `kind` path param, shared by the lock toggles (canon.js) and the
// corrective-vision pair (vision.js).
export const lockParamsSchema = z.object({
  kind: z.enum(BIBLE_KINDS),
});

// A reference image the vision routes accept from one of two sources:
//   - 'upload'  → a filename the client already POSTed to /api/screenshots
//                 (lives under data/screenshots; passed to the runner as a bare
//                 filename, which it resolves under that dir).
//   - 'gallery' → a generated-gallery filename under data/images; resolved here
//                 to an ABSOLUTE path, which the runner's loadImageAsBase64
//                 accepts as-is (it only prefixes data/screenshots for bare
//                 names).
export const imageSourceSchema = z.object({
  source: z.enum(['upload', 'gallery']),
  filename: z.string().trim().min(1).max(300),
});

// Resolve a mixed `[{ source, filename }]` list into runner-loadable paths,
// failing loudly per the source's rules. The runner silently DROPS a missing
// image and still sends the text prompt, so a stale/never-uploaded reference
// would let the model describe with fewer references — or hallucinate from the
// prompt alone if all are missing. Reject up front instead.
export function resolveImageSources(images) {
  return images.map(({ source, filename }) => {
    if (source === 'gallery') {
      const abs = resolveGalleryImage(filename);
      if (!abs) {
        throw new ServerError(`Gallery image not found: ${filename} — pick another and retry.`, { status: 400, code: 'GALLERY_IMAGE_NOT_FOUND' });
      }
      return abs;
    }
    // 'upload' — the upload route already sanitizes on write, so a legitimately
    // uploaded name round-trips unchanged. A hand-crafted name with path
    // components is rejected outright (a 400, not a silent rewrite to a name
    // that won't exist), keeping a traversal attempt distinguishable from a
    // deleted/never-uploaded file.
    const safe = sanitizeFilename(filename);
    if (safe !== filename) {
      throw new ServerError(`Invalid screenshot filename: ${filename}`, { status: 400, code: 'VALIDATION_ERROR' });
    }
    if (!existsSync(join(PATHS.screenshots, safe))) {
      throw new ServerError(`Screenshot not found: ${safe} — re-upload the image and retry.`, { status: 400, code: 'SCREENSHOT_NOT_FOUND' });
    }
    return safe;
  });
}

// Resolve a SINGLE gallery filename to an absolute path, rejecting a
// traversal attempt or an unknown file up front. Shared by the two
// single-gallery-image vision routes (`analyze-style-reference`,
// `correct-from-image`) that resolve one reference image rather than the
// mixed upload/gallery list `resolveImageSources` handles.
export function resolveGalleryImageOrThrow(filename) {
  const imageFilename = sanitizeFilename(filename);
  if (imageFilename !== filename) {
    throw new ServerError(`Invalid gallery image filename: ${filename}`, {
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  const imagePath = resolveGalleryImage(imageFilename);
  if (!imagePath) {
    throw new ServerError(`Gallery image not found: ${imageFilename} — upload it again and retry.`, {
      status: 400,
      code: 'GALLERY_IMAGE_NOT_FOUND',
    });
  }
  return { imageFilename, imagePath };
}
