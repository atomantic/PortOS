import { useState } from 'react';
import { isFleetProvider } from '../../utils/providerEndpoints';
import { isProviderHardwareCompatible } from '../../utils/providerSelection';
import { isCodexSubscriptionProvider, isTuiProvider } from '../../utils/providerTypes';
import { PROVIDER_CARD_STATE } from '../../utils/providerReadiness';
import { runtimeBadgeMeta } from '../../utils/providers';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import ProviderCardHeader from './ProviderCardHeader';
import ProviderCardActions from './ProviderCardActions';
import ProviderCardDetails from './ProviderCardDetails';

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
    surface: 'bg-port-bg/40',
    hint: 'Switched off — nothing to do unless you want to use it.',
  },
};

export default function ProviderCard({
  provider,
  apps = [],
  cardState,
  daemonReadiness,
  runtime,
  status,
  isDefault,
  providersById,
  activeProviderId,
  statuses = {},
  runnerAllowedCommands,
  testResult,
  refreshing,
  refreshNotice = null,
  recovering,
  onTest,
  onRefreshModels,
  onToggleEnabled,
  onSetActive,
  onEdit,
  onDelete,
  onAddTuiMode,
  addingTuiMode = false,
  onRecover,
  onInstallRuntime,
  onAutoSetupRuntime,
  onUseServedModel,
  onServeWantedModel,
  servingModel = false,
  codex,
}) {
  // Share confirmation state between the Delete button and the full-width prompt.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const modes = (provider.executionModes || []).map(mode => providersById?.[mode.id]).filter(Boolean);
  const unified = modes.length > 1;
  const isCardDefault = isDefault || (unified && modes.some(m => m.id === activeProviderId));
  const displayName = unified ? provider.name.replace(/\b(CLI|TUI)\b\s*/i, '').trim() : provider.name;
  const style = CARD_STATE_STYLES[cardState.state];
  const runtimeBadge = runtimeBadgeMeta(provider);
  const fleetHostLabel = getFleetHostLabel(provider);
  const hardwareCompatible = isProviderHardwareCompatible(provider);
  // The card state also controls the tone of prerequisite notices.
  const optional = cardState.state === PROVIDER_CARD_STATE.DISABLED;
  const codexSubscription = isCodexSubscriptionProvider(provider);
  const subscriptionAccountReady = !codexSubscription || codex?.account?.status === 'ready';
  // ChatGPT account readiness applies to both Codex modes, but the explicit
  // text-transport consent only applies to the CLI's app-server path. The TUI
  // is an interactive PTY launch and must remain selectable before generic
  // text calls have been opted in.
  const codexModeReady = (mode) => !isCodexSubscriptionProvider(mode)
    || (subscriptionAccountReady && (isTuiProvider(mode) || mode.textTransportEnabled === true));
  return (
    <div
      id={`provider-card-${provider.id}`}
      data-provider-id={provider.id}
      data-mode-ids={(provider.executionModes || []).map(m => m.id).join(' ')}
      tabIndex={isCardDefault ? -1 : undefined}
      className={`@container ${
        isCardDefault ? 'bg-port-accent/10' : 'bg-port-card'
      } border border-l-4 rounded-xl p-4 transition-colors duration-200 ${style.border} ${style.surface || ''} ${
        isCardDefault ? 'ring-1 ring-port-accent/60' : ''
      }`}
    >
      <div className="flex flex-col @2xl:flex-row @2xl:items-start justify-between gap-3">
        <ProviderCardHeader
          provider={provider}
          displayName={displayName}
          unified={unified}
          isCardDefault={isCardDefault}
          fleetHostLabel={fleetHostLabel}
          runtimeBadge={runtimeBadge}
          cardState={cardState}
          status={status}
          style={style}
          optional={optional}
          runnerAllowedCommands={runnerAllowedCommands}
          codexQuotaExhausted={codexSubscription && codex?.account?.status === 'quota-exhausted'}
          hardwareCompatible={hardwareCompatible}
        />
        <ProviderCardActions
          provider={provider}
          displayName={displayName}
          modes={modes}
          unified={unified}
          isCardDefault={isCardDefault}
          activeProviderId={activeProviderId}
          apps={apps}
          testResult={testResult}
          refreshing={refreshing}
          refreshNotice={refreshNotice}
          subscriptionAccountReady={subscriptionAccountReady}
          codexModeReady={codexModeReady}
          onTest={onTest}
          onRefreshModels={onRefreshModels}
          onToggleEnabled={onToggleEnabled}
          onSetActive={onSetActive}
          onEdit={onEdit}
          onAddTuiMode={onAddTuiMode}
          addingTuiMode={addingTuiMode}
          confirmingDelete={confirmingDelete}
          onConfirmDelete={() => setConfirmingDelete(true)}
        />
      </div>
      <div className="mt-3 space-y-2">
        {/* Full-width and directly under the action row so the question is
            read where the click happened, whatever the buttons wrapped to.
            A unified card owns BOTH modes: the server deletes the whole mode
            group, so the question has to say so. */}
        {confirmingDelete && (
          <InlineConfirmRow
            question={`Delete ${displayName}?${unified ? ' Both its CLI and TUI modes are removed.' : ''} Its saved settings and model defaults are gone for good.`}
            confirmText="Delete provider"
            autoFocus
            aria-label={`Confirm deleting ${displayName}`}
            onConfirm={() => {
              setConfirmingDelete(false);
              onDelete(provider.id);
            }}
            onCancel={() => setConfirmingDelete(false)}
          />
        )}
        <ProviderCardDetails
          provider={provider}
          providersById={providersById}
          daemonReadiness={daemonReadiness}
          runtime={runtime}
          status={status}
          statuses={statuses}
          modes={modes}
          unified={unified}
          optional={optional}
          fleetHostLabel={fleetHostLabel}
          runtimeBadge={runtimeBadge}
          hardwareCompatible={hardwareCompatible}
          testResult={testResult}
          recovering={recovering}
          onRecover={onRecover}
          onEdit={onEdit}
          onInstallRuntime={onInstallRuntime}
          onAutoSetupRuntime={onAutoSetupRuntime}
          onUseServedModel={onUseServedModel}
          onServeWantedModel={onServeWantedModel}
          servingModel={servingModel}
          codex={codex}
        />
      </div>
    </div>
  );
}

function getFleetHostLabel(provider) {
  if (!isFleetProvider(provider)) return null;
  const hostname = URL.canParse(provider.endpoint) ? new URL(provider.endpoint).hostname : '';
  return hostname || 'another private-network machine';
}
