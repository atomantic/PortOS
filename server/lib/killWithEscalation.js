/**
 * Shared SIGTERM→grace→SIGKILL cancel-escalation for spawn-based media jobs.
 *
 * Every spawn-based job service (musicVideo/render, videoTimeline/local,
 * imageGen/local, imageGen/codex, videoGen/local, loraTraining, the yt-dlp
 * track import) cancels an in-flight child the same way: SIGTERM first, then
 * escalate to SIGKILL after a grace window IFF the tracked process is still the
 * one we spawned and hasn't exited yet. This helper is that single convention
 * so new job services converge here instead of re-copying the block by hand.
 *
 * Semantics preserved verbatim from the pre-existing call sites:
 *   - `proc.kill('SIGTERM')` is sent synchronously.
 *   - After `delayMs`, escalate to SIGKILL only when BOTH the caller's
 *     `stillRunning()` guard holds (e.g. `job.process === proc`, so a replaced
 *     or already-cleared handle is left alone) AND the child hasn't exited
 *     (`proc.exitCode === null && proc.signalCode === null` — `proc.killed` is
 *     set the moment `kill()` is called and does NOT mean the child exited).
 *
 * The escalation runs in a `setTimeout` OUTSIDE the Express request lifecycle,
 * so the callback is wrapped in try/catch (an uncaught throw there would crash
 * the Node process — there is no `next(err)` to bubble to). The timer is
 * `unref()`'d so a pending escalation can't hold the event loop open.
 *
 * @param {import('child_process').ChildProcess} proc - the child to terminate.
 * @param {object} opts
 * @param {string} opts.label - per-site label for the warning log (e.g.
 *   `music-video render`, `image child`, `yt-dlp import`).
 * @param {() => boolean} opts.stillRunning - predicate reproducing the caller's
 *   guard; escalation is skipped when it returns false.
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
