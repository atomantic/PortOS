/**
 * Shared execGit utility — imported by both git.js and worktreeManager.js
 * to avoid a circular dependency (git.js imports worktreeManager.js).
 */

import { spawn } from './childProcess.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { StringDecoder } from 'node:string_decoder';

const mutationLifetime = new AsyncLocalStorage();
/** Admission owners retain their durable permit when Git/helper exit is uncertain. */
export const withGitMutationLifetime = (work, onUncertain) => mutationLifetime.run(onUncertain, work);

/**
 * Execute a git command safely using spawn (prevents shell injection).
 * @param {string[]} args - Git command arguments
 * @param {string} cwd - Working directory (required — an absent cwd would
 *   silently resolve to process.cwd(), i.e. PortOS's own checkout)
 * @param {object} options - Additional options
 * @param {number} [options.maxBuffer] - Max combined output in JavaScript code units (default 10 * 1024 * 1024)
 * @param {boolean} [options.bufferOutput] - Return original output bytes; the same decoded code-unit limit applies
 * @param {number} [options.timeout] - Timeout in ms (default 30s)
 * @param {boolean} [options.ignoreExitCode] - Resolve instead of reject on non-zero exit
 * @param {object} [options.env] - Explicit child environment; omitted inherits normally
 * @returns {Promise<{stdout: string|Buffer, stderr: string|Buffer, exitCode: number|null, signal?: string, terminated?: boolean}>}
 */
export function execGit(args, cwd, options = {}) {
  return new Promise((resolve, reject) => {
    // `spawn` treats a missing cwd as `process.cwd()`, so a caller whose repo
    // path came back undefined (a fixture whose temp-dir setup failed, a
    // config lookup that returned nothing) would run `git init` / `git config`
    // against PortOS's own checkout instead of failing. Refuse loudly (#4554).
    if (typeof cwd !== 'string' || cwd.trim() === '') {
      reject(new Error(`❌ execGit requires a working directory: git ${args.join(' ')}`));
      return;
    }
    const maxBuffer = options.maxBuffer || 10 * 1024 * 1024;
    const timeout = options.timeout || 30000;
    // Always disable the shell to keep this helper a hard boundary against
    // shell-injection. `spawn` resolves `git` via PATH on all supported
    // platforms (including Windows) without a shell wrapper.
    const child = spawn('git', args, {
      cwd,
      shell: false,
      ...(options.env ? { env: options.env } : {})
    });

    const onUncertain = mutationLifetime.getStore();
    let stdout = '';
    let stderr = '';
    let outputUnits = 0;
    const stdoutChunks = [];
    const stderrChunks = [];
    const collect = (data, decoder, chunks, channel) => {
      const bytes = typeof data === 'string' ? Buffer.from(data) : data;
      const decoded = decoder.write(bytes);
      outputUnits += decoded.length;
      if (options.bufferOutput) chunks.push(bytes);
      else if (channel === 'stdout') stdout += decoded;
      else stderr += decoded;
    };
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let killed = false;
    let failure = null;
    let escalation = null;
    const markUncertain = () => {
      try { onUncertain?.(); }
      catch (error) { failure ||= error; }
    };
    const terminate = error => {
      if (killed) return;
      killed = true;
      failure = error;
      // A direct-child close cannot prove detached hooks/helpers settled.
      markUncertain();
      try { child.kill(); } catch (killError) { failure ||= killError; }
      escalation = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (killError) { failure ||= killError; }
      }, 5000);
    };

    const timer = setTimeout(() => {
      if (!killed) {
        terminate(new Error(`git command timed out after ${timeout / 1000}s: git ${args.join(' ')}`));
      }
    }, timeout);

    // Both streams share one overflow guard against the combined code-unit count so
    // a runaway command can't blow past maxBuffer on either channel.
    const guardOverflow = () => {
      if (outputUnits > maxBuffer && !killed) {
        clearTimeout(timer);
        terminate(new Error(`git output exceeded maxBuffer (${maxBuffer} code units)`));
      }
    };

    child.stdout.on('data', (data) => {
      if (killed) return;
      collect(data, stdoutDecoder, stdoutChunks, 'stdout');
      guardOverflow();
    });

    child.stderr.on('data', (data) => {
      if (killed) return;
      collect(data, stderrDecoder, stderrChunks, 'stderr');
      guardOverflow();
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(escalation);
      const stdoutTail = stdoutDecoder.end();
      const stderrTail = stderrDecoder.end();
      outputUnits += stdoutTail.length + stderrTail.length;
      if (options.bufferOutput) {
        stdout = Buffer.concat(stdoutChunks);
        stderr = Buffer.concat(stderrChunks);
      } else {
        stdout += stdoutTail;
        stderr += stderrTail;
      }
      if (!failure && outputUnits > maxBuffer) {
        markUncertain();
        failure = new Error(`git output exceeded maxBuffer (${maxBuffer} code units)`);
      }
      if (failure) { reject(failure); return; }
      if (code === null && signal) {
        markUncertain();
        if (options.ignoreExitCode) {
          resolve({ stdout, stderr, exitCode: null, signal, terminated: true });
        } else {
          reject(Object.assign(new Error(`git command cancelled by ${signal}`), {
            name: 'AbortError', signal, terminated: true
          }));
        }
      } else if (code !== 0 && !options.ignoreExitCode) {
        reject(new Error(stderr.length ? stderr.toString() : `git exited with code ${code}`));
      } else {
        resolve({ stdout, stderr, exitCode: code });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (child.pid) markUncertain();
      reject(err);
    });
  });
}

// Like execGit but catches rejections (e.g. timeout) into a failed-result shape.
// Exported because every caller that wants `ignoreExitCode` semantics also has to
// survive the two rejections `ignoreExitCode` does NOT suppress — a timeout and a
// maxBuffer overflow — and each one hand-rolling that catch drops `stdout`.
export const execGitSafe = (args, cwd, options) =>
  execGit(args, cwd, options).catch(err => ({ exitCode: 1, stdout: '', stderr: err.message }));
