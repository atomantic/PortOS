/**
 * Seed the new `quick-image` dashboard widget into the built-in `default`
 * (Everything) layout for installs that already have a persisted
 * `data/dashboard-layouts.json`.
 *
 * Background:
 *   `server/services/dashboardLayouts.js#DEFAULT_LAYOUTS` only seeds when
 *   the file is missing. Adding a widget to the default layout in code
 *   alone won't reach existing users — this migration walks the file,
 *   finds the built-in `default` layout, and inserts `quick-image` into
 *   its `widgets` list + `grid` if missing. User-renamed copies and
 *   non-default layouts are not touched. Re-runs detect the widget is
 *   already present and skip.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const WIDGET_ID = 'quick-image';
const WIDGET_W = 3;
const WIDGET_H = 3;

// Mirror of the geometry in `server/services/dashboardLayouts.js`
// DEFAULT_LAYOUTS — slot below quick-brain in the capture row. Edits here
// must match that file or fresh installs + migrated installs diverge.
const PREFERRED_SLOTS = {
  default: { x: 0, y: 2 },
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

  let changed = false;
  // 1) Insert into widgets if absent.
  if (!layout.widgets.includes(WIDGET_ID)) {
    layout.widgets = [...layout.widgets, WIDGET_ID];
    changed = true;
  }
  // 2) Heal the grid entry independently. The previous early-return on
  // widgets.includes() skipped the realistic legacy/corrupted case where
  // the widget id was present in `widgets` but missing from `grid` —
  // either because an older migration only seeded one side, or because
  // a `widgets`-only edit landed without an arrange-and-save pass. We
  // detect that here and add the placement entry, so the on-disk state
  // is always self-consistent. Treat non-array grid as [] (same shape
  // the client's `synthesizeGrid` would auto-create at render time).
  const existingGrid = Array.isArray(layout.grid) ? layout.grid : [];
  const hasGridEntry = existingGrid.some((it) => it?.id === WIDGET_ID);
  if (!hasGridEntry) {
    layout.grid = [...existingGrid, pickGridEntry(existingGrid, layout.id)];
    changed = true;
  } else if (!Array.isArray(layout.grid)) {
    // Defensive: widget had an entry in a non-array grid (impossible by
    // the some() check above unless the grid is itself weird) — normalize
    // to the existingGrid we just synthesized.
    layout.grid = existingGrid;
    changed = true;
  }
  return changed;
}

export default {
  async up({ rootDir }) {
    const path = join(rootDir, 'data', 'dashboard-layouts.json');
    const raw = await readFile(path, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) {
      console.log(`📦 migration 033: no dashboard-layouts.json yet — fresh install will seed from defaults.`);
      return { updated: 0, reason: 'no-state' };
    }
    let doc;
    try { doc = JSON.parse(raw); } catch {
      console.log(`📦 migration 033: dashboard-layouts.json unreadable — skipping.`);
      return { updated: 0, reason: 'unreadable' };
    }
    if (!doc || !Array.isArray(doc.layouts)) {
      return { updated: 0, reason: 'no-layouts-array' };
    }

    let touched = 0;
    for (const layout of doc.layouts) {
      if (!layout || layout.id !== 'default') continue;
      if (applyToLayout(layout)) touched += 1;
    }

    if (touched === 0) {
      console.log(`📦 migration 033: quick-image already present in default layout.`);
      return { updated: 0, reason: 'already-applied' };
    }

    await writeFile(path, JSON.stringify(doc, null, 2));
    console.log(`📦 migration 033: seeded quick-image widget into ${touched} built-in layout(s).`);
    return { updated: touched };
  },
};
