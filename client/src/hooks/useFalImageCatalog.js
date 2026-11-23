/**
 * The live fal.ai image model list, shared across pickers and loaded once while a fal picker is shown.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { getFalImageCatalogSnapshot, subscribeFalImageCatalog, loadFalImageCatalog } from '../services/apiFalImageCatalog.js';

export function useFalImageCatalog(enabled = true) {
  const catalog = useSyncExternalStore(subscribeFalImageCatalog, getFalImageCatalogSnapshot);
  useEffect(() => { if (enabled) void loadFalImageCatalog(); }, [enabled]);
  return { ...catalog, refresh: () => loadFalImageCatalog({ refresh: true }) };
}
