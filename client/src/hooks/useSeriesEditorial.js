import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getSeriesEditorial, getSeriesEditorialStatus,
  analyzeSeriesEditorial, cancelSeriesEditorial, pipelineEditorialSseUrl,
} from '../services/api';
import toast from '../components/ui/Toast';
import { projectAnalyzedPoints } from '../lib/editorialRoadmap';
import { usePipelineProgress } from './usePipelineProgress';

const EMPTY_COVERAGE = { analyzed: 0, total: 0, withContent: 0, stale: 0, noContent: 0 };

/**
 * Owns the editorial-roadmap aggregate for a series plus the batch-analysis
 * lifecycle: initial load, re-attach to an in-flight run on (re)mount, SSE
 * progress, start/cancel, and a reload when the batch ends. Shared by the
 * EditorialRoadmapPanel (Series page) and the Reader Map detail page so the two
 * views can't drift (e.g. when to reload, how points are projected).
 *
 * Returns the aggregate + derived `coverage`/`roadmap`/`analyzedPoints`, `loadError`
 * (a failed read, kept apart from an empty aggregate) and `noDraftedContent` (the
 * Run-analysis gate: true only for a successful zero-content read), the
 * run state (`running`/`starting`/`progressText`), and `reload`/`startAnalysis`
 * /`cancelAnalysis`. Callers render however they like on top.
 */
export function useSeriesEditorial(seriesId) {
  const [aggregate, setAggregate] = useState(null);
  const [loading, setLoading] = useState(true);
  // A failed read is NOT "nothing analyzed": `loadError` is kept apart from a
  // successful-but-empty aggregate so callers never gate on EMPTY_COVERAGE.
  const [loadError, setLoadError] = useState(null);
  // The series the run flag belongs to. Deriving `analysisEnabled` from it
  // means a series switch drops the flag in the same render, so the progress
  // URL never follows the new id while the previous series' run is attached.
  const [runSeriesId, setRunSeriesId] = useState(null);
  const [starting, setStarting] = useState(false);
  const analysisEnabled = Boolean(seriesId) && runSeriesId === seriesId;
  const seriesIdRef = useRef(seriesId);

  // Keeps the aggregate already on screen when the read fails (a follow-up
  // reload must not wipe a result that was just produced).
  const reload = useCallback(() => {
    if (!seriesId) return Promise.resolve();
    return getSeriesEditorial(seriesId, { silent: true })
      .then((data) => {
        if (seriesIdRef.current !== seriesId) return;
        setAggregate(data);
        setLoadError(null);
      })
      .catch((err) => {
        if (seriesIdRef.current === seriesId) setLoadError(err ?? new Error('Request failed'));
      });
  }, [seriesId]);

  // Initial load + re-attach to a batch still running from a prior visit so its
  // completion still refreshes this view. The `canceled` guard prevents a slow
  // response for a previous seriesId from overwriting the current one's state
  // after a fast switch (inline fetch rather than `reload()` so it's guarded).
  useEffect(() => {
    seriesIdRef.current = seriesId;
    // Never show the previous series' data under the new id, or keep it as the
    // "retained" aggregate when this series' first read fails.
    setAggregate(null);
    setLoadError(null);
    if (!seriesId) { setLoading(false); return undefined; }
    let canceled = false;
    setLoading(true);
    getSeriesEditorial(seriesId, { silent: true })
      .then((data) => { if (!canceled) setAggregate(data); })
      .catch((err) => { if (!canceled) setLoadError(err ?? new Error('Request failed')); })
      .finally(() => { if (!canceled) setLoading(false); });
    getSeriesEditorialStatus(seriesId, { silent: true })
      .then((s) => { if (!canceled && s?.active) setRunSeriesId(seriesId); })
      .catch(() => {});
    return () => { canceled = true; };
  }, [seriesId]);

  // Reload when the batch ends. `closed` covers a terminal frame OR a
  // dropped/404 stream (fast batch pruned before we attached), so the UI never
  // hangs in "Analyzing…" waiting for a frame that will never arrive.
  const { latest, closed } = usePipelineProgress(pipelineEditorialSseUrl, [seriesId], { enabled: analysisEnabled });
  useEffect(() => {
    if (closed && analysisEnabled) {
      setRunSeriesId(null);
      reload();
    }
  }, [closed, analysisEnabled, reload]);

  // Force a recompute: this is an explicit user action ("Interpret reader map"
  // / "Re-run all"). On a first run nothing is cached so force is a no-op; on a
  // re-run it bypasses the unchanged-content cache short-circuit so the button
  // actually re-analyzes (e.g. after a prompt/model change or a bad result).
  const startAnalysis = useCallback(() => {
    if (!seriesId) return;
    setStarting(true);
    analyzeSeriesEditorial(seriesId, { force: true }, { silent: true })
      .then(() => setRunSeriesId(seriesId))
      .catch((err) => toast.error(err?.message || 'Failed to start analysis'))
      .finally(() => setStarting(false));
  }, [seriesId]);

  const cancelAnalysis = useCallback(() => {
    if (seriesId) cancelSeriesEditorial(seriesId).catch(() => {});
    setRunSeriesId(null);
    // Disabling the SSE means we won't see the server's `canceled` frame, so
    // pull the aggregate to surface snapshots already written for issues that
    // finished before the cancel (otherwise the roadmap shows pre-run coverage
    // until a manual reload).
    reload();
  }, [seriesId, reload]);

  const coverage = aggregate?.coverage || EMPTY_COVERAGE;
  const roadmap = aggregate?.roadmap || [];
  const analyzedPoints = projectAnalyzedPoints(roadmap);
  const running = analysisEnabled;
  // True only when a SUCCESSFUL read says there is nothing drafted (or the first
  // read is still pending). A failed first read leaves the actions enabled and
  // retryable instead of claiming the series is empty.
  const noDraftedContent = aggregate ? coverage.withContent === 0 : !loadError;
  const progressText = running && latest?.total ? `Analyzing ${latest.done || 0}/${latest.total}…` : null;

  return {
    aggregate,
    loading,
    loadError,
    noDraftedContent,
    reload,
    running,
    starting,
    startAnalysis,
    cancelAnalysis,
    coverage,
    roadmap,
    analyzedPoints,
    progressText,
  };
}
