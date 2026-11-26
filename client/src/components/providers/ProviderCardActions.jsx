import { Link, useNavigate } from 'react-router';
import { Terminal } from 'lucide-react';
import AppContextPicker from '../AppContextPicker';
import { isApiProvider, isLaunchableTuiProvider, isTuiProvider } from '../../utils/providerTypes';
import { supportsModelRefresh } from '../../utils/providerReadiness';
import { LOCAL_RUNTIME_LABELS, LOCAL_RUNTIME_MANAGE_URLS, localRuntimeKind } from '../../../../server/lib/modelPinMembership.js';
import ProviderVisionTest from './ProviderVisionTest';

export default function ProviderCardActions({
  provider,
  displayName,
  modes,
  unified,
  isCardDefault,
  activeProviderId,
  apps,
  testResult,
  refreshing,
  refreshNotice,
  subscriptionAccountReady,
  codexModeReady,
  onTest,
  onRefreshModels,
  onToggleEnabled,
  onSetActive,
  onEdit,
  onAddTuiMode,
  addingTuiMode,
  confirmingDelete,
  onConfirmDelete,
}) {
  const navigate = useNavigate();
  const shellProvider = unified ? modes.find(isTuiProvider) : provider;
  const subscriptionReady = codexModeReady(provider);
  return (
    <div className="flex flex-wrap items-center gap-2 @2xl:justify-end">
      {/* Keep the command and its environment server-side. The Shell route
          carries the provider ID and, for a managed app, the working directory. */}
      {isLaunchableTuiProvider(shellProvider) && (
        <ShellLaunchControl
          provider={shellProvider}
          apps={apps}
          onLaunch={(cwd) => navigate(shellLaunchPath(shellProvider.id, cwd))}
        />
      )}

      <button
        onClick={() => onTest(provider.id)}
        disabled={testResult?.testing || !subscriptionReady}
        className="px-3 py-1.5 pointer-coarse:min-h-11 text-sm bg-port-border hover:bg-port-border/80 text-white rounded transition-colors disabled:opacity-50"
      >
        {testResult?.testing ? 'Testing...' : 'Test'}
      </button>

      {isApiProvider(provider) && <ProviderVisionTest provider={provider} />}

      {supportsModelRefresh(provider) && (
        <>
          <button
            onClick={() => onRefreshModels(provider.id)}
            disabled={refreshing}
            className="px-3 py-1.5 pointer-coarse:min-h-11 text-sm bg-port-border hover:bg-port-border/80 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Refresh available models"
          >
            {refreshing ? 'Refreshing...' : 'Refresh Models'}
          </button>
          {refreshNotice && <ModelRefreshNotice provider={provider} notice={refreshNotice} />}
        </>
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

      <ProviderModeActions
        provider={provider}
        modes={modes}
        unified={unified}
        isCardDefault={isCardDefault}
        activeProviderId={activeProviderId}
        subscriptionReady={subscriptionReady}
        codexModeReady={codexModeReady}
        onSetActive={onSetActive}
        onEdit={onEdit}
      />

      {/* The server checks whether this harness supports a TUI and its sibling ID is free. */}
      {!unified && provider.canAddTuiMode && (
        <button
          onClick={() => onAddTuiMode(provider)}
          disabled={addingTuiMode}
          title={`Add the interactive (TUI) mode of ${displayName}, using its existing command and connection`}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-port-border hover:bg-port-border/80 text-white rounded transition-colors disabled:opacity-50"
        >
          <Terminal size={14} />
          {addingTuiMode ? 'Adding…' : 'Add interactive mode'}
        </button>
      )}

      {!confirmingDelete && (
        <button
          onClick={onConfirmDelete}
          className="px-3 py-1.5 text-sm bg-port-error/20 text-port-error hover:bg-port-error/30 rounded transition-colors"
        >
          Delete
        </button>
      )}
    </div>
  );
}

function ProviderModeActions({
  provider,
  modes,
  unified,
  isCardDefault,
  activeProviderId,
  subscriptionReady,
  codexModeReady,
  onSetActive,
  onEdit,
}) {
  return (
    <>
      {!unified && !isCardDefault && provider.enabled && (
        <button
          onClick={() => onSetActive(provider.id)}
          disabled={!subscriptionReady}
          className="px-3 py-1.5 text-sm bg-port-accent/20 text-port-accent hover:bg-port-accent/30 rounded transition-colors"
        >
          Set Default
        </button>
      )}

      {unified && modes.map(mode => (
        <span key={mode.id} className="inline-flex flex-wrap items-center gap-2">
          {provider.enabled && (
            <button
              onClick={() => onSetActive(mode.id)}
              disabled={mode.id === activeProviderId || !codexModeReady(mode)}
              className="px-3 py-1.5 text-sm bg-port-accent/20 text-port-accent rounded disabled:opacity-50"
            >
              {mode.id === activeProviderId ? `${mode.type.toUpperCase()} default` : `Set ${mode.type.toUpperCase()} default`}
            </button>
          )}
          <button onClick={() => onEdit(mode)} className="px-3 py-1.5 pointer-coarse:min-h-11 text-sm bg-port-border text-white rounded">
            Edit {mode.type.toUpperCase()}
          </button>
        </span>
      ))}
      {!unified && (
        <button
          onClick={() => onEdit(provider)}
          className="px-3 py-1.5 pointer-coarse:min-h-11 text-sm bg-port-border hover:bg-port-border/80 text-white rounded transition-colors"
        >
          Edit
        </button>
      )}
    </>
  );
}

function ModelRefreshNotice({ provider, notice }) {
  const kind = notice.runtime ?? localRuntimeKind(provider);
  const fallbackUrl = Object.hasOwn(LOCAL_RUNTIME_MANAGE_URLS, kind) ? LOCAL_RUNTIME_MANAGE_URLS[kind] : null;
  // Management links point to PortOS routes. Reject external URL syntax.
  const explicitUrl = typeof notice.manageUrl === 'string' && /^\/[a-z]/i.test(notice.manageUrl);
  const manageUrl = explicitUrl ? notice.manageUrl : fallbackUrl;
  const manageLabel = notice.manageLabel || (fallbackUrl ? `Open the ${LOCAL_RUNTIME_LABELS[kind]} card` : 'Open runtime settings');
  return (
    <p role="alert" className="text-xs text-port-warning flex flex-wrap items-center gap-x-1.5 gap-y-1">
      <span>{notice.message}</span>
      {manageUrl && <Link to={manageUrl} className="text-port-accent hover:underline shrink-0">{manageLabel}</Link>}
    </p>
  );
}

function shellLaunchPath(providerId, cwd) {
  const params = new URLSearchParams({ provider: providerId });
  if (cwd) params.set('cwd', cwd);
  return `/shell?${params}`;
}

const SHELL_LAUNCH_CLASS = 'flex items-center gap-1.5 px-3 py-1.5 pointer-coarse:min-h-11 text-sm bg-port-accent/20 text-port-accent hover:bg-port-accent/30 rounded transition-colors';

// Picking a managed app IS the launch, so the select's empty value is a prompt,
// never a destination. With no app that has a repo path (still loading, failed,
// or none registered) it degrades to the plain home-folder launch.
function ShellLaunchControl({ provider, apps, onLaunch }) {
  const title = `Launch TUI in Shell: ${provider.tuiCommandLine}`;
  const launchable = apps.filter(app => app.repoPath && !app.archived);
  if (launchable.length === 0) {
    return (
      <Link to={shellLaunchPath(provider.id)} className={SHELL_LAUNCH_CLASS} title={title}>
        <Terminal size={14} />
        Launch in Shell
      </Link>
    );
  }
  return (
    <div className="relative" title={title}>
      <Terminal size={14} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-port-accent" />
      <AppContextPicker
        apps={launchable}
        value=""
        label={null}
        ariaLabel="Launch in Shell in app"
        placeholder="Launch in Shell…"
        showRepoPath={false}
        selectClassName={`${SHELL_LAUNCH_CLASS} pl-8 max-w-[14rem] cursor-pointer border-0`}
        onChange={(appId) => {
          const app = launchable.find(a => a.id === appId);
          if (app) onLaunch(app.repoPath);
        }}
      />
    </div>
  );
}
