/**
 * Reads live catalog-only Cast & Sets items, blockers and approval basis.
 *
 * Refreshes on catalog changes/reconnect and keeps whole-project reference pickers in sync without
 * persisting copied images. A project edit re-reads only when it changes an input of the check
 * (musicVideoCatalogCheckinInputs), once a burst of such edits settles, so a take decision, Done or a
 * timing move sends no read (#16306). Use when: Catalog-only Look check-in.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import socket from '../services/socket.js';
import { getMusicVideoCastAndSets, repairMusicVideoShotReference } from '../services/apiMusicVideo.js';
import { musicVideoCatalogCheckinInputs } from '../lib/musicVideoCatalogCheckinInputs.js';
import { useVisibilityEvent } from './useVisibilityEvent.js';

// A burst of edits (typing a prompt that names a subject, several reference picks) makes one read.
export const CHECKIN_INPUT_SETTLE_MS = 400;

/** An approval always describes the currently resolved catalog, never a cached sheet. */
export default function useCatalogCastSetsCheckin(project, onResolved, onRepair) {
  const resolvedRef = useRef(onResolved);
  resolvedRef.current = onResolved;
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState(null);
  const [repairing, setRepairing] = useState(false);
  const [repairError, setRepairError] = useState(null);
  const repairPending = useRef(false);
  const enabled = project.castAndSets?.source === 'catalog';
  const ids = JSON.stringify([...new Set((project.concept?.subjects || []).map((s) => s.ingredientId).filter(Boolean))].sort());
  // Not `updatedAt`: every applied edit reply advances it, and most edits cannot change this check.
  const inputs = useMemo(() => (enabled ? musicVideoCatalogCheckinInputs(project) : ''), [enabled, project]);
  // An explicit refresh (Retry, a repair, a catalog event, reconnect, tab return) reads the current inputs at
  // once and absorbs a pending input change, so a repair whose picks land with its refresh reads once.
  const [settled, setSettled] = useState({ inputs, refresh });
  useEffect(() => {
    if (settled.refresh !== refresh) { setSettled({ inputs, refresh }); return undefined; }
    if (inputs === settled.inputs) return undefined;
    const timer = setTimeout(() => setSettled({ inputs, refresh }), CHECKIN_INPUT_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [inputs, refresh, settled]);
  const key = JSON.stringify([project.id, settled.inputs, settled.refresh]);
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
  const retry = () => setRefresh((n) => n + 1);
  const repair = (problemId) => {
    if (repairPending.current) return;
    repairPending.current = true;
    setRepairing(true);
    setRepairError(null);
    return repairMusicVideoShotReference(project.id, problemId, { silent: true })
      .then((saved) => onRepair?.(saved))
      .catch((error) => setRepairError({ projectId: project.id, message: error.message || 'Could not fix the shot reference.' }))
      .finally(() => {
        repairPending.current = false;
        setRepairing(false);
        retry();
      });
  };
  return {
    checkin: result?.key === key ? result.checkin : null, error: result?.key === key ? result.error : null, retry,
    repair, repairing, repairError: repairError?.projectId === project.id ? repairError.message : null,
  };
}
