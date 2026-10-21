import { safeReadJsonStorage, safeWriteJsonStorage } from '../../lib/safeStorage';
import { WIDGETS_BY_ID } from './widgetRegistry.jsx';

// The last server-confirmed layouts response, kept so a reload paints the
// user's own grid (and starts its widget chunks downloading) before the
// layouts GET returns. The server read still runs and always wins; this copy
// is only a first-paint hint and is never written back.
export const LAYOUT_CACHE_KEY = 'portos.dashboard.layoutsCache.v1';

const isCachedLayout = (l) => !!l && typeof l === 'object'
  && typeof l.id === 'string'
  && Array.isArray(l.widgets) && l.widgets.every((id) => typeof id === 'string')
  && (l.grid === undefined || Array.isArray(l.grid));

// Returns { layouts, activeLayoutId } or null for a missing, corrupt, or
// foreign-shaped entry.
export function readLayoutCache() {
  const cached = safeReadJsonStorage(LAYOUT_CACHE_KEY, null);
  if (!cached || !Array.isArray(cached.layouts) || cached.layouts.length === 0) return null;
  if (!cached.layouts.every(isCachedLayout)) return null;
  return {
    layouts: cached.layouts,
    activeLayoutId: typeof cached.activeLayoutId === 'string' ? cached.activeLayoutId : null,
  };
}

export function writeLayoutCache(layouts, activeLayoutId) {
  if (!Array.isArray(layouts) || layouts.length === 0) return;
  safeWriteJsonStorage(LAYOUT_CACHE_KEY, { layouts, activeLayoutId });
}

// The dashboardState streams a layout's widgets read (registry `needs`), so the
// page skips requests no visible widget would render and leaves the phone's
// few connections free for the ones that will. Sorted for a stable effect key.
export function streamsForWidgets(widgetIds) {
  const needed = new Set();
  for (const id of widgetIds ?? []) {
    for (const stream of WIDGETS_BY_ID[id]?.needs ?? []) needed.add(stream);
  }
  return [...needed].sort();
}
