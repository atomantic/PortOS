/**
 * Seed the new `network-exposure` dashboard widget into built-in layouts
 * for installs that already have a persisted `data/dashboard-layouts.json`.
 *
 * Background:
 *   `server/services/dashboardLayouts.js#DEFAULT_LAYOUTS` lists the built-in
 *   layouts shipped with PortOS. `getState()` returns the sanitized persisted
 *   layouts whenever the file exists, so adding a new widget to a built-in
 *   layout in code only affects fresh installs — existing users never see it.
 *
 *   This migration walks `data/dashboard-layouts.json`, finds the built-in
 *   `default` (Everything) and `ops` layouts by id, and inserts
 *   `network-exposure` into their `widgets` list + an explicit `grid` entry,
 *   matching the geometry seeded server-side. User-renamed copies and custom
 *   layouts are not touched (idempotent — re-runs detect the widget is
 *   already present and skip).
 *
 *   Layouts that were explicitly removed from the file (e.g. user deleted
 *   the `ops` layout) stay absent — `dashboardLayouts.js` re-seeds them on
 *   read if every built-in is gone, but a single deleted built-in doesn't
 *   come back.
 */

import { readLayoutsDoc, writeLayoutsDoc } from './_lib.js';

const WIDGET_ID = 'network-exposure';
const WIDGET_W = 3;
const WIDGET_H = 5;

// Mirror of the geometry chosen in `server/services/dashboardLayouts.js`
// DEFAULT_LAYOUTS. Edits here must match that file or fresh installs +
// migrated installs will diverge — when the preferred slot is clear.
const PREFERRED_SLOTS = {
  default: { x: 9, y: 10 },
  ops:     { x: 3, y: 5 },
};

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function collidesWith(grid, candidate) {
  for (const item of grid) {
    if (rectsOverlap(item, candidate)) return true;
  }
  return false;
}

// Place the widget at the preferred (x, y) when free. If a user-rearranged
// layout already occupies that cell, fall back to appending below every
// existing item at x=0 so the new widget never overlaps user content. The
// user can drag it back to the preferred slot via the dashboard's
// Arrange button.
function pickGridEntry(grid, layoutId) {
  const preferred = PREFERRED_SLOTS[layoutId];
  if (preferred) {
    const candidate = { id: WIDGET_ID, x: preferred.x, y: preferred.y, w: WIDGET_W, h: WIDGET_H };
    if (!collidesWith(grid, candidate)) return candidate;
  }
  const bottom = grid.reduce((max, it) => Math.max(max, (it.y ?? 0) + (it.h ?? 0)), 0);
  return { id: WIDGET_ID, x: 0, y: bottom, w: WIDGET_W, h: WIDGET_H };
}

function applyToLayout(layout) {
  if (!layout || typeof layout !== 'object') return false;
  if (!Array.isArray(layout.widgets)) return false;
  if (layout.widgets.includes(WIDGET_ID)) return false;
  layout.widgets = [...layout.widgets, WIDGET_ID];
  if (Array.isArray(layout.grid)) {
    layout.grid = [...layout.grid, pickGridEntry(layout.grid, layout.id)];
  }
  return true;
}

export default {
  async up({ rootDir }) {
    const result = await readLayoutsDoc({ rootDir, label: 'migration 029' });
    if (!result.ok) return { updated: 0, reason: result.reason };
    const { doc, path } = result;

    let touched = 0;
    for (const layout of doc.layouts) {
      if (!layout || (layout.id !== 'default' && layout.id !== 'ops')) continue;
      if (applyToLayout(layout)) touched += 1;
    }

    if (touched === 0) {
      console.log(`📦 migration 029: network-exposure already present in built-in layouts.`);
      return { updated: 0, reason: 'already-applied' };
    }

    await writeLayoutsDoc(path, doc);
    console.log(`📦 migration 029: seeded network-exposure widget into ${touched} built-in layout(s).`);
    return { updated: touched };
  },
};
