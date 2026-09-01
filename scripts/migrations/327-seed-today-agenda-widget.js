/**
 * Seed the Today's Agenda calendar widget into the built-in Everything and
 * Morning Review layouts. The widget is gated on a connected calendar account,
 * so installs without one see no change. Custom/user layouts are intentionally
 * untouched: the layout editor is the user's source of truth for those.
 */

import { readLayoutsDoc, writeLayoutsDoc } from './_lib.js';

const LABEL = 'migration 327';
const TARGET_LAYOUTS = new Set(['default', 'morning-review']);
const WIDGET_ID = 'today-agenda';

function applyToLayout(layout) {
  if (!layout || !TARGET_LAYOUTS.has(layout.id) || !Array.isArray(layout.widgets)) return false;
  const hasWidget = layout.widgets.includes(WIDGET_ID);
  const hasGridEntry = Array.isArray(layout.grid) && layout.grid.some((item) => item?.id === WIDGET_ID);
  if (hasWidget && hasGridEntry) return false;

  if (!hasWidget) layout.widgets = [...layout.widgets, WIDGET_ID];
  if (!hasGridEntry) {
    // Append at the end of the packing sequence — the widget is gated, so a
    // trailing cell that gates off leaves only harmless trailing space.
    const grid = Array.isArray(layout.grid) ? layout.grid : [];
    const maxOrder = grid.reduce((max, item) => Math.max(max, Number.isFinite(item?.order) ? item.order : -1), -1);
    layout.grid = [...grid, { id: WIDGET_ID, x: 0, w: 4, order: maxOrder + 1, h: 4 }];
  }
  return true;
}

export default {
  async up({ rootDir }) {
    const result = await readLayoutsDoc({ rootDir, label: LABEL });
    if (!result.ok) return { updated: 0, reason: result.reason };
    const { doc, path } = result;
    let updated = 0;
    for (const layout of doc.layouts) {
      if (applyToLayout(layout)) updated += 1;
    }
    if (updated === 0) return { updated: 0, reason: 'already-applied' };
    await writeLayoutsDoc(path, doc);
    console.log(`📅 ${LABEL}: seeded Today's Agenda widget in ${updated} built-in dashboard layout(s).`);
    return { updated };
  },
};
