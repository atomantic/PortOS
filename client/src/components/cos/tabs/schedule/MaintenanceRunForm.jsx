import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import socket from '../../../../services/socket';
import MaintenanceStepSettings from './MaintenanceStepSettings';
import MaintenanceRunStatus from './MaintenanceRunStatus';
import MaintenanceStepChecklist from './MaintenanceStepChecklist';
import { buildMaintenanceSteps } from '../../../../../../server/lib/maintenanceSequence';
import ProviderModelSelector from '../../../ProviderModelSelector';
import * as api from '../../../../services/api';
import { useAutoRefetch } from '../../../../hooks/useAutoRefetch';
import { buildQuotaBurnTaskCatalog, maintenancePrerequisites, taskSourceHref } from '../../../../lib/quotaBurnTasks';
import { getAppName } from '../../../../utils/formatters';
import { effortAwareModelOptions, isProcessProvider } from '../../../../utils/providers';
import { familyForProvider } from '../../../../../../server/lib/providerFamilies';

const RUNS_POLL_MS = 15_000;

export default function MaintenanceRunForm({ schedule, apps = [], providers = [], providersLoaded, improvementDisabled, daemonRunning, onRefresh }) {
  const [appId, setAppId] = useState('');
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [claimHandler, setClaimHandler] = useState({ providerId: '', model: '', effort: '' });
  const [mode, setMode] = useState('file-issues');
  const [claimBetweenAudits, setClaimBetweenAudits] = useState(true);
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
  const prerequisites = maintenancePrerequisites(groups, appId, { mode, claimBetweenAudits });
  const plannedSteps = buildMaintenanceSteps({ appId, idPrefix: 'preview', mode, claimBetweenAudits });
  const hasClaims = plannedSteps.some(step => step.drain);
  const claimProvider = availableProviders.find(entry => entry.id === claimHandler.providerId);
  const claimReady = !hasClaims || !claimHandler.providerId || Boolean(claimProvider && claimHandler.model);
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
    if (busy || blocked || !ready || !claimReady || !provider || !model || !consent) return;
    setBusy(true);
    setMessage('Starting maintenance…');
    const response = await api.startMaintenanceRun({ appId, providerId, model, effort: effort || null, mode, claimBetweenAudits, ...(hasClaims && claimHandler.providerId ? { claimHandler: { ...claimHandler, effort: claimHandler.effort || null } } : {}) }, { silent: true }).catch(error => {
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

  const applyRun = updated => {
    if (!updated) return;
    revision.current += 1;
    setRuns(current => (current || []).map(entry => (entry.id === updated.id && !(entry.updatedAt > updated.updatedAt) ? updated : entry)));
  };
  const stop = async id => {
    const response = await api.stopMaintenanceRun(id, { silent: true }).catch(error => {
      setMessage(`Could not stop the run: ${error.message}`);
      return null;
    });
    applyRun(response?.run);
  };
  const visibleRuns = (runs || []).filter(entry => entry.status === 'running');

  return (
    <div className="mt-3 space-y-3 text-sm">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),24rem))] gap-3">
        <label htmlFor="maintenance-run-app" className="block min-w-0">
          App
          <select id="maintenance-run-app" value={appId} disabled={busy} onChange={event => setAppId(event.target.value)} className="mt-1 w-full bg-port-bg border border-port-border rounded p-2 text-white">
            <option value="">Select an app</option>
            {apps.filter(app => app.archived !== true).map(app => <option key={app.id} value={app.id}>{app.name}</option>)}
          </select>
        </label>
        <label htmlFor="maintenance-run-mode" className="block min-w-0">
          Audit mode
          <select id="maintenance-run-mode" value={mode} disabled={busy} onChange={event => { setMode(event.target.value); setConsent(false); }} className="mt-1 w-full bg-port-bg border border-port-border rounded p-2 text-white">
            <option value="file-issues">File issues</option>
            <option value="fix">Audit and fix</option>
          </select>
        </label>
        {mode === 'file-issues' && <label htmlFor="maintenance-run-claims" className="block min-w-0">
          Issue handling
          <select id="maintenance-run-claims" value={String(claimBetweenAudits)} disabled={busy} onChange={event => { setClaimBetweenAudits(event.target.value === 'true'); setConsent(false); }} className="mt-1 w-full bg-port-bg border border-port-border rounded p-2 text-white">
            <option value="true">Resolve issues between audits</option>
            <option value="false">Leave issues open for review</option>
          </select>
        </label>}
      </div>
      <p className="text-xs">{mode === 'fix'
        ? 'Fix findings in each audit; finish with documentation and one final claim pass.'
        : claimBetweenAudits ? 'Claim passes resolve the backlog before the next audit.' : 'File findings for review; run documentation last. No claim jobs.'}</p>
      <div className="space-y-2">
        <p className="font-medium">Planned steps · {plannedSteps.length}</p>
        <MaintenanceStepChecklist steps={plannedSteps} label="Planned maintenance steps" />
      </div>
      <p className="font-medium">Audit and documentation handler</p>
      <ProviderModelSelector
        providers={availableProviders}
        selectedProviderId={providerId}
        selectedModel={model}
        availableModels={provider ? effortAwareModelOptions(provider, model) : []}
        onProviderChange={next => { setProviderId(next); setModel(''); setEffort(''); setConsent(false); }}
        onModelChange={next => { setModel(next); setConsent(false); }}
        effort={effort}
        onEffortChange={next => { setEffort(next); setConsent(false); }}
        emptyProviderOption="Select a subscription provider"
        emptyModelOption="Select a model" includeDefaultModel
        alwaysShowModel
        loading={!providersLoaded}
        disabled={busy}
      />
      {hasClaims && <fieldset className="space-y-2">
        <legend className="font-medium">Claim-issue handler</legend>
        <ProviderModelSelector
          providers={availableProviders}
          label="Claim provider"
          selectedProviderId={claimHandler.providerId}
          selectedModel={claimHandler.model}
          availableModels={claimProvider ? effortAwareModelOptions(claimProvider, claimHandler.model) : []}
          onProviderChange={next => { setClaimHandler({ providerId: next, model: '', effort: '' }); setConsent(false); }}
          onModelChange={next => { setClaimHandler(current => ({ ...current, model: next })); setConsent(false); }}
          effort={claimHandler.effort}
          onEffortChange={next => { setClaimHandler(current => ({ ...current, effort: next })); setConsent(false); }}
          emptyProviderOption="Same as audit handler"
          emptyModelOption="Select a model" includeDefaultModel
          alwaysShowModel={Boolean(claimHandler.providerId)}
          loading={!providersLoaded}
          disabled={busy}
        />
      </fieldset>}
      {appId && !ready && <div className="space-y-2">
        <p role="status">Run now needs these saved task settings:</p>
        <ul className="list-disc pl-5 space-y-1">
          {prerequisites.map(item => <li key={item.taskType}>
            <Link className="underline" to={taskSourceHref(item)}>{item.taskType}</Link>: {item.reason}
          </li>)}
        </ul>
        {onRefresh && !prerequisites.some(item => item.unavailable) && <>
          <p className="text-xs">Enable the listed tasks globally and for this app. Claim jobs require perpetual mode. Existing schedules may also run.</p>
          <button type="button" onClick={prepare} disabled={busy} className="px-3 py-1.5 bg-port-accent text-white rounded disabled:opacity-50">
            {preparing ? 'Enabling…' : 'Enable required tasks'}
          </button>
        </>}
      </div>}
      {blocked && <p role="status">Enable Improvement and start the CoS daemon before running maintenance.</p>}
      <p className="text-xs">Runs sequentially, without Quota Burn gates. Blank effort uses each task’s saved setting.</p>
      <label className="flex items-start gap-2" htmlFor="maintenance-run-consent">
        <input id="maintenance-run-consent" type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} />
        <span>Run these steps now using the selected providers’ quota.</span>
      </label>
      <div className="flex items-center gap-3 flex-wrap">
        <button type="button" onClick={run} disabled={busy || blocked || !ready || !claimReady || !provider || !model || !consent || !providersLoaded} className="px-3 py-1.5 bg-port-accent text-white rounded disabled:opacity-50">
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
            <MaintenanceRunStatus run={entry} showSteps renderStepSettings={step => (
              <MaintenanceStepSettings key={`${step.id}:${JSON.stringify(step.overrides)}`} run={entry} step={step}
                providers={availableProviders} loading={!providersLoaded} onSaved={applyRun} />
            )} />
            <button type="button" onClick={() => stop(entry.id)} className="px-2 py-1 text-xs bg-port-border rounded">Stop</button>
          </li>;
        })}
      </ul>}
      {visibleRuns.length > 0 && <button type="button" onClick={refreshRuns} className="text-xs underline">Refresh runs</button>}
    </div>
  );
}
