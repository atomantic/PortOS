export const MANAGED_INKLING_RUNTIMES = {
  splash: {
    label: 'Splash',
    requirement: 'Requires macOS 26.4 or later and an Apple M3 or newer.',
    download: 'Downloads Inkling 2 Mini and its DFlash drafter on first setup. Allow several tens of GB of free disk space.',
    provider: 'When it is ready, enable an existing Splash preset under AI Providers.',
  },
  mkserve: {
    label: 'mkserve',
    requirement: 'This Inkling 2 Mini build requires an Apple M5 Max with at least 36 GiB of unified memory.',
    download: 'Downloads about 19 GiB of Inkling 2 Mini weights, plus the runtime and its Python environment.',
    provider: 'When it is ready, add an OpenAI-compatible provider using the endpoint and model ID shown here.',
  },
};

const BUSY_STATES = ['installing', 'updating', 'stopping'];
const ACTION_STATE = { install: 'installing', upgrade: 'updating', start: 'starting', stop: 'stopping' };
const OCCUPIED_STATES = ['external', 'unrecognized', 'not-ready', 'starting', 'running', 'online'];

export function managedInklingRow(id, status, onAction) {
  const { label, requirement, download } = MANAGED_INKLING_RUNTIMES[id];
  const state = ACTION_STATE[status?.operation?.action] || status?.state || 'unknown';
  const idle = status?.supported === true && !status.operation && !BUSY_STATES.includes(state) && !status.installing;
  const occupied = OCCUPIED_STATES.includes(state);
  const canChangeInstall = idle && !occupied && status.canInstall !== false;
  const updateAvailable = Boolean(status?.installed && status.updateAvailable);
  const launch = (action) => () => onAction(id, action);
  const versionLabel = (version) => /^[0-9a-f]{40}$/.test(version || '') ? version.slice(0, 12) : version;
  return {
    id,
    label,
    state: state === 'online' ? 'running' : state,
    endpoint: status?.endpoint,
    model: status?.model,
    version: versionLabel(status?.version),
    latestVersion: versionLabel(status?.targetVersion || status?.availableVersion),
    updateAvailable,
    progress: status?.operation?.message,
    error: status?.lastError,
    detail: status?.reason || (status?.supported === false ? requirement
      : occupied && !status?.managed ? 'PortOS doesn’t control this process. Free the preset port before starting the managed runtime.'
        : state === 'missing' ? download
          : updateAvailable && occupied ? 'Stop the managed runtime before updating it.' : null),
    onInstall: canChangeInstall && !status.installed ? launch('install') : null,
    onUpgrade: canChangeInstall && updateAvailable ? launch('upgrade') : null,
    onStart: idle && status.installed && !occupied && status.canStart !== false ? launch('start') : null,
    onStop: idle && status.managed === true && occupied ? launch('stop') : null,
  };
}
