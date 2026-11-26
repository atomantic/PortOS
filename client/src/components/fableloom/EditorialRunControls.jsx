import { BrainCircuit, Loader2, Sparkles, Square, Waypoints } from 'lucide-react';
import ProviderModelSelector from '../ProviderModelSelector';
import { effortAwareModelOptions } from '../../utils/providers';
import LoomAiRunStatus from './LoomAiRunStatus';

export default function EditorialRunControls({
  hasEpisodes, dirty, settings, actions, autopilotRun, autopilotActive, shownRun,
}) {
  const {
    mode, setMode, route, setRoute, providers, providersLoading, effectiveProviderId,
    selectedProvider, selectedModel, maxRounds, setMaxRounds, selfImprove, setSelfImprove,
  } = settings;
  const {
    remediate, remediating, runPlaytest, playtesting, cancelAutopilot, cancelingAutopilot,
    startAutopilot, startingAutopilot, remediationRun, playtestRun,
  } = actions;
  const busy = remediating || playtesting || startingAutopilot || cancelingAutopilot || autopilotActive;
  const blocked = dirty || !hasEpisodes;
  const restartLabel = ['failed', 'paused', 'canceled'].includes(shownRun?.status)
    ? 'Retry editor autopilot'
    : 'Start editor autopilot';
  return (
    <>
      <div>
        <label htmlFor="fableloom-autopilot-mode" className="block text-xs text-port-text-muted mb-1">Autopilot stage</label>
        <select id="fableloom-autopilot-mode" value={mode} onChange={(event) => setMode(event.target.value)} disabled={busy} className="w-full min-h-11 rounded border border-port-border bg-port-bg px-3 text-sm">
          <option value="planning">Plan the series before writing scenes</option>
          <option value="series">Edit and playtest the complete teleplay</option>
        </select>
        <p className="mt-1 text-xs text-port-text-muted">Planning reviews the arc first, then drafts and reviews each episode outline in order. It stops before scene expansion or media generation.</p>
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
          loading={providersLoading}
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

      <div className="rounded border border-port-border bg-port-bg/30 px-3 py-2">
        <label htmlFor="fableloom-editorial-self-improve" className="flex items-start gap-2 text-xs text-port-text">
          <input
            id="fableloom-editorial-self-improve"
            type="checkbox"
            checked={selfImprove}
            onChange={(event) => setSelfImprove(event.target.checked)}
            disabled={busy}
            className="mt-0.5"
          />
          <span>
            <span className="font-medium">Improve FableLoom itself when autopilot stalls or fails</span>
            <span className="mt-1 block text-[11px] text-port-text-muted">
              Runs one content-free, budget-gated post-mortem to distinguish story work from a broken or inefficient editor/reviewer workflow. A confident PortOS defect queues a deduplicated worktree + PR CoS task in the approval queue; it never starts by itself. Healthy and canceled runs spend nothing.
            </span>
          </span>
        </label>
      </div>

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
            {startingAutopilot ? 'Starting…' : restartLabel}
          </button>
        )}
      </div>

      {dirty ? (
        <p className="text-xs text-port-warning" role="status">Save the current series-plan edits before running editorial automation.</p>
      ) : !hasEpisodes ? (
        <p className="text-xs text-port-warning" role="status">Add at least one episode before running editorial automation.</p>
      ) : null}
      {autopilotActive ? (
        <div className="flex items-center gap-2 rounded border border-port-accent/30 bg-port-accent/5 px-3 py-2 text-xs text-port-text-muted" role="status">
          <Loader2 size={14} className="animate-spin text-port-accent" />
          <span>{autopilotRun.message}</span>
        </div>
      ) : null}
      <LoomAiRunStatus run={remediationRun} />
      <LoomAiRunStatus run={playtestRun} />
    </>
  );
}
