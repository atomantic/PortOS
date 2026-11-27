/**
 * Media Collections
 *
 * User-named buckets for image filenames + video ids. Many-to-many: the same
 * media item can live in any number of collections at once. Persisted via the
 * per-record `createCollectionStore` layout under data/media-collections/ —
 * one `{id}/index.json` per collection plus a type-level `index.json` stamping
 * the storage `schemaVersion`. (Migrated from the legacy monolithic
 * data/media-collections.json by scripts/migrations/059-split-media-collections.js.)
 *
 * Storage: `file-primary` today (target: `db-primary` link tables pointing at
 * `asset-file-db-indexed` bytes) — federates through the `mediaCollections` sync
 * category, which implies the `videoHistory` snapshot for the rows it references.
 *
 * An item is identified by `{ kind: 'image'|'video', ref: <filename|videoId> }`.
 * A collection's `coverKey` is `null` (auto: newest item) or `"<kind>:<ref>"`
 * to pin a specific item as the cover thumbnail.
 *
 * **Concurrency.** Every public mutator routes its read-modify-write through
 * the store's per-record queue (`store().queueRecordWrite(id, fn)`), so two
 * writes against the SAME collection serialize while writes against DIFFERENT
 * collections run in parallel. This replaces the legacy single-tail file queue
 * that serialized every unrelated write and rewrote the whole ~200 KB document
 * per item. The hot render-filing paths (pipeline cover filer, Universe Builder
 * completion hook, image-gen auto-file) all target deterministic `uc-`/`sc-`
 * ids, so concurrent `addItem`s to the same bucket still serialize correctly.
 */

export {
  COLLECTION_SOURCES, DESCRIPTION_MAX_LENGTH, ERR_DUPLICATE, ERR_INCOMPLETE_INVENTORY,
  ERR_NOT_FOUND, ERR_VALIDATION, ITEMS_MAX, NAME_MAX_LENGTH, REF_MAX_LENGTH, getCollection,
  itemKey, listCollectionIds, listCollections, mediaCollectionStore,
} from './mediaCollections/collectionStore.js';
export {
  addItem, bulkUpdateCollectionItems, createCollection, deleteCollection, isOwnerManaged,
  joinCollections, removeItem, removeItemFromAllCollections, setCollectionPrimaryMachine,
  updateCollection,
} from './mediaCollections/collectionEdits.js';
export {
  CATALOG_TYPE_COLLECTIONS, EXTERNAL_COLLECTION_ID, commissionCollectionId,
  commissionCollectionNameFor, findCollectionBySeriesId, findCollectionByUniverseId,
  findOrCreateCatalogTypeCollection, findOrCreateCollectionByName,
  findOrCreateCommissionCollection, findOrCreateCompositionsCollection, findOrCreateDeckCollection,
  findOrCreateExternalCollection, findOrCreateFableLoomCollection, findOrCreateMoodBoardCollection,
  findOrCreateMusicVideoCollection, findOrCreateSeriesCollection, findOrCreateSpriteCollection,
  findOrCreateStoryboardCollection, findOrCreateTimelineCollection, findOrCreateUniverseCollection,
  linkedCollectionId, moodBoardCollectionId, musicVideoCollectionId, musicVideoCollectionNameFor,
  renameCollectionForSeries, renameCollectionForUniverse, seriesCollectionNameFor,
  universeCollectionNameFor, unlinkCollectionsForSeries, unlinkCollectionsForUniverse,
} from './mediaCollections/ownerAdapters.js';
export {
  mergeMediaCollectionsFromSync, pruneCollectionItemRemovals, pruneTombstonedCollections,
} from './mediaCollections/syncMerge.js';
