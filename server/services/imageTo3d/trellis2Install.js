/** Explicit Install and Repair share the same PortOS-owned, locked Metal setup. */
import { fileURLToPath } from 'node:url';
import { spawn } from '../../lib/childProcess.js';
import { withoutServerSecretsEnv } from '../../lib/processEnv.js';
import { runInstallSteps } from './laneRunner.js';
import { trellis2Root, isTransientInstallError } from './trellis2.js';

const SETUP_SCRIPT = fileURLToPath(new URL('../../../scripts/setup-trellis2-mps.sh', import.meta.url));

export function installTrellis2({
  base,
  onEvent = () => {},
  spawnImpl = spawn,
  env,
  maxRetries = 0,
  sleep,
} = {}) {
  return runInstallSteps({
    steps: [{ stage: 'bootstrap', command: 'bash', args: [SETUP_SCRIPT, trellis2Root(base)] }],
    label: 'TRELLIS.2 Metal',
    codePrefix: 'TRELLIS2',
    isTransient: isTransientInstallError,
    onEvent,
    spawnImpl,
    env: withoutServerSecretsEnv(env),
    maxRetries,
    sleep,
  });
}
