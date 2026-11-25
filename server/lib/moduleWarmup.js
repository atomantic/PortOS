/** Defer sequential module imports until after the primary server is listening. */
import { setImmediate } from 'node:timers/promises';
import { isSmokeBoot, isTestRunner } from './runtimeEnv.js';

function logWarmupFailure(label, error) {
  const message = String(error?.message ?? error).replace(/[\r\n]+/g, ' ');
  console.error(`❌ ${label} warmup failed: ${message}`);
}

export async function warmModuleLoads(loads) {
  for (const [label, load] of loads) {
    await setImmediate();
    try {
      await load();
    } catch (error) {
      logWarmupFailure(label, error);
    }
  }
}

export function scheduleModuleWarmup(server, warm) {
  if (isSmokeBoot() || isTestRunner()) return;
  server.once('listening', () => {
    warm().catch(error => logWarmupFailure('Server module', error));
  });
}
