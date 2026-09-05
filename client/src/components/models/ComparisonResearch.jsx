import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { getProviders } from '../../services/apiProviders';
import { getCosSchedule, updateCosTaskInterval, triggerCosOnDemandTask } from '../../services/apiAgents';

const TASK = 'model-comparison-refresh';
export default function ComparisonResearch() {
  const [providers, setProviders] = useState([]);
  const [saved, setSaved] = useState(null);
  const [draft, setDraft] = useState({ providerId: '', model: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    Promise.all([getProviders({ silent: true }), getCosSchedule({ silent: true })]).then(([data, schedule]) => {
      if (!active) return;
      setProviders(data.providers.filter(provider => provider.enabled !== false));
      const task = schedule.tasks[TASK];
      setSaved(task || { enabled: false });
      setDraft({ providerId: task?.providerId || '', model: task?.model || '' });
    }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, []);
  const provider = providers.find(item => item.id === draft.providerId);
  const valid = provider && provider.models?.includes(draft.model);
  const dirty = saved?.providerId !== draft.providerId || saved?.model !== draft.model;
  const save = () => {
    setBusy(true); setError(''); setMessage('');
    updateCosTaskInterval(TASK, { ...draft, enabled: true }, { silent: true }).then(result => {
      setSaved(result.interval); setMessage('Research provider saved. You can now run the task.');
    }).catch(err => setError(err.message)).finally(() => setBusy(false));
  };
  const run = () => {
    setBusy(true); setError(''); setMessage('');
    triggerCosOnDemandTask(TASK, null, { silent: true }).then(result => {
      if (result.error) throw new Error(result.error);
      setMessage('Research queued in CoS. Follow the run there, then reload comparison data after it completes.');
    }).catch(err => setError(err.message)).finally(() => setBusy(false));
  };
  return <section className="bg-port-card border border-port-border rounded-2xl p-5 space-y-4" aria-label="Refresh model research">
    <h3 className="font-semibold text-lg">Refresh model research with CoS</h3>
    <p className="text-sm text-port-text-muted leading-relaxed">Choose a browsing-capable provider and model. Running research uses that provider’s quota or API budget. The task checks current sources and configured model gaps; it never runs model benchmarks. New providers and local models are considered on the next research run.</p>
    <div className="flex flex-wrap gap-3 items-end">
      <label className="text-sm min-w-0 max-w-full" htmlFor="research-provider">Research provider<br /><select id="research-provider" className="bg-port-bg border border-port-border rounded-lg p-2.5 mt-2 max-w-full" value={draft.providerId} disabled={busy || !saved} onChange={e => setDraft({ providerId: e.target.value, model: '' })}><option value="">Choose provider</option>{providers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="text-sm min-w-0 max-w-full" htmlFor="research-model">Research model<br /><select id="research-model" className="bg-port-bg border border-port-border rounded-lg p-2.5 mt-2 max-w-full" value={draft.model} disabled={busy || !saved} onChange={e => setDraft(previous => ({ ...previous, model: e.target.value }))}><option value="">Choose model</option>{provider?.models?.map(model => <option key={model} value={model}>{model}</option>)}</select></label>
      <button className="px-4 py-2.5 text-sm rounded-lg border border-port-border disabled:opacity-50" onClick={save} disabled={busy || !valid || (!dirty && saved?.enabled)}>Save research settings</button>
      <button className="px-4 py-2.5 text-sm rounded-lg bg-port-accent text-port-on-accent disabled:opacity-50" onClick={run} disabled={busy || dirty || !valid || !saved?.enabled}>Run research now</button>
    </div>
    <p className="text-sm">Cadence: {saved?.type === 'cron' ? saved.cronExpression : 'On demand'}. <Link className="text-port-accent-text underline" to="/cos/schedule">Edit cadence, effort, prompt and view status in CoS Schedule</Link>.</p>
    {message && <p role="status">{message}</p>}{error && <p role="alert" className="text-port-error">{error}</p>}
  </section>;
}
