import { useEffect, useRef, useState } from 'react';
import socket from '../../services/socket';
import { getMusicVideoCatalogCompletion, getMusicVideoProject } from '../../services/apiMusicVideo.js';
import { isMusicVideoCompleted } from '../../../../server/lib/musicVideo/musicVideoSummary.js';

const CATALOG_BATCH_MS = 50;
const MAX_INGREDIENTS_PER_READ = 50;

/**
 * Keeps the project index and header picker (`summaries`, a usePagedCollection)
 * current with projects changed elsewhere (#15724): a listed project is read
 * again by id (dropped on a 404), an unlisted one refreshes the first page. The
 * open project and this tab's own writes are skipped; the page follows those.
 */
export default function useProjectSummarySync({ summaries, selectedId, enabled, statusFilter = null, matches = null }) {
  const resetOnMembershipChange = statusFilter === 'completed' || statusFilter === 'in-progress';
  const [catalogError, setCatalogError] = useState(null);
  const retryCatalogRef = useRef(null);
  const summarySyncRef = useRef(null);
  summarySyncRef.current = {
    matches,
    selectedId,
    resetOnMembershipChange,
    statusFilter,
    reconcileFirst: summaries.reconcileFirst,
    items: summaries.items,
    refreshFirst: summaries.refreshFirst,
    removeItem: summaries.removeItem,
    setItems: summaries.setItems,
  };
  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    const inflight = new Map();
    const unlistedMembership = new Map();
    const readListed = (id, checkUnlisted = false) => {
      const slot = inflight.get(id);
      if (slot) { slot.queued = true; slot.checkUnlisted ||= checkUnlisted; return; }
      inflight.set(id, { queued: false, checkUnlisted });
      getMusicVideoProject(id, { silent: true })
        .then((fresh) => {
          if (!active || !fresh) return;
          const current = summarySyncRef.current;
          const previous = current.items.find((p) => p.id === id);
          if (previous) unlistedMembership.delete(id);
          if (previous && ((current.resetOnMembershipChange && isMusicVideoCompleted(previous) !== isMusicVideoCompleted(fresh)) || (current.matches && !current.matches(fresh)))) {
            current.setItems((items) => items.filter((p) => p.id !== id));
            current.reconcileFirst();
          } else if (previous) current.setItems((prev) => prev.map((p) => (p.id === id ? fresh : p)));
          else if (inflight.get(id)?.checkUnlisted && current.resetOnMembershipChange) {
            const matches = isMusicVideoCompleted(fresh) === (current.statusFilter === 'completed') && (!current.matches || current.matches(fresh));
            if (!unlistedMembership.has(id) || unlistedMembership.get(id) !== matches) current.reconcileFirst();
            unlistedMembership.set(id, matches);
          }
        })
        .catch((err) => {
          if (active && err?.status === 404) {
            if (summarySyncRef.current.resetOnMembershipChange) {
              summarySyncRef.current.setItems((items) => items.filter((p) => p.id !== id));
              summarySyncRef.current.reconcileFirst();
            } else summarySyncRef.current.removeItem(id);
          }
        })
        .finally(() => {
          const current = inflight.get(id);
          inflight.delete(id);
          if (active && current?.queued) readListed(id, current.checkUnlisted);
        });
    };
    const onChanged = (data) => {
      const id = data?.id;
      if (!id) return;
      if (data.origin && data.origin === socket.id) return;
      if (id === summarySyncRef.current.selectedId) return;
      const listed = summarySyncRef.current.items.some((project) => project.id === id);
      if (!listed && summarySyncRef.current.resetOnMembershipChange) summarySyncRef.current.reconcileFirst();
      else if (!listed) summarySyncRef.current.refreshFirst();
      else readListed(id);
    };
    const onFilm = (data) => {
      if (summarySyncRef.current.statusFilter == null || data?.kind !== 'state' || !data.projectId || data.projectId === summarySyncRef.current.selectedId) return;
      if (!summarySyncRef.current.resetOnMembershipChange && !summarySyncRef.current.items.some((project) => project.id === data.projectId)) return;
      readListed(data.projectId, true);
    };
    const onRun = (data) => {
      if (!summarySyncRef.current.resetOnMembershipChange || !data?.projectId || data.projectId === summarySyncRef.current.selectedId) return;
      if (summarySyncRef.current.items.some((project) => project.id === data.projectId)) readListed(data.projectId);
    };
    socket.on('music-video:project:changed', onChanged);
    socket.on('music-video:blender', onFilm);
    socket.on('music-video:production', onRun);
    socket.on('music-video:autonomous', onRun);
    return () => { active = false; socket.off('music-video:project:changed', onChanged); socket.off('music-video:blender', onFilm); socket.off('music-video:production', onRun); socket.off('music-video:autonomous', onRun); };
  }, [enabled, statusFilter]);

  const { reconcileFirst } = summaries;
  useEffect(() => {
    setCatalogError(null);
    if (!enabled || !resetOnMembershipChange) return undefined;
    let active = true;
    let timer = null;
    let request = null;
    const pending = new Set();

    const flush = async () => {
      timer = null;
      if (!active || request || !pending.size) return;
      const ids = [...pending];
      pending.clear();
      const controller = new AbortController();
      request = controller;
      try {
        const affected = [];
        for (let offset = 0; offset < ids.length; offset += MAX_INGREDIENTS_PER_READ) {
          affected.push(...await getMusicVideoCatalogCompletion(ids.slice(offset, offset + MAX_INGREDIENTS_PER_READ), {
            signal: controller.signal, silent: true,
          }));
          if (!active) return;
        }
        const { items, matches: matchesName, setItems } = summarySyncRef.current;
        const listed = new Set(items.map(({ id }) => id));
        const leaving = new Set();
        let refresh = false;
        for (const project of affected) {
          const matches = project.isCompleted === (statusFilter === 'completed') && (!matchesName || matchesName(project));
          if (listed.has(project.id)) {
            if (!matches) leaving.add(project.id);
          } else if (!matchesName || matchesName(project)) {
            // Even an unlisted project that no longer matches may have
            // shifted the total or an offset on a later page.
            refresh = true;
          }
        }
        if (leaving.size) setItems(current => current.filter(({ id }) => !leaving.has(id)));
        if (leaving.size || refresh) void reconcileFirst();
        setCatalogError(null);
        schedule();
      } catch (err) {
        if (!active) return;
        const receivedWhileReading = pending.size > 0;
        ids.forEach(id => pending.add(id));
        setCatalogError(err?.message || 'Could not refresh projects after a catalog change');
        if (receivedWhileReading) schedule();
      } finally {
        request = null;
      }
    };

    function schedule() {
      if (pending.size && !timer) timer = setTimeout(() => { void flush(); }, CATALOG_BATCH_MS);
    }
    const onChanged = ({ ingredientId, sourceId, survivorId } = {}) => {
      for (const id of [ingredientId, sourceId, survivorId]) if (id) pending.add(id);
      if (!request) schedule();
    };
    retryCatalogRef.current = () => { if (!request && !timer) void flush(); };
    const events = ['catalog:assets-changed', 'catalog:primitive-changed', 'catalog:identity-changed'];
    events.forEach(event => socket.on(event, onChanged));
    return () => {
      active = false;
      clearTimeout(timer);
      request?.abort();
      retryCatalogRef.current = null;
      events.forEach(event => socket.off(event, onChanged));
    };
  }, [enabled, reconcileFirst, resetOnMembershipChange, statusFilter]);

  return { catalogError, retryCatalog: () => retryCatalogRef.current?.() };
}
