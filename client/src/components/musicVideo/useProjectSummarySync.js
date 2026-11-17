import { useEffect, useRef } from 'react';
import socket from '../../services/socket';
import { getMusicVideoProject } from '../../services/apiMusicVideo.js';

/**
 * Keeps the project index and header picker (`summaries`, a usePagedCollection)
 * current with projects changed elsewhere (#15724): a listed project is read
 * again by id (dropped on a 404), an unlisted one refreshes the first page. The
 * open project and this tab's own writes are skipped; the page follows those.
 */
export default function useProjectSummarySync({ summaries, selectedId, enabled, resetOnMembershipChange = false }) {
  const summarySyncRef = useRef(null);
  summarySyncRef.current = {
    selectedId,
    resetOnMembershipChange,
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
    const readListed = (id) => {
      const slot = inflight.get(id);
      if (slot) { slot.queued = true; return; }
      inflight.set(id, { queued: false });
      getMusicVideoProject(id, { silent: true })
        .then((fresh) => {
          if (!active || !fresh) return;
          const current = summarySyncRef.current;
          const previous = current.items.find((p) => p.id === id);
          if (current.resetOnMembershipChange && previous && (previous.status === 'complete') !== (fresh.status === 'complete')) {
            current.setItems((items) => items.filter((p) => p.id !== id));
            current.reconcileFirst();
          } else current.setItems((prev) => prev.map((p) => (p.id === id ? fresh : p)));
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
          if (active && current?.queued) readListed(id);
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
    socket.on('music-video:project:changed', onChanged);
    return () => { active = false; socket.off('music-video:project:changed', onChanged); };
  }, [enabled]);
}
