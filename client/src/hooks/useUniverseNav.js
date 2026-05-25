import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

// Strips any trailing `/:universeId` (or deeper path) so the result is always
// the "/universes" root. The editor mounts at `/universes/:universeId` (and the
// create sentinel `/universes/new`); this collapses either back to the index
// root for navigation.
export function universesBasePath(pathname) {
  return (pathname || '').replace(/\/universes(?:\/.*)?$/, '/universes');
}

// Returns `goToWorld(id)`. Calling it navigates to the Universe editor route
// for `id` (or back to the index when id is null/undefined), preserving the
// current `location.search` so query state like `?tab=&bucket=` survives the
// create-from-idea round-trip. The id is `encodeURIComponent`-wrapped so
// universe ids with slashes / spaces / `#` don't smear into the path.
export function useUniverseNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const basePath = universesBasePath(location.pathname);
  return useCallback((id) => navigate({
    pathname: id ? `${basePath}/${encodeURIComponent(id)}` : basePath,
    search: location.search,
  }), [navigate, basePath, location.search]);
}
