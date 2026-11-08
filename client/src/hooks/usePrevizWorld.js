import { useMemo } from 'react';
import useCatalogPlaces from './useCatalogPlaces.js';
import { placeWorld } from '../../../server/lib/worldMap.js';

/**
 * A music video previz's world: `{ worldId, entry, world, places }`. `entry` is
 * the world environment (undefined while loading, null when removed), `world`
 * its map or null, `places` the loaded catalog places of its sets by id.
 */
export default function usePrevizWorld(project) {
  const worldId = project?.previz?.worldId || null;
  const entry = useCatalogPlaces(worldId ? [worldId] : [])[worldId];
  const world = useMemo(() => placeWorld(entry?.ingredient), [entry]);
  const places = useCatalogPlaces((world?.sets || []).map((set) => set.ingredientId));
  return { worldId, entry, world, places };
}
