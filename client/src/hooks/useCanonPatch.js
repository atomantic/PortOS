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
  const scopeRef = useRef({ id: universe?.id, fields: new Map() });
  if (scopeRef.current.id !== universe?.id) {
    scopeRef.current = { id: universe?.id, fields: new Map() };
  }

  const patchEntry = useCallback((kind, entryId, patch) => {
    const latest = current.current;
    if (!latest || !patch || typeof patch !== 'object') return Promise.resolve();
    const field = kind.key;
    const target = latest[field]?.find(entry => entry.id === entryId);
    if (!target) return Promise.resolve();
    const scope = scopeRef.current;
    const token = {};
    const edits = Object.keys(patch).map(key => {
      const path = JSON.stringify([field, entryId, key]);
      const state = scope.fields.get(path) || { saved: target[key] };
      state.latest = token;
      scope.fields.set(path, state);
      return { key, path, state };
    });
    const publish = value => { current.current = value; applyRef.current(value); };
    publish({ ...latest, [field]: latest[field].map(entry => entry.id === entryId ? { ...entry, ...patch } : entry) });
    const settle = result => {
      if (!mountedRef.current || scopeRef.current !== scope) return;
      const live = current.current;
      const updatedAt = result?.universe?.updatedAt;
      const olderSnapshot = updatedAt && live.updatedAt && updatedAt < live.updatedAt;
      // Track field ownership separately from the displayed snapshot: a sibling
      // operation may have replaced that snapshot while this edit was pending.
      const owned = edits.filter(({ key, path, state }) => {
        if (result) state.saved = result.entry[key];
        if (state.latest !== token) return false;
        scope.fields.delete(path);
        return true;
      });
      publish({
        ...live,
        updatedAt: updatedAt && (!live.updatedAt || updatedAt > live.updatedAt) ? updatedAt : live.updatedAt,
        [field]: live[field].map(entry => {
          if (entry.id !== entryId) return entry;
          const next = { ...entry };
          for (const { key, state } of owned) {
            const stillOptimistic = JSON.stringify(entry[key]) === JSON.stringify(patch[key]);
            // Failed edits roll back to the last confirmed value. A newer server
            // snapshot or a newer local edit keeps its own field value.
            if ((result && !olderSnapshot) || stillOptimistic) next[key] = state.saved;
          }
          return next;
        }),
      });
    };

    return patchUniverseCanonEntry(
      latest.id, kind.apiKind || kind.singular, entryId, patch, { silent: true },
    ).then(result => { settle(result); }).catch(err => {
      settle(null);
      toast.error(`Save failed: ${err.message}`);
    });
  }, [mountedRef]);

  return { patchEntry };
}

export default useCanonPatch;
