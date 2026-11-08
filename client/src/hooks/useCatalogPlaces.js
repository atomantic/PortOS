import { useEffect, useState } from 'react';
import { listCatalogIngredientsByIds, listCatalogIngredientMedia } from '../services/apiCatalog.js';
import { useVisibilityEvent } from './useVisibilityEvent.js';
import socket from '../services/socket.js';

const BATCH = 50;

/**
 * Load catalog places (and their media, for a Blender greybox's model file) by
 * id: `{ [ingredientId]: { ingredient, media } }`, an id missing until it loads
 * and `null` when the load failed. Refreshes on return to the tab and when a
 * loaded place is saved (`catalog:primitive-changed`).
 */
export default function useCatalogPlaces(ingredientIds = []) {
  const ids = [...new Set(ingredientIds.filter(Boolean))].sort().join(',');
  const [places, setPlaces] = useState({});
  const [refresh, setRefresh] = useState(0);
  useVisibilityEvent((state) => { if (state === 'visible') setRefresh((n) => n + 1); });
  // A loaded place saved elsewhere (its world map redrafted, its greybox edited) reloads.
  useEffect(() => {
    if (!ids) return undefined;
    const watched = new Set(ids.split(','));
    let timer = null;
    const changed = (event) => {
      if (!watched.has(event?.ingredientId)) return;
      clearTimeout(timer);
      // Catalog notifications precede their transaction commit.
      timer = setTimeout(() => setRefresh((n) => n + 1), 1000);
    };
    socket.on('catalog:primitive-changed', changed);
    return () => { clearTimeout(timer); socket.off('catalog:primitive-changed', changed); };
  }, [ids]);
  useEffect(() => {
    let active = true;
    setPlaces({});
    if (!ids) return () => { active = false; };
    const selected = ids.split(',');
    Promise.all([
      // The batch read caps each call at BATCH ids; a world can place more sets than that.
      Promise.all(Array.from({ length: Math.ceil(selected.length / BATCH) }, (_, i) => listCatalogIngredientsByIds(selected.slice(i * BATCH, (i + 1) * BATCH), { silent: true })))
        .then((pages) => pages.flat()),
      // A removed place 404s its media read; only that id should read as missing.
      Promise.all(selected.map((id) => listCatalogIngredientMedia(id, { silent: true }).then((media) => [id, media]).catch(() => [id, []]))),
    ]).then(([ingredients, media]) => {
      if (!active) return;
      const found = Object.fromEntries(ingredients.map((ingredient) => [ingredient.id, { ingredient, media: media.find(([id]) => id === ingredient.id)?.[1] || [] }]));
      setPlaces(Object.fromEntries(selected.map((id) => [id, found[id] || null])));
    }).catch(() => { if (active) setPlaces(Object.fromEntries(selected.map((id) => [id, null]))); });
    return () => { active = false; };
  }, [ids, refresh]);
  return places;
}
