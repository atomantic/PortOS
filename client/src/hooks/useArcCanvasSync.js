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
//                     occurred so the caller can surface a confirmation toast.
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
  useEffect(() => {
    if (series && lastSavedRef.current?.id !== series.id) lastSavedRef.current = series;
  }, [series]);

  const updateSeriesFromServer = useCallback((next) => {
    setSeries(next);
    lastSavedRef.current = next;
  }, [setSeries]);

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
    const dirty = flushFields.some((k) => (series[k] ?? '') !== (saved[k] ?? ''))
      || JSON.stringify(series.llm || {}) !== JSON.stringify(saved.llm || {});
    if (!dirty) return false;
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
    if (!updated) return false;
    updateSeriesFromServer(updated);
    return true;
  }, [series, flushFields, payloadDefaults, silent, onFlushError, updateSeriesFromServer]);

  return { updateSeriesFromServer, handleIssuesUpdate, flushPending };
}
