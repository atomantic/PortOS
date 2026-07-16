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
 * The DEFAULT_LAYOUTS geometry places daily-driver full-width in a fresh row
 * BELOW the Morning Review scan quadrants (so a gated-off slot leaves only
 * trailing space, never a gap at the top). This migration mirrors that: it
 * appends daily-driver on a fresh row below everything already in the persisted
 * grid, never rewriting the user's existing positions (migration-145 convention).
 */

import { readLayoutsDoc, writeLayoutsDoc } from './_lib.js';

const WIDGET_ID = 'daily-driver';
const WIDGET_W = 12;
const WIDGET_H = 6;

// Mirror of the geometry in `server/services/dashboardLayouts.js`
// DEFAULT_LAYOUTS `morning-review` layout — daily-driver sits full-width in a
// fresh row BELOW the scan quadrants. Edits here must match that file or fresh
// installs + migrated installs diverge.
const TARGET_LAYOUT_IDS = ['morning-review'];

// Always append daily-driver on a fresh row below everything already in the
// grid (never at the top). A gated-off widget's slot is dropped without
// compacting the rows above it, so a bottom slot means the driver's absence
// leaves only harmless trailing space — matching the DEFAULT_LAYOUTS placement.
function pickGridEntry(grid) {
  const bottom = grid.reduce((max, it) => Math.max(max, (it.y ?? 0) + (it.h ?? 0)), 0);
  return { id: WIDGET_ID, x: 0, y: bottom, w: WIDGET_W, h: WIDGET_H };
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
    layout.grid = [...existingGrid, pickGridEntry(existingGrid)];
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
