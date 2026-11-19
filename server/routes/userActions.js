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
import { validateRequest } from '../lib/validateRequest.js';
import { listUserActions } from '../services/userActions.js';
import { userActionsListQuerySchema } from '../lib/userActionValidation.js';

const router = Router();

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
