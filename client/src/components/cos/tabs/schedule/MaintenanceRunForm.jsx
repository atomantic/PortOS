import { useState } from 'react';
import { uuidv4 } from '../../../../lib/uuid';
import { Link } from 'react-router';
import ProviderModelSelector from '../../../ProviderModelSelector';
import * as api from '../../../../services/api';
import { buildQuotaBurnTaskCatalog, maintenancePrerequisites, maintenanceSequence, taskSourceHref } from '../../../../lib/quotaBurnTasks';
import { effortAwareModelOptions, isProcessProvider } from '../../../../utils/providers';
import { familyForProvider } from '../../../../../../server/lib/providerFamilies';

export default function MaintenanceRunForm({ schedule, apps = [], providers = [], providersLoaded, improvementDisabled, daemonRunning, onRefresh }) {
  const [appId, setAppId] = useState('');
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [message, setMessage] = useState('');
  const availableProviders = providers.filter(provider => provider.enabled && isProcessProvider(provider) && familyForProvider(provider));
  const provider = availableProviders.find(entry => entry.id === providerId);
  const familyId = familyForProvider(provider);
  const groups = buildQuotaBurnTaskCatalog({ schedule, apps });
  const jobs = maintenanceSequence(groups, appId, 'preview');
  const prerequisites = maintenancePrerequisites(groups, appId);
  const blocked = improvementDisabled || daemonRunning === false;

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
    if (!refreshed) setMessage('Could not refresh task settings. Refresh the schedule before running maintenance.');
    else if (saved) setMessage('Required tasks enabled. You can now run maintenance.');
    setPreparing(false);
    setBusy(false);
  };

  const run = async () => {
    if (busy || blocked || !jobs || !provider || !model || !consent) return;
    setBusy(true);
    setMessage('Checking existing plan…');
    const current = await api.getQuotaBurn(false, { silent: true }).catch(error => {
      setMessage(`Could not check existing plan: ${error.message}`);
      return null;
    });
    if (!current?.config || current.config.families?.[familyId]?.jobs?.length) {
      if (current?.config) setMessage('This family already has a plan. Manage or clear it in Quota Burn before starting another sequence.');
      setBusy(false);
      return;
    }
    setMessage('Saving maintenance sequence…');
    // Each invocation gets fresh completion keys. Pins apply to the audits AND
    // their claim drains; the scheduled tasks' saved settings remain intact.
    const steps = maintenanceSequence(groups, appId, `maintenance-${uuidv4()}`).map(job => ({
      ...job,
      overrides: { ...job.overrides, providerId, model, effort: effort || null },
    }));
    const saved = await api.saveQuotaBurn({
      enabled: true,
      families: { [familyId]: { enabled: true, sequence: true, jobs: steps } },
    }, { silent: true }).catch(error => {
      setMessage(`Could not save maintenance sequence: ${error.message}`);
      return null;
    });
    if (saved) {
      const response = await api.runQuotaBurn({ familyId, force: true }, { silent: true }).catch(error => {
        setMessage(`Sequence saved, but could not start: ${error.message}. Manage it in Quota Burn.`);
        return null;
      });
      if (response) {
        const result = response.result;
        setMessage(result?.dispatched
          ? 'Maintenance started. Follow progress in Tasks and Quota Burn.'
          : `Sequence saved; waiting: ${result?.reason || 'no task dispatched'}. See Quota Burn for details.`);
      }
      setConsent(false);
    }
    setBusy(false);
  };

  return (
    <div className="mt-3 space-y-3 text-sm">
      <label htmlFor="maintenance-run-app" className="block">
        App
        <select id="maintenance-run-app" value={appId} disabled={busy} onChange={event => setAppId(event.target.value)} className="mt-1 w-full bg-port-bg border border-port-border rounded p-2 text-white">
          <option value="">Select an app</option>
          {apps.filter(app => app.archived !== true).map(app => <option key={app.id} value={app.id}>{app.name}</option>)}
        </select>
      </label>
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
      {appId && !jobs && <div className="space-y-2">
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
      <p className="text-xs">Runs the first step now, bypassing its reset window, reserve, and dispatch cap; later steps continue in order through Quota Burn, subject to its quota gates. Supports subscription CLI/TUI providers. Blank effort inherits each scheduled task’s saved effort.</p>
      <label className="flex items-start gap-2" htmlFor="maintenance-run-consent">
        <input id="maintenance-run-consent" type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} />
        <span>Enable Quota Burn and add this maintenance sequence to an empty provider family plan. Other enabled family plans may also resume.</span>
      </label>
      <div className="flex items-center gap-3 flex-wrap">
        <button type="button" onClick={run} disabled={busy || blocked || !jobs || !provider || !model || !consent || !providersLoaded} className="px-3 py-1.5 bg-port-accent text-white rounded disabled:opacity-50">
          {busy && !preparing ? 'Starting…' : 'Run now'}
        </button>
        <Link className="underline" to={familyId ? `/devtools/quota-burn/${familyId}` : '/devtools/quota-burn'}>Manage sequence in Quota Burn</Link>
      </div>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
