import { useCallback, useRef } from 'react';
import toast from '../components/ui/Toast';
import { patchUniverseCanonEntry } from '../services/apiUniverseBuilder';

// Optimistic field edits for UniverseCanonSection and NounsStage. Accepted
// writes finish in click order, including after navigation; only their UI
// acknowledgements are bound to the current visit. The server merges each
// field patch inside its existing record write queue instead of replacing a
// client snapshot of the whole canon array.
export function useCanonPatch({ universe, apply, mountedRef }) {
  const current = useRef(universe);
  current.current = universe;
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const scopeRef = useRef({ id: universe?.id });
  if (scopeRef.current.id !== universe?.id) {
    scopeRef.current = { id: universe?.id };
  }

  const patchEntry = useCallback((kind, entryId, patch) => {
    const latest = current.current;
    if (!latest || !patch || typeof patch !== 'object') return Promise.resolve();
    const field = kind.key;
    if (!latest[field]?.some(entry => entry.id === entryId)) return Promise.resolve();
    const scope = scopeRef.current;
    const publish = value => { current.current = value; applyRef.current(value); };
    publish({ ...latest, [field]: latest[field].map(entry => entry.id === entryId ? { ...entry, ...patch } : entry) });

    return patchUniverseCanonEntry(
      latest.id, kind.apiKind || kind.singular, entryId, patch, { silent: true },
    ).then(result => {
      if (!mountedRef.current || scopeRef.current !== scope || !result?.entry) return;
      const live = current.current;
      const updatedAt = result.universe?.updatedAt;
      // Acknowledgements normalize only submitted fields that are still
      // unchanged. Newer edits, sibling entries and other canon kinds stay put.
      publish({ ...live,
        updatedAt: updatedAt && (!live.updatedAt || updatedAt > live.updatedAt) ? updatedAt : live.updatedAt,
        [field]: live[field].map(entry => {
        if (entry.id !== entryId) return entry;
        const next = { ...entry };
        for (const key of Object.keys(patch)) {
          if (JSON.stringify(entry[key]) === JSON.stringify(patch[key])) next[key] = result.entry[key];
        }
        return next;
      }) });
    }).catch(err => { toast.error(`Save failed: ${err.message}`); });
  }, [mountedRef]);

  return { patchEntry };
}

export default useCanonPatch;
