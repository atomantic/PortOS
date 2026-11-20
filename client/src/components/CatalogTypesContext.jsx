import { createContext, useRef } from 'react';

// Thin context shell mounted by `App.jsx` so cold-load routes never pull in
// `lib/catalogTypes.js`, `server/lib/bibleLimits.js`, or `apiCatalogTypes.js`
// (or fire `/api/catalog/types` on pages that never read catalog types).
// The first mounted `useCatalogTypes()` consumer lazily populates this store.
export const CatalogTypesStoreContext = createContext(null);

export function CatalogTypesProvider({ children }) {
  const storeRef = useRef(null);
  if (!storeRef.current) {
    storeRef.current = {
      state: null,
      inFlight: null,
      listeners: new Set(),
    };
  }
  return (
    <CatalogTypesStoreContext.Provider value={storeRef.current}>
      {children}
    </CatalogTypesStoreContext.Provider>
  );
}
