import { useEffect, useId, useState } from 'react';
import * as api from '../../services/api';

export default function PersistentMindMaintainerControls() {
  const id = useId();
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    api.getPersistentMindMaintainer({ silent: true }).then(next => {
      if (active) { setData(next); setDraft(next.role); }
    }).catch(err => { if (active) setError(err?.message || 'Could not load maintainer settings'); });
    return () => { active = false; };
  }, []);
  const change = patch => { setDraft(current => ({ ...current, ...patch })); setSaved(false); };
  const dirty = draft && JSON.stringify(draft) !== JSON.stringify(data?.role);
  const save = async event => {
    event.preventDefault();
    if (saving || !dirty) return;
    setSaving(true); setError(null); setSaved(false);
    await api.updateCosConfig({ persistentMindMaintainer: draft }, { silent: true }).then(async config => {
      const role = config.persistentMindMaintainer;
      setDraft(role);
      setData(current => ({ ...current, role }));
      setSaved(true);
      await api.getPersistentMindMaintainer({ silent: true }).then(next => setData(next));
    }).catch(err => setError(err?.message || 'Could not save maintainer settings')).finally(() => setSaving(false));
  };
  const apps = [...(data?.availableApps || [])];
  for (const app of data?.apps || []) if (!apps.some(candidate => candidate.id === app.id)) apps.push(app);
  return (
    <section className="rounded border border-port-border bg-port-card p-4" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`} className="text-sm font-semibold text-port-text">Development maintainer</h3>
      <p className="mt-1 text-xs text-port-text-muted">Curate development and maintenance for selected repositories on this instance. Permissions and inference settings are configured separately.</p>
      {error && <p role="alert" className="mt-2 text-xs text-port-error">{error}</p>}
      {!draft ? <p className="mt-2 text-xs text-port-text-muted">{error ? 'Settings unavailable.' : 'Loading maintainer settings…'}</p> : <form onSubmit={save} className="mt-3 space-y-3">
        <fieldset disabled={saving} className="space-y-3 disabled:opacity-60">
          <div className="flex items-center gap-2">
            <input id={`${id}-enabled`} type="checkbox" checked={draft.enabled} onChange={event => change({ enabled: event.target.checked })} />
            <label htmlFor={`${id}-enabled`} className="text-sm text-port-text">Enable maintainer role on this instance</label>
          </div>
          <fieldset className="space-y-2">
            <legend className="mb-2 text-xs font-medium text-port-text">Repository scope</legend>
            {apps.length === 0 && <p className="text-xs text-port-text-muted">No managed repositories are available. Add an app and configure its repository first.</p>}
            {apps.map(app => <div key={app.id} className="flex items-start gap-2">
              <input id={`${id}-app-${app.id}`} type="checkbox" checked={draft.appIds.includes(app.id)} onChange={event => change({ appIds: event.target.checked ? [...draft.appIds, app.id] : draft.appIds.filter(value => value !== app.id) })} />
              <label htmlFor={`${id}-app-${app.id}`} className="min-w-0 break-words text-xs text-port-text">{app.name}{app.repository ? ` · ${app.repository}` : ''}<span className="text-port-text-muted">{!app.available ? ' · Repository unavailable' : !app.granted ? ' · Permission required' : ''}</span></label>
            </div>)}
          </fieldset>
          <div className="max-w-xs">
            <label htmlFor={`${id}-cadence`} className="text-xs font-medium text-port-text">Check interval (minutes)</label>
            <input id={`${id}-cadence`} type="number" min="5" max="10080" step="1" required value={draft.intervalMinutes} onChange={event => change({ intervalMinutes: event.target.value === '' ? '' : Number(event.target.value) })} className="mt-1 block w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-port-text" />
          </div>
        </fieldset>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={saving || !dirty || !Number.isInteger(draft.intervalMinutes) || draft.intervalMinutes < 5 || draft.intervalMinutes > 10080} className="rounded bg-port-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save maintainer settings'}</button>
          {saved && <p role="status" className="text-xs text-port-success">Maintainer settings saved.</p>}
        </div>
        <div className="text-xs text-port-text-muted">
          <p>Saved role: {data.role.enabled ? 'Enabled' : 'Disabled'}. Prerequisites below reflect saved settings.</p>
          {(data.prerequisites || []).length > 0 ? <ul className="mt-2 list-disc space-y-1 pl-5">{data.prerequisites.map(item => <li key={item}>{item}</li>)}</ul> : <p className="mt-2">Configuration prerequisites are satisfied. This does not verify operational health.</p>}
        </div>
        {data.schedule?.requiresWatchdog && <p className="text-xs text-port-text-muted">The programmatic watchdog must be available before scheduled checks can run.</p>}
        <details className="rounded border border-port-border p-3">
          <summary className="cursor-pointer text-xs font-medium text-port-text">Maintainer charter preview (saved scope)</summary>
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs text-port-text-muted">{data.instructions || 'Charter unavailable.'}</pre>
        </details>
      </form>}
    </section>
  );
}
