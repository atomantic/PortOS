/**
 * The system-resource disk scan plus its cleanup lifecycle, as one hook.
 *
 * `runSystemResourceReport` is an expensive multi-store scan whose result feeds
 * two unrelated surfaces — the Storage panel under Dev Tools and the downloaded-
 * model inventory under Models → Status. Both need the same three things around
 * it, and getting any of them subtly wrong is a data bug rather than a cosmetic
 * one:
 *
 *  - **Generation guarding.** Explicit refreshes and post-cleanup rescans
 *    overlap. Only the newest request may own the report or the loading flag —
 *    an older scan landing late must not resurrect candidates a newer scan
 *    already removed.
 *  - **One delete in flight.** `cleanupBusyRef` is checked *before* the state
 *    update, so a double-click can't fire two deletes for the same row.
 *  - **Invalidate on success.** Every candidate carries a server-issued action;
 *    after a removal the whole report is dropped (not patched) so no stale row
 *    stays clickable during the follow-up scan.
 *
 * Returns `{ report, setReport, loading, runReport, cleanup }`, where `cleanup`
 * is the prop bag `StoragePanel` / `ModelsPanel` / `CleanupControl` expect.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import * as api from '../services/api';
import toast from '../components/ui/Toast';
import { useConfirmDelete } from './useConfirmDelete.js';

// Maps a candidate's server-issued action to the delete call that honors it.
// Returning null for an unknown type is deliberate: a newer server may describe
// an action this client cannot perform, and refusing beats guessing.
const removeForAction = (action) => {
  if (action.type === 'data-category') return api.purgeDataCategory(action.key, {}, { silent: true });
  if (action.type === 'hf-model') return api.deleteCachedModel(action.dirName, { silent: true });
  if (action.type === 'model-store') return api.deleteModelStoreItem(action.backend, action.key, { silent: true });
  if (action.type === 'lora') return api.deleteLora(action.filename, { silent: true });
  if (action.type === 'local-model') return api.deleteLocalLlmModel(action.backend, action.modelId, { silent: true });
  return null;
};

export function useSystemResourceReport() {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const generationRef = useRef(0);
  const busyRef = useRef(null);
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();

  const runReport = useCallback(async () => {
    const generation = ++generationRef.current;
    cancelDelete();
    setLoading(true);
    const outcome = await api.runSystemResourceReport({ silent: true }).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    if (generation !== generationRef.current) return outcome.value || null;
    setLoading(false);
    if (outcome.error) {
      toast.error(outcome.error?.message || 'System report failed');
      return null;
    }
    if (outcome.value) setReport(outcome.value);
    return outcome.value || null;
  }, [cancelDelete]);

  const removeCandidate = useCallback(async (candidate) => {
    const action = candidate.action;
    if (!action || busyRef.current) return;
    busyRef.current = candidate.id;
    setBusyId(candidate.id);
    const result = await (removeForAction(action) || Promise.resolve(null)).catch((error) => {
      toast.error(error?.message || `Could not remove ${candidate.label}`);
      return null;
    });
    if (!result) {
      busyRef.current = null;
      setBusyId(null);
      return;
    }
    setReport(null);
    toast.success(`${candidate.label} removed`);
    await runReport();
    busyRef.current = null;
    setBusyId(null);
  }, [runReport]);

  const cleanup = useMemo(() => ({
    busyId,
    locked: busyId != null || loading,
    isConfirming,
    request: requestDelete,
    cancel: cancelDelete,
    confirm: (candidate) => confirmDelete(() => removeCandidate(candidate)),
  }), [busyId, loading, isConfirming, requestDelete, cancelDelete, confirmDelete, removeCandidate]);

  return { report, setReport, loading, runReport, cleanup };
}

export default useSystemResourceReport;
