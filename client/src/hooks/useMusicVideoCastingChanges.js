import { useCallback, useEffect, useState } from 'react';
import socket from '../services/socket';
import { getMusicVideoCastAndSetsCastingChanges } from '../services/apiMusicVideo.js';
import { useVisibilityEvent } from './useVisibilityEvent.js';

const IDLE = new Set(['review', 'approved']);
// A media write announces before its transaction commits; read a moment after.
const SETTLE_MS = 1000;

/**
 * What changed in the video's linked Casting records since its idle Cast & Sets
 * sheet was built, from the server: `changes` (`{ images, cast }`, or null for
 * nothing changed), `loadError` when the last read failed, and `retry()`. A failed
 * re-read keeps the last successful changes for the same project, so a blip does
 * not clear a notice the director is still relying on. Re-read when the sheet or
 * the video's cast links change, when a linked record changes (catalog socket
 * events), and on return to the tab.
 */
export default function useMusicVideoCastingChanges(project) {
  const stage = project?.castAndSets;
  const subjects = project?.concept?.subjects || [];
  const links = subjects.filter((s) => s?.ingredientId).map((s) => `${s.id}:${s.ingredientId}:${s.castForm?.id || ''}`).sort().join(',');
  const records = [...new Set(subjects.map((s) => s?.ingredientId).filter(Boolean))].sort().join(',');
  const idle = !!stage?.direction && IDLE.has(stage.status);
  // Keyed by project so another project's result never shows after a switch.
  const [read, setRead] = useState({ projectId: null, changes: null, loadError: false });
  const [refresh, setRefresh] = useState(0);
  const retry = useCallback(() => setRefresh((n) => n + 1), []);
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
    // Returns the previous state when unchanged, so a repeated "nothing changed" read does not re-render.
    const settle = (changes) => setRead((prev) => (prev.projectId === projectId && prev.changes === changes && !prev.loadError ? prev : { projectId, changes, loadError: false }));
    if (!projectId || !idle) { settle(null); return () => { active = false; }; }
    getMusicVideoCastAndSetsCastingChanges(projectId, { silent: true })
      .then((res) => { if (active) settle(res?.changes || null); })
      .catch(() => { if (active) setRead((prev) => ({ projectId, changes: prev.projectId === projectId ? prev.changes : null, loadError: true })); });
    return () => { active = false; };
  }, [projectId, idle, revision, status, links, refresh]);

  const current = read.projectId === projectId ? read : { changes: null, loadError: false };
  return { changes: current.changes, loadError: current.loadError, retry };
}
