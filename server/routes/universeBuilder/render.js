/**
 * Batch render — enqueue image-gen jobs for a universe's variations,
 * composite sheets, and/or canon entries.
 *
 * Scoped under `/:id`, so mount order relative to crud.js doesn't matter.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/errorHandler.js';
import { validateRequest, cloudModelIdString } from '../../lib/validation.js';
import { RECORD_RENDER_MODEL_MAX } from '../../lib/renderTargets.js';
import { BIBLE_LIMITS } from '../../lib/storyBible.js';
import * as svc from '../../services/universeBuilder.js';
import { IMAGE_GEN_MODES } from '../../services/imageGen/modes.js';
import { renderUniverseJobs } from '../../services/universeBuilderRender.js';
import { mapServiceError } from './shared.js';

const router = Router();

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

export default router;
