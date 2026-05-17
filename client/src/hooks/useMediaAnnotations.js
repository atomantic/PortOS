import { useCallback, useEffect, useRef, useState } from 'react';
import { listMediaAnnotations, setMediaAnnotation } from '../services/api';
import socket from '../services/socket';
import toast from '../components/ui/Toast';

// Per-entry: `own`/`others` from the server, plus back-compat aliases
// (`starred`/`note`/`updatedAt` = local author) and `anyNote` for the
// card-level "has notes" indicator (true when any author has a note).
function enrich(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const own = entry.own || null;
  const others = Array.isArray(entry.others) ? entry.others : [];
  return {
    own,
    others,
    starred: !!own?.starred,
    note: own?.note ?? '',
    updatedAt: own?.updatedAt ?? null,
    anyStarred: !!own?.starred || others.some((o) => o.starred),
    anyNote: !!(own?.note) || others.some((o) => o.note),
  };
}

function enrichAll(raw) {
  const out = {};
  for (const [key, entry] of Object.entries(raw || {})) {
    const e = enrich(entry);
    if (e) out[key] = e;
  }
  return out;
}

export function useMediaAnnotations() {
  const [annotations, setAnnotations] = useState({});
  // Mirror the latest annotations in a ref so toggleStar can read prior state
  // without using setAnnotations as a side-channel. Calling setState with a
  // side effect inside the updater function is unsafe under StrictMode /
  // concurrent rendering (state updaters must be pure).
  const annotationsRef = useRef(annotations);
  useEffect(() => { annotationsRef.current = annotations; }, [annotations]);

  useEffect(() => {
    let cancelled = false;
    listMediaAnnotations().then(
      (res) => { if (!cancelled) setAnnotations(enrichAll(res?.annotations)); },
      () => { /* fallback to empty map — non-fatal */ },
    );
    return () => { cancelled = true; };
  }, []);

  // Mirror server broadcasts so a note/star toggle in one view (or browser tab,
  // or a peer's machine via the sharing pipeline) shows up in every other open
  // consumer. The originator also receives this; the server entry is
  // authoritative and overrides the optimistic merge.
  useEffect(() => {
    const onUpdate = ({ key, entry }) => {
      if (!key) return;
      setAnnotations((prev) => {
        const next = { ...prev };
        const enriched = enrich(entry);
        if (enriched) next[key] = enriched;
        else delete next[key];
        return next;
      });
    };
    socket.on('media:annotation:updated', onUpdate);
    return () => socket.off('media:annotation:updated', onUpdate);
  }, []);

  const updateAnnotation = useCallback(async (key, patch) => {
    // Snapshot prior state synchronously from the ref — state updaters in
    // React 18 concurrent mode can be deferred or retried, so mutating an
    // outer `let prior` from inside `setAnnotations((prev) => { ... })` is
    // unsafe and would leave the revert path with the wrong (or undefined)
    // snapshot. The ref always reflects the latest committed state.
    const prior = annotationsRef.current[key];
    const priorOwn = prior?.own ?? null;
    const mergedOwn = {
      authorName: priorOwn?.authorName ?? '',
      starred: 'starred' in patch ? patch.starred : (priorOwn?.starred ?? false),
      note: 'note' in patch ? patch.note : (priorOwn?.note ?? ''),
      updatedAt: new Date().toISOString(),
    };
    const others = prior?.others ?? [];
    const ownEmpty = !mergedOwn.starred && !mergedOwn.note;
    const nextEntry = enrich({
      own: ownEmpty ? null : mergedOwn,
      others,
    });
    setAnnotations((prev) => {
      const next = { ...prev };
      if (!nextEntry || (!nextEntry.own && nextEntry.others.length === 0)) delete next[key];
      else next[key] = nextEntry;
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

  // Reads prior starred state from the ref so the callback's identity stays
  // stable across annotations updates (otherwise every MediaCard receives a
  // new `onToggleStar` prop after each star flip). The ref pattern replaces
  // the previous setAnnotations-as-side-channel, which violated React's
  // "state updaters must be pure" contract under StrictMode / concurrent
  // rendering.
  const toggleStar = useCallback((item) => {
    if (!item?.key) return;
    const priorStarred = !!annotationsRef.current[item.key]?.own?.starred;
    updateAnnotation(item.key, { starred: !priorStarred });
  }, [updateAnnotation]);

  // Shortcut for the `{ starred, hasNote, onToggleStar }` triple that every
  // <MediaCard> consumer reads from this hook. Callers spread it onto the card
  // and can still override individual fields (e.g. clear onToggleStar in
  // select/stitch modes by passing `onToggleStar={undefined}` after the spread).
  const getCardProps = useCallback((key) => ({
    starred: !!annotations[key]?.starred,
    hasNote: !!annotations[key]?.anyNote,
    onToggleStar: toggleStar,
  }), [annotations, toggleStar]);

  return { annotations, toggleStar, updateAnnotation, getCardProps };
}
