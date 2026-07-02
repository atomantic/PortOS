/**
 * Seed the new `feeds` (Feeds Digest) and `meatspace-streak` (Health Logging
 * Streak) dashboard widgets into their built-in layouts for installs that
 * already have a persisted `data/dashboard-layouts.json`.
 *
 * Background:
 *   `server/services/dashboardLayouts.js#DEFAULT_LAYOUTS` (+ INTENT_LAYOUTS)
 *   only seed when the file is missing. Adding a widget to a built-in layout
 *   in code alone won't reach existing users — this migration walks the file,
 *   finds each target built-in layout, and inserts the widget into its
 *   `widgets` list + `grid` if missing. User-renamed copies and other layouts
 *   are untouched. Re-runs detect the widget is already present and skip.
 *   Mirrors migrations 070 / 145.
 *
 *   `feeds` → `default` ("Everything") layout; `meatspace-streak` → `health`.
 *   Both widgets are gated client-side (hidden until feeds/logs exist), so a
 *   fresh-but-persisted install seeing the id costs nothing until it has data.
 */

import { readLayoutsDoc, writeLayoutsDoc } from './_lib.js';

// Each widget → its target built-in layout id + preferred grid slot. Slots
// mirror the geometry in `server/services/dashboardLayouts.js` — edits here
// must match that file or fresh installs + migrated installs diverge.
const SEEDS = [
  { widgetId: 'feeds',            layoutId: 'default', slot: { x: 8, y: 29, w: 3, h: 4 } },
  { widgetId: 'meatspace-streak', layoutId: 'health',  slot: { x: 0, y: 9,  w: 4, h: 4 } },
];

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function collidesWith(grid, candidate) {
  return grid.some((item) => rectsOverlap(item, candidate));
}

function pickGridEntry(grid, widgetId, slot) {
  const candidate = { id: widgetId, ...slot };
  if (!collidesWith(grid, candidate)) return candidate;
  // Fall back to a clean row below everything else if the preferred slot is
  // occupied (a user rearranged the layout but kept the built-in id).
  const bottom = grid.reduce((max, it) => Math.max(max, (it.y ?? 0) + (it.h ?? 0)), 0);
  return { id: widgetId, x: 0, y: bottom, w: slot.w, h: slot.h };
}

function applyToLayout(layout, widgetId, slot) {
  if (!layout || typeof layout !== 'object') return false;
  if (!Array.isArray(layout.widgets)) return false;

  let changed = false;
  // 1) Insert into widgets if absent.
  if (!layout.widgets.includes(widgetId)) {
    layout.widgets = [...layout.widgets, widgetId];
    changed = true;
  }
  // 2) Heal the grid entry independently — the id can be present in `widgets`
  // but missing from `grid` (e.g. a widgets-only edit landed without an
  // arrange-and-save pass). Treat a non-array grid as [].
  const existingGrid = Array.isArray(layout.grid) ? layout.grid : [];
  const hasGridEntry = existingGrid.some((it) => it?.id === widgetId);
  if (!hasGridEntry) {
    layout.grid = [...existingGrid, pickGridEntry(existingGrid, widgetId, slot)];
    changed = true;
  } else if (!Array.isArray(layout.grid)) {
    layout.grid = existingGrid;
    changed = true;
  }
  return changed;
}

export default {
  async up({ rootDir }) {
    const result = await readLayoutsDoc({ rootDir, label: 'migration 156' });
    if (!result.ok) return { updated: 0, reason: result.reason };
    const { doc, path } = result;

    let touched = 0;
    for (const { widgetId, layoutId, slot } of SEEDS) {
      const layout = doc.layouts.find((l) => l && l.id === layoutId);
      if (!layout) continue;
      if (applyToLayout(layout, widgetId, slot)) touched += 1;
    }

    if (touched === 0) {
      console.log(`📦 migration 156: feeds + meatspace-streak already present in target layouts.`);
      return { updated: 0, reason: 'already-applied' };
    }

    await writeLayoutsDoc(path, doc);
    console.log(`📦 migration 156: seeded feeds/meatspace-streak into ${touched} built-in layout(s).`);
    return { updated: touched };
  },
};
