/**
 * Client cache of the server's fal.ai image model list, with a short TTL and one in-flight request.
 */

import { request } from './apiCore.js';

const TTL = 5 * 60 * 1000;
const listeners = new Set();
let snapshot = { models: [], bundled: true, stale: true, truncated: false };
let fetchedAt = null;
let pending = null;
let pendingForced = false;

export const getFalImageCatalogSnapshot = () => snapshot;
export const subscribeFalImageCatalog = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };

function usable(data) {
  return Array.isArray(data?.models) && data.models.every((row) => typeof row?.id === 'string' && typeof row?.label === 'string');
}

/** Shared across every fal picker. An invalid payload or a failed load keeps the last snapshot. */
export function loadFalImageCatalog({ refresh = false } = {}) {
  if (pending) return refresh && !pendingForced ? pending.then(() => loadFalImageCatalog({ refresh: true })) : pending;
  pendingForced = refresh;
  if (!refresh && fetchedAt != null && Date.now() - fetchedAt < TTL) return Promise.resolve(snapshot);
  pending = request(`/image-gen/fal-models${refresh ? '/refresh' : ''}`, { method: refresh ? 'POST' : 'GET', silent: true })
    .then((data) => {
      if (!usable(data)) throw new Error('Invalid fal.ai catalog response');
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
