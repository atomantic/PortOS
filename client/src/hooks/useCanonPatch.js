import { useCallback, useEffect, useRef } from 'react';
import toast from '../components/ui/Toast';
import { updateUniverse } from '../services/apiUniverseBuilder';

// Shared optimistic canon-entry patch handler. `UniverseCanonSection` and
// `NounsStage` had ~95%-identical inline handlers: rebuild the kind list with
// one entry mutated, apply it to local state immediately so the edit feels
// instant, PATCH the universe, then re-apply the server's authoritative copy.
//
// `apply` is the optimistic-state setter — `setUniverse` (when the caller owns
// `universe` via `useUniverse`) or `onUniverseChange` (when a parent owns the
// draft). It's called with the full next universe object.
//
// The PATCH targets and is staleness-guarded on the LOADED record's `id`
// (`universe.id`), NOT a separately-passed prop. NounsStage drives `universe`
// from `useUniverse(series.universeId)`, which can briefly expose the previous
// universe while a series/universe switch is in flight — keying off the record
// we actually built the list from means we never send one universe's canon to
// another's id, and a re-apply that lands after the loaded universe swapped (or
// cleared) is dropped instead of resurrecting stale state.
//
// Usage:
//   const { patchEntry } = useCanonPatch({ universe, apply: setUniverse, mountedRef });
//   <Card onPatchEntry={(entryId, patch) => patchEntry(kind, entryId, patch)} />
export function useCanonPatch({ universe, apply, mountedRef }) {
  // Live mirror of the loaded universe's id so a PATCH that resolves after the
  // record swapped can compare against the current id and bow out.
  const currentUniverseIdRef = useRef(universe?.id);
  useEffect(() => { currentUniverseIdRef.current = universe?.id; }, [universe?.id]);

  const patchEntry = useCallback(async (kind, entryId, patch) => {
    if (!universe || !patch || typeof patch !== 'object') return;
    const capturedId = universe.id;
    const kindKey = kind.key;
    const list = (universe[kindKey] || []).map((e) =>
      e.id === entryId ? { ...e, ...patch } : e
    );
    apply({ ...universe, [kindKey]: list });
    // `{ silent: true }` because the .catch below owns the failure toast —
    // without it the apiCore request() helper fires a second, duplicate one
    // (CLAUDE.md "Custom catch ⇒ silent: true").
    const updated = await updateUniverse(capturedId, { [kindKey]: list }, { silent: true })
      .catch((err) => { toast.error(`Save failed: ${err.message}`); return null; });
    if (updated && mountedRef.current && currentUniverseIdRef.current === capturedId) {
      apply(updated);
    }
  }, [universe, apply, mountedRef]);

  return { patchEntry };
}

export default useCanonPatch;
