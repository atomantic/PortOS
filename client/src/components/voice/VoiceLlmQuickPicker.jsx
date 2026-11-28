import { useState } from 'react';
import { Brain } from 'lucide-react';
import { voiceModelDisplayName } from '../../../../server/lib/voiceModelCatalog.js';
import { preloadVoiceLlm, updateVoiceConfig } from '../../services/apiVoice';
import useMounted from '../../hooks/useMounted';
import useVoiceLlmProviders from '../../hooks/useVoiceLlmProviders';
import toast from '../ui/Toast';
import VoiceLlmFields from './VoiceLlmFields';
import { voiceLlmResidencyBadge } from './voiceLlmResidencyBadge';

/**
 * Inline Voice Brain / LLM picker for the Voice Call station and floating
 * sat-phone setup tray. Saves each change immediately, to the global voice
 * config by default or through `onSave` (a channel's own LLM), and shows
 * `children` (the scope chips) under its heading.
 */
export default function VoiceLlmQuickPicker({
  provider = 'lmstudio',
  model = 'auto',
  onSaved,
  onSave,
  compact = false,
  residency = null,
  children,
}) {
  const residencyBadge = voiceLlmResidencyBadge(residency);
  const mountedRef = useMounted();
  const { apiProviders, error, reload, refreshing, refreshModels } = useVoiceLlmProviders();
  const [saving, setSaving] = useState(false);

  const saveLlm = async ({ provider: nextProvider, model: nextModel }) => {
    if (saving) return;
    setSaving(true);
    try {
      const choice = { provider: nextProvider, model: nextModel };
      if (onSave) await onSave(choice);
      else await updateVoiceConfig({ llm: choice }, { silent: true });
      // Load the new model now so the first reply skips the cold load; a failed preload leaves it to load on first reply.
      preloadVoiceLlm({ silent: true }).catch(() => {});
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
        {!saving && residencyBadge && (
          <span role="status" className="inline-flex min-w-0 items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-port-text-muted">
            <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${residencyBadge.led}`} />
            <span className="truncate">{residencyBadge.label}</span>
          </span>
        )}
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

      {children}

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
          if (onSave) {
            saveLlm(next);
            return;
          }
          onSaved?.(next);
          toast.success(`Voice LLM set to ${voiceModelDisplayName(next.model)}`);
        }}
      />
    </section>
  );
}
