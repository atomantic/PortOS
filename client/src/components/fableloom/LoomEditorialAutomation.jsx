import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  AlertTriangle, BrainCircuit, CheckCircle2, Loader2, Sparkles, Square, Waypoints,
} from 'lucide-react';
import ProviderModelSelector from '../ProviderModelSelector';
import toast from '../ui/Toast';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import useFableLoomAiRun from '../../hooks/useFableLoomAiRun';
import useProviderModels from '../../hooks/useProviderModels';
import {
  cancelLoomEditorialAutopilot,
  getLoom,
  getLoomEditorialAutopilotRun,
  getLoomEditorialAutopilotStatus,
  remediateLoomEditorial,
  reviewLoomPlaythroughs,
  startLoomEditorialAutopilot,
} from '../../services/api';
import { effectiveModelFor, effortAwareModelOptions } from '../../utils/providers';
import LoomAiRunStatus from './LoomAiRunStatus';

const ACTIVE_STATUSES = new Set(['running', 'canceling']);
const TERMINAL_STATUSES = new Set(['completed', 'paused', 'failed', 'canceled']);

const routePayload = (route) => ({
  ...(route.providerId ? { providerId: route.providerId } : {}),
  ...(route.model ? { model: route.model } : {}),
  ...(route.effort ? { effort: route.effort } : {}),
});

const statusClass = (status) => {
  if (status === 'completed') return 'border-port-success/40 bg-port-success/5 text-port-success';
  if (status === 'failed') return 'border-port-error/40 bg-port-error/5 text-port-error';
  if (status === 'paused' || status === 'canceled') return 'border-port-warning/40 bg-port-warning/5 text-port-warning';
  return 'border-port-accent/30 bg-port-accent/5 text-port-accent';
};

function Metric({ label, value, tone = 'default' }) {
  const valueClass = tone === 'good'
    ? 'text-port-success'
    : tone === 'bad' ? 'text-port-error' : 'text-port-text';
  return (
    <div className="rounded border border-port-border bg-port-bg/40 px-3 py-2">
      <p className="text-[11px] text-port-text-muted">{label}</p>
      <p className={`mt-0.5 text-sm font-semibold ${valueClass}`}>{value}</p>
    </div>
  );
}

function FindingLink({ loom, finding }) {
  const episode = loom.episodes.find((candidate) => candidate.id === finding.episodeId);
  const scene = episode?.nodes?.find((candidate) => candidate.id === finding.nodeId);
  const target = episode
    ? `/fableloom/${encodeURIComponent(loom.id)}/${encodeURIComponent(episode.id)}${scene ? `/${encodeURIComponent(scene.id)}` : ''}`
    : null;
  const severity = finding.severity === 'error' ? 'high' : finding.severity;
  const Icon = severity === 'high' ? AlertTriangle : Waypoints;
  return (
    <li className="rounded border border-port-border px-3 py-2 text-xs">
      <div className="flex items-start gap-2">
        <Icon
          size={13}
          className={`mt-0.5 shrink-0 ${severity === 'high' ? 'text-port-error' : 'text-port-warning'}`}
        />
        <div className="min-w-0 flex-1">
          <p>{finding.problem || finding.message}</p>
          {finding.suggestion ? <p className="mt-1 text-port-text-muted">{finding.suggestion}</p> : null}
          {target ? (
            <Link to={target} className="mt-1 inline-block text-port-accent hover:underline">
              Episode {episode.number || loom.episodes.indexOf(episode) + 1}{scene ? ` · ${scene.title || 'Scene'}` : ''}
            </Link>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/** Whole-series one-pass editor, bounded editor/reviewer autopilot, and playthrough QA. */
export default function LoomEditorialAutomation({ loom, dirty, onLoomUpdate }) {
  const [route, setRoute] = useState({ providerId: '', model: '', effort: '' });
  const [maxRounds, setMaxRounds] = useState(3);
  const [result, setResult] = useState(null);
  const [autopilotRun, setAutopilotRun] = useState(null);
  const handledTerminalRunRef = useRef(null);
  const remediationAi = useFableLoomAiRun();
  const playtestAi = useFableLoomAiRun();
  const { providers, activeProviderId, loading: providersLoading } = useProviderModels({
    allowDefault: true,
    silent: true,
    withEffort: true,
  });
  const effectiveProviderId = route.providerId || activeProviderId;
  const selectedProvider = providers.find((provider) => provider.id === effectiveProviderId);
  const selectedModel = effectiveModelFor(selectedProvider, route.model);
  const routeBody = useMemo(() => routePayload(route), [route]);

  useEffect(() => {
    setResult(null);
    setAutopilotRun(null);
    handledTerminalRunRef.current = null;
    let ignore = false;
    getLoomEditorialAutopilotStatus(loom.id, { silent: true })
      .then(({ run }) => { if (!ignore && run) setAutopilotRun(run); })
      .catch(() => {});
    return () => { ignore = true; };
  }, [loom.id]);

  const autopilotActive = ACTIVE_STATUSES.has(autopilotRun?.status);
  useEffect(() => {
    if (!autopilotActive || !autopilotRun?.id) return undefined;
    let ignore = false;
    const refresh = () => getLoomEditorialAutopilotRun(loom.id, autopilotRun.id, { silent: true })
      .then((run) => { if (!ignore) setAutopilotRun(run); })
      .catch(() => {});
    const interval = setInterval(refresh, 2000);
    return () => {
      ignore = true;
      clearInterval(interval);
    };
  }, [autopilotActive, autopilotRun?.id, loom.id]);

  useEffect(() => {
    if (!TERMINAL_STATUSES.has(autopilotRun?.status)
      || handledTerminalRunRef.current === autopilotRun.id) return;
    handledTerminalRunRef.current = autopilotRun.id;
    setResult({ type: 'autopilot', run: autopilotRun });
    getLoom(loom.id, { silent: true }).then(onLoomUpdate).catch(() => {});
  }, [autopilotRun, loom.id, onLoomUpdate]);

  const [remediate, remediating] = useAsyncAction(async () => {
    const operationId = remediationAi.begin();
    const response = await remediateLoomEditorial(loom.id, {
      ...routeBody,
      operationId,
    }, { silent: true }).catch((error) => {
      remediationAi.fail(error.message);
      throw error;
    });
    setResult({ type: 'remediation', response });
    onLoomUpdate(response.loom);
    toast.success(response.changed
      ? `Series remediated — ${response.changes.length || 1} safe edit${response.changes.length === 1 ? '' : 's'} applied`
      : 'Series evaluated — no safe edit was needed');
  }, { errorMessage: 'Series editorial remediation failed' });

  const [runPlaytest, playtesting] = useAsyncAction(async () => {
    const operationId = playtestAi.begin();
    const response = await reviewLoomPlaythroughs(loom.id, {
      ...routeBody,
      aiReview: true,
      operationId,
    }, { silent: true }).catch((error) => {
      playtestAi.fail(error.message);
      throw error;
    });
    setResult({ type: 'playtest', response });
    toast.success(response.passed
      ? 'Every enumerated playthrough passed structural and narrative review'
      : 'Playthrough review found issues to resolve');
  }, { errorMessage: 'Playthrough test failed' });

  const [startAutopilot, startingAutopilot] = useAsyncAction(async () => {
    const run = await startLoomEditorialAutopilot(loom.id, {
      ...routeBody,
      maxRounds,
    }, { silent: true });
    handledTerminalRunRef.current = null;
    setAutopilotRun(run);
    setResult(null);
    toast.success(run.alreadyRunning ? 'Reattached to the active editorial autopilot' : 'Editorial autopilot started');
  }, { errorMessage: 'Could not start editorial autopilot' });

  const [cancelAutopilot, cancelingAutopilot] = useAsyncAction(async () => {
    const run = await cancelLoomEditorialAutopilot(loom.id, autopilotRun.id, { silent: true });
    setAutopilotRun(run);
  }, { errorMessage: 'Could not cancel editorial autopilot' });

  const busy = remediating || playtesting || startingAutopilot || cancelingAutopilot || autopilotActive;
  const blocked = dirty || !loom.episodes.length;
  const response = result?.response;
  const shownRun = result?.type === 'autopilot' ? result.run : result ? null : autopilotRun;
  const diagnostics = result?.type === 'remediation' ? response?.diagnostics : null;
  const deterministic = result?.type === 'playtest'
    ? response?.deterministic
    : diagnostics?.playthrough || shownRun?.lastPlaytest;
  const stats = deterministic?.stats;
  const remediationStats = result?.type === 'remediation'
    ? response?.after
    : shownRun?.rounds?.at(-1)?.after;
  const review = result?.type === 'playtest' ? response?.review : shownRun?.lastReview;
  const evaluation = result?.type === 'remediation' ? response?.evaluation : shownRun?.lastEvaluation;
  const findings = result?.type === 'autopilot' || shownRun?.status
    ? shownRun?.residualFindings || []
    : review?.findings?.length ? review.findings : evaluation?.findings || [];
  const summary = review?.summary || evaluation?.summary || shownRun?.message;
  const passed = result?.type === 'playtest'
    ? response?.passed
    : shownRun?.status === 'completed' || diagnostics?.passed;

  return (
    <section
      className="rounded-lg border border-port-accent/40 bg-port-card p-4 space-y-4"
      aria-label="AI editorial automation"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="font-semibold flex items-center gap-2">
            <BrainCircuit size={16} className="text-port-accent" /> AI editor, reviewer & playtest
          </h3>
          <p className="mt-1 text-xs text-port-text-muted max-w-3xl">
            One editor can evaluate and safely repair the complete series. Autopilot alternates that editor with an independent review of every enumerated gameplay path until the story passes or reaches its bounded round limit.
          </p>
        </div>
        {shownRun ? (
          <span className={`shrink-0 rounded border px-2 py-1 text-xs ${statusClass(shownRun.status)}`}>
            {shownRun.status} · round {shownRun.round}/{shownRun.maxRounds}
          </span>
        ) : null}
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_9rem]">
        <ProviderModelSelector
          providers={providers}
          selectedProviderId={route.providerId}
          effectiveProviderId={effectiveProviderId}
          selectedModel={route.model}
          availableModels={effortAwareModelOptions(selectedProvider, route.model)}
          onProviderChange={(providerId) => setRoute({ providerId, model: '', effort: '' })}
          onModelChange={(model) => setRoute((current) => ({ ...current, model }))}
          effort={route.effort}
          onEffortChange={(effort) => setRoute((current) => ({ ...current, effort }))}
          label="Editorial AI route"
          disabled={busy || providersLoading}
          modelDisabled={busy || providersLoading}
          emptyProviderOption="Default (editorial stage or active provider)"
          emptyModelOption="Default model"
          alwaysShowModel={!!route.providerId}
        />
        <div>
          <label htmlFor="fableloom-editorial-rounds" className="block text-xs text-gray-500 mb-1">
            Autopilot rounds
          </label>
          <select
            id="fableloom-editorial-rounds"
            value={maxRounds}
            onChange={(event) => setMaxRounds(Number(event.target.value))}
            disabled={busy}
            className="w-full px-3 py-1.5 min-h-[36px] bg-port-bg border border-port-border rounded-lg text-white text-sm"
          >
            {[1, 2, 3, 4, 5, 6].map((rounds) => (
              <option key={rounds} value={rounds}>{rounds}</option>
            ))}
          </select>
        </div>
      </div>
      {selectedProvider ? (
        <p className="text-xs text-port-text-muted">
          Runs will use {selectedProvider.name}{selectedModel ? ` (${selectedModel})` : ''}
          {route.effort ? ` at ${route.effort} effort` : ' at the provider default effort'}.
        </p>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-3">
        <button
          type="button"
          onClick={remediate}
          disabled={blocked || busy}
          className="flex min-h-11 items-center justify-center gap-2 rounded bg-port-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {remediating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {remediating ? 'Remediating…' : 'Evaluate & remediate series'}
        </button>
        <button
          type="button"
          onClick={runPlaytest}
          disabled={blocked || busy}
          className="flex min-h-11 items-center justify-center gap-2 rounded border border-port-accent px-3 py-2 text-sm text-port-accent hover:bg-port-accent/10 disabled:opacity-50"
        >
          {playtesting ? <Loader2 size={14} className="animate-spin" /> : <Waypoints size={14} />}
          {playtesting ? 'Testing paths…' : 'Run playthrough test'}
        </button>
        {autopilotActive ? (
          <button
            type="button"
            onClick={cancelAutopilot}
            disabled={cancelingAutopilot || autopilotRun.status === 'canceling'}
            className="flex min-h-11 items-center justify-center gap-2 rounded border border-port-warning px-3 py-2 text-sm text-port-warning disabled:opacity-50"
          >
            {cancelingAutopilot ? <Loader2 size={14} className="animate-spin" /> : <Square size={13} />}
            {autopilotRun.status === 'canceling' ? 'Canceling after this step…' : 'Stop editor autopilot'}
          </button>
        ) : (
          <button
            type="button"
            onClick={startAutopilot}
            disabled={blocked || busy}
            className="flex min-h-11 items-center justify-center gap-2 rounded border border-port-accent px-3 py-2 text-sm text-port-accent hover:bg-port-accent/10 disabled:opacity-50"
          >
            {startingAutopilot ? <Loader2 size={14} className="animate-spin" /> : <BrainCircuit size={14} />}
            {startingAutopilot ? 'Starting…' : 'Start editor autopilot'}
          </button>
        )}
      </div>

      {dirty ? (
        <p className="text-xs text-port-warning" role="status">Save the current series-plan edits before running editorial automation.</p>
      ) : !loom.episodes.length ? (
        <p className="text-xs text-port-warning" role="status">Add at least one episode before running editorial automation.</p>
      ) : null}
      {autopilotActive ? (
        <div className="flex items-center gap-2 rounded border border-port-accent/30 bg-port-accent/5 px-3 py-2 text-xs text-port-text-muted" role="status">
          <Loader2 size={14} className="animate-spin text-port-accent" />
          <span>{autopilotRun.message}</span>
        </div>
      ) : null}
      <LoomAiRunStatus run={remediationAi.run} />
      <LoomAiRunStatus run={playtestAi.run} />

      {(stats || remediationStats || review || evaluation || shownRun) ? (
        <div className="space-y-3 border-t border-port-border pt-4" aria-label="Editorial automation results">
          <div className="flex items-start gap-2">
            {passed ? (
              <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-port-success" />
            ) : (
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-port-warning" />
            )}
            <div>
              <p className="text-sm font-medium">
                {passed ? 'Series clears the current editorial gates' : 'Editorial work remains'}
              </p>
              {summary ? <p className="mt-1 text-xs text-port-text-muted">{summary}</p> : null}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
            {remediationStats ? (
              <>
                <Metric label="Outline blockers" value={remediationStats.outlineErrors} tone={remediationStats.outlineErrors ? 'bad' : 'good'} />
                <Metric label="Graph blockers" value={remediationStats.graphErrors} tone={remediationStats.graphErrors ? 'bad' : 'good'} />
                <Metric label="Convergence gaps" value={remediationStats.convergenceIssues} tone={remediationStats.convergenceIssues ? 'bad' : 'good'} />
              </>
            ) : null}
            {stats ? (
              <>
                <Metric label="Variations tested" value={stats.variationCount} />
                <Metric
                  label="Path coverage"
                  value={`${stats.visitedTransitionCount}/${stats.transitionCount}`}
                  tone={stats.visitedTransitionCount === stats.transitionCount ? 'good' : 'bad'}
                />
              </>
            ) : null}
            {review?.qualityScore != null ? (
              <Metric label="Story quality" value={`${review.qualityScore}/10`} tone={review.qualityScore >= 8 ? 'good' : 'bad'} />
            ) : null}
          </div>
          {evaluation?.strengths?.length || review?.strengths?.length ? (
            <p className="text-xs text-port-text-muted">
              <span className="font-medium text-port-text">Strengths:</span>{' '}
              {(review?.strengths?.length ? review.strengths : evaluation.strengths).join(' · ')}
            </p>
          ) : null}
          {findings.length ? (
            <ul className="space-y-2">
              {findings.slice(0, 12).map((finding, index) => (
                <FindingLink
                  key={`${finding.episodeId || 'series'}-${finding.nodeId || finding.pathId || index}-${index}`}
                  loom={loom}
                  finding={finding}
                />
              ))}
            </ul>
          ) : null}
          {shownRun?.rounds?.length ? (
            <p className="text-[11px] text-port-text-muted">
              {shownRun.rounds.length} bounded editorial round{shownRun.rounds.length === 1 ? '' : 's'} recorded. The run stops on success, plateau, cancellation, provider failure, or the selected round limit.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
