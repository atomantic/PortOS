import { useEffect, useSyncExternalStore } from 'react';
import { getRunwayCatalogSnapshot, subscribeRunwayCatalog, loadRunwayCatalog } from '../services/apiRunwayCatalog.js';
import { RUNWAY_IMAGE_MODELS } from '../lib/imageGenModes.js';
import { RUNWAY_VIDEO_MODELS } from '../lib/runwayVideoModels.js';
import { RUNWAY_SPECIAL_VIDEO_MODELS } from '../../../server/lib/runwaySpecialVideoModels.js';

export function useRunwayCatalog(enabled = true, videoMode = 'image') {
  const catalog = useSyncExternalStore(subscribeRunwayCatalog, getRunwayCatalogSnapshot);
  useEffect(() => { if (enabled) void loadRunwayCatalog(); }, [enabled]);
  const special = RUNWAY_SPECIAL_VIDEO_MODELS.find((m) => m.mode === videoMode);
  const endpoint = special?.endpoint || (videoMode === 'text' ? 'text_to_video' : 'image_to_video');
  return {
    ...catalog,
    imageModels: RUNWAY_IMAGE_MODELS.filter((m) => catalog.available.text_to_image.includes(m.id)),
    videoModels: (special ? RUNWAY_SPECIAL_VIDEO_MODELS : RUNWAY_VIDEO_MODELS).filter((m) => (catalog.available[endpoint] || []).includes(m.id)),
    refresh: () => loadRunwayCatalog({ refresh: true }),
  };
}
