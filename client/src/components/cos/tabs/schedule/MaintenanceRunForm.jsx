import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import socket from '../../../../services/socket';
import MaintenanceRunStatus from './MaintenanceRunStatus';
import ProviderModelSelector from '../../../ProviderModelSelector';
import * as api from '../../../../services/api';
import { useAutoRefetch } from '../../../../hooks/useAutoRefetch';
import { buildQuotaBurnTaskCatalog, maintenancePrerequisites, taskSourceHref } from '../../../../lib/quotaBurnTasks';
import { getAppName } from '../../../../utils/formatters';
import { effortAwareModelOptions, isProcessProvider } from '../../../../utils/providers';
import { familyForProvider } from '../../../../../../server/lib/providerFamilies';

const RUNS_POLL_MS = 15_000;
const FINISHED_RUNS_SHOWN = 3;

export default function MaintenanceRunForm({ schedule, apps = [], providers = [], providersLoaded, improvementDisabled, daemonRunning, onRefresh }) {
  const [appId, setAppId] = useState('');
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [mode, setMode] = useState('file-issues');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [message, setMessage] = useState('');
  // `null` = not read yet, `[]` = read and empty — the first read must happen
  // even when there is nothing to show.
  const [runs, setRuns] = useState(null);
  const revision = useRef(0);
  const availableProviders = providers.filter(provider => provider.enabled && isProcessProvider(provider) && familyForProvider(provider));
  const provider = availableProviders.find(entry => entry.id === providerId);
  const groups = buildQuotaBurnTaskCatalog({ schedule, apps });
  const prerequisites = maintenancePrerequisites(groups, appId);
  const ready = Boolean(appId) && prerequisites.length === 0;
  const blocked = improvementDisabled || daemonRunning === false;

  const fetchRuns = useCallback(async () => {
    const requestedRevision = revision.current;
    const response = await api.getMaintenanceRuns({ silent: true }).catch(() => null);
    // A failed read stays `null` so the poll keeps trying; only a real answer
    // settles the list.
    if (response && requestedRevision === revision.current) setRuns(response.runs || []);
  }, []);
  const anyRunning = (runs || []).some(run => run.status === 'running');
  // One read on mount, then polling only while a run is in flight — an idle
  // form costs nothing, and a start/resume already holds the fresh record.
  const { refetch: refreshRuns } = useAutoRefetch(fetchRuns, RUNS_POLL_MS, { pollOnly: true, enabled: runs === null || anyRunning, immediate: runs === null });

  useEffect(() => {
    const subscribe = () => { socket.emit('cos:subscribe'); fetchRuns(); };
    const update = updated => {
      revision.current += 1;
      setRuns(current => {
        const previous = (current || []).find(entry => entry.id === updated.id);
        if (previous?.updatedAt > updated.updatedAt) return current;
        return [updated, ...(current || []).filter(entry => entry.id !== updated.id)];
      });
    };
    socket.on('cos:maintenance:updated', update);
    socket.on('connect', subscribe);
    socket.emit('cos:subscribe');
    return () => {
      socket.off('cos:maintenance:updated', update);
      socket.off('connect', subscribe);
    };
  }, [fetchRuns]);

  const prepare = async () => {
    if (busy || !onRefresh || !prerequisites.length || prerequisites.some(item => item.unavailable)) return;
    setBusy(true);
    setPreparing(true);
    setMessage('Enabling required tasks…');
    const save = async () => {
      for (const { taskType, settings, enableApp } of prerequisites) {
        if (Object.keys(settings).length) {
          const result = await api.updateCosTaskInterval(taskType, settings, { silent: true });
          if (!result?.success) throw new Error(`Could not update ${taskType}`);
        }
        if (enableApp) {
          const result = await api.updateAppTaskTypeOverride(appId, taskType, { enabled: true }, { silent: true });
          if (!result?.success) throw new Error(`Could not enable ${taskType} for this app`);
        }
      }
      return true;
    };
    const saved = await save().catch(error => {
      setMessage(`Setup incomplete: ${error.message}. Saved changes are kept; retry to finish.`);
      return false;
    });
    // Refresh even after a partial save so retries use the persisted settings.
    const refreshed = await onRefresh().catch(() => false);
    if (!refreshed) setMessage(current => saved
      ? 'Could not refresh task settings. Refresh the schedule before running maintenance.'
      : `${current} Refreshing the schedule also failed.`);
    else if (saved) setMessage('Required task settings saved.');
    setPreparing(false);
    setBusy(false);
  };

  const describe = result => (result?.dispatched
    ? `Maintenance started with ${result.taskType}. Later steps follow as each one finishes; progress is shown below and in Tasks.`
    : `Maintenance run saved; holding: ${result?.reason || 'nothing dispatched'}. It retries on its own.`);

  const run = async () => {
    if (busy || blocked || !ready || !provider || !model || !consent) return;
    setBusy(true);
    setMessage('Starting maintenance…');
    const response = await api.startMaintenanceRun({ appId, providerId, model, effort: effort || null, mode }, { silent: true }).catch(error => {
      setMessage(`Could not start maintenance: ${error.message}`);
      return null;
    });
    if (response?.run) {
      revision.current += 1;
      setRuns(current => [response.run, ...(current || []).filter(entry => entry.id !== response.run.id)]);
      setMessage(describe(response.result));
      setConsent(false);
    }
    setBusy(false);
  };

  const applyRun = (updated, result) => {
    if (!updated) return;
    revision.current += 1;
    setRuns(current => (current || []).map(entry => (entry.id === updated.id ? updated : entry)));
    if (result) setMessage(describe(result));
  };
  const stop = async id => {
    const response = await api.stopMaintenanceRun(id, { silent: true }).catch(error => {
      setMessage(`Could not stop the run: ${error.message}`);
      return null;
    });
    applyRun(response?.run);
  };
  const resume = async id => {
    const response = await api.resumeMaintenanceRun(id, { silent: true }).catch(error => {
      setMessage(`Could not resume the run: ${error.message}`);
      return null;
    });
    applyRun(response?.run, response?.result);
  };

  const visibleRuns = [
    ...(runs || []).filter(entry => entry.status === 'running'),
    ...(runs || []).filter(entry => entry.status !== 'running').slice(0, FINISHED_RUNS_SHOWN),
  ];

  return (
    <div className="mt-3 space-y-3 text-sm">
      <label htmlFor="maintenance-run-app" className="block">
        App
        <select id="maintenance-run-app" value={appId} disabled={busy} onChange={event => setAppId(event.target.value)} className="mt-1 w-full bg-port-bg border border-port-border rounded p-2 text-white">
          <option value="">Select an app</option>
          {apps.filter(app => app.archived !== true).map(app => <option key={app.id} value={app.id}>{app.name}</option>)}
        </select>
      </label>
      <label htmlFor="maintenance-run-mode" className="block">
        Audit mode
        <select id="maintenance-run-mode" value={mode} disabled={busy} onChange={event => { setMode(event.target.value); setConsent(false); }} className="mt-1 w-full bg-port-bg border border-port-border rounded p-2 text-white">
          <option value="file-issues">File issues</option>
          <option value="fix">Audit and fix</option>
        </select>
      </label>
      <p className="text-xs">{mode === 'fix'
        ? 'Audits fix findings directly, then documentation runs, followed by one final claim-issue drain for remaining issues.'
        : 'Audits file issues, with a claim-issue drain between audits to resolve findings before the next step.'}</p>
      <ProviderModelSelector
        providers={availableProviders}
        selectedProviderId={providerId}
        selectedModel={model}
        availableModels={provider ? effortAwareModelOptions(provider, model) : []}
        onProviderChange={next => { setProviderId(next); setModel(''); setEffort(''); }}
        onModelChange={setModel}
        effort={effort}
        onEffortChange={setEffort}
        emptyProviderOption="Select a subscription provider"
        emptyModelOption="Select a model"
        alwaysShowModel
        loading={!providersLoaded}
        disabled={busy}
      />
      {appId && !ready && <div className="space-y-2">
        <p role="status">Run now needs these saved task settings:</p>
        <ul className="list-disc pl-5 space-y-1">
          {prerequisites.map(item => <li key={item.taskType}>
            <Link className="underline" to={taskSourceHref(item)}>{item.taskType}</Link>: {item.reason}
          </li>)}
        </ul>
        {onRefresh && !prerequisites.some(item => item.unavailable) && <>
          <p className="text-xs">Enable the listed tasks globally and for this app, and set claim-issue to perpetual. This also allows their existing schedules to run.</p>
          <button type="button" onClick={prepare} disabled={busy} className="px-3 py-1.5 bg-port-accent text-white rounded disabled:opacity-50">
            {preparing ? 'Enabling…' : 'Enable required tasks'}
          </button>
        </>}
      </div>}
      {blocked && <p role="status">Enable Improvement and start the CoS daemon before running maintenance.</p>}
      <p className="text-xs">Runs every step now, in order: each audit starts when the previous step finishes, and each claim-issue drain repeats until the app’s issue backlog is empty. Independent of Quota Burn — no master switch, no quota gates, nothing to re-arm. Supports subscription CLI/TUI providers. Blank effort inherits each scheduled task’s saved effort.</p>
      <label className="flex items-start gap-2" htmlFor="maintenance-run-consent">
        <input id="maintenance-run-consent" type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} />
        <span>Run the whole maintenance sequence for this app on the selected provider now, spending its quota as needed.</span>
      </label>
      <div className="flex items-center gap-3 flex-wrap">
        <button type="button" onClick={run} disabled={busy || blocked || !ready || !provider || !model || !consent || !providersLoaded} className="px-3 py-1.5 bg-port-accent text-white rounded disabled:opacity-50">
          {busy && !preparing ? 'Starting…' : 'Run now'}
        </button>
        <Link className="underline" to="/devtools/quota-burn">Schedule this sequence in Quota Burn instead</Link>
      </div>
      {message && <p role="status">{message}</p>}
      {visibleRuns.length > 0 && <ul aria-label="Maintenance runs" className="space-y-2">
        {visibleRuns.map(entry => {
          return <li key={entry.id} className="border border-port-border rounded p-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-medium">{getAppName(entry.appId, apps, entry.appId)}</span>
            <span className="text-xs">{entry.providerId}{entry.model ? ` · ${entry.model}` : ''}</span>
            <MaintenanceRunStatus run={entry} />
            {entry.status === 'running'
              ? <button type="button" onClick={() => stop(entry.id)} className="px-2 py-1 text-xs bg-port-border rounded">Stop</button>
              : entry.status === 'stopped' && <button type="button" onClick={() => resume(entry.id)} className="px-2 py-1 text-xs bg-port-border rounded">Resume</button>}
          </li>;
        })}
      </ul>}
      {visibleRuns.length > 0 && <button type="button" onClick={refreshRuns} className="text-xs underline">Refresh runs</button>}
    </div>
  );
}
