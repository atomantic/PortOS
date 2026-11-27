import { useCallback, useEffect, useId, useState } from 'react';
import { Brain, RefreshCw } from 'lucide-react';
import { CONVERSATIONAL_GEMMA, isConversationalGemma } from '../../../../server/lib/voiceModelCatalog.js';
import { getProviders, refreshProviderModels } from '../../services/apiProviders';
import { updateVoiceConfig } from '../../services/apiVoice';
import { withUnlistedOption } from '../../lib/withUnlistedOption';
import useMounted from '../../hooks/useMounted';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import ProviderModelSelector from '../ProviderModelSelector';
import ConversationalGemmaNotice from '../settings/voice/ConversationalGemmaNotice';

/**
 * Inline Voice Brain / LLM provider & model picker for the Voice Call station
 * and floating sat-phone setup tray. Saves changes immediately to voice config.
 */
export default function VoiceLlmQuickPicker({
  provider = 'lmstudio',
  model = 'auto',
  onSaved,
  compact = false,
}) {
  const mountedRef = useMounted();
  const modelSelectId = useId();
  const [apiProviders, setApiProviders] = useState([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadProviders = useCallback(() => {
    setLoadFailed(false);
    return getProviders({ silent: true })
      .then((data) => {
        if (!mountedRef.current) return;
        const list = Array.isArray(data?.providers) ? data.providers : [];
        setApiProviders(list.filter((p) => p.type === 'api'));
      })
      .catch(() => {
        if (!mountedRef.current) return;
        setLoadFailed(true);
      });
  }, [mountedRef]);

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  const saveLlm = async (nextProvider, nextModel) => {
    if (saving) return;
    setSaving(true);
    try {
      await updateVoiceConfig({ llm: { provider: nextProvider, model: nextModel } }, { silent: true });
      if (!mountedRef.current) return;
      onSaved?.({ provider: nextProvider, model: nextModel });
      const label = nextModel === 'auto'
        ? `${nextProvider} (auto)`
        : (isConversationalGemma(nextModel) ? CONVERSATIONAL_GEMMA.name : nextModel);
      toast.success(`Voice LLM set to ${label}`);
    } catch (err) {
      if (mountedRef.current) toast.error(`Could not update Voice LLM: ${err.message}`);
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const handleRefreshModels = async () => {
    if (!provider || refreshing) return;
    setRefreshing(true);
    try {
      const updated = await refreshProviderModels(provider, { silent: true });
      if (!mountedRef.current) return;
      setApiProviders((prev) => prev.map((p) => (p.id === provider ? { ...p, models: updated.models || [] } : p)));
      toast.success(`Refreshed models for ${updated.name || provider} (${updated.models?.length || 0})`);
    } catch (err) {
      if (mountedRef.current) toast.error(`Failed to refresh models: ${err.message}`);
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  };

  const selectedProvider = apiProviders.find((p) => p.id === provider);
  const providerMissing = apiProviders.length > 0 && !selectedProvider;
  const providerOptions = withUnlistedOption(
    apiProviders,
    provider,
    (id) => ({ id, name: apiProviders.length === 0 ? id : `${id} (not an API provider)` }),
  );
  const modelChoices = (selectedProvider?.models || []).map((m) => ({ id: m }));
  const modelOptions = model === 'auto'
    ? modelChoices
    : withUnlistedOption(modelChoices, model, (id) => ({ id, current: true }));

  const selectCls = 'min-h-10 pointer-coarse:min-h-11 w-full min-w-0 rounded-lg border border-port-border bg-port-bg px-2.5 py-1.5 font-mono text-xs text-port-text focus:border-port-accent focus:outline-none disabled:opacity-50';

  return (
    <section
      aria-label="Voice LLM selection"
      className={`space-y-2.5 rounded-xl border border-port-border bg-port-card text-port-text ${compact ? 'p-3' : 'p-4'}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Brain size={14} aria-hidden="true" className="shrink-0 text-port-accent" />
          <h3 className="font-mono text-xs font-semibold uppercase tracking-wider">Voice brain (LLM)</h3>
        </div>
        {saving && <span className="font-mono text-[10px] uppercase tracking-wider text-port-accent-text">Saving…</span>}
        {loadFailed && (
          <button
            type="button"
            onClick={loadProviders}
            className="min-h-9 pointer-coarse:min-h-11 rounded border border-port-border px-2 text-xs text-port-accent-text hover:border-port-accent"
          >
            Retry providers
          </button>
        )}
      </div>

      <div className={`grid grid-cols-1 gap-2 ${compact ? '' : 'sm:grid-cols-2'}`}>
        <div className="space-y-1 min-w-0">
          <span className="block font-mono text-[10px] uppercase tracking-wider text-port-text-muted">
            Voice LLM provider
          </span>
          <ProviderModelSelector
            compact
            label="Voice LLM provider"
            providers={providerOptions}
            selectedProviderId={provider}
            disabled={saving}
            composeMethods={['api']}
            onProviderChange={(id) => saveLlm(id, 'auto')}
          />
        </div>

        <div className="space-y-1 min-w-0">
          <label htmlFor={modelSelectId} className="block font-mono text-[10px] uppercase tracking-wider text-port-text-muted">
            Voice LLM model
          </label>
          <div className="flex items-center gap-1.5 min-w-0">
            <select
              id={modelSelectId}
              value={model}
              disabled={saving}
              onChange={(event) => saveLlm(provider, event.target.value)}
              className={`${selectCls} flex-1`}
            >
              <option value="auto">auto (provider default)</option>
              {modelOptions.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {isConversationalGemma(opt.id) ? CONVERSATIONAL_GEMMA.name : opt.id}{opt.current ? ' (current)' : ''}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleRefreshModels}
              disabled={refreshing || saving || providerMissing || apiProviders.length === 0}
              aria-label="Refresh voice LLM models"
              title="Refresh model list from selected provider"
              className="satphone-key inline-flex min-h-10 min-w-10 pointer-coarse:min-h-11 pointer-coarse:min-w-11 shrink-0 items-center justify-center rounded-lg border px-2 disabled:opacity-45"
            >
              {refreshing ? <BrailleSpinner /> : <RefreshCw size={13} aria-hidden="true" />}
            </button>
          </div>
        </div>
      </div>

      <ConversationalGemmaNotice
        compact={compact}
        apiProviders={apiProviders}
        selectedProviderId={provider}
        selectedModelId={model}
        onSelectModel={(modelId) => saveLlm(provider, modelId)}
        onSwitchProviderAndModel={(providerId, modelId) => saveLlm(providerId, modelId)}
        onRefresh={!providerMissing && apiProviders.length > 0 ? handleRefreshModels : undefined}
        refreshing={refreshing}
      />
    </section>
  );
}
