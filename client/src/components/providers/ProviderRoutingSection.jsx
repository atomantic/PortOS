import { useState } from 'react';
import { FormField } from '../ui/FormField';

const inputClass = 'w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden';

const ROUTING_KEYS = ['routingSort', 'routingDataCollection', 'routingRequireParameters', 'routingOnly', 'routingIgnore', 'routingOrder', 'routingModelsText'];

const LIST_FIELDS = [
  ['routingOnly', 'Only providers', 'anthropic, openai'],
  ['routingIgnore', 'Ignore providers', 'together'],
  ['routingOrder', 'Provider order', 'anthropic, google-vertex'],
];

/** OpenRouter `provider` routing preferences; rendered only for an OpenRouter endpoint. */
export default function ProviderRoutingSection({ formData, setFormData }) {
  // Initial state only: a controlled `open` would collapse the panel the moment the last watched field is cleared.
  const [initiallyOpen] = useState(() => ROUTING_KEYS.some((key) => Boolean(formData[key])));
  const set = (patch) => setFormData((prev) => ({ ...prev, ...patch }));
  return (
    <details className="border-t border-port-border pt-4 mt-4" open={initiallyOpen}>
      <summary className="text-sm font-medium text-gray-300 cursor-pointer">OpenRouter Routing</summary>
      <p className="text-xs text-gray-500 my-3">
        Sent as OpenRouter's <code className="text-gray-400">provider</code> object on every request to this endpoint.
        Choose <code className="text-gray-400">Deny</code> for data collection to keep prompts away from upstream hosts that train on them.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <FormField label="Sort by">
          <select value={formData.routingSort} onChange={(e) => set({ routingSort: e.target.value })} className={inputClass}>
            <option value="">OpenRouter default</option>
            <option value="price">Price</option>
            <option value="throughput">Throughput</option>
            <option value="latency">Latency</option>
          </select>
        </FormField>
        <FormField label="Data collection">
          <select value={formData.routingDataCollection} onChange={(e) => set({ routingDataCollection: e.target.value })} className={inputClass}>
            <option value="">OpenRouter default</option>
            <option value="deny">Deny (recommended)</option>
            <option value="allow">Allow</option>
          </select>
        </FormField>
        {LIST_FIELDS.map(([key, label, placeholder]) => (
          <FormField key={key} label={label}>
            <input type="text" value={formData[key]} onChange={(e) => set({ [key]: e.target.value })} placeholder={placeholder} className={inputClass} />
          </FormField>
        ))}
        <label className="flex items-center gap-2 text-sm text-gray-300 sm:col-span-2">
          <input type="checkbox" checked={formData.routingRequireParameters} onChange={(e) => set({ routingRequireParameters: e.target.checked })} />
          Require parameters (never route to a host that would silently drop one)
        </label>
        <FormField label="Per-model overrides (JSON)" className="sm:col-span-2">
          <textarea
            rows={4}
            value={formData.routingModelsText}
            onChange={(e) => set({ routingModelsText: e.target.value })}
            placeholder={'{ "anthropic/claude-sonnet-4": { "only": ["anthropic"] } }'}
            spellCheck={false}
            className={`${inputClass} font-mono text-sm`}
          />
          <p className="text-xs text-gray-500 mt-1">Keys set here replace the defaults above for that model only. Clear everything to remove routing.</p>
        </FormField>
      </div>
    </details>
  );
}
