/** Serialize management operations for the local llama-server PM2 process. */

import { createSingleFlight } from '../lib/singleFlight.js';
import { llamaLaunchState, readLlamaServerLaunch, startLlamaServerUnlocked } from './llamaServerLifecycle.js';
import { persistDaemonLaunchConfig } from './localDaemonLaunchConfig.js';
import { relaunchLlamaServerWithAliasUnlocked, relaunchLlamaServerWithTuningUnlocked, restoreLlamaServerConfigUnlocked } from './llamaServerTuning.js';
import { upgradeLlamaServerUnlocked } from './llamaServerUpgrade.js';

export { LLAMA_APP } from '../lib/managedDaemon.js';
export { _resetLlamaServerStateForTests, _setLlamaKeepLoadedOverrideForTests, getLlamaServerEndpoint, getLlamaServerStatus, readLlamaServerLaunch, stopLlamaServer, waitForLlamaServerReady } from './llamaServerLifecycle.js';
export { captureLlamaServerConfig } from './llamaServerTuning.js';
export { getLlamaServerUpdateStatus, installLlamaServer } from './llamaServerInstall.js';

/**
 * Every operation that stops, deletes or starts the one `portos-llama-server`
 * PM2 app runs through this exclusive slot. Unserialized, overlapping starts
 * `pm2 delete` each other's process and interleave writes to `currentConfig` /
 * `preTuningConfig` (same race #12723 closed for mtplx/slotstream). The key is
 * unique per call so callers never join one another's result: each carries its
 * own launch options. Internal composition (relaunch -> start) calls the
 * `*Unlocked` bodies directly; re-entering the slot would deadlock.
 */
const launchFlight = createSingleFlight({ exclusive: true });
const serialized = (fn) => (...args) => launchFlight.run(Symbol('llama-launch'), () => fn(...args));

/**
 * Save the launch line the daemon is now running, so the boot auto-start
 * (`llamaServerAutoStart.js`) replays the user's last choice. Only explicit
 * starts and alias relaunches persist: a tuning sweep's trial lines are not a
 * choice anyone made. The idle window is left out so the saved setting, not a
 * snapshot of it, decides the next launch.
 */
async function persistLaunch(config) {
  if (!config?.model) return false;
  const { sleepIdleMinutes: _idle, ...launch } = config;
  await persistDaemonLaunchConfig({ key: 'llama', label: 'llama-server', launch });
  return true;
}
const persistCurrentLaunch = () => persistLaunch(llamaLaunchState.currentConfig);

/**
 * Save the launch line of a llama-server PortOS is ALREADY running (read back
 * from PM2), for callers that turn on Start with PortOS without starting it:
 * a server started before launch lines were saved, or one setup found serving.
 * @returns {Promise<boolean>} whether a line was saved
 */
export const persistRunningLlamaLaunch = serialized(async () => {
  const { managed, config } = await readLlamaServerLaunch();
  return managed ? persistLaunch(config) : false;
});

export const startLlamaServer = serialized(async (...a) => {
  const result = await startLlamaServerUnlocked(...a);
  await persistCurrentLaunch();
  return result;
});
export const upgradeLlamaServer = serialized((...a) => upgradeLlamaServerUnlocked(...a));
export const relaunchLlamaServerWithAlias = serialized(async (...a) => {
  const result = await relaunchLlamaServerWithAliasUnlocked(...a);
  if (result?.applied) await persistCurrentLaunch();
  return result;
});
export const restoreLlamaServerConfig = serialized((...a) => restoreLlamaServerConfigUnlocked(...a));
export const relaunchLlamaServerWithTuning = serialized((...a) => relaunchLlamaServerWithTuningUnlocked(...a));
