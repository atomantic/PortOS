import { useEffect, useState } from 'react';
import socket from '../services/socket';
import { getMusicVideoCastAndSetsCastingChanges } from '../services/apiMusicVideo.js';
import { useVisibilityEvent } from './useVisibilityEvent.js';

const IDLE = new Set(['review', 'approved']);
// A media write announces before its transaction commits; read a moment after.
const SETTLE_MS = 1000;

/**
 * What changed in the video's linked Casting records since its idle Cast & Sets
 * sheet was built (`{ images, cast }`, or null), from the server. Re-read when
 * the sheet or the video's cast links change, when a linked record changes
 * (catalog socket events), and on return to the tab.
 */
export default function useMusicVideoCastingChanges(project) {
  const stage = project?.castAndSets;
  const subjects = project?.concept?.subjects || [];
  const links = subjects.filter((s) => s?.ingredientId).map((s) => `${s.id}:${s.ingredientId}:${s.castForm?.id || ''}`).sort().join(',');
  const records = [...new Set(subjects.map((s) => s?.ingredientId).filter(Boolean))].sort().join(',');
  const idle = !!stage?.direction && IDLE.has(stage.status);
  const [changes, setChanges] = useState(null);
  const [refresh, setRefresh] = useState(0);
  useVisibilityEvent((state) => { if (state === 'visible') setRefresh((n) => n + 1); });

  useEffect(() => {
    if (!records || !idle) return undefined;
    const ids = new Set(records.split(','));
    let timer = null;
    const changed = (data) => {
      if (!ids.has(data?.ingredientId)) return;
      clearTimeout(timer);
      timer = setTimeout(() => setRefresh((n) => n + 1), SETTLE_MS);
    };
    socket.on('catalog:primitive-changed', changed);
    socket.on('catalog:assets-changed', changed);
    return () => {
      clearTimeout(timer);
      socket.off('catalog:primitive-changed', changed);
      socket.off('catalog:assets-changed', changed);
    };
  }, [records, idle]);

  const projectId = project?.id || null;
  const revision = stage?.revision ?? null;
  const status = stage?.status ?? null;
  useEffect(() => {
    let active = true;
    if (!projectId || !idle) { setChanges(null); return () => { active = false; }; }
    getMusicVideoCastAndSetsCastingChanges(projectId, { silent: true })
      .then((res) => { if (active) setChanges(res?.changes || null); })
      .catch(() => { if (active) setChanges(null); });
    return () => { active = false; };
  }, [projectId, idle, revision, status, links, refresh]);

  return changes;
}
