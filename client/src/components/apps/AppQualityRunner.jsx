import { useCallback, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import ProviderModelSelector from '../ProviderModelSelector';
import MaintenanceRunStatus from '../cos/tabs/schedule/MaintenanceRunStatus';
import useProviderModels from '../../hooks/useProviderModels';
import { useAutoRefetch } from '../../hooks/useAutoRefetch';
import { enabledProcessProviderFilter } from '../../utils/providers';
import { getMaintenanceRuns, startMaintenanceRun, stopMaintenanceRun } from '../../services/apiAgents';

// Inapplicable here (no UI for an accessibility audit, say): the server skips
// the dispatch anyway, so the batch selections leave it out. Picking the one
// category by name still offers it, and the server explains the skip.
const isApplicable = category => category.applicable !== false;
const needsCheck = category => {
  if (!isApplicable(category)) return false;
  // A stale not-applicable ruling has expired (the repo may have gained a UI), so it is re-offered.
  if ((category.coverage === 'not-applicable' && !category.stale) || (category.coverage === 'unavailable' && category.assessedAt)) return false;
  return category.score == null || category.stale || category.coverage !== 'broad' || category.confidence === 'low';
};

export default function AppQualityRunner({ app, children }) {
  const categories = app.quality?.categories || [];
  const [params, setParams] = useSearchParams();
  const requested = params.get('qualityCheck');
  const selection = requested === 'all' || categories.some(category => category.id === requested) ? requested : 'missing';
  const setSelection = value => setParams(previous => {
    const next = new URLSearchParams(previous);
    next.set('qualityCheck', value);
    return next;
  });
  const [mode, setMode] = useState('file-issues');
  const [effort, setEffort] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [runs, setRuns] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const revision = useRef(0);
  const picker = useProviderModels({ filter: enabledProcessProviderFilter, withEffort: true });
  const taskTypes = categories.filter(category => (selection === 'all' && isApplicable(category)) || (selection === 'missing' ? needsCheck(category) : category.id === selection)).map(category => category.id);
  const loadRuns = useCallback(async () => {
    const requestedRevision = revision.current;
    const response = await getMaintenanceRuns({ silent: true }).catch(() => null);
    if (!response || requestedRevision !== revision.current) return;
    setRuns(response.runs.filter(entry => entry.appId === app.id));
    setLoaded(true);
  }, [app.id]);
  useAutoRefetch(loadRuns, 15000, { enabled: !busy, immediate: !loaded, pollOnly: true });
  const start = async () => {
    revision.current += 1;
    setBusy(true);
    setError('');
    const response = await startMaintenanceRun({ appId: app.id, providerId: picker.selectedProviderId, model: picker.selectedModel,
      effort: effort || null, mode, claimBetweenAudits: false, taskTypes,
      // A category picked by name is the user's explicit choice and runs even if
      // the repository scan says it cannot apply; batch selections stay gated.
      ...(selection !== 'missing' && selection !== 'all' ? { explicitCheck: true } : {}) }, { silent: true }).catch(err => { setError(err.message); return null; });
    if (response) setRuns(previous => [response.run, ...previous.filter(entry => entry.id !== response.run.id)]);
    setBusy(false);
  };
  const stop = async (id) => {
    revision.current += 1;
    setBusy(true);
    setError('');
    const response = await stopMaintenanceRun(id, { silent: true }).catch(err => { setError(err.message); return null; });
    if (response) setRuns(previous => previous.map(entry => entry.id === response.run.id ? response.run : entry));
    setBusy(false);
  };
  const controls = <section id="quality-runner" aria-label="Run quality checks" className="space-y-3">
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
      <label htmlFor="quality-checks">Checks
        <select id="quality-checks" className="block w-full bg-port-bg border border-port-border rounded p-2" value={selection} disabled={busy} onChange={event => setSelection(event.target.value)}>
          <option value="missing">Missing or outdated evidence</option><option value="all">All applicable categories</option>
          {categories.map(category => <option key={category.id} value={category.id}>{category.label}</option>)}
        </select>
      </label>
      <label htmlFor="quality-mode">Mode
        <select id="quality-mode" className="block w-full bg-port-bg border border-port-border rounded p-2" value={mode} disabled={busy} onChange={event => setMode(event.target.value)}>
          <option value="file-issues">File issues</option><option value="fix">Audit and fix</option>
        </select>
      </label>
    </div>
    <ProviderModelSelector providers={picker.providers} selectedProviderId={picker.selectedProviderId} selectedModel={picker.selectedModel}
      availableModels={picker.availableModels} onProviderChange={value => { picker.setSelectedProviderId(value); setEffort(''); }}
      onModelChange={picker.setSelectedModel} effort={effort} onEffortChange={setEffort} loading={picker.loading} disabled={busy}
      emptyProviderOption="Select a subscription provider" emptyModelOption="Select a model" includeDefaultModel highlightToolUse />
    <p className="text-xs text-gray-400">Runs sequentially; launch another batch to run in parallel. {mode === 'fix' ? 'Each audit can change code and open a PR.' : 'Findings become issues; no fixes.'}</p>
    <details className="text-xs"><summary className="cursor-pointer text-port-accent">Selected checks ({taskTypes.length})</summary><p className="mt-1">{categories.filter(category => taskTypes.includes(category.id)).map(category => category.label).join(', ') || 'No checks need evidence. Unavailable assessments and categories that do not apply to this repository are excluded.'}</p></details>
    <button type="button" onClick={start} disabled={busy || picker.loading || !picker.selectedProviderId || !picker.selectedModel || !taskTypes.length || app.quality?.unavailable}
      className="px-3 py-2 rounded bg-port-accent text-port-bg text-sm font-medium disabled:opacity-50">{taskTypes.length === 1 ? 'Run now' : `Run ${taskTypes.length} checks now`}</button>
    {!loaded && <p className="text-xs" role="status">Loading runner status… <button type="button" className="text-port-accent" onClick={loadRuns}>Retry</button></p>}
    {error && <p role="alert" className="text-sm text-port-error">{error}</p>}
    {runs.filter((run, index) => run.status === 'running' || index === 0).map(run => <div key={run.id} className="space-y-2">
      <MaintenanceRunStatus run={run} />
      {run.reason && <p className="text-xs break-words">{run.reason} <Link className="text-port-accent underline" to="/cos/schedule">Open runner settings</Link></p>}
      {run.status === 'running' && <button type="button" className="text-xs text-port-accent" disabled={busy} onClick={() => stop(run.id)}>Stop remaining checks</button>}
    </div>)}
  </section>;
  const activeRuns = runs.filter(run => run.status === 'running').length;
  return children ? children(controls, activeRuns) : controls;
}
