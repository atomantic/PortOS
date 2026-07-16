/**
 * Creative Commission routes — REST CRUD for the Autonomous Creation Engine
 * (#2657, Phase 1). A commission is a standing, recurring creative brief the
 * scheduler fires on a cadence. After any mutation we re-sync the scheduler so a
 * newly enabled/edited/deleted commission's cron takes effect immediately.
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
  isPaginationRequested,
  paginateArray,
} from '../lib/validation.js';
import * as svc from '../services/creativeCommissions/store.js';
import { syncCommissionSchedules } from '../services/creativeCommissions/scheduler.js';

const router = Router();

const SERVICE_ERROR_STATUS = {
  [svc.ERR_NOT_FOUND]: 404,
  [svc.ERR_VALIDATION]: 400,
};
const mapServiceError = createServiceErrorMapper(SERVICE_ERROR_STATUS);

// Fire-and-forget scheduler re-sync after a mutation — the HTTP response doesn't
// wait on it, and a re-sync failure must not fail the request.
function resyncScheduler() {
  syncCommissionSchedules().catch((err) =>
    console.error(`❌ Creative commission schedule re-sync failed: ${err.message}`));
}

router.get('/', asyncHandler(async (req, res) => {
  const items = await svc.listCommissions();
  if (!isPaginationRequested(req.query)) return res.json(items);
  res.json(paginateArray(items, req.query, { defaultLimit: 50, maxLimit: 500 }));
}));

router.post('/', asyncHandler(async (req, res) => {
  const body = validateRequest(creativeCommissionCreateSchema, req.body ?? {});
  const created = await svc.createCommission(body).catch((err) => { throw mapServiceError(err); });
  resyncScheduler();
  res.status(201).json(created);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const rec = await svc.getCommission(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(rec);
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const body = validateRequest(creativeCommissionUpdateSchema, req.body ?? {});
  const rec = await svc.updateCommission(req.params.id, body).catch((err) => { throw mapServiceError(err); });
  resyncScheduler();
  res.json(rec);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const r = await svc.deleteCommission(req.params.id).catch((err) => { throw mapServiceError(err); });
  resyncScheduler();
  res.json(r);
}));

export default router;
