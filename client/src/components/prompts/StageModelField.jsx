// A stage's model choice: a tier (resolved per install) or a specific
// provider + model. Shared by the stage editor and the create-stage form.
import ProviderModelSelector from '../ProviderModelSelector';
import { filterSelectableModels } from '../../utils/providers';
import { STAGE_MODEL_TIER_OPTIONS, canonicalStageModelTier } from '../../lib/stageModelTiers';

const modelsFor = (providers, providerId) => {
  const p = providers.find((pr) => pr.id === providerId);
  return p ? filterSelectableModels(p.models || [p.defaultModel]) : [];
};

/**
 * @param {{ provider?: string|null, model?: string }} props.value
 * @param {(patch: { provider?: string|null, model: string }) => void} props.onChange
 *   Receives only the fields that changed, to merge; `provider: null` is tier mode.
 * @param {import('react').ReactNode} [props.notice]  Shown between the mode toggle and the picker.
 */
export default function StageModelField({ value, onChange, providers, disabled = false, notice = null }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm text-gray-400">Model</span>
        <div className="flex gap-1">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange({ provider: null, model: 'default' })}
            className={`px-2 py-1 text-xs rounded transition-colors ${!value.provider ? 'bg-port-accent text-white' : 'bg-port-border text-gray-400 hover:text-white'}`}
          >
            Tier
          </button>
          <button
            type="button"
            onClick={() => {
              if (value.provider) return;
              const first = providers[0];
              onChange({ provider: first?.id || '', model: first?.defaultModel || '' });
            }}
            disabled={disabled || providers.length === 0}
            className={`px-2 py-1 text-xs rounded transition-colors ${value.provider ? 'bg-port-accent text-white' : 'bg-port-border text-gray-400 hover:text-white'} disabled:opacity-50`}
          >
            Specific
          </button>
        </div>
      </div>
      {notice}
      {!value.provider ? (
        <select
          disabled={disabled}
          aria-label="Model tier"
          value={canonicalStageModelTier(value.model) || 'default'}
          onChange={(e) => onChange({ model: e.target.value })}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
        >
          {STAGE_MODEL_TIER_OPTIONS.map(({ value: tier, label }) => (
            <option key={tier} value={tier}>{label}</option>
          ))}
        </select>
      ) : (
        <ProviderModelSelector
          disabled={disabled}
          providers={providers}
          selectedProviderId={value.provider}
          selectedModel={value.model}
          availableModels={modelsFor(providers, value.provider)}
          onProviderChange={(id) => {
            const p = providers.find((pr) => pr.id === id);
            onChange({ provider: id, model: p?.defaultModel || '' });
          }}
          onModelChange={(model) => onChange({ model })}
        />
      )}
    </div>
  );
}
