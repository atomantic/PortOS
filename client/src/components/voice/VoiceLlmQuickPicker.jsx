import { useState } from 'react';
import { Brain } from 'lucide-react';
import { voiceModelDisplayName } from '../../../../server/lib/voiceModelCatalog.js';
import { updateVoiceConfig } from '../../services/apiVoice';
import useMounted from '../../hooks/useMounted';
import useVoiceLlmProviders from '../../hooks/useVoiceLlmProviders';
import toast from '../ui/Toast';
import VoiceLlmFields from './VoiceLlmFields';

/**
 * Inline Voice Brain / LLM picker for the Voice Call station and floating
 * sat-phone setup tray. Saves each change immediately to voice config.
 */
export default function VoiceLlmQuickPicker({
  provider = 'lmstudio',
  model = 'auto',
  onSaved,
  compact = false,
}) {
  const mountedRef = useMounted();
  const { apiProviders, error, reload, refreshing, refreshModels } = useVoiceLlmProviders();
  const [saving, setSaving] = useState(false);

  const saveLlm = async ({ provider: nextProvider, model: nextModel }) => {
    if (saving) return;
    setSaving(true);
    try {
      await updateVoiceConfig({ llm: { provider: nextProvider, model: nextModel } }, { silent: true });
      if (!mountedRef.current) return;
      onSaved?.({ provider: nextProvider, model: nextModel });
      toast.success(`Voice LLM set to ${nextModel === 'auto' ? `${nextProvider} (auto)` : voiceModelDisplayName(nextModel)}`);
    } catch (err) {
      if (mountedRef.current) toast.error(`Could not update Voice LLM: ${err.message}`);
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

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
        {error && (
          <button
            type="button"
            onClick={reload}
            className="min-h-9 pointer-coarse:min-h-11 rounded border border-port-border px-2 text-xs text-port-accent-text hover:border-port-accent"
          >
            Retry providers
          </button>
        )}
      </div>

      <VoiceLlmFields
        compact={compact}
        provider={provider}
        model={model}
        apiProviders={apiProviders}
        refreshing={refreshing}
        onRefreshModels={refreshModels}
        disabled={saving}
        onChange={saveLlm}
        // The server already saved provider + model; reload so the new provider is listed.
        onSetupComplete={(next) => {
          reload();
          onSaved?.(next);
          toast.success(`Voice LLM set to ${voiceModelDisplayName(next.model)}`);
        }}
      />
    </section>
  );
}
