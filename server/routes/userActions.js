/**
 * Operator-action ledger read API (#5594, epic #5593).
 *
 * Read-only on purpose: rows are written at the mutation sites that produce them
 * (CoS task routes, agent feedback, on-demand trigger, settings save), never by
 * a client POST — an operator log a client can forge is not evidence of anything.
 *
 * Auth: no entry in `ALWAYS_PUBLIC_API_PATHS` and no `API_REGISTRY` public
 * prefix, so `authGate` covers these under the normal `/api/*` gate.
 */

import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { userActionsListQuerySchema, validateRequest } from '../lib/validation.js';
import { USER_ACTION_ACTORS, USER_ACTION_TYPES } from '../lib/userActionTypes.js';
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, listUserActions } from '../services/userActions.js';

const router = Router();

// GET /api/user-actions/types — the closed vocabulary, for a filter UI that must
// not hardcode a mirror of the server list.
router.get('/types', asyncHandler(async (_req, res) => {
  res.json({
    types: [...USER_ACTION_TYPES],
    actors: [...USER_ACTION_ACTORS],
    defaultLimit: DEFAULT_LIST_LIMIT,
    maxLimit: MAX_LIST_LIMIT,
  });
}));

// GET /api/user-actions — newest-first slice of the ledger.
router.get('/', asyncHandler(async (req, res) => {
  const query = validateRequest(userActionsListQuerySchema, req.query);
  const events = await listUserActions({
    ...query,
    // Query strings carry no booleans; absent stays absent so it means "either".
    success: query.success === undefined ? undefined : query.success === 'true',
  });
  res.json({ events });
}));

export default router;
