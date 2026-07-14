/**
 * One-time boot reconciliation: collapse any pre-existing divergence between an
 * embedded universe-canon entry and its `catalog_ingredients` row.
 *
 * Before the bidirectional projection (server/services/catalogCanonProjection.js)
 * landed, the Catalog detail page and the Universe Builder canon surface were
 * copy-on-write mirrors — an edit on either side went stale on the other. On
 * the first boot after the upgrade, those two stores can already disagree. This
 * repair walks every universe canon entry that carries an `ingredientId`,
 * LWW-merges the embedded payload vs the catalog payload on `updatedAt`, and
 * writes the WINNER to BOTH sides so they converge. From then on the live
 * projection keeps them in lockstep.
 *
 * Writes:
 *   - universe side: `updateUniverse(..., { silent })` — silent suppresses the
 *     per-universe peer-sync fan-out (this is a local data repair, not a user
 *     edit; peers reconcile on their own boot).
 *   - catalog side: `updateIngredient(..., { source: 'sync' })` so the rewrite
 *     reads as a system reconciliation in the revision history, not a user edit.
 *
 * Idempotent + marker-gated (`data/catalog-canon-reconcile.applied.json`): once
 * a clean pass completes, every subsequent boot is a no-op. A second run over
 * already-converged rows is a no-op anyway (the LWW comparison finds them
 * equal-or-fresher and writes nothing material).
 *
 * The corresponding `scripts/migrations/055-reconcile-canon-catalog.js` is a
 * registration stub for the migration ledger — the actual repair runs here
 * (boot-time) because the `scripts/migrations/` runner executes before the DB
 * pool is up (same reason migrations 048–053 are boot-time + stubbed).
 *
 * Invoked from server/index.js at boot, after `ensureSchema()` + the bible→
 * catalog backfill + `migrateCatalogPayload`, so every promoted row exists and
 * is at its current payload-shape version before this reconciles content.
 */

import { readMarker, writeMarker } from '../lib/migrationMarker.js';
import { BIBLE_FIELD } from '../lib/storyBible.js';
import { listUniverses, updateUniverse } from '../services/universeBuilder.js';
import * as catalogDB from '../services/catalogDB.js';
// Reuse the live projection's canon-entry→payload strip so a reconcile and a
// live projection produce byte-identical catalog payloads (a divergent rule
// would re-introduce the very drift this repair exists to collapse).
import { entryToPayload } from '../services/catalogCanonProjection.js';

const MARKER_VERSION = 1;
const MARKER_FILENAME = 'catalog-canon-reconcile.applied.json';

const CANON_ARRAY_KEYS = Object.values(BIBLE_FIELD);     // ['characters','places','objects']

/**
 * Public entry point. Walk every universe canon entry with an `ingredientId`,
 * LWW-merge embedded vs catalog payload, write the winner to both sides.
 * `force` re-runs past the marker (tests / admin re-trigger).
 */
export async function reconcileCanonCatalog({ force = false } = {}) {
  const marker = await readMarker(MARKER_FILENAME);
  if (marker?.version === MARKER_VERSION && !force) {
    return { skipped: true, marker };
  }

  console.log('🔁 canon↔catalog reconcile: starting');
  const universes = await listUniverses({ includeDeleted: false });
  const totals = { universesScanned: 0, scanned: 0, catalogWon: 0, canonWon: 0, errors: 0 };

  // Stable snapshot of each catalog row's ORIGINAL `updatedAt` clock, keyed by
  // ingredientId, captured the first time we see the row. The same ingredient
  // can be embedded in multiple universes; writing a canon-winner bumps the
  // row's `updated_at` to NOW(), which — without this snapshot — would make a
  // LATER universe's genuinely-newer embedded copy lose to the artificially
  // fresh row and get clobbered. Comparing every universe against the pre-pass
  // clock keeps the winner determination stable across the whole reconcile.
  const rowClockAtStart = new Map();
  // High-water mark of the canon-winner clock already written to each catalog
  // row this pass. When the same ingredient is embedded in several universes
  // and more than one copy beats the ORIGINAL row, only the NEWEST embedded
  // copy may win — a later but older copy must not clobber the newer one we
  // already wrote.
  const canonWinnerClock = new Map();

  for (const universe of universes) {
    if (universe.deleted) continue;
    totals.universesScanned++;
    // Collect per-array, per-entry-id the winning payload to stamp back onto the
    // embedded entries in ONE silent updateUniverse below. The catalog side is
    // written inline (one updateIngredient per catalog-loser).
    const canonPatches = {};                              // arrayKey -> { entryId -> winningEntryFields }
    for (const arrayKey of CANON_ARRAY_KEYS) {
      const list = Array.isArray(universe[arrayKey]) ? universe[arrayKey] : [];
      for (const entry of list) {
        const ingredientId = entry?.ingredientId;
        if (!ingredientId || !entry?.id) continue;          // entries without ingredientId untouched
        totals.scanned++;
        try {
          const row = await catalogDB.getIngredient(ingredientId);
          if (!row) continue;                               // dangling backlink — leave both sides alone
          const entryAt = Date.parse(entry.updatedAt || '') || 0;
          // Compare against the row's clock AS OF the start of this pass, not
          // its live value — a canon-winner write earlier in the pass bumped
          // `updated_at` to now and would otherwise wrongly win here.
          if (!rowClockAtStart.has(ingredientId)) {
            rowClockAtStart.set(ingredientId, Date.parse(row.updatedAt || '') || 0);
          }
          const rowAt = rowClockAtStart.get(ingredientId);
          if (rowAt > entryAt) {
            // Catalog row is newer → it wins. Stamp its name+payload onto the
            // embedded entry (silent universe write below).
            (canonPatches[arrayKey] ||= {})[entry.id] = {
              ...entryToPayload(row.payload || {}),
              name: row.name,
              ingredientId,
              updatedAt: row.updatedAt,
            };
            totals.catalogWon++;
          } else if (entryAt > rowAt && entryAt > (canonWinnerClock.get(ingredientId) || 0)) {
            // Embedded entry beats the original row AND any canon-winner already
            // written this pass → it wins. Write it into the catalog row and
            // raise the high-water mark so an older sibling copy can't clobber it.
            await catalogDB.updateIngredient(
              ingredientId,
              { name: entry.name, payload: entryToPayload(entry) },
              { source: 'sync', actor: 'canon-catalog-reconcile' },
            );
            canonWinnerClock.set(ingredientId, entryAt);
            totals.canonWon++;
          }
          // Equal timestamps → already converged; nothing to do.
        } catch (err) {
          console.error(`🔁 reconcile failed (${universe.id}/${arrayKey}/${ingredientId}): ${err.message}`);
          totals.errors++;
        }
      }
    }

    // Stamp catalog-winner payloads back onto the embedded entries in one silent
    // write per universe (skips when the catalog never won on this universe).
    const hasCanonPatch = Object.keys(canonPatches).some((k) => Object.keys(canonPatches[k]).length > 0);
    if (hasCanonPatch) {
      await updateUniverse(universe.id, (cur) => {
        const patch = {};
        for (const arrayKey of CANON_ARRAY_KEYS) {
          const byId = canonPatches[arrayKey];
          if (!byId || Object.keys(byId).length === 0) continue;
          const list = Array.isArray(cur[arrayKey]) ? cur[arrayKey] : [];
          patch[arrayKey] = list.map((e) => {
            const win = e?.id ? byId[e.id] : null;
            return win ? { ...e, ...win } : e;
          });
        }
        return Object.keys(patch).length > 0 ? patch : null;
      }, { silent: true }).catch((err) => {
        console.error(`🔁 reconcile: universe ${universe.id} canon stamp failed: ${err.message}`);
        totals.errors++;
      });
    }
  }

  const payload = { version: MARKER_VERSION, completedAt: new Date().toISOString(), stats: totals };
  // Only stamp the completion marker on a clean pass — a row-level failure
  // withholds it so the (idempotent) reconcile retries next boot.
  const wroteMarker = totals.errors === 0;
  if (wroteMarker) await writeMarker(MARKER_FILENAME, payload);

  console.log(
    `🔁 canon↔catalog reconcile: ${totals.universesScanned} universes, ${totals.scanned} entries scanned, ` +
    `${totals.catalogWon} catalog-won, ${totals.canonWon} canon-won, ${totals.errors} errors` +
    (wroteMarker ? '' : ' — marker NOT written (will retry next boot)'),
  );

  return { skipped: false, markerWritten: wroteMarker, ...payload };
}
