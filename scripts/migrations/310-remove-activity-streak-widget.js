/**
 * Remove the retired generic activity-streak widget from every persisted
 * dashboard layout. POST and MeatSpace habit widgets remain untouched.
 */

import { readLayoutsDoc, writeLayoutsDoc } from './_lib.js';

const LABEL = 'migration 310';
const WIDGET_ID = 'activity-streak';

function removeFromLayout(layout) {
  if (!layout || !Array.isArray(layout.widgets)) return false;
  const widgets = layout.widgets.filter((id) => id !== WIDGET_ID);
  const existingGrid = Array.isArray(layout.grid) ? layout.grid : [];
  const grid = existingGrid.filter((item) => item?.id !== WIDGET_ID);
  const changed = widgets.length !== layout.widgets.length || grid.length !== existingGrid.length;
  if (!changed) return false;

  layout.widgets = widgets;
  layout.grid = grid;
  return true;
}

export default {
  async up({ rootDir }) {
    const result = await readLayoutsDoc({ rootDir, label: LABEL });
    if (!result.ok) return { updated: 0, reason: result.reason };
    const { doc, path } = result;
    let updated = 0;
    for (const layout of doc.layouts) {
      if (removeFromLayout(layout)) updated += 1;
    }
    if (updated === 0) return { updated: 0, reason: 'already-applied' };
    await writeLayoutsDoc(path, doc);
    console.log(`📦 ${LABEL}: removed activity streak widget from ${updated} dashboard layout(s).`);
    return { updated };
  },
};
