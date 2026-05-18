/**
 * Pipeline — auto-file series/volume/issue cover renders into either the
 * series' universe collection (when the series is universe-linked) or a
 * per-series collection (fallback for series without a universe).
 *
 * The Universe Builder already maintains a `Universe: <name>` collection per
 * universe (`server/services/universeBuilderCollectionHook.js` files render
 * jobs into it by tag). Pipeline cover renders bypass that hook — they go
 * through dedicated routes that don't carry a `universeRun` tag — so without
 * this helper, a series/volume/issue cover image renders into the gallery
 * but never lands in any collection. Without a collection to bundle, the
 * share-bucket exporter has nothing to put in `manifest.collection` either.
 *
 * The two cover filename hooks (seasonCover, comicPages cover/backCover)
 * call `fileCoverIntoAutoCollection` after they finish stamping the
 * filename on the stage record. Failures are logged and swallowed —
 * bookkeeping must never fail the user's render.
 *
 * **Concurrency.** No per-universe/per-series queue is needed here. Every
 * collection write routes through the single file-level write tail in
 * `mediaCollections.js`. Two parallel filings for the same series (cover +
 * back-cover from the same render burst) interleave their own `await`
 * points freely; the file tail serializes the *writes* so both filenames
 * land and neither orphans the collection.
 */

import {
  findOrCreateUniverseCollection,
  findOrCreateSeriesCollection,
  unlinkCollectionsForUniverse,
  unlinkCollectionsForSeries,
  addItem,
  ERR_DUPLICATE,
} from '../mediaCollections.js';
import * as seriesSvc from './series.js';
import * as universeSvc from '../universeBuilder.js';

/**
 * Dispatch a freshly-rendered cover image to whichever auto-collection the
 * series qualifies for: universe-linked first, per-series fallback when
 * the series has no universeId. Silent no-op for missing/invalid input.
 */
export async function fileCoverIntoAutoCollection({ seriesId, filename }) {
  if (!seriesId || typeof filename !== 'string' || !filename) return;
  const series = await seriesSvc.getSeries(seriesId).catch(() => null);
  if (!series) return;
  if (series.universeId) {
    // Forward the dispatcher's fetched series so the universe leaf can
    // skip its initial getSeries pin — its job there is just to capture
    // the universeId, which is already in hand. The leaf still re-reads
    // mid-flight for race-detection.
    await fileCoverIntoUniverseCollection({ seriesId, filename, _preloadedSeries: series });
    return;
  }
  // Series-leaf intentionally does NOT receive a preload: its own first
  // read is the early re-route check for "universe link added between
  // dispatcher and leaf entry" — collapsing that to the dispatcher's
  // earlier read would let a newly-linked series land in the per-series
  // collection (and just get orphaned by recovery) instead of being
  // re-routed into the universe collection.
  await fileCoverIntoSeriesCollection({ seriesId, filename });
}

// Adds a freshly-rendered cover image to the universe's collection.
// `seriesId` is the bridge — series → universeId → universe → collection.
// Silent no-op when the series has no universe link (a common case for
// quick experiments with no canon yet).
//
// `_preloadedSeries` is an internal optimization hook: the dispatcher
// (`fileCoverIntoAutoCollection`) has already fetched the series record
// purely to branch — passing it through here skips the initial getSeries
// read. The mid-flight re-read below is intentional race-detection and
// is preserved either way.
export async function fileCoverIntoUniverseCollection({ seriesId, filename, _preloadedSeries } = {}) {
  if (!seriesId || typeof filename !== 'string' || !filename) return;

  // Pin the universeId we observed up front. After this await the series's
  // link could change (a parallel updateSeries unlinks or re-points it);
  // every downstream step compares against this snapshot so a mid-flight
  // re-link doesn't mis-attribute the cover to the new universe.
  const initialSeries = _preloadedSeries ?? await seriesSvc.getSeries(seriesId).catch(() => null);
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

// Per-series fallback when `series.universeId` is null. Same shape +
// delete-race recovery as the universe path above.
//
// This leaf does NOT accept a `_preloadedSeries` arg from the dispatcher
// even though the universe leaf does. The reason: this leaf's first read
// (below) is the *early re-route check* for "a universe link was added
// between the dispatcher's fetch and this leaf's entry." If we collapsed
// that read to the dispatcher's earlier snapshot, a newly-linked series
// would proceed down the per-series path and get filed into the wrong
// bucket — the post-`addItem` recovery would then unlink it, leaving the
// cover orphaned instead of where it belonged (the universe collection).
export async function fileCoverIntoSeriesCollection({ seriesId, filename }) {
  if (!seriesId || typeof filename !== 'string' || !filename) return;

  // Re-fetch close to the create so a series rename mid-flight stamps the
  // collection with the freshest name.
  const liveSeries = await seriesSvc.getSeries(seriesId).catch(() => null);
  if (!liveSeries) return;

  // Re-route if the series has (gained) a universe link. Two ways this matters:
  // (a) this helper is exported and a direct caller may invoke it for an
  // already-linked series — without the guard we'd stamp a per-series bucket
  // even though linked series are supposed to use the universe collection;
  // (b) when called via the dispatcher, `updateSeries` could land a universe
  // link between the dispatcher's branch and this fetch. Either way, defer
  // to the universe path so all linked series share one universe collection.
  if (liveSeries.universeId) {
    await fileCoverIntoUniverseCollection({ seriesId, filename });
    return;
  }

  const collection = await findOrCreateSeriesCollection({
    seriesId: liveSeries.id,
    seriesName: liveSeries.name,
    description: `Renders for "${liveSeries.name}"`,
  }).catch((err) => {
    console.error(`❌ cover → series collection provision failed for ${filename}: ${err?.message || err}`);
    return null;
  });
  if (!collection) return;

  await addItem(collection.id, { kind: 'image', ref: filename }).catch((err) => {
    if (err?.code === ERR_DUPLICATE) return;
    console.error(`❌ cover → series collection filing failed for ${filename}: ${err?.message || err}`);
  });

  // Delete- and re-link-race recovery. Two failure modes after the addItem:
  //   (a) deleteSeries fired between getSeries and the collection write
  //       → leaves a seriesId-stamped collection bound to a now-deleted
  //       series (rename-locked with no series to cascade from);
  //   (b) updateSeries linked the series to a universe between the earlier
  //       liveSeries read and the write → leaves a seriesId-stamped
  //       collection on a universe-linked series, which violates the
  //       "linked series export under the universe contract" invariant and
  //       would otherwise be picked up by the exporter's per-series fallback.
  // Both recoveries unlink the per-series collection so it becomes a normal
  // user-owned bucket; the covers added above are preserved either way.
  const stillExists = await seriesSvc.getSeries(seriesId).catch(() => null);
  const gainedUniverse = stillExists && stillExists.id === liveSeries.id && stillExists.universeId;
  if (!stillExists || stillExists.id !== liveSeries.id || gainedUniverse) {
    await unlinkCollectionsForSeries(seriesId).catch((err) => {
      console.error(`❌ cover → series collection orphan-unlink failed for series=${seriesId}: ${err?.message || err}`);
    });
  }
}
