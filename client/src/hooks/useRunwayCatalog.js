import { useEffect, useSyncExternalStore } from 'react';
import { getRunwayCatalogSnapshot, subscribeRunwayCatalog, loadRunwayCatalog } from '../services/apiRunwayCatalog.js';
import { RUNWAY_IMAGE_MODELS } from '../lib/imageGenModes.js';
import { RUNWAY_VIDEO_MODELS } from '../lib/runwayVideoModels.js';

export function useRunwayCatalog(enabled = true, videoMode = 'image') {
  const catalog = useSyncExternalStore(subscribeRunwayCatalog, getRunwayCatalogSnapshot);
  useEffect(() => { if (enabled) void loadRunwayCatalog(); }, [enabled]);
  return {
    ...catalog,
    imageModels: RUNWAY_IMAGE_MODELS.filter((m) => catalog.available.text_to_image.includes(m.id)),
    videoModels: RUNWAY_VIDEO_MODELS.filter((m) => catalog.available[videoMode === 'text' ? 'text_to_video' : 'image_to_video'].includes(m.id)),
    refresh: () => loadRunwayCatalog({ refresh: true }),
  };
}
