/**
 * Layered Intelligence — shared CLI spawn primitive (#2842 split of
 * layeredIntelligence.js). Its own module so the source gatherer and the forge
 * filer can both use it without an import cycle.
 */

import { spawn } from '../../lib/childProcess.js';
import { withSpawnCwdEnv } from '../../lib/spawnCwd.js';

/** Run a CLI, resolving `{ code, stdout, stderr }` (never rejects). */
export function runCli(cmd, args, options = {}) {
  return new Promise((resolve) => {
    // Pin PWD to the spawn cwd — see withSpawnCwdEnv (#3193). `options` may
    // carry a caller-supplied `cwd`, so this generic wrapper owns the pin on
    // every caller's behalf rather than each one remembering it.
    const child = spawn(cmd, args, {
      shell: false,
      ...options,
      env: withSpawnCwdEnv(options.env ?? process.env, options.cwd),
    });
    let stdout = '', stderr = '';
    child.stdout?.on('data', d => { stdout += d.toString(); });
    child.stderr?.on('data', d => { stderr += d.toString(); });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.on('error', err => resolve({ code: -1, stdout: '', stderr: err.message }));
  });
}
