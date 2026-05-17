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
 *
 * **Concurrency.** No per-universe queue is needed here. Every collection
 * write the helper makes (findOrCreateUniverseCollection, addItem,
 * unlinkCollectionsForUniverse) routes through the single file-level write
 * tail in `mediaCollections.js`. Two parallel filings for the same universe
 * (cover + back-cover from the same render burst) interleave their own
 * `await` points freely; the file tail serializes the *writes* so both
 * filenames land and neither orphans the collection.
 */

import {
  findOrCreateUniverseCollection,
  unlinkCollectionsForUniverse,
  addItem,
  ERR_DUPLICATE,
} from '../mediaCollections.js';
import * as seriesSvc from './series.js';
import * as universeSvc from '../universeBuilder.js';

// Adds a freshly-rendered cover image to the universe's collection.
// `seriesId` is the bridge — series → universeId → universe → collection.
// Silent no-op when the series has no universe link (a common case for
// quick experiments with no canon yet).
export async function fileCoverIntoUniverseCollection({ seriesId, filename }) {
  if (!seriesId || typeof filename !== 'string' || !filename) return;

  // Pin the universeId we observed up front. After this await the series's
  // link could change (a parallel updateSeries unlinks or re-points it);
  // every downstream step compares against this snapshot so a mid-flight
  // re-link doesn't mis-attribute the cover to the new universe.
  const initialSeries = await seriesSvc.getSeries(seriesId).catch(() => null);
  if (!initialSeries?.universeId) return;
  const universeId = initialSeries.universeId;

  // Re-read series before the universe lookup so a re-link landed during
  // the previous await is caught before we resolve the universe payload.
  const series = await seriesSvc.getSeries(seriesId).catch(() => null);
  if (!series?.universeId || series.universeId !== universeId) return;

  // Resolve the universe as close as possible to the create so we don't
  // stamp a newly-created collection with stale universe details.
  const liveUniverse = await universeSvc.getUniverse(universeId).catch(() => null);
  if (!liveUniverse) return;

  // Honor the file header's contract: failures are logged and swallowed.
  // A findOrCreateUniverseCollection rejection (validation, I/O) would
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

  // File the render first, regardless of what happened to the universe
  // mid-flight. The user's cover is real work — we never throw it away
  // just because the universe got deleted between findOrCreate and now.
  await addItem(collection.id, { kind: 'image', ref: filename }).catch((err) => {
    // A duplicate just means the user re-rendered the same cover into the
    // same slot — not an error worth surfacing.
    if (err?.code === ERR_DUPLICATE) return;
    console.error(`❌ cover → universe collection filing failed for ${filename}: ${err?.message || err}`);
  });

  // Delete-race recovery: deleteUniverse may have fired between the
  // initial getUniverse and findOrCreateUniverseCollection's write,
  // leaving the freshly-stamped collection bound to a now-deleted
  // universeId — rename-locked with no universe to cascade from. Unlink
  // the collection so the user can rename or delete it via normal flows;
  // the cover added above is preserved in the (now-orphaned) bucket
  // instead of being thrown away with the universe.
  const stillExists = await universeSvc.getUniverse(universeId).catch(() => null);
  if (!stillExists || stillExists.id !== liveUniverse.id) {
    await unlinkCollectionsForUniverse(universeId).catch((err) => {
      // Log per the file header: bookkeeping failures are swallowed but
      // never silenced. If this unlink fails, the just-stamped collection
      // stays bound to a deleted universeId (rename-locked) and the
      // operator needs the log entry to find + fix it.
      console.error(`❌ cover → universe collection orphan-unlink failed for universe=${universeId}: ${err?.message || err}`);
    });
  }
}
