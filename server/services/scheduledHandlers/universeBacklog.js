/** The universe-walking half of every universe-backed burn job: outstanding-work count and single-universe pick, shared so the pick rule cannot drift between jobs. */

import { getUniverse, listUniverses } from '../universeBuilder.js';
import { QUOTA_BURN_BOUNDS } from '../../lib/quotaBurnConfig.js';

// From the catalog descriptor the client renders its min/max from, so the form and jobs agree.
const ENTRY_BOUNDS = QUOTA_BURN_BOUNDS.maxEntries;

/** `params.maxEntries` clamped into the range the job form advertises. */
export const clampMaxEntries = (params) =>
  Math.min(ENTRY_BOUNDS.max, Math.max(ENTRY_BOUNDS.min, Number(params?.maxEntries) || ENTRY_BOUNDS.default));

/** The universes a job targets: the one it names, or all. A deleted universe reports zero pending rather than wedging the family. */
export async function loadUniverses(params) {
  const id = typeof params?.universeId === 'string' ? params.universeId.trim() : '';
  if (!id || id === 'all') return listUniverses();
  return getUniverse(id).then((universe) => [universe]).catch(() => []);
}

/**
 * Walk the targeted universes, count the whole backlog, and pick the FIRST universe with
 * work, capped to `maxEntries`. One universe per run: each job's `run` makes a single
 * batched call against one universe, so spreading the cap never held.
 *
 * `rowsFor(universe)` returns outstanding rows (cooldown already applied). `sortRows`
 * orders only the chosen universe's rows; others contribute just a count. Returns
 * `{ picked, total, max }`; `picked` carries id and name, not the multi-megabyte record,
 * because the probe result goes to the client in the status payload.
 */
export async function collectUniverseBacklog(params, { rowsFor, sortRows } = {}) {
  const max = clampMaxEntries(params);
  const universes = await loadUniverses(params);
  let picked = null;
  let total = 0;
  for (const universe of universes) {
    const rows = rowsFor(universe);
    total += rows.length;
    if (!rows.length || picked) continue;
    picked = {
      universeId: universe.id,
      universeName: universe.name,
      rows: (sortRows ? sortRows(rows) : rows).slice(0, max),
    };
  }
  return { picked, total, max };
}
