/**
 * One AI-provider card on the Settings → AI Providers page.
 *
 * Lives here rather than inline on the page because the page also owns the
 * provider EDITOR, the sample-provider panel and the ad-hoc runner — the card
 * is ~300 lines of its own and was already three `map`s deep once the page
 * started grouping cards by their card state.
 *
 * The card renders no derivation of its own: `cardState`, `runtime` and
 * `status` all arrive resolved, so what colors the border, what the badge says,
 * and which section the page filed the card under can never disagree.
 */

import { Link } from 'react-router';
import { Terminal } from 'lucide-react';
import {
  PROVIDER_CARD_STATE,
  effectiveModelContextWindow,
  isApiProvider,
  isGrokBuildCli,
  gatewayForProvider,
  isPrivateNetworkEndpoint,
  isProcessProvider,
  isRunnerAllowedCommand,
  isTuiProvider,
  providerTypeClass,
  supportsModelRefresh,
} from '../../utils/providers';
import { formatContextLength } from '../../utils/formatters';
import ProviderRuntimeStatus from './ProviderRuntimeStatus';
import ProviderReadiness from './ProviderReadiness';
import { GrokUploadWarning, GatewayKeyHint } from './ProviderNotices';

// One phrasing for "this command isn't on the CoS Agent Runner's allowlist".
// The editor states the same thing in its own inline banner, in prose.
const RUNNER_NOT_ALLOWED_HINT = 'This command is not on the CoS Agent Runner’s allowlist, so /spawn and /spawn-tui will refuse it. The provider still works everywhere else (direct spawn, chat, pipeline). The allowlist is curated in the PortOS source, not in this form.';

// Card presentation per card state. Exactly ONE border-color utility is
// emitted per card — Tailwind resolves same-specificity color utilities by
// stylesheet order, not by the order they appear in `className` — so the
// "default provider" highlight is a ring rather than a competing border color.
export const CARD_STATE_STYLES = {
  [PROVIDER_CARD_STATE.READY]: {
    label: 'READY',
    border: 'border-port-success/40',
    badge: 'bg-port-success/20 text-port-success',
    hint: 'Enabled, and every prerequisite is in place.',
  },
  [PROVIDER_CARD_STATE.BENCHED]: {
    label: 'BENCHED',
    border: 'border-port-error/50',
    badge: 'bg-port-error/20 text-port-error',
    hint: 'Enabled, but benched after a failure — calls route to the fallback.',
  },
  [PROVIDER_CARD_STATE.BLOCKED]: {
    label: 'NEEDS SETUP',
    border: 'border-port-warning/50',
    badge: 'bg-port-warning/20 text-port-warning',
    hint: 'Missing a prerequisite — install the CLI or add the API key to use it.',
  },
  [PROVIDER_CARD_STATE.DISABLED]: {
    label: 'DISABLED',
    border: 'border-port-border',
    badge: 'bg-gray-500/20 text-gray-400',
    // Switched-off cards recede until hovered, so a long list reads as the
    // handful of providers that are actually live.
    dim: 'opacity-70 hover:opacity-100 transition-opacity',
    hint: 'Ready to go, but switched off.',
  },
};

export default function ProviderCard({
  provider,
  cardState,
  daemonReadiness,
  runtime,
  status,
  isDefault,
  providersById,
  runnerAllowedCommands,
  testResult,
  refreshing,
  recovering,
  onTest,
  onRefreshModels,
  onToggleEnabled,
  onSetActive,
  onEdit,
  onDelete,
  onRecover,
  onInstallRuntime,
  onAutoSetupRuntime,
  onUseServedModel,
  onServeWantedModel,
  servingModel = false,
}) {
  const style = CARD_STATE_STYLES[cardState.state];
  return (
    <div
      className={`@container bg-port-card border border-l-4 rounded-xl p-4 ${style.border} ${style.dim || ''} ${
        isDefault ? 'ring-1 ring-port-accent/60' : ''
      }`}
    >
      {/* Identity and actions share the top row; everything else sits BELOW it
          at the card's full width. The details used to be the row's first flex
          item, which meant the un-shrinkable seven-button action group claimed
          its max-content width first and left the details whatever remained —
          on a real desktop card that was a ~275px column of hard-wrapped text
          beside an empty half-card. Breakpoints are container-relative (`@`)
          rather than viewport-relative: the card is what has to be wide enough
          to split, and it is narrower than the viewport by the sidebar. */}
      <div className="flex flex-col @2xl:flex-row @2xl:items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <h3 className="text-lg font-semibold text-white">{provider.name}</h3>
          <span className={`text-xs px-2 py-0.5 rounded ${providerTypeClass(provider.type)}`}>
            {provider.type.toUpperCase()}
          </span>
          {isDefault && (
            <span className="text-xs px-2 py-0.5 rounded bg-port-accent/20 text-port-accent">
              DEFAULT
            </span>
          )}
          {provider.llamaBacked && (
            <span className="text-xs px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30">
              LLAMA.CPP / DFLASH
            </span>
          )}
          {provider.vllmBacked && (
            <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
              vLLM / DFLASH2
            </span>
          )}
          {provider.sglangBacked && (
            <span className="text-xs px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
              SGLANG
            </span>
          )}
          {provider.mtplxBacked && (
            <span className="text-xs px-2 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30">
              MTPLX
            </span>
          )}
          {/* One badge for the card's state — the same one that
              colors its border and decides which section it sits in.
              BENCHED covers what used to render as UNAVAILABLE: an
              enabled provider sidelined after a failure (usage limit,
              model-not-found, auth) in favor of its fallback. */}
          <span
            className={`text-xs px-2 py-0.5 rounded ${style.badge}`}
            title={cardState.state === PROVIDER_CARD_STATE.BLOCKED
              ? cardState.missing.map(m => m.label).join(' · ')
              : (status?.message || style.hint)}
          >
            {style.label}
            {cardState.state === PROVIDER_CARD_STATE.BENCHED && status?.reason
              ? ` · ${status.reason}`
              : ''}
          </span>
          {/* A blocked provider's toggle is not what's stopping it, so
              spell out which way it sits rather than leaving the reader
              to infer it from the Enable/Disable button. */}
          {cardState.state === PROVIDER_CARD_STATE.BLOCKED && (
            <span className="text-xs px-2 py-0.5 rounded bg-gray-500/20 text-gray-400">
              {provider.enabled ? 'SWITCHED ON' : 'SWITCHED OFF'}
            </span>
          )}
          {/* Off the CoS Agent Runner's exec allowlist: the provider still
              works for direct spawn, it just can't be launched by /spawn
              or /spawn-tui. Informational — never a save-time rejection. */}
          {isProcessProvider(provider) && isRunnerAllowedCommand(provider.command, runnerAllowedCommands) === false && (
            <span
              className="text-xs px-2 py-0.5 rounded bg-port-warning/20 text-port-warning"
              title={RUNNER_NOT_ALLOWED_HINT}
            >
              NO AGENT RUNNER
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 @2xl:justify-end">
          {/* TUI providers are the only ones a human can drive interactively, so
              they get a one-click hand-off to the Shell page. The link carries
              only the provider ID: the server resolves both the command line
              and the provider's `envVars` (its backend and auth) when it spawns
              the PTY, so an Ollama-backed or Bedrock provider reaches the
              backend it is configured for instead of the vendor cloud. Sending
              the command itself would leave that env behind — and those values
              are secret, so they can't ride a URL anyway. `tuiCommandLine` is
              the display half of the same resolution: it shows what will run,
              and an older server that omits it simply renders no button. */}
          {isTuiProvider(provider) && provider.tuiCommandLine && (
            <Link
              to={`/shell?provider=${encodeURIComponent(provider.id)}`}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-port-accent/20 text-port-accent hover:bg-port-accent/30 rounded transition-colors"
              title={`Launch in Shell: ${provider.tuiCommandLine}`}
            >
              <Terminal size={14} />
              Launch in Shell
            </Link>
          )}

          <button
            onClick={() => onTest(provider.id)}
            disabled={testResult?.testing}
            className="px-3 py-1.5 text-sm bg-port-border hover:bg-port-border/80 text-white rounded transition-colors disabled:opacity-50"
          >
            {testResult?.testing ? 'Testing...' : 'Test'}
          </button>

          {supportsModelRefresh(provider) && (
            <button
              onClick={() => onRefreshModels(provider.id)}
              disabled={refreshing}
              className="px-3 py-1.5 text-sm bg-port-border hover:bg-port-border/80 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title="Refresh available models"
            >
              {refreshing ? 'Refreshing...' : 'Refresh Models'}
            </button>
          )}

          <button
            onClick={() => onToggleEnabled(provider)}
            className={`px-3 py-1.5 text-sm rounded transition-colors ${
              provider.enabled
                ? 'bg-port-warning/20 text-port-warning hover:bg-port-warning/30'
                : 'bg-port-success/20 text-port-success hover:bg-port-success/30'
            }`}
          >
            {provider.enabled ? 'Disable' : 'Enable'}
          </button>

          {!isDefault && provider.enabled && (
            <button
              onClick={() => onSetActive(provider.id)}
              className="px-3 py-1.5 text-sm bg-port-accent/20 text-port-accent hover:bg-port-accent/30 rounded transition-colors"
            >
              Set Default
            </button>
          )}

          <button
            onClick={() => onEdit(provider)}
            className="px-3 py-1.5 text-sm bg-port-border hover:bg-port-border/80 text-white rounded transition-colors"
          >
            Edit
          </button>

          <button
            onClick={() => onDelete(provider.id)}
            className="px-3 py-1.5 text-sm bg-port-error/20 text-port-error hover:bg-port-error/30 rounded transition-colors"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Card body — full width, below the header row rather than beside the
          action buttons. */}
      <div className="mt-3 space-y-2">
        <ProviderRuntimeStatus
          runtime={runtime}
          onInstall={onInstallRuntime}
        />

        {/* The other half of "can this actually run": is the local daemon this
            provider points at installed, up, and serving the model it names.
            Distinct from the card STATE above — that one is about the toggle
            and the credentials, this one probes the daemon. */}
        <ProviderReadiness
          className="max-w-3xl"
          readiness={daemonReadiness}
          onAutoSetup={(setup) => onAutoSetupRuntime?.({ ...setup, providerId: provider.id })}
          onUseServedModel={(modelId) => onUseServedModel?.(provider, modelId)}
          onServeWantedModel={onServeWantedModel ? () => onServeWantedModel(provider) : undefined}
          serving={servingModel}
        />

        {provider.enabled && status?.available === false && (
          <div className="max-w-3xl text-xs rounded border border-port-error/40 bg-port-error/10 px-3 py-2 text-port-error space-y-1">
            <p className="break-words">
              <span className="font-semibold">Benched ({status?.reason || 'unknown'})</span>
              {status?.timeUntilRecovery ? ` — auto-retries in ${status.timeUntilRecovery}` : ''}
              . Calls route to the fallback until then.
            </p>
            {status?.message && (
              <p className="break-words text-port-error/80">Why: {status.message}</p>
            )}
            <button
              type="button"
              onClick={() => onRecover(provider.id)}
              disabled={recovering}
              className="mt-1 px-2 py-0.5 rounded bg-port-error/20 hover:bg-port-error/30 disabled:opacity-50 text-port-error"
            >
              {recovering ? 'Clearing…' : 'Recover now'}
            </button>
          </div>
        )}

        <div className="text-sm text-gray-400 space-y-1">
          {provider.llamaBacked && (
            <p className="text-xs text-purple-300/90">
              Local llama.cpp / llama-server harness (endpoint: <code className="text-purple-200">{provider.endpoint}</code>) — supports DFlash 2 speculative drafting.
            </p>
          )}
          {provider.vllmBacked && (
            <p className="text-xs text-emerald-300/90">
              Local vLLM container (endpoint: <code className="text-emerald-200">{provider.endpoint}</code>) — Qwen3.8-27B with DFlash 2 drafting. It holds the whole GPU, so stop it before running local image/video generation.
            </p>
          )}
          {provider.sglangBacked && (
            <p className="text-xs text-amber-300/90">
              Local SGLang container (endpoint: <code className="text-amber-200">{provider.endpoint}</code>) — Qwen3.8-27B on a Hopper or Blackwell card. It holds the whole GPU, so stop it before running local image/video generation.
            </p>
          )}
          {isProcessProvider(provider) && (
            <p className="break-words">Command: <code className="text-gray-300 break-all">{provider.command} {provider.args?.join(' ')}</code></p>
          )}
          {isApiProvider(provider) && (
            <p className="break-words">Endpoint: <code className="text-gray-300 break-all">{provider.endpoint}</code></p>
          )}
          {/* API-type providers auth solely via the stored apiKey (sent as a
              Bearer header) — surface its state here so "where does the key
              go?" is answered from the card, not by spelunking the form. */}
          {isApiProvider(provider) && (
            provider.hasApiKey ? (
              <p className="text-xs">API key: <span className="text-port-success">set</span></p>
            ) : isPrivateNetworkEndpoint(provider.endpoint) ? (
              /* Same rule as `providerCardState`'s apiKey prerequisite — a
                 keyless call to a private OpenAI-compatible server (loopback,
                 the LAN box, a tailnet peer) is a supported setup, so the two
                 must not disagree: a card badged READY used to carry an
                 orange "API key: not set" line for exactly those endpoints. */
              <p className="text-xs">API key: <span className="text-gray-500">none (private network endpoint)</span></p>
            ) : (
              <p className="text-xs">API key: <span className="text-port-warning">not set — Edit this provider to paste one</span></p>
            )
          )}
          {provider.models?.length > 0 && (
            <p>Models: {provider.models.slice(0, 3).join(', ')}{provider.models.length > 3 ? ` +${provider.models.length - 3}` : ''}</p>
          )}
          {provider.defaultModel && (
            <p className="break-words">Default: <code className="text-gray-300 break-all">{provider.defaultModel}</code></p>
          )}
          {provider.effort && (
            <p className="break-words">Default effort: <code className="text-gray-300">{provider.effort}</code></p>
          )}
          {(() => {
            const windowLabel = formatContextLength(effectiveModelContextWindow(provider, provider.defaultModel));
            return windowLabel ? (
              <p className="text-xs">
                Context: <span className="text-gray-300">{windowLabel}</span>
                {provider.contextWindow ? <span className="text-gray-500"> override</span> : null}
              </p>
            ) : null;
          })()}
          {(provider.lightModel || provider.mediumModel || provider.heavyModel) && (
            <p className="text-xs">
              Tiers:
              {provider.lightModel && <span className="ml-1 text-port-success">{provider.lightModel}</span>}
              {provider.mediumModel && <span className="ml-1 text-port-warning">{provider.mediumModel}</span>}
              {provider.heavyModel && <span className="ml-1 text-port-error">{provider.heavyModel}</span>}
            </p>
          )}
          {provider.headlessArgs?.length > 0 && (
            <p className="text-xs break-words">
              Headless: <code className="text-gray-300 break-all">{provider.headlessArgs.join(' ')}</code>
            </p>
          )}
          {isTuiProvider(provider) && (
            <p className="text-xs break-words">
              TUI: paste delay <span className="text-gray-300">{provider.tuiPromptDelayMs || 2500}ms</span>, completion by sentinel, process exit, or explicit failure
            </p>
          )}
          {provider.fallbackProvider && (
            <p className="text-xs">
              Fallback: <span className="text-port-accent">{providersById[provider.fallbackProvider]?.name || provider.fallbackProvider}</span>
              {provider.fallbackModel && <span className="ml-1 text-gray-300">({provider.fallbackModel})</span>}
            </p>
          )}
          {provider.envVars && Object.keys(provider.envVars).length > 0 && (
            <div className="text-xs mt-1">
              <span className="text-gray-400">Env:</span>
              {Object.entries(provider.envVars).map(([k, v]) => (
                <div key={k}>
                  <code className="ml-1 text-orange-400">
                    {k}={provider.secretEnvVars?.includes(k) ? (v === '' ? '(not set)' : '***') : v}
                  </code>
                </div>
              ))}
            </div>
          )}
        </div>

        {isGrokBuildCli(provider) && <GrokUploadWarning className="max-w-3xl" />}

        {gatewayForProvider(provider) && (
          <GatewayKeyHint
            gateway={gatewayForProvider(provider)}
            sibling={providersById[gatewayForProvider(provider).id]}
            onEdit={onEdit}
            className="max-w-3xl"
          />
        )}

        {testResult && !testResult.testing && (
          <div className={`text-sm ${testResult.success ? 'text-port-success' : 'text-port-error'}`}>
            {testResult.success
              ? `✓ Available${testResult.version ? ` (${testResult.version})` : ''}`
              : `✗ ${testResult.error}`
            }
          </div>
        )}
      </div>
    </div>
  );
}
