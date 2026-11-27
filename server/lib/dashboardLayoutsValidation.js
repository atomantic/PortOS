// Zod request schemas for the dashboard layouts routes.

import { z } from 'zod';
import * as limits from './dashboardLayoutConstraints.js';

// Bounds are sourced from the service so sanitization on read and validation
// at the API boundary agree by construction.
const idSchema = z.string().trim().min(1).max(limits.ID_MAX_LENGTH).regex(limits.ID_PATTERN, 'id must be lowercase kebab');

// Grid items carry per-widget x/w columns plus an `order` (the reading and
// packing sequence — the dashboard's only vertical coordinate). Bounds mirror
// the service-layer sanitizeGridItem so reads and writes agree by
// construction. The route enforces structural validity here; cross-field
// invariants (id ∈ widgets, dedup, x+w ≤ cols) are enforced by the .refine()
// on layoutSchema below and the service.
const gridItemSchema = z.object({
  id: z.string().trim().min(1).max(limits.WIDGET_ID_MAX_LENGTH),
  x: z.number().int().min(0).max(limits.GRID_COLS - 1),
  w: z.number().int().min(1).max(limits.GRID_COLS),
  // Optional so a client that only knows the legacy `y` shape can still save;
  // the service resolves whichever is present into a dense sequence.
  order: z.number().int().min(0).max(limits.GRID_ORDER_MAX).optional(),
  // Legacy row position, accepted from pre-#4133 clients and converted on
  // read. Never written back.
  y: z.number().int().min(0).max(limits.GRID_LEGACY_Y_MAX).optional(),
  // First-paint / older-client fallback height in rows. Optional because the
  // rendered height comes from measuring the widget, not from this.
  h: z.number().int().min(1).max(limits.GRID_ITEM_H_MAX).optional(),
  // Set when the user pinned this cell's height by dragging it. Absent means
  // the dashboard sizes the cell to its content (and treats `h` as the
  // first-paint fallback) — see DashboardGrid.jsx.
  fixedH: z.boolean().optional(),
});

// Time-window strings (HH:MM, 24h). The route accepts `null` to clear an
// existing window — clients send `activateWindow: null` to remove the
// auto-activation. The service's sanitizer also drops malformed shapes on
// read so unknown fields can never sneak through.
const timeStringSchema = z.string().regex(limits.TIME_STRING_RE, 'must be HH:MM (24h)');

const activateWindowSchema = z.object({
  start: timeStringSchema,
  end: timeStringSchema,
}).refine((w) => w.start !== w.end, { message: 'start and end must differ' });

export const layoutSchema = z.object({
  id: idSchema,
  // Trim before min-length check so whitespace-only names are rejected.
  name: z.string().trim().min(1).max(limits.NAME_MAX_LENGTH),
  // Trim each widget id before length + uniqueness checks so "apps " can't
  // slip past dedup and land as a no-op entry that the client registry
  // skips. Matches the service-layer sanitize() on read.
  widgets: z
    .array(z.string().trim().min(1).max(limits.WIDGET_ID_MAX_LENGTH))
    .max(limits.WIDGETS_MAX)
    .refine((w) => new Set(w).size === w.length, { message: 'widgets must be unique' }),
  // Optional — older clients (and pre-migration layouts) post no `grid` and
  // the dashboard auto-flows widgets. When present, grid items must:
  //   1. reference a widget that's in the `widgets` list (no orphans),
  //   2. be unique by id (one position per widget), and
  //   3. fit horizontally (x + w ≤ GRID_COLS).
  grid: z
    .array(gridItemSchema)
    .max(limits.WIDGETS_MAX)
    .optional()
    .default([]),
  // Optional — when set, the dashboard auto-selects this layout on cold
  // load if the local clock falls in the window. `null` is the explicit
  // clear signal; `undefined` (key missing) preserves whatever's on disk.
  activateWindow: activateWindowSchema.nullable().optional(),
}).refine(
  (l) => l.grid.every((g) => l.widgets.includes(g.id)),
  { message: 'grid items must reference widgets in the layout', path: ['grid'] }
).refine(
  (l) => new Set(l.grid.map((g) => g.id)).size === l.grid.length,
  { message: 'grid items must be unique by id', path: ['grid'] }
).refine(
  (l) => l.grid.every((g) => g.x + g.w <= limits.GRID_COLS),
  { message: 'grid item x+w must fit in cols', path: ['grid'] }
);

export const setActiveSchema = z.object({
  id: idSchema,
});

export const dashboardLayoutParamsSchema = z.object({ id: idSchema });
