/** Combines Splash readiness on the default loopback endpoint with PortOS process ownership. */

import { SPLASH_MODEL, SPLASH_ORIGIN } from '../lib/splashRuntime.js';
import { probeSplashEndpoint, SPLASH_UNSUPPORTED_REASON, supportsManagedSplash } from './splashManagedRuntime.js';
import { getSplashManagedState } from './splashServerManager.js';

export async function getSplashRuntimeStatus(host, options) {
  const supported = await supportsManagedSplash(host);
  const base = { supported, endpoint: `${SPLASH_ORIGIN}/v1` };
  if (!supported) return { ...base, state: 'unsupported', reason: SPLASH_UNSUPPORTED_REASON };
  const [managedState, endpointState] = await Promise.all([getSplashManagedState(options), probeSplashEndpoint()]);
  const status = { ...base, ...managedState, ...endpointState };
  if (managedState.managed) {
    if (endpointState.state === 'external' && endpointState.model === SPLASH_MODEL) return { ...status, state: 'running' };
    return { ...status, state: managedState.startTimedOut ? 'not-ready' : 'starting' };
  }
  if (endpointState.state === 'missing' && managedState.installed === true) return { ...status, state: 'stopped' };
  return status;
}
