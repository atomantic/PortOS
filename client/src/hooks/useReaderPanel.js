import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getReaderPanel, getReaderPanelStatus,
  runReaderPanel, cancelReaderPanel, readerPanelSseUrl,
} from '../services/api';
import toast from '../components/ui/Toast';
import { usePipelineProgress } from './usePipelineProgress';

/**
 * Owns the reader-panel snapshot for a series plus the convene lifecycle:
 * initial load, re-attach to an in-flight run on (re)mount, per-persona SSE
 * progress, run/cancel, and a reload when the run ends. Mirrors
 * useSeriesEditorial — the panel is a sibling editorial view on the Reader Map
 * page (#2170).
 *
 * Returns the stored `panel` (personas[] + mined disagreements), `loadError` (a failed
 * read, distinct from a successful empty panel), the run state
 * (`running`/`starting`/`progressText`), and `reload`/`convene`/`cancel`.
 */
export function useReaderPanel(seriesId) {
  const [panel, setPanel] = useState(null);
  const [loading, setLoading] = useState(true);
  // A failed read is kept apart from a successful empty panel (`null`), so the
  // view can offer Retry instead of "hasn't met yet".
  const [loadError, setLoadError] = useState(null);
  // Run flag scoped to the series it belongs to; see useSeriesEditorial.
  const [runSeriesId, setRunSeriesId] = useState(null);
  const [starting, setStarting] = useState(false);
  const running = Boolean(seriesId) && runSeriesId === seriesId;
  const seriesIdRef = useRef(seriesId);

  // Keeps the panel already on screen when the read fails.
  const reload = useCallback(() => {
    if (!seriesId) return Promise.resolve();
    return getReaderPanel(seriesId, { silent: true })
      .then((data) => {
        if (seriesIdRef.current !== seriesId) return;
        setPanel(data);
        setLoadError(null);
      })
      .catch((err) => {
        if (seriesIdRef.current === seriesId) setLoadError(err ?? new Error('Request failed'));
      });
  }, [seriesId]);

  // Initial load + re-attach to a run still going from a prior visit so its
  // completion still refreshes this view. The `canceled` guard prevents a slow
  // response for a previous seriesId from overwriting the current one.
  useEffect(() => {
    seriesIdRef.current = seriesId;
    setPanel(null);
    setLoadError(null);
    if (!seriesId) { setLoading(false); return undefined; }
    let canceled = false;
    setLoading(true);
    getReaderPanel(seriesId, { silent: true })
      .then((data) => { if (!canceled) setPanel(data); })
      .catch((err) => { if (!canceled) setLoadError(err ?? new Error('Request failed')); })
      .finally(() => { if (!canceled) setLoading(false); });
    getReaderPanelStatus(seriesId, { silent: true })
      .then((s) => { if (!canceled && s?.active) setRunSeriesId(seriesId); })
      .catch(() => {});
    return () => { canceled = true; };
  }, [seriesId]);

  // Reload when the run ends. `closed` covers a terminal frame OR a dropped/404
  // stream, so the UI never hangs in "Convening…".
  const { latest, closed } = usePipelineProgress(readerPanelSseUrl, [seriesId], { enabled: running });
  useEffect(() => {
    if (closed && running) {
      setRunSeriesId(null);
      reload();
    }
  }, [closed, running, reload]);

  const convene = useCallback(() => {
    if (!seriesId) return;
    setStarting(true);
    runReaderPanel(seriesId, {}, { silent: true })
      .then(() => setRunSeriesId(seriesId))
      .catch((err) => toast.error(err?.message || 'Failed to convene panel'))
      .finally(() => setStarting(false));
  }, [seriesId]);

  const cancel = useCallback(() => {
    if (seriesId) cancelReaderPanel(seriesId).catch(() => {});
    setRunSeriesId(null);
    reload();
  }, [seriesId, reload]);

  const progressText = running
    ? (latest?.label ? `${latest.label}… (${latest.done || 0}/${latest.total || 4})` : 'Convening panel…')
    : null;

  return { panel, loading, loadError, reload, running, starting, convene, cancel, progressText };
}
