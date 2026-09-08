import { useState } from 'react';
import { Link } from 'react-router';
import ProviderModelSelector from '../../../ProviderModelSelector';
import * as api from '../../../../services/api';
import { buildQuotaBurnTaskCatalog, maintenanceSequence } from '../../../../lib/quotaBurnTasks';
import { effortAwareModelOptions, isProcessProvider } from '../../../../utils/providers';
import { familyForProvider } from '../../../../../../server/lib/providerFamilies';

export default function MaintenanceRunForm({ schedule, apps = [], providers = [], providersLoaded, improvementDisabled, daemonRunning }) {
  const [appId, setAppId] = useState('');
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const availableProviders = providers.filter(provider => provider.enabled && isProcessProvider(provider) && familyForProvider(provider));
  const provider = availableProviders.find(entry => entry.id === providerId);
  const familyId = familyForProvider(provider);
  const groups = buildQuotaBurnTaskCatalog({ schedule, apps });
  const jobs = maintenanceSequence(groups, appId, 'preview');
  const blocked = improvementDisabled || daemonRunning === false;

  const run = async () => {
    if (busy || blocked || !jobs || !provider || !model || !consent) return;
    setBusy(true);
    setMessage('Saving maintenance sequence…');
    // Each invocation gets fresh completion keys. Pins apply to the audits AND
    // their claim drains; the scheduled tasks' saved settings remain intact.
    const steps = maintenanceSequence(groups, appId, `maintenance-${crypto.randomUUID()}`).map(job => ({
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
      {appId && !jobs && <p role="status">Enable every maintenance task and claim-issue for this app, and set claim-issue to perpetual, before running the sequence.</p>}
      {blocked && <p role="status">Enable Improvement and start the CoS daemon before running maintenance.</p>}
      <p className="text-xs">Runs the first step now; later steps continue in order through Quota Burn, subject to its quota gates. Supports subscription CLI/TUI providers.</p>
      <label className="flex items-start gap-2" htmlFor="maintenance-run-consent">
        <input id="maintenance-run-consent" type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} />
        <span>Enable Quota Burn and replace this provider family’s plan with this maintenance sequence. Other enabled family plans may also resume.</span>
      </label>
      <div className="flex items-center gap-3 flex-wrap">
        <button type="button" onClick={run} disabled={busy || blocked || !jobs || !provider || !model || !consent || !providersLoaded} className="px-3 py-1.5 bg-port-accent text-white rounded disabled:opacity-50">
          {busy ? 'Starting…' : 'Run now'}
        </button>
        <Link className="underline" to={familyId ? `/devtools/quota-burn/${familyId}` : '/devtools/quota-burn'}>Manage sequence in Quota Burn</Link>
      </div>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
