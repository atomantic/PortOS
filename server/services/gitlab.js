import { spawn } from 'child_process';

/**
 * Execute a `glab` CLI command safely using spawn (no shell — injection-proof).
 *
 * Unlike `execGh` (github.js), this takes an explicit `cwd`: `glab` resolves the
 * target project from the repo's git `origin` remote in the working directory, so
 * it MUST run inside the repo checkout. Resolves to trimmed stdout on success and
 * `null` on ANY failure (non-zero exit, spawn error, glab not installed) — callers
 * treat null as "unavailable / transient", mirroring the `.catch(() => null)`
 * pattern used around `execGh`.
 *
 * @param {string[]} args - glab arguments (e.g. ['issue', 'list', '-F', 'json'])
 * @param {string} cwd - repo root the glab command runs in
 * @returns {Promise<string|null>}
 */
export function execGlab(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn('glab', args, { cwd, shell: false, windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    // stderr is intentionally ignored — a failed glab call resolves to null via
    // the exit code, and we never surface glab's stderr to the caller.
    child.on('close', (code) => resolve(code === 0 ? stdout.trim() : null));
    child.on('error', () => resolve(null));
  });
}
