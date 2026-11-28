import { createContext, useContext } from 'react';
import { makingOfItemKey } from '../../../../server/lib/musicVideo/musicVideoMakingOfStoryShared.js';

/**
 * Shared Making-Of capture context provided by `ProjectWorkspace`.
 * Lets take cards, look references, Assets, and the media lightbox capture
 * stills/clips/references straight into the project's Making-Of bank without
 * prop-drilling through every intermediate board component.
 */
export const MakingOfCaptureContext = createContext(null);

export function useMakingOfCapture() {
  return useContext(MakingOfCaptureContext);
}

/** Find an existing Making-Of item matching `(kind, assetId)` in a story record. */
export function findCapturedMakingOfItem(story, kind, assetId) {
  const key = makingOfItemKey(kind, assetId);
  if (!key || !Array.isArray(story?.items)) return null;
  return story.items.find((item) => makingOfItemKey(item.kind, item.assetId) === key) || null;
}
