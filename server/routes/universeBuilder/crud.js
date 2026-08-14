/**
 * Universe CRUD — list/create/read/update/delete, the style-token lookup, the
 * per-universe run history, and the bulk variation lock toggle.
 *
 * `GET /styles` is declared ahead of `GET /:id` in this file so the wildcard
 * doesn't swallow it; every OTHER static top-level path lives in a sub-router
 * mounted BEFORE this one (see index.js).
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/errorHandler.js';
import { validateRequest, llmSchema, isPaginationRequested, paginateArray } from '../../lib/validation.js';
import { recordRenderPinFields } from '../../lib/sharedSchemas.js';
import { pruneStaleReferenceSheets } from '../../lib/storyBible.js';
import * as svc from '../../services/universeBuilder.js';
import { findSameNameUniverses } from '../../services/duplicateDetection.js';
import {
  mapServiceError,
  entryImageRefsField,
  compositeSheetSchema,
  categoriesSchema,
  lockedSchema,
  influencesSchema,
  styleReferencesField,
  legacyStylePromptField,
  legacyNegativePromptField,
  canonArrayField,
} from './shared.js';

const router = Router();

const createSchema = z.object({
  name: z.string().trim().min(1).max(svc.NAME_MAX_LENGTH),
  starterPrompt: z.string().trim().max(svc.STARTER_PROMPT_MAX).optional().default(''),
  stylePrompt: legacyStylePromptField,
  negativePrompt: legacyNegativePromptField,
  logline: z.string().trim().max(svc.LOGLINE_MAX).optional().default(''),
  premise: z.string().trim().max(svc.PREMISE_MAX).optional().default(''),
  styleNotes: z.string().trim().max(svc.STYLE_NOTES_MAX).optional().default(''),
  // Linked mood board pointer (#4188) — null/'' clears, absent preserves.
  moodBoardId: z.string().trim().max(svc.MOOD_BOARD_ID_MAX).nullable().optional(),
  categories: categoriesSchema.optional(),
  compositeSheets: z.array(compositeSheetSchema).max(svc.COMPOSITE_SHEETS_MAX).optional(),
  influences: influencesSchema.optional(),
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
  // Linked mood board pointer (#4188) — null/'' clears, absent preserves.
  moodBoardId: z.string().trim().max(svc.MOOD_BOARD_ID_MAX).nullable().optional(),
  categories: categoriesSchema.optional(),
  compositeSheets: z.array(compositeSheetSchema).max(svc.COMPOSITE_SHEETS_MAX).optional(),
  influences: influencesSchema.optional(),
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
  ephemeral: z.boolean().optional(),
}).refine((p) => Object.keys(p).length > 0, { message: 'patch must include at least one field' });

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

// Style tokens only (see svc.listUniverseStyles). Must stay ahead of `/:id` so
// the wildcard doesn't catch "styles" as a universe id.
router.get('/styles', asyncHandler(async (_req, res) => {
  res.json(await svc.listUniverseStyles());
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
