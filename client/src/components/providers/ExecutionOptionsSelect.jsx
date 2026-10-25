import { useEffect, useId, useState } from 'react';
import { request } from '../../services/apiCore.js';

/** Capability-driven controls; unsupported saved pins remain clearable. */
export default function ExecutionOptionsSelect({ provider, model, value, onChange, disabled, className, fieldClassName }) {
  const id = useId();
  const [snapshot, setSnapshot] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const providerId = provider?.id;
  const shouldInspect = provider?.executionOptionKeys?.length > 0
    || Object.keys(value || {}).length > 0 || Object.keys(provider?.executionOptions || {}).length > 0;
  const routeKey = JSON.stringify([providerId, provider?.type, provider?.command, provider?.args, provider?.codexAuthMode, provider?.ignoreUserConfig, provider?.enabled, provider?.gatewayBacked, provider?.credentialBootstrapId]);
  useEffect(() => {
    let active = true;
    if (providerId && shouldInspect) {
      request(`/providers/${encodeURIComponent(providerId)}/execution-options?model=${encodeURIComponent(model || '')}${refresh ? '&refresh=true' : ''}`, { silent: true })
        .then((data) => { if (active) setSnapshot({ providerId, model, routeKey, data }); })
        .catch(() => { if (active) setSnapshot({ providerId, model, routeKey, data: { options: [], reason: 'Execution capabilities could not be verified.' } }); });
    }
    return () => { active = false; };
  }, [providerId, model, routeKey, refresh, shouldInspect]);
  const capabilities = snapshot?.providerId === providerId && snapshot?.model === model && snapshot?.routeKey === routeKey ? snapshot.data : null;
  const descriptors = capabilities?.options || [];
  const keys = [...new Set([...descriptors.map((option) => option.key), ...Object.keys(value || {}), ...Object.keys(provider?.executionOptions || {})])];
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
    return <div key={key} className={fieldClassName}>
      <label htmlFor={`${id}-${key}`} className="block text-xs text-gray-500 mb-1">{descriptor?.label || (key === 'serviceTier' ? 'Speed' : key)}</label>
      <select id={`${id}-${key}`} value={saved || ''} disabled={disabled} className={className}
        onChange={(event) => change(event.target.value)}>
        <option value="">Inherit / default{provider?.executionOptions?.[key] ? ` (${provider.executionOptions[key]})` : ''}</option>
        {unsupported && <option value={saved} disabled>{saved} (unsupported)</option>}
        {descriptor?.values.map((setting) => <option key={setting} value={setting}>{setting.charAt(0).toUpperCase() + setting.slice(1)}</option>)}
      </select>
      <button type="button" className="text-xs text-port-accent mt-1" disabled={disabled} onClick={() => setRefresh((current) => current + 1)}>Refresh capabilities</button>
      <p className="text-xs text-gray-500 mt-1">{unsupported || !descriptor?.values.length ? capabilities?.reason || 'This saved option is unsupported or unverified for the selected route and model.' : descriptor?.help}</p>
    </div>;
  });
}
