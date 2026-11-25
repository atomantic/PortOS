/**
 * Bidirectional projection between an embedded universe-canon entry and its `catalog_ingredients` row,
 * so the two never diverge. The catalog row is the store of record; the embedded entry
 * (`universe.characters[]`, `places[]`, `objects[]`, with a stable `ingredientId`) is a full projection
 * CACHE because many synchronous renderers and prompt-builders read it directly.
 *
 *   projectToCanon(ingredientId, updatedIngredient): catalog edit -> embedded entry of every referencing
 *     universe. Fire-and-forget at the call site; failures are logged single-line and swallowed.
 *   projectToCatalog(universeId, canonArrays, { guardToken }): canon edit -> catalog row. Called
 *     SYNCHRONOUSLY inside updateUniverse so the cache never lags the authoritative row.
 *
 * Loop safety: projectToCanon calls updateUniverse, which calls projectToCatalog (A->B->A). Each call
 * guards the identities in its universe snapshot, including unchanged siblings. Independent canon edits
 * still run the normal freshness checks in their own write.
 *
 * Conflict policy: LWW on `updatedAt` (no field-level merge). projectToCatalog writes only when the
 * embedded entry is newer-or-equal; projectToCanon accepts only the current catalog revision and never
 * replaces a newer embedded edit. reconcileCanonCatalog.js runs the same comparison at boot.
 */

import { isDeepStrictEqual } from 'node:util';
import * as catalogDB from './catalogDB.js';
import { catalogEvents } from './catalogEvents.js';
import { getCatalogIdentityAccess } from '../catalogDB/identityAccess.js';
import { collectUniverseCanonIngredientIds } from '../../lib/catalog/catalogUniverseContext.js';
import { BIBLE_KEYS } from '../../lib/storyBible.js';

// Fields that live on the embedded canon entry but are NOT part of the catalog
// row's `payload` (the catalog row owns `id`/`name`/timestamps as columns, and
// `ingredientId` is the canon→catalog backlink, not payload content). Stripped
// both directions so a round-trip is shape-stable and we never smuggle a stale
// `schemaVersion` from one store into the other.
const NON_PAYLOAD_KEYS = ['id', 'ingredientId', 'createdAt', 'updatedAt', 'name', 'schemaVersion'];

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

export function pickCanonControlFields(entry) {
  return Object.fromEntries(
    NON_PAYLOAD_KEYS.filter((key) => entry[key] !== undefined).map((key) => [key, entry[key]]),
  );
}

/**
 * Project a catalog edit into every universe that references the ingredient.
 * Best-effort: returns `{ universes, written, skipped }` and never throws on a per-universe failure;
 * the caller invokes it AFTER responding, so a hiccup must not turn a successful edit into an error.
 */
export async function projectToCanon(ingredientId, updatedIngredient, deps = {}) {
  // `deps.updateUniverse` is a test seam (the suite injects a spy to assert the
  // canon side is written exactly once without a live universe store). Prod
  // dynamic-imports the real one — a static import would form a require cycle
  // (universeBuilder imports this module).
  const updateUniverse = deps.updateUniverse || (await import('../universeBuilder.js')).updateUniverse;
  if (!ingredientId || !updatedIngredient) return { universes: 0, written: 0, skipped: 0 };

  ingredientId = updatedIngredient.id || ingredientId;
  // Cross-owner contextual canon stays an original snapshot. The catalog ID
  // resolves current canon without silently rewriting a peer-owned universe.
  if (await getCatalogIdentityAccess(ingredientId)) return { universes: 0, written: 0, skipped: 1 };
  const identityIds = new Set(await catalogDB.getIngredientIdentityIds(ingredientId));

  const stats = { universes: 0, written: 0, skipped: 0 };
  const refs = await catalogDB.listRefsForIngredient(ingredientId);
  const universeIds = [...new Set(
    refs.filter((r) => r.refKind === 'universe' && r.refId).map((r) => r.refId),
  )];
  if (universeIds.length === 0) return stats;            // no-universe-ref → silent no-op

  const name = updatedIngredient.name;
  const payload = entryToPayload(updatedIngredient.payload || {});
  const updatedAt = updatedIngredient.updatedAt;
  const sourceAt = Date.parse(updatedAt || '');

  for (const universeId of universeIds) {
    stats.universes++;
    // Replace the mirrored payload on every embedded entry carrying this ingredientId, preserving only
    // control fields (merging onto the whole entry would retain fields removed by an edit or revision
    // restore and leak stale canon back into Catalog). `silent: true` suppresses per-universe peer-sync
    // fan-out; `guardToken` makes updateUniverse's projectToCatalog skip this ingredient (loop break).
    let touched = false;
    const projectionIdentityIds = [...identityIds];
    const result = await updateUniverse(universeId, async (cur) => {
      // Read without taking the catalog write queue: reverse projection already
      // runs inside this universe queue. Waiting on both queues can deadlock.
      const current = await catalogDB.getIngredient(ingredientId);
      if (!current || current.id !== ingredientId || !Number.isFinite(sourceAt)
        || Date.parse(current.updatedAt || '') !== sourceAt
        || current.name !== name
        || !isDeepStrictEqual(entryToPayload(current.payload || {}), payload)) return null;
      const patch = {};
      for (const arrayKey of BIBLE_KEYS) {
        const list = Array.isArray(cur[arrayKey]) ? cur[arrayKey] : [];
        if (!list.some((e) => identityIds.has(e?.ingredientId))) continue;
        patch[arrayKey] = list.map((e) => {
          if (!identityIds.has(e?.ingredientId)) return e;
          // Alias-backed entries are archived context, not newer edits of
          // the canonical identity; an explicit catalog edit refreshes them.
          if (e.ingredientId === ingredientId && Date.parse(e.updatedAt || '') > sourceAt) return e;
          touched = true;
          return { ...pickCanonControlFields(e), ...payload, name, ingredientId, updatedAt };
        });
      }
      if (!touched) return null;
      projectionIdentityIds.push(...collectUniverseCanonIngredientIds(cur));
      return patch;
    }, { silent: true, canonProjectionGuard: ingredientId, canonProjectionIdentityIds: projectionIdentityIds }).catch((err) => {
      console.error(`🔁 projectToCanon: universe ${universeId} update failed: ${err.message}`);
      return null;
    });
    if (result && touched) stats.written++;
    else stats.skipped++;
  }
  return stats;
}

/**
 * Project a canon edit into the catalog row for every embedded entry that carries an `ingredientId`.
 * Called SYNCHRONOUSLY inside updateUniverse after the canon arrays persist.
 *
 *   canonArrays: the PERSISTED universe record (or a `{ characters, places, objects }` subset).
 *   guardToken: when set (a projectToCanon-originated write), the entry with that ingredientId is skipped (loop break).
 *   guardIdentityIds: aliases and unchanged canon entries captured by the originating operation, also skipped.
 *
 * LWW: writes only when the embedded entry's `updatedAt` is newer-or-equal to the stored row's,
 * re-checked under the row lock. Best-effort per entry; a write refused because the row changed
 * after the batched lookup counts as skipped. Returns `{ written, skipped }`.
 */
export async function projectToCatalog(universeId, canonArrays, { guardToken = null, guardIdentityIds = [] } = {}) {
  const stats = { written: 0, skipped: 0 };
  if (!canonArrays || typeof canonArrays !== 'object') return stats;

  // Pass 1: collect candidates across every canon array and apply the loop break up front,
  // so the batched lookup below asks only for rows we could write (#3941).
  const guardedIds = new Set(guardIdentityIds);
  if (guardToken) guardedIds.add(guardToken);
  const candidates = [];
  for (const arrayKey of BIBLE_KEYS) {
    const list = Array.isArray(canonArrays[arrayKey]) ? canonArrays[arrayKey] : [];
    for (const entry of list) {
      const ingredientId = entry?.ingredientId;
      if (!ingredientId) continue;
      // A Catalog-originated write has no canon edits to send back.
      if (guardedIds.has(ingredientId)) {
        stats.skipped++;
        continue;
      }
      candidates.push({ ingredientId, entry });
    }
  }
  if (candidates.length === 0) return stats;

  // ONE query for every candidate's freshness. A lookup failure is logged once and every candidate counts as skipped.
  const timestamps = await catalogDB.getIngredientTimestamps(
    candidates.map((c) => c.ingredientId),
    // A retained source cache is an archived contextual copy, not a fresh
    // authoritative edit. Only a catalog projection may refresh its identity.
    { excludeAliases: true },
  ).catch((err) => {
    console.error(`🔁 projectToCatalog: batched lookup of ${candidates.length} ingredients failed: ${err.message}`);
    return null;
  });
  if (!timestamps) {
    stats.skipped += candidates.length;
    return stats;
  }

  // Pass 2: sequential by design (each write is a multi-statement transaction).
  // The batched snapshot only prunes obvious losers; updateIngredientIfFresh re-checks the clock
  // under the row lock and reports `stale` rather than overwriting a newer row (#12503).
  // `ownWrites` keeps each write's row version and source clock so a duplicate ingredientId
  // compares against the entry written earlier in the pass, not the NOW() the trigger stamped (#4006).
  const ownWrites = new Map();
  for (const { ingredientId, entry } of candidates) {
    const rowUpdatedAt = timestamps.get(ingredientId);
    if (rowUpdatedAt === undefined) { stats.skipped++; continue; }   // no live row
    const priorWrite = ownWrites.get(ingredientId) || null;
    // LWW on updatedAt: only overwrite when the embedded entry is at-least-as-fresh.
    const entryAt = Date.parse(entry.updatedAt || '') || 0;
    const rowAt = Date.parse(priorWrite?.sourceUpdatedAt || rowUpdatedAt || '') || 0;
    if (entryAt < rowAt) { stats.skipped++; continue; }
    try {
      const sourceUpdatedAt = entry.updatedAt;
      const result = await catalogDB.updateIngredientIfFresh(
        ingredientId,
        { name: entry.name, payload: entryToPayload(entry) },
        { sourceUpdatedAt, priorWrite, source: 'sync', actor: 'canon-projection' },
      );
      if (result?.status !== 'written') { stats.skipped++; continue; }
      catalogEvents.emit('primitive-changed', { ingredientId: result.ingredient.id });
      ownWrites.set(ingredientId, { syncSequence: result.ingredient.syncSequence, sourceUpdatedAt });
      stats.written++;
    } catch (err) {
      console.error(`🔁 projectToCatalog: ingredient ${ingredientId} update failed: ${err.message}`);
      stats.skipped++;
    }
  }
  return stats;
}
