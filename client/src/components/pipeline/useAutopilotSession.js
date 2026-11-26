import { useCallback, useEffect, useRef, useState } from 'react';
import { usePipelineProgress } from '../../hooks/usePipelineProgress';
import {
  cancelPipelineAutopilot, getPipelineAutopilotStatus, getPipelineSeries, listPipelineIssues,
  pausePipelineAutopilot, pipelineAutopilotSseUrl, startPipelineAutopilot,
} from '../../services/apiPipeline.js';
import toast from '../ui/Toast';
import { craftGapCaution, editorialCheckCaution, observerLine, selfImproveLine } from './AutopilotStatusBanner';

const RUN_ENDED = new Set(['complete', 'canceled', 'error', 'paused']);

export default function useAutopilotSession({ seriesId, onSeriesUpdate, onIssuesUpdate }) {
  const [active, setActive] = useState(false);
  const [attachVersion, setAttachVersion] = useState(0);
  const [pausePending, setPausePending] = useState(false);
  const [starting, setStarting] = useState(false);
  const [mode, setMode] = useState(null);
  const [plan, setPlan] = useState(null);
  const [planTotals, setPlanTotals] = useState(null);
  // Milestone-map state. `seedProgress` is the snapshot the status route hands a
  // panel that attaches MID-RUN (SSE replays one frame, so the live `progress`
  // frames alone would start the map at zero); `terminal` is how the tracked run
  // ended, which turns the step it stopped on from "running" into "blocked".
  const [seedProgress, setSeedProgress] = useState(null);
  const [terminal, setTerminal] = useState(null);
  // Provider/model/effort the ACTIVE run reported on its start frame — what the
  // live progress line names, so a run started elsewhere (or by the scheduler)
  // still says which provider (and how hard it thinks) it is spending on.
  const [runLlm, setRunLlm] = useState(null);

  const { latest, frames, closed } = usePipelineProgress(pipelineAutopilotSseUrl, [seriesId], { enabled: active });

  const onSeriesUpdateRef = useRef(onSeriesUpdate);
  const onIssuesUpdateRef = useRef(onIssuesUpdate);
  onSeriesUpdateRef.current = onSeriesUpdate;
  onIssuesUpdateRef.current = onIssuesUpdate;
  // The runId of the run THIS panel is currently tracking. After a run ends,
  // useSseProgress leaves the terminal frame in `latest`; without this guard a
  // fresh Run/Resume would see that stale terminal frame and immediately tear
  // the new run down. Terminal frames whose runId doesn't match are ignored.
  const activeRunIdRef = useRef(null);
  const activeRunSeriesIdRef = useRef(seriesId);
  const settledRunIdRef = useRef(null);
  const terminalVersionRef = useRef(0);
  // Live series identity for async continuations (start()'s awaits, the
  // closed-stream recovery): a callback closed over series A must not write
  // run state onto the panel after it has been pointed at series B.
  const seriesIdRef = useRef(seriesId);
  seriesIdRef.current = seriesId;

  // The panel is reused across `seriesId` changes rather than remounted, so
  // every piece of per-run state must be dropped synchronously on a switch —
  // otherwise series A's Stop/Pause controls, LLM label and milestone map
  // linger on series B and override its persisted marker. Declared BEFORE the
  // re-attach effect so that effect's status fetch re-seeds B after this reset.
  useEffect(() => {
    activeRunIdRef.current = null;
    settledRunIdRef.current = null;
    terminalVersionRef.current += 1;
    setActive(false);
    setPausePending(false);
    setStarting(false);
    setMode(null);
    setPlan(null);
    setPlanTotals(null);
    setSeedProgress(null);
    setTerminal(null);
    setRunLlm(null);
  }, [seriesId]);

  // Read a run's `start` frame — mode (the dry-run badge), the resolved run
  // provider/model, and a dry-run's plan. Shared by the SSE frame and the
  // status payload's copy of it (see the re-attach effect below).
  const applyStartFrame = useCallback((f) => {
    setMode(f.mode || null);
    setRunLlm({
      provider: f.provider || null,
      model: f.model || null,
      effort: f.effort || null,
      judge: f.judge || null,
    });
    if (Array.isArray(f.plan)) setPlan(f.plan);
    if (f.planTotals) setPlanTotals(f.planTotals);
  }, []);

  // Re-attach to an in-flight run on (re)mount.
  useEffect(() => {
    if (!seriesId) return undefined;
    let canceled = false;
    const terminalVersion = terminalVersionRef.current;
    getPipelineAutopilotStatus(seriesId, { silent: true })
      .then((s) => {
        if (canceled || terminalVersion !== terminalVersionRef.current || !s?.active) return;
        // The live start frame owns identity; the persisted marker can still
        // describe a previous run, and dry-runs never persist one.
        const knownRunId = activeRunSeriesIdRef.current === seriesId ? activeRunIdRef.current : null;
        const runId = s.start?.runId || knownRunId || null;
        if (settledRunIdRef.current && runId === settledRunIdRef.current) return;
        activeRunIdRef.current = runId;
        activeRunSeriesIdRef.current = seriesId;
        // SSE replays only the last frame, so the run's `start` frame comes back
        // on the status payload instead — same shape, same reader.
        if (s.start) applyStartFrame(s.start);
        // …and its position in that plan, so the map opens where the run
        // actually is instead of claiming nothing has happened yet.
        if (s.progress) setSeedProgress(s.progress);
        setTerminal(null);
        setPausePending(s.pauseRequested === true);
        setActive(true);
      })
      .catch(() => null);
    return () => { canceled = true; };
  }, [seriesId, attachVersion, applyStartFrame]);

  // Capture dry-run plan + mode. The plan rides the start frame, but a fast
  // dry-run can complete before the client attaches and only the terminal frame
  // is replayed — so also read the plan off a dry-run complete frame.
  useEffect(() => {
    if (latest?.type === 'start') {
      applyStartFrame(latest);
    } else if (latest?.type === 'complete' && latest.dryRun && Array.isArray(latest.plan)) {
      // A fast dry-run can finish before the client attaches, so this terminal
      // frame is the only place the plan (and the fact that it WAS a dry-run,
      // which is what makes the map a plan rather than a progress meter) lands.
      setMode('dry-run');
      setPlan(latest.plan);
      if (latest.planTotals) setPlanTotals(latest.planTotals);
    }
  }, [latest, applyStartFrame]);

  // A completed refresh must still belong to the displayed series when it
  // lands. The issue callback replaces the visible issue list.
  const refreshSeries = useCallback(() => {
    getPipelineSeries(seriesId, { silent: true }).then((series) => {
      if (series && seriesIdRef.current === seriesId) onSeriesUpdateRef.current?.(series);
    }).catch(() => null);
    listPipelineIssues(seriesId, { silent: true }).then((issues) => {
      if (seriesIdRef.current === seriesId) onIssuesUpdateRef.current?.(Array.isArray(issues) ? issues : []);
    }).catch(() => null);
  }, [seriesId]);

  // Run-ended handling: refresh series (for the marker) + issues, toast outcome.
  useEffect(() => {
    if (!active || !latest || !RUN_ENDED.has(latest.type) || activeRunSeriesIdRef.current !== seriesId) return;
    // Ignore a terminal frame left over from a previous run (stale `latest`).
    if (activeRunIdRef.current && latest.runId && latest.runId !== activeRunIdRef.current) return;
    settledRunIdRef.current = latest.runId || activeRunIdRef.current;
    terminalVersionRef.current += 1;
    setActive(false);
    setPausePending(false);
    // Freeze the map on how this run ended: a paused/errored run keeps its
    // milestones on screen with the step it stopped on flagged, rather than the
    // list vanishing the moment the stream closes.
    setTerminal(latest.type);
    refreshSeries();
    if (latest.type === 'complete') {
      if (latest.dryRun) toast.success('Autopilot plan ready');
      else if (latest.craftGapIssues > 0) toast.warning(`Autopilot complete with ${craftGapCaution(latest.craftGapIssues)}`);
      else if (latest.editorialCheckErrors > 0) toast.warning(`Autopilot complete — ${editorialCheckCaution(latest.editorialCheckErrors)}`);
      else toast.success('Autopilot complete — selected production pass finished');
    }
    else if (latest.type === 'canceled') toast.success('Autopilot canceled');
    else if (latest.type === 'paused') toast.warning(`Autopilot paused — ${latest.reason || 'needs review'}`);
    else toast.error(latest.error || 'Autopilot failed');
    // The self-improvement verdict rides the terminal frame; announce a filed
    // PortOS fix separately so it isn't buried in the run's own outcome toast.
    const siLine = selfImproveLine(latest.selfImprove);
    if (siLine) toast(siLine);
    // Same for the observing orchestrator's run summary.
    const obLine = observerLine(latest.observer);
    if (obLine) toast(obLine);
  }, [active, latest, seriesId, refreshSeries]);

  // A stream that closes WITHOUT a terminal frame (404 on an evicted run, server
  // restart, dropped replay window) would otherwise leave `active` true forever:
  // the run-ended effect above only fires on a terminal frame. Reconcile with
  // the status route instead and release the card if no run remains.
  useEffect(() => {
    if (!active || !closed || (latest && RUN_ENDED.has(latest.type))) return undefined;
    let canceled = false;
    getPipelineAutopilotStatus(seriesId, { silent: true })
      .then((s) => {
        if (canceled || seriesIdRef.current !== seriesId || s?.active) return;
        setActive(false);
        setPausePending(false);
        refreshSeries();
      })
      .catch(() => null);
    return () => { canceled = true; };
  }, [active, closed, latest, seriesId, refreshSeries]);

  const start = useCallback(async (prepareRun, onStarted) => {
    const forSeriesId = seriesId;
    setStarting(true);
    setPlan(null);
    setPlanTotals(null);
    // The previous run's map must not bleed into this one — the fresh run
    // rebuilds both halves (plan on its start frame, progress from its frames).
    setSeedProgress(null);
    setTerminal(null);
    const payload = await prepareRun();
    // The user navigated away while the settings saved: don't launch a run on
    // a series they are no longer looking at.
    if (seriesIdRef.current !== forSeriesId) return;
    const res = await startPipelineAutopilot(seriesId, payload, { silent: true })
      .catch((err) => { toast.error(err.message || 'Could not start autopilot'); return null; });
    // The panel now shows another series — the run (if it started) is picked up
    // from the status route when the user returns to it.
    if (seriesIdRef.current !== forSeriesId) return;
    setStarting(false);
    if (!res) return;
    setMode(res.mode || null);
    onStarted();
    // Track this run's id BEFORE enabling the stream so the terminal-frame
    // effect can reject a stale terminal frame from the previous run.
    activeRunIdRef.current = res.runId || null;
    activeRunSeriesIdRef.current = seriesId;
    setAttachVersion((version) => version + 1);
    setActive(true);
  }, [seriesId]);

  const cancel = useCallback(async () => {
    setPausePending(false);
    await cancelPipelineAutopilot(seriesId).catch(() => null);
  }, [seriesId]);

  const pause = useCallback(async () => {
    const result = await pausePipelineAutopilot(seriesId).catch(() => null);
    if (seriesIdRef.current === seriesId) setPausePending(result?.pauseRequested === true);
  }, [seriesId]);

  // Acknowledge controls immediately while the active step settles.
  const canceling = active && latest?.type === 'cancel:acknowledged';
  const pausing = active && (pausePending || latest?.type === 'pause:acknowledged');

  return {
    active, starting, canceling, pausing, start, cancel, pause,
    feed: { latest, frames, mode, plan, planTotals, seedProgress, terminal, runLlm },
  };
}
