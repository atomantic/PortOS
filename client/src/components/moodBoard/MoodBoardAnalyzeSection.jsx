import { PROVIDERS_PAGE_BREADCRUMB } from '../../../../server/lib/navManifest.js';
import { useState } from 'react';
import { ScanEye, ChevronDown, Cpu } from 'lucide-react';
import ProviderModelSelector from '../ProviderModelSelector';
import ListLoadError from '../ui/ListLoadError';
import { formatCount } from '../../utils/formatters';

function AnalysisProvider({
  providers,
  selectedProviderId,
  selectedModel,
  availableModels,
  setSelectedProviderId,
  setSelectedModel,
  effort,
  setEffort,
  busy,
  providersLoading,
  providersError,
  retryProviders,
}) {
  const [aiOpen, setAiOpen] = useState(false);
  const providerName = providers.find((p) => p.id === selectedProviderId)?.name || selectedProviderId;
  const aiSummary = [providerName || 'Choose a provider', selectedModel, effort ? `${effort} effort` : null].filter(Boolean).join(' · ');
  return (
    <>
      {/* Provider, model and effort fold into one summary line until changed. */}
      <div>
        <button
          type="button"
          onClick={() => setAiOpen((v) => !v)}
          aria-expanded={aiOpen}
          aria-label={`Analysis AI: ${aiSummary}`}
          className="flex w-full min-h-[40px] items-center gap-2 px-2.5 rounded border border-port-border bg-port-bg text-left text-xs text-gray-300 hover:text-white"
        >
          <Cpu className="w-3.5 h-3.5 shrink-0 text-gray-400" aria-hidden="true" />
          <span className="flex-1 min-w-0 truncate">{aiSummary}</span>
          <ChevronDown className={`w-3.5 h-3.5 shrink-0 transition-transform ${aiOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
        {aiOpen ? (
          <div className="mt-2">
            <ProviderModelSelector
              providers={providers}
              selectedProviderId={selectedProviderId}
              selectedModel={selectedModel}
              availableModels={availableModels}
              onProviderChange={setSelectedProviderId}
              onModelChange={setSelectedModel}
              effort={effort}
              onEffortChange={setEffort}
              disabled={busy || providersLoading}
            />
          </div>
        ) : null}
      </div>
      {providersError && providers.length === 0 && !providersLoading ? (
        <ListLoadError what="AI providers" error={providersError} onRetry={retryProviders} />
      ) : providers.length === 0 && !providersLoading ? (
        <p className="text-xs text-port-warning">No vision-capable provider is enabled. Add one under {PROVIDERS_PAGE_BREADCRUMB} to analyze items. Composing from analyses you already have still works.</p>
      ) : null}
    </>
  );
}

function AnalysisProgress({ analyzable, plan, jobRunning, jobProgress, progressPct }) {
  return (
    <>
      {analyzable > 0 ? (
        <div className="space-y-1.5">
          <p className="text-xs text-gray-400">
            {jobRunning ? jobProgress : `${formatCount(plan.analyzed)} of ${formatCount(analyzable)} pins analyzed`}
          </p>
          <div
            role="progressbar"
            aria-label="Pins analyzed"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progressPct}
            className="h-1.5 rounded-full bg-port-bg overflow-hidden"
          >
            <div className="h-full bg-port-accent transition-[width]" style={{ width: `${progressPct}%` }} />
          </div>
        </div>
      ) : null}
    </>
  );
}

export default function MoodBoardAnalyzeSection({
  plan,
  job,
  jobRunning,
  busy,
  composing,
  showMakeComplete,
  jobId,
  styleDirty,
  canCompleteRender,
  analyzeBoard,
  composeOnly,
  providers,
  selectedProviderId,
  selectedModel,
  availableModels,
  setSelectedProviderId,
  setSelectedModel,
  effort,
  setEffort,
  providersLoading,
  providersError,
  retryProviders,
}) {
  const jobProgress = jobRunning
    ? (job.phase === 'rendering' ? 'Creating main board image…' : job.phase === 'composing'
      ? 'Composing board style…'
      : job.total > 0
        ? `Analyzing ${formatCount(Math.min(job.done + 1, job.total))} of ${formatCount(job.total)}`
        : 'Preparing…')
    : '';
  const showAnalyze = plan.pending.length > 0;
  const showCompose = plan.analyzed > 0;
  const analyzable = plan.analyzed + plan.pending.length;
  const progressPct = jobRunning && job.total > 0
    ? Math.round((Math.min(job.done, job.total) / job.total) * 100)
    : analyzable > 0 ? Math.round((plan.analyzed / analyzable) * 100) : 0;
  return (
    <>
      <AnalysisProgress
        analyzable={analyzable}
        plan={plan}
        jobRunning={jobRunning}
        jobProgress={jobProgress}
        progressPct={progressPct}
      />
      {showMakeComplete ? <div className="space-y-1">
        <button type="button" onClick={() => analyzeBoard(true)}
          disabled={busy || Boolean(jobId) || styleDirty || !selectedProviderId || !canCompleteRender || !analyzable}
          className="min-h-[40px] px-3 py-1.5 text-sm rounded bg-port-success text-white hover:bg-port-success/80 disabled:opacity-50">
          {jobRunning && job.makeComplete ? jobProgress : 'Make complete'}
        </button>
        <p className="text-xs text-gray-400">Analyze missing pins, compose positive and negative style prompts, then create the main board image with the selected poster renderer. Saved analyses are reused; the current image stays until its replacement is ready.</p>
        {!canCompleteRender ? <p className="text-xs text-port-warning">Choose a queueable backend in Poster renderer below to use Make complete. External API rendering remains available through Generate poster.</p> : null}
        {styleDirty ? <p className="text-xs text-port-warning">Save your style edits before running Make complete.</p> : null}
        {job?.makeComplete && job.status === 'failed' ? <p role="alert" className="text-xs text-port-warning">{job.error} Saved analyses are kept. Make complete retries the workflow.</p> : null}
        {job?.makeComplete && job.status === 'done' ? <p role="status" className="text-xs text-port-success">Board complete: style prompt and main image saved.</p> : null}
      </div> : null}
      <div className="flex flex-wrap items-center gap-2">
        {showAnalyze ? (
          <button
            type="button"
            onClick={() => analyzeBoard()}
            disabled={busy || !selectedProviderId}
            className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50 transition-colors"
          >
            <ScanEye className="w-4 h-4" aria-hidden="true" />
            {jobRunning ? jobProgress : `Analyze ${formatCount(plan.pending.length)} new`}
          </button>
        ) : null}
        {showCompose ? (
          <button
            type="button"
            onClick={composeOnly}
            disabled={busy}
            className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-port-bg border border-port-border text-gray-200 hover:text-white disabled:opacity-50 transition-colors"
          >
            {composing ? 'Composing style prompt…' : 'Compose style prompt'}
          </button>
        ) : null}
        {!showAnalyze && !showCompose ? (
          <p className="text-xs text-gray-500">Pin an image or video to analyze this board.</p>
        ) : null}
      </div>

      {showCompose ? (
        <p className="text-xs text-gray-400">
          Combines saved pin analyses into the Style prompt below for posters and renders.
          It does not re-analyze images or replace your Board prompt.
        </p>
      ) : null}

      <AnalysisProvider
        providers={providers}
        selectedProviderId={selectedProviderId}
        selectedModel={selectedModel}
        availableModels={availableModels}
        setSelectedProviderId={setSelectedProviderId}
        setSelectedModel={setSelectedModel}
        effort={effort}
        setEffort={setEffort}
        busy={busy}
        providersLoading={providersLoading}
        providersError={providersError}
        retryProviders={retryProviders}
      />
      {plan.skipped > 0 ? (
        <p className="text-[11px] text-gray-500">
          {formatCount(plan.skipped)} pin{plan.skipped === 1 ? '' : 's'} couldn’t be imported from {plan.skipped === 1 ? 'its' : 'their'} source URL and can’t be analyzed yet.
        </p>
      ) : null}
    </>
  );
}
