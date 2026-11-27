/** Upgrade the llama.cpp binary and restore the managed server and tuning baseline around package changes. */

import { PORTS } from '../lib/ports.js';
import { getLlamaServerInstallPlan, resolveLlamaServerBinary, updateLlamaServerPackage, upgradePreflight } from './llamaServerInstall.js';
import {
  llamaLaunchState, readLlamaServerLaunch, startLlamaServerUnlocked, stopLlamaServer,
  waitForLlamaServerReady, waitForPortRelease, clearSleepIdleSupport,
} from './llamaServerLifecycle.js';

/**
 * Put a managed server back after an upgrade attempt. The model may take longer
 * than the normal port-release race, so wait before asking `startLlamaServer`
 * to validate the preserved launch configuration.
 */
async function restartManagedLlamaServer(config, baseline) {
  await waitForPortRelease(config.port ?? PORTS.LLAMA_SERVER);
  // The recovered PM2 config carries the effective idle flag from the old
  // process. Leave this field undefined so startLlamaServer reads the current
  // saved setting when an upgrade is also the next launch.
  const started = await startLlamaServerUnlocked({ ...config, sleepIdleMinutes: undefined }).catch((err) => {
    console.error(`❌ llama-server: could not restore the previous configuration after update: ${err.message}`);
    return null;
  });
  if (!started) return null;
  const ready = started.online ? { ready: true } : await waitForLlamaServerReady(started.endpoint);
  if (!ready.ready) {
    console.error(`❌ llama-server: restored process never answered after update (${ready.reason})`);
    await stopLlamaServer().catch(() => {});
    return null;
  }
  llamaLaunchState.preTuningConfig = baseline;
  return started;
}

async function upgradeFailureResult(message, managedConfig, baseline, updated = false) {
  const restored = managedConfig ? await restartManagedLlamaServer(managedConfig, baseline) : null;
  const restoreNote = managedConfig && !restored
    ? ' PortOS could not restore the llama-server process.'
    : '';
  return {
    success: false,
    ...(updated ? { updated: true } : {}),
    error: `${message}${restoreNote}`,
  };
}

/**
 * Upgrade a package-manager-installed llama.cpp binary in place.
 *
 * A managed llama-server is stopped before the package manager swaps the binary
 * and then restarted with the exact launch configuration it was using. An
 * external process is never stopped; changing the package only takes effect for
 * it when its owner starts it again.
 */
export async function upgradeLlamaServerUnlocked({ onProgress = () => {} } = {}) {
  const plan = getLlamaServerInstallPlan();
  const binaryPath = resolveLlamaServerBinary();
  const refusal = await upgradePreflight(plan, binaryPath);
  if (refusal) return refusal;

  const launch = await readLlamaServerLaunch();
  if (launch.readFailed) {
    return {
      success: false,
      error: 'PortOS could not read PM2 to determine whether it owns llama-server. Try the update again in a moment.',
    };
  }
  if (launch.managed && !launch.config?.model) {
    return {
      success: false,
      error: 'PortOS could not recover llama-server\'s launch configuration, so it left the running process untouched.',
    };
  }
  const managedConfig = launch.managed ? launch.config : null;
  const baseline = llamaLaunchState.preTuningConfig;

  if (managedConfig) {
    onProgress({ event: 'progress', message: 'Stopping llama-server before updating…' });
    const stopped = await stopLlamaServer();
    if (!stopped.success) {
      return {
        success: false,
        error: stopped.message || 'PortOS could not stop the managed llama-server before updating.',
      };
    }
  }

  const upgraded = await updateLlamaServerPackage(plan, onProgress);
  if (!upgraded.success) {
    return upgradeFailureResult(upgraded.error, managedConfig, baseline, upgraded.updated);
  }

  // A new binary may gain support for a cached compatibility flag such as
  // --sleep-idle-seconds. Re-probe it before the preserved launch line returns.
  clearSleepIdleSupport();

  if (managedConfig) {
    onProgress({ event: 'progress', message: 'Restarting llama-server with its previous settings…' });
    const restarted = await restartManagedLlamaServer(managedConfig, baseline);
    if (!restarted) {
      return {
        success: false,
        updated: true,
        error: 'llama.cpp was upgraded, but llama-server could not be restarted with its previous settings.',
      };
    }
    return {
      success: true,
      note: 'Updated llama.cpp and restarted llama-server with its previous settings.',
    };
  }

  return {
    success: true,
    note: 'Updated llama.cpp. The new binary will be used the next time llama-server starts.',
  };
}
