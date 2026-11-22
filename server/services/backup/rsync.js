/**
 * Backup subprocess supervision: the idle/wall-clock watchdog for rsync, tar
 * and pg tools, rsync binary resolution and the rsync runner.
 */

import { spawn } from '../../lib/childProcess.js';
import { killWithEscalation } from '../../lib/killWithEscalation.js';
import { stat } from 'fs/promises';
import { createLineReader } from '../../lib/streamLines.js';

// Backups and restores can legitimately run for hours on large or remote
// volumes, so a short elapsed-time cap would turn healthy work into failure.
// Treat ten minutes with no observable progress as a stall, while retaining a
// generous hard ceiling for a process that stays noisy forever.
export const BACKUP_PROCESS_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const BACKUP_PROCESS_WALL_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const BACKUP_PROCESS_PROGRESS_POLL_MS = 30 * 1000;

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

// Whole minutes for realistic deadlines ("10 minutes"), seconds below one
// minute, so the timeout message stays truthful under an override either way.
const describeIdleDuration = (ms) => {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} seconds`;
  const minutes = Math.round(ms / 60_000);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
};

class BackupProcessTimeoutError extends Error {
  constructor(label, timeoutKind, idleTimeoutMs = BACKUP_PROCESS_IDLE_TIMEOUT_MS) {
    const duration = timeoutKind === 'idle' ? `${describeIdleDuration(idleTimeoutMs)} without progress` : '4 hours';
    super(`${label} timed out after ${duration}`);
    this.name = 'BackupProcessTimeoutError';
    this.code = 'BACKUP_PROCESS_TIMEOUT';
    this.timeoutKind = timeoutKind;
  }
}

/**
 * Watch a backup subprocess for both stalled progress and runaway wall time.
 * The watchdog only starts termination; callers still settle from `close`, so
 * the backup lock and snapshot markers cannot clear while the child may write.
 *
 * pg_dump writes directly to `progressPath` and is normally silent. Polling its
 * growing output file lets a healthy large dump reset the idle timer without
 * adding verbose flags or buffering its SQL in memory.
 *
 * `idleTimeoutMs` overrides the default idle deadline for a caller whose
 * process can legitimately stay silent longer — restoreSnapshot derives one
 * from the largest in-scope file because a single file's `--checksum` digest
 * emits no output until it finishes (#7302). Callers that can produce regular
 * output leave the tight default so a genuinely wedged child is still caught
 * quickly.
 * `wallOnly` disables the idle timer and progress polling so a streaming download
 * subject to browser backpressure is not killed as stalled, while still
 * enforcing the 4-hour wall-time ceiling.
 */
export function watchBackupProcess(proc, { label, progressPath = null, idleTimeoutMs, wallOnly = false } = {}) {
  // Internal callers only, but a non-positive or non-numeric override would
  // silently disarm (0, NaN) or tighten (-1) the deadline — fall back instead.
  const idleDeadlineMs = Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0
    ? idleTimeoutMs
    : BACKUP_PROCESS_IDLE_TIMEOUT_MS;
  let finished = false;
  let timeoutError = null;
  let idleTimer = null;
  let escalationTimer = null;
  let progressPoll = null;
  let progressPollInFlight = false;
  let lastProgressSize = 0;

  const startTermination = (timeoutKind) => {
    if (finished || timeoutError || proc.exitCode !== null || proc.signalCode !== null) return;
    timeoutError = new BackupProcessTimeoutError(label, timeoutKind, idleDeadlineMs);
    console.warn(`⚠️ ${timeoutError.message} — terminating child process`);
    try {
      escalationTimer = killWithEscalation(proc, {
        label,
        stillRunning: () => !finished,
      });
    } catch (err) {
      // Keep the caller pending if termination itself fails. Releasing a backup
      // lock while its child may still mutate files or the database is unsafe.
      console.error(`❌ ${label} timeout termination failed: ${err.message}`);
    }
  };

  const armIdleTimer = () => {
    if (wallOnly) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => startTermination('idle'), idleDeadlineMs);
    idleTimer.unref?.();
  };

  const markActivity = () => {
    if (!finished && !timeoutError) armIdleTimer();
  };

  armIdleTimer();
  const wallTimer = setTimeout(() => startTermination('wall'), BACKUP_PROCESS_WALL_TIMEOUT_MS);
  wallTimer.unref?.();

  if (!wallOnly && progressPath) {
    progressPoll = setInterval(() => {
      if (finished || timeoutError || progressPollInFlight) return;
      progressPollInFlight = true;
      stat(progressPath)
        .then((info) => {
          if (info.size > lastProgressSize) {
            lastProgressSize = info.size;
            markActivity();
          }
        })
        // A missing or temporarily unreadable file is no progress. The idle
        // deadline remains authoritative and will terminate the child.
        .catch(() => {})
        .finally(() => { progressPollInFlight = false; });
    }, BACKUP_PROCESS_PROGRESS_POLL_MS);
    progressPoll.unref?.();
  }

  return {
    markActivity,
    getTimeoutError: () => timeoutError,
    finish: () => {
      if (finished) return false;
      finished = true;
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(wallTimer);
      if (progressPoll) clearInterval(progressPoll);
      if (escalationTimer) clearTimeout(escalationTimer);
      return true;
    },
  };
}

/**
 * Run rsync from srcDir to destDir with optional flags.
 * Resolves with array of changed file lines. Rejects on non-zero exit (24 only
 * when the caller opts in — see `allowVanishedSources`).
 */
export function resolveRsyncBinary(env = process.env) {
  const override = typeof env.PORTOS_RSYNC === 'string' ? env.PORTOS_RSYNC.trim() : '';
  // A bare command lets spawn resolve rsync through PATH on macOS, Linux,
  // Windows/MSYS, and non-standard Unix layouts. PORTOS_RSYNC remains the
  // explicit escape hatch for bundled or custom installations.
  return override || 'rsync';
}

// `allowVanishedSources` is the per-operation exit policy (#10898). A backup
// reads the LIVE data tree, where a file deleted mid-scan (exit 24) is normal
// and the snapshot is still a usable point-in-time copy. A restore reads a
// snapshot that must not change under it: exit 24 means part of its source
// disappeared, so live data may now mix restored and old files. Restore keeps
// the strict default and treats 24 like every other nonzero exit.
export function runRsync(srcDir, destDir, flags = [], { idleTimeoutMs, allowVanishedSources = false } = {}) {
  return new Promise((resolve, reject) => {
    // `--itemize-changes` emits only after each file finishes. `--progress` is
    // also supported by macOS's bundled rsync 2.6.9 and emits within a large
    // file, giving the idle watchdog evidence that a slow transfer is healthy.
    // Both report only TRANSFERRING files, so a caller that adds `--checksum`
    // must also pass `-ii` or its scan of an unchanged tree is silent for the
    // whole digest and the watchdog kills it — see restoreSnapshot. Even `-ii`
    // is a per-file heartbeat, so a caller expecting one very large file may
    // widen the idle deadline via `idleTimeoutMs` (see restoreSnapshot).
    const args = ['--archive', '--itemize-changes', '--progress', ...flags, srcDir + '/', destDir];
    const proc = spawn(resolveRsyncBinary(), args, { shell: false });

    const changed = [];
    let stderr = '';
    const watchdog = watchBackupProcess(proc, { label: 'backup rsync', idleTimeoutMs });

    const stdoutReader = createLineReader((line) => {
      if (line.startsWith('>') || line.startsWith('<')) {
        changed.push(line);
      }
    });
    proc.stdout.on('data', (chunk) => {
      watchdog.markActivity();
      stdoutReader.push(chunk);
    });

    proc.stderr.on('data', (chunk) => {
      watchdog.markActivity();
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      if (!watchdog.finish()) return;
      const timeoutError = watchdog.getTimeoutError();
      if (timeoutError) {
        reject(timeoutError);
        return;
      }
      // Exit code 24 = some source files vanished mid-transfer.
      if (code === 0 || (code === 24 && allowVanishedSources)) {
        stdoutReader.flush();
        resolve(changed);
      } else {
        const detail = code === 24 ? ' (source files vanished during transfer)' : '';
        reject(new Error(`rsync exited with code ${code}${detail}: ${stderr.trim()}`));
      }
    });

    proc.on('error', (err) => {
      // A timeout does not settle until `close`: the child may still be alive
      // after an error from a failed termination attempt.
      if (watchdog.getTimeoutError() || !watchdog.finish()) return;
      reject(new Error(`rsync spawn error: ${err.message}`));
    });
  });
}
