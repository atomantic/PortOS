/**
 * Seed the new `daily-driver` dashboard widget ("Daily Driver", issue #2666)
 * into the built-in `morning-review` layout for installs that already have a
 * persisted `data/dashboard-layouts.json`.
 *
 * Background:
 *   `server/services/dashboardLayouts.js#DEFAULT_LAYOUTS` only seeds when the
 *   file is missing. Adding `daily-driver` to the Morning Review layout in code
 *   alone won't reach existing users — this migration walks the file, finds the
 *   built-in `morning-review` layout, and inserts `daily-driver` into its
 *   `widgets` list + `grid` if missing. User-renamed copies and other layouts
 *   are not touched. Re-runs detect the widget is already present and skip.
 *   Mirrors migration 145.
 *
 * The DEFAULT_LAYOUTS geometry pins daily-driver full-width at the top and
 * shifts the other Morning Review widgets down — but an existing persisted
 * layout still has those widgets at their old (top) positions, so the preferred
 * top slot collides. Per the migration-145 convention we do NOT rewrite the
 * user's existing positions; instead the collision fallback appends
 * daily-driver on a fresh row below everything (still present, still gated).
 */

import { readLayoutsDoc, writeLayoutsDoc } from './_lib.js';

const WIDGET_ID = 'daily-driver';
const WIDGET_W = 12;
const WIDGET_H = 6;

// Mirror of the geometry in `server/services/dashboardLayouts.js`
// DEFAULT_LAYOUTS `morning-review` layout — edits here must match that file or
// fresh installs + migrated installs diverge.
const PREFERRED_SLOTS = {
  'morning-review': { x: 0, y: 0, w: WIDGET_W, h: WIDGET_H },
};
const TARGET_LAYOUT_IDS = Object.keys(PREFERRED_SLOTS);

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function collidesWith(grid, candidate) {
  for (const item of grid) {
    if (rectsOverlap(item, candidate)) return true;
  }
  return false;
}

function pickGridEntry(grid, layoutId) {
  const preferred = PREFERRED_SLOTS[layoutId];
  if (preferred) {
    const candidate = { id: WIDGET_ID, x: preferred.x, y: preferred.y, w: preferred.w, h: preferred.h };
    if (!collidesWith(grid, candidate)) return candidate;
  }
  // Fall back to a clean row below everything else if the preferred slot is
  // occupied (an existing persisted layout keeps its old widget positions).
  const bottom = grid.reduce((max, it) => Math.max(max, (it.y ?? 0) + (it.h ?? 0)), 0);
  return {
    id: WIDGET_ID,
    x: 0,
    y: bottom,
    w: preferred?.w ?? WIDGET_W,
    h: preferred?.h ?? WIDGET_H,
  };
}

function applyToLayout(layout) {
  if (!layout || typeof layout !== 'object') return false;
  if (!Array.isArray(layout.widgets)) return false;

  let changed = false;
  // 1) Insert into widgets if absent.
  if (!layout.widgets.includes(WIDGET_ID)) {
    layout.widgets = [...layout.widgets, WIDGET_ID];
    changed = true;
  }
  // 2) Heal the grid entry independently — the widget id can be present in
  // `widgets` but missing from `grid` (e.g. a widgets-only edit landed without
  // an arrange-and-save pass). Treat a non-array grid as [] (the shape the
  // client's `synthesizeGrid` would auto-create at render time).
  const existingGrid = Array.isArray(layout.grid) ? layout.grid : [];
  const hasGridEntry = existingGrid.some((it) => it?.id === WIDGET_ID);
  if (!hasGridEntry) {
    layout.grid = [...existingGrid, pickGridEntry(existingGrid, layout.id)];
    changed = true;
  } else if (!Array.isArray(layout.grid)) {
    layout.grid = existingGrid;
    changed = true;
  }
  return changed;
}

export default {
  async up({ rootDir }) {
    const result = await readLayoutsDoc({ rootDir, label: 'migration 191' });
    if (!result.ok) return { updated: 0, reason: result.reason };
    const { doc, path } = result;

    let touched = 0;
    for (const layout of doc.layouts) {
      if (!layout || !TARGET_LAYOUT_IDS.includes(layout.id)) continue;
      if (applyToLayout(layout)) touched += 1;
    }

    if (touched === 0) {
      console.log(`📦 migration 191: daily-driver already present in target layouts.`);
      return { updated: 0, reason: 'already-applied' };
    }

    await writeLayoutsDoc(path, doc);
    console.log(`📦 migration 191: seeded daily-driver widget into ${touched} built-in layout(s).`);
    return { updated: touched };
  },
};
