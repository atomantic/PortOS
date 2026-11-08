import useCatalogPlaces from './useCatalogPlaces.js';

/** Load linked sets once per board, and refresh on return from editing a place. */
export default function useMusicVideoGreyboxPlaces(project) {
  return useCatalogPlaces((project?.concept?.subjects || []).filter((s) => s.kind === 'place' && s.ingredientId).map((s) => s.ingredientId));
}
