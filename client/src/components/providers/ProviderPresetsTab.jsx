import { Link } from 'react-router';
import ProviderModelSelector from '../ProviderModelSelector';
import { filterSelectableModels, isApiProvider, isCodexSubscriptionProvider, isLocalEndpoint, isProcessProvider, providerTypeClass } from '../../utils/providers';
import { formatCount } from '../../utils/formatters';
import ListLoadError from '../ui/ListLoadError';
import EmptyState from '../EmptyState';
import Banner from '../ui/Banner';
import CollapsibleSection from '../ui/CollapsibleSection';
import LocalPersistentMindSetupCard from '../settings/LocalPersistentMindSetupCard.jsx';
import DefaultProviderHelper from './DefaultProviderHelper';
import FleetHostSetup from './FleetHostSetup';
import ProviderCard from './ProviderCard';
import ProviderCompatibilityMatrix from './ProviderCompatibilityMatrix';
import MoaPresetsSection from './MoaPresetsSection';
import ProviderEnvVars from './ProviderEnvVars';
import RetiredModelPinsPanel from './RetiredModelPinsPanel';

export default function ProviderPresetsTab({
  providers,
  providersById,
  presetSections,
  cardStateByProviderId,
  runtimeByProviderId,
  readiness,
  statuses,
  activeProviderId,
  defaultProvider,
  runnerAllowedCommands,
  testResults,
  refreshing,
  refreshNotice = {},
  recovering,
  addingTuiMode,
  servingModel,
  codexAccount,
  codexModels,
  codexAccountLoading,
  codexLoginLoading,
  loadError,
  modelPinReloadKey,
  showSamples,
  setShowSamples,
  loadingSamples,
  samplesState,
  samplesError,
  retrySamples,
  sampleProviders,
  addableSamples,
  addingSample,
  onAddSample,
  onAddAllSamples,
  showRunPanel,
  apps,
  appsState,
  appsError,
  retryApps,
  selectedWorkspace,
  setSelectedWorkspace,
  runPrompt,
  setRunPrompt,
  activeRun,
  runOutput,
  runProviderIsTui,
  onExecuteRun,
  onStopRun,
  compositionCatalog,
  onCompose,
  onScrollToDefaultCard,
  onReload,
  onTest,
  onRefreshModels,
  onToggleEnabled,
  onSetActive,
  onEdit,
  onDelete,
  onAddTuiMode,
  onRecover,
  onInstallRuntime,
  onAutoSetupRuntime,
  onUseServedModel,
  onServeWantedModel,
  onCodexCheckAccount,
  onCodexSignIn,
  onCodexCancelLogin,
  onCodexLogout,
  onCodexRefreshModels,
  onCodexCopyCode,
  onCodexEnable,
}) {
  return (
    <>
      {!loadError && (
        <DefaultProviderHelper
          provider={defaultProvider}
          onScrollToCard={onScrollToDefaultCard}
        />
      )}

      {/* A retirement only becomes observable when a catalog refresh lands, so
          the panel re-reads on every refresh — see RetiredModelPinsPanel. */}
      <RetiredModelPinsPanel reloadKey={modelPinReloadKey} />

      <LocalPersistentMindSetupCard compact onApplied={onReload} />
      <FleetHostSetup compact providers={providers} />

      {/* Sample Providers Panel */}
      {showSamples && (
        <div className="bg-port-card border border-port-border rounded-xl p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">Sample Providers</h2>
            <div className="flex gap-2">
              {addableSamples.length > 1 && (
                <button
                  onClick={onAddAllSamples}
                  className="px-3 py-1.5 text-sm bg-port-accent hover:bg-port-accent/80 text-white rounded transition-colors"
                >
                  Add All ({addableSamples.length})
                </button>
              )}
              <button
                onClick={() => setShowSamples(false)}
                className="px-3 py-1.5 text-sm text-gray-400 hover:text-white"
              >
                Close
              </button>
            </div>
          </div>

          {loadingSamples ? (
            <div className="text-center py-6 text-gray-400">Loading sample providers...</div>
          ) : samplesState === 'error' ? (
            <ListLoadError what="sample providers" error={samplesError} onRetry={retrySamples} />
          ) : addableSamples.length === 0 ? (
            <div className="text-center py-6 text-gray-500">
              {sampleProviders.length === 0
                ? 'All sample providers are already in your configuration.'
                : 'The remaining sample providers cannot run on this machine’s hardware.'}
            </div>
          ) : (
            <div className="grid gap-3">
              {addableSamples.map(provider => (
                <div
                  key={provider.id}
                  className="bg-port-bg border border-port-border rounded-lg p-3 flex flex-col sm:flex-row sm:items-start justify-between gap-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold text-white">{provider.name}</h3>
                      <span className={`text-xs px-2 py-0.5 rounded ${providerTypeClass(provider.type)}`}>
                        {provider.type.toUpperCase()}
                      </span>
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
                      {!provider.enabled && (
                        <span className="text-xs px-2 py-0.5 rounded bg-gray-500/20 text-gray-400">
                          DISABLED
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-gray-400 space-y-0.5">
                      {isProcessProvider(provider) && (
                        <p>Command: <code className="text-gray-300">{provider.command} {provider.args?.join(' ')}</code></p>
                      )}
                      {isApiProvider(provider) && (
                        <p>Endpoint: <code className="text-gray-300">{provider.endpoint}</code></p>
                      )}
                      {isApiProvider(provider) && !isLocalEndpoint(provider.endpoint) && (
                        <p className="text-port-warning">Needs an API key — after adding, use Edit to paste it</p>
                      )}
                      {filterSelectableModels(provider.models).length > 0 && (
                        <p>Models: {filterSelectableModels(provider.models).slice(0, 3).join(', ')}{filterSelectableModels(provider.models).length > 3 ? ` +${filterSelectableModels(provider.models).length - 3}` : ''}</p>
                      )}
                      {/* The card's model line shows the SCOPED list, so say when a
                          model-access policy is what makes it short — otherwise a
                          user comparing it against the vendor's catalog reads a
                          deliberate scope as a failed refresh. */}
                      {provider.modelAccessHiddenCount > 0 && (
                        <p className="text-gray-500">
                          {formatCount(provider.modelAccessHiddenCount)} more hidden by model access
                          {provider.modelAccessSource && provider.modelAccessSource !== 'own'
                            ? ` (from ${provider.modelAccessSource})` : ''}
                        </p>
                      )}
                      {provider.envVars && Object.keys(provider.envVars).length > 0 && (
                        <ProviderEnvVars
                          envVars={provider.envVars}
                          secretEnvVars={provider.secretEnvVars}
                          className="mt-0.5"
                        />
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => onAddSample(provider)}
                    disabled={Boolean(addingSample[provider.id])}
                    className="px-4 py-1.5 text-sm bg-port-success/20 text-port-success hover:bg-port-success/30 rounded transition-colors disabled:opacity-50 shrink-0"
                  >
                    {addingSample[provider.id] ? 'Adding...' : 'Add'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Run Panel */}
      {showRunPanel && (
        <div className="bg-port-card border border-port-border rounded-xl p-4 space-y-4">
          <div className="flex flex-col sm:flex-row gap-2 sm:gap-4">
            {/* `activeProvider` is always a PRESET id (epic #7561), so the
                compose entry is off here — the picker cannot hand it a composite. */}
            <div className="w-full sm:w-64">
              <ProviderModelSelector
                compact
                compose={false}
                label="Active provider"
                providers={providers}
                selectedProviderId={activeProviderId || ''}
                emptyProviderOption="Select Provider"
                onProviderChange={onSetActive}
              />
            </div>

            {appsState === 'error' && (
              <ListLoadError what="workspaces" error={appsError} onRetry={retryApps} />
            )}
            {appsState !== 'error' && (
              <select
                aria-label="Workspace"
                value={selectedWorkspace}
                onChange={(e) => setSelectedWorkspace(e.target.value)}
                className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white w-full sm:w-auto"
              >
                <option value="">{appsState === 'ready' && apps.length === 0 ? 'No workspaces found' : 'No workspace'}</option>
                {apps.map(app => (
                  <option key={app.id} value={app.id}>{app.name}</option>
                ))}
              </select>
            )}
          </div>

          <textarea
            aria-label="Prompt"
            value={runPrompt}
            onChange={(e) => setRunPrompt(e.target.value)}
            placeholder="Enter your prompt..."
            rows={3}
            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white resize-none focus:border-port-accent focus:outline-hidden"
          />

          <div className="flex justify-between items-center">
            <button
              onClick={onExecuteRun}
              disabled={!runPrompt.trim() || !activeProviderId || activeRun}
              className="px-6 py-2 bg-port-success hover:bg-port-success/80 text-white rounded-lg transition-colors disabled:opacity-50"
            >
              {activeRun ? 'Running...' : 'Execute'}
            </button>

            {activeRun && (
              <button
                onClick={onStopRun}
                className="px-4 py-2 bg-port-error hover:bg-port-error/80 text-white rounded-lg transition-colors"
              >
                Stop
              </button>
            )}
          </div>

          {runProviderIsTui && (
            <div className="text-xs text-port-accent bg-port-accent/10 border border-port-accent/20 rounded-lg px-3 py-2">
              TUI providers spawn a PTY-backed run that streams output here and is stoppable from the run list.
            </div>
          )}

          {runOutput && (
            <div className="bg-port-bg border border-port-border rounded-lg p-3 max-h-64 overflow-auto">
              <pre className="text-sm text-gray-300 font-mono whitespace-pre-wrap break-all">{runOutput}</pre>
            </div>
          )}
        </div>
      )}

      {/* Every harness × service pair the server would offer, and a click into
          the compose flow on it. Derived from the same catalog every picker
          reads, so it can never disagree with what compose lists. */}
      <ProviderCompatibilityMatrix
        harnesses={compositionCatalog.harnesses}
        services={compositionCatalog.services}
        compatibility={compositionCatalog.compatibility}
        loading={compositionCatalog.loading}
        onCompose={onCompose}
      />

      {/* Preset list, grouped by harness (see PRESET_STATE_ORDER) */}
      <div className="grid gap-6">
        {loadError ? (
          <Banner
            tone="error"
            size="md"
            title="Failed to load AI providers"
            actions={(
              <button
                type="button"
                onClick={onReload}
                className="px-3 py-1.5 rounded-lg text-xs bg-port-error/20 hover:bg-port-error/30 text-port-error font-medium transition-colors"
              >
                Retry
              </button>
            )}
          >
            Could not connect to the server to fetch provider configuration.
          </Banner>
        ) : (
          <>
            {presetSections.map(section => {
              const sectionProviders = section.providers;
              return (
                <CollapsibleSection
                  key={section.key}
                  size="lg"
                  defaultOpen={section.defaultOpen}
                  buttonClassName="flex-wrap border-b border-port-border/60 pb-1.5"
                  bodyClassName="grid gap-4 pt-3"
                  label={(
                    <span className="flex flex-wrap items-center gap-2">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${section.dot}`} aria-hidden="true" />
                      <span className="text-sm font-semibold uppercase tracking-wide text-white">{section.title}</span>
                      <span className="text-xs px-1.5 py-0.5 rounded bg-port-bg text-gray-400">{sectionProviders.length}</span>
                      <span className="text-xs text-gray-500">
                        {section.hint || `${formatCount(section.ready)} of ${formatCount(sectionProviders.length)} can run`}
                      </span>
                    </span>
                  )}
                  headerActions={section.link ? (
                    <Link to={section.link} className="text-xs text-port-accent hover:underline">
                      harness →
                    </Link>
                  ) : null}
                >
                  {sectionProviders.map(provider => (
                    <ProviderCard
                      key={provider.id}
                      provider={provider}
                      cardState={cardStateByProviderId[provider.id]}
                      daemonReadiness={readiness[provider.id]}
                      runtime={runtimeByProviderId[provider.id]}
                      status={statuses[provider.id]}
                      isDefault={provider.id === activeProviderId}
                      providersById={providersById}
                      activeProviderId={activeProviderId}
                      statuses={statuses}
                      runnerAllowedCommands={runnerAllowedCommands}
                      testResult={testResults[provider.id]}
                      refreshing={Boolean(refreshing[provider.id])}
                      refreshNotice={refreshNotice[provider.id] || null}
                      recovering={Boolean(recovering[provider.id])}
                      onTest={onTest}
                      onRefreshModels={onRefreshModels}
                      onToggleEnabled={onToggleEnabled}
                      onSetActive={onSetActive}
                      onEdit={onEdit}
                      onDelete={onDelete}
                      onAddTuiMode={onAddTuiMode}
                      addingTuiMode={Boolean(addingTuiMode[provider.id])}
                      onRecover={onRecover}
                      onInstallRuntime={onInstallRuntime}
                      onAutoSetupRuntime={onAutoSetupRuntime}
                      onUseServedModel={onUseServedModel}
                      onServeWantedModel={onServeWantedModel}
                      servingModel={Boolean(servingModel[provider.id])}
                      codexAccount={isCodexSubscriptionProvider(provider) ? codexAccount : undefined}
                      codexModels={codexModels}
                      codexAccountLoading={codexAccountLoading}
                      codexLoginLoading={codexLoginLoading}
                      onCodexCheckAccount={onCodexCheckAccount}
                      onCodexSignIn={onCodexSignIn}
                      onCodexCancelLogin={onCodexCancelLogin}
                      onCodexLogout={onCodexLogout}
                      onCodexRefreshModels={onCodexRefreshModels}
                      onCodexCopyCode={onCodexCopyCode}
                      onCodexEnable={() => onCodexEnable(provider)}
                    />
                  ))}
                </CollapsibleSection>
              );
            })}

            {providers.length === 0 && (
              <div className="flex flex-col items-center">
                <EmptyState
                  title="No presets configured"
                  message="A preset is a named harness × service combination. Add Preset composes one from a service. Add standalone preset is for a backend no service definition describes."
                  actionLabel="Add Preset"
                  onAction={() => onCompose({})}
                />
                <button
                  type="button"
                  onClick={() => onEdit(null)}
                  className="mb-6 text-sm text-gray-400 underline-offset-2 hover:text-white hover:underline"
                >
                  Add standalone preset
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Virtual presets composed from the API presets above (#17386). */}
      {!loadError && <MoaPresetsSection providers={providers} />}

      {/* Full run history lives on the Chief of Staff → Runs tab; this page
          only configures providers. */}
      <div className="mt-8">
        <Link to="/cos/runs" className="text-sm text-port-accent hover:underline">
          View AI run history →
        </Link>
      </div>
    </>
  );
}
