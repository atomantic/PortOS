import ProviderModelSelector from '../ProviderModelSelector';
import { filterSelectableModels } from '../../utils/providers';
import { providerPinPatch } from './constants';

/**
 * The ONE control for an app's per-app provider/model pin on a scheduled task
 * type (`taskTypeOverrides[<taskType>].providerId` / `.model`).
 *
 * The same field used to be edited from three places with three different
 * clear-normalizations (`model: ''`, `model: null`, `'' → null`) and three
 * different "picking a provider clears the model" rules — or no rule at all.
 * Both rules live here now (#4783), so every surface produces one stored result:
 *
 *   - `''` / absent → `null`, the "inherit" sentinel the route deletes the key for.
 *   - Choosing a provider CLEARS the pinned model, so a model from the previous
 *     provider can't leak into a provider that has never heard of it.
 *
 * Fully controlled: it renders `providerId`/`model` and hands the caller a
 * complete normalized `{ providerId, model }` patch. The caller decides whether
 * that patch is PUT immediately (Automation / Schedule rows) or staged in a form
 * (the Intelligence tab's drawer save).
 *
 * @param {Array}    props.providers      Selectable providers (already type/enabled filtered).
 * @param {string}   [props.providerId]   Currently pinned provider id ('' / null = inherit).
 * @param {string}   [props.model]        Currently pinned model ('' / null = provider default).
 * @param {function} props.onChange       Called with `{ providerId, model }`, both normalized.
 * @param {string}   props.label          Provider-select label (also its aria-label when compact).
 * @param {string}   [props.inheritLabel] What a blank pin resolves to, e.g. `Inherit (claude-code)`.
 * @param {boolean}  [props.disabled]
 * @param {boolean}  [props.compact]      Hide labels for inline/table use.
 * @param {'row'|'stacked'} [props.layout]
 */
export default function AppProviderPin({
  providers,
  providerId,
  model,
  onChange,
  label,
  inheritLabel = 'Use default provider',
  disabled = false,
  compact = false,
  layout = 'row'
}) {
  const selectedProviderId = providerId || '';
  const selectedModel = model || '';
  const selectedProvider = providers?.find(p => p.id === selectedProviderId);
  const availableModels = selectedProvider
    ? filterSelectableModels(selectedProvider.models || [selectedProvider.defaultModel])
    : [];
  // Keep a pinned model visible even when it isn't in the provider's fetched list
  // (a stale or hand-typed model must not render as a blanked select).
  const modelOptions = selectedModel && !availableModels.includes(selectedModel)
    ? [selectedModel, ...availableModels]
    : availableModels;

  return (
    <ProviderModelSelector
      providers={providers || []}
      selectedProviderId={selectedProviderId}
      selectedModel={selectedModel}
      availableModels={modelOptions}
      // Switching providers drops the model pin — see the header note.
      onProviderChange={id => onChange(providerPinPatch(id, ''))}
      onModelChange={next => onChange(providerPinPatch(selectedProviderId, next))}
      label={label}
      emptyProviderOption={inheritLabel}
      emptyModelOption="Default model"
      alwaysShowModel
      disabled={disabled}
      compact={compact}
      layout={layout}
    />
  );
}
