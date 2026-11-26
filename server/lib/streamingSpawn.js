/**
 * Run one command to completion, streaming its stdout/stderr lines to a hook.
 *
 * `services/localLlm.js` package-manager installs, `services/localRuntimeSetup.js` daemon setup, that forward each line to an SSE frame).
 *
 * A non-zero exit carries the TAIL of what the tool said (`brew upgrade ollama` exiting 1 with "Error: ollama not installed" must surface that, not "exited with code 1"). Never rejects: every failure resolves `{ success: false, error }`,
 * since these run outside the Express lifecycle (a child-process callback has no `next(err)`), and the `onLine` hook is guarded for the same reason. `bufferedSpawn.js` is the sibling for whole-output-at-the-end; use this one when live output IS the progress.
 */

import { spawn } from './childProcess.js';
import { safeChildProcessEnv, safeChildProcessOptions } from './processEnv.js';
import { createLineReader, createOutputTail } from './streamLines.js';
import { killProcessTree } from './bufferedSpawn.js';
import { trackDetachedGroup } from './credentialBootstrap.js';

/** How often `isCancelled` is asked: a second is under human perception for "I closed it and it stopped" and costs nothing against a command running minutes or hours. */
const CANCEL_POLL_MS = 1_000;

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {(line: string) => void} [onLine] - called once per non-empty line
 * @param {{timeoutMs?: number, cwd?: string, env?: object, spawnImpl?: Function, splitRe?: RegExp, isCancelled?: () => boolean, signal?: AbortSignal, processGroup?: boolean}} [options]
  *   `timeoutMs: 0` (default) means no timeout. `splitRe` goes to the line readers (pass `/[\r\n]+/` for a progress bar redrawing one line with a bare `\r`, else a multi-GB download goes silent). `isCancelled` is polled while running (see CANCEL_POLL_MS).
  *   An unset `env` inherits this process's environment, but `docker compose` substitutes `${VAR}` refs from ITS caller's env before the project's `.env`, so a compose target reusing a name PortOS sets (`PORT`, see `services/vllmQwenManager.js#startVllmQwenProject`)
  *   is silently remapped: audit a new target's variable names against `lib/ports.js`. `processGroup` spawns detached and signals the whole group on timeout/cancel, for a credential-bootstrap WRAPPER supervising the real harness (pass `needsProcessGroup(wrapped)`; a per-pid SIGKILL would leave it running, #7496); off by default.
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export function runStreamingCommand(cmd, args, onLine, { timeoutMs = 0, cwd, env, spawnImpl = spawn, splitRe, isCancelled, signal, processGroup = false } = {}) {
  if (signal?.aborted) return Promise.resolve({ success: false, error: 'cancelled' });
  return new Promise((resolve) => {
    const child = spawnImpl(cmd, args, safeChildProcessOptions({
      env: env ? safeChildProcessEnv(env) : process.env,
      ...(cwd ? { cwd } : {}),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: processGroup,
    }));
    // Remember the detached group so the graceful-shutdown sweep can reach it: detaching moved the child out of the server's process group, so a group signal at shutdown would orphan it (#7496).
    trackDetachedGroup(child, processGroup);

    let settled = false;
    // Recent output, so a non-zero exit reports what the tool said.
    const tail = createOutputTail();

    const safeLine = (line) => {
      if (!line) return;
      tail.remember(line);
      if (typeof onLine !== 'function') return;
      try { onLine(line); } catch (err) { console.error(`⚠️ streaming output hook failed: ${err.message}`); }
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (cancelTimer) clearInterval(cancelTimer);
      signal?.removeEventListener('abort', abort);
      resolve(result);
    };

    const timer = timeoutMs > 0
      ? setTimeout(() => {
        killProcessTree(child, 'SIGKILL', { processGroup });
        finish({ success: false, error: `timed out after ${Math.round(timeoutMs / 1000)}s` });
      }, timeoutMs)
      : null;

    // A command running hours (a model-weights download) outlives its request and a caller holding a lock holds it that long; polling lets a closed stream STOP the child (`timeoutMs` only bounds the worst case).
    // Outside the Express lifecycle a throwing `isCancelled` would crash the process (the AGENTS.md try/catch exception); an unaskable predicate means "not cancelled" and the timeout still bounds the run.
    const cancelTimer = typeof isCancelled === 'function'
      ? setInterval(() => {
        let cancelled = false;
        try { cancelled = isCancelled(); } catch (err) { console.error(`⚠️ cancellation check failed for ${cmd}: ${err.message}`); }
        if (!cancelled) return;
        killProcessTree(child, 'SIGKILL', { processGroup });
        finish({ success: false, error: 'cancelled' });
      }, CANCEL_POLL_MS)
      : null;
    // Keep the caller's operation reserved until the cancelled process closes.
    const abort = () => killProcessTree(child, 'SIGKILL', { processGroup });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();

    // ONE reader per stream, never a shared buffer: chunks arrive on arbitrary byte boundaries, so a shared carry splices a half-written stdout line onto the next stderr chunk (`npm install`'s `added 42 ` plus a mid-line warning yields one corrupt line and loses both). `streamLines.js` carries the rule.
    const readerOptions = splitRe ? { splitRe } : undefined;
    const stdoutReader = createLineReader((line) => safeLine(line.trim()), readerOptions);
    const stderrReader = createLineReader((line) => safeLine(line.trim()), readerOptions);

    child.stdout?.on('data', stdoutReader.push);
    child.stderr?.on('data', stderrReader.push);
    child.on('error', (err) => finish({ success: false, error: err.message }));
    // 'close' rather than 'exit': 'exit' can fire with stdio still buffered, dropping the lines the failure message needs.
    child.on('close', (code) => {
      stdoutReader.flush();
      stderrReader.flush();
      if (signal?.aborted) return finish({ success: false, error: 'cancelled' });
      if (code === 0) return finish({ success: true });
      const detail = tail.text();
      finish({ success: false, error: detail ? `exit ${code}: ${detail}` : `exited with code ${code}` });
    });
  });
}
