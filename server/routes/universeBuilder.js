/**
 * Universe Builder Routes
 *
 *   GET    /api/universe-builder                        → Universe[]
 *   POST   /api/universe-builder                        → Universe
 *   GET    /api/universe-builder/:id                    → Universe
 *   PATCH  /api/universe-builder/:id                    → Universe
 *   DELETE /api/universe-builder/:id                    → { id }
 *   POST   /api/universe-builder/expand                 → { logline, premise, styleNotes, influences, categories, compositeSheets, characters, places, objects, llm }
 *   POST   /api/universe-builder/describe-from-images   → { description, llm }
 *   POST   /api/universe-builder/:id/characters/:entryId/expand-from-images → { fields, updatedFields, llm }
 *   POST   /api/universe-builder/:id/render             → { runId, collectionId, jobIds, promptCount }
 *   GET    /api/universe-builder/:id/runs               → Run[]
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError, createServiceErrorMapper } from '../lib/errorHandler.js';
import { validateRequest, optionalBooleanMap, llmSchema, isPaginationRequested, paginateArray } from '../lib/validation.js';
import * as svc from '../services/universeBuilder.js';
import * as canonSvc from '../services/universeCanon.js';
import { expandUniverseCharacter } from '../services/universeCharacterExpand.js';
import {
  renderCharacterReferenceSheet,
  deleteCharacterReferenceSheet,
  listSheetVariants,
} from '../services/universeCharacterSheet.js';
import { BIBLE_KINDS, BIBLE_LIMITS, pruneStaleReferenceSheets } from '../lib/storyBible.js';
import { getUniverseCanonUsage, listLinkedSeriesNames } from '../services/canonUsage.js';
import { expandWorldTemplate, generateCategoryVariations } from '../services/universeBuilderExpand.js';
import { describeEntityFromImages, VISION_KINDS, VISION_MAX_IMAGES } from '../services/universeVisionDescribe.js';
import { expandEntityFromImages, VISION_EXPAND_MAX_IMAGES } from '../services/universeVisionExpand.js';
import { sanitizeFilename, PATHS, resolveGalleryImage } from '../lib/fileUtils.js';
import { existsSync } from 'fs';
import { join } from 'path';
import { refineWorldPrompts } from '../services/universeBuilderRefine.js';
import { promoteVariationToCanon, VALID_TARGET_KINDS } from '../services/universeBuilderPromote.js';
import { autoSortOtherBuckets } from '../services/universeBuilderAutoSort.js';
import { findDuplicateUniverseGroups, findSameNameUniverses } from '../services/duplicateDetection.js';
import { mergeUniverses, buildCascadeContext } from '../services/recordMerge.js';
import { mergeFieldsWithAI } from '../services/recordMergeAI.js';
import { IMAGE_GEN_MODES } from '../services/imageGen/modes.js';
import { renderUniverseJobs } from '../services/universeBuilderRender.js';

const router = Router();

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
const mapServiceError = createServiceErrorMapper(SERVICE_ERROR_STATUS, (err) =>
  err?.blockingSeries ? { blockingSeries: err.blockingSeries } : buildCascadeContext(err),
);

// ---- shared zod fragments ----
// `id` is optional on input — the service-layer sanitizer mints one with a
// `var-`/`sheet-` prefix when absent. Existing non-empty ids are normalized
// on read/write (trimmed + capped to 80 chars) so renames + bucket-moves
// preserve the link to imageRefs[]; callers should treat the normalized
// form as the canonical id rather than the raw value they supplied.
const entryIdField = z.string().trim().min(1).max(80).optional();
const entryImageRefField = z.string().trim().min(1).max(svc.IMAGE_REF_FILENAME_MAX);
const entryImageRefsField = z.array(entryImageRefField).max(svc.IMAGE_REFS_PER_ENTRY_MAX).optional();
const variationSchema = z.object({
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
const compositeSheetSchema = z.object({
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
const categoriesSchema = z.record(
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
const lockedSchema = z.object({
  ...optionalBooleanMap(svc.LOCKABLE_FIELDS),
  influences: z.boolean().optional(),
}).strict();

const influenceEntrySchema = z.string().trim().min(1).max(svc.INFLUENCE_ENTRY_MAX);
const influencesSchema = z.object({
  embrace: z.array(influenceEntrySchema).max(svc.INFLUENCES_PER_LIST_MAX).optional().default([]),
  avoid: z.array(influenceEntrySchema).max(svc.INFLUENCES_PER_LIST_MAX).optional().default([]),
}).strict();

// Legacy prose prompts: the v2 universe template carried `stylePrompt` /
// `negativePrompt` as comma-separated prose strings; v3 collapses them into
// the chip-based `influences` lists. Accepting them here (as optional) lets
// a stale client (or an importer of a v2 share-bucket payload) hand us the
// legacy shape — the service-layer sanitizer splits + merges the tokens into
// influences. New callers should send `influences` directly.
const legacyStylePromptField = z.string().trim().max(svc.PROMPT_FRAGMENT_MAX).optional();
const legacyNegativePromptField = z.string().trim().max(svc.PROMPT_FRAGMENT_MAX).optional();

// Canon arrays go through `sanitizeBibleList` in the service layer where
// each entry is validated structurally — accept them loosely here so
// patch-the-whole-list flows (e.g. inline canon edits, render-ref hooks)
// don't fail Zod for legitimately rich shapes. Cap at the bible-wide entry
// limit so a malicious payload can't blow up memory.
// Hard cap mirrors BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX (200) with headroom
// — sanitizer truncates anyway, so this just protects the JSON-parse layer.
const canonArrayField = z.array(z.record(z.unknown())).max(500).optional();

const createSchema = z.object({
  name: z.string().trim().min(1).max(svc.NAME_MAX_LENGTH),
  starterPrompt: z.string().trim().max(svc.STARTER_PROMPT_MAX).optional().default(''),
  stylePrompt: legacyStylePromptField,
  negativePrompt: legacyNegativePromptField,
  logline: z.string().trim().max(svc.LOGLINE_MAX).optional().default(''),
  premise: z.string().trim().max(svc.PREMISE_MAX).optional().default(''),
  styleNotes: z.string().trim().max(svc.STYLE_NOTES_MAX).optional().default(''),
  categories: categoriesSchema.optional(),
  compositeSheets: z.array(compositeSheetSchema).max(svc.COMPOSITE_SHEETS_MAX).optional(),
  influences: influencesSchema.optional(),
  // Base "style probe" render filenames — sanitized + capped server-side.
  // Match the sanitizer cap so over-the-cap requests get a loud 400 instead
  // of a silent 200 with N entries dropped (sanitizer keeps the most recent
  // IMAGE_REFS_PER_ENTRY_MAX). Per-element filename cap is shared too.
  styleImageRefs: entryImageRefsField,
  locked: lockedSchema.optional(),
  llm: llmSchema,
  // Canon registries on POST (Phase B.4): writers-room promote, share-bucket
  // import, and tests can seed a universe with canon at create time instead
  // of needing a second PATCH round-trip.
  characters: canonArrayField,
  places: canonArrayField,
  objects: canonArrayField,
  // Local-only "don't sync to peers" marker — see sanitizeRecordForWire.
  ephemeral: z.boolean().optional(),
});
// `origin` is a share-bucket provenance block written by the importer + cleared
// to null by the user; structurally an object or null.
const originField = z.record(z.unknown()).nullable().optional();

const patchSchema = z.object({
  name: z.string().trim().min(1).max(svc.NAME_MAX_LENGTH).optional(),
  starterPrompt: z.string().trim().max(svc.STARTER_PROMPT_MAX).optional(),
  // Legacy prose prompts — see legacy*Field comment above. Tolerated on PATCH
  // so a stale client tab can still save while the new chip-based UI lands.
  stylePrompt: legacyStylePromptField,
  negativePrompt: legacyNegativePromptField,
  logline: z.string().trim().max(svc.LOGLINE_MAX).optional(),
  premise: z.string().trim().max(svc.PREMISE_MAX).optional(),
  styleNotes: z.string().trim().max(svc.STYLE_NOTES_MAX).optional(),
  categories: categoriesSchema.optional(),
  compositeSheets: z.array(compositeSheetSchema).max(svc.COMPOSITE_SHEETS_MAX).optional(),
  influences: influencesSchema.optional(),
  // Base "style probe" render filenames — sanitized + capped server-side.
  // Match the sanitizer cap so over-the-cap requests get a loud 400 instead
  // of a silent 200 with N entries dropped (sanitizer keeps the most recent
  // IMAGE_REFS_PER_ENTRY_MAX). Per-element filename cap is shared too.
  styleImageRefs: entryImageRefsField,
  locked: lockedSchema.optional(),
  llm: llmSchema,
  // Canon writes — these flow through sanitizeBibleList server-side so
  // schema parity here is just "accept arrays of records." Without these
  // entries Zod's default strip behavior silently drops them from the
  // patch (PATCHABLE_SCALARS in services/universeBuilder.js reads them
  // from the post-Zod body, so they'd never reach the writer).
  characters: canonArrayField,
  places: canonArrayField,
  objects: canonArrayField,
  origin: originField,
  ephemeral: z.boolean().optional(),
}).refine((p) => Object.keys(p).length > 0, { message: 'patch must include at least one field' });

const expandSchema = z.object({
  starterPrompt: z.string().trim().min(1).max(svc.STARTER_PROMPT_MAX),
  // Optional structured influences from a prior refinement — passed in so
  // the LLM keeps re-expansions on-direction instead of regenerating from
  // the bare starter idea.
  influences: influencesSchema.optional(),
  // Per-item locks the user has set on individual variations / composite
  // boards. Listed in the LLM prompt so it doesn't waste tokens regenerating
  // them; the client merges them back in after the result returns.
  preservedVariations: z.record(
    z.string().trim().min(1).max(svc.WORLD_CATEGORY_KEY_MAX),
    z.array(variationSchema).max(svc.VARIATIONS_PER_CATEGORY_MAX),
  ).optional(),
  preservedCompositeSheets: z.array(compositeSheetSchema).max(svc.COMPOSITE_SHEETS_MAX).optional(),
  // Current bible/prompt state — locked entries are echoed verbatim, others
  // are starting points the LLM can refine while staying consistent.
  logline: z.string().trim().max(svc.LOGLINE_MAX).optional(),
  premise: z.string().trim().max(svc.PREMISE_MAX).optional(),
  styleNotes: z.string().trim().max(svc.STYLE_NOTES_MAX).optional(),
  locked: lockedSchema.optional(),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
});

// `targetKind` is only required when the source bucket's `kind` is 'other'
// (otherwise the service resolves it from the bucket). Enum derived from
// VALID_TARGET_KINDS so the schema and the resolver share one source.
const promoteVariationSchema = z.object({
  category: z.string().trim().min(1).max(svc.WORLD_CATEGORY_KEY_MAX),
  label: z.string().trim().min(1).max(svc.VARIATION_LABEL_MAX),
  targetKind: z.enum(VALID_TARGET_KINDS).optional(),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
});

// Auto-sort takes no bucket selection — the service scans for every
// `kind: 'other'` bucket on the universe. Provider/model are optional;
// the service falls back to the active provider when omitted.
const autoSortSchema = z.object({
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
});

const generateVariationsSchema = z.object({
  category: z.string().trim().min(1).max(svc.WORLD_CATEGORY_KEY_MAX),
  count: z.number().int().min(1).max(svc.VARIATIONS_PER_CATEGORY_MAX),
  existingLabels: z.array(z.string().trim().min(1).max(svc.VARIATION_LABEL_MAX))
    .max(svc.VARIATIONS_PER_CATEGORY_MAX).optional().default([]),
  influences: influencesSchema.optional(),
  logline: z.string().trim().max(svc.LOGLINE_MAX).optional().default(''),
  premise: z.string().trim().max(svc.PREMISE_MAX).optional().default(''),
  styleNotes: z.string().trim().max(svc.STYLE_NOTES_MAX).optional().default(''),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
});

const refinePromptsSchema = z.object({
  starterPrompt: z.string().trim().min(1).max(svc.STARTER_PROMPT_MAX),
  // Bible context: passed in so the refiner sees the full seed, refines them
  // alongside the prompts, and stays consistent with the universe's narrative.
  logline: z.string().trim().max(svc.LOGLINE_MAX).optional().default(''),
  premise: z.string().trim().max(svc.PREMISE_MAX).optional().default(''),
  styleNotes: z.string().trim().max(svc.STYLE_NOTES_MAX).optional().default(''),
  // Structured influences (embrace + avoid) — refined alongside the prompts
  // and used as the canonical reference list for renderer-token composition.
  influences: influencesSchema.optional(),
  // Post-Expand structure — when present, the refiner sees the full universe
  // (categories + composites with per-item locks) and may edit/replace/add
  // items per the user's feedback. When omitted (pre-Expand iteration), the
  // refiner falls back to the bible-only behavior.
  categories: categoriesSchema.optional(),
  compositeSheets: z.array(compositeSheetSchema).max(svc.COMPOSITE_SHEETS_MAX).optional(),
  // Per-field lock map — locked fields are echoed back unchanged regardless
  // of what the LLM tries to write.
  locked: lockedSchema.optional().default({}),
  feedback: z.string().trim().min(1).max(3000),
  // Optional gallery image used as a VISUAL style reference — when present the
  // refiner forces a vision-capable API provider and folds the image's
  // palette/lighting/mood into influences + styleNotes. Resolved to an absolute
  // path in the handler before reaching the service.
  image: z.string().trim().min(1).max(300).optional(),
  providerId: z.string().trim().max(80).optional(),
  // Whitespace-only model → undefined so the refiner's defaultModel /
  // models[0] fallback kicks in instead of a blank string reaching the
  // provider. Mirrors how /api/media-jobs/refine-prompt handles it.
  model: z.string().max(200).optional().transform((s) => {
    const v = (s ?? '').trim();
    return v.length > 0 ? v : undefined;
  }),
});

// `selection` per category: 'all' or array of variation labels.
const selectionValueSchema = z.union([z.literal('all'), z.array(z.string().trim().min(1).max(svc.VARIATION_LABEL_MAX)).max(svc.VARIATIONS_PER_CATEGORY_MAX)]);
const selectionSchema = z.record(
  z.string().trim().min(1).max(svc.WORLD_CATEGORY_KEY_MAX),
  selectionValueSchema,
).refine((selection) => Object.keys(selection).length <= svc.WORLD_CATEGORY_COUNT_MAX, {
  message: `selection cannot exceed ${svc.WORLD_CATEGORY_COUNT_MAX} buckets`,
});

// `canonSelection` per trunk: 'all' or array of canon-entry names (case-insensitive).
// Settings entries also match on `slugline` so a render queued from the Places
// tab can target an entry the user filed by slugline ("INT. FOUNDRY — DAY").
// Per-trunk cap mirrors the bible sanitizer (`ENTRIES_PER_BIBLE_MAX`) so this
// can't enqueue more entries than the server actually persists; per-string cap
// uses the looser of `NAME_MAX` / `SLUGLINE_MAX` so a places entry filed by
// slugline isn't rejected if those limits ever diverge (both 200 today).
const CANON_TRUNK_KEYS = ['characters', 'places', 'objects'];
const CANON_NEEDLE_MAX = Math.max(BIBLE_LIMITS.NAME_MAX, BIBLE_LIMITS.SLUGLINE_MAX);
const canonSelectionValueSchema = z.union([
  z.literal('all'),
  z.array(z.string().trim().min(1).max(CANON_NEEDLE_MAX)).max(BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX),
]);
const canonSelectionSchema = z.object(
  Object.fromEntries(CANON_TRUNK_KEYS.map((k) => [k, canonSelectionValueSchema.optional()])),
).strict();

const renderSchema = z.object({
  // Removed: callers that still send `collectionName` get an explicit 400
  // (see the .refine() below) instead of a confusing silent no-op. The
  // canonical "Universe: <name>" identity is owned by the universe and
  // enforced by the rename-lock — per-render overrides have no semantic
  // home in that model.
  collectionName: z.unknown().optional(),
  // Image-gen knobs — these mirror /api/image-gen/generate so the user can
  // pick mode/size/steps without bouncing to the Image page first.
  mode: z.enum(IMAGE_GEN_MODES).optional(),
  modelId: z.string().trim().max(64).optional(),
  width: z.number().int().min(64).max(2048).optional(),
  height: z.number().int().min(64).max(2048).optional(),
  steps: z.number().int().min(1).max(150).optional(),
  cfgScale: z.number().min(0).max(30).optional(),
  guidance: z.number().min(0).max(30).optional(),
  quantize: z.enum(['3', '4', '5', '6', '8']).optional(),
  // Per-variation render count and per-category subset.
  promptMode: z.enum(['variations', 'sheets', 'canon', 'all']).optional().default('variations'),
  batchPerVariation: z.number().int().min(1).max(20).optional().default(1),
  selection: selectionSchema.optional(),
  sheetSelection: z.union([z.literal('all'), z.array(z.string().trim().min(1).max(svc.VARIATION_LABEL_MAX)).max(svc.COMPOSITE_SHEETS_MAX)]).optional(),
  canonSelection: canonSelectionSchema.optional(),
  // Per-batch overrides surfaced through the full Image-Gen form. All optional;
  // empty values are treated as "use the universe's existing influences."
  // `seed` matches /api/image-gen/generate's contract (non-negative integer) —
  // local image gen coerces via Number(seed) and would yield NaN for arbitrary
  // strings, so reject early at the boundary.
  seed: z.number().int().min(0).optional(),
  negativePrompt: z.string().trim().max(svc.PROMPT_FRAGMENT_MAX).optional(),
  extraStyle: z.string().trim().max(svc.PROMPT_FRAGMENT_MAX).optional(),
  stylePresetId: z.string().trim().max(80).optional(),
  // Matches /api/image-gen/generate's LoRA contract: basenames only (server
  // resolves against PATHS.loras), max 8 stacked LoRAs per render. Keeping
  // the two routes in sync so a payload that's accepted here can also flow
  // through /api/image-gen/generate if we ever proxy it.
  loras: z.array(z.object({
    filename: z.string().trim().min(1).max(256).regex(/^[^/\\]+$/, 'lora filename must not contain path separators'),
    scale: z.number().min(0).max(2),
    name: z.string().trim().max(256).optional(),
  })).max(8).optional(),
}).refine((body) => body.collectionName === undefined, {
  message: 'collectionName is no longer supported — the linked collection follows the universe name automatically. Remove this field.',
  path: ['collectionName'],
});

// Backward-compatible by default: returns the full universes array. When a client
// passes `limit`/`offset`, the response becomes the bounded
// `{ items, total, limit, offset }` envelope every paginated PortOS list shares.
router.get('/', asyncHandler(async (req, res) => {
  const universes = await svc.listUniverses();
  if (!isPaginationRequested(req.query)) {
    return res.json(universes);
  }
  res.json(paginateArray(universes, req.query, { defaultLimit: 50, maxLimit: 500 }));
}));

router.post('/', asyncHandler(async (req, res) => {
  const body = validateRequest(createSchema, req.body ?? {});
  const created = await svc.createUniverse(body);
  // Non-blocking same-name warning (computed at the route layer so the importer,
  // which calls the service directly, never pays for the scan). The UI surfaces
  // it but may proceed — duplicates are resolved later via Sharing → Duplicates.
  const duplicateName = await findSameNameUniverses(created.name, { excludeId: created.id });
  res.status(201).json(duplicateName.length ? { ...created, _warnings: { duplicateName } } : created);
}));

// `expand` is a sub-resource — keep it ahead of `/:id` so the wildcard
// doesn't catch "expand" as a universe id.
router.post('/expand', asyncHandler(async (req, res) => {
  const body = validateRequest(expandSchema, req.body ?? {});
  const result = await expandWorldTemplate(body);
  res.json(result);
}));

router.post('/generate-variations', asyncHandler(async (req, res) => {
  const body = validateRequest(generateVariationsSchema, req.body ?? {});
  const result = await generateCategoryVariations(body);
  res.json(result);
}));

// A reference image the vision routes accept from one of two sources:
//   - 'upload'  → a filename the client already POSTed to /api/screenshots
//                 (lives under data/screenshots; passed to the runner as a bare
//                 filename, which it resolves under that dir).
//   - 'gallery' → a generated-gallery filename under data/images; resolved here
//                 to an ABSOLUTE path, which the runner's loadImageAsBase64
//                 accepts as-is (it only prefixes data/screenshots for bare
//                 names).
const imageSourceSchema = z.object({
  source: z.enum(['upload', 'gallery']),
  filename: z.string().trim().min(1).max(300),
});

// Resolve a mixed `[{ source, filename }]` list into runner-loadable paths,
// failing loudly per the source's rules. The runner silently DROPS a missing
// image and still sends the text prompt, so a stale/never-uploaded reference
// would let the model describe with fewer references — or hallucinate from the
// prompt alone if all are missing. Reject up front instead.
function resolveImageSources(images) {
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

// Vision-to-prose: turn one or more reference images of a character/place/
// object into an image-gen-ready prose description (multiple images → the
// shared/common description). Stateless — the client decides which entry
// field to write the result into. Images come from upload OR the gallery (see
// resolveImageSources). Keep ahead of `/:id` so "describe-from-images" isn't
// parsed as a universe id.
const describeFromImagesSchema = z.object({
  kind: z.enum(VISION_KINDS),
  name: z.string().trim().max(BIBLE_LIMITS.NAME_MAX).optional(),
  context: z.string().trim().max(2000).optional(),
  images: z.array(imageSourceSchema).min(1).max(VISION_MAX_IMAGES),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
});
router.post('/describe-from-images', asyncHandler(async (req, res) => {
  const body = validateRequest(describeFromImagesSchema, req.body ?? {});
  const screenshots = resolveImageSources(body.images);
  const result = await describeEntityFromImages({ ...body, screenshots });
  res.json(result);
}));

// Refines the 3 top-level prompts (starter / style / negative) based on
// user feedback. Stateless — the caller decides whether to write the
// result back to a saved universe. Keep ahead of `/:id`.
router.post('/refine-prompts', asyncHandler(async (req, res) => {
  const body = validateRequest(refinePromptsSchema, req.body ?? {});
  // Resolve the optional style-reference image to an absolute gallery path
  // before the service runs — fail loudly on a stale/bogus filename rather than
  // letting the runner silently drop it and refine text-only.
  let imagePath = null;
  if (body.image) {
    imagePath = resolveGalleryImage(body.image);
    if (!imagePath) {
      throw new ServerError(`Gallery image not found: ${body.image} — pick another and retry.`, { status: 400, code: 'GALLERY_IMAGE_NOT_FOUND' });
    }
  }
  res.json(await refineWorldPrompts({ ...body, imagePath }));
}));

// Static-path GETs must register BEFORE `/:id` so they aren't swallowed by
// the parametric route. The catalog lists every registered reference-sheet
// variant — the client renders one row per entry in CharacterReferenceSheetPanel.
router.get('/reference-sheet-variants', asyncHandler(async (_req, res) => {
  res.json({ variants: listSheetVariants() });
}));

// ---- Duplicate resolution (static paths — keep BEFORE `/:id`) ----

const mergeSchema = z.object({
  survivorId: z.string().trim().min(1).max(128),
  loserId: z.string().trim().min(1).max(128),
  fieldChoices: z.record(z.enum(['survivor', 'loser'])).optional().default({}),
  // Free-form per-field values that win over the survivor/loser binary —
  // populated by the AI-merge flow (a third unified option) and optionally
  // tweaked by the user before submit.
  fieldOverrides: z.record(z.string()).optional().default({}),
}).refine((b) => b.survivorId !== b.loserId, { message: 'survivor and loser must differ' });

const mergeAIResolveSchema = z.object({
  survivorId: z.string().trim().min(1).max(128),
  loserId: z.string().trim().min(1).max(128),
  fields: z.array(z.string().trim().min(1).max(64)).min(1).max(20),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
}).refine((b) => b.survivorId !== b.loserId, { message: 'survivor and loser must differ' });

router.get('/duplicates', asyncHandler(async (_req, res) => {
  res.json({ groups: await findDuplicateUniverseGroups() });
}));

router.post('/merge/preview', asyncHandler(async (req, res) => {
  const body = validateRequest(mergeSchema, req.body ?? {});
  const preview = await mergeUniverses(body.survivorId, body.loserId, body.fieldChoices, { dryRun: true, fieldOverrides: body.fieldOverrides })
    .catch((err) => { throw mapServiceError(err); });
  res.json(preview);
}));

router.post('/merge', asyncHandler(async (req, res) => {
  const body = validateRequest(mergeSchema, req.body ?? {});
  const result = await mergeUniverses(body.survivorId, body.loserId, body.fieldChoices, { fieldOverrides: body.fieldOverrides })
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Ask the configured AI provider to merge specific conflicting text fields
// into a single unified value per field. Returns `{ merged, skipped, llm, runId }`
// — the client applies `merged` as `fieldOverrides` on the subsequent
// /merge or /merge/preview call. No record state is mutated here.
router.post('/merge/ai-resolve', asyncHandler(async (req, res) => {
  const body = validateRequest(mergeAIResolveSchema, req.body ?? {});
  const [survivor, loser] = await Promise.all([
    svc.getUniverse(body.survivorId).catch((err) => { throw mapServiceError(err); }),
    svc.getUniverse(body.loserId).catch((err) => { throw mapServiceError(err); }),
  ]);
  const result = await mergeFieldsWithAI({
    kind: 'universe',
    survivor,
    loser,
    fields: body.fields,
    providerId: body.providerId,
    model: body.model,
  });
  res.json(result);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  // Read-by-id 404s are benign and high-volume: callers like LoraDatasetDetail
  // speculatively fetch a dataset's `character.universeId` ({ silent: true }),
  // which 404s whenever that universe was deleted. Classify as `warning` so the
  // error middleware skips it instead of spamming ❌ Route error on every
  // page reconnect. (Mirrors the media-job archive-lookup precedent.)
  const w = await svc.getUniverse(req.params.id).catch((err) => {
    const mapped = mapServiceError(err);
    if (mapped?.code === svc.ERR_NOT_FOUND) mapped.severity = 'warning';
    throw mapped;
  });
  // Lazy stale-reference-sheet collapse: nulls out any character.referenceSheetImageRef
  // whose underlying file was deleted from disk, so the UI never tries to
  // render `<img src="/data/image-refs/<gone>">`. Doesn't persist the change
  // — next render or PATCH will overwrite cleanly. Sub-millisecond for the
  // typical 5-50 character universe.
  const pruned = Array.isArray(w?.characters)
    ? { ...w, characters: pruneStaleReferenceSheets(w.characters) }
    : w;
  res.json(pruned);
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const body = validateRequest(patchSchema, req.body ?? {});
  const w = await svc.updateUniverse(req.params.id, body).catch((err) => { throw mapServiceError(err); });
  // Re-check the same-name warning when the rename actually changed the name.
  if ('name' in body) {
    const duplicateName = await findSameNameUniverses(w.name, { excludeId: req.params.id });
    if (duplicateName.length) { res.json({ ...w, _warnings: { duplicateName } }); return; }
  }
  res.json(w);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const r = await svc.deleteUniverse(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(r);
}));

router.get('/:id/runs', asyncHandler(async (req, res) => {
  res.json(await svc.listRuns(req.params.id));
}));

router.post('/:id/render', asyncHandler(async (req, res) => {
  const body = validateRequest(renderSchema, req.body ?? {});
  // Legacy universes carry no variation/sheet ids on disk. sanitizeTemplate
  // mints fresh UUIDs on every read but readState() intentionally does not
  // persist them (race against concurrent writers). The render route needs
  // ids that are stable across the read→queue→completion lifecycle so the
  // collection hook can find the source entry by `entryRef.id`. Gate the
  // one-time no-op write on the raw-disk inspection: fully-migrated
  // universes skip the write so `updatedAt` doesn't bump on every render
  // (which would interfere with LWW sync + trigger spurious re-export).
  // Skip entirely for canon-only renders — canon entries already carry
  // stable ids (storyBible.js sanitizer), so the raw-disk read + write
  // would be pure overhead.
  if (body.promptMode !== 'canon' && await svc.needsEntryIdPersist(req.params.id)) {
    await svc.updateUniverse(req.params.id, () => ({})).catch((err) => { throw mapServiceError(err); });
  }
  const result = await renderUniverseJobs(req.params.id, body, mapServiceError);
  res.json(result);
}));

// ---- Canon (Phase A of Universe-as-canon refactor) ----

const extractCanonSchema = z.object({
  corpus: z.string().trim().min(1).max(200_000),
  kinds: z.array(z.string().trim().min(1)).optional(),
  parallel: z.boolean().optional(),
  providerOverride: z.string().trim().max(64).optional(),
});

// Extract characters/places/objects from a prose body into the universe's
// canon arrays. Same LLM path as the series-side extract — just targeting a
// universe so multiple series can share the cast.
router.post('/:id/extract-canon', asyncHandler(async (req, res) => {
  const body = validateRequest(extractCanonSchema, req.body ?? {});
  const result = await canonSvc.extractCanonFromProse(req.params.id, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Promote a {label, prompt} variation into a full canon entry of the
// corresponding trunk (resolved from the bucket's `kind` field, or the
// caller-supplied `targetKind` for 'other'-kinded buckets). The variation
// is removed from its source bucket and the canon entry is appended in a
// single atomic patch.
router.post('/:id/promote-variation', asyncHandler(async (req, res) => {
  const body = validateRequest(promoteVariationSchema, req.body ?? {});
  const result = await promoteVariationToCanon(req.params.id, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Bulk-classify every `kind: 'other'` bucket via one LLM call. Each bucket's
// `kind` is updated atomically in one `updateUniverse` patch; renames the
// LLM suggests are surfaced in the response but not auto-applied (the UI
// can present them as opt-in suggestions).
router.post('/:id/auto-sort', asyncHandler(async (req, res) => {
  const body = validateRequest(autoSortSchema, req.body ?? {});
  const result = await autoSortOtherBuckets(req.params.id, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

const refineCharSchema = z.object({
  providerId: z.string().trim().max(64).optional(),
  model: z.string().trim().max(128).optional(),
});

router.post('/:id/characters/:entryId/refine', asyncHandler(async (req, res) => {
  const body = validateRequest(refineCharSchema, req.body ?? {});
  const result = await canonSvc.refineUniverseCharacter(req.params.id, req.params.entryId, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Expand a character via one LLM call — fills BLANK extended fields
// (pronouns/age/stats/colorPalette/expressions/...) so a novelist + graphic
// novelist have full reference data. No-clobber on populated fields; locked
// characters return `{ locked: true }` with no LLM call.
router.post('/:id/characters/:entryId/expand', asyncHandler(async (req, res) => {
  const body = validateRequest(refineCharSchema, req.body ?? {});
  const result = await expandUniverseCharacter(req.params.id, req.params.entryId, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Vision-driven expand — a vision model reads reference image(s) (upload or
// gallery) and PROPOSES values for the character's still-blank structured
// fields (palette/visual notes/expressions/...). Review-only: returns the
// proposed `{ field: value }` map; the client applies the kept/edited values
// via the normal entry-PATCH path. No-clobber, characters-only, locked
// characters return `{ locked: true }` with no LLM call.
const expandFromImagesSchema = z.object({
  name: z.string().trim().max(BIBLE_LIMITS.NAME_MAX).optional(),
  context: z.string().trim().max(2000).optional(),
  images: z.array(imageSourceSchema).min(1).max(VISION_EXPAND_MAX_IMAGES),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
});
router.post('/:id/characters/:entryId/expand-from-images', asyncHandler(async (req, res) => {
  const body = validateRequest(expandFromImagesSchema, req.body ?? {});
  const screenshots = resolveImageSources(body.images);
  const result = await expandEntityFromImages({
    universeId: req.params.id,
    entryId: req.params.entryId,
    name: body.name,
    context: body.context,
    screenshots,
    providerId: body.providerId,
    model: body.model,
  }).catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Generate one of the character reference-sheet variants from a structured
// TEXT prompt — no init image required, so it works across codex / local
// backends. The `variant` field selects which prompt-builder + storage slot
// the render targets (defaults to 'standard' = illustrated turnaround).
// Returns immediately with `{ jobId, generationId, variant }`; client
// subscribes to SSE for progress, and the server-side completion handler
// stamps the variant's pointer on success.
const renderReferenceSheetSchema = z.object({
  variant: z.string().trim().min(1).max(48).optional(),
  overridePrompt: z.string().trim().max(8000).optional(),
  overrideNegativePrompt: z.string().trim().max(2000).optional(),
  modelId: z.string().trim().max(64).optional(),
});
router.post('/:id/characters/:entryId/render-reference-sheet', asyncHandler(async (req, res) => {
  const options = validateRequest(renderReferenceSheetSchema, req.body ?? {});
  const result = await renderCharacterReferenceSheet(req.params.id, req.params.entryId, options)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Delete a character's reference sheet — unlinks the PNG from
// `data/image-refs/` and nulls the variant's pointer on every matching
// character so the UI clears reactively without a refetch. `variant` is
// passed via query string (DELETE bodies are awkward across HTTP clients).
const deleteReferenceSheetQuerySchema = z.object({
  variant: z.string().trim().min(1).max(48).optional(),
});
router.delete('/:id/characters/:entryId/reference-sheet', asyncHandler(async (req, res) => {
  const opts = validateRequest(deleteReferenceSheetQuerySchema, req.query ?? {});
  const result = await deleteCharacterReferenceSheet(req.params.id, req.params.entryId, opts)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Cast-wide differentiate — one LLM call rewrites every character so the
// cast as a whole has no visually-colliding pairs. Returns counts + the
// updated universe.
router.post('/:id/characters/differentiate-cast', asyncHandler(async (req, res) => {
  const body = validateRequest(refineCharSchema, req.body ?? {});
  const result = await canonSvc.differentiateUniverseCast(req.params.id, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Cross-reference: per-canon-entry usage across the universe's linked series.
// Read-only aggregation; no LLM calls, no writes. Surfaces which series + how
// many issues each character / place / object appears in, so the user can
// see crossover/cameo footprint at a glance on the Universe Canon page.
router.get('/:id/canon-usage', asyncHandler(async (req, res) => {
  const result = await getUniverseCanonUsage(req.params.id)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Thin lookup: linked-series id/name pairs for callers (e.g. NounsStage) that
// only need to label canon-card "from <series>" chips. Skips the O(series ×
// issues × matchers) prose scan that /canon-usage runs.
router.get('/:id/series-names', asyncHandler(async (req, res) => {
  const result = await listLinkedSeriesNames(req.params.id)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Lock toggle for canon entries. Locked entries are protected from AI rewrite
// paths (refine, differentiate, re-extract field overwrites).
const setLockSchema = z.object({
  locked: z.boolean(),
});
const lockParamsSchema = z.object({
  kind: z.enum(BIBLE_KINDS),
});
router.patch('/:id/canon/:kind/:entryId/lock', asyncHandler(async (req, res) => {
  const { kind } = validateRequest(lockParamsSchema, req.params);
  const body = validateRequest(setLockSchema, req.body ?? {});
  const result = await canonSvc.setCanonEntryLock(
    req.params.id,
    kind,
    req.params.entryId,
    body.locked,
  ).catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Bulk lock/unlock every canon entry of a single kind. Powers the
// "Lock all / Unlock all" buttons in the Universe Builder canon section.
router.patch('/:id/canon/:kind/lock-all', asyncHandler(async (req, res) => {
  const { kind } = validateRequest(lockParamsSchema, req.params);
  const body = validateRequest(setLockSchema, req.body ?? {});
  const result = await canonSvc.setCanonKindLockAll(req.params.id, kind, body.locked)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Bulk lock/unlock every variation in a category bucket. Powers the
// per-bucket "Lock all / Unlock all" affordance on the variations grid.
// Omit `category` in the body to apply to every variation in every bucket;
// pass `includeSheets: true` to also flip composite sheets in the same call.
const setVariationsLockAllSchema = z.object({
  locked: z.boolean(),
  category: z.string().trim().min(1).max(svc.WORLD_CATEGORY_KEY_MAX).nullable().optional(),
  includeSheets: z.boolean().optional(),
});
router.patch('/:id/variations/lock-all', asyncHandler(async (req, res) => {
  const body = validateRequest(setVariationsLockAllSchema, req.body ?? {});
  const result = await svc.setVariationsLockAll(req.params.id, {
    categoryKey: body.category || null,
    locked: body.locked,
    includeSheets: body.includeSheets === true,
  }).catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

export default router;
