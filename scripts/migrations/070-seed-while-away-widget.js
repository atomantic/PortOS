/**
 * Seed the new `while-away` dashboard widget ("While You Were Away") into the
 * built-in `default` (Everything) and `agent-watch` layouts for installs that
 * already have a persisted `data/dashboard-layouts.json`.
 *
 * Background:
 *   `server/services/dashboardLayouts.js#DEFAULT_LAYOUTS` only seeds when the
 *   file is missing. Adding a widget to those layouts in code alone won't reach
 *   existing users — this migration walks the file, finds each target built-in
 *   layout, and inserts `while-away` into its `widgets` list + `grid` if
 *   missing. User-renamed copies and other layouts are not touched. Re-runs
 *   detect the widget is already present and skip. Mirrors migration 033.
 */

import { readLayoutsDoc, writeLayoutsDoc } from './_lib.js';

const WIDGET_ID = 'while-away';
const WIDGET_W = 3;
const WIDGET_H = 5;

// Mirror of the geometry in `server/services/dashboardLayouts.js`
// DEFAULT_LAYOUTS — edits here must match that file or fresh installs +
// migrated installs diverge. `agent-watch` gives the card a wider slot.
const PREFERRED_SLOTS = {
  default: { x: 9, y: 15, w: WIDGET_W, h: 3 },
  'agent-watch': { x: 6, y: 3, w: 6, h: WIDGET_H },
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
  // occupied (a user rearranged the layout but kept the built-in id). Carry
  // the layout's preferred width/height so a collided agent-watch heal still
  // gets the intended 6-wide card, not the bare WIDGET_W default.
  const bottom = grid.reduce((max, it) => Math.max(max, (it.y ?? 0) + (it.h ?? 0)), 0);
  return {
    id: WIDGET_ID,
    x: 0,
    y: bottom,
    w: preferred?.w ?? WIDGET_W,
    h: preferred?.h ?? WIDGET_H
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
    const result = await readLayoutsDoc({ rootDir, label: 'migration 070' });
    if (!result.ok) return { updated: 0, reason: result.reason };
    const { doc, path } = result;

    let touched = 0;
    for (const layout of doc.layouts) {
      if (!layout || !TARGET_LAYOUT_IDS.includes(layout.id)) continue;
      if (applyToLayout(layout)) touched += 1;
    }

    if (touched === 0) {
      console.log(`📦 migration 070: while-away already present in target layouts.`);
      return { updated: 0, reason: 'already-applied' };
    }

    await writeLayoutsDoc(path, doc);
    console.log(`📦 migration 070: seeded while-away widget into ${touched} built-in layout(s).`);
    return { updated: touched };
  },
};
