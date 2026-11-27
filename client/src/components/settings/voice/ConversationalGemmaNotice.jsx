import { useState } from 'react';
import { Link } from 'react-router';
import { ExternalLink, Sparkles } from 'lucide-react';
import { CONVERSATIONAL_GEMMA, isConversationalGemma } from '../../../../../server/lib/voiceModelCatalog.js';
import { PROVIDERS_PAGE_BREADCRUMB, PROVIDERS_PAGE_PATH } from '../../../../../server/lib/navManifest.js';
import { checkConversationalGemmaAccess } from '../../../services/apiLocalLlm.js';
import HfTokenBanner from '../../imageGen/HfTokenBanner.jsx';

/**
 * State-aware Conversational Gemma 4 31B prerequisite & enablement helper.
 *
 * - If the active provider already serves it: offers a one-click select (or confirms active).
 * - If another connected API provider serves it: offers a one-click provider + model switch.
 * - Otherwise: explains clearly why it is not in the dropdown and links directly to the
 *   exact PortOS setup screens (Local LLM Runtimes for llama.cpp GGUF, Providers for
 *   external OpenAI-compatible servers) plus an inline Hugging Face access check.
 */
export default function ConversationalGemmaNotice({
  apiProviders = [],
  selectedProviderId,
  selectedModelId,
  onSelectModel,
  onSwitchProviderAndModel,
  onRefresh,
  refreshing = false,
  compact = false,
}) {
  const { id, name, url, license, localGgufPath } = CONVERSATIONAL_GEMMA;
  const [accessStatus, setAccessStatus] = useState(null);
  const [checking, setChecking] = useState(false);

  const selectedProvider = apiProviders.find((p) => p.id === selectedProviderId);
  const servedOnCurrent = (selectedProvider?.models || []).find(isConversationalGemma);
  const alternateHost = !servedOnCurrent
    ? apiProviders
      .map((p) => ({ provider: p, modelId: (p.models || []).find(isConversationalGemma) }))
      .find((entry) => entry.modelId)
    : null;

  const checkAccess = async () => {
    setChecking(true);
    setAccessStatus(null);
    try {
      setAccessStatus((await checkConversationalGemmaAccess({ silent: true })).status);
    } catch {
      setAccessStatus('error');
    } finally {
      setChecking(false);
    }
  };

  if (servedOnCurrent) {
    if (isConversationalGemma(selectedModelId)) {
      return (
        <p className="flex items-center gap-1.5 text-xs text-port-success-text">
          <Sparkles size={12} aria-hidden="true" className="shrink-0" />
          Using {name} from {selectedProvider?.name || selectedProviderId}.
        </p>
      );
    }
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-port-accent/30 bg-port-accent/10 px-2.5 py-2 text-xs text-port-text">
        <span>
          <strong>{name}</strong> is served by {selectedProvider?.name || selectedProviderId}.
        </span>
        {onSelectModel && (
          <button
            type="button"
            onClick={() => onSelectModel(servedOnCurrent)}
            className="min-h-9 pointer-coarse:min-h-11 rounded-md border border-port-accent/60 bg-port-card px-2.5 py-1 text-xs font-medium text-port-accent-text hover:border-port-accent"
          >
            Use {name}
          </button>
        )}
      </div>
    );
  }

  if (alternateHost) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-port-accent/30 bg-port-accent/10 px-2.5 py-2 text-xs text-port-text">
        <span>
          <strong>{name}</strong> is served by <strong>{alternateHost.provider.name || alternateHost.provider.id}</strong> (not the currently selected provider).
        </span>
        {onSwitchProviderAndModel && (
          <button
            type="button"
            onClick={() => onSwitchProviderAndModel(alternateHost.provider.id, alternateHost.modelId)}
            className="min-h-9 pointer-coarse:min-h-11 rounded-md border border-port-accent/60 bg-port-card px-2.5 py-1 text-xs font-medium text-port-accent-text hover:border-port-accent"
          >
            Switch to {alternateHost.provider.name || alternateHost.provider.id}
          </button>
        )}
      </div>
    );
  }

  return (
    <details className={`rounded-lg border border-port-border bg-port-bg/60 text-xs text-port-text-muted ${compact ? 'px-2.5 py-1.5' : 'px-3 py-2'}`}>
      <summary className="cursor-pointer py-1 font-medium text-port-text hover:text-port-accent-text">
        How to install &amp; enable {name}
      </summary>
      <div className="mt-2 space-y-2 border-t border-port-border/60 pt-2 leading-relaxed">
        <p>
          <strong>{name}</strong> is not in this dropdown because none of your connected API providers currently serve{' '}
          <code className="rounded bg-port-card px-1 py-0.5 text-[11px] text-port-text">{id}</code>.
          Trelis publishes FP8 weights (CUDA) rather than a stock Ollama or LM Studio download.
        </p>
        <ol className="list-decimal space-y-1.5 pl-4">
          <li>
            <strong className="text-port-text">Apple Silicon (local llama.cpp):</strong> place a locally converted Q8_0 GGUF at{' '}
            <code className="break-all rounded bg-port-card px-1 py-0.5 text-[11px] text-port-text">{localGgufPath}</code>, then start its preset in{' '}
            <Link to="/models/llms-runtimes" className="font-medium text-port-accent-text underline">llama.cpp runtime</Link> (or review options in{' '}
            <Link to="/models/llms" className="font-medium text-port-accent-text underline">Local LLMs</Link>).
          </li>
          <li>
            <strong className="text-port-text">External OpenAI-compatible server:</strong> serve{' '}
            <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium text-port-accent-text underline">
              {name} <ExternalLink size={10} aria-hidden="true" />
            </a>{' '}
            ({license}) and register the endpoint under{' '}
            <Link to={PROVIDERS_PAGE_PATH} className="font-medium text-port-accent-text underline">{PROVIDERS_PAGE_BREADCRUMB}</Link>.
          </li>
          <li>
            Select that provider above and click <strong className="text-port-text">Refresh models</strong> so it appears in the model dropdown.
          </li>
        </ol>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            disabled={checking}
            onClick={checkAccess}
            className="min-h-9 pointer-coarse:min-h-11 rounded-md border border-port-border bg-port-card px-2.5 py-1 text-xs font-medium text-port-text hover:border-port-accent disabled:opacity-50"
          >
            {checking ? 'Checking Hugging Face access…' : accessStatus ? 'Recheck HF access' : 'Check Hugging Face access'}
          </button>
          {onRefresh && (
            <button
              type="button"
              disabled={refreshing}
              onClick={onRefresh}
              className="min-h-9 pointer-coarse:min-h-11 rounded-md border border-port-border bg-port-card px-2.5 py-1 text-xs font-medium text-port-text hover:border-port-accent disabled:opacity-50"
            >
              {refreshing ? 'Refreshing…' : 'Refresh models'}
            </button>
          )}
        </div>
        {accessStatus === 'ready' && (
          <p role="status" className="text-port-success-text">
            Hugging Face confirmed download access to the checkpoint.
          </p>
        )}
        {accessStatus === 'terms-required' && (
          <p role="status" className="text-port-warning-text">
            Hugging Face denied access. Accept the model terms with the account that owns your read token and verify gated-repo access.
          </p>
        )}
        {accessStatus === 'error' && (
          <p role="alert" className="text-port-error-text">
            Could not verify Hugging Face access right now. Try again shortly.
          </p>
        )}
        {(accessStatus === 'token-required' || accessStatus === 'terms-required') && (
          <HfTokenBanner modelLabel={name} licenseUrl={url} onSaved={checkAccess} />
        )}
      </div>
    </details>
  );
}
