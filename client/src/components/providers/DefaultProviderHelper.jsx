import { Sparkles, ArrowDown } from 'lucide-react';
import { harnessLabel, providerHarnessId, OTHER_HARNESS_GROUP } from '../../utils/providerHarnesses';

/**
 * Helper banner rendered at the top of the AI Providers Presets view (#7567)
 * identifying the active default preset (provider, model, effort) and
 * allowing a one-click scroll to where its card lives in its harness section.
 */
export default function DefaultProviderHelper({
  provider = null,
  onScrollToCard = null,
  className = '',
}) {
  if (!provider) {
    return (
      <div
        className={`flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 rounded-xl bg-port-card border border-port-border text-xs sm:text-sm text-gray-400 ${className}`}
        data-testid="default-provider-helper"
      >
        <div className="flex items-center gap-2">
          <Sparkles size={15} className="text-gray-400" aria-hidden="true" />
          <span className="font-medium text-gray-300">Default:</span>
          <span>No default provider configured</span>
        </div>
      </div>
    );
  }

  const rawHarnessId = providerHarnessId(provider);
  const harnessId = rawHarnessId ?? OTHER_HARNESS_GROUP;
  const harness = harnessId === OTHER_HARNESS_GROUP ? 'Other' : harnessLabel(harnessId);

  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 rounded-xl bg-port-accent/10 border border-port-accent/30 text-xs sm:text-sm ${className}`}
      data-testid="default-provider-helper"
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 min-w-0">
        <div className="flex items-center gap-1.5 font-semibold text-port-accent shrink-0">
          <Sparkles size={15} aria-hidden="true" />
          <span>Default:</span>
        </div>
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-gray-400">Provider:</span>
          <span
            className="font-semibold text-white truncate"
            data-testid="default-helper-provider-name"
          >
            {provider.name} {harness ? `(${harness})` : ''}
          </span>
        </div>
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-gray-400">Model:</span>
          {provider.defaultModel ? (
            <code
              className="px-1.5 py-0.5 rounded bg-port-bg border border-port-border text-gray-200 font-mono text-xs truncate max-w-[200px] sm:max-w-xs"
              title={provider.defaultModel}
              data-testid="default-helper-model"
            >
              {provider.defaultModel}
            </code>
          ) : (
            <span className="text-gray-500 italic text-xs" data-testid="default-helper-model">None</span>
          )}
        </div>
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-gray-400">Effort:</span>
          {provider.effort ? (
            <code
              className="px-1.5 py-0.5 rounded bg-port-bg border border-port-border text-gray-200 font-mono text-xs"
              data-testid="default-helper-effort"
            >
              {provider.effort}
            </code>
          ) : (
            <span className="text-gray-500 italic text-xs" data-testid="default-helper-effort">None</span>
          )}
        </div>
      </div>

      {onScrollToCard && (
        <button
          type="button"
          onClick={onScrollToCard}
          className="text-xs text-port-accent hover:underline font-medium inline-flex items-center gap-1 shrink-0 ml-auto cursor-pointer"
        >
          <span>Jump to card</span>
          <ArrowDown size={12} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
