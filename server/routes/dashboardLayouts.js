/**
 *   GET    /api/dashboard/layouts           → { activeLayoutId, layouts }
 *   PUT    /api/dashboard/layouts/active    → { activeLayoutId, layouts }  (body: { id })
 *   PUT    /api/dashboard/layouts/:id       → { activeLayoutId, layouts }
 *   DELETE /api/dashboard/layouts/:id       → { activeLayoutId, layouts }
 */

import { layoutSchema, setActiveSchema, dashboardLayoutParamsSchema } from '../lib/dashboardLayoutsValidation.js';
import { Router } from 'express';
import { asyncHandler, createServiceErrorMapper } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import * as svc from '../services/dashboardLayouts.js';

const router = Router();

// Map service error codes to HTTP statuses. Any other error (I/O, parse,
// write failures) bubbles through asyncHandler as 500 — do NOT collapse
// unknown errors into 404, that hides real server problems.
const SERVICE_ERROR_STATUS = {
  [svc.ERR_NOT_FOUND]: 404,
  [svc.ERR_BUILTIN_PROTECTED]: 400,
};

const mapServiceError = createServiceErrorMapper(SERVICE_ERROR_STATUS);

router.get('/', asyncHandler(async (_req, res) => {
  res.json(await svc.getState());
}));

router.put('/active', asyncHandler(async (req, res) => {
  const { id } = validateRequest(setActiveSchema, req.body ?? {});
  const state = await svc.setActiveLayout(id).catch((err) => { throw mapServiceError(err); });
  res.json(state);
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const body = validateRequest(layoutSchema, { ...(req.body ?? {}), id: req.params.id });
  res.json(await svc.saveLayout(body));
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const { id } = validateRequest(dashboardLayoutParamsSchema, req.params ?? {});
  const state = await svc.deleteLayout(id).catch((err) => { throw mapServiceError(err); });
  res.json(state);
}));

export default router;
