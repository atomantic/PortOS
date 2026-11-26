import { useState } from 'react';
import { Rocket, Loader2, X, Sliders, PauseCircle, Play } from 'lucide-react';
import AutopilotFrameFeed from './AutopilotFrameFeed';
import AutopilotOptionsPanel from './AutopilotOptionsPanel';
import AutopilotStageQualitySections from './AutopilotStageQualitySections';
import AutopilotStatusBanner from './AutopilotStatusBanner';
import CanonReadinessPanel from './CanonReadinessPanel';
import SeriesAutopilotSchedule from './SeriesAutopilotSchedule';
import useAutopilotRunOptions from './useAutopilotRunOptions';
import useAutopilotSession from './useAutopilotSession';
import useAutopilotStageRoutes from './useAutopilotStageRoutes';

export default function AutopilotPanel({ series, onSeriesUpdate, onIssuesUpdate }) {
  const seriesId = series?.id;
  const [showOpts, setShowOpts] = useState(false);
  const { active, starting, canceling, pausing, start, cancel, pause, feed } =
    useAutopilotSession({ seriesId, onSeriesUpdate, onIssuesUpdate });
  const {
    providers, activeProviderId, productionScope, setProductionScope, collectRouteOverrides, runRouteFields, stageRouteFields,
  } = useAutopilotStageRoutes(series);
  const { prepareRunOptions, clearUnlockForRun, runOptionFields, qualityFields } = useAutopilotRunOptions(series);

  const startRun = () => {
    const routes = collectRouteOverrides();
    return start(async () => ({ ...(await prepareRunOptions(productionScope)), ...routes }), () => {
      setShowOpts(false);
      // Unlock consent applies to the run that just started.
      clearUnlockForRun();
    });
  };

  if (!seriesId) return null;

  const ap = series.autopilot;
  const runLabel = ap?.status === 'paused' ? 'Resume autopilot'
    : ap?.status === 'done' ? 'Run autopilot again'
      : 'Run autopilot';

  return (
    <div className="border border-port-border rounded-lg bg-port-card/40">
      <div className="flex items-center gap-2 flex-wrap p-3">
        <Rocket size={15} className="text-port-accent" />
        <span className="text-sm font-medium text-white">Autonomous mode</span>
        <span className="text-xs text-gray-500">reviews the story before producing the selected issues</span>

        <div className="ml-auto flex items-center gap-2">
          {!active ? (
            <>
              <button
                type="button"
                onClick={() => setShowOpts((v) => !v)}
                className="inline-flex items-center gap-1 px-2 py-1.5 rounded text-xs text-gray-300 hover:text-white border border-port-border bg-port-bg hover:border-port-accent/40"
                title="Run options"
                aria-expanded={showOpts}
              >
                <Sliders size={12} /> Options
              </button>
              <button
                type="button"
                onClick={startRun}
                disabled={starting}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium border bg-port-bg text-port-accent border-port-border hover:border-port-accent/40 disabled:opacity-40"
              >
                {starting ? <Loader2 size={14} className="animate-spin" /> : (ap?.status === 'paused' ? <Play size={14} /> : <Rocket size={14} />)}
                {runLabel}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={pause}
                disabled={pausing || canceling}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded text-xs text-port-accent hover:text-white border border-port-accent/40 bg-port-bg hover:bg-port-accent/10 disabled:opacity-50 disabled:cursor-default"
                title="Finish the active step, then pause without stopping its AI run"
              >
                {pausing ? <Loader2 size={12} className="animate-spin" /> : <PauseCircle size={12} />} {pausing ? 'Pausing…' : 'Pause safely'}
              </button>
              <button
                type="button"
                onClick={cancel}
                disabled={canceling}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded text-xs text-port-warning hover:text-white border border-port-warning/40 bg-port-bg hover:bg-port-warning/10 disabled:opacity-50 disabled:hover:text-port-warning disabled:cursor-default"
                title="Stop the active AI run immediately"
              >
                {canceling ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />} {canceling ? 'Cancelling…' : 'Stop now'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Options popover */}
      {!active ? (
        <div className="px-3 pb-3 flex flex-wrap items-center gap-2">
          <label htmlFor="autopilot-production-scope" className="text-xs text-gray-400">Produce</label>
          <select
            id="autopilot-production-scope"
            value={productionScope}
            onChange={(event) => setProductionScope(event.target.value)}
            disabled={starting}
            className="max-w-full rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm text-white"
          >
            <option value="series">All planned issues</option>
            <option value="first-issue">First issue only</option>
          </select>
          <span className="text-xs text-gray-500">
            {productionScope === 'first-issue'
              ? 'Draft and draw the opening. Editorial repairs can still update the whole plan and any existing drafts.'
              : 'The opening receives developmental review before later issues are drafted.'}
          </span>
        </div>
      ) : null}
      {showOpts && !active ? (
        <AutopilotOptionsPanel
          providers={providers} activeProviderId={activeProviderId}
          {...runRouteFields} {...runOptionFields}
        />
      ) : null}

      {!active && <AutopilotStageQualitySections stageRouting={stageRouteFields} {...qualityFields} />}

      <AutopilotFrameFeed ap={ap} active={active} providers={providers} activeProviderId={activeProviderId} {...feed} />

      {!active ? <AutopilotStatusBanner ap={ap} /> : null}

      {/* Scheduled unattended runs (#2174) — hidden while a run is active. */}
      {!active ? (
        <SeriesAutopilotSchedule series={series} providers={providers} activeProviderId={activeProviderId} />
      ) : null}

      {/* Production readiness (canon descriptive integrity) */}
      <CanonReadinessPanel seriesId={seriesId} />
    </div>
  );
}
