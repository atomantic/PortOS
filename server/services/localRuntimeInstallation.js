/** Offline installation checks shared by provider readiness and one-click setup. */

import { LOCAL_RUNTIMES } from '../lib/localProviderRuntime.js';
import { resolveMtplxBinary } from '../lib/mtplxRuntime.js';
import { findCommandOnPath } from '../lib/processEnv.js';
import { isAppInstalled as isLmStudioAppInstalled } from './lmStudioManager.js';

const detectors = {
  mtplx: ({ findCommand }) => findCommand('mtplx', resolveMtplxBinary),
  slotstream: ({ findCommand }) => findCommand('slotstream', async () => (await import('./slotstreamServerManager.js')).resolveSlotstreamBinary()),
  splash: async () => (await import('./splashManagedRuntime.js')).readInstalledSplashVersion(),
  mkserve: async () => (await import('./mkserveRuntimeInstall.js')).readMkserveInstall(),
};

/** Returns the source of the install evidence, or null if none was found. */
export async function detectRuntimeInstallation(kind, {
  findCommand = (command, resolve = () => findCommandOnPath(command)) => resolve(),
  isAppInstalled = isLmStudioAppInstalled,
} = {}) {
  if (Object.hasOwn(detectors, kind)) {
    // An unrelated CLI on PATH cannot start the fixed Splash/mkserve bundles.
    return await detectors[kind]({ findCommand }) ? 'managed' : null;
  }
  const command = LOCAL_RUNTIMES[kind]?.command;
  if (command && findCommand(command)) return 'path';
  if (kind === 'lmstudio' && isAppInstalled()) return 'app';
  return null;
}
