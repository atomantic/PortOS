import { useState } from 'react';
import { Link } from 'react-router';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import ToggleSwitch from '../ToggleSwitch';
import { useInstanceFeatures, publishInstanceFeatures } from '../../hooks/useInstanceFeatures.js';
import { isGitHubRepoUrl } from '../../lib/githubRepoUrl.js';
import { getPrimaryLaunchUrl } from '../../services/appUrls.js';
import { installEidoverseFeature, updateInstanceFeature } from '../../services/api';

// How the current value was decided, so a user who never touched the toggle can
// see that the install picked it up from a configured integration rather than
// guessing why a section is missing from the sidebar.
const sourceHint = (feature) => {
  if (feature.source !== 'auto') return null;
  return feature.enabled
    ? `Detected automatically — this install has ${feature.label} configured.`
    : `Detected automatically — no ${feature.label} instance is configured yet.`;
};

export function InstanceFeaturesTab() {
  const { features, error, reload } = useInstanceFeatures();
  const [savingId, setSavingId] = useState(null);
  const [eidoverseRepoUrl, setEidoverseRepoUrl] = useState(null);
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
          const setup = isEidoverse ? feature.setup : null;
          const needsInstall = isEidoverse && setup?.installed !== true;
          const installing = savingId === feature.id;
          const selectedRepoUrl = eidoverseRepoUrl ?? setup?.worldsRepoUrl ?? '';
          const repoIsValid = isGitHubRepoUrl(selectedRepoUrl);
          const canInstall = repoIsValid && setup?.bunAvailable === true && setup?.registryAvailable !== false;
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
                {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
                {needsInstall && (
                  <div className="mt-3 space-y-1 text-xs text-gray-400">
                    <p>
                      PortOS will clone your selected Worlds repository and the upstream video runtime as separate AGPL-3.0 repositories, install their Bun dependencies, and register Worlds under Apps. It will not start the server automatically.
                    </p>
                    <label className="block pt-2" htmlFor="eidoverse-worlds-repo">
                      <span className="block text-gray-300 mb-1">Worlds GitHub repository</span>
                      <input
                        id="eidoverse-worlds-repo"
                        type="url"
                        required
                        value={selectedRepoUrl}
                        onChange={(event) => setEidoverseRepoUrl(event.target.value)}
                        disabled={savingId !== null}
                        aria-invalid={!repoIsValid}
                        aria-describedby={!repoIsValid ? 'eidoverse-worlds-repo-error' : undefined}
                        className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden disabled:opacity-50"
                        placeholder="https://github.com/your-account/eidoverse-worlds"
                      />
                    </label>
                    {!repoIsValid && (
                      <p id="eidoverse-worlds-repo-error" role="alert" className="text-port-error">
                        {selectedRepoUrl === ''
                          ? 'Enter a GitHub repository URL.'
                          : 'Enter a valid GitHub repository URL.'}
                      </p>
                    )}
                    <p>Use your own fork if you want PortOS agents to prepare changes and PRs against it.</p>
                    {setup?.bunAvailable === false && (
                      <p className="text-port-warning">
                        Bun is required. <a className="underline hover:text-white" href="https://bun.sh" target="_blank" rel="noreferrer">Install Bun</a>, then retry.
                      </p>
                    )}
                    {setup?.registryAvailable === false && (
                      <p className="text-port-error">The managed-app registry could not be read. Repair that before installing to avoid a duplicate app record.</p>
                    )}
                    {(setup?.bunAvailable === false || setup?.registryAvailable === false) && (
                      <button
                        type="button"
                        onClick={handleEidoverseRecheck}
                        disabled={recheckingEidoverse}
                        className="inline-flex items-center justify-center min-h-[44px] px-3 mt-2 text-sm bg-port-border hover:bg-port-border/70 disabled:opacity-50 text-white rounded transition-colors"
                      >
                        {recheckingEidoverse ? 'Rechecking…' : 'Recheck requirements'}
                      </button>
                    )}
                  </div>
                )}
                {setup?.installed && (
                  <div className="flex flex-wrap items-center gap-3 mt-3 text-xs">
                    {setup.worldsRepoUrl && (
                      <a className="text-port-accent hover:text-white transition-colors" href={setup.worldsRepoUrl} target="_blank" rel="noreferrer">
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
