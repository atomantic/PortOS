import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import ProviderModelSelector from '../ProviderModelSelector';
import MaintenanceRunStatus, { maintenanceRunProgress } from '../cos/tabs/schedule/MaintenanceRunStatus';
import useProviderModels from '../../hooks/useProviderModels';
import { useSocketResource } from '../../hooks/useSocketResource';
import { formatCount } from '../../utils/formatters';
import { enabledProcessProviderFilter } from '../../utils/providers';
import { getMaintenanceRuns, startMaintenanceRun, stopMaintenanceRun, setMaintenanceRunArchived } from '../../services/apiAgents';

const RUN_EVENTS = ['cos:maintenance:updated'];

// Inapplicable here (no UI for an accessibility audit, say): the server skips
// the dispatch anyway, so the batch selections leave it out. Picking the one
// category by name still offers it, and the server explains the skip.
const isApplicable = category => category.applicable !== false;
const BELOW_COMPOSITE = 'below-composite';
const needsCheck = category => {
  if (!isApplicable(category)) return false;
  // Expired assessments can be retried; current applicability still gates the batch above.
  if (!category.stale && (category.coverage === 'not-applicable' || (category.coverage === 'unavailable' && category.assessedAt))) return false;
  return category.score == null || category.stale || category.coverage !== 'broad' || category.confidence === 'low';
};

export default function AppQualityRunner({ app, children }) {
  const categories = app.quality?.categories || [];
  const compositeScore = app.quality?.score;
  const [params, setParams] = useSearchParams();
  const requested = params.get('qualityCheck');
  const selection = requested === 'all' || requested === BELOW_COMPOSITE || categories.some(category => category.id === requested) ? requested : 'missing';
  const setSelection = value => setParams(previous => {
    const next = new URLSearchParams(previous);
    next.set('qualityCheck', value);
    return next;
  });
  const [mode, setMode] = useState('file-issues');
  const [auditDepth, setAuditDepth] = useState('quick');
  const [prCompletion, setPrCompletion] = useState('inherit');
  const [effort, setEffort] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const appIdRef = useRef(app.id);
  appIdRef.current = app.id;
  useEffect(() => {
    setBusy(false);
    setError('');
  }, [app.id]);
  const picker = useProviderModels({ filter: enabledProcessProviderFilter, withEffort: true });
  const selectedCategories = categories.filter(category => {
    if (selection === 'all') return isApplicable(category);
    if (selection === 'missing') return needsCheck(category);
    if (selection === BELOW_COMPOSITE) {
      return isApplicable(category) && compositeScore != null && category.score != null
        && category.coverage !== 'not-applicable' && category.score < compositeScore;
    }
    return category.id === selection;
  });
  const taskTypes = selectedCategories.map(category => category.id);
  const batchSelection = selection === 'missing' || selection === 'all' || selection === BELOW_COMPOSITE;
  const emptySelectionMessage = selection === BELOW_COMPOSITE
    ? compositeScore == null
      ? 'No overall composite score is available, so below-score checks cannot be selected.'
      : `No applicable checks currently score below the overall composite score of ${compositeScore}/100.`
    : selection === 'all'
      ? 'No applicable checks are available.'
      : 'No checks need evidence. Recent unavailable assessments and categories that do not apply to this repository are excluded.';
  const { data, loading, error: loadError, refetch: loadRuns, updateData: setRuns } = useSocketResource(
    () => getMaintenanceRuns({ silent: true }).then(response => response.runs.filter(entry => entry.appId === app.id)),
    { namespace: 'cos', events: RUN_EVENTS, resourceKey: app.id, matchesEvent: run => run?.appId === app.id },
  );
  const runs = data ?? [];
  const showArchived = params.get('qualityHistory') === 'archived';
  const visibleRuns = runs.filter(run => Boolean(run.archivedAt) === showArchived);
  const archive = async (id, archived) => {
    setBusy(true);
    setError('');
    const response = await setMaintenanceRunArchived(id, app.id, archived, { silent: true }).catch(err => { if (appIdRef.current === app.id) setError(err.message); return null; });
    if (appIdRef.current !== app.id) return;
    if (response) setRuns(previous => (previous ?? []).map(entry => entry.id === response.run.id ? response.run : entry));
    setBusy(false);
  };
  const start = async () => {
    setBusy(true);
    setError('');
    const response = await startMaintenanceRun({ appId: app.id, providerId: picker.selectedProviderId, model: picker.selectedModel,
      effort: effort || null, mode, ...(auditDepth === 'deep' ? { auditDepth } : {}), claimBetweenAudits: false, taskTypes,
      ...(mode === 'fix' && prCompletion ? { prCompletion } : {}),
      // A category picked by name is the user's explicit choice and runs even if
      // the repository scan says it cannot apply; batch selections stay gated.
      ...(!batchSelection ? { explicitCheck: true } : {}) }, { silent: true }).catch(err => { if (appIdRef.current === app.id) setError(err.message); return null; });
    if (appIdRef.current !== app.id) return;
    if (response) setRuns(previous => [response.run, ...(previous ?? []).filter(entry => entry.id !== response.run.id)]);
    setBusy(false);
  };
  const stop = async (id) => {
    setBusy(true);
    setError('');
    const response = await stopMaintenanceRun(id, { silent: true }).catch(err => { if (appIdRef.current === app.id) setError(err.message); return null; });
    if (appIdRef.current !== app.id) return;
    if (response) setRuns(previous => (previous ?? []).map(entry => entry.id === response.run.id ? response.run : entry));
    setBusy(false);
  };
  const controls = <section id="quality-runner" aria-label="Run quality checks" className="space-y-3">
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
      <label htmlFor="quality-checks">Checks
        <select id="quality-checks" className="block w-full bg-port-bg border border-port-border rounded p-2" value={selection} disabled={busy} onChange={event => setSelection(event.target.value)}>
          <option value="missing">Missing or outdated evidence</option><option value={BELOW_COMPOSITE}>Below composite score</option><option value="all">All applicable categories</option>
          {categories.map(category => <option key={category.id} value={category.id}>{category.label}</option>)}
        </select>
      </label>
      <label htmlFor="quality-mode">Mode
        <select id="quality-mode" className="block w-full bg-port-bg border border-port-border rounded p-2" value={mode} disabled={busy} onChange={event => setMode(event.target.value)}>
          <option value="file-issues">File issues</option><option value="fix">Audit and fix</option>
        </select>
      </label>
    </div>
    <label htmlFor="quality-depth" className="block text-sm">Audit depth
      <select id="quality-depth" className="block w-full bg-port-bg border border-port-border rounded p-2" value={auditDepth} disabled={busy} onChange={event => setAuditDepth(event.target.value)}>
        <option value="quick">Quick — broad scan, focused review</option>
        <option value="deep">Deep — extended investigation and multiple fixes</option>
      </select>
    </label>
    {auditDepth === 'deep' && <p className="text-xs text-gray-400">Spend more time investigating high-risk paths and fixing multiple worthwhile issues in one run. The summary reports coverage and remaining limits; Deep does not certify every file.</p>}
    {mode === 'fix' && <div><label htmlFor="quality-publication" className="block text-sm">Pull requests
      <select id="quality-publication" className="block w-full bg-port-bg border border-port-border rounded p-2" value={prCompletion} disabled={busy} onChange={event => setPrCompletion(event.target.value)}>
        <option value="draft">Drafts for review — never merge</option>
        <option value="inherit">Follow saved policy — may merge automatically</option>
      </select>
    </label>
      <p className="text-xs text-gray-400 mt-1">{prCompletion === 'inherit' ? 'Each check uses its saved PR completion policy; fixes and quality snapshots may merge automatically.' : 'Fixes stay in draft pull requests for review. Automatic quality snapshot publication is skipped.'} This setting does not schedule additional checks or rescans.</p>
    </div>}
    <ProviderModelSelector providers={picker.providers} selectedProviderId={picker.selectedProviderId} selectedModel={picker.selectedModel}
      availableModels={picker.availableModels} onProviderChange={value => { picker.setSelectedProviderId(value); setEffort(''); }}
      onModelChange={picker.setSelectedModel} effort={effort} onEffortChange={setEffort} loading={picker.loading} disabled={busy}
      emptyProviderOption="Select a subscription provider" emptyModelOption="Select a model" includeDefaultModel highlightToolUse />
    <p className="text-xs text-gray-400">Batch execution: selected checks run one after another. A separately launched batch can run in parallel. {mode === 'file-issues' && 'Findings become issues; no fixes.'}</p>
    <details className="text-xs"><summary className="cursor-pointer text-port-accent">Selected checks ({taskTypes.length})</summary><p className="mt-1">{selectedCategories.map(category => category.label).join(', ') || emptySelectionMessage}</p></details>
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" onClick={start} disabled={busy || picker.loading || !picker.selectedProviderId || !picker.selectedModel || !taskTypes.length || app.quality?.unavailable}
        className="px-3 py-2 rounded bg-port-accent text-port-bg text-sm font-medium disabled:opacity-50">{taskTypes.length === 1 ? 'Run now' : `Run ${taskTypes.length} checks now`}</button>
      <button type="button" className="text-xs text-port-accent" onClick={() => setParams(previous => {
        const next = new URLSearchParams(previous);
        if (showArchived) next.delete('qualityHistory'); else next.set('qualityHistory', 'archived');
        return next;
      })}>{showArchived ? 'View current runs' : `View archived runs (${formatCount(runs.filter(run => run.archivedAt).length)})`}</button>
    </div>
    {(loading || loadError) && <p className="text-xs" role="status">{loadError ? 'Runner status is unavailable.' : 'Loading runner status…'} <button type="button" className="text-port-accent" onClick={loadRuns}>Retry</button></p>}
    {error && <p role="alert" className="text-sm text-port-error">{error}</p>}
    {showArchived && <p className="text-xs text-gray-400">Archived history retains evidence and findings. Restoring a card does not restart its run.</p>}
    {visibleRuns.filter((run, index) => showArchived || (run.status !== 'completed' && (run.status === 'running' || run.auditDepth === 'deep' || index === 0))).map(run => <div key={run.id} className="space-y-2">
      <MaintenanceRunStatus run={run} />
      {run.reason && !(run.auditDepth === 'deep' && !run.auditWorkflow) && <p className="text-xs break-words">{run.reason} <Link className="text-port-accent underline" to="/cos/schedule">Open runner settings</Link></p>}
      {run.auditDepth === 'deep' && !run.auditWorkflow && <p className="text-xs text-gray-400">Historical exhaustive audit — evidence retained; start a new Deep run above.</p>}
      {run.status !== 'running' && <button type="button" className="text-xs text-port-accent" disabled={busy} onClick={() => archive(run.id, !run.archivedAt)}>{run.archivedAt ? 'Restore run history' : 'Archive run history'}</button>}
      {run.status === 'running' && <button type="button" className="text-xs text-port-accent" disabled={busy} onClick={() => stop(run.id)}>Stop remaining checks</button>}
    </div>)}
  </section>;
  const status = <QualityRunStatus runs={runs} categories={categories} loading={loading} loadError={loadError}
    error={error} busy={busy} onStop={stop} onRetry={loadRuns} />;
  return children ? children(controls, status) : controls;
}

function QualityRunStatus({ runs, categories, loading, loadError, error, busy, onStop, onRetry }) {
  const batches = runs.filter(run => run.status === 'running').map(run => {
    const { done, total, step } = maintenanceRunProgress(run);
    const active = ['running', 'in_progress'].includes(run.active?.status) ? 1 : 0;
    const pending = Math.max(0, total - done - active);
    const state = active ? 'Active' : run.active?.status === 'blocked' ? 'Blocked' : run.active ? 'Queued' : 'Waiting';
    const label = categories.find(category => category.id === step)?.label || step || 'Quality checks';
    return { run, done, total, active, pending, state, label };
  });
  const active = batches.reduce((sum, batch) => sum + batch.active, 0);
  const pending = batches.reduce((sum, batch) => sum + batch.pending, 0);
  return <section aria-label="Checks in flight" className="basis-full min-w-0 w-full border-t border-port-border pt-3 space-y-2 text-xs">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="font-medium">Checks in flight</h4>
      {batches.length > 0 && <p role="status" className="tabular-nums">{formatCount(active)} active · {formatCount(pending)} pending</p>}
    </div>
    {(loading || loadError) && <p role="status">
      {loadError ? 'Runner status is unavailable.' : 'Loading runner status…'}{' '}
      <button type="button" className="text-port-accent min-h-[44px] px-2" onClick={onRetry}>Retry</button>
    </p>}
    {error && <p role="alert" className="text-port-error">{error}</p>}
    {!loading && !loadError && batches.length === 0 && <p className="text-gray-400">No checks in flight.</p>}
    {batches.length > 0 && <>
      <ul className="space-y-2" aria-label="Check batches">
        {batches.map(({ run, done, total, pending: remaining, state, label }) => <li key={run.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <div className="flex-1 min-w-0 basis-48 space-y-1">
            <p className="break-words"><span className="font-medium">{label}</span> · {state} · {formatCount(done)}/{formatCount(total)} complete · {formatCount(remaining)} pending</p>
            {run.reason && <p className="text-gray-400 break-words">{run.reason}</p>}
            {run.active?.agentId && <Link className="text-port-accent underline" to={`/cos/agents/${encodeURIComponent(run.active.agentId)}`}>View active agent</Link>}
          </div>
          <button type="button" disabled={busy} onClick={() => onStop(run.id)}
            className="min-h-[44px] rounded border border-port-border px-3 text-port-accent hover:border-port-accent disabled:opacity-50">Stop remaining checks</button>
        </li>)}
      </ul>
      <p className="text-gray-400">Stopping prevents later checks. Work already queued or running can still finish.</p>
    </>}
  </section>;
}
