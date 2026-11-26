import { Gauge, HardDrive, Zap } from 'lucide-react';
import { LOCAL_RUNTIME_LABELS } from '../../../../server/lib/modelPinMembership.js';
import {
  controlManagedInklingRuntime,
  getLlamaServerStatus,
  getLlamaServerUpdateStatus,
  getManagedInklingRuntimeStatus,
  getMtplxServerStatus,
  getSlotstreamServerStatus,
  installLlamaServer,
  installMtplx,
  uninstallMtplx,
  installSlotstream,
  uninstallSlotstream,
  startLlamaServer,
  startMtplxServer,
  startSlotstreamServer,
  stopLlamaServer,
  stopMtplxServer,
  stopSlotstreamServer,
  upgradeLlamaServer,
} from '../../services/apiLocalLlm.js';
import { formatCount } from '../../utils/formatters';

export const RUNTIME_CHANGE_LABELS = { install: 'Install', upgrade: 'Update', repair: 'Repair', uninstall: 'Uninstall' };

/**
 * PM2 status distinguishes our own processes from external ones.
 *
 * These DO distinguish ours from external: `managed === false` while something
 * answers on the port means a server the user started in a terminal, which
 * PortOS must not offer to stop.
 */
function pm2Row({ id, label, icon, status, platformReason, onStart, onStop, onInstall, onUpgrade, onUninstall, startBlockedReason, detail }) {
  const external = status?.running && status?.managed === false;
  const updateAvailable = !platformReason && status?.installed && status?.updateAvailable === true;
  const state = !status ? 'unknown' : platformReason ? 'unsupported'
    : status?.running ? (external ? 'external' : 'running')
      : status?.installed ? 'stopped' : 'missing';
  return {
    id,
    label,
    icon,
    state,
    endpoint: status?.endpoint || null,
    releaseReason: !status?.running && status?.releaseReason ? status.releaseReason : null,
    detail: platformReason || detail || null,
    runAtStartup: status?.runAtStartup ?? null,
    pid: status?.managed && status?.pid ? status.pid : null,
    // `status` is null until the first status response lands. Offering Install then would
    // put a button on a host that turns out not to support the runtime at all.
    onInstall: status && !platformReason && !status.installed ? onInstall : null,
    onStart: !platformReason && status?.installed && !status?.running && !startBlockedReason ? onStart : null,
    startBlockedReason: status?.installed && !status?.running ? startBlockedReason : null,
    onUninstall: !platformReason && status?.canUninstall ? onUninstall : null,
    onStop: !external && status?.running ? onStop : null,
    model: status?.config?.model || status?.model || null,
    version: status?.version || null,
    latestVersion: status?.latestVersion || null,
    updateAvailable,
    // Named in the tooltip so the button never promises the wrong tool.
    updateVia: status?.packageManagerLabel || null,
    onUpgrade: updateAvailable && status?.canUpgrade ? onUpgrade : null,
    updateUrl: updateAvailable && !status?.canUpgrade ? status?.downloadUrl : null,
  };
}

const BUSY_STATES = ['installing', 'updating', 'stopping', 'uninstalling'];
const ACTION_STATE = { install: 'installing', upgrade: 'updating', start: 'starting', stop: 'stopping', uninstall: 'uninstalling' };
const OCCUPIED_STATES = ['external', 'unrecognized', 'not-ready', 'starting', 'running', 'online'];

function bundleRow(status, action) {
  const { id, label, icon, copy: { requirement, download } } = this;
  const state = ACTION_STATE[status?.operation?.action] || status?.state || 'unknown';
  const idle = status?.supported === true && !status.operation && !BUSY_STATES.includes(state) && !status.installing;
  const occupied = OCCUPIED_STATES.includes(state);
  const canChangeInstall = idle && !occupied && status.canInstall !== false;
  const updateAvailable = Boolean(status?.installed && status.updateAvailable);
  const versionLabel = (version) => /^[0-9a-f]{40}$/.test(version || '') ? version.slice(0, 12) : version;
  return {
    id,
    label,
    icon,
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
    onInstall: canChangeInstall && !status.installed ? action('install') : null,
    onRepair: canChangeInstall && status.repairRecommended && !updateAvailable ? action('repair') : null,
    onUpgrade: canChangeInstall && updateAvailable ? action('upgrade') : null,
    onStart: idle && status.installed && !occupied && status.canStart !== false ? action('start') : null,
    onUninstall: idle && !occupied && status.canUninstall ? action('uninstall') : null,
    onStop: idle && status.managed === true && occupied ? action('stop') : null,
  };
}

const PM2_CAPABILITIES = { idleRelease: true, configure: 'pm2', bootPersist: true, confirmInstall: false };
const BUNDLE_CAPABILITIES = { idleRelease: false, configure: 'detail', bootPersist: false, confirmInstall: true };

function bundleApi(id) {
  return {
    status: (options) => getManagedInklingRuntimeStatus(id, options),
    install: () => controlManagedInklingRuntime(id, 'install'),
    start: () => controlManagedInklingRuntime(id, 'start'),
    stop: () => controlManagedInklingRuntime(id, 'stop'),
    upgrade: () => controlManagedInklingRuntime(id, 'upgrade'),
    uninstall: () => controlManagedInklingRuntime(id, 'uninstall'),
  };
}

function checkpointDetail(status) {
  const count = status?.cachedModels?.length;
  return count ? `${formatCount(count)} checkpoint${count === 1 ? '' : 's'} cached` : null;
}

export const LOCAL_RUNTIME_DESCRIPTORS = {
  llama: {
    id: 'llama',
    label: LOCAL_RUNTIME_LABELS.llama,
    icon: Zap,
    kind: 'pm2',
    api: { status: getLlamaServerStatus, install: installLlamaServer, start: startLlamaServer, stop: stopLlamaServer, upgrade: upgradeLlamaServer, updateStatus: getLlamaServerUpdateStatus },
    capabilities: PM2_CAPABILITIES,
    copy: {
      idleRelease: 'Minutes of PortOS inactivity after which llama.cpp unloads the model in place and reloads it on the next request. 0 = keep it resident. Applies from the next start.',
      install: 'llama.cpp installed',
      upgrade: (r) => r?.note || 'llama.cpp updated',
      stop: (r) => r?.message || 'llama-server stopped',
    },
    toRow(status, action) {
      return pm2Row({
        id: this.id,
        label: this.label,
        icon: this.icon,
        status,
        onInstall: action('install'),
        onUpgrade: action('upgrade'),
        onStop: action('stop'),
        // llama-server takes a REQUIRED model path, and which GGUF (plus which
        // drafter and spec type) is a real choice — so there is no honest one-click
        // Start here. The launcher below owns it.
        startBlockedReason: 'Choose Configure to pick a model before starting',
      });
    },
  },
  mtplx: {
    id: 'mtplx',
    label: LOCAL_RUNTIME_LABELS.mtplx,
    icon: Gauge,
    kind: 'pm2',
    api: { status: getMtplxServerStatus, install: installMtplx, uninstall: uninstallMtplx, start: startMtplxServer, stop: stopMtplxServer },
    capabilities: PM2_CAPABILITIES,
    copy: {
      idleRelease: 'Minutes of PortOS inactivity after which MTPLX is stopped. The next PortOS request starts it again on the same checkpoint. 0 = keep it running.',
      install: 'MTPLX installed',
      uninstall: (result) => result.message,
      uninstallDetail: 'Removes the private MTPLX environment installed by PortOS. Downloaded checkpoints, provider presets, and launch settings are kept. An MTPLX installation on PATH is not removed.',
      start: (r) => r?.online ? 'MTPLX is running' : 'MTPLX is loading its checkpoint',
      stop: (r) => r?.message || 'MTPLX stopped',
    },
    toRow(status, action) {
      return pm2Row({
        id: this.id,
        label: this.label,
        icon: this.icon,
        status,
        platformReason: status?.supported === false ? 'macOS with Apple Silicon only' : null,
        onInstall: action('install'),
        onUninstall: action('uninstall'),
        // MTPLX can be started explicitly when a verified checkpoint is cached,
        // and is still restarted automatically before a request after an idle
        // release. Neither path downloads or guesses a model.
        onStart: status?.cachedModels?.length ? action('start') : null,
        onStop: action('stop'),
        startBlockedReason: status?.installed && !status?.running
          ? (status?.cachedModels?.length === 0 && !status?.cacheError
            ? 'No checkpoint yet — use Configure to download one'
            : null)
          : null,
        detail: checkpointDetail(status),
      });
    },
  },
  slotstream: {
    id: 'slotstream',
    label: LOCAL_RUNTIME_LABELS.slotstream,
    icon: HardDrive,
    kind: 'pm2',
    api: { status: getSlotstreamServerStatus, install: installSlotstream, uninstall: uninstallSlotstream, start: startSlotstreamServer, stop: stopSlotstreamServer },
    capabilities: PM2_CAPABILITIES,
    copy: {
      idleRelease: 'Minutes of PortOS inactivity after which Slotstream is stopped. The next PortOS request starts it again on the same checkpoint and memory cap. 0 = keep it running.',
      install: 'Slotstream installed',
      uninstall: (result) => result.message,
      uninstallDetail: 'Removes the Slotstream executable installed by PortOS. Downloaded checkpoints, provider presets, and launch settings are kept for reinstall. Existing Slotstream providers will not work until a server is available again.',
      start: (r) => r?.online ? 'Slotstream is running' : 'Slotstream is loading its checkpoint',
      stop: (r) => r?.message || 'Slotstream stopped',
    },
    toRow(status, action) {
      return pm2Row({
        id: this.id,
        label: this.label,
        icon: this.icon,
        status,
        platformReason: status?.supported === false ? 'macOS with Apple Silicon only' : null,
        onInstall: action('install'),
        onUninstall: action('uninstall'),
        onStart: status?.cachedModels?.length ? action('start') : null,
        onStop: action('stop'),
        // An unreadable cache also leaves `cachedModels` empty, so it withholds
        // Start too — it must say WHY, or the row renders "stopped" with nothing
        // to click and no explanation.
        startBlockedReason: status?.installed && !status?.running
          ? (status?.cacheError
            ? `Checkpoint cache unreadable — ${status.cacheError}`
            : (status?.cachedModels?.length === 0
              ? 'No checkpoint yet — a start never fetches weights'
              : null))
          : null,
        detail: [
          status?.memoryPlan
            && `target ${status.memoryPlan.targetGb} GB${status.memoryPlan.auto ? ' (auto)' : ''} · peak ${status.memoryPlan.expectedPeakGb} GB · ~${status.memoryPlan.expectedWarmDecodeToks} tok/s`,
          checkpointDetail(status),
        ].filter(Boolean).join(' · ') || null,
      });
    },
  },
  splash: {
    id: 'splash',
    label: LOCAL_RUNTIME_LABELS.splash,
    icon: Zap,
    kind: 'bundle',
    api: bundleApi('splash'),
    capabilities: BUNDLE_CAPABILITIES,
    copy: {
      uninstallDetail: 'Removes the PortOS-managed Splash runtime files. Downloaded models and provider presets are kept for reinstall. Existing providers for this server will not work until a server is available again.',
      requirement: 'Requires macOS 26.4 or later and an Apple M3 or newer.',
      download: 'First setup downloads about 17 GB for Inkling 2 Mini and its DFlash drafter. Leave additional room for the prepared cache.',
      provider: 'When it is ready, enable an existing Splash preset under AI Providers.',
    },
    toRow: bundleRow,
  },
  mkserve: {
    id: 'mkserve',
    label: LOCAL_RUNTIME_LABELS.mkserve,
    icon: Zap,
    kind: 'bundle',
    api: bundleApi('mkserve'),
    capabilities: BUNDLE_CAPABILITIES,
    copy: {
      uninstallDetail: 'Removes the PortOS-managed mkserve runtime files. Downloaded models and provider presets are kept for reinstall. Existing providers for this server will not work until a server is available again.',
      requirement: 'Requires macOS 26 or later and an Apple M5 Max with at least 36 GiB of unified memory.',
      download: 'Downloads about 19 GiB of Inkling 2 Mini weights, plus the runtime and its Python environment.',
      provider: 'When it is ready, add an OpenAI-compatible provider using the endpoint and model ID shown here.',
    },
    toRow: bundleRow,
  },
};
