/**
 * Shared execGit utility — imported by both git.js and worktreeManager.js
 * to avoid a circular dependency (git.js imports worktreeManager.js).
 */

import { spawn } from 'child_process';

/**
 * Execute a git command safely using spawn (prevents shell injection).
 * @param {string[]} args - Git command arguments
 * @param {string} cwd - Working directory
 * @param {object} options - Additional options
 * @param {number} [options.maxBuffer] - Max output buffer size in bytes (default 10 MB)
 * @param {number} [options.timeout] - Timeout in ms (default 30s)
 * @param {boolean} [options.ignoreExitCode] - Resolve instead of reject on non-zero exit
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
 */
export function execGit(args, cwd, options = {}) {
  return new Promise((resolve, reject) => {
    const maxBuffer = options.maxBuffer || 10 * 1024 * 1024;
    const timeout = options.timeout || 30000;
    // Always disable the shell to keep this helper a hard boundary against
    // shell-injection. `spawn` resolves `git` via PATH on all supported
    // platforms (including Windows) without a shell wrapper.
    const child = spawn('git', args, {
      cwd,
      shell: false,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      if (!killed) {
        killed = true;
        child.kill();
        reject(new Error(`git command timed out after ${timeout / 1000}s: git ${args.join(' ')}`));
      }
    }, timeout);

    // Both streams share one overflow guard against the combined byte count so
    // a runaway command can't blow past maxBuffer on either channel.
    const guardOverflow = () => {
      if (stdout.length + stderr.length > maxBuffer && !killed) {
        killed = true;
        clearTimeout(timer);
        child.kill();
        reject(new Error(`git output exceeded maxBuffer (${maxBuffer} bytes)`));
      }
    };

    child.stdout.on('data', (data) => {
      stdout += data.toString();
      guardOverflow();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
      guardOverflow();
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (code !== 0 && !options.ignoreExitCode) {
        reject(new Error(stderr || `git exited with code ${code}`));
      } else {
        resolve({ stdout, stderr, exitCode: code });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
