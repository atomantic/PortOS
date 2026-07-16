/**
 * Creative Commission routes — REST CRUD for the Autonomous Creation Engine
 * (#2657, Phase 1). A commission is a standing, recurring creative brief the
 * scheduler fires on a cadence. The scheduler re-arms crons off the store's
 * `commission:changed` event (emitted by every create/update/delete), so the
 * route stays decoupled from the scheduler graph and non-REST writers re-sync
 * too — the same seam seriesAutopilotScheduler uses for `settings:updated`.
 *
 * No try/catch — errors bubble to the centralized error middleware. Service
 * errors carry a `code` mapped to an HTTP status via createServiceErrorMapper.
 */

import { Router } from 'express';
import { asyncHandler, createServiceErrorMapper } from '../lib/errorHandler.js';
import {
  validateRequest,
  creativeCommissionCreateSchema,
  creativeCommissionUpdateSchema,
  commissionFeedbackSchema,
  isPaginationRequested,
  paginateArray,
} from '../lib/validation.js';
import * as svc from '../services/creativeCommissions/store.js';

const router = Router();

const SERVICE_ERROR_STATUS = {
  [svc.ERR_NOT_FOUND]: 404,
  [svc.ERR_VALIDATION]: 400,
};
const mapServiceError = createServiceErrorMapper(SERVICE_ERROR_STATUS);

router.get('/', asyncHandler(async (req, res) => {
  const items = await svc.listCommissions();
  if (!isPaginationRequested(req.query)) return res.json(items);
  res.json(paginateArray(items, req.query, { defaultLimit: 50, maxLimit: 500 }));
}));

router.post('/', asyncHandler(async (req, res) => {
  const body = validateRequest(creativeCommissionCreateSchema, req.body ?? {});
  const created = await svc.createCommission(body).catch((err) => { throw mapServiceError(err); });
  res.status(201).json(created);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const rec = await svc.getCommission(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(rec);
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const body = validateRequest(creativeCommissionUpdateSchema, req.body ?? {});
  const rec = await svc.updateCommission(req.params.id, body).catch((err) => { throw mapServiceError(err); });
  res.json(rec);
}));

// Rate/annotate a specific run's output (#2657, Phase 2). The reaction is folded
// into the next scheduled fire's directive via buildCommissionDirective. Returns
// the full updated commission so the client updates its feedback state reactively.
router.post('/:id/feedback', asyncHandler(async (req, res) => {
  const body = validateRequest(commissionFeedbackSchema, req.body ?? {});
  const rec = await svc.submitCommissionFeedback(req.params.id, body).catch((err) => { throw mapServiceError(err); });
  res.status(201).json(rec);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const r = await svc.deleteCommission(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(r);
}));

export default router;
