/**
 * Pipeline — auto-file series/volume/issue cover renders into a Universe's
 * media collection.
 *
 * The Universe Builder already maintains a `Universe: <name>` collection per
 * universe (`server/services/universeBuilderCollectionHook.js` files render
 * jobs into it by tag). Pipeline cover renders bypass that hook — they go
 * through dedicated routes that don't carry a `universeRun` tag — so without
 * this helper, a series/volume/issue cover image renders into the gallery
 * but never lands in the universe's collection alongside the universe's own
 * concept art.
 *
 * The two cover filename hooks (seasonCover, comicPages cover/backCover)
 * call into this helper after they finish stamping the filename on the
 * stage record. Failures are logged and swallowed — bookkeeping must never
 * fail the user's render.
 */

import {
  findCollectionByUniverseId,
  findOrCreateCollectionByName,
  createCollectionForUniverse,
  universeCollectionNameFor,
  listCollections,
  addItem,
  ERR_DUPLICATE,
} from '../mediaCollections.js';
import * as seriesSvc from './series.js';
import * as universeSvc from '../universeBuilder.js';

// Per-universe in-flight queue. Cover + back-cover (or two parallel re-renders)
// for the same universe can complete in close succession. Without a queue the
// "no linked collection → create" branch runs concurrently and both branches
// race through `findOrCreateCollectionByName`, persisting two collections of
// the same name (one overwrites the other on the next write, leaving an
// orphan id that `addItem` then targets — drop a render). Serializing per
// universe keeps the create-or-find atomic. The Map is bounded by active
// universes; entries are pruned in `.finally`.
const universeFilingQueues = new Map();

const enqueueForUniverse = (universeId, task) => {
  const prev = universeFilingQueues.get(universeId) || Promise.resolve();
  const next = prev.then(task, task).finally(() => {
    // Only clear the slot if no one else chained onto it after us — otherwise
    // the next task in the chain stops being serialized.
    if (universeFilingQueues.get(universeId) === next) {
      universeFilingQueues.delete(universeId);
    }
  });
  universeFilingQueues.set(universeId, next);
  return next;
};

// Find a collection by the universe's canonical "Universe: <name>" key, but
// only return collections that are unlinked OR already linked to THIS
// universe. The legacy fallback in `findOrCreateCollectionByName` is name-
// only, so two distinct universes that share a name would otherwise share a
// bucket (and the second universe's renders would silently land in the
// first's collection). When no safe match exists, returns null so the caller
// creates a fresh, properly-linked collection.
const findSafeNameMatch = async (name, universeId) => {
  // Cheap path: an existing same-universeId collection — already covered by
  // findCollectionByUniverseId at the caller, but keep the contract local.
  const linked = await findCollectionByUniverseId(universeId);
  if (linked && linked.name === name) return linked;
  // Reuse-by-name is only safe for collections with no universeId stamp at
  // all (legacy buckets from before the link existed). A non-matching
  // universeId means someone else owns that name — never adopt it.
  const all = await listCollections();
  const needle = name.toLowerCase();
  const candidate = all.find((c) => c.name.toLowerCase() === needle);
  if (!candidate) return null;
  if (!candidate.universeId) return candidate; // legacy unlinked — safe to backfill
  if (candidate.universeId === universeId) return candidate;
  return null;
};

// Adds a freshly-rendered cover image to the universe's collection.
// `seriesId` is the bridge — series → universeId → universe → collection.
// Silent no-op when the series has no universe link (a common case for
// quick experiments with no canon yet).
export async function fileCoverIntoUniverseCollection({ seriesId, filename }) {
  if (!seriesId || typeof filename !== 'string' || !filename) return;

  const series = await seriesSvc.getSeries(seriesId).catch(() => null);
  if (!series?.universeId) return;

  return enqueueForUniverse(series.universeId, async () => {
    // Prefer the universeId stamp — survives a hand-renamed collection that
    // the rename-lock blocks today but legacy data may still carry. Skip the
    // universe lookup entirely when it hits (the steady-state case after the
    // first render).
    let collection = await findCollectionByUniverseId(series.universeId);
    if (!collection) {
      const universe = await universeSvc.getUniverse(series.universeId).catch(() => null);
      if (!universe) return;
      const desiredName = universeCollectionNameFor(universe.name);
      // Tighter name-based fallback: never adopt a name match owned by a
      // different universe. `findOrCreateCollectionByName` matches on name
      // alone, so an unrelated universe with the same name would otherwise
      // hijack this universe's renders.
      const safe = await findSafeNameMatch(desiredName, universe.id);
      if (safe) {
        // Either an existing same-universeId collection (fast path) or a
        // legacy unlinked bucket safe to backfill. findOrCreateCollectionByName
        // does the lazy-backfill in one write when universeId is missing.
        collection = await findOrCreateCollectionByName({
          name: desiredName,
          description: `Renders for "${universe.name}"`,
          universeId: universe.id,
        });
      } else {
        // No safe name match — the canonical name is already taken by a
        // collection linked to a different universe. Skip the name-match
        // path entirely (it would adopt the foreign bucket) and create a
        // fresh, properly-stamped collection. Two collections with the same
        // visible name is the user-correctable case; corrupting the foreign
        // universe's bucket is not.
        collection = await createCollectionForUniverse({
          name: desiredName,
          description: `Renders for "${universe.name}"`,
          universeId: universe.id,
        });
      }
    }

    await addItem(collection.id, { kind: 'image', ref: filename }).catch((err) => {
      // A duplicate just means the user re-rendered the same cover into the
      // same slot — not an error worth surfacing.
      if (err?.code === ERR_DUPLICATE) return;
      console.error(`❌ cover → universe collection filing failed for ${filename}: ${err?.message || err}`);
    });
  });
}

