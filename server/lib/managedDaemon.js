/** Shared entry points for PM2 daemon lifecycle, on-demand launch and idle reaping. */

import { MANAGED_RUNTIME_APPS } from './managedRuntimeApps.js';
import { _resetIdleDaemonsForTests as resetIdleDaemons } from './idleDaemonReaper.js';
import { resetOnDemandSubscriptionsForTests } from './onDemandDaemon.js';

export { createDaemonLogBuffer, createDaemonLogFiles, createDaemonWatcher, createPm2ExitTail, pm2ArgValue, waitForDaemonReady } from './daemonWatcher.js';
export { createBundleDaemon, createOnDemandDaemon } from './onDemandDaemon.js';
export {
  DEFAULT_PRESSURE_CALM_DOWN_MS, DEFAULT_PRESSURE_DEAD_BAND_BYTES,
  DEFAULT_PRESSURE_THRESHOLD_BYTES, DEFAULT_SUSTAINED_PRESSURE_MS,
  evaluateMemoryPressurePolicy, formatReleaseTime, getLastPressureReleaseTime,
  getPressureHistory, idleWindowMs, markDaemonUsed, reapIdleDaemons, recordPressureSample,
  registerIdleDaemon, setLastPressureReleaseTime, startIdleReaper, stopIdleReaper,
} from './idleDaemonReaper.js';

export const LLAMA_APP = MANAGED_RUNTIME_APPS.llama.app;
export const MTPLX_APP = MANAGED_RUNTIME_APPS.mtplx.app;
export const SLOTSTREAM_APP = MANAGED_RUNTIME_APPS.slotstream.app;

export function _resetIdleDaemonsForTests() {
  resetOnDemandSubscriptionsForTests();
  resetIdleDaemons();
}
