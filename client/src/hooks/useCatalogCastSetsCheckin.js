import { useEffect, useRef, useState } from 'react';
import socket from '../services/socket.js';
import { getMusicVideoCastAndSets } from '../services/apiMusicVideo.js';
import { useVisibilityEvent } from './useVisibilityEvent.js';

/** An approval always describes the currently resolved catalog, never a cached sheet. */
export default function useCatalogCastSetsCheckin(project, onResolved) {
  const resolvedRef = useRef(onResolved);
  resolvedRef.current = onResolved;
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState(null);
  const enabled = project.castAndSets?.source === 'catalog';
  const ids = JSON.stringify([...new Set((project.concept?.subjects || []).map((s) => s.ingredientId).filter(Boolean))].sort());
  const key = JSON.stringify([project.id, project.updatedAt, project.castAndSets?.revision, project.castAndSets?.status, project.concept?.subjects, refresh]);
  useVisibilityEvent((state) => { if (enabled && state === 'visible') setRefresh((n) => n + 1); });
  useEffect(() => {
    if (!enabled) return undefined;
    const linked = new Set(JSON.parse(ids));
    let timer;
    const changed = (event) => {
      if (!linked.has(event?.ingredientId)) return;
      clearTimeout(timer);
      timer = setTimeout(() => setRefresh((n) => n + 1), 1000);
    };
    const reconnect = () => setRefresh((n) => n + 1);
    socket.on('catalog:primitive-changed', changed);
    socket.on('catalog:assets-changed', changed);
    socket.on('connect', reconnect);
    return () => {
      clearTimeout(timer);
      socket.off('catalog:primitive-changed', changed);
      socket.off('catalog:assets-changed', changed);
      socket.off('connect', reconnect);
    };
  }, [enabled, ids]);
  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    getMusicVideoCastAndSets(project.id, { silent: true }).then((res) => {
      if (!res?.catalogCheckin || !Array.isArray(res.catalogCheckin.items) || !Array.isArray(res.catalogCheckin.problems)) throw new Error('The catalog check-in could not be read.');
      if (active) {
        setResult({ key, checkin: res.catalogCheckin });
        resolvedRef.current?.(res.catalogCheckin);
      }
    }).catch((error) => { if (active) {
      setResult({ key, error: error.message || 'Could not load the catalog check-in.' });
      resolvedRef.current?.(null);
    } });
    return () => { active = false; };
  }, [enabled, key, project.id]);
  return { checkin: result?.key === key ? result.checkin : null, error: result?.key === key ? result.error : null, retry: () => setRefresh((n) => n + 1) };
}
