/**
 * Seed the three new intent-named built-in dashboard layouts (`deep-work`, `health`, `agent-watch`) into installs that already have a persisted `data/dashboard-layouts.json`.
 *
 * `server/services/dashboardLayouts.js#DEFAULT_LAYOUTS` ships them alongside the original four, but `getState()` returns the sanitized persisted layouts whenever the file exists, so new built-ins in code only reach fresh installs. This inserts any that aren't present (by id, so re-runs skip: idempotent) with their server-side default grid. A user-deleted one is re-seeded, matching the fresh-install path (a hand-edit could remove it; built-ins are guarded against deletion today).
 */

import { INTENT_LAYOUTS } from '../../server/services/dashboardLayouts.js';
import { readLayoutsDoc, writeLayoutsDoc } from './_lib.js';

export default {
  async up({ rootDir }) {
    const result = await readLayoutsDoc({ rootDir, label: 'migration 030' });
    if (!result.ok) return { updated: 0, reason: result.reason };
    const { doc, path } = result;

    const existingIds = new Set(doc.layouts.map((l) => l?.id).filter(Boolean));
    const toAdd = INTENT_LAYOUTS.filter((l) => !existingIds.has(l.id));
    if (toAdd.length === 0) {
      console.log(`📦 migration 030: intent layouts already present.`);
      return { updated: 0, reason: 'already-applied' };
    }

    doc.layouts.push(...toAdd.map((l) => ({ ...l, builtIn: true })));
    await writeLayoutsDoc(path, doc);
    console.log(`📦 migration 030: seeded ${toAdd.length} intent layout(s) (${toAdd.map((l) => l.id).join(', ')}).`);
    return { updated: toAdd.length };
  },
};
