// Agent guard — keeps spawned AI agents from killing the shared PM2 daemon.
//
// CoS "Fix with AI" tasks and the autofixer app run their CLI with
// `--dangerously-skip-permissions` (fully unrestricted Bash). A confused agent
// asked to "restart the app" once ran `pm2 kill`, which took down EVERY app on
// the machine — including PortOS itself. `agentGuardEnv()` returns an env patch
// that prepends a guarded `pm2` shim (./bin/pm2) to the agent's PATH so a bare
// `pm2 kill` / `pm2 delete all` is intercepted before it reaches the real pm2.
// The shim's blocked-subcommand list mirrors `validatePm2Command` in
// commandSecurity.js (which guards the non-agentic command paths).
//
// POSIX-only by design: the shim is a bash script, so on Windows (pm2.cmd, no
// bash) the prepend is a harmless no-op and pm2 resolves normally.

import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));

// Directory containing the guarded `pm2` shim.
export const AGENT_GUARD_BIN = join(HERE, 'bin');

// Node-resolved path to the REAL pm2 binary, handed to the shim via
// PORTOS_REAL_PM2 so it doesn't have to rediscover it on PATH. Resolved once.
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
