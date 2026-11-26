import { useEffect, useId, useState } from 'react';
import { request } from '../../services/apiCore.js';

const CAPABILITY_TTL_MS = 10_000;
const capabilityReads = new Map();
const capabilityListeners = new Map();

function readCapabilities(key, providerId, model, refresh = false) {
  const now = Date.now();
  const cached = capabilityReads.get(key);
  if (!refresh && cached && cached.expires > now) return cached.promise;

  for (const [cachedKey, entry] of capabilityReads) {
    if (entry.expires <= now) capabilityReads.delete(cachedKey);
  }

  const promise = request(`/providers/${encodeURIComponent(providerId)}/execution-options?model=${encodeURIComponent(model || '')}${refresh ? '&refresh=true' : ''}`, { silent: true });
  const entry = { expires: Infinity, promise: promise.then(
    (data) => {
      entry.expires = Date.now() + CAPABILITY_TTL_MS;
      return data;
    },
    () => {
      if (capabilityReads.get(key) === entry) capabilityReads.delete(key);
      return { options: [], reason: 'Execution capabilities could not be verified.' };
    },
  ) };
  capabilityReads.set(key, entry);
  capabilityListeners.get(key)?.forEach((listener) => listener(entry.promise));
  return entry.promise;
}

/** Capability-driven controls; unsupported saved pins remain clearable. */
export default function ExecutionOptionsSelect({ provider, model, value, onChange, disabled, className, fieldClassName, inspectionBlockedReason }) {
  const id = useId();
  const [snapshot, setSnapshot] = useState(null);
  const providerId = provider?.id;
  const shouldInspect = provider?.executionOptionKeys?.length > 0
    || Object.keys(value || {}).length > 0 || Object.keys(provider?.executionOptions || {}).length > 0;
  const routeKey = JSON.stringify([providerId, provider?.type, provider?.command, provider?.args, provider?.codexAuthMode, provider?.ignoreUserConfig, provider?.enabled, provider?.gatewayBacked, provider?.credentialBootstrapId]);
  const requestKey = JSON.stringify([model || '', routeKey]);
  const canInspect = Boolean(providerId && shouldInspect && !inspectionBlockedReason);
  useEffect(() => {
    if (!canInspect) return;
    const listeners = capabilityListeners.get(requestKey) ?? new Set();
    capabilityListeners.set(requestKey, listeners);
    let active = true;
    // A refresh can finish before the read it superseded.
    let latestRead;
    const update = (promise) => {
      latestRead = promise;
      return promise.then((data) => {
        if (active && latestRead === promise) setSnapshot({ key: requestKey, data });
      });
    };
    const promise = readCapabilities(requestKey, providerId, model);
    listeners.add(update);
    update(promise);
    return () => {
      active = false;
      listeners.delete(update);
      if (!listeners.size) capabilityListeners.delete(requestKey);
    };
  }, [canInspect, requestKey, providerId, model]);
  const capabilities = inspectionBlockedReason ? { options: [], reason: inspectionBlockedReason }
    : canInspect && snapshot?.key === requestKey ? snapshot.data : null;
  const descriptors = capabilities?.options || [];
  const keys = [...new Set([...(provider?.executionOptionKeys || []), ...descriptors.map((option) => option.key), ...Object.keys(value || {}), ...Object.keys(provider?.executionOptions || {})])];
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
      <button type="button" className="text-xs text-port-accent mt-1" disabled={disabled || !canInspect} onClick={() => { readCapabilities(requestKey, providerId, model, true); }}>Refresh capabilities</button>
      {(unsupported || !descriptor?.values.length) && <p className="text-xs text-gray-500 mt-1">{capabilities?.reason || 'This saved option is unsupported or unverified for the selected route and model.'}</p>}
    </div>;
  });
}
