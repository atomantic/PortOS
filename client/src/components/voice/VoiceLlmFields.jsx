import { useId } from 'react';
import { RefreshCw } from 'lucide-react';
import { voiceModelDisplayName } from '../../../../server/lib/voiceModelCatalog.js';
import { withUnlistedOption } from '../../lib/withUnlistedOption';
import BrailleSpinner from '../BrailleSpinner';
import ProviderModelSelector from '../ProviderModelSelector';
import ConversationalGemmaNotice from '../settings/voice/ConversationalGemmaNotice';
import FastVoiceModelNotice from './FastVoiceModelNotice';
import LlamaRuntimeRow, { isManagedLlamaProvider } from './LlamaRuntimeRow';

export const VOICE_LLM_SELECT_CLS = 'min-h-10 pointer-coarse:min-h-11 w-full min-w-0 rounded-lg border border-port-border bg-port-bg px-2.5 py-1.5 font-mono text-xs text-port-text focus:border-port-accent focus:outline-none disabled:opacity-50';
const LABEL_CLS = 'block font-mono text-[10px] uppercase tracking-wider text-port-text-muted';

/**
 * Voice Brain provider + model picker, shared by the Settings Voice tab and the
 * Voice Call / sat-phone quick picker so both look and behave the same.
 *
 * Every change goes through one `onChange({ provider, model })`: switching
 * provider resets the model to `auto` (the old model may not exist there), and
 * the Conversational Gemma card and llama.cpp runtime row report through it too.
 * The saved provider/model always render, even when the registry no longer
 * lists them, so the select never silently drops the user's choice.
 */
export default function VoiceLlmFields({
  provider,
  model,
  apiProviders,
  refreshing = false,
  onRefreshModels,
  onChange,
  onSetupComplete,
  disabled = false,
  compact = false,
  providerLabel = 'Voice LLM provider',
  modelLabel = 'Voice LLM model',
}) {
  const modelSelectId = useId();
  const selectedProvider = apiProviders.find((p) => p.id === provider);
  const providerMissing = apiProviders.length > 0 && !selectedProvider;
  // An empty registry means "not loaded yet" (or the fetch failed), not
  // "confirmed not an API provider", so the synthetic option says which.
  const providerOptions = withUnlistedOption(
    apiProviders,
    provider,
    (id) => ({ id, name: apiProviders.length === 0 ? id : `${id} (not an API provider)` }),
  );
  const modelChoices = (selectedProvider?.models || []).map((m) => ({ id: m }));
  // 'auto' is its own hardcoded option, never a catalog id.
  const modelOptions = model === 'auto'
    ? modelChoices
    : withUnlistedOption(modelChoices, model, (id) => ({ id, current: true }));

  return (
    <div className="space-y-2.5 min-w-0">
      <div className={`grid grid-cols-1 gap-2 ${compact ? '' : 'sm:grid-cols-2'}`}>
        <div className="space-y-1 min-w-0">
          <span className={LABEL_CLS}>{providerLabel}</span>
          {/* Streaming needs a direct API route, so composing is restricted to `api`. */}
          <ProviderModelSelector
            compact
            label={providerLabel}
            providers={providerOptions}
            selectedProviderId={provider}
            disabled={disabled}
            composeMethods={['api']}
            onProviderChange={(id) => onChange({ provider: id, model: 'auto' })}
          />
        </div>

        <div className="space-y-1 min-w-0">
          <label htmlFor={modelSelectId} className={LABEL_CLS}>{modelLabel}</label>
          <div className="flex items-center gap-1.5 min-w-0">
            <select
              id={modelSelectId}
              value={model}
              disabled={disabled}
              onChange={(event) => onChange({ provider, model: event.target.value })}
              className={`${VOICE_LLM_SELECT_CLS} flex-1`}
            >
              <option value="auto">auto (provider default)</option>
              {modelOptions.map((opt) => (
                <option key={opt.id} value={opt.id}>{voiceModelDisplayName(opt.id)}{opt.current ? ' (current)' : ''}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => onRefreshModels?.(provider)}
              disabled={refreshing || disabled || providerMissing || apiProviders.length === 0}
              aria-label="Refresh voice LLM models"
              title="Refresh model list from the selected provider"
              className="inline-flex min-h-10 min-w-10 pointer-coarse:min-h-11 pointer-coarse:min-w-11 shrink-0 items-center justify-center rounded-lg border border-port-border bg-port-card px-2 text-port-text hover:border-port-accent disabled:opacity-45"
            >
              {refreshing ? <BrailleSpinner /> : <RefreshCw size={13} aria-hidden="true" />}
            </button>
          </div>
        </div>
      </div>

      {isManagedLlamaProvider(selectedProvider) && <LlamaRuntimeRow />}

      <FastVoiceModelNotice
        apiProviders={apiProviders}
        selectedProviderId={provider}
        selectedModelId={model}
        onChange={onChange}
        onRefreshModels={onRefreshModels}
      />

      <ConversationalGemmaNotice
        compact={compact}
        apiProviders={apiProviders}
        selectedProviderId={provider}
        selectedModelId={model}
        onSelectModel={(modelId) => onChange({ provider, model: modelId })}
        onSwitchProviderAndModel={(providerId, modelId) => onChange({ provider: providerId, model: modelId })}
        onSetupComplete={onSetupComplete}
      />
    </div>
  );
}
