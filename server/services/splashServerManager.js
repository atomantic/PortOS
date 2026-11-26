/** Owns user-triggered Splash install/update/start/stop without taking over an external server. */

import { isSplashContextWindow, SPLASH_CONTEXT, SPLASH_MODEL, SPLASH_ORIGIN } from '../lib/splashRuntime.js';
import { MANAGED_RUNTIME_APPS } from '../lib/managedRuntimeApps.js';
import { createBundleDaemon } from '../lib/managedDaemon.js';
import { ServerError } from '../lib/errorHandler.js';
import { setTimeout as sleep } from 'timers/promises';
import { isPortInUse } from '../lib/platform.js';
import { clearJlistCache, execPm2, getAppStatusStrict } from './pm2.js';
import {
  installPinnedSplash, probeSplashEndpoint, readInstalledSplashVersion, splashLaunchArgs, splashLaunchPrefix, SPLASH_UNSUPPORTED_REASON,
  SPLASH_VERSION, supportsManagedSplash,
} from './splashManagedRuntime.js';

export const SPLASH_APP = MANAGED_RUNTIME_APPS.splash.app;
const PORT = Number(new URL(SPLASH_ORIGIN).port);
let startTimedOut = false;
const fail = (message, status = 409, code = 'SPLASH_CONFLICT') => new ServerError(message, { status, code });
const settingsService = () => import('./settings.js');

async function configuredContextWindow({ forStart = false } = {}) {
  const { readSettingsStrict } = await settingsService();
  const { settings, corrupt } = await readSettingsStrict();
  if (corrupt && forStart) throw fail('Splash context settings could not be read.', 503, 'SPLASH_SETTINGS_UNAVAILABLE');
  const value = settings?.localLlm?.splash?.contextWindow;
  return isSplashContextWindow(value) ? value : SPLASH_CONTEXT;
}

function matchesLaunch(processInfo, version) {
  if (!version || !Array.isArray(processInfo.args)) return false;
  const prefix = splashLaunchPrefix(version);
  // PM2 owns the OS process identity. Its app name alone is not evidence of
  // ownership when another installation or a manually created app shares PM2.
  return prefix.every((arg, index) => processInfo.args[index] === arg);
}

const daemon = createBundleDaemon({
  appName: SPLASH_APP,
  port: PORT,
  busy: () => fail('Another Splash operation is in progress.'),
  matchesLaunch,
  pm2Unavailable: () => fail('Could not verify the PortOS PM2 process state. Retry once PM2 is available.', 503, 'SPLASH_PM2_UNAVAILABLE'),
  nameInUse: () => fail('A PM2 app named portos-splash is not owned by this PortOS installation.'),
  portInUse: () => fail(`Port ${PORT} is in use. PortOS will not replace an external server.`, 409, 'SPLASH_PORT_IN_USE'),
  unsupportedStop: () => fail('There is no PortOS-managed Splash process to stop. PortOS will not stop an external process.'),
  getAppStatusStrict, clearJlistCache, execPm2, isPortInUse, sleep,
  timeoutMs: 120_000,
  pollMs: 750,
});

export async function getSplashManagedState({ includeLogs = false } = {}) {
  const [version, requestedContextWindow] = await Promise.all([readInstalledSplashVersion(), configuredContextWindow()]);
  const status = version ? await daemon.read(version) : { owned: false };
  const { app, owned, active } = status;
  const repairRecommended = owned && ['errored', 'stopped'].includes(app.status);
  return {
    installed: Boolean(version),
    requestedContextWindow,
    version,
    targetVersion: SPLASH_VERSION,
    updateAvailable: version !== null && version !== SPLASH_VERSION,
    managed: owned && active,
    installing: daemon.operation() === 'install',
    recentLogs: includeLogs ? await daemon.recentLogs(status) : [],
    startTimedOut: owned && startTimedOut,
    repairRecommended,
    ...(repairRecommended ? { reason: 'Splash exited. If its cache is incomplete, use Repair before retrying Start.' } : {}),
  };
}

async function withSplashOperation(state, run) {
  if (!await supportsManagedSplash()) throw fail(SPLASH_UNSUPPORTED_REASON, 400, 'SPLASH_UNSUPPORTED');
  return daemon.withOperation(state, run);
}

function guardedProgress(onProgress) {
  return (message) => {
    try { onProgress(message); } catch { /* Progress delivery must not abort lifecycle work. */ }
  };
}

export function installSplashRuntime({ onProgress = () => {} } = {}) {
  return withSplashOperation('install', async () => {
    const version = await readInstalledSplashVersion();
    if (version) {
      const status = await daemon.requireStatus(version);
      if (status.owned && status.active) throw fail('Stop the PortOS-managed Splash server before updating it.');
      if (status.owned) await daemon.remove(status);
    }
    await installPinnedSplash({ previousVersion: version, emit: guardedProgress(onProgress) });
    return { success: true, message: `Splash ${SPLASH_VERSION} and Inkling 2 Mini are installed. Start Splash when ready.` };
  });
}

export function saveSplashContextWindow(contextWindow) {
  return withSplashOperation('context', async () => {
    if (!isSplashContextWindow(contextWindow)) throw fail('Choose a supported Splash context window.', 400, 'SPLASH_INVALID_CONTEXT');
    const { active } = await daemon.requireStatus();
    if (active || await daemon.hasListener()) {
      throw fail('Stop Splash before changing its context window. PortOS will not stop an external server.');
    }
    const { updateSettingsWith } = await settingsService();
    await updateSettingsWith((settings) => ({
      ...settings,
      localLlm: {
        ...settings.localLlm,
        splash: { ...settings.localLlm?.splash, contextWindow },
      },
    }), { actor: 'user' });
    return { requestedContextWindow: contextWindow };
  });
}

export function startSplashServer({ onProgress = () => {} } = {}) {
  return withSplashOperation('start', async () => {
    const version = await readInstalledSplashVersion();
    if (!version) throw fail('Install Splash and its Inkling 2 Mini checkpoint before starting.', 400, 'SPLASH_NOT_INSTALLED');
    const status = await daemon.requireStatus(version);
    if (status.owned && status.active) throw fail('PortOS-managed Splash is already running or starting.');
    daemon.assertNameAvailable(status);
    await daemon.assertPortFree();
    const contextWindow = await configuredContextWindow({ forStart: true });
    if (status.owned) await daemon.remove(status);
    guardedProgress(onProgress)('Starting Splash with cached Inkling 2 Mini weights.');
    startTimedOut = false;
    await daemon.launch(splashLaunchArgs(version, SPLASH_MODEL, contextWindow, PORT), { killTimeoutMs: 10_000, force: true });
    await daemon.waitUntilReady({
      identity: version,
      probe: async () => {
        const endpoint = await probeSplashEndpoint();
        return endpoint.state === 'external' && endpoint.model === SPLASH_MODEL;
      },
      exited: () => {
        const hint = contextWindow > SPLASH_CONTEXT
          ? ' Try a smaller context window, or check the portos-splash logs for memory or SSD limits.'
          : ' Use Repair to check the local cache, or check the portos-splash logs.';
        return fail(`Splash exited during startup.${hint}`, 502, 'SPLASH_START_FAILED');
      },
      timedOut: () => {
        // Keep ownership after a slow startup so the UI still offers Stop.
        startTimedOut = true;
        return fail('Splash has not become ready yet. Check its status or stop the managed server to retry.', 504, 'SPLASH_START_TIMEOUT');
      },
    });
    return { success: true, message: 'Splash is ready with Inkling 2 Mini.' };
  });
}

export function stopSplashServer() {
  return withSplashOperation('stop', async () => {
    const version = await readInstalledSplashVersion();
    await daemon.remove(await daemon.requireStatus(version));
    return { success: true, message: 'PortOS-managed Splash stopped.' };
  });
}
