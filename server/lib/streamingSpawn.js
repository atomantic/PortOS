/**
 * Run one command to completion, streaming its stdout/stderr LINES to a hook.
 *
 * The install/setup flows (`services/localLlm.js`'s package-manager installs,
 * `services/localRuntimeSetup.js`'s one-click daemon setup) all need the same
 * thing: spawn a package manager, forward every line it prints to an SSE frame,
 * and end up with an actionable `{ success, error }` — where a non-zero exit
 * carries the TAIL of what the tool actually said, because `brew upgrade ollama`
 * exiting 1 with stderr "Error: ollama not installed" must surface that string
 * rather than "exited with code 1".
 *
 * Deliberately never rejects: every failure (spawn error, non-zero exit,
 * timeout) resolves as `{ success: false, error }`. These run outside the
 * Express request lifecycle — from a child-process callback there is no
 * `next(err)` to bubble to — so the caller gets a value to report, and the
 * `onLine` hook is itself guarded for the same reason.
 *
 * `bufferedSpawn.js` is the sibling for the other shape: run a command and get
 * its whole output at the end. Use this one when live output IS the progress.
 */

import { spawn } from './childProcess.js';
import { safeChildProcessEnv, safeChildProcessOptions } from './processEnv.js';
import { createLineReader, createOutputTail } from './streamLines.js';
import { killProcessTree } from './bufferedSpawn.js';
import { trackDetachedGroup } from './credentialBootstrap.js';

/**
 * How often `isCancelled` is asked. A second is well under human perception for
 * "I closed it and it stopped", and a check this cheap costs nothing against a
 * command whose whole point is that it runs for minutes or hours.
 */
const CANCEL_POLL_MS = 1_000;

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {(line: string) => void} [onLine] - called once per non-empty line
 * @param {{timeoutMs?: number, cwd?: string, env?: object, spawnImpl?: Function, splitRe?: RegExp, isCancelled?: () => boolean, processGroup?: boolean}} [options]
 *   `timeoutMs: 0` (default) means no timeout. `splitRe` is forwarded to the
 *   line readers — pass `/[\r\n]+/` for a tool whose progress bar redraws the
 *   same line with a bare `\r`, so each redraw surfaces instead of the stream
 *   going silent for the length of a multi-gigabyte download. `isCancelled` is
 *   polled while the command runs; see CANCEL_POLL_MS. An unset `env` inherits
 *   this whole process's environment — fine for most callers, but `docker
 *   compose` substitutes `${VAR}` refs in a compose file from ITS OWN caller's
 *   env before falling back to the project's `.env`, so a compose-based target
 *   whose file happens to reuse a name PortOS also sets (`PORT` is the
 *   recurring offender — see `services/vllmQwenManager.js#startVllmQwenProject`)
 *   gets silently remapped. Audit a new docker-compose target's variable names
 *   against `lib/ports.js` before assuming the default inheritance is safe.
 *   `processGroup` spawns the child detached and signals its whole group on
 *   timeout/cancel — pass `needsProcessGroup(wrapped)` when the command is a
 *   credential-bootstrap WRAPPER supervising the real harness, which a per-pid
 *   SIGKILL would leave running (#7496). Off by default: for an ordinary
 *   command the direct child IS the thing to kill.
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export function runStreamingCommand(cmd, args, onLine, { timeoutMs = 0, cwd, env, spawnImpl = spawn, splitRe, isCancelled, processGroup = false } = {}) {
  return new Promise((resolve) => {
    const child = spawnImpl(cmd, args, safeChildProcessOptions({
      env: env ? safeChildProcessEnv(env) : process.env,
      ...(cwd ? { cwd } : {}),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: processGroup,
    }));
    // Remember the detached group so the graceful-shutdown sweep can reach it:
    // detaching moved this child out of the server's own process group, and a
    // shutdown driven by a signal to THAT group would otherwise orphan it (#7496).
    trackDetachedGroup(child, processGroup);

    let settled = false;
    // Recent output, kept so a non-zero exit reports what the tool actually said.
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
      resolve(result);
    };

    const timer = timeoutMs > 0
      ? setTimeout(() => {
        killProcessTree(child, 'SIGKILL', { processGroup });
        finish({ success: false, error: `timed out after ${Math.round(timeoutMs / 1000)}s` });
      }, timeoutMs)
      : null;

    // A command that runs for hours (a model-weights download) outlives the
    // request that asked for it, and a caller holding a lock until this settles
    // holds it for the whole run. Polling is what lets a closed stream actually
    // STOP the child — `timeoutMs` alone only bounds the worst case.
    //
    // The callback runs outside the Express request lifecycle, so a throwing
    // `isCancelled` would take the process down with no `next(err)` to bubble to
    // (see the try/catch exception in AGENTS.md). A predicate that cannot be
    // asked is treated as "not cancelled" — the timeout still bounds the run.
    const cancelTimer = typeof isCancelled === 'function'
      ? setInterval(() => {
        let cancelled = false;
        try { cancelled = isCancelled(); } catch (err) { console.error(`⚠️ cancellation check failed for ${cmd}: ${err.message}`); }
        if (!cancelled) return;
        killProcessTree(child, 'SIGKILL', { processGroup });
        finish({ success: false, error: 'cancelled' });
      }, CANCEL_POLL_MS)
      : null;

    // ONE reader per stream — never a shared buffer. Chunks arrive on arbitrary
    // byte boundaries, so a single carry shared by stdout and stderr splices a
    // half-written stdout line onto the next stderr chunk: `npm install` writing
    // `added 42 ` and a warning arriving mid-line yields one corrupt line and
    // loses both real ones. (Inherited from the hand-rolled splitter this was
    // extracted from; `streamLines.js` carries the rule.)
    const readerOptions = splitRe ? { splitRe } : undefined;
    const stdoutReader = createLineReader((line) => safeLine(line.trim()), readerOptions);
    const stderrReader = createLineReader((line) => safeLine(line.trim()), readerOptions);

    child.stdout?.on('data', stdoutReader.push);
    child.stderr?.on('data', stderrReader.push);
    child.on('error', (err) => finish({ success: false, error: err.message }));
    // 'close' rather than 'exit': 'exit' can fire with stdio still buffered,
    // which would drop the very lines the failure message needs.
    child.on('close', (code) => {
      stdoutReader.flush();
      stderrReader.flush();
      if (code === 0) return finish({ success: true });
      const detail = tail.text();
      finish({ success: false, error: detail ? `exit ${code}: ${detail}` : `exited with code ${code}` });
    });
  });
}
