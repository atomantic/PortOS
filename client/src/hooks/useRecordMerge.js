import { useState, useCallback } from 'react';
import toast from '../components/ui/Toast';
import {
  previewUniverseMerge, mergeUniverses, previewSeriesMerge, mergeSeries,
} from '../services/api';

// Orchestrates the duplicate-record merge flow (Universe or Series): open →
// dry-run preview → resolve field conflicts → execute. The returned `merge`
// state object drives <MergeModal>; `openMerge`/`runPreview`/`executeMerge`
// are the handlers it (and the trigger button) call. `onMerged` runs after a
// successful merge so the caller can refresh its list (the loser is tombstoned).
//
// Shared between Sharing → Duplicates (DuplicatesTab) and the inline resolver
// on the Universes page so both surface identical merge behavior.
//
// Usage:
//   const { merge, setMerge, openMerge, runPreview, executeMerge } =
//     useRecordMerge({ onMerged: reload });
//   <DuplicateGroup kind="universe" group={g} onMerge={openMerge} ... />
//   {merge && <MergeModal merge={merge} setMerge={setMerge}
//     onExecute={executeMerge}
//     onRepreview={(s, l) => runPreview(merge.kind, s, l, merge.records)} />}
export function useRecordMerge({ onMerged } = {}) {
  // { kind, records, survivorId, loserId, preview, choices, busy }
  const [merge, setMerge] = useState(null);

  const runPreview = useCallback(async (kind, survivorId, loserId, records) => {
    // Commit the new survivor/loser ids and invalidate the current preview up
    // front so a quick "Merge" click during the in-flight request can't run with
    // stale ids/choices (the Merge button gates on `busy || !preview`).
    setMerge((m) => (m ? {
      ...m, kind, survivorId, loserId, records: records || m.records, preview: null, choices: {}, busy: true,
    } : m));
    const previewFn = kind === 'universe' ? previewUniverseMerge : previewSeriesMerge;
    const result = await previewFn({ survivorId, loserId }, { silent: true }).catch((err) => {
      toast.error(`Preview failed: ${err.message}`);
      return null;
    });
    setMerge((m) => (m ? {
      ...m, kind, survivorId, loserId, records: records || m.records, preview: result,
      // Default each conflicting field to the survivor's value.
      choices: Object.fromEntries((result?.conflicts || []).map((c) => [c.field, 'survivor'])),
      busy: false,
    } : m));
  }, []);

  const openMerge = useCallback(async (kind, records) => {
    const survivorId = records[0].id;
    const loserId = records[1].id;
    setMerge({ kind, records, survivorId, loserId, preview: null, choices: {}, busy: true });
    await runPreview(kind, survivorId, loserId, records);
  }, [runPreview]);

  const executeMerge = useCallback(async () => {
    if (!merge) return;
    const { kind, survivorId, loserId, choices } = merge;
    setMerge((m) => (m ? { ...m, busy: true } : m));
    const run = kind === 'universe' ? mergeUniverses : mergeSeries;
    const ok = await run({ survivorId, loserId, fieldChoices: choices }, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(`Merge failed: ${err.message}`); return false; });
    if (ok) {
      toast.success('Merged — the duplicate was folded in and tombstoned.');
      setMerge(null);
      await onMerged?.();
    } else {
      setMerge((m) => (m ? { ...m, busy: false } : m));
    }
  }, [merge, onMerged]);

  return { merge, setMerge, openMerge, runPreview, executeMerge };
}
