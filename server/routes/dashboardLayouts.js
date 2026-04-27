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
const idSchema = z.string().trim().min(1).max(svc.ID_MAX_LENGTH).regex(svc.ID_PATTERN, 'id must be lowercase kebab');

// Grid items carry per-widget x/y/w/h so the dashboard can render a
// free-form layout. Bounds mirror the service-layer sanitizeGridItem so
// reads and writes agree by construction. The route enforces structural
// validity here; cross-field invariants (id ∈ widgets, dedup, x+w ≤ cols)
// are enforced by the .refine() on layoutSchema below and the service.
const gridItemSchema = z.object({
  id: z.string().trim().min(1).max(svc.WIDGET_ID_MAX_LENGTH),
  x: z.number().int().min(0).max(svc.GRID_COLS - 1),
  y: z.number().int().min(0).max(svc.GRID_ROW_MAX),
  w: z.number().int().min(1).max(svc.GRID_COLS),
  h: z.number().int().min(1).max(svc.GRID_ITEM_H_MAX),
});

const layoutSchema = z.object({
  id: idSchema,
  // Trim before min-length check so whitespace-only names are rejected.
  name: z.string().trim().min(1).max(svc.NAME_MAX_LENGTH),
  // Trim each widget id before length + uniqueness checks so "apps " can't
  // slip past dedup and land as a no-op entry that the client registry
  // skips. Matches the service-layer sanitize() on read.
  widgets: z
    .array(z.string().trim().min(1).max(svc.WIDGET_ID_MAX_LENGTH))
    .max(svc.WIDGETS_MAX)
    .refine((w) => new Set(w).size === w.length, { message: 'widgets must be unique' }),
  // Optional — older clients (and pre-migration layouts) post no `grid` and
  // the dashboard auto-flows widgets. When present, grid items must:
  //   1. reference a widget that's in the `widgets` list (no orphans),
  //   2. be unique by id (one position per widget), and
  //   3. fit horizontally (x + w ≤ GRID_COLS).
  grid: z
    .array(gridItemSchema)
    .max(svc.WIDGETS_MAX)
    .optional()
    .default([]),
}).refine(
  (l) => l.grid.every((g) => l.widgets.includes(g.id)),
  { message: 'grid items must reference widgets in the layout', path: ['grid'] }
).refine(
  (l) => new Set(l.grid.map((g) => g.id)).size === l.grid.length,
  { message: 'grid items must be unique by id', path: ['grid'] }
).refine(
  (l) => l.grid.every((g) => g.x + g.w <= svc.GRID_COLS),
  { message: 'grid item x+w must fit in cols', path: ['grid'] }
);

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
