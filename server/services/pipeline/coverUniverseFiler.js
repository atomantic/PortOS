/**
 * Pipeline: auto-file series/volume/issue cover renders into the series'
 * universe collection (universe-linked) or a per-series collection (fallback).
 *
 * Cover renders go through dedicated routes without a `universeRun` tag, so the
 * Universe Builder's collection hook never sees them; without this filing the
 * share-bucket exporter has no `manifest.collection`.
 *
 * The cover filename hooks (seasonCover, comicPages cover/backCover) call
 * `fileCoverIntoAutoCollection` after stamping the filename. Failures are logged
 * and swallowed: bookkeeping must never fail the user's render.
 *
 * **Concurrency.** No per-series queue: every collection write goes through the
 * single file-level write tail in `mediaCollections.js`, so parallel filings for
 * one series interleave their awaits but both filenames land.
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
    // Forward the fetched series so the universe leaf skips its initial read.
    await fileCoverIntoUniverseCollection({ seriesId, filename, _preloadedSeries: series });
    return;
  }
  // The series leaf gets no preload: its own first read is the re-route check for
  // a universe link added after this dispatch.
  await fileCoverIntoSeriesCollection({ seriesId, filename });
}

// Adds a freshly-rendered cover to the universe's collection via
// series -> universeId -> universe -> collection. No-op without a universe link.
//
// `_preloadedSeries` lets the dispatcher skip the initial getSeries; the
// mid-flight re-read below is race-detection and always runs.
export async function fileCoverIntoUniverseCollection({ seriesId, filename, _preloadedSeries } = {}) {
  if (!seriesId || typeof filename !== 'string' || !filename) return;

  // Pin the universeId observed up front; a parallel updateSeries may re-link
  // mid-flight, and every later step compares against this snapshot.
  const initialSeries = _preloadedSeries ?? await seriesSvc.getSeries(seriesId).catch(() => null);
  if (!initialSeries?.universeId) return;
  const universeId = initialSeries.universeId;

  // Re-read so a re-link landed during the previous await is caught.
  const series = await seriesSvc.getSeries(seriesId).catch(() => null);
  if (!series?.universeId || series.universeId !== universeId) return;

  // Resolve the universe as close as possible to the create to avoid stale details.
  const liveUniverse = await universeSvc.getUniverse(universeId).catch(() => null);
  if (!liveUniverse) return;

  // Per the file header, failures are logged and swallowed rather than rejecting
  // out of this helper.
  const collection = await findOrCreateUniverseCollection({
    universeId: liveUniverse.id,
    universeName: liveUniverse.name,
    description: `Renders for "${liveUniverse.name}"`,
  }).catch((err) => {
    console.error(`❌ cover → universe collection provision failed for ${filename}: ${err?.message || err}`);
    return null;
  });
  if (!collection) return;

  // File the render first: a universe deleted mid-flight must not discard the cover.
  await addItem(collection.id, { kind: 'image', ref: filename }).catch((err) => {
    // A duplicate means the same cover was re-rendered into the same slot.
    if (err?.code === ERR_DUPLICATE) return;
    console.error(`❌ cover → universe collection filing failed for ${filename}: ${err?.message || err}`);
  });

  // Delete-race recovery: deleteUniverse may fire before the collection write,
  // leaving a collection bound to a deleted universeId (rename-locked). Unlink it
  // so normal flows can rename/delete it; the cover added above is preserved.
  const stillExists = await universeSvc.getUniverse(universeId).catch(() => null);
  if (!stillExists || stillExists.id !== liveUniverse.id) {
    await unlinkCollectionsForUniverse(universeId).catch((err) => {
      // Log, never silence: a failed unlink leaves a rename-locked collection the
      // operator must find.
      console.error(`❌ cover → universe collection orphan-unlink failed for universe=${universeId}: ${err?.message || err}`);
    });
  }
}

// Per-series fallback when `series.universeId` is null; same delete-race
// recovery as the universe path.
//
// Takes no `_preloadedSeries`: this leaf's first read is the early re-route check
// for a universe link added after the dispatcher's fetch. A stale snapshot would
// file into the per-series bucket and recovery would orphan the cover.
export async function fileCoverIntoSeriesCollection({ seriesId, filename }) {
  if (!seriesId || typeof filename !== 'string' || !filename) return;

  // Re-fetch close to the create so a rename mid-flight stamps the freshest name.
  const liveSeries = await seriesSvc.getSeries(seriesId).catch(() => null);
  if (!liveSeries) return;

  // Re-route if the series has (gained) a universe link: a direct caller may pass
  // an already-linked series, or `updateSeries` may link one after the dispatcher
  // branched. Linked series share one universe collection.
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

  // Recover from (a) deleteSeries or (b) a universe link landing after the
  // earlier read: a seriesId-stamped collection on a deleted or now-linked series
  // would be rename-locked / violate "linked series export under the universe
  // contract". Unlink it; the covers added above are preserved.
  const stillExists = await seriesSvc.getSeries(seriesId).catch(() => null);
  const gainedUniverse = stillExists && stillExists.id === liveSeries.id && stillExists.universeId;
  if (!stillExists || stillExists.id !== liveSeries.id || gainedUniverse) {
    await unlinkCollectionsForSeries(seriesId).catch((err) => {
      console.error(`❌ cover → series collection orphan-unlink failed for series=${seriesId}: ${err?.message || err}`);
    });
  }
}
