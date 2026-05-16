import { useCallback, useEffect, useState } from 'react';
import { listMediaAnnotations, setMediaAnnotation } from '../services/api';
import socket from '../services/socket';
import toast from '../components/ui/Toast';

// Loads the full media-annotation map once and exposes optimistic-update
// helpers. Shared by every gallery surface (MediaHistory, ImageGen, VideoGen,
// MediaCollectionDetail) so favorites stay in sync across pages and the same
// optimistic-update / revert behavior lives in one place.
//
// Returns:
//   annotations          — { [key]: { starred, note, updatedAt } }
//   toggleStar(item)     — flips starred for item.key (optimistic + revert on error)
//   updateAnnotation(key, patch) — generic partial update used by the lightbox note editor
export function useMediaAnnotations() {
  const [annotations, setAnnotations] = useState({});

  useEffect(() => {
    let cancelled = false;
    listMediaAnnotations().then(
      (res) => { if (!cancelled) setAnnotations(res?.annotations || {}); },
      () => { /* fallback to empty map — non-fatal */ },
    );
    return () => { cancelled = true; };
  }, []);

  // Mirror server broadcasts so a note/star toggle in one view (or browser tab)
  // shows up in every other open consumer. Originator also receives this; the
  // server entry is authoritative and overrides the optimistic merge.
  useEffect(() => {
    const onUpdate = ({ key, entry }) => {
      if (!key) return;
      setAnnotations((prev) => {
        const next = { ...prev };
        if (entry) next[key] = entry;
        else delete next[key];
        return next;
      });
    };
    socket.on('media:annotation:updated', onUpdate);
    return () => socket.off('media:annotation:updated', onUpdate);
  }, []);

  const updateAnnotation = useCallback(async (key, patch) => {
    // Snapshot prior state for revert; build optimistic next state.
    let prior;
    setAnnotations((prev) => {
      prior = prev[key];
      const merged = {
        starred: 'starred' in patch ? patch.starred : (prior?.starred ?? false),
        note: 'note' in patch ? patch.note : (prior?.note ?? ''),
        updatedAt: new Date().toISOString(),
      };
      const next = { ...prev };
      if (!merged.starred && !merged.note) delete next[key];
      else next[key] = merged;
      return next;
    });
    const res = await setMediaAnnotation(key, patch).catch((err) => {
      toast.error(err?.message || 'Failed to save annotation');
      setAnnotations((prev) => {
        const reverted = { ...prev };
        if (prior) reverted[key] = prior;
        else delete reverted[key];
        return reverted;
      });
      return null;
    });
    return res?.entry ?? null;
  }, []);

  // Reads prior starred state from the functional setter so the callback's
  // identity doesn't change on every annotations update (otherwise every
  // MediaCard receives a new `onToggleStar` prop after each star flip).
  const toggleStar = useCallback((item) => {
    if (!item?.key) return;
    setAnnotations((prev) => {
      updateAnnotation(item.key, { starred: !prev[item.key]?.starred });
      return prev;
    });
  }, [updateAnnotation]);

  return { annotations, toggleStar, updateAnnotation };
}
