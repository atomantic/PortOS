/**
 * Universe CRUD — list/create/read/update/delete, the style-token lookup, the
 * per-universe run history, and the bulk variation lock toggle.
 *
 * `GET /styles` is declared ahead of `GET /:id` in this file so the wildcard
 * doesn't swallow it; every OTHER static top-level path lives in a sub-router
 * mounted BEFORE this one (see index.js).
 */

import { Router } from 'express';
import { universeStarterPatch } from '../../lib/universeStarters.js';
import { ServerError, asyncHandler } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validateRequest.js';
import {
  universeCreateSchema,
  universePatchSchema,
  universeRestoreStarterSchema,
} from '../../lib/universeBuilderValidation.js';
import { paginationQuerySchema, isPaginationRequested, paginateArray } from '../../lib/queryValidation.js';
import { pruneStaleReferenceSheets } from '../../lib/storyBible.js';
import * as svc from '../../services/universeBuilder.js';
import { findSameNameUniverses } from '../../services/duplicateDetection.js';
import { mapServiceError } from './shared.js';

const router = Router();

// Backward-compatible by default: returns the full universes array. When a client
// passes `limit`/`offset`, the response becomes the bounded
// `{ items, total, limit, offset }` envelope every paginated PortOS list shares.
router.get('/', asyncHandler(async (req, res) => {
  // Validate before the store read: a malformed query is a 400 whatever state the store is in (#16428).
  const query = validateRequest(paginationQuerySchema, req.query);
  const universes = await svc.listUniverses();
  if (!isPaginationRequested(query)) {
    return res.json(universes);
  }
  res.json(paginateArray(universes, query, { defaultLimit: 50, maxLimit: 500 }));
}));

router.post('/', asyncHandler(async (req, res) => {
  const body = validateRequest(universeCreateSchema, req.body ?? {});
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

router.get('/names', asyncHandler(async (_req, res) => {
  res.json(await svc.listUniverseNames());
}));

router.get('/summaries', asyncHandler(async (_req, res) => {
  res.json(await svc.listUniverseSummaries());
}));

// Revision check runs inside the record queue so a concurrent edit is preserved.
router.post('/:id/restore-starter', asyncHandler(async (req, res) => {
  const patch = universeStarterPatch(req.params.id);
  if (!patch) throw new ServerError('No shipped starter exists for this universe', { status: 404 });
  const { expectedUpdatedAt } = validateRequest(universeRestoreStarterSchema, req.body ?? {});
  const restored = await svc.updateUniverse(req.params.id, (latest) => {
    if (latest.updatedAt !== expectedUpdatedAt) {
      throw new ServerError('Universe changed. Reload it before restoring the starter.', { status: 409 });
    }
    return patch;
  }, { touchesCanon: false }).catch(err => { throw mapServiceError(err); });
  res.json(restored);
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
  const { replaceCategories, ...body } = validateRequest(universePatchSchema, req.body ?? {});
  const w = await svc.updateUniverse(req.params.id, body, { replaceCategories: replaceCategories === true }).catch((err) => { throw mapServiceError(err); });
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

export default router;
