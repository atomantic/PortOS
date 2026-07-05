import { useCallback, useEffect, useState } from 'react';
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
 * Returns the stored `panel` (personas[] + mined disagreements), the run state
 * (`running`/`starting`/`progressText`), and `reload`/`convene`/`cancel`.
 */
export function useReaderPanel(seriesId) {
  const [panel, setPanel] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);

  const reload = useCallback(() => {
    if (!seriesId) return Promise.resolve();
    return getReaderPanel(seriesId, { silent: true })
      .then((data) => setPanel(data))
      .catch(() => setPanel(null));
  }, [seriesId]);

  // Initial load + re-attach to a run still going from a prior visit so its
  // completion still refreshes this view. The `canceled` guard prevents a slow
  // response for a previous seriesId from overwriting the current one.
  useEffect(() => {
    if (!seriesId) { setLoading(false); return undefined; }
    let canceled = false;
    setLoading(true);
    getReaderPanel(seriesId, { silent: true })
      .then((data) => { if (!canceled) setPanel(data); })
      .catch(() => { if (!canceled) setPanel(null); })
      .finally(() => { if (!canceled) setLoading(false); });
    getReaderPanelStatus(seriesId, { silent: true })
      .then((s) => { if (!canceled && s?.active) setRunning(true); })
      .catch(() => {});
    return () => { canceled = true; };
  }, [seriesId]);

  // Reload when the run ends. `closed` covers a terminal frame OR a dropped/404
  // stream, so the UI never hangs in "Convening…".
  const { latest, closed } = usePipelineProgress(readerPanelSseUrl, [seriesId], { enabled: running });
  useEffect(() => {
    if (closed && running) {
      setRunning(false);
      reload();
    }
  }, [closed, running, reload]);

  const convene = useCallback(() => {
    if (!seriesId) return;
    setStarting(true);
    runReaderPanel(seriesId, {}, { silent: true })
      .then(() => setRunning(true))
      .catch((err) => toast.error(err?.message || 'Failed to convene panel'))
      .finally(() => setStarting(false));
  }, [seriesId]);

  const cancel = useCallback(() => {
    if (seriesId) cancelReaderPanel(seriesId).catch(() => {});
    setRunning(false);
    reload();
  }, [seriesId, reload]);

  const progressText = running
    ? (latest?.label ? `${latest.label}… (${latest.done || 0}/${latest.total || 4})` : 'Convening panel…')
    : null;

  return { panel, loading, reload, running, starting, convene, cancel, progressText };
}
