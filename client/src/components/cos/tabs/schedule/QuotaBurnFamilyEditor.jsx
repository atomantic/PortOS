import { useState } from 'react';

const FAMILIES = ['claude', 'codex', 'agy', 'grok'];
const defaults = { enabled: false, prompt: '', providerId: null, model: null, scope: null, resetWithinHours: 24, reservePercent: 0, maxDispatchesPerWindow: 5, priority: 0 };

export default function QuotaBurnFamilyEditor({ metadata, onSave, disabled }) {
  const [expanded, setExpanded] = useState(null);
  const families = metadata?.families || {};
  const saveFamily = (id, patch) => {
    const next = { ...defaults, ...(families[id] || {}), ...patch };
    onSave({ ...(metadata || {}), families: { ...families, [id]: next } });
  };

  return (
    <div className="w-full mt-2 rounded border border-port-border bg-port-card/30 p-3 space-y-2">
      <p className="text-xs text-gray-300">Quota-burn families run only near reset, stay disabled until configured, and never dispatch on an unknown reset time.</p>
      {FAMILIES.map((id) => {
        const family = { ...defaults, ...(families[id] || {}) };
        const open = expanded === id;
        return (
          <div key={id} className="rounded border border-port-border/70 p-2">
            <div className="flex items-center gap-2">
              <input id={`quota-burn-${id}`} type="checkbox" checked={family.enabled} disabled={disabled} onChange={(event) => saveFamily(id, { enabled: event.target.checked })} />
              <label htmlFor={`quota-burn-${id}`} className="text-sm capitalize text-white flex-1">{id}</label>
              <button type="button" className="text-xs text-port-accent hover:underline" onClick={() => setExpanded(open ? null : id)}>{open ? 'Hide settings' : 'Configure'}</button>
            </div>
            {open && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3 text-xs">
                <label className="text-gray-400">Reset window (hours)<input className="w-full mt-1 bg-port-bg border border-port-border rounded p-2 text-white" type="number" min="0" value={family.resetWithinHours} disabled={disabled} onChange={(event) => saveFamily(id, { resetWithinHours: Number(event.target.value) })} /></label>
                <label className="text-gray-400">Reserve (%)<input className="w-full mt-1 bg-port-bg border border-port-border rounded p-2 text-white" type="number" min="0" max="100" value={family.reservePercent} disabled={disabled} onChange={(event) => saveFamily(id, { reservePercent: Number(event.target.value) })} /></label>
                <label className="text-gray-400">Dispatch cap<input className="w-full mt-1 bg-port-bg border border-port-border rounded p-2 text-white" type="number" min="1" value={family.maxDispatchesPerWindow} disabled={disabled} onChange={(event) => saveFamily(id, { maxDispatchesPerWindow: Number(event.target.value) })} /></label>
                <label className="text-gray-400">Provider ID (optional)<input className="w-full mt-1 bg-port-bg border border-port-border rounded p-2 text-white" value={family.providerId || ''} disabled={disabled} onChange={(event) => saveFamily(id, { providerId: event.target.value || null })} /></label>
                <label className="sm:col-span-2 text-gray-400">Work prompt<textarea className="w-full mt-1 bg-port-bg border border-port-border rounded p-2 text-white min-h-20" value={family.prompt} disabled={disabled} onChange={(event) => saveFamily(id, { prompt: event.target.value })} /></label>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
