/** Run FFmpeg child processes and safely install the files they encode. */

import { randomUUID } from 'crypto';
import { unlink, rename } from 'fs/promises';
import { join, resolve as resolvePath, sep as PATH_SEP } from 'path';
import { spawn } from '../childProcess.js';
import { safeChildProcessOptions } from '../processEnv.js';

const IS_WIN = process.platform === 'win32';

// Validate that a sidecar/history-supplied filename is a safe basename under
// the expected directory — guards against tampered history entries with
// path-traversal segments (`../etc/passwd`) leaking into ffmpeg or unlink.
export const safeUnder = (root, name) => {
  if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  const rootResolved = resolvePath(root) + PATH_SEP;
  const fullPath = resolvePath(join(root, name));
  return fullPath.startsWith(rootResolved) ? fullPath : null;
};

/**
 * Spawn an ffmpeg child process and resolve with a structured result.
 * Collapses three sibling implementations (audioMux mux, optimizeForStreaming
 * faststart remux, upscaleVideo2x) onto one primitive so the spawn → stderr-
 * tail → close → SIGTERM-on-abort behavior stays in sync.
 *
 * - `bin`: absolute ffmpeg path (call `findFfmpeg()` upstream — keeps the
 *   discovery cache hot and lets the caller decide what to do when ffmpeg
 *   is missing). Required.
 * - `args`: argv passed to spawn. Required.
 * - `signal`: optional `AbortSignal`. When the signal fires we SIGTERM the
 *   child; the close handler reports `{ ok:false, reason: 'cancelled (SIGTERM)' }`.
 *   The abort listener is removed in a `finally`-shaped path so a long-lived
 *   signal (one per render queue, used across many calls) doesn't accumulate
 *   listeners on every successful ffmpeg run.
 * - `stderrTailBytes`: cap on the stderr buffer. `0` → `stdio: 'ignore'` (no
 *   stderr captured, matches the historical optimize/upscale behavior).
 *   Default `2000` mirrors audioMux's prior cap.
 *
 * - `returnStderr`: when true a successful result also carries the captured
 *   stderr tail as `stderr` (loudness measurement reads its JSON from there).
 * - `onLifecycle`: synchronous observer of fixed process phases and the
 *   owned child PID. A signal attempt is reported before delivery.
 *
 * - `label`: the program name failure reasons start with. The lifecycle is not
 *   ffmpeg-specific, so another media CLI (the Real-ESRGAN frame pass) reuses it
 *   under its own name.
 *
 * - `timeoutMs`: optional wall-clock ceiling for a stalled ffmpeg (unreadable
 *   input, evicted cloud file, dead network mount). On expiry the child gets
 *   SIGTERM, then SIGKILL after `FFMPEG_KILL_GRACE_MS`, and the result is
 *   `{ ok: false, reason: 'timed out after <n>s' }`. No default: long encodes
 *   rely on their caller `signal` instead. The `signal` abort path escalates
 *   to SIGKILL the same way.
 *
 * Returns `{ ok: true }` on exit code 0, otherwise `{ ok: false, reason }`
 * where `reason` is a short human-readable string suitable for logging or
 * surfacing in a UI error. Spawn errors are translated into `reason: 'spawn
 * failed: …'` so callers don't need a separate `.on('error', …)` handler.
 */
export const FFMPEG_KILL_GRACE_MS = 5000;
// Ceilings for bounded work: one frame/poster, and a single full-file pass.
export const FFMPEG_FRAME_TIMEOUT_MS = 2 * 60 * 1000;
export const FFMPEG_SCAN_TIMEOUT_MS = 15 * 60 * 1000;

export function runFfmpegProcess({ bin, args, signal, timeoutMs, stderrTailBytes = 2000, returnStderr = false, env, onStdout, onLifecycle, label = 'ffmpeg' } = {}) {
  if (!bin || typeof bin !== 'string') {
    return Promise.resolve({ ok: false, reason: 'invalid ffmpeg binary' });
  }
  if (!Array.isArray(args)) {
    return Promise.resolve({ ok: false, reason: 'invalid ffmpeg args' });
  }
  if (signal?.aborted) return Promise.resolve({ ok: false, reason: 'cancelled' });
  return new Promise((resolve) => {
    const stdio = ['ignore', onStdout ? 'pipe' : 'ignore', stderrTailBytes > 0 ? 'pipe' : 'ignore'];
    const proc = spawn(bin, args, safeChildProcessOptions({ stdio, ...(env ? { env } : {}) }));
    const report = phase => onLifecycle?.({ phase, pid: proc.pid ?? null });
    if (onStdout) proc.stdout.on('data', onStdout);
    let stderrTail = '';
    if (stderrTailBytes > 0 && proc.stderr) {
      proc.stderr.on('data', (chunk) => {
        stderrTail += chunk.toString();
        if (stderrTail.length > stderrTailBytes) {
          stderrTail = stderrTail.slice(-stderrTailBytes);
        }
      });
    }
    // `{ once: true }` auto-removes the listener when it fires. We still call
    // removeEventListener on normal completion so a signal reused across many
    // ffmpeg calls (one per render queue) doesn't accumulate dozens of unfired
    // listeners — the leak the audioMux audit flagged.
    let closed = false;
    let timedOut = false;
    let processError = null;
    let timeoutTimer = null;
    let killTimer = null;
    const sendSignal = (signal, phase) => {
      report(phase);
      try { proc.kill(signal); }
      catch (error) { recordError(error); }
    };
    // SIGTERM first; a child wedged in uninterruptible IO may ignore it, so
    // follow with SIGKILL unless it has closed by then.
    const terminate = () => {
      if (closed || killTimer) return;
      killTimer = setTimeout(() => {
        if (!closed && proc.exitCode == null && proc.signalCode == null) sendSignal('SIGKILL', 'kill');
      }, FFMPEG_KILL_GRACE_MS);
      killTimer.unref?.();
      sendSignal('SIGTERM', 'term');
    };
    const settle = result => {
      if (closed) return;
      closed = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', terminate);
      resolve(result);
    };
    const recordError = error => {
      const started = Boolean(proc.pid);
      report(started ? 'child-error' : 'spawn-error');
      // A signal refusal is an error from a live child. Keep the escalation
      // timer and leave its file owned until the close event.
      if (started) processError ??= error;
      else settle({ ok: false, reason: `spawn failed: ${error.message}` });
    };
    proc.on('error', recordError);
    proc.on('close', (code, sig) => {
      report('closed');
      if (timedOut) {
        settle({ ok: false, reason: `timed out after ${Math.round(timeoutMs / 1000)}s` });
        return;
      }
      if (sig === 'SIGTERM' || sig === 'SIGKILL') {
        settle({ ok: false, reason: `cancelled (${sig})` });
        return;
      }
      if (processError || signal?.aborted) {
        settle({ ok: false, reason: processError ? `${label} process error: ${processError.message}` : 'cancelled' });
        return;
      }
      if (code !== 0) {
        const tail = stderrTail.split(/\r?\n/).slice(-4).join(' | ');
        settle({ ok: false, reason: tail ? `${label} exit ${code}: ${tail}` : `${label} exit ${code}` });
        return;
      }
      settle(returnStderr ? { ok: true, stderr: stderrTail } : { ok: true });
    });
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutTimer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
      timeoutTimer.unref?.();
    }
    signal?.addEventListener('abort', terminate, { once: true });
    report('running');
    if (signal?.aborted) terminate();
  });
}

// Move a freshly-encoded temp file over the file it replaces.
//
// POSIX rename atomically replaces an existing destination in one syscall. On
// Windows, fs.rename fails when the destination already exists — but a simple
// unlink-first would destroy the original if the subsequent rename failed
// (locked file, AV scan, transient permissions). Move the original aside to a
// .bak first, install the new file, and restore the backup on failure. If the
// restore itself fails, retain that original and signal uncertain publication
// state so backup admission cannot accept the temporarily missing target.
//
// Extracted because three transform callers (`trimVideoFromFrame`, `upscaleVideo2x`,
// `optimizeForStreaming`) need this identical rollback, and a data-loss-
// sensitive path with three copies is one that eventually gets fixed in only
// two of them. Exported for the same reason: `pipeline/audioMux.js` replaces
// the stitched episode in place from four more entry points, and its own bare
// `rename` was exactly the copy that never got fixed (#7237). `label` names
// the operation for the failure message.
//
// Returns `{ ok: true, outPath }` or `{ ok: false, reason }`. A failed rollback
// throws explicitly uncertain publication state and retains the original backup.
export const installEncodedVideo = async (tmpPath, targetPath, label) => {
  let backupPath = null;
  try {
    if (IS_WIN) {
      const candidate = `${targetPath}.bak.${randomUUID()}`;
      await rename(targetPath, candidate).then(() => { backupPath = candidate; }).catch((err) => {
        if (err?.code !== 'ENOENT') throw err;
      });
    }
    await rename(tmpPath, targetPath);
    if (backupPath) await unlink(backupPath).catch(() => {});
    return { ok: true, outPath: targetPath };
  } catch (err) {
    if (backupPath) {
      try { await rename(backupPath, targetPath); }
      catch (rollbackError) {
        throw Object.assign(new AggregateError([err, rollbackError], `Failed to restore ${label} video; original retained at ${backupPath}`), {
          backupPublicationUncertain: true, recoveryPath: backupPath,
        });
      }
    }
    await unlink(tmpPath).catch(() => {});
    return { ok: false, reason: `Failed to install ${label} video: ${err.message}` };
  }
};
