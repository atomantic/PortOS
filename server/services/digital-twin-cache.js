/** Digital twin file caches and the mutex shared by metadata writers and live restores. */
import { createMutex } from '../lib/asyncMutex.js';

export const metaMutex = createMutex();

export const cache = {
  meta: { data: null, timestamp: 0 },
  documents: { data: null, timestamp: 0 },
  tests: { data: null, timestamp: 0 },
  valuesTests: { data: null, timestamp: 0 },
  adversarialTests: { data: null, timestamp: 0 },
  multiTurnTests: { data: null, timestamp: 0 }
};

// Each read keeps its map so an in-flight document read cannot refill the
// current cache after rsync replaces bytes while preserving the mtime.
export let docContentCache = new Map();

export function invalidateDigitalTwinCaches() {
  docContentCache = new Map();
  for (const key of Object.keys(cache)) {
    cache[key] = { data: null, timestamp: 0 };
  }
}
