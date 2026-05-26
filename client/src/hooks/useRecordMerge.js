import { useState, useCallback } from 'react';
import toast from '../components/ui/Toast';
import {
  previewUniverseMerge, mergeUniverses, previewSeriesMerge, mergeSeries,
  aiResolveUniverseMerge, aiResolveSeriesMerge,
} from '../services/api';

// `choices[field]` value space. SURVIVOR/LOSER mirror the server's Zod enum;
// AI is client-only and means "use the value at overrides[field]" (populated
// by runAIMerge, editable via updateOverride). Kept as a const so the modal
// and the executeMerge wire-payload filter agree on the legal set.
export const MERGE_CHOICE = { SURVIVOR: 'survivor', LOSER: 'loser', AI: 'ai' };

// Orchestrates the duplicate-record merge flow (Universe or Series): open →
// dry-run preview → resolve field conflicts → execute. Drives <MergeModal>
// from both Sharing → Duplicates (DuplicatesTab) and the inline resolver on
// the Universes page. `onMerged` refreshes the caller's list after the loser
// is tombstoned.
export function useRecordMerge({ onMerged } = {}) {
  // { kind, records, survivorId, loserId, preview, choices, overrides, aiBusy, busy }
  const [merge, setMerge] = useState(null);

  const runPreview = useCallback(async (kind, survivorId, loserId, records) => {
    // Commit the new survivor/loser ids and invalidate the current preview up
    // front so a quick "Merge" click during the in-flight request can't run with
    // stale ids/choices (the Merge button gates on `busy || !preview`).
    setMerge((m) => (m ? {
      ...m, kind, survivorId, loserId, records: records || m.records, preview: null, choices: {}, overrides: {}, busy: true,
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
      overrides: {},
      busy: false,
    } : m));
  }, []);

  const openMerge = useCallback(async (kind, records) => {
    const survivorId = records[0].id;
    const loserId = records[1].id;
    setMerge({ kind, records, survivorId, loserId, preview: null, choices: {}, overrides: {}, busy: true });
    await runPreview(kind, survivorId, loserId, records);
  }, [runPreview]);

  // Synthesize a unified value per conflicting text field via the configured
  // AI provider; populate `overrides[field]` + flip `choices[field]` to AI so
  // the modal renders the editable textarea. Skipped fields (non-string) stay
  // on their existing survivor/loser choice.
  //
  // Staleness: if the user swaps survivor/loser (re-preview) while the AI call
  // is in flight, the survivorId/loserId/kind snapshot below will no longer
  // match the latest state — drop the response on the floor in that case so a
  // late AI result doesn't write overrides for the wrong pair.
  const runAIMerge = useCallback(async () => {
    if (!merge?.preview) return;
    const { kind, survivorId, loserId, preview } = merge;
    const fields = (preview.conflicts || []).map((c) => c.field);
    if (fields.length === 0) return;
    setMerge((m) => (m ? { ...m, aiBusy: true } : m));
    const resolveFn = kind === 'universe' ? aiResolveUniverseMerge : aiResolveSeriesMerge;
    const result = await resolveFn({ survivorId, loserId, fields }, { silent: true }).catch((err) => {
      toast.error(`AI merge failed: ${err.message}`);
      return null;
    });
    let applied = false;
    setMerge((m) => {
      if (!m) return m;
      if (!result) return { ...m, aiBusy: false };
      if (m.kind !== kind || m.survivorId !== survivorId || m.loserId !== loserId) {
        return { ...m, aiBusy: false };
      }
      const merged = result.merged || {};
      const nextOverrides = { ...m.overrides };
      const nextChoices = { ...m.choices };
      for (const [field, value] of Object.entries(merged)) {
        if (typeof value !== 'string') continue;
        nextOverrides[field] = value;
        nextChoices[field] = MERGE_CHOICE.AI;
      }
      applied = true;
      return { ...m, aiBusy: false, overrides: nextOverrides, choices: nextChoices };
    });
    if (!applied) return;
    if (result?.skipped?.length) {
      toast.warning(`AI skipped ${result.skipped.length} non-text field(s) — pick those manually.`);
    } else {
      toast.success('AI merged the conflicting fields — review and edit before applying.');
    }
  }, [merge]);

  const updateOverride = useCallback((field, value) => {
    setMerge((m) => (m ? { ...m, overrides: { ...m.overrides, [field]: value } } : m));
  }, []);

  const executeMerge = useCallback(async () => {
    if (!merge) return;
    const { kind, survivorId, loserId, choices, overrides } = merge;
    const fieldOverrides = {};
    const fieldChoices = {};
    for (const [field, c] of Object.entries(choices || {})) {
      if (c === MERGE_CHOICE.AI && typeof overrides?.[field] === 'string') {
        fieldOverrides[field] = overrides[field];
      } else if (c === MERGE_CHOICE.SURVIVOR || c === MERGE_CHOICE.LOSER) {
        fieldChoices[field] = c;
      }
    }
    setMerge((m) => (m ? { ...m, busy: true } : m));
    const run = kind === 'universe' ? mergeUniverses : mergeSeries;
    // Only include `fieldOverrides` when populated — keeps the wire payload
    // identical to pre-AI-merge clients on the common "no AI used" path.
    const payload = Object.keys(fieldOverrides).length > 0
      ? { survivorId, loserId, fieldChoices, fieldOverrides }
      : { survivorId, loserId, fieldChoices };
    const ok = await run(payload, { silent: true })
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

  return { merge, setMerge, openMerge, runPreview, executeMerge, runAIMerge, updateOverride };
}
