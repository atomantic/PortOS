/**
 * Seed the three new intent-named built-in dashboard layouts into installs
 * that already have a persisted `data/dashboard-layouts.json`.
 *
 * Background:
 *   `server/services/dashboardLayouts.js#DEFAULT_LAYOUTS` ships
 *   `deep-work`, `health`, and `agent-watch` alongside the original four
 *   built-ins. `getState()` returns the sanitized persisted layouts whenever
 *   the file exists, so adding new built-ins in code only affects fresh
 *   installs — existing users never see them.
 *
 *   This migration walks `data/dashboard-layouts.json` and inserts any of
 *   the three new built-ins that aren't already present, with their
 *   server-side default grid. Re-runs detect each layout already exists by
 *   id and skip, so the migration is idempotent.
 *
 *   If the user previously deleted one of the new built-in ids (the
 *   `health` widget doesn't survive deletion of a built-in today because
 *   built-ins are guarded — but a hand-edit could remove it), we will
 *   re-seed it. This matches the behavior of the fresh-install path.
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
