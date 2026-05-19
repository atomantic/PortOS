/**
 * Universe Builder Routes
 *
 *   GET    /api/universe-builder                        → Universe[]
 *   POST   /api/universe-builder                        → Universe
 *   GET    /api/universe-builder/:id                    → Universe
 *   PATCH  /api/universe-builder/:id                    → Universe
 *   DELETE /api/universe-builder/:id                    → { id }
 *   POST   /api/universe-builder/expand                 → { logline, premise, styleNotes, influences, categories, compositeSheets, characters, places, objects, llm }
 *   POST   /api/universe-builder/:id/render             → { runId, collectionId, jobIds, promptCount }
 *   GET    /api/universe-builder/:id/runs               → Run[]
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import * as svc from '../services/universeBuilder.js';
import * as canonSvc from '../services/universeCanon.js';
import { expandUniverseCharacter } from '../services/universeCharacterExpand.js';
import { renderCharacterReferenceSheet, deleteCharacterReferenceSheet } from '../services/universeCharacterSheet.js';
import { BIBLE_KINDS, BIBLE_LIMITS, pruneStaleReferenceSheets } from '../lib/storyBible.js';
import { getUniverseCanonUsage, listLinkedSeriesNames } from '../services/canonUsage.js';
import { expandWorldTemplate, generateCategoryVariations } from '../services/universeBuilderExpand.js';
import { refineWorldPrompts } from '../services/universeBuilderRefine.js';
import { promoteVariationToCanon, VALID_TARGET_KINDS } from '../services/universeBuilderPromote.js';
import { autoSortOtherBuckets } from '../services/universeBuilderAutoSort.js';
import { enqueueJob } from '../services/mediaJobQueue/index.js';
import { getSettings } from '../services/settings.js';
import { findOrCreateUniverseCollection } from '../services/mediaCollections.js';
import { registerUniverseBuilderRun } from '../services/universeBuilderCollectionHook.js';
import { getImageModels, isFlux2, isZImage, isErnie } from '../lib/mediaModels.js';
import { getStylePresetById } from '../lib/writersRoomStylePresets.js';

const router = Router();

const SERVICE_ERROR_STATUS = {
  [svc.ERR_NOT_FOUND]: 404,
  [svc.ERR_VALIDATION]: 400,
};

const mapServiceError = (err) => {
  const status = SERVICE_ERROR_STATUS[err?.code];
  if (status) return new ServerError(err.message, { status, code: err.code });
  return err;
};

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

export const llmSchema = z.object({
  provider: z.string().trim().max(80).nullable().optional(),
  model: z.string().trim().max(200).nullable().optional(),
}).optional();

// `locked` is a sparse map of `{ field: true }` for the LOCKABLE_FIELDS list.
// `false` is treated the same as omitted — only `true` records a lock so the
// stored shape stays minimal and additive. Accept legacy `influences` key as
// an alias for both `influencesEmbrace` and `influencesAvoid` so older clients
// PATCHing a previously saved lock map still pass validation (sanitizeLocked
// rewrites it on read into the per-list keys).
const lockedSchema = z.object({
  ...Object.fromEntries(svc.LOCKABLE_FIELDS.map((k) => [k, z.boolean().optional()])),
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
  locked: lockedSchema.optional(),
  llm: llmSchema,
  // Canon registries on POST (Phase B.4): writers-room promote, share-bucket
  // import, and tests can seed a universe with canon at create time instead
  // of needing a second PATCH round-trip.
  characters: canonArrayField,
  places: canonArrayField,
  objects: canonArrayField,
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
  mode: z.enum(['external', 'local', 'codex']).optional(),
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

router.get('/', asyncHandler(async (_req, res) => {
  res.json(await svc.listUniverses());
}));

router.post('/', asyncHandler(async (req, res) => {
  const body = validateRequest(createSchema, req.body ?? {});
  res.status(201).json(await svc.createUniverse(body));
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

// Refines the 3 top-level prompts (starter / style / negative) based on
// user feedback. Stateless — the caller decides whether to write the
// result back to a saved universe. Keep ahead of `/:id`.
router.post('/refine-prompts', asyncHandler(async (req, res) => {
  const body = validateRequest(refinePromptsSchema, req.body ?? {});
  res.json(await refineWorldPrompts(body));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const w = await svc.getUniverse(req.params.id).catch((err) => { throw mapServiceError(err); });
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
  const universe = await svc.getUniverse(req.params.id).catch((err) => { throw mapServiceError(err); });

  // Resolve a style preset (server-side authoritative list) so the embrace
  // tokens are deterministic for this render even if the client sent a stale
  // preset object. Unknown ids are ignored (server is the source of truth).
  const stylePreset = getStylePresetById(body.stylePresetId);
  // `negativePrompt` is the schema field; `extraNegative` is compilePrompts'
  // option name (avoids shadowing `negativePrompt` on each compiled item).
  const compiled = svc.compilePrompts(universe, {
    promptMode: body.promptMode,
    selection: body.selection,
    sheetSelection: body.sheetSelection,
    canonSelection: body.canonSelection,
    batchPerVariation: body.batchPerVariation,
    extraStyle: body.extraStyle,
    extraNegative: body.negativePrompt,
    stylePresetPrompt: stylePreset?.prompt,
    stylePresetNegative: stylePreset?.negativePrompt,
  });
  if (!compiled.length) {
    throw new ServerError('No prompts to render — add canon entries, variations, or composite sheets first', {
      status: 400, code: 'WORLD_BUILDER_EMPTY',
    });
  }

  const settings = await getSettings();
  const mode = body.mode || settings.imageGen?.mode || 'external';

  // Reject `external` mode upfront — batch rendering against a remote SD-API
  // would block this request for the entire batch, and we don't want to leave
  // an orphaned media collection behind when we discover this mid-loop below.
  if (mode !== 'local' && mode !== 'codex') {
    throw new ServerError(
      'Batch render requires local or codex mode — switch image-gen mode in Settings → Image Gen',
      { status: 400, code: 'WORLD_BUILDER_EXTERNAL_UNSUPPORTED' },
    );
  }

  // Mirror the upfront validation /api/image-gen/generate does so a doomed
  // batch fails before any jobs land in the queue.
  if (mode === 'codex' && !settings.imageGen?.codex?.enabled) {
    throw new ServerError(
      'Codex Imagegen is disabled — enable it in Settings → Image Gen first',
      { status: 400, code: 'CODEX_IMAGEGEN_DISABLED' },
    );
  }
  if (mode === 'local') {
    const py = settings.imageGen?.local?.pythonPath || null;
    const allModels = getImageModels();
    if (body.modelId && !allModels.some((m) => m.id === body.modelId)) {
      throw new ServerError(`Unknown modelId: ${body.modelId}`, { status: 400, code: 'IMAGE_GEN_UNKNOWN_MODEL' });
    }
    const selectedModel = allModels.find((m) => m.id === body.modelId)
      ?? allModels.find((m) => m.id === 'dev')
      ?? allModels[0];
    if (selectedModel && !isFlux2(selectedModel) && !isZImage(selectedModel) && !isErnie(selectedModel) && !py) {
      throw new ServerError(
        'Local image generation is not configured (settings.imageGen.local.pythonPath is missing).',
        { status: 400, code: 'IMAGE_GEN_NOT_CONFIGURED' },
      );
    }
  }

  // Provision the collection up front so renders can be tagged as they
  // complete. The completion hook (universeBuilderCollectionHook) will add
  // each finished image's filename to this collection. Resolution is
  // universeId-first (not name-first) so a re-render finds the existing
  // linked bucket even if the universe was hand-renamed or another
  // universe happens to share the same display name. Name-only matching
  // would either fork the bucket on rename or hijack a foreign universe's
  // collection — the atomic helper rules out both.
  const collection = await findOrCreateUniverseCollection({
    universeId: universe.id,
    universeName: universe.name,
    description: `Universe Builder renders for "${universe.name}"`,
  });

  const runId = randomUUID();
  const jobIds = [];
  // Map cfgScale → guidance the same way /api/image-gen/generate does. The
  // mediaJobQueue calls imageGen/local.generateImage() directly (not the
  // dispatcher), so without this mapping the Universe Builder UI's CFG control
  // would silently no-op for local renders.
  const guidance = body.guidance ?? body.cfgScale;
  // Local image gen reads `loraFilenames` (basenames) + `loraScales` (parallel
  // array of numbers), not the `[{filename, scale}]` UI shape. Convert here so
  // every enqueued job actually applies the user's LoRA selection.
  const loraFilenames = Array.isArray(body.loras) && body.loras.length
    ? body.loras.map((l) => l.filename)
    : undefined;
  const loraScales = Array.isArray(body.loras) && body.loras.length
    ? body.loras.map((l) => l.scale)
    : undefined;
  const baseParams = {
    width: body.width,
    height: body.height,
    steps: body.steps,
    cfgScale: body.cfgScale,
    guidance,
    quantize: body.quantize,
    seed: body.seed,
    loraFilenames,
    loraScales,
  };

  // Parallel-indexed mapping from jobId → entryRef so the client can show a
  // per-entry pending loader (MediaJobThumb-style) on the variation / sheet /
  // canon row that owns this render. Only entries with a stable `id` carry an
  // entryRef in `compiled` (the sanitizer mints ids on every write now, so
  // legacy id-less records are the only gap).
  const entryJobs = [];
  for (const item of compiled) {
    const params = {
      ...baseParams,
      prompt: item.prompt,
      negativePrompt: item.negativePrompt || undefined,
      // Tag every job so the completion hook can route the result back
      // into the run's collection without us having to thread additional
      // arguments through the queue. `entryRef` (when present — variations
      // and composite sheets gain it once the universe has been written
      // through the current sanitizer) lets the hook also append the
      // rendered filename to the source variation/sheet/canon entry's
      // `imageRefs[]` so the Universe Builder can show the latest render
      // as an avatar next to each item.
      universeRun: {
        runId,
        universeId: universe.id,
        collectionId: collection.id,
        category: item.category,
        label: item.label,
        ...(item.entryRef ? { entryRef: item.entryRef } : {}),
      },
    };
    let queued;
    if (mode === 'codex') {
      const c = settings.imageGen?.codex || {};
      queued = enqueueJob({
        kind: 'image',
        params: { mode: 'codex', codexPath: c.codexPath, model: c.model, ...params },
      });
    } else {
      // mode === 'local' (validated upfront).
      const py = settings.imageGen?.local?.pythonPath || null;
      queued = enqueueJob({
        kind: 'image',
        params: { pythonPath: py, modelId: body.modelId, ...params },
      });
    }
    jobIds.push(queued.jobId);
    if (item.entryRef) entryJobs.push({ jobId: queued.jobId, entryRef: item.entryRef });
  }

  const run = await svc.recordRun({
    id: runId,
    universeId: universe.id,
    collectionId: collection.id,
    jobIds,
    promptCount: compiled.length,
    createdAt: new Date().toISOString(),
  });

  // Tell the completion hook how many jobs to expect so per-image
  // emitRecordUpdated calls can be coalesced into one re-export at run end.
  registerUniverseBuilderRun({ runId, universeId: universe.id, jobCount: jobIds.length });

  console.log(`🌍 Universe Builder render — universe=${universe.name} prompts=${compiled.length} mode=${mode} runId=${runId.slice(0, 8)}`);

  res.json({
    runId: run.id,
    collectionId: collection.id,
    collectionName: collection.name,
    promptCount: compiled.length,
    jobIds,
    // Per-entry mapping for client-side pending-state UI. Empty when the
    // batch only contains entries without stable ids (legacy fallback).
    entryJobs,
    mode,
  });
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

// Generate a single dense artist reference sheet (turnaround + expressions +
// palette + wardrobe + props + hand gestures) from a structured TEXT prompt
// — no init image required, so it works across codex / local backends.
// Returns immediately with `{ jobId, generationId }`; client subscribes to
// SSE for progress, and the server-side completion handler stamps
// `character.referenceSheetImageRef` on success.
const renderReferenceSheetSchema = z.object({
  overridePrompt: z.string().trim().max(8000).optional(),
  overrideNegativePrompt: z.string().trim().max(2000).optional(),
  modelId: z.string().trim().max(64).optional(),
});
router.post('/:id/characters/:entryId/render-reference-sheet', asyncHandler(async (req, res) => {
  const body = validateRequest(renderReferenceSheetSchema, req.body ?? {});
  const result = await renderCharacterReferenceSheet(req.params.id, req.params.entryId, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Delete the character's current reference sheet — unlinks the PNG from
// `data/image-refs/` and nulls `referenceSheetImageRef` on every matching
// character (via `purgeReferenceSheetFromAllUniverses`) so the UI clears
// reactively without a refetch.
router.delete('/:id/characters/:entryId/reference-sheet', asyncHandler(async (req, res) => {
  const result = await deleteCharacterReferenceSheet(req.params.id, req.params.entryId)
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
