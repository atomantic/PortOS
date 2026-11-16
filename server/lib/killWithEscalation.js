/**
 * Shared SIGTERM→grace→SIGKILL cancel-escalation for spawn-based media jobs: `killWithEscalation(proc, {label, stillRunning, delayMs=8000})`.
 *
 * SIGTERM is sent synchronously; after `delayMs` it escalates to SIGKILL only when the caller's
 * `stillRunning()` guard holds (e.g. `job.process === proc`, so a replaced handle is left alone) AND the
 * child hasn't exited (`exitCode === null && signalCode === null`; `proc.killed` is set as soon as
 * `kill()` is called and does NOT mean the child exited).
 *
 * The timer runs OUTSIDE the request lifecycle, so the callback is try/catch-wrapped (an uncaught throw
 * would crash Node) and the timer is `unref()`'d so it can't hold the event loop open.
 *
 * @param {import('child_process').ChildProcess} proc
 * @param {object} opts
 * @param {string} opts.label - per-site label for the warning log.
 * @param {() => boolean} opts.stillRunning - escalation is skipped when it returns false.
 * @param {number} [opts.delayMs=8000] - grace window before SIGKILL.
 * @returns {NodeJS.Timeout} the escalation timer (already unref'd).
 */
export function killWithEscalation(proc, { label, stillRunning, delayMs = 8000 }) {
  proc.kill('SIGTERM');
  const timer = setTimeout(() => {
    try {
      if (stillRunning() && proc.exitCode === null && proc.signalCode === null) {
        console.log(`⚠️ ${label} didn't exit on SIGTERM — escalating to SIGKILL`);
        proc.kill('SIGKILL');
      }
    } catch (err) {
      console.error(`❌ ${label} SIGKILL escalation failed: ${err.message}`);
    }
  }, delayMs);
  timer.unref?.();
  return timer;
}
