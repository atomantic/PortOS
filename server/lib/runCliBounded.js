/**
 * `runCliBounded(cmd, args, { timeoutMs = 15000, ...spawnOptions })` — never-rejecting, never-hanging
 * CLI runner resolving `{ code, stdout, stderr }`.
 *
 * Kills a child still running at `timeoutMs` and resolves `code: -1` (stderr preserved, else `timed
 * out`); pins PWD via `withSpawnCwdEnv`. Use it for every `gh`/`glab`/`git` call a scheduled job
 * awaits (#11678).
 */

import { spawn } from './childProcess.js';
import { withSpawnCwdEnv } from './spawnCwd.js';

export const DEFAULT_CLI_TIMEOUT_MS = 15_000;

/**
 * Run a CLI, resolving `{ code, stdout, stderr }` — never rejects and never
 * hangs. A spawn error or a child still running after `timeoutMs` resolves
 * `code: -1` (the timed-out child is killed); stderr accumulated before the
 * fault is preserved, falling back to the error message / `timed out`.
 * `options` pass through to spawn; PWD is pinned to `options.cwd` (#3193).
 */
export function runCliBounded(cmd, args, { timeoutMs = DEFAULT_CLI_TIMEOUT_MS, ...options } = {}) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', settled = false, timer;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(cmd, args, {
      shell: false,
      ...options,
      env: withSpawnCwdEnv(options.env ?? process.env, options.cwd),
    });
    child.stdout?.on('data', d => { stdout += d.toString(); });
    child.stderr?.on('data', d => { stderr += d.toString(); });
    child.on('error', err => done({ code: -1, stdout, stderr: stderr || err.message }));
    child.on('close', code => done({ code, stdout, stderr }));
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      done({ code: -1, stdout, stderr: stderr || 'timed out' });
    }, timeoutMs);
    timer.unref?.();
  });
}
