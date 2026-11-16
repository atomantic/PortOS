/**
 * Shared spawn-state tracking and exactly-once terminal callback for the SSE ffmpeg render runners (`attachFfmpegRenderGuard`).
 *
 * Callers (musicVideo/render, videoTimeline/local) supply their own finalize bodies as callbacks.
 *
 * ffmpeg's 'error' fires for BOTH a pre-spawn failure (ENOENT: no 'close' will follow) AND a later
 * child error such as a failed kill (ffmpeg still live, 'close' still owes the terminal event);
 * 'spawn' flips `spawned` to tell them apart. Pre-spawn errors finalize via `onSpawnError`; post-spawn
 * errors only record via `onProcessError` and keep process + mutex ownership until 'close', otherwise
 * a replacement render could overlap the live ffmpeg. Whichever of {pre-spawn 'error', 'close'} fires
 * first sets `terminal` and finalizes; the other is a no-op.
 *
 * These listeners run outside the Express lifecycle, so each is wrapped in a last-resort try/catch;
 * callbacks wanting richer recovery keep their own inner try/catch.
 *
 * @param {import('child_process').ChildProcess} proc - the spawned ffmpeg child
 * @param {object} handlers
 * @param {string} handlers.label - log label for the crash-guard messages
 * @param {(err: Error) => void|Promise<void>} handlers.onSpawnError - child never started; finalize the job.
 * @param {(err: Error) => void|Promise<void>} handlers.onProcessError - ffmpeg still live; record only, do NOT finalize.
 * @param {(code: number|null, signal: string|null) => void|Promise<void>} handlers.onClose - the sole terminal finalization.
 */
export function attachFfmpegRenderGuard(proc, { label, onSpawnError, onProcessError, onClose }) {
  let spawned = false;
  let terminal = false;
  proc.on('spawn', () => { spawned = true; });

  proc.on('error', async (err) => {
    try {
      // A late stray 'error' (e.g. ESRCH/EPERM from killing a dead pid) must not clobber a completed job.
      if (terminal) return;
      if (spawned) {
      // Post-spawn: ffmpeg still live; the pending 'close' runs the sole finalization.
        await onProcessError(err);
        return;
      }
      // Pre-spawn: no 'close' will follow. Set `terminal` BEFORE the callback so a throw can't let 'close' re-finalize.
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
