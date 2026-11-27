import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ExternalLink, Play, Sparkles, Square } from 'lucide-react';
import { CONVERSATIONAL_GEMMA, isConversationalGemma } from '../../../../../server/lib/voiceModelCatalog.js';
import { PROVIDERS_PAGE_BREADCRUMB, PROVIDERS_PAGE_PATH } from '../../../../../server/lib/navManifest.js';
import {
  cancelConversationalGemmaSetup,
  getConversationalGemmaSetupStatus,
  startConversationalGemmaSetup,
} from '../../../services/apiLocalLlm.js';
import { useSocketResource } from '../../../hooks/useSocketResource.js';
import BrailleSpinner from '../../BrailleSpinner.jsx';
import HfTokenBanner from '../../imageGen/HfTokenBanner.jsx';

const SETUP_EVENTS = ['voice:conversationalGemma:changed'];

/**
 * Direct one-click Conversational Gemma 4 31B (llama.cpp) enablement & setup card.
 *
 * - If active: confirms Conversational Gemma is active.
 * - If already served by a connected provider: offers a single-click switch.
 * - On Apple Silicon: offers a single-click "Set up / Start llama.cpp + Conversational Gemma"
 *   button that installs llama.cpp, downloads/converts the Q8_0 GGUF (prompting inline for
 *   the HF token/terms only if needed), launches llama-server, enables the llama.cpp API
 *   provider, and selects Conversational Gemma as the Voice Brain automatically.
 */
export default function ConversationalGemmaNotice({
  apiProviders = [],
  selectedProviderId,
  selectedModelId,
  onSelectModel,
  onSwitchProviderAndModel,
  onSetupComplete,
  compact = false,
}) {
  const { id, name, url, license, llamaProviderId } = CONVERSATIONAL_GEMMA;
  const [submitting, setSubmitting] = useState(false);
  const [requestError, setRequestError] = useState('');

  const selectedProvider = apiProviders.find((p) => p.id === selectedProviderId);
  const servedOnCurrent = (selectedProvider?.models || []).find(isConversationalGemma);
  const alternateHost = !servedOnCurrent
    ? apiProviders
      .map((p) => ({ provider: p, modelId: (p.models || []).find(isConversationalGemma) }))
      .find((entry) => entry.modelId)
    : null;

  const needsLocalSetup = !servedOnCurrent && !alternateHost;
  const { data: setup, updateData } = useSocketResource(getConversationalGemmaSetupStatus, {
    events: SETUP_EVENTS,
    enabled: needsLocalSetup,
  });

  const prevPhaseRef = useRef(setup?.phase);
  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = setup?.phase;
    if (prev && prev !== 'ready' && setup?.phase === 'ready') {
      onSetupComplete?.({ provider: llamaProviderId, model: id });
    }
  }, [setup?.phase, onSetupComplete, llamaProviderId, id]);

  const handleStartSetup = async () => {
    if (submitting) return;
    setSubmitting(true);
    setRequestError('');
    try {
      const next = await startConversationalGemmaSetup({ silent: true });
      updateData(next);
      if (next?.phase === 'ready') {
        onSetupComplete?.({ provider: llamaProviderId, model: id });
      }
    } catch (err) {
      setRequestError(err?.message || 'Could not start Conversational Gemma setup.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancelSetup = async () => {
    setSubmitting(true);
    setRequestError('');
    try {
      updateData(await cancelConversationalGemmaSetup({ silent: true }));
    } catch (err) {
      setRequestError(err?.message || 'Could not cancel setup.');
    } finally {
      setSubmitting(false);
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
          <strong>{name}</strong> is ready on <strong>{alternateHost.provider.name || alternateHost.provider.id}</strong>.
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

  const running = Boolean(setup?.running);
  const canAutoSetup = setup ? setup.supported !== false : true;
  const ggufReady = Boolean(setup?.ggufExists);
  const accessStatus = setup?.accessStatus;
  const showHfBanner = accessStatus === 'token-required' || accessStatus === 'terms-required';
  const actionLabel = ggufReady
    ? 'Start llama.cpp + Conversational Gemma'
    : 'Use llama.cpp + Conversational Gemma 4 31B';

  return (
    <div className={`space-y-2 rounded-lg border border-port-border bg-port-bg/60 text-xs text-port-text-muted ${compact ? 'px-2.5 py-2' : 'px-3 py-2.5'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <p className="flex items-center gap-1.5 font-medium text-port-text">
            <Sparkles size={12} aria-hidden="true" className="shrink-0 text-port-accent" />
            <span>{name}</span>
          </p>
          <p className="text-[11px] leading-snug text-port-text-muted">
            {running
              ? (setup.detail || 'Setting up llama.cpp + Conversational Gemma 4 31B…')
              : ggufReady
                ? 'Local Q8_0 GGUF ready. Launch llama.cpp and switch Voice Brain automatically.'
                : canAutoSetup
                  ? 'One-click local Apple Silicon setup: installs llama.cpp, converts Q8_0 GGUF, starts the server, and selects it here.'
                  : 'Connect an external OpenAI-compatible server hosting this checkpoint.'}
          </p>
        </div>

        {canAutoSetup && (
          running ? (
            <button
              type="button"
              disabled={submitting}
              onClick={handleCancelSetup}
              className="inline-flex min-h-9 pointer-coarse:min-h-11 shrink-0 items-center gap-1.5 rounded-md border border-port-error/50 bg-port-card px-2.5 py-1 text-xs font-medium text-port-error-text hover:border-port-error disabled:opacity-50"
            >
              <Square size={11} aria-hidden="true" />
              Cancel
            </button>
          ) : (
            <button
              type="button"
              disabled={submitting}
              onClick={handleStartSetup}
              className="inline-flex min-h-9 pointer-coarse:min-h-11 max-w-full items-center gap-1.5 rounded-md border border-port-accent/60 bg-port-card px-2.5 py-1 text-left text-xs font-medium text-port-accent-text hover:border-port-accent disabled:opacity-50"
            >
              {submitting ? <BrailleSpinner /> : <Play size={11} aria-hidden="true" className="shrink-0" />}
              <span className="break-words">{actionLabel}</span>
            </button>
          )
        )}
      </div>

      {running && (
        <div className="space-y-1">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-port-border/60">
            <div
              className="h-full rounded-full bg-port-accent transition-all duration-300"
              style={{ width: `${Math.max(6, Math.min(100, setup?.percent ?? 12))}%` }}
            />
          </div>
          {setup?.percent != null && (
            <p role="status" className="font-mono text-[10px] text-port-text-muted">
              {setup.phase} · {setup.percent}%
            </p>
          )}
        </div>
      )}

      {!running && (requestError || setup?.error) && (
        <p role="alert" className="text-port-error-text">
          {requestError || setup.error}
        </p>
      )}

      {showHfBanner && (
        <HfTokenBanner modelLabel={name} licenseUrl={url} onSaved={handleStartSetup} />
      )}

      {!canAutoSetup && (
        <p className="text-[11px] leading-relaxed">
          Serve{' '}
          <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium text-port-accent-text underline">
            {name} <ExternalLink size={10} aria-hidden="true" />
          </a>{' '}
          ({license}) and register it under{' '}
          <Link to={PROVIDERS_PAGE_PATH} className="font-medium text-port-accent-text underline">{PROVIDERS_PAGE_BREADCRUMB}</Link>.
        </p>
      )}
    </div>
  );
}
