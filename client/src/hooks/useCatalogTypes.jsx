/**
 * Catalog ingredient type registry (system + user-defined) merged with the static fallback via a
 * Provider/hook pair.
 *
 * Synchronous fallback to the built-in six so first render never blanks. Use when: Catalog
 * list/picker/editor; anywhere the catalog type list/lookup is needed.
 */

import { useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { CatalogTypesStoreContext, CatalogTypesProvider } from '../components/CatalogTypesContext.jsx';
import { listCatalogTypes } from '../services/apiCatalogTypes';
import { CATALOG_TYPES, mergeCatalogTypes } from '../lib/catalogTypes';

export { CatalogTypesProvider };

// Build the merged registry from a raw server array (or [] for fallback). The
// server returns system + user entries; mergeCatalogTypes drops the system
// ones (already in the static fallback) and normalizes the rest.
const buildRegistry = (userTypesRaw) => mergeCatalogTypes(CATALOG_TYPES, userTypesRaw);

const createInitialState = () => ({
  registry: buildRegistry([]),
  loading: true,
  error: null,
});

function ensureStoreState(store) {
  if (!store.state) store.state = createInitialState();
  return store.state;
}

function notifyStore(store) {
  for (const listener of store.listeners) listener(store.state);
}

function fetchIntoStore(store) {
  const current = ensureStoreState(store);
  const run = listCatalogTypes({ silent: true })
    .then((data) => {
      const serverTypes = Array.isArray(data?.types) ? data.types : [];
      store.state = {
        registry: buildRegistry(serverTypes.filter((t) => t && t.system === false)),
        loading: false,
        error: null,
      };
      notifyStore(store);
    })
    // Network/route failure → keep the static fallback, surface the error so
    // Settings can offer a retry instead of reading as "no custom types".
    .catch((err) => {
      store.state = {
        registry: store.state?.registry || current.registry,
        loading: false,
        error: err || new Error('Failed to load catalog types'),
      };
      notifyStore(store);
    })
    .finally(() => {
      if (store.inFlight === run) store.inFlight = null;
    });
  store.inFlight = run;
  return run;
}

/**
 * Read the catalog type registry. Shares one lazy fetch across consumers under
 * a `CatalogTypesProvider`, and falls back to a standalone store when used
 * outside a provider (e.g. an isolated test).
 */
export function useCatalogTypes() {
  const ctxStore = useContext(CatalogTypesStoreContext);
  const standaloneRef = useRef(null);
  if (!ctxStore && !standaloneRef.current) {
    standaloneRef.current = { state: null, inFlight: null, listeners: new Set() };
  }
  const store = ctxStore || standaloneRef.current;

  const [snapshot, setSnapshot] = useState(() => ensureStoreState(store));

  useEffect(() => {
    const listener = (nextState) => setSnapshot(nextState);
    store.listeners.add(listener);
    // Sync if the store updated between render and effect, and trigger the
    // first shared fetch once a consumer actually mounts.
    if (store.state && store.state !== snapshot) setSnapshot(store.state);
    if (!store.inFlight && store.state?.loading) {
      fetchIntoStore(store);
    }
    return () => {
      store.listeners.delete(listener);
    };
  }, [store]);

  const refresh = useCallback(() => fetchIntoStore(store), [store]);

  return useMemo(() => ({
    types: snapshot.registry.list,
    getType: (id) => snapshot.registry.byId[id],
    ids: snapshot.registry.list.map((t) => t.id),
    loading: snapshot.loading,
    error: snapshot.error,
    refresh,
  }), [snapshot, refresh]);
}

export default useCatalogTypes;
