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
  findOrCreateUniverseCollection,
  unlinkCollectionsForUniverse,
  addItem,
  ERR_DUPLICATE,
} from '../mediaCollections.js';
import * as seriesSvc from './series.js';
import * as universeSvc from '../universeBuilder.js';

// Per-universe in-flight queue for the *addItem* step. The atomic
// findOrCreateUniverseCollection helper already serializes its own
// read-modify-write on the shared media-collections file (so two first-time
// filings — same universe or two universes that share a display name —
// can't race into duplicate/orphaned records). This queue covers the gap
// between create and addItem: cover + back-cover for the same universe
// arrive together, and two addItem calls against the same collection still
// do their own read-modify-write that can drop one of the two items.
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

// Adds a freshly-rendered cover image to the universe's collection.
// `seriesId` is the bridge — series → universeId → universe → collection.
// Silent no-op when the series has no universe link (a common case for
// quick experiments with no canon yet).
export async function fileCoverIntoUniverseCollection({ seriesId, filename }) {
  if (!seriesId || typeof filename !== 'string' || !filename) return;

  // Pre-queue read: we need a universeId to pick a serialization key.
  // Re-read inside the queued task to catch a series that was unlinked
  // (or moved to another universe) while we waited in the queue.
  const initialSeries = await seriesSvc.getSeries(seriesId).catch(() => null);
  if (!initialSeries?.universeId) return;

  return enqueueForUniverse(initialSeries.universeId, async () => {
    // Re-read series inside the queue — a parallel updateSeries (or another
    // hook) could have unlinked it (universeId=null) or re-pointed it at a
    // different universe while earlier filings for the original universe
    // worked through the queue. Filing into the stale link would
    // mis-attribute the cover.
    const series = await seriesSvc.getSeries(seriesId).catch(() => null);
    if (!series?.universeId || series.universeId !== initialSeries.universeId) return;

    // Revalidate as close as possible to collection creation so we do not
    // stamp a newly-created collection with a universe id/name fetched from a
    // universe that has already been deleted.
    const liveUniverse = await universeSvc.getUniverse(series.universeId).catch(() => null);
    if (!liveUniverse) return;

    // Honor the file header's contract: "Failures are logged and swallowed
    // — bookkeeping must never fail the user's render." A
    // findOrCreateUniverseCollection rejection (validation, I/O) would
    // otherwise reject out of this helper and crash any direct caller that
    // doesn't already wrap it.
    const collection = await findOrCreateUniverseCollection({
      universeId: liveUniverse.id,
      universeName: liveUniverse.name,
      description: `Renders for "${liveUniverse.name}"`,
    }).catch((err) => {
      console.error(`❌ cover → universe collection provision failed for ${filename}: ${err?.message || err}`);
      return null;
    });
    if (!collection) return;

    // Delete-race guard: deleteUniverse may have fired between the
    // getUniverse above and findOrCreateUniverseCollection's write,
    // leaving a freshly-stamped collection bound to a now-deleted
    // universeId (rename-locked, no universe to cascade from). Re-check
    // and release the link so the user gets a normal orphan collection
    // they can rename or delete. Single-user mode makes this rare, but
    // when it does happen the lock is otherwise inescapable.
    const stillExists = await universeSvc.getUniverse(series.universeId).catch(() => null);
    if (!stillExists || stillExists.id !== liveUniverse.id) {
      await unlinkCollectionsForUniverse(series.universeId).catch(() => null);
      return;
    }

    await addItem(collection.id, { kind: 'image', ref: filename }).catch((err) => {
      // A duplicate just means the user re-rendered the same cover into the
      // same slot — not an error worth surfacing.
      if (err?.code === ERR_DUPLICATE) return;
      console.error(`❌ cover → universe collection filing failed for ${filename}: ${err?.message || err}`);
    });
  });
}
