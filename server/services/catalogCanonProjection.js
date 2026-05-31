/**
 * Bidirectional projection between an embedded universe-canon entry and its
 * `catalog_ingredients` row — so the two NEVER diverge.
 *
 * Background. A universe canon entry (`universe.characters[]`, `places[]`,
 * `objects[]`) carries the FULL bible payload PLUS a stable `ingredientId`. The
 * matching `catalog_ingredients.payload` holds a parallel copy. Before this
 * module the two were copy-on-write mirrors: the Catalog detail page PATCHed
 * only the catalog row, and the Universe Builder canon surface PATCHed only
 * `universe.characters[]`, so an edit on either side silently went stale on the
 * other. This module collapses them to ONE store of record (the catalog row)
 * while keeping the embedded entry as a full projection CACHE (v1 decision —
 * many synchronous renderers / prompt-builders read `universe.characters[].x`).
 *
 * Two directions:
 *   projectToCanon(ingredientId, updatedIngredient)
 *     A catalog edit → fan the catalog row's name+payload into the embedded
 *     entry of every universe that references the ingredient. Best-effort /
 *     fire-and-forget at the call site (the catalog PATCH route already
 *     responded); failures are logged single-line and swallowed.
 *
 *   projectToCatalog(universeId, canonArrays, { guardToken })
 *     A canon edit → write each embedded entry's payload back into its catalog
 *     row. Called SYNCHRONOUSLY inside updateUniverse so the cache can never
 *     lag the authoritative row on the same request.
 *
 * Loop safety. projectToCanon calls updateUniverse, and updateUniverse calls
 * projectToCatalog — an A→B→A cycle. A module-level in-flight guard (`Set` of
 * ingredient ids currently being projected, plus a per-call `guardToken`)
 * breaks it: projectToCatalog skips any entry whose ingredientId is guarded, so
 * the catalog row that a projectToCanon is reading FROM is never written back
 * to inside the same logical operation. Net effect for a single user edit: each
 * side is written EXACTLY ONCE (asserted in catalogCanonProjection.test.js).
 *
 * Conflict policy. LWW on `updatedAt` (no field-level merge). projectToCatalog
 * only writes when the embedded entry's `updatedAt` is newer-or-equal to the
 * catalog row's; projectToCanon always wins (the catalog row IS the store of
 * record after a catalog edit). The boot reconciler (reconcileCanonCatalog.js)
 * runs the same LWW comparison to collapse any pre-existing divergence.
 */

import * as catalogDB from './catalogDB.js';
import { BIBLE_KIND, BIBLE_FIELD } from '../lib/storyBible.js';

// Catalog `type` ↔ canon array key, derived from the bible registry so a future
// kind added there flows through without editing this file.
const TYPE_FOR_ARRAY = Object.freeze(
  Object.fromEntries(Object.values(BIBLE_KIND).map((k) => [BIBLE_FIELD[k], k])),
);
const CANON_ARRAY_KEYS = Object.freeze(Object.values(BIBLE_FIELD));

// Fields that live on the embedded canon entry but are NOT part of the catalog
// row's `payload` (the catalog row owns `id`/`name`/timestamps as columns, and
// `ingredientId` is the canon→catalog backlink, not payload content). Stripped
// both directions so a round-trip is shape-stable and we never smuggle a stale
// `schemaVersion` from one store into the other.
const NON_PAYLOAD_KEYS = ['id', 'ingredientId', 'createdAt', 'updatedAt', 'name', 'schemaVersion'];

// In-flight re-entrancy guard. Holds ingredient ids currently mid-projection so
// the A→B→A cycle (projectToCanon → updateUniverse → projectToCatalog) can't
// write the originating catalog row a second time. A `Set` (not a single flag)
// because a multi-universe catalog edit projects into N universes and a single
// canon edit can touch multiple ingredients.
const inFlight = new Set();

/**
 * Build the catalog `payload` from an embedded canon entry (strip the control
 * keys the row owns as columns + the backlink + schemaVersion). Exported so the
 * boot reconciler (reconcileCanonCatalog.js) produces a byte-identical payload
 * — a divergent strip rule between the two would re-introduce the very drift
 * this module exists to kill.
 */
export function entryToPayload(entry) {
  const payload = { ...(entry && typeof entry === 'object' ? entry : {}) };
  for (const k of NON_PAYLOAD_KEYS) delete payload[k];
  return payload;
}

/**
 * Project a catalog edit into every universe that references the ingredient.
 *
 * Best-effort: returns a stats object `{ universes, written, skipped }` and
 * never throws on a per-universe failure (logged single-line). The caller (the
 * catalog PATCH route) invokes this AFTER responding, so a projection hiccup
 * must not turn a successful edit into an error.
 */
export async function projectToCanon(ingredientId, updatedIngredient, deps = {}) {
  // `deps.updateUniverse` is a test seam (the suite injects a spy to assert the
  // canon side is written exactly once without a live universe store). Prod
  // dynamic-imports the real one — a static import would form a require cycle
  // (universeBuilder imports this module).
  const updateUniverse = deps.updateUniverse || (await import('./universeBuilder.js')).updateUniverse;
  if (!ingredientId || !updatedIngredient) return { universes: 0, written: 0, skipped: 0 };

  // Guard the originating ingredient so the updateUniverse → projectToCatalog
  // echo inside this call can't write the catalog row a second time.
  inFlight.add(ingredientId);
  const stats = { universes: 0, written: 0, skipped: 0 };
  try {
    const refs = await catalogDB.listRefsForIngredient(ingredientId);
    const universeIds = [...new Set(
      refs.filter((r) => r.refKind === 'universe' && r.refId).map((r) => r.refId),
    )];
    if (universeIds.length === 0) return stats;            // no-universe-ref → silent no-op

    const name = updatedIngredient.name;
    const payload = entryToPayload(updatedIngredient.payload || {});
    const updatedAt = updatedIngredient.updatedAt || new Date().toISOString();

    for (const universeId of universeIds) {
      stats.universes++;
      // Mutator form: merge the catalog payload into every embedded entry that
      // carries this ingredientId, across all canon arrays. `silent: true`
      // suppresses the per-universe peer-sync fan-out so a catalog edit that
      // touches N universes doesn't emit N recordUpdated events. `guardToken`
      // threads the originating ingredientId so updateUniverse's synchronous
      // projectToCatalog skips it (loop break).
      const result = await updateUniverse(universeId, (cur) => {
        let touched = false;
        const patch = {};
        for (const arrayKey of CANON_ARRAY_KEYS) {
          const list = Array.isArray(cur[arrayKey]) ? cur[arrayKey] : [];
          if (!list.some((e) => e?.ingredientId === ingredientId)) continue;
          patch[arrayKey] = list.map((e) => {
            if (e?.ingredientId !== ingredientId) return e;
            touched = true;
            return { ...e, ...payload, name, ingredientId, updatedAt };
          });
        }
        return touched ? patch : null;
      }, { silent: true, canonProjectionGuard: ingredientId }).catch((err) => {
        console.error(`🔁 projectToCanon: universe ${universeId} update failed: ${err.message}`);
        return null;
      });
      if (result) stats.written++;
      else stats.skipped++;
    }
    return stats;
  } finally {
    inFlight.delete(ingredientId);
  }
}

/**
 * Project a canon edit into the catalog row for every embedded entry that
 * carries an `ingredientId`. Called SYNCHRONOUSLY inside updateUniverse after
 * the canon arrays persist, so the catalog row never lags the embedded cache on
 * the same request.
 *
 *   canonArrays — the PERSISTED universe record (or `{ characters, places,
 *                 objects }` subset) read straight after the write.
 *   guardToken  — when set (a projectToCanon-originated write), the entry whose
 *                 ingredientId equals it is skipped (loop break).
 *
 * LWW: writes the catalog row only when the embedded entry's `updatedAt` is
 * newer-or-equal to the stored row's. Best-effort per entry (logged on
 * failure); returns `{ written, skipped }`.
 */
export async function projectToCatalog(universeId, canonArrays, { guardToken = null } = {}) {
  const stats = { written: 0, skipped: 0 };
  if (!canonArrays || typeof canonArrays !== 'object') return stats;

  for (const arrayKey of CANON_ARRAY_KEYS) {
    const list = Array.isArray(canonArrays[arrayKey]) ? canonArrays[arrayKey] : [];
    const type = TYPE_FOR_ARRAY[arrayKey];
    for (const entry of list) {
      const ingredientId = entry?.ingredientId;
      if (!ingredientId) continue;
      // Loop break: skip the ingredient the originating projectToCanon is
      // writing FROM (its catalog row is already authoritative this request).
      if (ingredientId === guardToken || inFlight.has(ingredientId)) {
        stats.skipped++;
        continue;
      }
      try {
        const row = await catalogDB.getIngredient(ingredientId);
        if (!row) { stats.skipped++; continue; }
        // LWW on updatedAt — only overwrite the catalog row when the embedded
        // entry is at-least-as-fresh. An older embedded snapshot (e.g. a
        // concurrent catalog edit won) is left alone.
        const entryAt = Date.parse(entry.updatedAt || '') || 0;
        const rowAt = Date.parse(row.updatedAt || '') || 0;
        if (entryAt < rowAt) { stats.skipped++; continue; }
        await catalogDB.updateIngredient(
          ingredientId,
          { name: entry.name, payload: entryToPayload(entry) },
          { source: 'sync', actor: 'canon-projection' },
        );
        stats.written++;
      } catch (err) {
        console.error(`🔁 projectToCatalog: ingredient ${ingredientId} update failed: ${err.message}`);
        stats.skipped++;
      }
    }
  }
  return stats;
}

// Test seam — lets the unit suite assert the guard set drains to empty after a
// projection round-trip (no leaked in-flight tokens).
export function _inFlightSize() {
  return inFlight.size;
}
