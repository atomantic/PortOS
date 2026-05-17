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
  universeCollectionNameFor,
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

  const series = await seriesSvc.getSeries(seriesId).catch(() => null);
  if (!series?.universeId) return;

  // Prefer the universeId stamp — survives a hand-renamed collection that
  // the rename-lock blocks today but legacy data may still carry. Skip the
  // universe lookup entirely when it hits (the steady-state case after the
  // first render).
  let collection = await findCollectionByUniverseId(series.universeId);
  if (!collection) {
    const universe = await universeSvc.getUniverse(series.universeId).catch(() => null);
    if (!universe) return;
    collection = await findOrCreateCollectionByName({
      name: universeCollectionNameFor(universe.name),
      description: `Renders for "${universe.name}"`,
      universeId: universe.id,
    });
  }

  await addItem(collection.id, { kind: 'image', ref: filename }).catch((err) => {
    // A duplicate just means the user re-rendered the same cover into the
    // same slot — not an error worth surfacing.
    if (err?.code === ERR_DUPLICATE) return;
    console.error(`❌ cover → universe collection filing failed for ${filename}: ${err?.message || err}`);
  });
}
