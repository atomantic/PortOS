/** Provides snapshot checksums and normalizes the exclude set for scoped snapshots. */

import { snapshotChecksum } from '../../lib/snapshotChecksum.js';

// Insertion-order sensitive by design: every getter here canonicalizes its own
// ordering before hashing (see the sorted-record notes below).
export const computeChecksum = snapshotChecksum;

// Normalize an `excludeRecordIds` option into a Set. Accepts a Set, an array,
// or null/undefined (→ empty Set = no exclusion = legacy full snapshot).
export function toExcludeSet(exclude) {
  if (exclude instanceof Set) return exclude;
  if (Array.isArray(exclude)) return new Set(exclude);
  return new Set();
}
