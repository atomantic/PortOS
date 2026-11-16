// Agent guard: keeps spawned AI agents from killing the shared PM2 daemon.
//
// CoS "Fix with AI" tasks and the autofixer run their CLI with `--dangerously-skip-permissions`, and a bare `pm2 kill`
// takes down EVERY app including PortOS. `agentGuardEnv()` prepends a guarded `pm2` shim (./bin/pm2) to the agent's PATH;
// its blocked-subcommand list mirrors `validatePm2Command` in commandSecurity.js.
// POSIX-only: the shim is a bash script, so on Windows (pm2.cmd) the prepend is a harmless no-op.

import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));

// Directory containing the guarded `pm2` shim.
export const AGENT_GUARD_BIN = join(HERE, 'bin');

// Real pm2 binary, handed to the shim via PORTOS_REAL_PM2. Resolved once; unresolved is non-fatal (shim scans PATH).
function resolveRealPm2() {
  const require = createRequire(import.meta.url);
  // require.resolve throws when pm2 isn't installed — the shim falls back to a
  // PATH scan in that case, so an unresolved binary is non-fatal.
  try {
    return join(dirname(require.resolve('pm2/package.json')), 'bin', 'pm2');
  } catch {
    return undefined;
  }
}

const REAL_PM2 = resolveRealPm2();

/**
 * Env patch to merge into a spawned agent's environment. Prepends the guarded
 * pm2 shim to PATH and points it at the real pm2.
 * @param {NodeJS.ProcessEnv} [baseEnv=process.env] base env to read PATH from.
 * @returns {{ PATH: string, PORTOS_REAL_PM2?: string }}
 */
export function agentGuardEnv(baseEnv = process.env) {
  const currentPath = baseEnv.PATH || baseEnv.Path || '';
  const patch = { PATH: `${AGENT_GUARD_BIN}${delimiter}${currentPath}` };
  if (REAL_PM2) patch.PORTOS_REAL_PM2 = REAL_PM2;
  return patch;
}
