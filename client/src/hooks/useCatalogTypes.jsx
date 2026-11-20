/**
 * Lazily shares the Catalog type registry with built-in types available on first render.
 */

import { useMemo, useSyncExternalStore } from 'react';
import { listCatalogTypes } from '../services/apiCatalogTypes';
import { CATALOG_TYPES, mergeCatalogTypes } from '../lib/catalogTypes';

const initialState = {
  registry: mergeCatalogTypes(CATALOG_TYPES, []),
  loading: true,
  error: null,
};
let snapshot = initialState;
let inFlight = null;
const listeners = new Set();
const getSnapshot = () => snapshot;

function refresh() {
  const run = listCatalogTypes({ silent: true }).then((data) => {
    const serverTypes = Array.isArray(data?.types) ? data.types : [];
    return {
      registry: mergeCatalogTypes(CATALOG_TYPES, serverTypes.filter(type => type?.system === false)),
      loading: false,
      error: null,
    };
  }).catch(error => ({
    ...snapshot,
    loading: false,
    error: error || new Error('Failed to load catalog types'),
  })).then(next => {
    // A read after a mutation wins over an older in-flight read.
    if (inFlight !== run) return;
    inFlight = null;
    snapshot = next;
    for (const listener of listeners) listener();
  });
  inFlight = run;
  return run;
}

function subscribe(listener) {
  listeners.add(listener);
  if (!inFlight && snapshot === initialState) void refresh();
  return () => listeners.delete(listener);
}

export function useCatalogTypes() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  return useMemo(() => ({
    types: snapshot.registry.list,
    getType: (id) => snapshot.registry.byId[id],
    ids: snapshot.registry.list.map((t) => t.id),
    loading: snapshot.loading,
    error: snapshot.error,
    refresh,
  }), [snapshot]);
}

/** Test seam. Reset only after the previous consumers unmount. */
export function __resetCatalogTypes() {
  inFlight = null;
  snapshot = initialState;
}

export default useCatalogTypes;
