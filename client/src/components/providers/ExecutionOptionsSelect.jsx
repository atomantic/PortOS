import { useEffect, useId, useState } from 'react';
import { request } from '../../services/apiCore.js';

/** Capability-driven controls; unsupported saved pins remain clearable. */
export default function ExecutionOptionsSelect({ provider, model, value, onChange, disabled, className }) {
  const id = useId();
  const [snapshot, setSnapshot] = useState(null);
  const providerId = provider?.id;
  useEffect(() => {
    let active = true;
    if (providerId) {
      request(`/providers/${encodeURIComponent(providerId)}/execution-options?model=${encodeURIComponent(model || '')}`, { silent: true })
        .then((data) => { if (active) setSnapshot({ providerId, model, data }); })
        .catch(() => { if (active) setSnapshot({ providerId, model, data: { options: [], reason: 'Execution capabilities could not be verified.' } }); });
    }
    return () => { active = false; };
  }, [providerId, model]);
  const capabilities = snapshot?.providerId === providerId && snapshot?.model === model ? snapshot.data : null;
  const descriptors = capabilities?.options || [];
  const keys = [...new Set([...descriptors.map((option) => option.key), ...Object.keys(value || {})])];
  if (!keys.length) return null;
  return keys.map((key) => {
    const descriptor = descriptors.find((option) => option.key === key);
    const saved = value?.[key];
    const unsupported = saved !== undefined && !descriptor?.values.includes(saved);
    const change = (next) => {
      const options = { ...value };
      if (next) options[key] = next;
      else delete options[key];
      onChange(options);
    };
    return <div key={key}>
      <label htmlFor={`${id}-${key}`} className="block text-xs text-gray-500 mb-1">{descriptor?.label || (key === 'serviceTier' ? 'Speed' : key)}</label>
      <select id={`${id}-${key}`} value={saved || ''} disabled={disabled} className={className}
        onChange={(event) => change(event.target.value)}>
        <option value="">Inherit / default</option>
        {unsupported && <option value={saved} disabled>{saved} (unsupported)</option>}
        {descriptor?.values.map((setting) => <option key={setting} value={setting}>{setting.charAt(0).toUpperCase() + setting.slice(1)}</option>)}
      </select>
      <p className="text-xs text-gray-500 mt-1">{unsupported ? capabilities?.reason || 'This saved option is unsupported for the selected route and model.' : descriptor?.help}</p>
    </div>;
  });
}
