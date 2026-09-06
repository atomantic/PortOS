/**
 * The universe-walking half of every universe-backed burn job.
 *
 * Both the describe job and the images job answer the same two questions — "how
 * much work is outstanding across every universe" and "which single universe do
 * I chew on this run" — and differ only in what counts as a row. Written twice,
 * the pick rule drifted immediately: the ONE-universe-per-run rule below is a
 * correction of an earlier version that spread the cap across universes and
 * produced a cap the run never honored, and a second copy is a second chance to
 * regress it.
 */

import { getUniverse, listUniverses } from '../universeBuilder.js';
import { QUOTA_BURN_BOUNDS } from '../../lib/quotaBurnConfig.js';

// Bounds come from the catalog descriptor the client renders its min/max from —
// hardcoding them here would let a raised cap change the accepted range in the
// form without changing what the jobs actually run.
const ENTRY_BOUNDS = QUOTA_BURN_BOUNDS.maxEntries;

/** `params.maxEntries` clamped into the range the job form advertises. */
export const clampMaxEntries = (params) =>
  Math.min(ENTRY_BOUNDS.max, Math.max(ENTRY_BOUNDS.min, Number(params?.maxEntries) || ENTRY_BOUNDS.default));

/**
 * The universes a job targets: the one it names, or all of them. A universe
 * deleted since the job was configured must not wedge the family — report zero
 * pending and let the next job in the plan take the window.
 */
export async function loadUniverses(params) {
  const id = typeof params?.universeId === 'string' ? params.universeId.trim() : '';
  if (!id || id === 'all') return listUniverses();
  return getUniverse(id).then((universe) => [universe]).catch(() => []);
}

/**
 * Walk the targeted universes, count the whole backlog, and pick the FIRST
 * universe that has work — capped to `maxEntries`.
 *
 * One universe per run because each job's `run` makes a single batched call
 * against one universe (one render collection, or one describe batch reported
 * under one name). Spreading the budget across several produced a cap the run
 * never honored and a status line that advertised more universes than it
 * touched.
 *
 * `rowsFor(universe)` returns that universe's outstanding rows, already filtered
 * for the cooldown. `sortRows` (optional) orders the pick — applied ONLY to the
 * universe actually chosen, since every other universe contributes nothing but
 * its row count and sorting those is pure waste on a path that runs for every
 * configured job on every config-page load.
 *
 * Returns `{ picked, total, max }`, where `picked` carries the universe's id and
 * name rather than the record: the probe's return value is handed to the client
 * inside the status payload, and a universe record is a multi-megabyte blob that
 * neither job's `run` reads more than two fields of.
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
