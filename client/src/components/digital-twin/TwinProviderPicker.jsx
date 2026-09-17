/**
 * The digital-twin surfaces' provider + model picker over the shared
 * preset-first `ProviderModelSelector` (#7566), for callers that hold a single
 * `{ providerId, model }` selection (`null` until seeded).
 *
 * Six twin surfaces used to render one bespoke `<select>` listing every
 * `provider:model` pair; this keeps their state shape and swaps the markup
 * for the shared selector, so they gain the harness-grouped preset list and
 * the "Custom combination…" compose flow without each carrying a copy.
 *
 * @param {object} props
 * @param {object[]} props.providers - The provider records to offer.
 * @param {{providerId: string, model: string}|null} props.selected
 * @param {function} props.onChange - `({ providerId, model }) => void`. A
 *   provider change seeds the provider's `defaultModel` (else its first listed
 *   model), matching how these surfaces seed their initial selection.
 * @param {string} [props.label] - Accessible name of the provider select.
 * @param {boolean} [props.compact] - Inline/toolbar mode (label as `aria-label`).
 * @param {boolean} [props.disabled]
 * @param {string} [props.className]
 */
import ProviderModelSelector from '../ProviderModelSelector.jsx';
import { providerModelList } from '../../utils/providers.js';

const modelsFor = (provider) => (provider ? providerModelList(provider).filter(Boolean) : []);

export default function TwinProviderPicker({
  providers,
  selected,
  onChange,
  label = 'AI provider',
  compact = false,
  disabled = false,
  className,
}) {
  const list = Array.isArray(providers) ? providers : [];
  const current = list.find((p) => p.id === selected?.providerId);
  return (
    <div className={className}>
      <ProviderModelSelector
        providers={list}
        selectedProviderId={selected?.providerId || ''}
        selectedModel={selected?.model || ''}
        availableModels={modelsFor(current)}
        label={label}
        compact={compact}
        disabled={disabled}
        onProviderChange={(providerId) => {
          const next = list.find((p) => p.id === providerId);
          onChange({ providerId, model: next?.defaultModel || modelsFor(next)[0] || '' });
        }}
        onModelChange={(model) => onChange({ providerId: selected?.providerId || '', model })}
      />
    </div>
  );
}
