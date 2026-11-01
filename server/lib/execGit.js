/**
 * Shared execGit utility — imported by both git.js and worktreeManager.js
 * to avoid a circular dependency (git.js imports worktreeManager.js).
 */

import { startGit, windowsGitFailureMetadata } from './windowsGitProcess.js';
import { currentGitMutationLifetime } from './gitMutationLifetime.js';
import { StringDecoder } from 'node:string_decoder';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';

export { withGitMutationLifetime } from './gitMutationLifetime.js';

const ownedWork = process[Symbol.for('portos.ownedGitWork')] ??= new Set();
const CANCELLATION_BUDGET_MS = 5000;
const ownedDirectory = directory => {
  try { return realpathSync.native(directory); }
  catch { return resolvePath(directory); }
};

/** Fixture teardown cannot discard a directory still owned by Git or a helper. */
export function assertGitWorkSettled(directory) {
  const root = ownedDirectory(directory);
  for (const work of ownedWork) {
    const path = relative(root, work.cwd);
    if (path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))) {
      throw Object.assign(new Error('Git work settlement is held'), { code: 'GIT_SETTLEMENT_HELD', settlement: 'held' });
    }
  }
}
globalThis.__portosAssertGitWorkSettled = assertGitWorkSettled;

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
 * @param {object} [options.env] - Explicit child environment; omitted inherits
 *   process.env. Either way LANGUAGE is pinned so git reports in English.
 * @returns {Promise<{stdout: string|Buffer, stderr: string|Buffer, exitCode: number|null, signal?: string, terminated?: boolean}>}
 */
export function execGit(args, cwd, options = {}) {
  const owner = currentGitMutationLifetime();
  if (owner?.closed) return Promise.reject(Object.assign(new Error('Git mutation lifetime has ended'), { code: 'GIT_MUTATION_LIFETIME_CLOSED' }));
  const promise = new Promise((resolve, reject) => {
    // `spawn` treats a missing cwd as `process.cwd()`, so a caller whose repo
    // path came back undefined (a fixture whose temp-dir setup failed, a
    // config lookup that returned nothing) would run `git init` / `git config`
    // against PortOS's own checkout instead of failing. Refuse loudly (#4554).
    if (typeof cwd !== 'string' || cwd.trim() === '' || cwd.includes('\0')) {
      reject(new Error('❌ execGit requires a working directory'));
      return;
    }
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
      reject(new TypeError('execGit requires string arguments without NUL bytes'));
      return;
    }
    const maxBuffer = options.maxBuffer || 10 * 1024 * 1024;
    const timeout = options.timeout || 30000;
    const onUncertain = owner?.onUncertain;
    const started = performance.now();
    const work = { cwd: ownedDirectory(cwd) };
    ownedWork.add(work);
    let wired = false;
    let startup;
    try { startup = startGit(args, {
      cwd,
      shell: false,
      // Callers classify failures by git's English wording (`not a git
      // repository`, `branch … already exists`, `is already used by worktree`),
      // and git translates it under a non-English locale: a pre-existing branch
      // then reads as an orphan that worktree cleanup force-deletes. LANGUAGE
      // outranks LC_ALL/LC_MESSAGES/LANG for messages and leaves LC_CTYPE alone.
      env: { ...(options.env ?? process.env), LANGUAGE: 'en' },
    }, child => {
      wired = true;

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
      let deadline = null;
      let finished = false;
      let uncertain = false;
      const markUncertain = reason => {
        if (uncertain) return;
        uncertain = true;
        if (failure) Object.assign(failure, { settlement: 'held', settlementReason: reason });
        try { onUncertain?.(); }
        catch (error) { failure ||= error; }
      };
      const finish = () => {
        finished = true;
        clearTimeout(timer);
        clearTimeout(escalation);
        clearTimeout(deadline);
      };
      const terminate = error => {
        if (killed) return;
        killed = true;
        failure ||= error;
        try {
          if (child.cancelOwnedGit) child.cancelOwnedGit();
          else { markUncertain('tree-unconfirmed'); child.kill(); }
        } catch { markUncertain('cancellation-unconfirmed'); }
        escalation = setTimeout(() => {
          if (!child.cancelOwnedGit) {
            try { child.kill('SIGKILL'); } catch { markUncertain('cancellation-unconfirmed'); }
          }
        }, 1000);
        deadline = setTimeout(() => {
          if (finished) return;
          markUncertain('pipes-unconfirmed');
          // The native ChildProcess handle cannot target a recycled PID. Losing
          // a supervisor closes its kill-on-close job, but is not settlement proof.
          try { child.kill('SIGKILL'); } catch { /* retain the obligation */ }
          finish();
          reject(failure);
        }, CANCELLATION_BUDGET_MS);
      };

      const timer = setTimeout(() => {
        if (!killed) {
          terminate(Object.assign(new Error(`git command timed out after ${timeout / 1000}s`), {
            code: 'GIT_TIMEOUT', limitMs: timeout, observedMs: Math.ceil(performance.now() - started),
          }));
        }
      }, timeout);

      // Both streams share one overflow guard against the combined code-unit count so
      // a runaway command can't blow past maxBuffer on either channel.
      const outputLimitError = () => Object.assign(new Error(`git output exceeded maxBuffer (${maxBuffer} code units)`), {
        code: 'GIT_OUTPUT_LIMIT', limitCodeUnits: maxBuffer, observedCodeUnits: outputUnits,
      });
      const guardOverflow = () => {
        if (outputUnits > maxBuffer && !killed) {
          clearTimeout(timer);
          terminate(outputLimitError());
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

      const onClose = (code, signal, settlement) => {
        if (finished && !child.pid && !child.gitSupervisor) return;
        if (settlement?.settled === false) {
          failure ||= Object.assign(new Error('Git work settlement is held'), { code: 'GIT_SETTLEMENT_HELD' });
          Object.assign(failure, windowsGitFailureMetadata(settlement));
          markUncertain(settlement.reason);
        } else if (!child.gitSettlement && (killed || signal)) markUncertain('tree-unconfirmed');
        else ownedWork.delete(work);
        if (finished) return;
        finish();
        if (settlement?.launched === false) {
          reject(Object.assign(new Error('Windows Git launch failed'), { code: 'GIT_CONTAINMENT_UNAVAILABLE', startupPhase: 'native-launch' }));
          return;
        }
        if (settlement?.settled) {
          code = settlement.exitCode;
          if (failure) failure.settlement = 'settled';
        }
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
          failure = outputLimitError();
        }
        if (failure) { reject(failure); return; }
        if (code === null && signal) {
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
      };
      child.on('close', (code, signal) => {
        if (child.gitSettlement) {
          void child.gitSettlement.then(settlement => onClose(code, signal, settlement));
        } else onClose(code, signal);
      });

      child.on('error', (err) => {
        if (child.pid) terminate(err);
        else {
          ownedWork.delete(work);
          finish();
          reject(child.gitSupervisor
            ? Object.assign(new Error('Windows Git supervisor unavailable'), { code: 'GIT_CONTAINMENT_UNAVAILABLE' }) : err);
        }
      });
    }); } catch (error) {
      if (!wired) ownedWork.delete(work);
      reject(error);
    }
    startup?.catch(error => {
      if (!wired) ownedWork.delete(work);
      reject(error);
    });
  });
  if (owner) {
    owner.pending.add(promise);
    void promise.then(() => owner.pending.delete(promise), () => owner.pending.delete(promise));
  }
  return promise;
}

// Like execGit but catches rejections (e.g. timeout) into a failed-result shape.
// Exported because every caller that wants `ignoreExitCode` semantics also has to
// survive the two rejections `ignoreExitCode` does NOT suppress — a timeout and a
// maxBuffer overflow — and each one hand-rolling that catch drops `stdout`.
export const execGitSafe = (args, cwd, options) =>
  execGit(args, cwd, options).catch(err => ({ exitCode: 1, stdout: '', stderr: err.message,
    ...(err.settlement ? { settlement: err.settlement } : {}),
    ...(err.settlementReason ? { settlementReason: err.settlementReason } : {}),
  }));
