import { request } from './apiCore.js';
import { RUNWAY_CATALOG_SNAPSHOT } from '../../../server/lib/runwayCatalogSnapshot.js';

const TTL = 5 * 60 * 1000;
const listeners = new Set();
let snapshot = { available: Object.fromEntries(Object.entries(RUNWAY_CATALOG_SNAPSHOT).map(([key, rows]) => [key, rows.map((row) => row.id)])), bundled: true, stale: true, unsupported: [] };
let fetchedAt = null;
let pending = null;
let pendingForced = false;
export const getRunwayCatalogSnapshot = () => snapshot;
export const subscribeRunwayCatalog = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };

/** Shared across every form mount, including concurrent drawers. Refresh updates open subscribers. */
export function loadRunwayCatalog({ refresh = false } = {}) {
  if (pending) return refresh && !pendingForced ? pending.then(() => loadRunwayCatalog({ refresh: true })) : pending;
  pendingForced = refresh;
  if (!refresh && fetchedAt != null && Date.now() - fetchedAt < TTL) return Promise.resolve(snapshot);
  pending = request(`/image-gen/runway-models${refresh ? '/refresh' : ''}`, { method: refresh ? 'POST' : 'GET', silent: true })
    .then((data) => {
      if (!Object.keys(snapshot.available).every((key) => Array.isArray(data?.available?.[key]))) throw new Error('Invalid Runway catalog response');
      snapshot = data;
    })
    .catch((err) => { snapshot = { ...snapshot, stale: true, error: err.message }; })
    .finally(() => {
      fetchedAt = Date.now();
      pending = null;
      for (const listener of listeners) listener();
    })
    .then(() => snapshot);
  return pending;
}
