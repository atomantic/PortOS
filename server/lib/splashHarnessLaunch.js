/** Resolve the context that a managed local Splash model is serving before launching its coding harness. */

import { SPLASH_CONTEXT, SPLASH_MODEL, SPLASH_ORIGIN } from './splashRuntime.js';
import { followsSplashContext, splashHarnessTarget } from './provider/splashHarnessContext.js';

async function readServedWindow() {
  try {
    // Probe only the known loopback Splash endpoint. No custom address, auth
    // header, or redirect is needed for the managed local runtime.
    const response = await fetch(`${SPLASH_ORIGIN}/v1/models`, { redirect: 'error', signal: AbortSignal.timeout(1000) });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const { data } = await response.json();
    const row = Array.isArray(data) && data.find((model) => model?.owned_by === 'splash' && model.id === SPLASH_MODEL);
    return [row?.max_model_len, row?.context_length].find((value) => Number.isSafeInteger(value) && value >= 512 && value <= 2097152);
  } catch {
    return null;
  }
}

export async function resolveSplashHarnessContext(provider, model, readWindow = readServedWindow) {
  const target = splashHarnessTarget(provider, model);
  if (!followsSplashContext(provider, target)) return provider;
  const tokens = await readWindow() ?? SPLASH_CONTEXT;
  // This is a launch-only overlay. Never turn a runtime observation into a
  // saved pin, or a later Splash restart would leave the provider behind.
  return { ...provider, harnessContext: { tokens, ...(target.kind === 'opencode' ? { model: SPLASH_MODEL } : {}) } };
}
