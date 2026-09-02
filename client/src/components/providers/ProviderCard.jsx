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
import { ExternalLink, Network, Terminal } from 'lucide-react';
import {
  CONTEXT_WINDOW_SOURCE,
  PROVIDER_CARD_STATE,
  filterHardwareCompatibleProviderModels,
  isApiProvider,
  isCodexSubscriptionProvider,
  gatewayForProvider,
  isPrivateNetworkEndpoint,
  isFleetProvider,
  isProcessProvider,
  isRunnerAllowedCommand,
  isProviderHardwareCompatible,
  isTuiProvider,
  isLaunchableTuiProvider,
  providerTypeClass,
  resolveModelContextWindow,
  supportsModelRefresh,
} from '../../utils/providers';
import { formatContextLength } from '../../utils/formatters';
import { isHttpsUrl } from '../../utils/urlNormalize';
import ProviderRuntimeStatus from './ProviderRuntimeStatus';
import ProviderReadiness from './ProviderReadiness';
import { GatewayKeyHint } from './ProviderNotices';

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
  [PROVIDER_CARD_STATE.UNKNOWN]: {
    label: 'CHECK ACCOUNT',
    border: 'border-port-warning/50',
    badge: 'bg-port-warning/20 text-port-warning',
    hint: 'PortOS could not determine the ChatGPT subscription state yet.',
  },
  [PROVIDER_CARD_STATE.DISABLED]: {
    label: 'DISABLED',
    border: 'border-port-border',
    badge: 'bg-gray-500/20 text-gray-400',
    // Switched-off cards recede until hovered, so a long list reads as the
    // handful of providers that are actually live.
    dim: 'opacity-70 hover:opacity-100 transition-opacity',
    hint: 'Switched off — nothing to do unless you want to use it.',
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
  codexAccount,
  codexModels = null,
  codexAccountLoading = false,
  codexLoginLoading = false,
  onCodexCheckAccount,
  onCodexSignIn,
  onCodexCancelLogin,
  onCodexLogout,
  onCodexRefreshModels,
  onCodexCopyCode,
  onCodexEnable,
}) {
  const style = CARD_STATE_STYLES[cardState.state];
  const compatibleModels = filterHardwareCompatibleProviderModels(provider.models, provider);
  const fleetProvider = isFleetProvider(provider);
  const fleetHost = fleetProvider && URL.canParse(provider.endpoint)
    ? new URL(provider.endpoint).hostname
    : null;
  // What the provider is missing — carried by both BLOCKED and DISABLED.
  const missingSummary = cardState.missing.map(m => m.label).join(' · ');
  // Switched off, so every finding on this card is a note about enabling it
  // rather than an outstanding task (see `providerCardState`). Read from
  // `cardState`, not `provider.enabled`, so the setup widgets below can never
  // tone one way while the badge, border, and section file the card another.
  const optional = cardState.state === PROVIDER_CARD_STATE.DISABLED;
  const codexSubscription = isCodexSubscriptionProvider(provider);
  const subscriptionAccountReady = !codexSubscription || codexAccount?.status === 'ready';
  const subscriptionReady = !codexSubscription || (subscriptionAccountReady && provider.textTransportEnabled === true);
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
          {fleetProvider && (
            <span
              className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
              title={`Runs on ${fleetHost || 'another private-network machine'}`}
            >
              <Network size={11} /> FLEET HOST
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
              ? missingSummary
              : (status?.message || style.hint)}
          >
            {style.label}
            {cardState.state === PROVIDER_CARD_STATE.BENCHED && status?.reason
              ? ` · ${status.reason}`
              : ''}
          </span>
          {/* A switched-off provider that would also need a CLI or a key says
              so — wearing the DISABLED badge's own colors, because it is an FYI
              for the day the user wants it, not a task this install is behind on. */}
          {optional && missingSummary && (
            <span
              className={`text-xs px-2 py-0.5 rounded ${style.badge}`}
              title={`To enable: ${missingSummary}`}
            >
              SETUP TO ENABLE
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
          {!isProviderHardwareCompatible(provider) && (
            <span
              className="text-xs px-2 py-0.5 rounded bg-port-warning/20 text-port-warning"
              title={provider.hardwareCompatibility?.reasons?.join(' · ')}
            >
              HARDWARE MISMATCH
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
          {isLaunchableTuiProvider(provider) && (
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
            disabled={testResult?.testing || !subscriptionReady}
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
            disabled={!provider.enabled && !subscriptionAccountReady}
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
              disabled={!subscriptionReady}
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
        {codexSubscription && (
          <CodexSubscriptionPanel
            account={codexAccount}
            models={codexModels}
            loading={codexAccountLoading}
            loginLoading={codexLoginLoading}
            onCheck={onCodexCheckAccount}
            onSignIn={onCodexSignIn}
            onCancel={onCodexCancelLogin}
            onLogout={onCodexLogout}
            onRefreshModels={onCodexRefreshModels}
            onCopyCode={onCodexCopyCode}
            subscriptionEnabled={provider.textTransportEnabled === true}
            onEnable={onCodexEnable}
          />
        )}
        <ProviderRuntimeStatus
          runtime={runtime}
          onInstall={onInstallRuntime}
          optional={optional}
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
          optional={optional}
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

        {!isProviderHardwareCompatible(provider) && (
          <div className="max-w-3xl text-xs rounded border border-port-warning/40 bg-port-warning/10 px-3 py-2 text-port-warning">
            Hidden from provider/model pickers on this machine: {provider.hardwareCompatibility?.reasons?.join(' · ') || 'hardware requirements are not met'}.
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
              {fleetProvider ? 'Fleet vLLM runtime' : 'Local vLLM container'} (endpoint: <code className="text-emerald-200">{provider.endpoint}</code>) — Qwen3.8-27B with DFlash 2 drafting. {fleetProvider ? 'This PortOS sends work over the private network; runtime lifecycle stays on the GPU host.' : 'It holds the whole GPU, so stop it before running local image/video generation.'}
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
          {fleetProvider && (
            <p className="text-xs text-cyan-300/90">
              Runs on <span className="font-medium">{fleetHost || 'another private-network machine'}</span>; install, start, and GPU-memory controls belong to that host.
            </p>
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
              /* Amber only while the provider is switched ON, where a missing
                 key is what's stopping it — `optional` mutes it otherwise. */
              <p className="text-xs">API key: <span className={optional ? 'text-gray-400' : 'text-port-warning'}>not set — Edit this provider to paste one</span></p>
            )
          )}
          {compatibleModels.length > 0 && (
            <p>Models: {compatibleModels.slice(0, 3).join(', ')}{compatibleModels.length > 3 ? ` +${compatibleModels.length - 3}` : ''}</p>
          )}
          {provider.defaultModel && (
            <p className="break-words">Default: <code className="text-gray-300 break-all">{provider.defaultModel}</code></p>
          )}
          {provider.effort && (
            <p className="break-words">Default effort: <code className="text-gray-300">{provider.effort}</code></p>
          )}
          {(() => {
            // The window AND where it came from: the last rung of the ladder is
            // a blanket 128K guess, and printing that bare made a 1M-context
            // model look like PortOS had capped it. A reported window prints
            // plain; a guess says so and names the way to replace it.
            const { tokens, source } = resolveModelContextWindow(provider, provider.defaultModel);
            const windowLabel = formatContextLength(tokens);
            if (!windowLabel) return null;
            // Only offer Refresh Models when this card HAS that button —
            // `assumed` is reached by every process provider with an
            // unrecognized model, including ones with no model-list capability
            // at all, and pointing those at a button that is not on screen is
            // worse than saying nothing.
            const assumed = source === CONTEXT_WINDOW_SOURCE.ASSUMED;
            const assumedFix = supportsModelRefresh(provider)
              ? 'assumed — Refresh Models to read the real one'
              : 'assumed — set a context window when editing this provider';
            return (
              <p className="text-xs">
                Context: <span className="text-gray-300">{windowLabel}</span>
                {source === CONTEXT_WINDOW_SOURCE.OVERRIDE && <span className="text-gray-500"> override</span>}
                {assumed && (
                  <span
                    className="text-gray-500"
                    title="PortOS has not been told this model’s real window, so prompt budgeting assumes a conservative 128K rather than the model’s own ceiling."
                  >
                    {" "}{assumedFix}
                  </span>
                )}
              </p>
            );
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

const BUTTON_CLASS = 'px-3 py-1.5 text-sm rounded transition-colors bg-port-accent/20 text-port-accent hover:bg-port-accent/30 disabled:opacity-50 disabled:cursor-not-allowed';

const quotaText = (window) => {
  if (!window || typeof window !== 'object') return null;
  const used = typeof window.usedPercent === 'number' ? Math.max(0, Math.min(100, Math.round(window.usedPercent))) : null;
  const label = typeof window.limitName === 'string' && window.limitName.trim() ? window.limitName.trim() : 'Usage window';
  const reset = typeof window.resetsAt === 'string' && window.resetsAt.trim() ? ` · resets ${window.resetsAt.trim()}` : '';
  return used === null ? `${label}${reset}` : `${label}: ${used}% used${reset}`;
};

function CodexSubscriptionPanel({
  account,
  models,
  loading,
  loginLoading,
  onCheck,
  onSignIn,
  onCancel,
  onLogout,
  onRefreshModels,
  onCopyCode,
  subscriptionEnabled,
  onEnable,
}) {
  const status = account?.status || 'unknown';
  const login = account?.login;
  const verificationUrl = isHttpsUrl(login?.verificationUrl) ? login.verificationUrl : null;
  const authUrl = isHttpsUrl(login?.authUrl) ? login.authUrl : null;
  const windows = [quotaText(account?.rateLimits?.primary), quotaText(account?.rateLimits?.secondary)].filter(Boolean);
  const catalogCount = Array.isArray(models?.models) ? models.models.length : null;
  const modelError = models?.error;
  const action = status === 'runtime-missing'
    ? 'Install Codex CLI from the runtime control below.'
    : status === 'signed-out' || status === 'reauth-required'
      ? 'Sign in with ChatGPT to use this subscription.'
      : status === 'quota-exhausted'
        ? 'Wait for a reported usage window to reset, then check the account again.'
        : status === 'login-pending'
          ? 'Finish sign-in in the opened browser or use the device-code fallback.'
          : status === 'ready'
            ? 'This provider uses ChatGPT subscription limits, not an OpenAI API key.'
            : 'Check the account again. PortOS could not determine this state.';

  return (
    <div className="max-w-3xl text-xs rounded border border-port-border bg-port-bg/50 px-3 py-2.5 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium text-gray-200">ChatGPT subscription</p>
        <span className="text-gray-400">{account?.account?.planType ? `${account.account.planType} plan` : status.replaceAll('-', ' ')}</span>
      </div>
      <p className="text-gray-400">{action}</p>
      {windows.length > 0 && <p className="text-gray-400">{windows.join(' · ')}</p>}
      {typeof account?.checkedAt === 'number' && <p className="text-gray-500">Last usage refresh: {new Date(account.checkedAt).toLocaleString()}</p>}
      {catalogCount !== null && <p className="text-gray-500">Subscription catalog: {catalogCount} model{catalogCount === 1 ? '' : 's'} available.</p>}
      {modelError && <p className="text-port-warning">Using the last known model catalog while a refresh is unavailable.</p>}
      {verificationUrl && (
        <div className="rounded bg-port-card px-2.5 py-2 text-gray-300 space-y-1">
          <p>Headless sign-in: open the verification page and enter this code.</p>
          {login.userCode && (
            <div className="flex flex-wrap items-center gap-2">
              <code className="text-port-accent font-semibold">{login.userCode}</code>
              <button type="button" className={BUTTON_CLASS} onClick={() => onCopyCode?.(login.userCode)}>Copy code</button>
            </div>
          )}
          <a className="inline-flex items-center gap-1 text-port-accent hover:underline" href={verificationUrl} target="_blank" rel="noreferrer">
            Open verification page <ExternalLink size={12} />
          </a>
        </div>
      )}
      {authUrl && (
        <a className="inline-flex items-center gap-1 text-port-accent hover:underline" href={authUrl} target="_blank" rel="noreferrer">
          Open ChatGPT sign-in <ExternalLink size={12} />
        </a>
      )}
      <div className="flex flex-wrap gap-2">
        {(status === 'signed-out' || status === 'reauth-required' || status === 'unknown') && (
          <button type="button" className={BUTTON_CLASS} disabled={loading || loginLoading} onClick={() => onSignIn?.(false)}>
            {loginLoading ? 'Starting sign-in…' : 'Sign in with ChatGPT'}
          </button>
        )}
        {(status === 'signed-out' || status === 'reauth-required' || status === 'login-pending' || status === 'unknown') && (
          <button type="button" className="px-3 py-1.5 text-sm rounded transition-colors bg-port-border hover:bg-port-border/80 text-white disabled:opacity-50" disabled={loading || loginLoading} onClick={() => onSignIn?.(true)}>
            Use device code
          </button>
        )}
        {status === 'login-pending' && login?.loginId && (
          <button type="button" className="px-3 py-1.5 text-sm rounded transition-colors bg-port-warning/20 text-port-warning hover:bg-port-warning/30 disabled:opacity-50" disabled={loading || loginLoading} onClick={() => onCancel?.(login.loginId)}>
            Cancel sign-in
          </button>
        )}
        {status === 'ready' && (
          <>
            {!subscriptionEnabled && (
              <button type="button" className={BUTTON_CLASS} disabled={loading} onClick={onEnable}>
                Enable subscription transport
              </button>
            )}
            <button type="button" className={BUTTON_CLASS} disabled={loading} onClick={onRefreshModels}>Refresh subscription models</button>
            <button type="button" className="px-3 py-1.5 text-sm rounded transition-colors bg-port-warning/20 text-port-warning hover:bg-port-warning/30 disabled:opacity-50" disabled={loading} onClick={onLogout}>Log out</button>
          </>
        )}
        {(status === 'quota-exhausted' || status === 'unknown') && (
          <button type="button" className={BUTTON_CLASS} disabled={loading} onClick={onCheck}>{loading ? 'Checking…' : 'Check account'}</button>
        )}
      </div>
    </div>
  );
}
