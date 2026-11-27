/** Public Brain storage API shared by local features and peer sync. */
import { clearLogCaches } from './brainStorage/logStore.js';
import { brainEvents, clearRecordIndexes } from './brainStorage/recordStore.js';

export * from './brainStorage/entityFacades.js';
export * from './brainStorage/peerMerge.js';
export {
  createDigest, createReview, ensureBrainDir, getDigests, getLatestDigest, getLatestReview,
  getReviews, loadMeta, saveMeta, updateMeta,
} from './brainStorage/logStore.js';
export {
  BRAIN_ENTITY_TYPES, BRAIN_STORE_SCHEMA_VERSION, brainCollectionStores, brainEvents,
  create, generateId, getAll, getById, getRawRecords, listLiveIds, listStoredIds,
  now, query, remove, update, updateMany, updateWith, upsertWithId,
} from './brainStorage/recordStore.js';

/**
 * Invalidate the non-collection caches (meta + JSONL logs) and every projection
 * index. Entity store BODIES still read through to disk, so there is no
 * whole-record entity cache to clear.
 */
export function invalidateAllCaches() {
  clearLogCaches();
  clearRecordIndexes();
  // Live restores replace files without record events. Drop derived caches too,
  // without turning cache invalidation into a write or federation announcement.
  brainEvents.emit('caches:invalidated');
}
