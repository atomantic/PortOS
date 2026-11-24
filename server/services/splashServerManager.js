/** Owns user-triggered Splash install/update/start/stop without taking over an external server. */

import { SPLASH_CONTEXT, SPLASH_MODEL, SPLASH_ORIGIN } from '../lib/splashRuntime.js';
import { ServerError } from '../lib/errorHandler.js';
import { setTimeout as sleep } from 'timers/promises';
import { isPortInUse } from '../lib/platform.js';
import { clearJlistCache, execPm2, getAppStatusStrict } from './pm2.js';
import {
  installPinnedSplash, probeSplashEndpoint, readInstalledSplashVersion, splashLaunchArgs, splashLaunchPrefix, SPLASH_UNSUPPORTED_REASON,
  SPLASH_VERSION, supportsManagedSplash,
} from './splashManagedRuntime.js';

export const SPLASH_APP = 'portos-splash';
const PORT = Number(new URL(SPLASH_ORIGIN).port);
const active = new Set(['online', 'launching', 'waiting restart', 'stopping']);

let operation = null;
let startTimedOut = false;
const fail = (message, status = 409, code = 'SPLASH_CONFLICT') => new ServerError(message, { status, code });
const launchArgs = (version) => splashLaunchArgs(version, SPLASH_MODEL, SPLASH_CONTEXT, PORT);

function ownsProcess(processInfo, version) {
  if (!version || !Number.isInteger(processInfo?.pm_id)) return false;
  const prefix = splashLaunchPrefix(version);
  // PM2 owns the OS process identity. Its app name alone is not evidence of
  // ownership when another installation or a manually created app shares PM2.
  return Array.isArray(processInfo.args)
    && prefix.every((arg, index) => processInfo.args[index] === arg);
}

export async function getSplashManagedState() {
  const version = await readInstalledSplashVersion();
  const pm2 = version ? await getAppStatusStrict(SPLASH_APP) : null;
  const owned = ownsProcess(pm2, version);
  const repairRecommended = owned && ['errored', 'stopped'].includes(pm2.status);
  return {
    installed: Boolean(version),
    version,
    targetVersion: SPLASH_VERSION,
    updateAvailable: version !== null && version !== SPLASH_VERSION,
    managed: owned && active.has(pm2.status),
    installing: operation === 'install',
    startTimedOut: owned && startTimedOut,
    repairRecommended,
    ...(repairRecommended ? { reason: 'Splash exited. If its cache is incomplete, use Repair before retrying Start.' } : {}),
  };
}

async function withOperation(name, fn) {
  if (!await supportsManagedSplash()) throw fail(SPLASH_UNSUPPORTED_REASON, 400, 'SPLASH_UNSUPPORTED');
  if (operation) throw fail('Another Splash operation is in progress.');
  operation = name;
  try { return await fn(); } finally { operation = null; }
}

async function checkedPm2() {
  clearJlistCache();
  const pm2 = await getAppStatusStrict(SPLASH_APP);
  if (!pm2) throw fail('Could not verify the PortOS PM2 process state. Retry once PM2 is available.', 503, 'SPLASH_PM2_UNAVAILABLE');
  return pm2;
}

function guardedProgress(onProgress) {
  return (message) => {
    try { onProgress(message); } catch { /* Progress delivery must not abort lifecycle work. */ }
  };
}

export function installSplashRuntime({ onProgress = () => {} } = {}) {
  return withOperation('install', async () => {
    const version = await readInstalledSplashVersion();
    if (version) {
      const pm2 = await checkedPm2();
      if (ownsProcess(pm2, version) && active.has(pm2.status)) throw fail('Stop the PortOS-managed Splash server before updating it.');
      if (ownsProcess(pm2, version)) {
        await execPm2(['delete', String(pm2.pm_id)]);
        clearJlistCache();
      }
    }
    await installPinnedSplash({ previousVersion: version, emit: guardedProgress(onProgress) });
    return { success: true, message: `Splash ${SPLASH_VERSION} and Inkling 2 Mini are installed. Start Splash when ready.` };
  });
}

export function startSplashServer({ onProgress = () => {} } = {}) {
  return withOperation('start', async () => {
    const version = await readInstalledSplashVersion();
    if (!version) throw fail('Install Splash and its Inkling 2 Mini checkpoint before starting.', 400, 'SPLASH_NOT_INSTALLED');
    const pm2 = await checkedPm2();
    const owned = ownsProcess(pm2, version);
    if (owned && active.has(pm2.status)) throw fail('PortOS-managed Splash is already running or starting.');
    if (!owned && pm2.status !== 'not_found') throw fail('A PM2 app named portos-splash is not owned by this PortOS installation.');
    if (await isPortInUse(PORT)) {
      throw fail(`Port ${PORT} is in use. PortOS will not replace an external server.`, 409, 'SPLASH_PORT_IN_USE');
    }
    if (owned) await execPm2(['delete', String(pm2.pm_id)]);
    guardedProgress(onProgress)('Starting Splash with cached Inkling 2 Mini weights.');
    startTimedOut = false;
    await execPm2([
      'start', '/usr/bin/env', '--name', SPLASH_APP, '--interpreter', 'none', '--no-autorestart',
      '--kill-timeout', '10000', '--force', '--', ...launchArgs(version),
    ]);
    await waitForSplashReady(version);
    return { success: true, message: 'Splash is ready with Inkling 2 Mini.' };
  });
}

async function waitForSplashReady(version) {
  const deadline = performance.now() + 120_000;
  while (performance.now() < deadline) {
    const started = await checkedPm2();
    if (!ownsProcess(started, version) || !active.has(started.status)) {
      throw fail('Splash exited during startup. Use Repair to check the local cache, or check the portos-splash logs.', 502, 'SPLASH_START_FAILED');
    }
    const endpoint = await probeSplashEndpoint();
    if (endpoint.state === 'external' && endpoint.model === SPLASH_MODEL) return;
    await sleep(750);
  }
  // Keep ownership after a slow startup so the UI still offers Stop.
  startTimedOut = true;
  throw fail('Splash has not become ready yet. Check its status or stop the managed server to retry.', 504, 'SPLASH_START_TIMEOUT');
}

export function stopSplashServer() {
  return withOperation('stop', async () => {
    const pm2 = await checkedPm2();
    const version = await readInstalledSplashVersion();
    if (!ownsProcess(pm2, version)) throw fail('There is no PortOS-managed Splash process to stop. PortOS will not stop an external process.');
    await execPm2(['delete', String(pm2.pm_id)]);
    clearJlistCache();
    return { success: true, message: 'PortOS-managed Splash stopped.' };
  });
}
