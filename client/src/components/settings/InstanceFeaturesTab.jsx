import { useState } from 'react';
import { Link } from 'react-router';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import ToggleSwitch from '../ToggleSwitch';
import RiggingRuntimeCard from './RiggingRuntimeCard';
import { useInstanceFeatures, publishInstanceFeatures } from '../../hooks/useInstanceFeatures.js';
import { isGitHubRepoUrl, parseGitHubUrl } from '../../lib/repoUrl.js';
import { getPrimaryLaunchUrl } from '../../services/appUrls.js';
import { installEidoverseFeature, updateEidoverseWorldsSource, updateInstanceFeature } from '../../services/api';

// How the current value was decided, so a user who never touched the toggle can
// see that the install picked it up from a configured integration rather than
// guessing why a section is missing from the sidebar.
const sourceHint = (feature) => {
  if (feature.source !== 'auto') return null;
  return feature.enabled
    ? `Detected automatically — this install has ${feature.label} configured.`
    : `Detected automatically — no ${feature.label} instance is configured yet.`;
};

const normalizeGitHubRepo = (url) => {
  const parsed = parseGitHubUrl(url);
  if (!parsed) return null;
  return /^git@github\.com:/i.test(String(url).trim())
    ? `git@github.com:${parsed.owner}/${parsed.repo}.git`
    : `https://github.com/${parsed.owner}/${parsed.repo}`;
};

const buildEidoverseRepoUrl = (owner, transport) => (
  transport === 'ssh'
    ? `git@github.com:${owner}/eidoverse-worlds.git`
    : `https://github.com/${owner}/eidoverse-worlds`
);

const eidoverseTransport = (url) => (/^git@github\.com:/i.test(String(url).trim()) ? 'ssh' : 'http');

const githubBrowseUrl = (url) => {
  const parsed = parseGitHubUrl(url);
  return parsed ? `https://github.com/${parsed.owner}/${parsed.repo}` : null;
};

const SourceChoiceButton = ({ active, children, disabled = false, onClick }) => (
  <button
    type="button"
    aria-pressed={active}
    disabled={disabled}
    onClick={onClick}
    className={`min-h-[36px] px-3 py-1.5 text-xs rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${active
      ? 'bg-port-accent text-white'
      : 'text-gray-400 hover:text-white hover:bg-port-border/70'}`}
  >
    {children}
  </button>
);

export function InstanceFeaturesTab() {
  const { features, error, reload } = useInstanceFeatures();
  const [savingId, setSavingId] = useState(null);
  const [eidoverseRepoUrl, setEidoverseRepoUrl] = useState(null);
  const [updatingEidoverseSource, setUpdatingEidoverseSource] = useState(false);
  const [recheckingEidoverse, setRecheckingEidoverse] = useState(false);

  // The toggle is announced on the shared INSTANCE_FEATURES_CHANGED channel, so
  // the sidebar, the ⌘K palette, and the dashboard widgets that already listen
  // all follow it — no reload, and no second broadcast path to keep in step.
  const handleToggle = async (feature) => {
    if (!feature?.id || savingId) return;
    const enabled = !feature.enabled;
    setSavingId(feature.id);

    const result = await updateInstanceFeature(feature.id, enabled, { silent: true }).catch((err) => {
      toast.error(err.message || `Could not update ${feature.label}`);
      return null;
    });

    if (result) publishInstanceFeatures(result.features, { featureId: feature.id, enabled });
    setSavingId(null);
  };

  const handleEidoverseInstall = async (feature) => {
    if (savingId) return;
    const worldsRepoUrl = eidoverseRepoUrl ?? feature?.setup?.worldsRepoUrl;
    if (!worldsRepoUrl) return;
    setSavingId(feature.id);
    const result = await installEidoverseFeature(worldsRepoUrl, { silent: true }).catch((err) => {
      toast.error(err.message || 'Could not install Eidoverse Worlds');
      return null;
    });

    if (result) {
      publishInstanceFeatures(result.features, { featureId: feature.id, enabled: true });
      toast.success('Eidoverse Worlds is installed and ready to start');
    }
    setSavingId(null);
  };

  const handleEidoverseSourceUpdate = async (feature) => {
    if (savingId) return;
    const worldsRepoUrl = eidoverseRepoUrl ?? feature?.setup?.worldsRepoUrl;
    if (!worldsRepoUrl || !isGitHubRepoUrl(worldsRepoUrl)) return;
    setUpdatingEidoverseSource(true);
    setSavingId(feature.id);
    const result = await updateEidoverseWorldsSource(worldsRepoUrl, { silent: true }).catch((err) => {
      toast.error(err.message || 'Could not update the Eidoverse Worlds source');
      return null;
    });

    if (result) {
      setEidoverseRepoUrl(null);
      publishInstanceFeatures(result.features, { featureId: feature.id, enabled: feature.enabled });
      toast.success('Eidoverse Worlds GitHub origin updated');
    }
    setUpdatingEidoverseSource(false);
    setSavingId(null);
  };

  const handleEidoverseRecheck = () => {
    if (recheckingEidoverse) return;
    setRecheckingEidoverse(true);
    reload()
      .catch((err) => toast.error(err.message || 'Could not recheck Eidoverse requirements'))
      .finally(() => setRecheckingEidoverse(false));
  };

  if (error) {
    return (
      <div className="space-y-3 max-w-3xl">
        <p className="text-sm text-port-error">{error.message || 'Failed to load instance features'}</p>
        <button
          type="button"
          onClick={reload}
          className="inline-flex items-center justify-center min-h-[44px] px-3 text-sm bg-port-border hover:bg-port-border/70 text-white rounded transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  if (features === null) return <BrailleSpinner text="Loading instance features" />;

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h2 className="text-lg font-semibold text-white">Instance features</h2>
        <p className="text-sm text-gray-400 mt-1">
          Choose which optional PortOS features this install actively uses. A disabled feature drops out of the sidebar and the ⌘K palette, and stops contributing passive metrics, reminders, and proactive prompts — its pages stay reachable by direct link.
        </p>
      </div>

      <div className="space-y-3">
        {features.map((feature) => {
          const hint = sourceHint(feature);
          const isEidoverse = feature.id === 'eidoverse';
          // Rigging's "configured" state is a machine-local runtime rather than a
          // config file, so its row carries the probe's answer (installed/absent, the
          // resolved interpreter, the module version, the install command).
          const isRigging = feature.id === 'rigging';
          const setup = isEidoverse ? feature.setup : null;
          const needsInstall = isEidoverse && setup?.installed !== true;
          const installing = savingId === feature.id;
          const selectedRepoUrl = eidoverseRepoUrl ?? setup?.worldsRepoUrl ?? '';
          const selectedRepo = parseGitHubUrl(selectedRepoUrl);
          const selectedTransport = eidoverseTransport(selectedRepoUrl);
          const selfOwner = setup?.sourceOwners?.self || null;
          const upstreamOwner = setup?.sourceOwners?.upstream || 'anima-research';
          const worldsBrowseUrl = githubBrowseUrl(setup?.worldsRepoUrl);
          const repoIsValid = isGitHubRepoUrl(selectedRepoUrl);
          const canInstall = repoIsValid && setup?.registryAvailable !== false;
          const canUpdateSource = repoIsValid
            && normalizeGitHubRepo(selectedRepoUrl) !== setup?.worldsRepoUrl
            && setup?.registryAvailable !== false;
          const launchUrl = setup?.appId && setup?.uiPort
            ? getPrimaryLaunchUrl({ id: setup.appId, uiPort: setup.uiPort })
            : null;
          return (
            <div
              key={feature.id}
              className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 bg-port-card border border-port-border rounded-lg p-4"
            >
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-white">{feature.label}</h3>
                <p className="text-sm text-gray-400 mt-1">{feature.description}</p>
                <p className={`text-xs mt-2 ${feature.enabled ? 'text-port-success' : 'text-gray-500'}`}>
                  {needsInstall
                    ? (setup?.partial ? 'Installation needs to be resumed' : 'Not installed')
                    : (feature.enabled
                      ? 'Active on this instance'
                      : (isEidoverse ? 'Installed but disabled on this instance' : 'Not used on this instance'))}
                </p>
                {hint && !isRigging && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
                {/* Rigging's own card states the runtime's status precisely; the
                    generic "no <label> instance is configured" hint would talk about
                    an integration this feature does not have. */}
                {isRigging && <RiggingRuntimeCard />}
                {isEidoverse && (
                  <div className="mt-3 space-y-1 text-xs text-gray-400">
                    {needsInstall && <p>
                      PortOS will install Bun if needed, clone your selected Worlds repository and the upstream video runtime as separate AGPL-3.0 repositories, install their dependencies, and register Worlds under Apps. It will not start the server automatically.
                    </p>}
                    <div className="pt-2">
                      <label className="block text-gray-300 mb-1" htmlFor="eidoverse-worlds-repo">
                        Worlds GitHub repository
                      </label>
                      <span className="flex flex-wrap gap-2 mb-2">
                        <span role="group" aria-label="Worlds repository owner" className="inline-flex gap-1 rounded-lg border border-port-border p-1">
                          <SourceChoiceButton
                            active={Boolean(selfOwner) && selectedRepo?.owner?.toLowerCase() === selfOwner.toLowerCase()}
                            disabled={savingId !== null || !selfOwner}
                            onClick={() => setEidoverseRepoUrl(buildEidoverseRepoUrl(selfOwner, selectedTransport))}
                          >
                            Self
                          </SourceChoiceButton>
                          <SourceChoiceButton
                            active={selectedRepo?.owner?.toLowerCase() === upstreamOwner.toLowerCase()}
                            disabled={savingId !== null}
                            onClick={() => setEidoverseRepoUrl(buildEidoverseRepoUrl(upstreamOwner, selectedTransport))}
                          >
                            Upstream
                          </SourceChoiceButton>
                        </span>
                        <span role="group" aria-label="Worlds repository protocol" className="inline-flex gap-1 rounded-lg border border-port-border p-1">
                          <SourceChoiceButton
                            active={selectedTransport === 'http'}
                            disabled={savingId !== null || !selectedRepo}
                            onClick={() => setEidoverseRepoUrl(buildEidoverseRepoUrl(selectedRepo.owner, 'http'))}
                          >
                            HTTP
                          </SourceChoiceButton>
                          <SourceChoiceButton
                            active={selectedTransport === 'ssh'}
                            disabled={savingId !== null || !selectedRepo}
                            onClick={() => setEidoverseRepoUrl(buildEidoverseRepoUrl(selectedRepo.owner, 'ssh'))}
                          >
                            SSH
                          </SourceChoiceButton>
                        </span>
                      </span>
                      <input
                        id="eidoverse-worlds-repo"
                        type="text"
                        required
                        value={selectedRepoUrl}
                        onChange={(event) => setEidoverseRepoUrl(event.target.value)}
                        disabled={savingId !== null}
                        aria-invalid={!repoIsValid}
                        aria-describedby={!repoIsValid ? 'eidoverse-worlds-repo-error' : undefined}
                        className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden disabled:opacity-50"
                        placeholder="https://github.com/example-owner/eidoverse-worlds"
                      />
                    </div>
                    {!repoIsValid && (
                      <p id="eidoverse-worlds-repo-error" role="alert" className="text-port-error">
                        {selectedRepoUrl === ''
                          ? 'Enter a GitHub repository URL.'
                          : 'Enter a valid GitHub repository URL.'}
                      </p>
                    )}
                    <p>
                      {needsInstall
                        ? 'Use your own fork if you want PortOS agents to prepare changes and PRs against it.'
                        : 'Changing this updates the installed checkout’s Git origin in place. Local work, the managed-app path, and world data stay untouched.'}
                    </p>
                    {!needsInstall && (
                      <button
                        type="button"
                        onClick={() => handleEidoverseSourceUpdate(feature)}
                        disabled={savingId !== null || !canUpdateSource}
                        className="inline-flex items-center justify-center min-h-[44px] px-3 mt-2 text-sm bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded transition-colors"
                      >
                        {updatingEidoverseSource ? 'Updating source…' : 'Update source'}
                      </button>
                    )}
                    {needsInstall && <>
                      {setup?.bunAvailable === false && (
                        <p className="text-port-warning">
                          Bun is not installed. PortOS will install it automatically when you install and enable Eidoverse Worlds.
                        </p>
                      )}
                      {setup?.registryAvailable === false && (
                        <p className="text-port-error">The managed-app registry could not be read. Repair that before installing to avoid a duplicate app record.</p>
                      )}
                      {setup?.registryAvailable === false && (
                        <button
                          type="button"
                          onClick={handleEidoverseRecheck}
                          disabled={recheckingEidoverse}
                          className="inline-flex items-center justify-center min-h-[44px] px-3 mt-2 text-sm bg-port-border hover:bg-port-border/70 disabled:opacity-50 text-white rounded transition-colors"
                        >
                          {recheckingEidoverse ? 'Rechecking…' : 'Recheck requirements'}
                        </button>
                      )}
                    </>}
                  </div>
                )}
                {setup?.installed && (
                  <div className="flex flex-wrap items-center gap-3 mt-3 text-xs">
                    {worldsBrowseUrl && (
                      <a className="text-port-accent hover:text-white transition-colors" href={worldsBrowseUrl} target="_blank" rel="noreferrer">
                        Worlds repository
                      </a>
                    )}
                    {setup.appId && (
                      <Link className="text-port-accent hover:text-white transition-colors" to={`/apps/${setup.appId}`}>
                        Manage app
                      </Link>
                    )}
                    {feature.enabled && setup.runtimeStatus === 'online' && launchUrl && (
                      <a className="text-port-accent hover:text-white transition-colors" href={launchUrl} target="_blank" rel="noreferrer">
                        Open world
                      </a>
                    )}
                    {feature.enabled && setup.runtimeStatus !== 'online' && (
                      <span className="text-gray-500">Start it from the managed app to enter the world.</span>
                    )}
                  </div>
                )}
              </div>
              {needsInstall ? (
                <button
                  type="button"
                  onClick={() => handleEidoverseInstall(feature)}
                  disabled={savingId !== null || !canInstall}
                  className="shrink-0 inline-flex items-center justify-center min-h-[44px] px-3 text-sm bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded transition-colors"
                >
                  {installing ? 'Installing…' : (setup?.partial ? 'Resume install' : 'Install & enable')}
                </button>
              ) : (
                <ToggleSwitch
                  enabled={feature.enabled}
                  onChange={() => handleToggle(feature)}
                  disabled={savingId !== null}
                  ariaLabel={`${feature.enabled ? 'Disable' : 'Enable'} ${feature.label} on this instance`}
                  className="mt-1"
                />
              )}
            </div>
          );
        })}
        {features.length === 0 && (
          <div className="bg-port-card border border-port-border rounded-lg p-4 text-sm text-gray-400">
            No optional features are registered for this version of PortOS.
          </div>
        )}
      </div>
    </div>
  );
}

export default InstanceFeaturesTab;
