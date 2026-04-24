/**
 *   GET    /api/dashboard/layouts           → { activeLayoutId, layouts }
 *   PUT    /api/dashboard/layouts/active    → { activeLayoutId, layouts }  (body: { id })
 *   PUT    /api/dashboard/layouts/:id       → { activeLayoutId, layouts }
 *   DELETE /api/dashboard/layouts/:id       → { activeLayoutId, layouts }
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import * as svc from '../services/dashboardLayouts.js';

const router = Router();

// Bounds are sourced from the service so sanitization on read and validation
// at the API boundary agree by construction.
const idSchema = z.string().min(1).max(svc.ID_MAX_LENGTH).regex(svc.ID_PATTERN, 'id must be lowercase kebab');

const layoutSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(svc.NAME_MAX_LENGTH),
  widgets: z
    .array(z.string().min(1).max(svc.WIDGET_ID_MAX_LENGTH))
    .max(svc.WIDGETS_MAX)
    .refine((w) => new Set(w).size === w.length, { message: 'widgets must be unique' }),
});

const setActiveSchema = z.object({
  id: idSchema,
});

// Map service error codes to HTTP statuses. Any other error (I/O, parse,
// write failures) bubbles through asyncHandler as 500 — do NOT collapse
// unknown errors into 404, that hides real server problems.
const SERVICE_ERROR_STATUS = {
  [svc.ERR_NOT_FOUND]: 404,
  [svc.ERR_BUILTIN_PROTECTED]: 400,
};

const mapServiceError = (err) => {
  const status = SERVICE_ERROR_STATUS[err?.code];
  if (status) return new ServerError(err.message, { status, code: err.code });
  return err;
};

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
  const { id } = validateRequest(z.object({ id: idSchema }), req.params ?? {});
  const state = await svc.deleteLayout(id).catch((err) => { throw mapServiceError(err); });
  res.json(state);
}));

export default router;
