import { useCallback, useEffect, useRef } from 'react';
import { updatePipelineSeries } from '../services/api';

// Host-side wiring for the embedded <ArcCanvas>. The canvas edits `series.arc`
// + the issue roadmap in place and expects three callbacks from its host:
//
//   onSeriesUpdate  → updateSeriesFromServer(next): a server-confirmed series
//                     setter that also advances the dirty-check baseline so a
//                     subsequent flushPending() doesn't re-PATCH the same state.
//   onIssuesUpdate  → handleIssuesUpdate(update): accepts ArcCanvas's
//                     `setState(fn)`-shaped updates AND plain arrays.
//   onFlushPending  → flushPending(): if local bible fields diverged from the
//                     last server snapshot, PATCH so generate / verify / resolve
//                     run against the on-screen state. Returns `true` when a save
//                     occurred, `false` for a clean no-op, and `null` if a save failed.
//                     Dependent actions must stop on `null`.
//
// A fourth callback, `onRegisterDraftFlush` → registerDraftFlush(fn), lets a
// descendant that owns an unsaved *draft* (the ArcContent logline / summary /
// protagonist-arc editor) hand up a committer. flushPending() runs it after the
// bible PATCH, so "flush before you act" covers an open arc editor too — without
// which clicking Lock & continue / Generate / Save while the editor is open
// silently discards what is on screen (#3907). The registered fn returns `true`
// when it saved, `false` for no changes, and `null` after reporting a save error.
//
// Both PipelineSeries and the embedded StoryBuilder arc step used to hand-roll
// this identical contract; the only real divergence is WHICH bible fields each
// host flushes (PipelineSeries carries 10 + cover/style overrides; StoryBuilder
// only 6) and whether a pre-flush save failure toasts or is swallowed. Those are
// the parameters below.
//
// `lastSavedRef` is a ref (not state) — we only need up-to-date comparison data
// for the async flush, not a re-render. Its baseline is (re)captured on the
// FIRST load of each series, keyed on `id`, so an unrelated refetch can't clobber
// the baseline (which would defeat the dirty-check) and navigating between series
// resets it. After capture it only advances via updateSeriesFromServer.
//
// updateSeriesFromServer MERGES rather than replaces (#8423). Sibling actions
// (format select, render pin, logo generation, season add, theme chips, a cover
// render landing, autopilot/review refetches) hand it a whole record while the
// user still has unsaved bible edits. A bible field is "pending" when the local
// value differs from the baseline; pending fields keep their local value AND
// their old baseline, so they stay dirty and the next Save still PATCHes them.
// Keeping the old baseline (not `next[k]`) matters because several callers build
// `next` from the local `series` (`{ ...series, seasons }`), which already
// carries the unsaved text — adopting it would mark those edits saved without
// any PATCH. Every other field takes the incoming value on both sides. Only
// flushPending, which knows its record came back from the bible PATCH, adopts
// the response wholesale as the new baseline.

const fieldValue = (record, k) => (k === 'llm' ? JSON.stringify(record?.llm || {}) : (record?.[k] ?? ''));
const pendingFields = (series, saved, flushFields) => (
  series && saved ? [...flushFields, 'llm'].filter((k) => fieldValue(series, k) !== fieldValue(saved, k)) : []
);

export function useArcCanvasSync({
  series,
  setSeries,
  setIssues,
  flushFields,
  payloadDefaults = {},
  silent = false,
  onFlushError,
}) {
  const lastSavedRef = useRef(null);
  // Latest committed local state, for server updates that land after an await.
  const latestSeriesRef = useRef(series);
  useEffect(() => {
    latestSeriesRef.current = series;
    if (series && lastSavedRef.current?.id !== series.id) lastSavedRef.current = series;
  }, [series]);

  // Committer handed up by an open draft editor (see the header comment). Held
  // in a ref, not state — registering must not re-render the host, and
  // flushPending only needs the latest value at call time.
  const draftFlushRef = useRef(null);
  const registerDraftFlush = useCallback((fn) => { draftFlushRef.current = fn || null; }, []);

  // `fromFlush` is internal: flushPending's PATCH response is the true server
  // state for every bible field, so it becomes the baseline outright.
  const applyServerRecord = useCallback((next, { fromFlush = false } = {}) => {
    const saved = lastSavedRef.current;
    const pendingIn = (local) => (
      next && saved?.id === next.id && local?.id === next.id ? pendingFields(local, saved, flushFields) : []
    );
    // The local merge reads `prev` so an edit queued in the same tick counts;
    // React may run this updater lazily, so the baseline below can't depend on it.
    setSeries((prev) => {
      const pending = pendingIn(prev);
      if (!pending.length) return next;
      const merged = { ...next };
      for (const k of pending) merged[k] = prev[k];
      return merged;
    });
    const pending = fromFlush ? [] : pendingIn(latestSeriesRef.current);
    if (!pending.length) {
      lastSavedRef.current = next;
      return;
    }
    const baseline = { ...next };
    for (const k of pending) baseline[k] = saved[k];
    lastSavedRef.current = baseline;
  }, [setSeries, flushFields]);

  const updateSeriesFromServer = useCallback((next) => applyServerRecord(next), [applyServerRecord]);

  const handleIssuesUpdate = useCallback((update) => {
    setIssues((prev) => {
      if (typeof update === 'function') return update(prev);
      if (Array.isArray(update)) return update;
      return prev;
    });
  }, [setIssues]);

  const flushPending = useCallback(async () => {
    if (!series) return false;
    const saved = lastSavedRef.current || series;
    let didSave = false;
    if (pendingFields(series, saved, flushFields).length) {
      // Build the PATCH payload from the same field list, applying any per-field
      // empty-value default (e.g. `titleLogo: '' ` so the server clears rather than
      // sees `undefined`). `llm` is always sent.
      const patch = { llm: series.llm || { provider: null, model: null } };
      for (const k of flushFields) {
        patch[k] = k in payloadDefaults ? (series[k] || payloadDefaults[k]) : series[k];
      }
      const updated = await updatePipelineSeries(series.id, patch, { silent })
        .catch((err) => {
          if (onFlushError) onFlushError(err);
          return null;
        });
      if (!updated) return null;
      applyServerRecord(updated, { fromFlush: true });
      didSave = true;
    }
    // Bible PATCH first, THEN the draft — the draft committer's response then
    // carries the bible fields too, so lastSavedRef ends on the freshest record.
    if (draftFlushRef.current) {
      const draftSaved = await draftFlushRef.current();
      if (draftSaved === null) return null;
      if (draftSaved) didSave = true;
    }
    return didSave;
  }, [series, flushFields, payloadDefaults, silent, onFlushError, applyServerRecord]);

  // Unsaved bible edits, for a host's navigation guard. Only meaningful once the
  // baseline belongs to the rendered series — right after a series switch the
  // ref still holds the previous one until the capture effect runs.
  // Read per render, not memoized: the baseline is a ref, and every path that
  // moves it also sets `series`, so the next render sees both.
  const saved = lastSavedRef.current;
  const isDirty = !!series && saved?.id === series.id && pendingFields(series, saved, flushFields).length > 0;

  return { updateSeriesFromServer, handleIssuesUpdate, flushPending, registerDraftFlush, isDirty };
}
