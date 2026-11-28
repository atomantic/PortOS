/**
 * Batch render — enqueue image-gen jobs for a universe's variations,
 * composite sheets, and/or canon entries.
 *
 * Scoped under `/:id`, so mount order relative to crud.js doesn't matter.
 */

import { Router } from 'express';
import { asyncHandler } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validateRequest.js';
import { universeRenderSchema } from '../../lib/universeBuilderValidation.js';
import * as svc from '../../services/universeBuilder.js';
import { renderUniverseJobs } from '../../services/universeBuilderRender.js';
import { mapServiceError } from './shared.js';

const router = Router();

router.post('/:id/render', asyncHandler(async (req, res) => {
  const body = validateRequest(universeRenderSchema, req.body ?? {});
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
