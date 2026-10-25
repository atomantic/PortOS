import { useEffect, useRef, useState } from 'react';
import { getCatalogIngredientCards } from '../services/apiCatalog';
import socket from '../services/socket';

// Hydrate only the visible IDs, in server-bounded batches. Refresh the same
// collection after mutations/reconnect; never scan the complete catalog.
export default function useCatalogCards(ids, { initial = null } = {}) {
  const key = JSON.stringify([...new Set(ids.filter(Boolean))]);
  const generation = useRef(0);
  const refreshRef = useRef(null);
  const [retryVersion, setRetryVersion] = useState(0);
  const [state, setState] = useState({ key: null, cards: {}, missing: [], error: null });
  const cardsRef = useRef(state.cards);
  cardsRef.current = state.cards;
  const initialRef = useRef(initial);
  initialRef.current = initial;
  useEffect(() => {
    let active = true;
    const requested = JSON.parse(key);
    const refresh = () => {
      const current = ++generation.current;
      return getCatalogIngredientCards(requested, { silent: true }).then(items => {
        if (active && current === generation.current) setState(previous => {
          const missing = requested.filter(id => !items.some(item => item.id === id));
          const retained = missing.filter(id => previous.cards[id]).map(id => [id, previous.cards[id]]);
          return { key, cards: Object.fromEntries([...retained, ...items.map(item => [item.id, item])]), missing, error: null };
        });
      }).catch(error => {
        if (active && current === generation.current) setState(previous => ({ ...previous, key, error: error.message }));
      });
    };
    refreshRef.current = refresh;
    if (initialRef.current && retryVersion === 0) setState(previous => ({ key, error: null, missing: [],
      cards: Object.fromEntries(initialRef.current.map(item => {
        const latest = previous.cards[item.id];
        return [item.id, latest && !(Date.parse(item.updatedAt) > Date.parse(latest.updatedAt)) ? latest : item];
      })),
    }));
    else refresh();
    const changed = event => {
      if ([event?.ingredientId, event?.sourceId, event?.survivorId].some(id => requested.includes(id) || Object.values(cardsRef.current).some(card => card.canonicalId === id))) refresh();
    };
    socket.on('catalog:primitive-changed', changed);
    socket.on('catalog:identity-changed', changed);
    socket.on('connect', refresh);
    return () => {
      active = false;
      if (refreshRef.current === refresh) refreshRef.current = null;
      socket.off('catalog:primitive-changed', changed);
      socket.off('catalog:identity-changed', changed);
      socket.off('connect', refresh);
    };
  }, [key, retryVersion]);
  return { cards: Object.fromEntries(JSON.parse(key).filter(id => state.cards[id]).map(id => [id, state.cards[id]])), error: state.key === key ? state.error : null, missing: state.key === key ? state.missing : [],
    retry: () => setRetryVersion(previous => previous + 1),
    update: item => {
      generation.current += 1;
      setState(previous => {
        const current = previous.cards[item.id] || item;
        return { ...previous, missing: previous.missing.filter(id => id !== item.id), cards: { ...previous.cards, [item.id]: { ...current,
          updatedAt: item.updatedAt || current.updatedAt, payload: { ...current.payload, locked: item.payload.locked } } } };
      });
      // The response owns only its flag. Rehydrate after confirmation so an
      // older mutation closure cannot overwrite a concurrently selected cover.
      refreshRef.current?.();
    } };
}
