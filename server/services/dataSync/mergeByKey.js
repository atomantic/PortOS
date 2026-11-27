/** Merges snapshot records by id, using last-writer-wins or a domain-specific merge. */

import { canonicalStringify } from '../../lib/objects.js';

/**
 * Merge two arrays of records by a key field. LWW by timestampField when both
 * sides have the same record. Records unique to either side are kept (union).
 * A mergeRecord callback can combine same-key records for domains whose record
 * is itself a container for independent sub-records.
 */
export function mergeArraysByKey(localArr, remoteArr, idField, timestampField, mergeRecord) {
  const localMap = new Map();
  for (const item of localArr) {
    localMap.set(item[idField], item);
  }

  let changed = false;
  for (const remoteItem of remoteArr) {
    const key = remoteItem[idField];
    const localItem = localMap.get(key);

    if (!localItem) {
      // New record from remote — add it
      localMap.set(key, remoteItem);
      changed = true;
    } else if (mergeRecord) {
      const mergedItem = mergeRecord(localItem, remoteItem);
      if (canonicalStringify(mergedItem) !== canonicalStringify(localItem)) {
        localMap.set(key, mergedItem);
        changed = true;
      }
    } else if (timestampField) {
      // Both have it — LWW
      const localTs = localItem[timestampField] || '';
      const remoteTs = remoteItem[timestampField] || '';
      if (remoteTs > localTs) {
        localMap.set(key, remoteItem);
        changed = true;
      }
    }
  }

  return { merged: Array.from(localMap.values()), changed };
}
