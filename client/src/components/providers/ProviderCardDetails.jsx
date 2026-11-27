import { hardwareUnavailableReason } from '../../utils/systemCapabilities';
import {
  CONTEXT_WINDOW_SOURCE,
  mergeObservedContextWindows,
  resolveModelContextWindow,
  withRuntimeContextWindow,
} from '../../utils/providerContextWindows';
import { isPrivateNetworkEndpoint } from '../../utils/providerEndpoints';
import { gatewayById, gatewayForProvider } from '../../utils/providerGateways';
import { codexRoutingAdvisory, supportsModelRefresh } from '../../utils/providerReadiness';
import { isApiProvider, isCodexSubscriptionProvider, isProcessProvider, isTuiProvider } from '../../utils/providerTypes';
import { filterHardwareCompatibleProviderModels } from '../../utils/providerSelection';
import { formatContextLength } from '../../utils/formatters';
import ProviderRuntimeStatus from './ProviderRuntimeStatus';
import ProviderReadiness from './ProviderReadiness';
import { CodexRoutingNotice, GatewayKeyHint } from './ProviderNotices';
import ProviderEnvVars from './ProviderEnvVars';
import CodexSubscriptionPanel from './CodexSubscriptionPanel';

// Shown once per unified card as a pill's tooltip rather than as body text.
const SHARED_CONFIG_TITLE = 'CLI and TUI share one provider configuration, including the catalog, model defaults, tier pins, effort, fallback, and generation settings. Edit either mode to update it. Arguments, timeouts, TUI timing, and CLI transport consent stay specific to their mode.';

export default function ProviderCardDetails({
  provider,
  providersById,
  daemonReadiness,
  runtime,
  status,
  statuses,
  modes,
  unified,
  optional,
  fleetHostLabel,
  runtimeBadge,
  hardwareCompatible,
  testResult,
  recovering,
  onRecover,
  onEdit,
  onInstallRuntime,
  onAutoSetupRuntime,
  onUseServedModel,
  onServeWantedModel,
  servingModel,
  codex,
}) {
  const routingAdvisory = codexRoutingAdvisory(provider);
  const gateway = gatewayForProvider(provider);
  return (
    <>
      {unified && (
        <div className="text-xs text-gray-400 space-y-1">
          <span
            tabIndex={0}
            title={SHARED_CONFIG_TITLE}
            aria-label={`Shared CLI/TUI config. ${SHARED_CONFIG_TITLE}`}
            className="inline-block px-2 py-0.5 rounded-full border border-port-border text-gray-300 cursor-help"
          >
            Shared CLI/TUI config
          </span>
          {modes.filter(mode => mode.id !== provider.id && statuses[mode.id]?.available === false).map(mode => (
            <p key={mode.id} className="text-port-warning">
              {mode.type.toUpperCase()} benched: {statuses[mode.id].message || statuses[mode.id].reason}{' '}
              <button onClick={() => onRecover(mode.id)} className="underline">Retry {mode.type.toUpperCase()}</button>
            </p>
          ))}
        </div>
      )}
      <CodexRoutingNotice
        advisory={routingAdvisory}
        className="max-w-3xl"
        onEdit={() => onEdit(provider)}
      />
      {isCodexSubscriptionProvider(provider) && (
        <CodexSubscriptionPanel
          codex={codex}
          provider={provider}
          routingOverridden={Boolean(routingAdvisory)}
        />
      )}
      <ProviderRuntimeStatus
        runtime={runtime}
        onInstall={onInstallRuntime}
        optional={optional}
      />

      {/* Daemon checks cover what is running and which model it serves. */}
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

      {!hardwareCompatible && (
        <div className="max-w-3xl text-xs rounded border border-port-warning/40 bg-port-warning/10 px-3 py-2 text-port-warning">
          {hardwareUnavailableReason('This provider', provider.hardwareCompatibility)}. Hidden from provider/model pickers on this machine.
        </div>
      )}

      <ProviderConfiguration
        provider={provider}
        providersById={providersById}
        optional={optional}
        gateway={gateway}
        fleetHostLabel={fleetHostLabel}
        daemonReadiness={daemonReadiness}
        runtimeBadge={runtimeBadge}
      />
      {gateway && (
        <GatewayKeyHint
          gateway={gateway}
          sibling={providersById[gateway.id]}
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
    </>
  );
}

function ProviderConfiguration({ provider, providersById, optional, gateway, fleetHostLabel, daemonReadiness, runtimeBadge }) {
  const compatibleModels = filterHardwareCompatibleProviderModels(provider.models, provider);
  return (
    <div className="text-sm text-gray-400 space-y-1">
      <ProviderConnectionDetails
        provider={provider}
        optional={optional}
        gateway={gateway}
        fleetHostLabel={fleetHostLabel}
        runtimeBadge={runtimeBadge}
      />
      {compatibleModels.length > 0 && (
        <p>Models: {compatibleModels.slice(0, 3).join(', ')}{compatibleModels.length > 3 ? ` +${compatibleModels.length - 3}` : ''}</p>
      )}
      {provider.defaultModel && (
        <p className="break-words">Default: <code className="text-gray-300 break-all">{provider.defaultModel}</code></p>
      )}
      {provider.effort && (
        <p className="break-words">Default effort: <code className="text-gray-300">{provider.effort}</code></p>
      )}
      <ProviderContextWindowLine provider={provider} daemonReadiness={daemonReadiness} />
      <ProviderTierLine provider={provider} />
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
        <ProviderEnvVars
          envVars={provider.envVars}
          secretEnvVars={provider.secretEnvVars}
          className="mt-1"
        />
      )}
    </div>
  );
}

function ProviderConnectionDetails({ provider, optional, gateway, fleetHostLabel, runtimeBadge }) {
  const runtimeCopy = (fleetHostLabel && runtimeBadge?.fleet) || runtimeBadge;
  return (
    <>
      {runtimeCopy && (
        <p className={`text-xs break-words ${runtimeBadge.descriptionClass || ''}`}>
          {runtimeCopy.description}
          {runtimeBadge.endpointClass && provider.endpoint && (
            <> (endpoint: <code className={`break-all ${runtimeBadge.endpointClass}`}>{provider.endpoint}</code>)</>
          )}
          {runtimeCopy.detail && ` — ${runtimeCopy.detail}`}
        </p>
      )}
      {isProcessProvider(provider) && (
        <p className="break-words">Command: <code className="text-gray-300 break-all">{provider.command} {provider.args?.join(' ')}</code></p>
      )}
      {isApiProvider(provider) && (
        <p className="break-words">Endpoint: <code className="text-gray-300 break-all">{provider.endpoint}</code></p>
      )}
      {fleetHostLabel && (
        <p className="text-xs text-cyan-300/90">
          Runs on <span className="font-medium">{fleetHostLabel}</span>; install, start, and GPU-memory controls belong to that host.
        </p>
      )}
      {isApiProvider(provider) && <ProviderApiKeyLine provider={provider} optional={optional} gateway={gateway} />}
    </>
  );
}

function ProviderApiKeyLine({ provider, optional, gateway }) {
  if (provider.hasApiKey) return <p className="text-xs">API key: <span className="text-port-success">set</span></p>;
  // Keep the display aligned with the private-endpoint exception in providerCardState.
  if (isPrivateNetworkEndpoint(provider.endpoint)) {
    return <p className="text-xs">API key: <span className="text-gray-500">none (private network endpoint)</span></p>;
  }
  const keyGateway = gatewayById(provider.id) ?? gateway;
  return (
    <p className="text-xs">
      API key: <span className={optional ? 'text-gray-400' : 'text-port-warning'}>not set — Edit this provider to paste one</span>
      {keyGateway?.keyUrl && (
        <>
          {' · '}
          <a className="text-port-accent hover:underline" href={keyGateway.keyUrl} target="_blank" rel="noreferrer">
            Get a {keyGateway.label} key
          </a>
        </>
      )}
    </p>
  );
}

function ProviderTierLine({ provider }) {
  if (!(provider.lightModel || provider.mediumModel || provider.heavyModel || provider.ultraModel)) return null;
  return (
    <p className="text-xs flex flex-wrap gap-x-1">
      Tiers:
      {provider.lightModel && <span className="text-port-success break-all">{provider.lightModel}</span>}
      {provider.mediumModel && <span className="text-port-warning break-all">{provider.mediumModel}</span>}
      {provider.heavyModel && <span className="text-port-error break-all">{provider.heavyModel}</span>}
      {provider.ultraModel && <span className="text-purple-400 break-all">Ultra: {provider.ultraModel}</span>}
    </p>
  );
}

function ProviderContextWindowLine({ provider, daemonReadiness }) {
  // Merge live observations and the configured daemon window before resolving
  // the ladder so this readout uses the same limit as dispatch.
  const { tokens, source } = resolveModelContextWindow(
    withRuntimeContextWindow(
      mergeObservedContextWindows(provider, daemonReadiness?.contextWindows),
      daemonReadiness?.runtimeContextWindow,
    ),
    provider.defaultModel
  );
  const windowLabel = formatContextLength(tokens);
  if (!windowLabel) return null;
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
}
