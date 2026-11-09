/**
 * Give every stored Life Calendar activity a stable `id` (#15383), so a removal
 * or edit names exactly the row the caller saw instead of whatever now sits at
 * a stale index (same-named and nameless rows defeated the name guard).
 *
 * Derived data: gated on `data/meatspace/activities.json` existing with an
 * `activities` array, and shipped without a `data.reference/` seed (an install
 * with no file serves the code defaults, which carry fixed ids). Rows that
 * already hold a unique id keep it; a missing, blank or repeated id gets a UUID.
 * Activities are machine-local, so no peer shares this id namespace.
 */
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readJsonOrNull, writeJsonAtomic } from './_lib.js';

export const OWNED_OUTPUT_PATHS = ['meatspace/activities.json'];

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export default {
  async up({ rootDir }) {
    const path = join(rootDir, 'data', 'meatspace', 'activities.json');
    if (!existsSync(path)) return { assigned: 0, reason: 'no-input' };
    const doc = await readJsonOrNull(path);
    if (!isPlainObject(doc) || !Array.isArray(doc.activities)) return { assigned: 0, reason: 'no-activities' };

    const seen = new Set();
    let assigned = 0;
    const activities = doc.activities.map((activity) => {
      if (!isPlainObject(activity)) return activity;
      const { id } = activity;
      if (typeof id === 'string' && id !== '' && !seen.has(id)) {
        seen.add(id);
        return activity;
      }
      const fresh = randomUUID();
      seen.add(fresh);
      assigned += 1;
      return { ...activity, id: fresh };
    });
    if (assigned === 0) return { assigned };
    await writeJsonAtomic(path, { ...doc, activities });
    console.log(`🆔 Assigned ids to ${assigned} Life Calendar activit${assigned === 1 ? 'y' : 'ies'}`);
    return { assigned };
  },
};
