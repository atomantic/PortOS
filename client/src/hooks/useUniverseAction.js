import { useCallback } from 'react';
import toast from '../components/ui/Toast';
import { upsertByIdPrepend } from '../lib/upsertByIdPrepend';

// Scaffolding for LLM-driven universe mutations that follow the
// "guarded API call → setWorlds → stale-write-checked setDraft" pattern.
// Used by handlePromoteVariation + handleAutoSort in UniverseBuilder.jsx.
//
// handleGenerateInCategory is intentionally NOT a consumer — it does an
// eager local merge first and then a best-effort save, so the guard /
// loading-toast / required-savedId shape doesn't fit. Forcing it through
// would warp it for almost no shared scaffolding.
//
// `action(capturedId)` must pass `{ silent: true }` to its API helper so
// toasts only fire from this hook (per CLAUDE.md "Custom catch ⇒ silent").
// `onFreshResult(result, { capturedId })` runs only when the user is still
// on the same universe; return a string to use as the success toast.
// `preflight()` runs AFTER the ref/savedId guards (so duplicate clicks short-
// circuit before it fires) but BEFORE the loading toast + LLM action. Return
// a falsy value to abort (the preflight is responsible for any failure toast).
// Used to flush a dirty draft via handleSave() so the LLM action operates
// against the user's latest local edits rather than a stale persisted copy.
export default function useUniverseAction({ selectedId, mountedRef, setWorlds }) {
  return useCallback(async function runUniverseAction({
    ref,
    setBusy,
    loadingMessage,
    errorPrefix = 'Action failed',
    notSavedMessage = 'Save the universe first',
    action,
    onFreshResult,
    preflight,
  }) {
    if (!selectedId) {
      toast.error(notSavedMessage);
      return null;
    }
    if (ref?.current) return null;
    if (ref) ref.current = true;
    setBusy?.(true);
    if (typeof preflight === 'function') {
      const ok = await preflight().catch(() => false);
      if (!ok) {
        if (mountedRef.current) {
          if (ref) ref.current = false;
          setBusy?.(false);
        }
        return null;
      }
    }
    const capturedId = selectedId;
    const toastId = loadingMessage ? toast.loading(loadingMessage) : null;

    const result = await action(capturedId).catch((e) => {
      if (toastId) toast.dismiss(toastId);
      toast.error(`${errorPrefix}: ${e.message}`);
      return null;
    });

    if (mountedRef.current) {
      if (ref) ref.current = false;
      setBusy?.(false);
    }

    if (!result?.universe) {
      if (toastId) toast.dismiss(toastId);
      return result;
    }

    // Always update the cached worlds list — even if the user navigated
    // away mid-flight, the persisted shape changed and other surfaces
    // (list page, palette) should see it.
    const updated = result.universe;
    setWorlds((prev) => upsertByIdPrepend(prev, updated));

    if (!mountedRef.current || capturedId !== selectedId) {
      if (toastId) toast.dismiss(toastId);
      return result;
    }

    const successMessage = onFreshResult ? onFreshResult(result, { capturedId }) : null;
    if (toastId) toast.dismiss(toastId);
    if (typeof successMessage === 'string' && successMessage) toast.success(successMessage);
    return result;
  }, [selectedId, mountedRef, setWorlds]);
}
