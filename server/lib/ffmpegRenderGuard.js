/**
 * Shared ffmpeg render-process lifecycle guard (#2398).
 *
 * The two SSE render runners — `server/services/musicVideo/render.js` and
 * `server/services/videoTimeline/local.js` — spawn ffmpeg and then wire an
 * identical spawn-state + exactly-once `terminal` guard around its 'spawn',
 * 'error', and 'close' events. That block is byte-for-byte parallel across the
 * two renderers; only the finalization *bodies* differ (music-video mutates the
 * project's render status; timeline does not). This helper owns the shared
 * mechanics and takes the service-specific finalize bodies as callbacks.
 *
 * The mechanics it owns:
 * - **Spawn-state tracking.** ffmpeg's 'error' fires for BOTH a genuine
 *   pre-spawn failure (ENOENT — the child never started, so no 'close' will
 *   follow) AND a later child-process error such as a failed kill (the ffmpeg
 *   is still live and 'close' still owes a terminal event). The 'spawn' event
 *   flips `spawned` so the 'error' handler can tell the two apart.
 * - **Pre-vs-post-spawn dispatch.** Pre-spawn errors finalize immediately
 *   (via `onSpawnError`); post-spawn errors only *record* the reason (via
 *   `onProcessError`) and retain process + mutex ownership until 'close' runs
 *   the sole terminal finalization — otherwise a replacement render could
 *   spawn and overlap the still-live ffmpeg.
 * - **Exactly-once `terminal` guard.** Whichever of {pre-spawn 'error',
 *   'close'} fires first sets `terminal` and runs the sole finalization; the
 *   other is a no-op. A post-spawn 'error' deliberately does NOT set `terminal`
 *   (the pending 'close' still owes the terminal event).
 *
 * These listeners run OUTSIDE the Express request lifecycle, so an uncaught
 * throw from a callback would crash the Node process (there is no `next(err)`
 * to bubble to). Each listener is wrapped in a last-resort try/catch that logs
 * via the emoji-prefixed convention — callbacks that want richer recovery
 * (emit an SSE error frame, release the mutex) keep their own inner try/catch.
 *
 * @param {import('child_process').ChildProcess} proc - the spawned ffmpeg child
 * @param {object} handlers
 * @param {string} handlers.label - log label for the crash-guard messages (e.g. "Music-video render")
 * @param {(err: Error) => void|Promise<void>} handlers.onSpawnError - pre-spawn failure: the child never started; finalize the job.
 * @param {(err: Error) => void|Promise<void>} handlers.onProcessError - post-spawn error: ffmpeg still live; record only, do NOT finalize.
 * @param {(code: number|null, signal: string|null) => void|Promise<void>} handlers.onClose - the sole terminal 'close' finalization.
 */
export function attachFfmpegRenderGuard(proc, { label, onSpawnError, onProcessError, onClose }) {
  let spawned = false;
  let terminal = false;
  proc.on('spawn', () => { spawned = true; });

  proc.on('error', async (err) => {
    try {
      // Already finalized (a pre-spawn error or 'close' won the race) — a late
      // stray 'error' (e.g. ESRCH/EPERM from a kill on the now-dead pid) must
      // not clobber a completed job.
      if (terminal) return;
      if (spawned) {
        // Post-spawn error. ffmpeg is still live — do NOT set `terminal` or
        // release ownership; the pending 'close' runs the sole finalization.
        await onProcessError(err);
        return;
      }
      // Pre-spawn failure: the child never started, so 'close' won't follow —
      // finalize here. Set `terminal` BEFORE the callback so a throw inside it
      // can't let 'close' re-run the finalization.
      terminal = true;
      await onSpawnError(err);
    } catch (e) {
      console.error(`❌ ${label} error handler failed: ${e.message}`);
    }
  });

  proc.on('close', async (code, signal) => {
    try {
      if (terminal) return; // a pre-spawn error already finalized this job
      terminal = true;
      await onClose(code, signal);
    } catch (e) {
      console.error(`❌ ${label} close handler failed: ${e.message}`);
    }
  });
}
