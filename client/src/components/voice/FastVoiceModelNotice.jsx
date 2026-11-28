import { useState } from 'react';
import { Download, Zap } from 'lucide-react';
import { RECOMMENDED_FAST_VOICE_MODEL } from '../../../../server/lib/voiceModelCatalog.js';
import { installLocalLlmModel } from '../../services/apiLocalLlm.js';
import BrailleSpinner from '../BrailleSpinner';

const BUTTON_CLS = 'inline-flex min-h-9 pointer-coarse:min-h-11 items-center gap-1.5 rounded-md border border-port-accent/60 bg-port-card px-2.5 py-1 text-xs font-medium text-port-accent-text hover:border-port-accent disabled:opacity-50';

/**
 * Recommends the fastest measured local Voice brain (`RECOMMENDED_FAST_VOICE_MODEL`) next to
 * the Voice LLM picker. One click selects it when Ollama already has it, or pulls
 * it first. Renders nothing when there is no Ollama provider to serve it.
 */
export default function FastVoiceModelNotice({ apiProviders = [], selectedProviderId, selectedModelId, onChange, onRefreshModels }) {
  const { id, name, providerId, downloadLabel } = RECOMMENDED_FAST_VOICE_MODEL;
  const [pulling, setPulling] = useState(false);
  const [error, setError] = useState('');
  const provider = apiProviders.find((p) => p.id === providerId);
  if (!provider) return null;

  const providerName = provider.name || providerId;
  if (selectedProviderId === providerId && selectedModelId === id) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-port-success-text">
        <Zap size={12} aria-hidden="true" className="shrink-0" />
        Using {name} from {providerName}, the fastest tested local Voice brain.
      </p>
    );
  }

  const installed = (provider.models || []).includes(id);
  const handlePull = async () => {
    setPulling(true);
    setError('');
    try {
      await installLocalLlmModel(providerId, id, { silent: true });
      await onRefreshModels?.(providerId);
      onChange({ provider: providerId, model: id });
    } catch (err) {
      setError(err?.message || `Could not pull ${name}.`);
    } finally {
      setPulling(false);
    }
  };

  return (
    <div className="space-y-1.5 rounded-lg border border-port-accent/30 bg-port-accent/10 px-2.5 py-2 text-xs text-port-text">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0">
          <strong>Fastest replies:</strong> {name} on {providerName} starts speaking in about a second and handles Voice tools.
        </span>
        {installed ? (
          <button type="button" onClick={() => onChange({ provider: providerId, model: id })} className={BUTTON_CLS}>
            <Zap size={12} aria-hidden="true" />
            Use {name}
          </button>
        ) : (
          <button type="button" onClick={handlePull} disabled={pulling} className={BUTTON_CLS}>
            {pulling ? <BrailleSpinner /> : <Download size={12} aria-hidden="true" />}
            {pulling ? `Pulling ${name}…` : `Pull ${name} (${downloadLabel})`}
          </button>
        )}
      </div>
      {error && <p role="alert" className="text-port-error-text">{error}</p>}
    </div>
  );
}
