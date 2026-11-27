/**
 * Duplicate resolution: the duplicate-group scan plus the merge preview /
 * commit / AI field-resolution trio.
 *
 * All static top-level paths — this router mounts BEFORE crud.js so `/:id`
 * can't swallow `/duplicates`.
 */

import { Router } from 'express';
import { asyncHandler } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validateRequest.js';
import { universeMergeSchema, universeMergeAIResolveSchema } from '../../lib/universeBuilderValidation.js';
import * as svc from '../../services/universeBuilder.js';
import { findDuplicateUniverseGroups } from '../../services/duplicateDetection.js';
import { mergeUniverses } from '../../services/recordMerge.js';
import { mergeFieldsWithAI } from '../../services/recordMergeAI.js';
import { mapServiceError } from './shared.js';

const router = Router();

router.get('/duplicates', asyncHandler(async (_req, res) => {
  res.json({ groups: await findDuplicateUniverseGroups() });
}));

router.post('/merge/preview', asyncHandler(async (req, res) => {
  const body = validateRequest(universeMergeSchema, req.body ?? {});
  const preview = await mergeUniverses(body.survivorId, body.loserId, body.fieldChoices, { dryRun: true, fieldOverrides: body.fieldOverrides })
    .catch((err) => { throw mapServiceError(err); });
  res.json(preview);
}));

router.post('/merge', asyncHandler(async (req, res) => {
  const body = validateRequest(universeMergeSchema, req.body ?? {});
  const result = await mergeUniverses(body.survivorId, body.loserId, body.fieldChoices, { fieldOverrides: body.fieldOverrides })
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Ask the configured AI provider to merge specific conflicting text fields
// into a single unified value per field. Returns `{ merged, skipped, llm, runId }`
// — the client applies `merged` as `fieldOverrides` on the subsequent
// /merge or /merge/preview call. No record state is mutated here.
router.post('/merge/ai-resolve', asyncHandler(async (req, res) => {
  const body = validateRequest(universeMergeAIResolveSchema, req.body ?? {});
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

export default router;
