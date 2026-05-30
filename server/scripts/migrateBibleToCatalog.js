/**
 * Backfill embedded universe canon into the Creative Ingredients Catalog.
 *
 * Walks every universe, promotes each character/place/object into a catalog
 * row, links it back to the universe via catalog_ingredient_refs, and stamps
 * the new `ingredientId` onto the embedded entry so subsequent edits know
 * which catalog row they own.
 *
 * Series + writers-room works do NOT carry embedded canon — only universes
 * do — so this script touches universes only. (The exploration brief
 * suggested otherwise; the actual on-disk shape is universe-only.)
 *
 * Idempotency: entries with an existing `ingredientId` are skipped. The
 * migration marker lives in `data/catalog-backfill.applied.json` rather than
 * piggy-backing on `data/migrations.applied.json`, which is a JSON array
 * managed by the prompt-replace runner under `scripts/migrations/`.
 *
 * Invoked from server/index.js at boot, after `ensureSchema()`, gated by
 * the marker file so the walk only runs once per install.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';
import { PATHS } from '../lib/fileUtils.js';
import { BIBLE_KINDS, BIBLE_FIELD } from '../lib/storyBible.js';
import { listUniverses, updateUniverse } from '../services/universeBuilder.js';
import * as catalogDB from '../services/catalogDB.js';

const MARKER_VERSION = 1;
const MARKER_FILENAME = 'catalog-backfill.applied.json';

// Derived from BIBLE_KINDS so a future kind added there flows through here
// without a manual update. `kind` is the catalog ingredient `type` (1:1 with
// BIBLE_KIND values today: character/place/object).
const KINDS = BIBLE_KINDS.map((kind) => ({
  kind,
  array: BIBLE_FIELD[kind],
  role: `canon-${kind}`,
}));

const TYPE_PREFIX = { character: 'chr', place: 'plc', object: 'obj' };

/**
 * Deterministic ingredient id derived from (universeId, kind, entry.id).
 *
 * Two peers running this migration independently against the SAME universe
 * (same `entry.id`) compute the SAME catalog id, so the cross-peer LWW merge
 * on the universe payload doesn't orphan one side's catalog row. Random
 * UUIDs here would mint divergent ids on each peer and leave whichever lost
 * the merge with a dangling catalog row.
 *
 * The `bible:` prefix tags the seed so a future deterministic-id source
 * (e.g. content-hash based) won't collide.
 */
function deterministicIngredientId(universeId, kind, entryId) {
  const prefix = TYPE_PREFIX[kind];
  if (!prefix) throw new Error(`deterministicIngredientId: unknown kind ${kind}`);
  const seed = `bible:universe:${universeId}:${kind}:${entryId}`;
  // 64-bit hex slice is plenty — collision odds at our scale are nil and the
  // id stays short enough to read in URLs and logs.
  const hash = createHash('sha256').update(seed).digest('hex').slice(0, 32);
  return `cat-${prefix}-bible-${hash}`;
}

async function readMarker() {
  const path = join(PATHS.data, MARKER_FILENAME);
  const raw = await readFile(path, 'utf-8').catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function writeMarker(payload) {
  const path = join(PATHS.data, MARKER_FILENAME);
  await writeFile(path, JSON.stringify(payload, null, 2), 'utf-8');
}

/**
 * Promote a single embedded canon entry to a catalog ingredient.
 *
 * The target id is DETERMINISTIC (`deterministicIngredientId`) — every peer
 * computes the same id for the same `(universeId, kind, entry.id)`, so peers
 * that run this migration independently against the same universe converge
 * on the same catalog row instead of minting divergent ids that would orphan
 * one side on the next universe LWW merge.
 *
 * Three cases:
 *  - Entry has no `ingredientId` → insert the deterministic row, link, return
 *    the id so the caller stamps the embedded record.
 *  - Entry already has the deterministic `ingredientId` → already promoted;
 *    ensure the ref link exists, skip.
 *  - Entry has a foreign `ingredientId` (legacy random-UUID id from a peer on
 *    a pre-deterministic build) → recreate locally with the explicit foreign
 *    id so cross-peer identity holds, until the network re-converges.
 */
async function promoteEntry({ universeId, universeName, entry, kind, role }) {
  if (!entry?.name || !entry?.id) return { skipped: true, reason: 'missing-id-or-name' };

  const payload = { ...entry };
  delete payload.id;
  delete payload.ingredientId;
  delete payload.createdAt;
  delete payload.updatedAt;

  // Friendly universe-name tag (e.g. "My Cool Universe") instead of the legacy
  // machine tags (`from-universe` + `universe:<uuid>`) — the structured link
  // already lives durably in catalog_ingredient_refs (refKind universe, role
  // canon-<kind>), so the tag is purely a human-readable affordance and never
  // needs the id. Existing rows with the old machine tags are repaired
  // separately by server/scripts/repairUniverseTags.js. Audit/system tags go
  // last so a `.slice(-N)` overflow preserves them over trimmed user tags.
  const friendlyName = typeof universeName === 'string' ? universeName.trim() : '';
  const systemTags = friendlyName ? [friendlyName] : [];
  const userTags = Array.isArray(entry.tags) ? entry.tags : [];
  const tags = [...userTags, ...systemTags].slice(-12);

  const targetId = entry.ingredientId || deterministicIngredientId(universeId, kind, entry.id);

  const existing = await catalogDB.getIngredient(targetId);
  if (existing) {
    await catalogDB.linkIngredientToRef(targetId, 'universe', universeId, role);
    // Stamp if the embedded entry hasn't recorded the id yet (first-time
    // promotion via deterministic id; previously had a different/no id).
    if (entry.ingredientId !== targetId) {
      return { ingredientId: targetId, name: entry.name };
    }
    return { skipped: true, reason: 'already-promoted' };
  }

  // Soft-deleted recovery: if a row exists at this id but marked deleted,
  // un-delete it rather than letting the next INSERT hit a PK conflict.
  const undeleted = await catalogDB.reviveDeletedIngredient(targetId, {
    type: kind, name: entry.name, payload, tags,
  }).catch(() => null);
  if (undeleted) {
    await catalogDB.linkIngredientToRef(targetId, 'universe', universeId, role);
    return entry.ingredientId === targetId
      ? { skipped: true, reason: 'undeleted' }
      : { ingredientId: targetId, name: entry.name };
  }

  const ing = await catalogDB.createIngredient({
    id: targetId, type: kind, name: entry.name, payload, tags,
  });
  await catalogDB.linkIngredientToRef(ing.id, 'universe', universeId, role);
  return { ingredientId: ing.id, name: entry.name };
}

/**
 * Walk one universe — for each kind (character/place/object), promote every
 * not-yet-promoted entry and stamp the new ingredientId back on the embedded
 * record. Returns per-kind counts.
 *
 * Uses the universe write path's mutator overload so the queued write picks
 * up the freshest in-memory snapshot — concurrent edits during boot won't
 * race the migration.
 */
async function migrateUniverse(universe) {
  const stats = { promoted: 0, skipped: 0, peerReconciled: 0, errors: 0 };
  // Promote each entry, collecting new ingredient ids keyed by entry id.
  // Done OUTSIDE the universe write queue so DB inserts don't block other
  // universe edits during boot.
  const newIds = {};
  for (const { array, kind, role } of KINDS) {
    const list = Array.isArray(universe[array]) ? universe[array] : [];
    newIds[array] = {};
    for (const entry of list) {
      if (!entry?.id) continue;
      try {
        const result = await promoteEntry({ universeId: universe.id, universeName: universe.name, entry, kind, role });
        if (result.peerReconciled) {
          stats.peerReconciled++;
          continue;
        }
        if (result.skipped) {
          stats.skipped++;
          continue;
        }
        newIds[array][entry.id] = result.ingredientId;
        stats.promoted++;
      } catch (err) {
        console.error(`🪄 promote failed (${universe.id}/${array}/${entry.name}): ${err.message}`);
        stats.errors++;
      }
    }
  }

  // Phase 2: stamp ingredientId back onto the embedded entries. Skip if
  // nothing was promoted on this universe so we don't bump updatedAt for no
  // reason.
  const hadAnyPromotion = KINDS.some(({ array }) => Object.keys(newIds[array]).length > 0);
  if (!hadAnyPromotion) return stats;

  // `silent: true` suppresses the per-universe peer-sync fan-out — without
  // this, every install would emit N recordUpdated events at boot post-
  // upgrade (one per universe with any new promotion), each fanning out to
  // every peer. Peers pick up the ingredient-id stamps on the next normal
  // sync cycle.
  await updateUniverse(universe.id, (cur) => {
    const patch = {};
    for (const { array } of KINDS) {
      const ids = newIds[array];
      if (Object.keys(ids).length === 0) continue;
      const list = Array.isArray(cur[array]) ? cur[array] : [];
      patch[array] = list.map((entry) => {
        const newId = ids[entry?.id];
        return newId ? { ...entry, ingredientId: newId } : entry;
      });
    }
    return Object.keys(patch).length > 0 ? patch : null;
  }, { silent: true });

  return stats;
}

/**
 * Public entry point. Runs the migration once, then no-ops on every
 * subsequent boot. Wired into server/index.js after ensureSchema().
 */
export async function migrateBibleToCatalog({ force = false } = {}) {
  const marker = await readMarker();
  if (marker?.version === MARKER_VERSION && !force) {
    return { skipped: true, marker };
  }

  console.log('🪄 bible→catalog migration: starting');
  const universes = await listUniverses({ includeDeleted: false });

  const totals = { universesScanned: 0, promoted: 0, peerReconciled: 0, skipped: 0, errors: 0 };
  for (const universe of universes) {
    if (universe.deleted) continue;
    const result = await migrateUniverse(universe);
    totals.universesScanned++;
    totals.promoted += result.promoted;
    totals.peerReconciled += result.peerReconciled;
    totals.skipped += result.skipped;
    totals.errors += result.errors;
  }

  const payload = {
    version: MARKER_VERSION,
    completedAt: new Date().toISOString(),
    stats: totals,
  };
  await writeMarker(payload);

  console.log(
    `🪄 bible→catalog migration: ${totals.universesScanned} universes scanned, ` +
    `${totals.promoted} promoted, ${totals.peerReconciled} peer-reconciled, ` +
    `${totals.skipped} skipped, ${totals.errors} errors`,
  );

  return { skipped: false, ...payload };
}
