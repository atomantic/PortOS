import { useEffect, useState } from 'react';
import { listCatalogIngredientsByIds, listCatalogIngredientMedia } from '../services/apiCatalog.js';
import { useVisibilityEvent } from './useVisibilityEvent.js';

/** Load linked sets once per board, and refresh on return from editing a place. */
export default function useMusicVideoGreyboxPlaces(project) {
  const ids = [...new Set((project?.concept?.subjects || []).filter((s) => s.kind === 'place' && s.ingredientId).map((s) => s.ingredientId))].sort().join(',');
  const [places, setPlaces] = useState({});
  const [refresh, setRefresh] = useState(0);
  useVisibilityEvent((state) => { if (state === 'visible') setRefresh((n) => n + 1); });
  useEffect(() => {
    let active = true;
    setPlaces({});
    if (!ids) return () => { active = false; };
    const selected = ids.split(',');
    Promise.all([
      listCatalogIngredientsByIds(selected, { silent: true }),
      Promise.all(selected.map((id) => listCatalogIngredientMedia(id, { silent: true }).then((media) => [id, media]))),
    ]).then(([ingredients, media]) => {
      if (active) setPlaces(Object.fromEntries(ingredients.map((ingredient) => [ingredient.id, { ingredient, media: media.find(([id]) => id === ingredient.id)?.[1] || [] }])));
    }).catch(() => { if (active) setPlaces(Object.fromEntries(selected.map((id) => [id, null]))); });
    return () => { active = false; };
  }, [ids, refresh]);
  return places;
}
