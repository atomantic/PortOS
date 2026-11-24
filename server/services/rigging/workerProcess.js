/**
 * Character rigging — the one way this lane spawns a Blender worker.
 *
 * Both rigging workers (`autoSkinWorker.py`, `retargetWorker.py`) are long-running
 * child processes outside the Express request lifecycle, so the same three rules apply
 * to both and are implemented once here:
 *
 *  - **Never reject.** A non-zero exit is an ANSWER, not an exception: the worker writes
 *    its measured report and exits with a code, and the caller owns the vocabulary of
 *    failure rather than inheriting "exited 1". A throw from inside a spawn callback has
 *    no `next(err)` to bubble to and would take the process down (AGENTS.md).
 *  - **Bounded output.** Only a tail is retained, so a worker that decides to print a
 *    million lines cannot grow the orchestrator's heap.
 *  - **A timeout that is a kill, not a wait.** A wedged Blender holds a CPU forever;
 *    past the budget it is terminated and the tail says so.
 */

import { spawn } from '../../lib/childProcess.js';
import { killWithEscalation } from '../../lib/killWithEscalation.js';

/** A rig is minutes of CPU, not hours; past this the worker is wedged, not working. */
export const RIGGING_WORKER_TIMEOUT_MS = 20 * 60 * 1000;

/** How much worker output is kept for the failure message. */
const TAIL_LIMIT = 4000;

/**
 * Run one Blender worker to completion.
 *
 * @param {{python: string, script: string, jobFile: string, spawnImpl?: Function,
 *          timeoutMs?: number, signal?: AbortSignal, killGraceMs?: number}} opts
 * @returns {Promise<{code: number, tail: string}>}
 */
export function runRiggingWorker({
  python,
  script,
  jobFile,
  spawnImpl = spawn,
  timeoutMs = RIGGING_WORKER_TIMEOUT_MS,
  signal,
  killGraceMs,
}) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ code: -1, tail: 'Rigging worker cancelled before it started.' });
      return;
    }
    const child = spawnImpl(python, [script, '--job', jobFile], {});
    let tail = '';
    let settled = false;
    let escalation = null;
    const collect = (buf) => { tail = `${tail}${buf}`.slice(-TAIL_LIMIT); };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    // SIGTERM first, SIGKILL if a wedged native Blender call ignores it. `settled`
    // stops escalation once the child has actually closed.
    const terminate = () => {
      if (settled || escalation) return;
      escalation = killWithEscalation(child, {
        label: 'Rigging worker',
        stillRunning: () => !settled,
        ...(killGraceMs != null ? { delayMs: killGraceMs } : {}),
      });
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      signal?.removeEventListener?.('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => {
      tail = `${tail}\nRigging worker was cancelled and terminated.`;
      terminate();
    };
    const timer = setTimeout(() => {
      tail = `${tail}\nRigging worker exceeded ${Math.round(timeoutMs / 60000)} minutes and was terminated.`;
      terminate();
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.on('error', (error) => finish({ code: -1, tail: `${tail}\n${error.message}` }));
    child.on('close', (code) => finish({ code, tail: tail.trim() }));
  });
}
