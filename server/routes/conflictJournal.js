/**
 * Conflict-journal routes — list/inspect/resolve the non-blocking edit-conflict
 * journal. Surfaced in the client's Sharing → Conflicts tab.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, createServiceErrorMapper } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { isBaseHashPersistBlocked } from '../lib/conflictJournal.js';
import * as resolver from '../services/conflictJournalResolver.js';

const router = Router();

const SERVICE_ERROR_STATUS = {
  [resolver.ERR_NOT_FOUND]: 404,
  [resolver.ERR_VALIDATION]: 400,
  // Target record was deleted since the conflict was archived — the entry is
  // still actionable via discard, so surface 409 rather than a generic 500.
  [resolver.ERR_TARGET_GONE]: 409,
};
const mapServiceError = createServiceErrorMapper(SERVICE_ERROR_STATUS);

// Entries are only ever 'pending' (on archive) or 'resolved' (after the user
// restores/merges/discards); there is no 'dismissed' state — discard resolves
// the entry and DELETE hard-removes it. Don't advertise a status the resolver
// never produces.
const listQuerySchema = z.object({
  status: z.enum(['pending', 'resolved']).optional(),
});

const resolveSchema = z.object({
  action: z.enum(['restore-all', 'merge-fields', 'discard']),
  fields: z.array(z.string().min(1).max(64)).max(50).optional(),
});

router.get('/', asyncHandler(async (req, res) => {
  const { status } = validateRequest(listQuerySchema, req.query ?? {});
  // #7260: while the sync base-hash file is present-but-unreadable the store is
  // latched — persistence is off and every overwrite journals fail-closed.
  // Surface the degradation so an empty `conflicts` list can't be mistaken for
  // "no conflicts"; the Conflicts tab renders this as a warning banner.
  const degraded = await isBaseHashPersistBlocked();
  res.json({
    conflicts: await resolver.listConflicts({ status: status ?? null }),
    conflictDetection: degraded
      ? { degraded: true, reason: 'sync_base_hashes.json is present but unreadable — repair or delete it and restart' }
      : { degraded: false },
  });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const entry = await resolver.getConflict(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(entry);
}));

router.post('/:id/resolve', asyncHandler(async (req, res) => {
  const body = validateRequest(resolveSchema, req.body ?? {});
  const result = await resolver.resolveConflict(req.params.id, body).catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const result = await resolver.deleteConflict(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

export default router;
