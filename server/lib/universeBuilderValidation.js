// Validates Universe Builder records, canon, expansion, image references, and rendering requests.

import { z } from 'zod';
import { BIBLE_LIMITS } from './bibleLimits.js';
import { BIBLE_KEYS, BIBLE_KINDS } from './universeCanon.js';
import {
  CATEGORY_KINDS,
  COMPOSITE_PROMPT_MAX,
  COMPOSITE_SHEETS_MAX,
  COMPOSITE_SHEET_KINDS,
  DESC_LIMIT,
  IMAGE_REFS_PER_ENTRY_MAX,
  IMAGE_REF_FILENAME_MAX,
  INFLUENCES_PER_LIST_MAX,
  INFLUENCE_ENTRY_MAX,
  LOCKABLE_FIELDS,
  LOGLINE_MAX,
  MOOD_BOARD_ID_MAX,
  NAME_MAX_LENGTH,
  PREMISE_MAX,
  PROMPT_FRAGMENT_MAX,
  STARTER_PROMPT_MAX,
  STYLE_NOTES_MAX,
  STYLE_REFERENCES_MAX,
  STYLE_REFERENCE_PROMPT_MAX,
  STYLE_REFERENCE_TITLE_MAX,
  VARIATIONS_PER_CATEGORY_MAX,
  VARIATION_LABEL_MAX,
  VISION_EXPAND_MAX_IMAGES,
  VISION_MAX_IMAGES,
  WORLD_CATEGORY_COUNT_MAX,
  WORLD_CATEGORY_KEY_MAX,
} from './universeBibleLimits.js';
import { IMAGE_GEN_MODES } from './generationModes.js';
import { RECORD_RENDER_MODEL_MAX } from './renderTargets.js';
import { cloudModelIdString, llmSchema, recordRenderPinFields } from './sharedSchemas.js';
import { universeVisualProfileSchema } from './universeVisualProfileValidation.js';
import { optionalBooleanMap } from './zodCompat.js';

// `id` is optional on input — the service-layer sanitizer mints one with a
// `var-`/`sheet-` prefix when absent. Existing non-empty ids are normalized
// on read/write (trimmed + capped to 80 chars) so renames + bucket-moves
// preserve the link to imageRefs[]; callers should treat the normalized
// form as the canonical id rather than the raw value they supplied.
const entryIdField = z.string().trim().min(1).max(80).optional();

const entryImageRefField = z.string().trim().min(1).max(IMAGE_REF_FILENAME_MAX);

const entryImageRefsField = z.array(entryImageRefField).max(IMAGE_REFS_PER_ENTRY_MAX).optional();

const variationSchema = z.object({
  id: entryIdField,
  label: z.string().trim().min(1).max(VARIATION_LABEL_MAX),
  prompt: z.string().trim().min(1).max(PROMPT_FRAGMENT_MAX),
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
  kind: z.enum(COMPOSITE_SHEET_KINDS).optional(),
  label: z.string().trim().min(1).max(VARIATION_LABEL_MAX),
  prompt: z.string().trim().min(1).max(COMPOSITE_PROMPT_MAX),
  // Per-item lock for composite boards (same semantics as variations).
  locked: z.boolean().optional(),
  imageRefs: entryImageRefsField,
});

const categoryShape = z.object({
  // Tags this bucket to one of the 3 canon trunks (or 'other' as the
  // un-classified sink). Optional on input — sanitizeCategories resolves a
  // sensible default from the built-in map (landscapes→places etc.) or
  // falls to 'other'. Added in schema v4.
  kind: z.enum(CATEGORY_KINDS).optional(),
  variations: z.array(variationSchema).max(VARIATIONS_PER_CATEGORY_MAX),
});

const categoriesSchema = z.record(
  z.string().trim().min(1).max(WORLD_CATEGORY_KEY_MAX),
  categoryShape,
).refine((categories) => Object.keys(categories).length <= WORLD_CATEGORY_COUNT_MAX, {
  message: `categories cannot exceed ${WORLD_CATEGORY_COUNT_MAX} buckets`,
});

// `locked` is a sparse map of `{ field: true }` for the LOCKABLE_FIELDS list.
// `false` is treated the same as omitted — only `true` records a lock so the
// stored shape stays minimal and additive. Accept legacy `influences` key as
// an alias for both `influencesEmbrace` and `influencesAvoid` so older clients
// PATCHing a previously saved lock map still pass validation (sanitizeLocked
// rewrites it on read into the per-list keys).
export const lockedSchema = z.object({
  ...optionalBooleanMap(LOCKABLE_FIELDS),
  influences: z.boolean().optional(),
}).strict();

const influenceEntrySchema = z.string().trim().min(1).max(INFLUENCE_ENTRY_MAX);

export const influencesSchema = z.object({
  embrace: z.array(influenceEntrySchema).max(INFLUENCES_PER_LIST_MAX).optional().default([]),
  avoid: z.array(influenceEntrySchema).max(INFLUENCES_PER_LIST_MAX).optional().default([]),
}).strict();

const styleReferenceSchema = z.object({
  id: entryIdField,
  title: z.string().trim().min(1).max(STYLE_REFERENCE_TITLE_MAX),
  prompt: z.string().trim().min(1).max(STYLE_REFERENCE_PROMPT_MAX),
  imageRefs: z.array(entryImageRefField).min(1).max(1),
  createdAt: z.string().trim().min(1).max(64).optional(),
}).strict();

const styleReferencesField = z.array(styleReferenceSchema).max(STYLE_REFERENCES_MAX).optional();

// Legacy prose prompts: the v2 universe template carried `stylePrompt` /
// `negativePrompt` as comma-separated prose strings; v3 collapses them into
// the chip-based `influences` lists. Accepting them here (as optional) lets
// a stale client (or an importer of a v2 share-bucket payload) hand us the
// legacy shape — the service-layer sanitizer splits + merges the tokens into
// influences. New callers should send `influences` directly.
const legacyStylePromptField = z.string().trim().max(PROMPT_FRAGMENT_MAX).optional();

const legacyNegativePromptField = z.string().trim().max(PROMPT_FRAGMENT_MAX).optional();

// Canon arrays go through `sanitizeBibleList` in the service layer where
// each entry is validated structurally — accept them loosely here so
// patch-the-whole-list flows (e.g. inline canon edits, render-ref hooks)
// don't fail Zod for legitimately rich shapes. Cap at the bible-wide entry
// limit so a malicious payload can't blow up memory.
// Hard cap mirrors BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX (200) with headroom
// — sanitizer truncates anyway, so this just protects the JSON-parse layer.
const canonArrayField = z.array(z.record(z.unknown())).max(500).optional();

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
const imageSourceSchema = z.object({
  source: z.enum(['upload', 'gallery']),
  filename: z.string().trim().min(1).max(300),
});

export const universeCreateSchema = z.object({
  name: z.string().trim().min(1).max(NAME_MAX_LENGTH),
  starterPrompt: z.string().trim().max(STARTER_PROMPT_MAX).optional().default(''),
  stylePrompt: legacyStylePromptField,
  negativePrompt: legacyNegativePromptField,
  logline: z.string().trim().max(LOGLINE_MAX).optional().default(''),
  premise: z.string().trim().max(PREMISE_MAX).optional().default(''),
  styleNotes: z.string().trim().max(STYLE_NOTES_MAX).optional().default(''),
  // Linked mood board pointer (#4188) — null/'' clears, absent preserves.
  moodBoardId: z.string().trim().max(MOOD_BOARD_ID_MAX).nullable().optional(),
  categories: categoriesSchema.optional(),
  compositeSheets: z.array(compositeSheetSchema).max(COMPOSITE_SHEETS_MAX).optional(),
  influences: influencesSchema.optional(),
  visualProfile: universeVisualProfileSchema.nullable().optional(),
  styleReferences: styleReferencesField,
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
  // Per-record render pin (#3231 Phase 3) — this universe's default image
  // backend + cloud model.
  ...recordRenderPinFields,
  // Factual/fiction axis (#7616) — true marks a real-world universe.
  factual: z.boolean().optional(),
  // Local-only "don't sync to peers" marker — see sanitizeRecordForWire.
  ephemeral: z.boolean().optional(),
});

// `origin` is a share-bucket provenance block written by the importer + cleared
// to null by the user; structurally an object or null.
const originField = z.record(z.unknown()).nullable().optional();

export const universePatchSchema = z.object({
  name: z.string().trim().min(1).max(NAME_MAX_LENGTH).optional(),
  starterPrompt: z.string().trim().max(STARTER_PROMPT_MAX).optional(),
  // Legacy prose prompts — see legacy*Field comment above. Tolerated on PATCH
  // so a stale client tab can still save while the new chip-based UI lands.
  stylePrompt: legacyStylePromptField,
  negativePrompt: legacyNegativePromptField,
  logline: z.string().trim().max(LOGLINE_MAX).optional(),
  premise: z.string().trim().max(PREMISE_MAX).optional(),
  styleNotes: z.string().trim().max(STYLE_NOTES_MAX).optional(),
  // Linked mood board pointer (#4188) — null/'' clears, absent preserves.
  moodBoardId: z.string().trim().max(MOOD_BOARD_ID_MAX).nullable().optional(),
  categories: categoriesSchema.optional(),
  // Full-map save: `categories` replaces the persisted map (so a deleted custom
  // bucket stays deleted) instead of the default per-key union. Partial
  // callers omit it and keep the merge.
  replaceCategories: z.boolean().optional(),
  compositeSheets: z.array(compositeSheetSchema).max(COMPOSITE_SHEETS_MAX).optional(),
  influences: influencesSchema.optional(),
  visualProfile: universeVisualProfileSchema.nullable().optional(),
  styleReferences: styleReferencesField,
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
  // Per-record render pin (#3231 Phase 3). Key-present with 'auto'/''/null
  // clears; key-absent preserves.
  ...recordRenderPinFields,
  // Factual/fiction axis (#7616). Only a literal `true` marks the universe
  // factual; `false` clears it back to absent (see sanitizeTemplate).
  factual: z.boolean().optional(),
  ephemeral: z.boolean().optional(),
}).refine((p) => Object.keys(p).length > 0, { message: 'patch must include at least one field' });

export const universeRestoreStarterSchema = z.object({
  expectedUpdatedAt: z.string().datetime(),
});

export const markdownImportSchema = z.object({
  markdown: z.string().trim().min(1).max(10_000_000),
}).strict();

export const markdownUniversePatchSchema = z.object({
  name: z.string().trim().min(1).max(NAME_MAX_LENGTH),
  logline: z.string().trim().max(LOGLINE_MAX).optional(),
  premise: z.string().trim().max(PREMISE_MAX).optional(),
  styleNotes: z.string().trim().max(STYLE_NOTES_MAX).optional(),
  categories: categoriesSchema.optional(),
  influences: influencesSchema.optional(),
  visualProfile: universeVisualProfileSchema.nullable().optional(),
  characters: canonArrayField,
  places: canonArrayField,
  objects: canonArrayField,
}).strict();

export const expandSchema = z.object({
  starterPrompt: z.string().trim().min(1).max(STARTER_PROMPT_MAX),
  // Optional structured influences from a prior refinement — passed in so
  // the LLM keeps re-expansions on-direction instead of regenerating from
  // the bare starter idea.
  influences: influencesSchema.optional(),
  // Per-item locks the user has set on individual variations / composite
  // boards. Listed in the LLM prompt so it doesn't waste tokens regenerating
  // them; the client merges them back in after the result returns.
  preservedVariations: z.record(
    z.string().trim().min(1).max(WORLD_CATEGORY_KEY_MAX),
    z.array(variationSchema).max(VARIATIONS_PER_CATEGORY_MAX),
  ).optional(),
  preservedCompositeSheets: z.array(compositeSheetSchema).max(COMPOSITE_SHEETS_MAX).optional(),
  // Current bible/prompt state — locked entries are echoed verbatim, others
  // are starting points the LLM can refine while staying consistent.
  logline: z.string().trim().max(LOGLINE_MAX).optional(),
  premise: z.string().trim().max(PREMISE_MAX).optional(),
  styleNotes: z.string().trim().max(STYLE_NOTES_MAX).optional(),
  locked: lockedSchema.optional(),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
});

// `targetKind` is only required when the source bucket's `kind` is 'other'
// (otherwise the service resolves it from the bucket). Enum derived from
// BIBLE_KEYS so the schema and the resolver share one source.
export const promoteVariationSchema = z.object({
  category: z.string().trim().min(1).max(WORLD_CATEGORY_KEY_MAX),
  label: z.string().trim().min(1).max(VARIATION_LABEL_MAX),
  targetKind: z.enum(BIBLE_KEYS).optional(),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
});

// Auto-sort takes no bucket selection — the service scans for every
// `kind: 'other'` bucket on the universe. Provider/model are optional;
// the service falls back to the active provider when omitted.
export const autoSortSchema = z.object({
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
});

export const generateVariationsSchema = z.object({
  category: z.string().trim().min(1).max(WORLD_CATEGORY_KEY_MAX),
  count: z.number().int().min(1).max(VARIATIONS_PER_CATEGORY_MAX),
  existingLabels: z.array(z.string().trim().min(1).max(VARIATION_LABEL_MAX))
    .max(VARIATIONS_PER_CATEGORY_MAX).optional().default([]),
  influences: influencesSchema.optional(),
  logline: z.string().trim().max(LOGLINE_MAX).optional().default(''),
  premise: z.string().trim().max(PREMISE_MAX).optional().default(''),
  styleNotes: z.string().trim().max(STYLE_NOTES_MAX).optional().default(''),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
});

export const refinePromptsSchema = z.object({
  starterPrompt: z.string().trim().min(1).max(STARTER_PROMPT_MAX),
  // Bible context: passed in so the refiner sees the full seed, refines them
  // alongside the prompts, and stays consistent with the universe's narrative.
  logline: z.string().trim().max(LOGLINE_MAX).optional().default(''),
  premise: z.string().trim().max(PREMISE_MAX).optional().default(''),
  styleNotes: z.string().trim().max(STYLE_NOTES_MAX).optional().default(''),
  // Structured influences (embrace + avoid) — refined alongside the prompts
  // and used as the canonical reference list for renderer-token composition.
  influences: influencesSchema.optional(),
  // Post-Expand structure — when present, the refiner sees the full universe
  // (categories + composites with per-item locks) and may edit/replace/add
  // items per the user's feedback. When omitted (pre-Expand iteration), the
  // refiner falls back to the bible-only behavior.
  categories: categoriesSchema.optional(),
  compositeSheets: z.array(compositeSheetSchema).max(COMPOSITE_SHEETS_MAX).optional(),
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

export const universeMergeSchema = z.object({
  survivorId: z.string().trim().min(1).max(128),
  loserId: z.string().trim().min(1).max(128),
  fieldChoices: z.record(z.enum(['survivor', 'loser'])).optional().default({}),
  // Free-form per-field values that win over the survivor/loser binary —
  // populated by the AI-merge flow (a third unified option) and optionally
  // tweaked by the user before submit.
  fieldOverrides: z.record(z.string()).optional().default({}),
}).refine((b) => b.survivorId !== b.loserId, { message: 'survivor and loser must differ' });

export const universeMergeAIResolveSchema = z.object({
  survivorId: z.string().trim().min(1).max(128),
  loserId: z.string().trim().min(1).max(128),
  fields: z.array(z.string().trim().min(1).max(64)).min(1).max(20),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
}).refine((b) => b.survivorId !== b.loserId, { message: 'survivor and loser must differ' });

export const analyzeStyleReferenceSchema = z.object({
  image: z.string().trim().min(1).max(300),
  title: z.string().trim().max(STYLE_REFERENCE_TITLE_MAX).optional(),
  prompt: z.string().trim().max(STYLE_REFERENCE_PROMPT_MAX).optional(),
  styleNotes: z.string().trim().max(STYLE_NOTES_MAX).optional().default(''),
  influences: influencesSchema.optional().default({ embrace: [], avoid: [] }),
  locked: lockedSchema.optional().default({}),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
});

// Add/remove one reference at a time instead of PATCHing the whole array; see
// `addStyleReference` in services/universeBuilder/crud.js for the rationale.
// The wholesale-replace `{ styleReferences: [...] }` field on PATCH /:id stays
// accepted (older clients, peer imports, the sharing importer).
export const addStyleReferenceSchema = z.object({
  // `id` is required here (unlike the wholesale-replace field, where the
  // sanitizer mints one): the id is what makes a re-sent add idempotent
  // server-side, and /analyze-style-reference always returns one. `required`
  // only drops the `.optional()` — the trim/length rules stay defined once, on
  // the shared `entryIdField`.
  reference: styleReferenceSchema.required({ id: true }),
  // Present when the user chose "Adopt style + add" — written in the SAME
  // queued write as the reference so the pair can't half-land. Both fields
  // default, so `adopt: {}` reads as "adopt an empty guide" (an explicit clear)
  // instead of reaching the service as `undefined` and clearing influences by
  // accident — matching analyzeStyleReferenceSchema's choice for the same pair.
  adopt: z.object({
    styleNotes: z.string().trim().max(STYLE_NOTES_MAX).optional().default(''),
    influences: influencesSchema.optional().default({ embrace: [], avoid: [] }),
  }).optional(),
});

// Adopt a style guide with NO reference record attached (#4188 Phase 4: the
// mood-board synthesis flow proposes styleNotes + influences from board
// content, not from a single image). Same queued-write semantics as the
// `adopt` half of the add-reference endpoint; locks are re-checked server-side
// against the freshest persisted record.
export const adoptStyleSchema = z.object({
  styleNotes: z.string().trim().max(STYLE_NOTES_MAX).optional().default(''),
  influences: influencesSchema.optional().default({ embrace: [], avoid: [] }),
}).strict();

// The id is only ever compared against stored reference ids (never used as a
// path/SQL operand), but validate it anyway so an absurdly long param is a 400
// here rather than a silent no-op deeper in.
export const removeStyleReferenceParamsSchema = z.object({
  referenceId: entryIdField.unwrap(),
});

export const extractCanonSchema = z.object({
  corpus: z.string().trim().min(1).max(200_000),
  kinds: z.array(z.enum(BIBLE_KINDS)).max(BIBLE_KINDS.length).optional(),
  parallel: z.boolean().optional(),
  providerOverride: z.string().trim().max(64).optional(),
});

export const refineCharSchema = z.object({
  providerId: z.string().trim().max(64).optional(),
  model: z.string().trim().max(128).optional(),
});

// ── Cast integrity (#6415) ───────────────────────────────────────────────
// Character ids the caller wants scoped. Omitted entirely = the whole cast;
// an explicit `[]` is an empty selection and reviews nobody. The two are
// deliberately different answers, so the schema must not default it to [].
export const castScopeSchema = z.object({
  characterIds: z.array(z.string().trim().min(1).max(120)).max(500).optional(),
  providerId: z.string().trim().max(64).optional(),
  model: z.string().trim().max(128).optional(),
});

// DETERMINISTIC integrity report — no provider call, safe on page load. Also
// returns `reviewScope` (provider / model / batch size) so the UI can name what
// a semantic review would spend BEFORE the user opts into it.
export const castIntegrityQuerySchema = z.object({ characterIds: z.string().optional() });

// Lock toggle for canon entries. Locked entries are protected from AI rewrite
// paths (refine, differentiate, re-extract field overwrites).
export const setLockSchema = z.object({
  locked: z.boolean(),
});

// Rich canon fields use the same service sanitizer as whole-array PATCHes.
// Identity comes from the URL and cannot be changed by a field edit.
export const entryPatchSchema = z.record(z.unknown()).refine(patch => !Object.hasOwn(patch, 'id'), {
  message: 'Canon entry identity cannot be edited',
});

// Remove ONE reference image from a canon entry. PATCH can't do this: the
// stale-write guard (`preserveImageRefsById`) restores any shorter imageRefs
// list. The image file stays in the gallery.
export const imageRefParamsSchema = lockParamsSchema.extend({
  filename: z.string().trim().min(1).max(512),
});

// `selection` per category: 'all' or array of variation labels.
const selectionValueSchema = z.union([z.literal('all'), z.array(z.string().trim().min(1).max(VARIATION_LABEL_MAX)).max(VARIATIONS_PER_CATEGORY_MAX)]);

const selectionSchema = z.record(
  z.string().trim().min(1).max(WORLD_CATEGORY_KEY_MAX),
  selectionValueSchema,
).refine((selection) => Object.keys(selection).length <= WORLD_CATEGORY_COUNT_MAX, {
  message: `selection cannot exceed ${WORLD_CATEGORY_COUNT_MAX} buckets`,
});

// `canonSelection` per trunk: 'all' or array of canon-entry names (case-insensitive).
// Settings entries also match on `slugline` so a render queued from the Places
// tab can target an entry the user filed by slugline ("INT. FOUNDRY — DAY").
// Per-trunk cap mirrors the bible sanitizer (`ENTRIES_PER_BIBLE_MAX`) so this
// can't enqueue more entries than the server actually persists; per-string cap
// uses the looser of `NAME_MAX` / `SLUGLINE_MAX` so a places entry filed by
// slugline isn't rejected if those limits ever diverge (both 200 today).
const CANON_NEEDLE_MAX = Math.max(BIBLE_LIMITS.NAME_MAX, BIBLE_LIMITS.SLUGLINE_MAX);

const canonSelectionValueSchema = z.union([
  z.literal('all'),
  z.array(z.string().trim().min(1).max(CANON_NEEDLE_MAX)).max(BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX),
]);

const canonSelectionSchema = z.object(
  Object.fromEntries(BIBLE_KEYS.map((k) => [k, canonSelectionValueSchema.optional()])),
).strict();

export const universeRenderSchema = z.object({
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
  // Per-batch cloud model override (#3231 Phase 3) — wins over the universe's
  // persisted imageModelId pin and the renderDefaults imageModel pin. Shares
  // the model-id charset guard so a bad id can't reach a CLI argv.
  cloudModel: cloudModelIdString('cloudModel must be a valid model id').max(RECORD_RENDER_MODEL_MAX).optional(),
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
  sheetSelection: z.union([z.literal('all'), z.array(z.string().trim().min(1).max(VARIATION_LABEL_MAX)).max(COMPOSITE_SHEETS_MAX)]).optional(),
  canonSelection: canonSelectionSchema.optional(),
  // Per-batch overrides surfaced through the full Image-Gen form. All optional;
  // empty values are treated as "use the universe's existing influences."
  // `seed` matches /api/image-gen/generate's contract (non-negative integer) —
  // local image gen coerces via Number(seed) and would yield NaN for arbitrary
  // strings, so reject early at the boundary.
  seed: z.number().int().min(0).optional(),
  negativePrompt: z.string().trim().max(PROMPT_FRAGMENT_MAX).optional(),
  extraStyle: z.string().trim().max(PROMPT_FRAGMENT_MAX).optional(),
  stylePresetId: z.string().trim().max(80).optional(),
  visualProfileOverride: universeVisualProfileSchema.nullable().optional(),
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

export const describeFromImagesSchema = z.object({
  kind: z.enum(BIBLE_KINDS),
  name: z.string().trim().max(BIBLE_LIMITS.NAME_MAX).optional(),
  context: z.string().trim().max(2000).optional(),
  images: z.array(imageSourceSchema).min(1).max(VISION_MAX_IMAGES),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
});

export const expandFromImagesSchema = z.object({
  name: z.string().trim().max(BIBLE_LIMITS.NAME_MAX).optional(),
  context: z.string().trim().max(2000).optional(),
  images: z.array(imageSourceSchema).min(1).max(VISION_EXPAND_MAX_IMAGES),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
});

export const correctFromImageSchema = z.object({
  image: z.string().trim().min(1).max(300),
  name: z.string().trim().max(BIBLE_LIMITS.NAME_MAX).optional(),
  context: z.string().trim().max(2000).optional(),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
});

// Cap at the largest per-kind descriptor limit (DESC_LIMIT) rather
// than the unrelated NOTES_MAX — applyCanonImageCorrection silently trims to
// the per-kind limit before persisting, so a looser schema cap here would let
// a request pass validation only to have its tail silently dropped on write.
export const applyImageCorrectionSchema = z.object({
  description: z.string().trim().min(1).max(Math.max(...Object.values(DESC_LIMIT))),
  imageFilename: z.string().trim().min(1).max(300),
});
