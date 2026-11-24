/** Read-only Splash readiness on the default loopback endpoint; PortOS never owns this process. */

import { findCommandOnPath } from '../lib/processEnv.js';
import { SPLASH_ORIGIN } from '../lib/splashRuntime.js';

export async function getSplashRuntimeStatus({ platform = process.platform, arch = process.arch } = {}) {
  const supported = platform === 'darwin' && arch === 'arm64';
  const base = { supported, endpoint: `${SPLASH_ORIGIN}/v1` };
  if (!supported) return { ...base, state: 'unsupported' };
  const probe = (path) => fetch(`${SPLASH_ORIGIN}${path}`, {
    redirect: 'error',
    signal: AbortSignal.timeout(1500),
  }).catch(() => null);

  // Do not infer readiness from a model listing alone: Splash exposes that
  // route even when its engine is recovering.
  const ready = await probe('/ready');
  const readiness = await ready?.json().catch(() => null);
  if (ready?.status === 503 && readiness?.status === 'unavailable') return { ...base, state: 'not-ready' };
  if (ready?.ok && readiness?.status === 'ready') {
    const listing = await probe('/v1/models');
    const body = listing?.ok ? await listing.json().catch(() => null) : null;
    if (listing && !listing.ok) await listing.body?.cancel().catch(() => null);
    const model = Array.isArray(body?.data) && body.data.find((item) => item?.owned_by === 'splash' && typeof item.id === 'string' && item.id)?.id;
    if (model) return { ...base, state: 'external', model };
  }
  if (ready) return { ...base, state: 'unrecognized' };
  return { ...base, state: findCommandOnPath('splash') ? 'stopped' : 'missing' };
}
