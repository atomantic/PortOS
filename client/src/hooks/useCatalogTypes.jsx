import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { listCatalogTypes } from '../services/apiCatalogTypes';
import { CATALOG_TYPES, mergeCatalogTypes } from '../lib/catalogTypes';

/**
 * Catalog type registry hook + context.
 *
 * Fetches `GET /api/catalog/types` once (the FULL active registry — system +
 * user-defined) and merges it with the static `CATALOG_TYPES` fallback so the
 * Catalog list / picker / editor pick up user-defined types. The static
 * registry is the SYNCHRONOUS fallback: first render (before the fetch
 * resolves) returns the built-in six so the UI never blanks.
 *
 * Exposed:
 *   types   — ordered merged list ({ id, label, badgeColor, primaryContentKey,
 *             primaryContentLabel, snippetFallbackKeys, editorFields?, system })
 *   getType — (id) => type | undefined
 *   ids     — ordered id list
 *   loading — true until the first fetch resolves (fallback is live meanwhile)
 *   refresh — re-fetch (call after a Settings → Catalog mutation)
 */

const CatalogTypesContext = createContext(null);

// Build the merged registry from a raw server array (or [] for fallback). The
// server returns system + user entries; mergeCatalogTypes drops the system
// ones (already in the static fallback) and normalizes the rest.
const buildRegistry = (userTypesRaw) => mergeCatalogTypes(CATALOG_TYPES, userTypesRaw);

// Shared fetch-and-merge state machine used by BOTH the Provider and the
// standalone (provider-less) fallback. `enabled` gates the fetch effect so the
// standalone path can stay dormant when a context is present. Synchronous
// fallback to the static system registry so first render never blanks.
function useRegistryFetcher(enabled = true) {
  const [registry, setRegistry] = useState(() => buildRegistry([]));
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const refresh = useCallback(() => listCatalogTypes({ silent: true })
    .then((data) => {
      if (!mountedRef.current) return;
      const serverTypes = Array.isArray(data?.types) ? data.types : [];
      setRegistry(buildRegistry(serverTypes.filter((t) => t && t.system === false)));
      setLoading(false);
    })
    // Network/route failure → keep the static fallback; stop the spinner.
    .catch(() => { if (mountedRef.current) setLoading(false); }), []);

  useEffect(() => { if (enabled) refresh(); }, [enabled, refresh]);

  return useMemo(() => ({
    types: registry.list,
    getType: (id) => registry.byId[id],
    ids: registry.list.map((t) => t.id),
    loading,
    refresh,
  }), [registry, loading, refresh]);
}

export function CatalogTypesProvider({ children }) {
  const value = useRegistryFetcher(true);
  return <CatalogTypesContext.Provider value={value}>{children}</CatalogTypesContext.Provider>;
}

/**
 * Read the catalog type registry. When used outside a `CatalogTypesProvider`
 * (e.g. a test that doesn't mount the provider) it falls back to a standalone
 * fetch-and-merge so the hook is still usable in isolation.
 */
export function useCatalogTypes() {
  const ctx = useContext(CatalogTypesContext);
  // Hooks must run unconditionally — run the standalone fetcher but keep it
  // dormant (no fetch) when a context already provides the registry.
  const standalone = useRegistryFetcher(!ctx);
  return ctx || standalone;
}

export default useCatalogTypes;
