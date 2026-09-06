import { useEffect, useId, useState } from 'react';
import * as api from '../../services/api';
import { formatMindRoute } from '../../lib/mindThinkingPresets.js';

export default function PersistentMindThinkingRequests({ catalog, capabilities, onSaved, onCancelled }) {
  const id = useId();
  const [enabled, setEnabled] = useState(false);
  const [ids, setIds] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const savedEnabled = capabilities?.chooseThinkingPreset === true;
  const savedIds = JSON.stringify(capabilities?.thinkingPresetAllowlist || []);
  useEffect(() => {
    setEnabled(savedEnabled);
    setIds(JSON.parse(savedIds));
  }, [savedEnabled, savedIds]);
  const act = (operation) => {
    setSaving(true);
    setError(null);
    operation().catch((failure) => setError(failure.message || 'Could not save local thinking access')).finally(() => setSaving(false));
  };
  return <section className="rounded border border-port-border bg-port-card p-4 space-y-3" aria-labelledby={`${id}-heading`}>
    <h3 id={`${id}-heading`} className="font-semibold text-port-text">Self-directed local thinking</h3>
    <p className="text-sm text-port-text-muted">Allow one approved local API preset on the next self-directed wake. At most three requests per rolling 24 hours, 30 minutes apart. Failure or cancellation still counts. Your default model and task-agent permissions stay unchanged.</p>
    {catalog?.default && <p className="text-sm text-port-text-muted">Default: {formatMindRoute(catalog.default)}. Current: {catalog.current?.model ? formatMindRoute(catalog.current) : 'Idle'}.</p>}
    <label htmlFor={`${id}-enabled`} className="flex gap-2 text-sm text-port-text">
      <input id={`${id}-enabled`} type="checkbox" checked={enabled} disabled={saving || !catalog} onChange={(event) => setEnabled(event.target.checked)} /> Allow preset requests
    </label>
    <fieldset disabled={saving || !catalog} className="space-y-2">
      <legend className="text-sm text-port-text-muted">Eligible local presets</legend>
      {(catalog?.presets || []).map((preset) => <label key={preset.id} htmlFor={`${id}-${preset.id}`} className="flex gap-2 text-sm text-port-text">
        <input id={`${id}-${preset.id}`} type="checkbox" checked={ids.includes(preset.id)} onChange={(event) => setIds((current) => event.target.checked ? [...current, preset.id] : current.filter((value) => value !== preset.id))} />
        {preset.label} — {formatMindRoute(preset)}
      </label>)}
      {!catalog?.presets?.length && <p className="text-sm text-port-text-muted">No eligible presets. Save a preset using a configured local API runtime first. Account-backed and unknown routes are unavailable.</p>}
    </fieldset>
    <button type="button" disabled={saving || !catalog} className="min-h-10 rounded bg-port-accent px-3 text-white disabled:opacity-50" onClick={() => act(async () => {
      const result = await api.updateCosConfig({ persistentMindCapabilities: { chooseThinkingPreset: enabled, thinkingPresetAllowlist: ids } }, { silent: true });
      onSaved(result.persistentMindCapabilities);
      if (!enabled) onCancelled();
    })}>{saving ? 'Saving…' : 'Save local thinking access'}</button>
    {catalog?.pending && <div className="text-sm text-port-text">
      <p>Pending: {catalog.pending.label} — {catalog.pending.reason}</p>
      <button type="button" disabled={saving} className="min-h-10 rounded border border-port-border px-3" onClick={() => act(async () => {
        await api.cancelPersistentMindThinkingRequest({ silent: true });
        onCancelled();
      })}>Cancel pending request</button>
    </div>}
    {catalog?.recent?.length > 0 && <details><summary className="text-sm text-port-text">Recent requests</summary><ul className="text-sm text-port-text-muted space-y-2">{catalog.recent.slice().reverse().map((request) => <li key={request.requestId}>{request.label}: {request.reason} — {request.outcome}</li>)}</ul></details>}
    {error && <p role="alert" className="text-sm text-port-error">{error}</p>}
  </section>;
}
