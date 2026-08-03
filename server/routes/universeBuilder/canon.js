/**
 * Canon (Phase A of the Universe-as-canon refactor): prose extraction, the
 * per-character LLM refine/expand/differentiate operations, the read-only
 * cross-reference lookups, and the entry/kind lock toggles.
 *
 * Every path here is scoped under `/:id`, so mount order relative to crud.js
 * doesn't matter (no single-segment route can shadow these).
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validation.js';
import * as canonSvc from '../../services/universeCanon.js';
import { expandUniverseCharacter } from '../../services/universeCharacterExpand.js';
import { getUniverseCanonUsage, listLinkedSeriesNames } from '../../services/canonUsage.js';
import { mapServiceError, lockParamsSchema } from './shared.js';

const router = Router();

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

export default router;
