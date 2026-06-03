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
// Staleness guard: the captured `universeId` is compared against the live id on
// completion, so a slow PATCH from a previous universe can't repopulate state
// after the caller navigates to a different world.
//
// Usage:
//   const { patchEntry } = useCanonPatch({ universe, universeId, apply: setUniverse, mountedRef });
//   <Card onPatchEntry={(entryId, patch) => patchEntry(kind, entryId, patch)} />
export function useCanonPatch({ universe, universeId, apply, mountedRef }) {
  const currentUniverseIdRef = useRef(universeId);
  useEffect(() => { currentUniverseIdRef.current = universeId; }, [universeId]);

  const patchEntry = useCallback(async (kind, entryId, patch) => {
    if (!universe || !patch || typeof patch !== 'object') return;
    const capturedId = universeId;
    const kindKey = kind.key;
    const list = (universe[kindKey] || []).map((e) =>
      e.id === entryId ? { ...e, ...patch } : e
    );
    apply({ ...universe, [kindKey]: list });
    const updated = await updateUniverse(universeId, { [kindKey]: list })
      .catch((err) => { toast.error(`Save failed: ${err.message}`); return null; });
    if (updated && mountedRef.current && currentUniverseIdRef.current === capturedId) {
      apply(updated);
    }
  }, [universe, universeId, apply, mountedRef]);

  return { patchEntry };
}

export default useCanonPatch;
