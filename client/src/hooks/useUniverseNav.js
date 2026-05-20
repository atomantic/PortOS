import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

// Strips any trailing `/:universeId` (or deeper path) so the result is always
// the "/universe-builder" root for the current route prefix. Mirrors the regex
// previously inlined in UniverseBuilder.jsx so consumers don't have to re-think
// the basePath derivation.
export function universeBuilderBasePath(pathname) {
  return (pathname || '').replace(/\/universe-builder(?:\/.*)?$/, '/universe-builder');
}

// Returns `goToWorld(id)`. Calling it navigates to the Universe Builder route
// for `id` (or back to the index when id is null/undefined), preserving the
// current `location.search` so query state like `?tab=&bucket=` survives the
// create-from-idea round-trip. The id is `encodeURIComponent`-wrapped so
// universe ids with slashes / spaces / `#` don't smear into the path.
export function useUniverseNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const basePath = universeBuilderBasePath(location.pathname);
  return useCallback((id) => navigate({
    pathname: id ? `${basePath}/${encodeURIComponent(id)}` : basePath,
    search: location.search,
  }), [navigate, basePath, location.search]);
}
