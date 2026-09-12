/**
 * Backup Service
 *
 * Rsync-based incremental backup from ./data/ to an external drive.
 * Generates SHA-256 manifests for integrity verification.
 * Integrates with eventScheduler for daily cron scheduling.
 */

import { spawn } from '../lib/childProcess.js';
import { killWithEscalation } from '../lib/killWithEscalation.js';
import { access, lstat, readdir, readFile, stat, unlink, writeFile } from 'fs/promises';
import { PassThrough } from 'node:stream';
import { hostname } from 'os';
import { join, resolve, relative, isAbsolute, posix } from 'path';
import { PATHS, ensureDir, readJSONFile, readJSONFileStrict, atomicWrite, sha256File } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { createLineReader } from '../lib/streamLines.js';
import { getEvent } from './eventScheduler.js';
import { checkHealth, getServerMajorVersion } from '../lib/db.js';
import { resolvePgDumpBinary } from '../lib/pgTools.js';
import { getBackendName } from './memoryBackend.js';
import { emitErrorEvent, ServerError } from '../lib/errorHandler.js';
import { isSafeSubdirFilter } from '../lib/sharedSchemas.js';
import { getIo } from './socket.js';
import { reloadSettings } from './settings.js';
import { invalidateAllCaches as invalidateBrainCaches } from './brainStorage.js';

// Module-level state
let isRunning = false;

// Backups and restores can legitimately run for hours on large or remote
// volumes, so a short elapsed-time cap would turn healthy work into failure.
// Treat ten minutes with no observable progress as a stall, while retaining a
// generous hard ceiling for a process that stays noisy forever.
const BACKUP_PROCESS_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const BACKUP_PROCESS_WALL_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const BACKUP_PROCESS_PROGRESS_POLL_MS = 30 * 1000;

const STATE_PATH = join(PATHS.data, 'backup', 'state.json');
// A snapshot mid-assembly is a truncated tree that looks like a finished backup.
// Two signals guard it, because neither alone is sufficient:
//   - `activeSnapshotId` catches the in-process case with no I/O.
//   - the `.in-progress` marker survives a hard crash or PM2 restart, which
//     resets module state while the partial directory stays on the drive.
// A finished failure replaces these guards with `.failed`: downloads remain
// available for manual salvage, while restore paths can distinguish the partial
// tree from both completed and legacy snapshots after a restart.
const SNAPSHOT_IN_PROGRESS_MARKER = '.in-progress';
const SNAPSHOT_FAILED_MARKER = '.failed';
// The pg_dump lives one level ABOVE the snapshot's data/ tree, so its manifest
// key is parent-relative. File restore must recognize and skip this key rather
// than resolving it as a data-file path — restorePostgres verifies it.
const SNAPSHOT_DUMP_MANIFEST_KEY = '../portos-db.sql';
let activeSnapshotId = null;

const markerPath = (snapshotDir) => join(snapshotDir, SNAPSHOT_IN_PROGRESS_MARKER);
const failedMarkerPath = (snapshotDir) => join(snapshotDir, SNAPSHOT_FAILED_MARKER);
const parentMarkerPath = (snapshotDir, snapshotId) =>
  join(resolve(snapshotDir, '..'), `.${snapshotId}${SNAPSHOT_IN_PROGRESS_MARKER}`);
const markerExistsAt = (path) =>
  access(path).then(
    () => true,
    (err) => err?.code === 'ENOENT' || err?.code === 'ENOTDIR' ? false : true,
  );
const markerExists = (snapshotDir, snapshotId) =>
  Promise.all([
    markerExistsAt(markerPath(snapshotDir)),
    snapshotId
      ? markerExistsAt(parentMarkerPath(snapshotDir, snapshotId))
      : false,
  ]).then(([snapshotMarker, parentMarker]) => snapshotMarker || parentMarker);

const failedMarkerExists = (snapshotDir) =>
  markerExistsAt(failedMarkerPath(snapshotDir));

async function snapshotState(snapshotDir, snapshotId) {
  const [markedInProgress, failed] = await Promise.all([
    markerExists(snapshotDir, snapshotId),
    failedMarkerExists(snapshotDir),
  ]);
  return {
    failed,
    // Once `.failed` exists the run is finished even if marker cleanup was
    // interrupted. The durable failed state still blocks every restore.
    incomplete: snapshotId === activeSnapshotId || (markedInProgress && !failed),
  };
}

/** Reject a snapshot that is still being written before any consumer reads it. */
async function assertSnapshotComplete(snapshotDir, snapshotId) {
  const { incomplete } = await snapshotState(snapshotDir, snapshotId);
  if (incomplete) {
    throw new ServerError(`Snapshot is still being written: ${snapshotId}`, {
      status: 409,
      code: 'SNAPSHOT_INCOMPLETE',
    });
  }
}

/** Reject snapshots whose backup run finished unsuccessfully before restoring. */
async function assertSnapshotRestorable(snapshotDir, snapshotId) {
  const { incomplete, failed } = await snapshotState(snapshotDir, snapshotId);
  if (incomplete) {
    throw new ServerError(`Snapshot is still being written: ${snapshotId}`, {
      status: 409,
      code: 'SNAPSHOT_INCOMPLETE',
    });
  }
  if (failed) {
    throw new ServerError(`Snapshot backup failed: ${snapshotId}. Choose a completed backup to restore.`, {
      status: 409,
      code: 'SNAPSHOT_FAILED',
    });
  }
}

// Serialize state read-merge-write so two saveState() calls (e.g. a run
// completing while the scheduler stamps a status) can't each read the same
// pre-image and clobber the other's fields. Single tail per shared state file.
const queueStateWrite = createFileWriteQueue();

// Paths under data/ that are skipped by default on top of user-configured excludes.
// Two classes live here: (1) ephemeral/cache data the user almost never wants in a
// snapshot (browser profile, agent worktrees), and (2) large re-downloadable assets
// (LoRA model files, cloned repos, browser downloads) that would bloat the backup
// target — typically iCloud or an external drive with limited capacity. Entries
// tagged `overridable: true` can be re-enabled from the Backup settings UI via
// `disabledDefaultExcludes`; non-overridable entries hold no irreplaceable user data
// and stay off unconditionally. When adding a new entry, ensure the path glob covers
// *every* on-disk location for that class of data — e.g. agent worktrees live under
// both cos/worktrees/ and cos/feature-agents/*/worktree/; cross-reference
// worktreeManager.js and agentLifecycle.js if introducing new worktree paths.
//
// All paths are anchored with a leading `/` (rsync filter syntax for "relative to
// the transfer root"). Without the anchor, a pattern like `loras/*.safetensors`
// matches any `loras/` directory anywhere under data/ (e.g. a user's
// brain/.../loras/ collection), which would silently exclude unrelated user data.
export const DEFAULT_EXCLUDES = [
  { path: '/browser-profile/', reason: 'Browser CDP profile — cache/cookies, can be several GB', overridable: false },
  { path: '/cos/worktrees/', reason: 'Ephemeral agent git worktrees — recreated on demand', overridable: false },
  { path: '/cos/slashdo-resolved/', reason: 'Resolved slashdo command bodies staged for agent prompts — derived from the bundled submodule, regenerated on demand', overridable: false },
  { path: '/cos/feature-agents/*/worktree/', reason: 'Per-feature-agent git worktrees — recreated on demand', overridable: false },
  { path: '/loras/*.safetensors', reason: 'LoRA adapter weight files — large, re-downloadable. .metadata.json sidecars (Civitai metadata, user-editable name/notes) ARE backed up.', overridable: true },
  // `**` (not `*`) so both engines' checkpoint dirs match: the torch trainer
  // writes training-runs/<id>/checkpoints/, mflux writes
  // training-runs/<id>/mflux/checkpoints/.
  { path: '/training-runs/**/checkpoints/', reason: 'LoRA training checkpoints — large intermediate adapter state, resumable-but-regenerable. Final trained adapters land in data/loras/ (weights excluded there too); run samples + configs ARE backed up.', overridable: true },
  { path: '/training-runs/*/cache/', reason: 'Precomputed latent/text-embedding training cache — regenerated from the dataset on the next run', overridable: false },
  { path: '/training-runs/*/data/.mflux_cache/', reason: 'mflux low_ram disk-backed encode cache (written inside the staged training data dir) — regenerable', overridable: false },
  { path: '/repos/', reason: 'Cloned git repositories — large, re-cloneable from origin', overridable: true },
  { path: '/cos/reference-repos/', reason: 'Reference upstream repos used by agents — re-cloneable', overridable: true },
  { path: '/browser-downloads/', reason: 'Browser downloads cache — large, re-downloadable', overridable: true },
  { path: '/cache/', reason: 'Remote-API metadata and licensed reading caches — regenerable on demand, and stale on restore anyway', overridable: false },
  // Sprite animation-run raw intermediates: 30–96 ffmpeg-extracted PNGs per
  // run, byte-for-byte regenerable from the archived source video by the
  // deterministic postprocess (walkPostprocess.js). The source video, packaged
  // frames, strips, manifests, and runtime atlases ARE backed up. `runs/` is
  // the live (vendor-neutral) layout; `grok/` covers pre-migration-202 runs.
  { path: '/sprites/*/grok/*/generated/raw/', reason: 'Sprite walk-run raw extracted frames — regenerable from the archived source video', overridable: true },
  { path: '/sprites/*/runs/*/generated/raw/', reason: 'Imported sprite-run raw extracted frames — regenerable from the archived source video', overridable: true },
  // Anchored with a leading `/` like every entry here — an unanchored `model.obj`
  // would match at any depth and silently drop unrelated user data.
  //
  // TRELLIS.2's `generate.py` writes this full-resolution OBJ next to the GLB it
  // exports: the decoder's mesh before bake-time decimation, measured at 930 MB /
  // 22.7M faces for one 1024_cascade render. It is regenerable by re-rendering the
  // same source at the same seed, it is not what the 3D page loads (that is
  // model.glb, which IS backed up), and at ~1 GB per render it would otherwise
  // dominate every snapshot. Overridable, because it is the only copy of the
  // discarded detail and someone archiving finished work may want it.
  // Anchored, like every entry here. Capability-test sandboxes are throwaway
  // copies of a fixture that ships in the repo — restoring one would restore a
  // half-finished agent edit, which is worse than not having it.
  { path: '/model-tests/sandboxes/', reason: 'Capability-test agent sandboxes — throwaway working copies of a repo fixture, recreated per run', overridable: false },
  // Anchored, like every entry here. Scratch for ONE in-flight auto-skin run: the
  // worker's staging copy of the rigged GLB plus its job/report files, deleted the
  // moment the run publishes or fails (services/rigging/autoSkin.js). A snapshot that
  // caught it mid-run would restore a half-written mesh next to the published pair.
  // The PUBLISHED rig (rig/<rigId>/) is deliberately NOT excluded: re-deriving it needs
  // a provisioned Blender runtime the restore target may not have, and a rigged GLB is
  // megabytes, not the gigabyte-per-render the model.obj sidecar below costs.
  { path: '/image-to-3d/*/rig/.staging/', reason: 'In-flight auto-skin staging directory — scratch for one rigging run, removed when it publishes or fails. The published rig/<rigId>/ pair IS backed up.', overridable: false },
  // Anchored, like every entry here. Same contract one step later: scratch for ONE
  // in-flight retarget run (services/rigging/retarget.js), including the probe pass's
  // job/report files. The PUBLISHED animation (retarget/<retargetId>/) is NOT excluded,
  // for the same reason the rig is not — re-deriving it needs both a Blender runtime and
  // the clip file the run used.
  { path: '/image-to-3d/*/retarget/.staging/', reason: 'In-flight retarget staging directory — scratch for one retarget run, removed when it publishes or fails. The published retarget/<retargetId>/ pair IS backed up.', overridable: false },
  { path: '/image-to-3d/*/model.obj', reason: 'TRELLIS.2 full-resolution mesh sidecar — ~1 GB per render, regenerable by re-rendering at the same seed. The exported model.glb and keyed source ARE backed up.', overridable: true },
  // Anchored, like every entry here. Not overridable: these are another
  // machine's conditioning bytes, staged for one federated render and swept on
  // a TTL measured in hours. Nothing here is this install's data to keep, and a
  // restored inbox entry is either already expired or already rendered.
  { path: '/federated-media-inbox/', reason: 'Conditioning images an allowlisted peer uploaded for one federated render — TTL-swept, and another machine\'s data rather than this install\'s', overridable: false },
  // Anchored, like every entry here. The Beeper attachment mirror (#37) is a
  // lazy CACHE of bytes Beeper Desktop can re-supply, re-fetched on first view
  // and rendered as a labelled reference when it cannot — so a snapshot that
  // skips it loses no record, only a re-download. It is also by far the largest
  // thing the Comms feature puts on disk, which is exactly the kind of
  // directory that turns a nightly snapshot into an hour.
  // Overridable, because an archive of a conversation is more useful with its
  // photos in it, and someone keeping one may well want to pay for them.
  { path: '/beeper/attachments/', reason: 'Beeper attachment byte mirror — a lazy cache re-fetchable from Beeper Desktop; the message bodies and attachment metadata live in Postgres and ARE backed up', overridable: true }
  // NOTE: legacy file→Postgres migration artifacts (`.imported` / `.bak-NNN`)
  // are intentionally NOT excluded here. They are deleted on disk by the
  // boot-time prune (pruneImportedLegacyFiles.js) the same boot the migration
  // runs — but ONLY once the DB is provably authoritative. While the prune is
  // *blocked* (a wiped/partial-restore DB short of the migration markers) those
  // parked files are the only recovery source, and `pg_dump` is capturing the
  // incomplete DB — so excluding them from snapshots would mean a backup taken
  // in that window restores neither the missing rows nor the source to rebuild
  // them. Letting rsync copy them is the safe default; once the prune removes
  // them from disk they leave subsequent snapshots naturally.
];

// Snapshots live under snapshots/<hostname>/<snapshotId> so a single shared
// destination (e.g. iCloud) can host backups from multiple machines without
// their snapshot IDs colliding.
const MACHINE_HOST = hostname().toLowerCase().replace(/[^\w.\-]/g, '_') || 'unknown';

const DEFAULT_STATE = {
  lastRun: null,
  status: 'never',
  lastSnapshotId: null,
  filesChanged: 0,
  pgBackup: null,
  error: null
};

/**
 * Map a dumpPostgres result to the overall backup status. Only a *failed*
 * dump (PG configured but the dump errored) degrades the backup; a *skipped*
 * dump (no PG — file mode) is benign and stays 'ok'.
 * @param {{status: string}} pgResult
 * @returns {'ok'|'degraded'}
 */
export function backupStatusForPg(pgResult) {
  return pgResult?.status === 'failed' ? 'degraded' : 'ok';
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

class BackupProcessTimeoutError extends Error {
  constructor(label, timeoutKind) {
    const duration = timeoutKind === 'idle' ? '10 minutes without progress' : '4 hours';
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
 */
function watchBackupProcess(proc, { label, progressPath = null } = {}) {
  let finished = false;
  let timeoutError = null;
  let idleTimer = null;
  let escalationTimer = null;
  let progressPoll = null;
  let progressPollInFlight = false;
  let lastProgressSize = 0;

  const startTermination = (timeoutKind) => {
    if (finished || timeoutError || proc.exitCode !== null || proc.signalCode !== null) return;
    timeoutError = new BackupProcessTimeoutError(label, timeoutKind);
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
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => startTermination('idle'), BACKUP_PROCESS_IDLE_TIMEOUT_MS);
    idleTimer.unref?.();
  };

  const markActivity = () => {
    if (!finished && !timeoutError) armIdleTimer();
  };

  armIdleTimer();
  const wallTimer = setTimeout(() => startTermination('wall'), BACKUP_PROCESS_WALL_TIMEOUT_MS);
  wallTimer.unref?.();

  if (progressPath) {
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
      clearTimeout(idleTimer);
      clearTimeout(wallTimer);
      if (progressPoll) clearInterval(progressPoll);
      if (escalationTimer) clearTimeout(escalationTimer);
      return true;
    },
  };
}

/**
 * Run rsync from srcDir to destDir with optional flags.
 * Resolves with array of changed file lines. Rejects on non-zero exit (except 24).
 */
export function resolveRsyncBinary(env = process.env) {
  const override = typeof env.PORTOS_RSYNC === 'string' ? env.PORTOS_RSYNC.trim() : '';
  // A bare command lets spawn resolve rsync through PATH on macOS, Linux,
  // Windows/MSYS, and non-standard Unix layouts. PORTOS_RSYNC remains the
  // explicit escape hatch for bundled or custom installations.
  return override || 'rsync';
}

function runRsync(srcDir, destDir, flags = []) {
  return new Promise((resolve, reject) => {
    // `--itemize-changes` emits only after each file finishes. `--progress` is
    // also supported by macOS's bundled rsync 2.6.9 and emits within a large
    // file, giving the idle watchdog evidence that a slow transfer is healthy.
    const args = ['--archive', '--itemize-changes', '--progress', ...flags, srcDir + '/', destDir];
    const proc = spawn(resolveRsyncBinary(), args, { shell: false });

    const changed = [];
    let stderr = '';
    const watchdog = watchBackupProcess(proc, { label: 'backup rsync' });

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
      // Exit code 24 = some files vanished mid-transfer (normal for active system)
      if (code === 0 || code === 24) {
        stdoutReader.flush();
        resolve(changed);
      } else {
        reject(new Error(`rsync exited with code ${code}: ${stderr.trim()}`));
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

// =============================================================================
// EXPORTS
// =============================================================================

/**
 * Compute the effective rsync --exclude list for a backup run. Pure function
 * extracted so the Array.isArray guards + override allow-list can be unit
 * tested without spawning rsync.
 *
 * - Non-overridable defaults stay on regardless of `disabledDefaultExcludes` so
 *   ephemeral/cache paths can never be backed up by mistake (e.g. via a
 *   hand-edited settings.json).
 * - Array.isArray guards: settings can be hand-edited or sent by a stale
 *   client, so a non-array value here would otherwise throw inside .filter
 *   and abort the backup before the defensive allow-list has a chance to apply.
 */
export function computeEffectiveExcludes({ excludePaths, disabledDefaultExcludes } = {}) {
  const overridablePaths = new Set(DEFAULT_EXCLUDES.filter(e => e.overridable).map(e => e.path));
  const disabledList = Array.isArray(disabledDefaultExcludes) ? disabledDefaultExcludes : [];
  const userList = Array.isArray(excludePaths) ? excludePaths : [];
  const disabledSet = new Set(disabledList.filter(p => overridablePaths.has(p)));
  const activeDefaults = DEFAULT_EXCLUDES.filter(e => !disabledSet.has(e.path)).map(e => e.path);
  const userExcludes = userList.filter(Boolean);
  return [...new Set([...activeDefaults, ...userExcludes])];
}

/**
 * Run a full backup snapshot from PATHS.data to destPath.
 * @param {string} destPath - Path to external drive backup root
 * @param {object|null} io - Socket.IO instance for real-time events (optional)
 */
export async function runBackup(destPath, io = null, { excludePaths = [], disabledDefaultExcludes = [] } = {}) {
  if (isRunning) {
    console.log('💾 Backup already running — skipping');
    return { skipped: true };
  }

  if (!destPath) {
    throw new Error('Backup destination not configured');
  }

  isRunning = true;
  let snapshotId = null;
  let snapshotDir;
  let parentMarker;

  const effectiveExcludes = computeEffectiveExcludes({ excludePaths, disabledDefaultExcludes });

  let changedFiles = [];
  let manifest;

  const clearInProgressMarkers = async () => {
    if (snapshotDir) await unlink(markerPath(snapshotDir)).catch(() => {});
    if (parentMarker) await unlink(parentMarker).catch(() => {});
  };

  const releaseActiveSnapshot = () => {
    activeSnapshotId = null;
  };

  const complete = async (result) => {
    if (snapshotDir) await unlink(failedMarkerPath(snapshotDir)).catch(() => {});
    await clearInProgressMarkers();
    releaseActiveSnapshot();
    isRunning = false;
    return result;
  };

  const fail = async (err) => {
    // Persist failure BEFORE removing the incomplete guards. If the marker
    // cannot be written, retain those guards so a partial tree never becomes a
    // restore source. The process lock is independent and is always released.
    const failureRecorded = snapshotDir
      ? await writeFile(failedMarkerPath(snapshotDir), '').then(() => true, () => false)
      : false;
    if (failureRecorded) await clearInProgressMarkers();
    releaseActiveSnapshot();
    isRunning = false;
    await saveState({ lastRun: new Date().toISOString(), status: 'error', error: err.message, pgBackup: null }).catch(() => {});
    if (io) io.emit('backup:failed', { snapshotId, error: err.message });
    throw err;
  };

  try {
    await access(destPath).catch((cause) => {
      // Never expose the filesystem message: it can include private paths.
      const code = ['ENOENT', 'EACCES', 'EPERM', 'EIO'].includes(cause.code) ? cause.code : 'UNKNOWN';
      const message = code === 'ENOENT' ? 'Backup destination not found' : 'Backup destination inaccessible';
      const error = new ServerError(`${message} (${code})`, { code: `BACKUP_DESTINATION_${code}` });
      error.cause = cause;
      throw error;
    });
    snapshotId = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
    const snapshotsRoot = join(destPath, 'snapshots', MACHINE_HOST);
    snapshotDir = join(snapshotsRoot, snapshotId);
    parentMarker = parentMarkerPath(snapshotDir, snapshotId);
    const dataDestDir = join(snapshotDir, 'data');

    console.log(`💾 Backup starting: snapshot ${snapshotId} (excluding ${effectiveExcludes.length} paths)`);
    if (io) io.emit('backup:started', { snapshotId });

    // Establish the durable parent marker before exposing the snapshot
    // directory. A crash during directory setup therefore cannot leave a
    // snapshot that consumers mistake for a completed backup after restart.
    await ensureDir(snapshotsRoot);
    await writeFile(parentMarker, '');
    await ensureDir(dataDestDir);
    activeSnapshotId = snapshotId;
    await writeFile(markerPath(snapshotDir), '');

    const excludeFlags = effectiveExcludes.flatMap(p => ['--exclude', p]);
    changedFiles = await runRsync(PATHS.data, dataDestDir, excludeFlags);
    console.log(`💾 Backup rsync complete: ${changedFiles.length} files changed (exit 0)`);

    // Dump PostgreSQL alongside the file backup. Result is NO LONGER swallowed —
    // a configured-but-failed dump must degrade the backup and alert the user.
    const pgDumpPath = join(snapshotDir, 'portos-db.sql');
    const pgResult = await dumpPostgres(pgDumpPath);

    manifest = await generateManifest(dataDestDir, join(snapshotDir, 'manifest.json'), pgDumpPath, {
      allowMissingDump: pgResult.status === 'skipped' || pgResult.status === 'failed'
    });

    const status = backupStatusForPg(pgResult);
    const lastRun = new Date().toISOString();
    await saveState({
      lastRun,
      lastSnapshotId: snapshotId,
      status,
      filesChanged: changedFiles.length,
      pgBackup: pgResult,
      error: pgResult.status === 'failed' ? `DB dump ${pgResult.reason}` : null
    });

    if (io) io.emit('backup:completed', { snapshotId, filesChanged: changedFiles.length, status, pgBackup: pgResult });

    // Loud-on-failure: surface a degraded DB dump as a warning toast, even on
    // unattended scheduled runs (which pass io=null) via the module-level io.
    if (pgResult.status === 'failed') {
      const errIo = io || getIo();
      if (errIo) {
        emitErrorEvent(errIo, new ServerError(
          `Backup DB dump failed: ${pgResult.reason}`,
          { status: 500, code: 'BACKUP_DB_DUMP_FAILED', severity: 'warning' }
        ));
      }
    }

    return complete({ snapshotId, filesChanged: changedFiles.length, status, lastRun, manifest, pgBackup: pgResult });
  } catch (err) {
    return fail(err);
  }
}

/**
 * Run pg_dump to create a PostgreSQL backup alongside the rsync snapshot.
 * Returns an explicit status so the caller can distinguish the benign file
 * escape hatch from "PG required but dump failed" (data at risk):
 *   { status: 'ok', sizeBytes, tableCount }
 *   { status: 'skipped', reason: 'not_configured' }   (explicit file escape hatch only)
 *   { status: 'failed', reason: 'pg_unreachable'|'pg_dump_missing'|'version_mismatch'|'dump_error'|'empty_dump'|'timeout', error }
 *     (pg_unreachable fires whenever Postgres is required — i.e. not the file
 *      escape hatch — but the DB is down at backup time; version_mismatch means
 *      no installed pg_dump is new enough for the running server)
 * @param {string} outputPath - Path to write the SQL dump file
 */
export async function dumpPostgres(outputPath) {
  const health = await checkHealth();
  if (!health.connected || !health.hasSchema) {
    // PG unreachable or uninitialized. Since PostgreSQL is now a mandatory
    // dependency, the ONLY benign "no PG to back up" case is the explicit file
    // escape hatch (MEMORY_BACKEND=file, or the backend resolved to 'file' in
    // test/dev mode). Every other state — including a default install whose
    // memory backend simply hasn't initialized yet (getBackendName() === null)
    // — means Postgres is required, so an unreachable DB is a real backup
    // failure (data that lives only in PG won't be captured). Degrade and alert
    // rather than silently skip; gating on getBackendName() === 'postgres'
    // alone would let an outage-before-first-memory-access read as a green
    // "not configured" run.
    const env = process.env.MEMORY_BACKEND;
    const fileEscapeHatch = env === 'file' || getBackendName() === 'file';
    if (!fileEscapeHatch) {
      return { status: 'failed', reason: 'pg_unreachable', error: health.error || 'PostgreSQL is required but is unreachable or uninitialized' };
    }
    return { status: 'skipped', reason: 'not_configured' };
  }

  const pgHost = process.env.PGHOST || 'localhost';
  const pgPort = process.env.PGPORT || '5432';
  const pgDb = process.env.PGDATABASE || 'portos';
  const pgUser = process.env.PGUSER || 'portos';

  if (!process.env.PGPASSWORD) {
    console.warn('⚠️ PGPASSWORD not set for pg_dump — using default');
  }

  // pg_dump must be >= the server's major version or it aborts on a "server
  // version mismatch". On machines with multiple Postgres installs (the common
  // Homebrew case: an old postgresql@NN keg shadowing a newer running server in
  // PATH) the bare `pg_dump` is often the wrong one, so select a matching binary
  // instead of trusting PATH order.
  const serverMajor = await getServerMajorVersion();
  // Shared resolver (server/lib/pgTools.js): PORTOS_PGDUMP override wins, else
  // auto-select a binary whose major is >= the server when we know the version,
  // else fall back to bare `pg_dump` off PATH.
  const { binary: pgDumpBin, satisfies } = await resolvePgDumpBinary(serverMajor);
  if (!satisfies) {
    console.warn(`⚠️ No installed pg_dump satisfies server major ${serverMajor} (using ${pgDumpBin})`);
  }

  return new Promise((resolvePromise) => {
    // --clean --if-exists: the dump DROPs each object before recreating it, so it
    // replays cleanly into the live, already-initialized PortOS database (the
    // common Restore-DB target) instead of erroring "relation already exists" on
    // the first CREATE. Without it the dump is only restorable into an empty DB.
    const proc = spawn(pgDumpBin, [
      '-h', pgHost,
      '-p', pgPort,
      '-U', pgUser,
      '-d', pgDb,
      '--no-owner',
      '--no-acl',
      '--clean',
      '--if-exists',
      '-f', outputPath
    ], {
      shell: false,
      env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD || 'portos' }
    });

    let stderr = '';
    const watchdog = watchBackupProcess(proc, { label: 'PostgreSQL dump', progressPath: outputPath });
    proc.stderr.on('data', (chunk) => {
      watchdog.markActivity();
      stderr += chunk.toString();
    });

    proc.on('close', async (code) => {
      if (!watchdog.finish()) return;
      const timeoutError = watchdog.getTimeoutError();
      if (timeoutError) {
        await unlink(outputPath).catch(() => {});
        resolvePromise({ status: 'failed', reason: 'timeout', error: timeoutError.message });
        return;
      }
      if (code !== 0) {
        console.warn(`⚠️ pg_dump failed (code ${code}): ${stderr.trim()}`);
        // pg_dump can exit non-zero after writing a partial file (e.g. mid-dump
        // connection loss). Remove it so a later restore can't trust a truncated
        // dump on size alone — a failed dump must leave no restorable artifact.
        await unlink(outputPath).catch(() => {});
        // A version mismatch is a distinct, actionable failure (install a newer
        // pg_dump) — classify it so the UI can point at the fix instead of the
        // generic "is pg_dump installed / is PG reachable" hint.
        const isMismatch = !satisfies || /server version mismatch|aborting because of server version/i.test(stderr);
        resolvePromise({ status: 'failed', reason: isMismatch ? 'version_mismatch' : 'dump_error', error: stderr.trim() });
        return;
      }
      // Verify: a dump that exits 0 but is empty/truncated is still a failure.
      const info = await stat(outputPath).catch(() => null);
      if (!info || info.size === 0) {
        console.warn('⚠️ pg_dump produced an empty dump file');
        resolvePromise({ status: 'failed', reason: 'empty_dump', error: 'dump file missing or 0 bytes' });
        return;
      }
      const sql = await readFile(outputPath, 'utf-8').catch(() => '');
      const tableCount = (sql.match(/^CREATE TABLE /gm) || []).length;
      console.log(`💾 pg_dump complete: ${Math.round(info.size / 1024)}KB, ${tableCount} tables`);
      // Don't return the absolute dump path: this result is persisted into
      // state.pgBackup and surfaced to the client via GET /api/backup/status,
      // the backup:completed socket event, and the /run response. No client
      // reads it (restorePostgres recomputes its own sqlPath), so leaking an
      // internal FS path serves no purpose.
      resolvePromise({ status: 'ok', sizeBytes: info.size, tableCount });
    });

    proc.on('error', (err) => {
      if (watchdog.getTimeoutError() || !watchdog.finish()) return;
      // pg_dump not installed — a configured-but-unbacked-up DB is at risk,
      // so this is a failure, not a silent skip.
      console.warn(`⚠️ pg_dump not available: ${err.message}`);
      resolvePromise({ status: 'failed', reason: 'pg_dump_missing', error: err.message });
    });
  });
}

// Filesystem messages contain private paths; only expose the operation and errno.
function manifestReadFailure(operation, err) {
  const code = /^E[A-Z0-9]+$/.test(err?.code) ? err.code : 'UNKNOWN';
  return new Error(`Backup manifest ${operation} failed (${code})`);
}

/**
 * Generate a SHA-256 manifest for all files in snapshotDataDir, plus the
 * sibling pg dump (which lives outside the data/ tree). Hashing the dump means
 * a truncated/corrupt portos-db.sql is detectable, not silently trusted.
 * @param {string} snapshotDataDir - Directory to hash
 * @param {string} manifestPath - Path to write manifest.json
 * @param {string|null} [pgDumpPath=null] - Sibling SQL dump to also hash
 * @param {object} [options] - Dump inventory expectations
 * @param {boolean} [options.allowMissingDump=false] - Only for skipped/failed dumps
 */
export async function generateManifest(snapshotDataDir, manifestPath, pgDumpPath = null, { allowMissingDump = false } = {}) {
  const entries = await readdir(snapshotDataDir, { recursive: true })
    .catch(err => { throw manifestReadFailure('data readdir', err); });
  const files = {};

  for (const entry of entries) {
    const filePath = join(snapshotDataDir, entry);
    const info = await stat(filePath).catch(async err => {
      // rsync --archive preserves links even when their targets are absent or
      // excluded. Preserve that compatibility, but never skip a missing entry.
      if (err.code === 'ENOENT') {
        const entryInfo = await lstat(filePath)
          .catch(entryErr => { throw manifestReadFailure('data lstat', entryErr); });
        if (entryInfo.isSymbolicLink()) return null;
      }
      throw manifestReadFailure('data stat', err);
    });
    if (!info || !info.isFile()) continue;
    files[entry] = await sha256File(filePath)
      .catch(err => { throw manifestReadFailure('data hash', err); });
  }

  if (pgDumpPath) {
    const dumpInfo = await stat(pgDumpPath).catch(err => {
      if (allowMissingDump && err.code === 'ENOENT') return null;
      throw manifestReadFailure('dump stat', err);
    });
    if (dumpInfo && !dumpInfo.isFile()) {
      throw new Error('Backup manifest dump stat failed (not a regular file)');
    }
    if (dumpInfo?.isFile()) {
      // Parent-relative key: the dump lives one level ABOVE snapshotDataDir
      // (alongside it, not inside it). A manifest-verify must not assume
      // every key resolves under snapshotDataDir — see verifySnapshotManifest.
      files[SNAPSHOT_DUMP_MANIFEST_KEY] = await sha256File(pgDumpPath)
        .catch(err => { throw manifestReadFailure('dump hash', err); });
    }
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    fileCount: Object.keys(files).length,
    files
  };

  await atomicWrite(manifestPath, manifest);
  console.log(`💾 Backup manifest: ${manifest.fileCount} files`);
  return manifest;
}

/**
 * List all snapshots in the backup destination.
 * @param {string} destPath - Path to external drive backup root
 * @returns {Array<{ id, createdAt, fileCount, incomplete, failed }>} sorted newest-first
 */
export async function listSnapshots(destPath) {
  if (!destPath) return [];

  const snapshotsDir = join(destPath, 'snapshots', MACHINE_HOST);
  // withFileTypes so we can skip non-directory entries: the backup target is
  // commonly an iCloud/Finder folder, where macOS drops a `.DS_Store` FILE into
  // every directory. Treating it as a snapshot id and reading
  // `<.DS_Store>/manifest.json` throws ENOTDIR. Also skip dotfile-named dirs so
  // nothing hidden can masquerade as a snapshot (real ids are timestamps).
  const entries = await readdir(snapshotsDir, { withFileTypes: true }).catch(() => []);
  const ids = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name);

  const snapshots = await Promise.all(
    ids.map(async (id) => {
      const snapshotDir = join(snapshotsDir, id);
      const manifestPath = join(snapshotDir, 'manifest.json');
      // logError:false — a snapshot taken before manifests existed legitimately
      // has none; the null is handled below, so it isn't worth a warning per list.
      // Read-only listing metadata; generateManifest rebuilds from snapshot bytes.
      const manifest = await readJSONFile(manifestPath, null, { logError: false });
      // Report a still-being-written snapshot rather than hiding it: the row is
      // real and the user should see the run in flight, but download and restore
      // must not be offered for it. Mirrors assertSnapshotComplete's two signals.
      const { incomplete, failed } = await snapshotState(snapshotDir, id);
      return {
        id,
        createdAt: manifest?.generatedAt ?? null,
        fileCount: manifest?.fileCount ?? 0,
        incomplete,
        failed,
      };
    })
  );

  return snapshots.sort((a, b) => {
    if (!a.createdAt) return 1;
    if (!b.createdAt) return -1;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

const SNAPSHOT_ID_PATTERN = /^[\w\-.:T]+$/;

function resolveSnapshotPath(destPath, snapshotId) {
  if (!snapshotId || !SNAPSHOT_ID_PATTERN.test(snapshotId)) {
    throw new ServerError(`Invalid snapshotId: ${snapshotId}`, {
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  }

  const snapshotsRoot = resolve(join(destPath, 'snapshots', MACHINE_HOST));
  const snapshotDir = resolve(join(snapshotsRoot, snapshotId));
  const rel = relative(snapshotsRoot, snapshotDir);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new ServerError(`Path traversal detected for snapshotId: ${snapshotId}`, {
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  }

  return { snapshotsRoot, snapshotDir };
}

/**
 * Open a gzip tar stream for one complete snapshot.
 * @param {string} destPath - Path to external drive backup root
 * @param {string} snapshotId - Snapshot ID to archive
 * @returns {Promise<import('stream').Readable>}
 */
export async function openSnapshotStream(destPath, snapshotId) {
  const { snapshotsRoot, snapshotDir } = resolveSnapshotPath(destPath, snapshotId);
  const info = await stat(snapshotDir).catch(() => null);
  if (!info?.isDirectory?.()) {
    throw new ServerError(`Snapshot not found: ${snapshotId}`, { status: 404, code: 'NOT_FOUND' });
  }
  await assertSnapshotComplete(snapshotDir, snapshotId);

  // tar's stderr is a pipe (spawn's default) and MUST be drained: left unread
  // it fills its ~64KB buffer on a tree that warns a lot — files changing under
  // the archiver, unreadable modes — and tar then blocks on the write forever,
  // hanging the download with the process still alive. Keep the tail so a
  // non-zero exit can say why rather than just reporting the code.
  const proc = spawn('tar', ['-czf', '-', '-C', snapshotsRoot, snapshotId], { shell: false });
  const archive = new PassThrough();
  let stderrTail = '';
  proc.stderr?.on('data', (chunk) => { stderrTail = (stderrTail + chunk).slice(-500); });

  let finished = false;
  const finish = (error = null) => {
    if (finished) return;
    finished = true;
    if (error) archive.destroy(error);
    else archive.end();
  };

  // Keep the response open until tar's close event. stdout can end before tar
  // reports a read/permission failure; delaying EOF lets the route turn that
  // non-zero exit into a failed download instead of a false 200 success.
  proc.stdout.on('error', finish);
  proc.stdout.pipe(archive, { end: false });
  proc.on('error', finish);
  proc.on('close', (code, signal) => {
    if (code === 0) {
      finish();
      return;
    }
    const detail = code == null ? `signal ${signal || 'unknown'}` : `code ${code}`;
    finish(new Error(`tar exited with ${detail}${stderrTail ? `: ${stderrTail.trim()}` : ''}`));
  });
  archive.abort = () => {
    // Escalate like every other spawn-based job: the backup destination is an
    // external/network mount, so a tar wedged on stalled I/O is the exact case
    // SIGTERM alone does not clear.
    if (proc.exitCode === null && proc.signalCode === null) {
      // stillRunning is `true` on purpose: the helper already skips SIGKILL once
      // the child has exited, and this proc is captured in the closure so there is
      // no handle that could be swapped out from under us. Gating on the stream's
      // own state instead would read as false by the time the timer fires (finish()
      // runs on the next line) and silently disable the escalation.
      killWithEscalation(proc, { label: `snapshot download ${snapshotId}`, stillRunning: () => true });
    }
    finish(new Error(`Snapshot download aborted: ${snapshotId}`));
  };
  return archive;
}

// A manifest key names a path RELATIVE to the snapshot's data/ dir. The
// manifest is data read off the backup medium — which may be a shared or
// damaged volume — so every key is validated before it is joined onto a real
// path: a corrupt or hostile manifest must not point the verifier outside the
// snapshot tree. `..` is detected by splitting on BOTH separators so a
// Windows-written manifest can't smuggle traversal through `..\`.
const SHA256_HEX = /^[0-9a-f]{64}$/;
function isSafeManifestKey(key) {
  if (typeof key !== 'string' || !key || key.includes('\0')) return false;
  if (isAbsolute(key) || key.startsWith('/') || key.startsWith('\\')) return false;
  if (/^[a-zA-Z]:($|[\\/])/.test(key)) return false; // drive-letter absolute
  if (key.split(/[\\/]/).includes('..')) return false;
  return true;
}

// Sentinel default for readJSONFileStrict so a confirmed-absent manifest (the
// legacy pre-manifest snapshot case) is distinguished from a manifest file that
// exists but parses to a falsy/non-object value — the former is an explicit
// unverified compatibility path, the latter must fail closed.
const MANIFEST_ABSENT = {};

const manifestVerificationError = (snapshotId, detail) => new ServerError(
  `Snapshot ${snapshotId} failed manifest verification: ${detail}. Choose another snapshot or repair the backup media before retrying.`,
  { status: 409, code: 'SNAPSHOT_MANIFEST_MISMATCH' },
);

/**
 * Verify a snapshot's manifest.json against its data/ bytes before restore.
 * Runs ahead of EVERY restore — preview and execution alike — so damaged or
 * mismatched snapshot bytes can never reach rsync and overwrite live data.
 *
 * Returns a verification descriptor the route/UI can surface:
 *   { status: 'verified', checkedFiles: n }          manifest present, all selected entries hashed clean
 *   { status: 'unverified', reason: 'no_manifest' }  legacy snapshot written before manifests existed
 * Throws ServerError (409) when the manifest exists but is unreadable,
 * malformed, or a selected file is missing/unreadable/hash-mismatched.
 *
 * @param {string} snapshotDir - Resolved snapshot directory
 * @param {string} snapshotId - For messages only
 * @param {string|null} subdirFilter - Already-validated selective restore scope
 */
async function verifySnapshotManifest(snapshotDir, snapshotId, subdirFilter) {
  const manifestPath = join(snapshotDir, 'manifest.json');
  const manifestRead = await readJSONFileStrict(manifestPath, MANIFEST_ABSENT);
  if (!manifestRead.ok) {
    throw new ServerError(`Snapshot manifest is unreadable: ${snapshotId}`, {
      status: 409,
      code: 'SNAPSHOT_MANIFEST_UNREADABLE',
    });
  }
  const manifest = manifestRead.value;
  if (manifest === MANIFEST_ABSENT) {
    return { status: 'unverified', reason: 'no_manifest' };
  }

  // Structural validation is strict on the security-relevant part: `files`
  // must be a map of safe relative keys to sha256 hex digests. Anything else —
  // a non-object manifest, an array, a garbage hash, an absolute/traversing
  // key — means the manifest cannot be trusted and the restore fails closed.
  const files = manifest?.files;
  const malformed = !manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || !files || typeof files !== 'object' || Array.isArray(files)
    || Object.entries(files).some(([key, hash]) =>
      key !== SNAPSHOT_DUMP_MANIFEST_KEY && (!isSafeManifestKey(key) || !SHA256_HEX.test(hash)));
  if (malformed) {
    throw new ServerError(`Snapshot manifest is malformed: ${snapshotId}`, {
      status: 409,
      code: 'SNAPSHOT_MANIFEST_UNREADABLE',
    });
  }

  // The dump key is verified by restorePostgres — it is not a data-file path
  // and must never be resolved under data/. Selection mirrors what the rsync
  // filter chain would restore: all recorded data files for a full restore, or
  // only entries at/under the literal subdirFilter for a selective one. Keys
  // are normalized to `/` (and `.`/duplicate separators collapsed) so a
  // manifest written on Windows still matches an `/`-separated filter.
  const filterNorm = subdirFilter
    ? posix.normalize(subdirFilter.replace(/\\/g, '/').replace(/\/+$/, ''))
    : null;
  const selectAll = !filterNorm || filterNorm === '.';
  const selected = Object.entries(files).filter(([key]) => {
    if (key === SNAPSHOT_DUMP_MANIFEST_KEY) return false;
    if (selectAll) return true;
    const normalized = posix.normalize(key.replace(/\\/g, '/'));
    return normalized === filterNorm || normalized.startsWith(`${filterNorm}/`);
  });

  const srcDir = join(snapshotDir, 'data');
  for (const [key, expectedHash] of selected) {
    const filePath = resolve(srcDir, key);
    const rel = relative(srcDir, filePath);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      // Defense-in-depth: isSafeManifestKey already rejected traversal, so
      // reaching here means the two checks drifted — fail closed either way.
      throw new ServerError(`Snapshot manifest is malformed: ${snapshotId}`, {
        status: 409,
        code: 'SNAPSHOT_MANIFEST_UNREADABLE',
      });
    }
    const info = await stat(filePath).catch((err) => {
      throw manifestVerificationError(
        snapshotId,
        err?.code === 'ENOENT' || err?.code === 'ENOTDIR'
          ? `recorded file is missing: ${key}`
          : `recorded file is unreadable: ${key}`,
      );
    });
    // stat follows links, mirroring generateManifest (a symlink to a regular
    // file is hashed under the link's path — that documented compatibility is
    // retained). Anything that is no longer a regular file cannot match.
    if (!info.isFile()) {
      throw manifestVerificationError(snapshotId, `recorded file is not a regular file: ${key}`);
    }
    const actualHash = await sha256File(filePath).catch(() => {
      throw manifestVerificationError(snapshotId, `recorded file is unreadable: ${key}`);
    });
    if (actualHash !== expectedHash) {
      throw manifestVerificationError(snapshotId, `hash mismatch for file: ${key}`);
    }
  }
  return { status: 'verified', checkedFiles: selected.length };
}

/**
 * Restore a snapshot back to PATHS.data using rsync.
 * @param {string} destPath - Path to external drive backup root
 * @param {string} snapshotId - Snapshot ID to restore
 * @param {object} options
 * @param {boolean} [options.dryRun=true] - If true, do not write any files
 * @param {string|null} [options.subdirFilter=null] - Limit restore to a subdirectory
 */
export async function restoreSnapshot(destPath, snapshotId, { dryRun = true, subdirFilter = null } = {}) {
  const { snapshotsRoot, snapshotDir } = resolveSnapshotPath(destPath, snapshotId);
  await assertSnapshotRestorable(snapshotDir, snapshotId);
  const srcDir = join(snapshotDir, 'data');

  // Defense-in-depth for non-route callers (the route already validates via
  // subdirFilterSchema). subdirFilter is interpolated into an rsync include arg,
  // so a `*` would override the filter chain (restoring everything) and `..`
  // would traverse out of the snapshot subdir. Reuse the same predicate the
  // schema does so the two can't drift — see issue #1822.
  if (subdirFilter != null && !isSafeSubdirFilter(subdirFilter)) {
    throw new Error(`Invalid subdirFilter: ${subdirFilter}`);
  }

  // Integrity preflight (#7167): when the snapshot carries a manifest, every
  // recorded file this restore would write must still match its SHA-256 before
  // rsync runs — otherwise a damaged backup overwrites healthy live data with
  // corrupt bytes. This re-verifies on the actual restore rather than trusting
  // a prior preview: bytes changed between the two calls are caught here.
  const verification = await verifySnapshotManifest(snapshotDir, snapshotId, subdirFilter);
  if (verification.status === 'unverified') {
    console.warn(`⚠️ restore: snapshot ${snapshotId} has no integrity manifest — restoring unverified (legacy snapshot)`);
  }

  const flags = ['--itemize-changes'];
  if (dryRun) flags.push('--dry-run');
  if (subdirFilter) {
    flags.push(`--include=${subdirFilter}/***`);
    flags.push('--include=*/');
    flags.push('--exclude=*');
  }

  let changedFiles;
  try {
    changedFiles = await runRsync(srcDir, PATHS.data, flags);
  } catch (err) {
    if (!dryRun) {
      const partialRestoreError = new Error(
        `${err.message}. Some files may already have been overwritten because file restore is not transactional.`,
        { cause: err },
      );
      if (err?.code) partialRestoreError.code = err.code;
      throw partialRestoreError;
    }
    throw err;
  }
  if (!dryRun) {
    // A live restore writes outside normal service mutation paths. Re-sync the
    // caches whose backing files may have changed instead of serving the
    // pre-restore projection until each record is next mutated or the process
    // restarts. Selective restores may target either `brain` itself or a nested
    // path such as `brain/inbox`.
    if (!subdirFilter || subdirFilter === 'brain' || subdirFilter.startsWith('brain/')) {
      invalidateBrainCaches();
    }
    await reloadSettings();
  }
  return { dryRun, snapshotId, subdirFilter, changedFiles, verification };
}

/**
 * Restore the PostgreSQL dump from a snapshot. Dry-run by default — mirrors
 * restoreSnapshot's safety default. A real restore pipes the snapshot's
 * portos-db.sql into psql; the dump was written with --no-owner --no-acl so
 * it replays cleanly.
 *   { status: 'ok', dryRun, sizeBytes, tableCount }   (dry-run or applied)
 *   { status: 'skipped', reason: 'no_dump' }           (no sql file in snapshot)
 *   { status: 'skipped', reason: 'not_configured' }    (real restore, PG unreachable)
 *   { status: 'failed', reason: 'manifest_unreadable'|'manifest_mismatch'|'restore_error'|'timeout', error? }
 * @param {string} destPath - Backup destination root
 * @param {string} snapshotId
 * @param {{dryRun?: boolean}} [options]
 */
export async function restorePostgres(destPath, snapshotId, { dryRun = true } = {}) {
  const { snapshotDir } = resolveSnapshotPath(destPath, snapshotId);
  await assertSnapshotRestorable(snapshotDir, snapshotId);
  const sqlPath = join(snapshotDir, 'portos-db.sql');

  const info = await stat(sqlPath).catch(() => null);
  // An empty/0-byte dump is as good as absent — restoring it is a silent no-op.
  // Mirror dumpPostgres's empty-dump guard so a truncated snapshot can't read
  // as a successful "0 tables" restore.
  if (!info || !info.isFile?.() || info.size === 0) {
    return { status: 'skipped', reason: 'no_dump' };
  }
  // Verify the dump against the manifest's stored SHA-256 before trusting it.
  // The dump is hashed in generateManifest under the parent-relative key
  // '../portos-db.sql' (it lives ALONGSIDE the snapshot data/ dir, not inside
  // it). Backward-compat: snapshots taken before manifests existed — or missing
  // the dump key — have nothing to verify against, so we SKIP verification and
  // proceed rather than hard-failing. An existing manifest refuses the restore
  // when it cannot be read or when its recorded dump hash does not match.
  const manifestPath = join(snapshotDir, 'manifest.json');
  // Read-only verification metadata. A confirmed ENOENT remains the legacy
  // no-manifest case, while corrupt bytes and every other read failure mean the
  // dump cannot be trusted. This path never writes the manifest back.
  const manifestRead = await readJSONFileStrict(manifestPath, null);
  if (!manifestRead.ok) {
    console.error(`❌ restore: integrity manifest unreadable for snapshot ${snapshotId}`);
    return { status: 'failed', reason: 'manifest_unreadable' };
  }
  const manifest = manifestRead.value;
  const expectedHash = manifest?.files?.[SNAPSHOT_DUMP_MANIFEST_KEY];
  if (expectedHash) {
    const actualHash = await sha256File(sqlPath);
    if (actualHash !== expectedHash) {
      console.error(`❌ restore: manifest hash mismatch for snapshot ${snapshotId} (expected ${expectedHash}, got ${actualHash})`);
      return { status: 'failed', reason: 'manifest_mismatch' };
    }
  }

  const sql = await readFile(sqlPath, 'utf-8').catch(() => '');
  const tableCount = (sql.match(/^CREATE TABLE /gm) || []).length;

  if (dryRun) {
    return { status: 'ok', dryRun: true, sizeBytes: info.size, tableCount };
  }

  // Never half-restore: require a reachable DB before replaying.
  const health = await checkHealth();
  if (!health.connected) {
    return { status: 'skipped', reason: 'not_configured' };
  }

  const pgHost = process.env.PGHOST || 'localhost';
  const pgPort = process.env.PGPORT || '5432';
  const pgDb = process.env.PGDATABASE || 'portos';
  const pgUser = process.env.PGUSER || 'portos';

  return new Promise((resolveP) => {
    // ON_ERROR_STOP=1 aborts on the first failed statement; --single-transaction
    // wraps the whole replay in one transaction so that abort ROLLs BACK every
    // prior statement. Together they make the restore atomic: it either fully
    // applies or leaves the live DB untouched — never a mixed snapshot/current
    // state. (The dump is written with --clean --if-exists, so the DROPs and
    // recreates all commit or roll back as one unit.)
    const proc = spawn('psql', [
      '-v', 'ON_ERROR_STOP=1',
      '--single-transaction',
      '--echo-all',
      '-h', pgHost, '-p', pgPort, '-U', pgUser, '-d', pgDb, '-f', sqlPath
    ], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD || 'portos' } });

    let stderr = '';
    const watchdog = watchBackupProcess(proc, { label: 'PostgreSQL restore' });
    // `--echo-all` echoes input as psql consumes it, including rows within a
    // long COPY. The output is never retained, but it must be drained: unread
    // piped output can backpressure and deadlock a verbose restore. Each chunk
    // is also the progress signal that keeps an active long restore alive.
    proc.stdout.on('data', watchdog.markActivity);
    proc.stderr.on('data', (chunk) => {
      watchdog.markActivity();
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      if (!watchdog.finish()) return;
      const timeoutError = watchdog.getTimeoutError();
      if (timeoutError) {
        resolveP({ status: 'failed', reason: 'timeout', error: timeoutError.message });
        return;
      }
      if (code === 0) {
        console.log(`💾 psql restore complete from snapshot ${snapshotId}: ${tableCount} tables`);
        resolveP({ status: 'ok', dryRun: false, sizeBytes: info.size, tableCount });
      } else {
        console.warn(`⚠️ psql restore failed (code ${code}): ${stderr.trim()}`);
        resolveP({ status: 'failed', reason: 'restore_error', error: stderr.trim() });
      }
    });
    proc.on('error', (err) => {
      if (watchdog.getTimeoutError() || !watchdog.finish()) return;
      console.warn(`⚠️ psql not available: ${err.message}`);
      resolveP({ status: 'failed', reason: 'restore_error', error: err.message });
    });
  });
}

/**
 * Get current backup state from disk.
 */
export async function getState() {
  return readJSONFile(STATE_PATH, DEFAULT_STATE, { strict: true });
}

/**
 * Merge patch into current backup state and persist.
 * @param {object} patch - Fields to merge into state
 */
export async function saveState(patch) {
  return queueStateWrite(async () => {
    await ensureDir(join(PATHS.data, 'backup'));
    const current = await getState();
    const updated = { ...current, ...patch };
    await atomicWrite(STATE_PATH, updated);
    return updated;
  });
}

/**
 * Get the next scheduled backup run time from eventScheduler.
 * @returns {string|null} ISO timestamp of next run, or null
 */
export function getNextRunTime() {
  const event = getEvent('backup-daily');
  return event?.nextRunAt ? new Date(event.nextRunAt).toISOString() : null;
}
