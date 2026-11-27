/** Serialize management operations for the local llama-server PM2 process. */

import { createSingleFlight } from '../lib/singleFlight.js';
import { startLlamaServerUnlocked } from './llamaServerLifecycle.js';
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

export const startLlamaServer = serialized((...a) => startLlamaServerUnlocked(...a));
export const upgradeLlamaServer = serialized((...a) => upgradeLlamaServerUnlocked(...a));
export const relaunchLlamaServerWithAlias = serialized((...a) => relaunchLlamaServerWithAliasUnlocked(...a));
export const restoreLlamaServerConfig = serialized((...a) => restoreLlamaServerConfigUnlocked(...a));
export const relaunchLlamaServerWithTuning = serialized((...a) => relaunchLlamaServerWithTuningUnlocked(...a));
