/**
 * Backup Service
 *
 * Rsync-based incremental backup from ./data/ to an external drive.
 * Generates SHA-256 manifests for integrity verification.
 * Integrates with eventScheduler for daily cron scheduling.
 */

import { dashboardEvents } from './dashboardEvents.js';
import { spawn } from '../lib/childProcess.js';
import { killWithEscalation } from '../lib/killWithEscalation.js';
import { access, lstat, mkdir, mkdtemp, readdir, realpath, rm, stat, unlink, writeFile } from 'fs/promises';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { hostname, tmpdir } from 'os';
import { basename, join, resolve, relative, isAbsolute } from 'path';
import { PATHS, ensureDir, readJSONFile, readJSONFileStrict, atomicWrite, sha256File } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { acquireBackupSnapshotCut } from '../lib/backupSnapshotBoundary.js';
import { backupAssetConsistency } from '../lib/backupAssetOwners.js';
import { assertDatabaseAdmission } from '../lib/databaseMaintenanceJournal.js';
import { createLineReader } from '../lib/streamLines.js';
import { getEvent } from './eventScheduler.js';
import { POOL_CONFIG, checkHealth, databaseRestoreRecovery, getServerMajorVersion, query, withDatabaseMaintenance } from '../lib/db.js';
import { withPgToolEnv, resolvePgDumpBinary } from '../lib/pgTools.js';
import { inspectDatabaseDump, prepareDatabaseReplay } from './backupDatabaseDump.js';
import {
  captureSyncFeedPositions, pendingRecoveryResult, repairCommittedRestore, restoreApplicationName, restoreReceiptSql,
  restoreRecoveryRefusal, settleReplayOutcome,
} from './backupRestoreRecovery.js';
import { getBackendName } from './memoryBackend.js';
import { emitErrorEvent, ServerError } from '../lib/errorHandler.js';
import { isSafeSnapshotSource, isSafeSubdirFilter, anchorUserExcludes } from '../lib/sharedSchemas.js';
import { reloadSettings, withLiveSettingsRestore } from './settings.js';
import { invalidateAllCaches as invalidateBrainCaches } from './brainStorage.js';
import { noteSystemActivity } from './systemActivityNotify.js';

// Module-level state
let isRunning = false;
let failedStateProjection = null;

// The in-process lock is the activity signal the updater reads. Note the edge
// in the same assignment so a client cannot keep a stale "backup running"
// verdict after the lock drops, or miss one that just started. There is no
// cancel path: a failed run releases the lock as `failure`.
function setBackupRunning(running, phase) {
  isRunning = running;
  noteSystemActivity('backup', phase);
}

// Backups and restores can legitimately run for hours on large or remote
// volumes, so a short elapsed-time cap would turn healthy work into failure.
// Treat ten minutes with no observable progress as a stall, while retaining a
// generous hard ceiling for a process that stays noisy forever.
const BACKUP_PROCESS_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const BACKUP_PROCESS_WALL_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const BACKUP_PROCESS_PROGRESS_POLL_MS = 30 * 1000;

// `-ii` heartbeats once per file rsync finishes deciding about, so a single
// file whose `--checksum` digest outlasts the idle deadline still emits
// nothing for its whole duration (#7302). The digest reads BOTH copies — the
// snapshot side and the live side — so a restore floors its idle timeout at
// 2x the largest in-scope file over this throughput. Sized near the bottom of
// a healthy network/iCloud destination (~25 MB/s observed), the floor keeps
// the tight default for small trees and relaxes only where a long silence is
// explainable.
const RESTORE_DIGEST_WORST_CASE_BPS = 10 * 1024 * 1024;

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

async function snapshotState(snapshotDir, snapshotId, currentSource = true) {
  const [markedInProgress, failed] = await Promise.all([
    markerExists(snapshotDir, snapshotId),
    failedMarkerExists(snapshotDir),
  ]);
  return {
    failed,
    // Once `.failed` exists the run is finished even if marker cleanup was
    // interrupted. The durable failed state still blocks every restore.
    incomplete: (currentSource && snapshotId === activeSnapshotId) || (markedInProgress && !failed),
  };
}

/** Reject a snapshot that is still being written before any consumer reads it. */
async function assertSnapshotComplete(snapshotDir, snapshotId, currentSource) {
  const { incomplete } = await snapshotState(snapshotDir, snapshotId, currentSource);
  if (incomplete) {
    throw new ServerError(`Snapshot is still being written: ${snapshotId}`, {
      status: 409,
      code: 'SNAPSHOT_INCOMPLETE',
    });
  }
}

/** Reject snapshots whose backup run finished unsuccessfully before restoring. */
async function assertSnapshotRestorable(snapshotDir, snapshotId, currentSource) {
  const { incomplete, failed } = await snapshotState(snapshotDir, snapshotId, currentSource);
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

// Snapshot source lifetime (#10898). Verifying snapshot bytes proves nothing if
// the snapshot can be deleted while a consumer is still reading it, so every
// consumer holds a READ lease from before its preflight until its last read
// settles (file restore/preview through rsync's close and reconciliation,
// database restore through dump admission, a download through tar's close),
// and every deletion — explicit or retention — needs the snapshot EXCLUSIVELY.
// Readers share; a deletion refuses while any reader holds it, and a reader
// refuses while a deletion holds it. Keyed by the canonical path (realpath
// folds the omitted-vs-explicit current source, destination symlinks and, on a
// case-insensitive volume, letter case into one owner); a path that does not
// exist keeps its resolved form, which every alias of it shares too. This
// coordinates this server's own callers — it is not a cross-machine lock.
const snapshotLeases = new Map();

const SNAPSHOT_LEASE_REFUSALS = Object.freeze({
  SNAPSHOT_DELETING: (snapshotId) => `Snapshot is being deleted: ${snapshotId}`,
  SNAPSHOT_IN_USE: (snapshotId) => `Snapshot is in use by a restore or download: ${snapshotId}. Retry when it finishes.`,
});

/**
 * Claim `snapshotDir` for `mode` ('read' | 'delete'). Resolves `{ release }`,
 * or `{ refusal }` naming the conflicting owner; never throws. The check and
 * the claim run in one synchronous step after the key is resolved, so two
 * claimants cannot both win.
 */
async function claimSnapshotLease(snapshotDir, mode) {
  // snapshotDir comes from resolveSnapshotPath, so it is already resolved.
  const key = await realpath(snapshotDir).catch(() => snapshotDir);
  const lease = snapshotLeases.get(key) ?? { readers: 0, deleting: false };
  if (lease.deleting) return { refusal: 'SNAPSHOT_DELETING' };
  if (mode === 'delete' && lease.readers > 0) return { refusal: 'SNAPSHOT_IN_USE' };
  if (mode === 'delete') lease.deleting = true;
  else lease.readers += 1;
  snapshotLeases.set(key, lease);
  let held = true;
  return {
    release: () => {
      if (!held) return;
      held = false;
      if (mode === 'delete') lease.deleting = false;
      else lease.readers -= 1;
      if (!lease.deleting && lease.readers === 0) snapshotLeases.delete(key);
    },
  };
}

/** Claim a snapshot lease or throw the structured 409 naming the conflict. */
async function acquireSnapshotLease(snapshotDir, snapshotId, mode) {
  const { release, refusal } = await claimSnapshotLease(snapshotDir, mode);
  if (refusal) {
    throw new ServerError(SNAPSHOT_LEASE_REFUSALS[refusal](snapshotId), {
      status: 409,
      code: refusal,
      context: { snapshotId },
    });
  }
  return release;
}

/** Hold a read lease on `snapshotDir` for exactly as long as `operation` runs. */
async function withSnapshotRead(snapshotDir, snapshotId, operation) {
  const release = await acquireSnapshotLease(snapshotDir, snapshotId, 'read');
  try {
    return await operation();
  } finally {
    release();
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
  { path: '/backup-admission/', reason: 'Machine-local publication ownership and snapshot fences', overridable: false },
  { path: '/image-thumbnails/', reason: 'Regenerable image grid previews', overridable: false },
  { path: '/python/laya-mlx/', reason: 'Rebuildable Laya-MLX experiment runtime and pinned model weights', overridable: false },
  { path: '/browser-profile/', reason: 'Browser CDP profile — cache/cookies, can be several GB', overridable: false },
  { path: '/cos/worktrees/', reason: 'Ephemeral agent git worktrees — recreated on demand', overridable: false },
  { path: '/cos/slashdo-resolved/', reason: 'Resolved slashdo command bodies staged for agent prompts — derived from the bundled submodule, regenerated on demand', overridable: false },
  { path: '/cos/feature-agents/*/worktree/', reason: 'Per-feature-agent git worktrees — recreated on demand', overridable: false },
  // `**` (not `*`) so both engines' checkpoint dirs match: the torch trainer
  // writes training-runs/<id>/checkpoints/, mflux writes
  // training-runs/<id>/mflux/checkpoints/.
  { path: '/training-runs/**/checkpoints/', reason: 'LoRA training checkpoints — large intermediate adapter state, resumable-but-regenerable. Deployed adapters in data/loras/, including promoted checkpoints, ARE backed up along with run samples + configs.', overridable: true },
  { path: '/training-runs/*/cache/', reason: 'Precomputed latent/text-embedding training cache — regenerated from the dataset on the next run', overridable: false },
  { path: '/training-runs/*/data/.mflux_cache/', reason: 'mflux low_ram disk-backed encode cache (written inside the staged training data dir) — regenerable', overridable: false },
  { path: '/repos/', reason: 'Cloned git repositories — large, re-cloneable from origin', overridable: true },
  { path: '/cos/reference-repos/', reason: 'Reference upstream repos used by agents — re-cloneable', overridable: true },
  { path: '/browser-downloads/', reason: 'Browser downloads cache — large, re-downloadable', overridable: true },
  { path: '/composition-proofs/', reason: 'HTML-composition contact-sheet proofs — review stills, re-rendered from the composition source', overridable: true },
  { path: '/code-animation-workspaces/', reason: 'In-flight sandboxed Code Animation worker workspaces — removed when each run ends', overridable: false },
  { path: '/code-animation-exports/', reason: 'Code Animation frame-exact export staging — the stored HTML plus render shim, staged once per export', overridable: true },
  { path: '/music-video-compositions/', reason: 'In-flight music-video typography overlay scratch — removed when its render ends and swept at boot', overridable: false },
  { path: '/music-video-song-renders/', reason: 'In-flight music-video composition renders (a staged copy of the document plus scene media) — removed when the render ends and swept at boot', overridable: false },
  { path: '/launch-videos/*/*/proofs/', reason: 'Launch-video critique-loop contact sheets — re-rendered from the run composition', overridable: true },
  { path: '/cache/', reason: 'Remote-API metadata and licensed reading caches — regenerable on demand, and stale on restore anyway', overridable: false },
  // Anchored with a leading `/`, like every entry here. The manifest describes
  // which model weights are on THIS machine's disks; restoring it onto another
  // would claim gigabytes of models that machine does not have, and offer delete
  // buttons for them. It is fully re-derivable by a rescan from Models → Status.
  // Anchored, like every entry here. The restore recovery journal (#9725) is an
  // admission fence for THIS machine's in-flight database restore; a restored
  // copy would re-fence the database for an operation that no longer exists.
  { path: '/database-restore-recovery.json', reason: 'In-flight database restore recovery journal — a machine-local admission fence for one restore operation, never data to restore', overridable: false },
  { path: '/.database-restore-recovery-*.pending', reason: 'Unpublished database restore recovery journal bytes — scratch from an interrupted journal write', overridable: false },
  { path: '/model-manifest.json', reason: 'Tracked downloaded-model inventory — machine-local and re-derivable by rescanning the model stores; a restored copy would describe another machine\'s disks', overridable: false },
  // Anchored, like every entry here. Readiness evidence is bound to THIS
  // machine's local image id (a restored copy would read as stale anyway) and
  // the rest is in-flight render scratch; setup re-derives all of it.
  { path: '/supercollider/', reason: 'SuperCollider runtime readiness evidence, in-flight render scratch and 24-hour render previews — machine-local, re-derived by npm run setup:supercollider', overridable: false },
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
  { path: '/beeper/attachments/', reason: 'Beeper attachment byte mirror — a lazy cache re-fetchable from Beeper Desktop; the message bodies and attachment metadata live in Postgres and ARE backed up', overridable: true },
  // Anchored with a leading `/`, like every entry here — an unanchored
  // `corpora/` would match at any depth and silently drop unrelated user data.
  //
  // Two of the three `data/jev/` directories are excluded; `heads/` deliberately
  // is NOT, because a trained head is the one artifact there that does not
  // re-derive. The full three-way tier argument lives in docs/BACKUP.md
  // ("jev project heads — excluded bulk, retained artifact"), which is where a
  // tier change belongs.
  { path: '/jev/corpora/', reason: 'jev training corpora — rebuildable from the forge by scripts/jev-corpus.js. Trained heads in data/jev/heads/ are NOT excluded: a head is not regenerable once its corpus is stale.', overridable: true },
  { path: '/jev/embeddings/', reason: 'Cached frozen-encoder outputs for jev head training — keyed by (pair, model revision) and byte-identical on re-encode', overridable: false }
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
const LEGACY_SNAPSHOT_SOURCE = '@legacy';
const SNAPSHOT_ID_PATTERN = /^[\w\-.:T]+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MANIFEST_ABSENT = Symbol('manifest-absent');

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
 */
function watchBackupProcess(proc, { label, progressPath = null, idleTimeoutMs } = {}) {
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
function runRsync(srcDir, destDir, flags = [], { idleTimeoutMs, allowVanishedSources = false } = {}) {
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
 * - User patterns are ANCHORED here (`anchorUserExcludes`), not in storage: a
 *   bare `cache/` is rsync for "every cache/ at any depth", which silently drops
 *   the per-run caches nested under training runs too. Normalizing on read leaves
 *   the stored value exactly as typed, so there is no migration and nothing is
 *   rewritten under the user. A `*`/`**`-led pattern stays as-is — that is the
 *   deliberate way to ask for any-depth matching.
 */
export function computeEffectiveExcludes({ excludePaths, disabledDefaultExcludes } = {}) {
  const overridablePaths = new Set(DEFAULT_EXCLUDES.filter(e => e.overridable).map(e => e.path));
  const disabledList = Array.isArray(disabledDefaultExcludes) ? disabledDefaultExcludes : [];
  const disabledSet = new Set(disabledList.filter(p => overridablePaths.has(p)));
  const activeDefaults = DEFAULT_EXCLUDES.filter(e => !disabledSet.has(e.path)).map(e => e.path);
  const userExcludes = anchorUserExcludes(excludePaths);
  return [...new Set([...activeDefaults, ...userExcludes])];
}

/**
 * Run a full backup snapshot from PATHS.data to destPath.
 * @param {string} destPath - Path to external drive backup root
 * @param {object|null} io - Socket.IO instance for real-time events (optional)
 */
export async function runBackup(destPath, io = null, { excludePaths = [], disabledDefaultExcludes = [], retentionCount = null } = {}) {
  if (isRunning) {
    console.log('💾 Backup already running — skipping');
    return { skipped: true };
  }

  if (!destPath) {
    throw new Error('Backup destination not configured');
  }

  setBackupRunning(true, 'start');
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
    setBackupRunning(false, 'completion');
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
    setBackupRunning(false, 'failure');
    const failureState = { lastRun: new Date().toISOString(), status: 'error', error: err.message, pgBackup: null };
    await saveState(failureState, (cause) => {
      const code = ['EACCES', 'EPERM', 'EIO', 'ENOSPC', 'EROFS', 'ENOENT', 'EMFILE', 'ENFILE'].includes(cause.code) ? cause.code : 'UNKNOWN';
      failedStateProjection = { ...failureState, error: `Backup failed; status persistence failed (${code}). See server logs.` };
      console.error(`❌ Backup status persistence failed: transition=error snapshot=${snapshotId ?? 'none'} code=${code}`);
    });
    dashboardEvents.emit('backup:changed');
    if (io) io.emit('backup:failed', { snapshotId, error: err.message });
    throw err;
  };

  try {
    // Refuse before reserving a snapshot while database maintenance is fenced;
    // the cut below repeats this check after it drains.
    assertDatabaseAdmission();
    await access(destPath).catch((cause) => {
      // Never expose the filesystem message: it can include private paths.
      const code = ['ENOENT', 'EACCES', 'EPERM', 'EIO'].includes(cause.code) ? cause.code : 'UNKNOWN';
      const message = code === 'ENOENT' ? 'Backup destination not found' : 'Backup destination inaccessible';
      const error = new ServerError(`${message} (${code})`, { code: `BACKUP_DESTINATION_${code}` });
      error.cause = cause;
      throw error;
    });
    const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
    const snapshotsRoot = join(destPath, 'snapshots', MACHINE_HOST);
    await ensureDir(snapshotsRoot);
    // Own the durable guard before exposing a directory. Never adopt an
    // existing tree, even when its timestamp matches this run's clock.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidateId = attempt === 0 ? timestamp : `${timestamp}-${randomUUID()}`;
      const candidateDir = join(snapshotsRoot, candidateId);
      const candidateMarker = parentMarkerPath(candidateDir, candidateId);
      const exists = await lstat(candidateDir).then(() => true, err => {
        if (err.code === 'ENOENT') return false;
        throw err;
      });
      if (exists) continue;
      const reserved = await writeFile(candidateMarker, '', { flag: 'wx' }).then(() => true, err => {
        if (err.code === 'EEXIST') return false;
        throw err;
      });
      if (!reserved) continue;
      const created = await mkdir(candidateDir).then(() => true, async err => {
        // Only our exclusive reservation can be released here. The directory
        // may belong to a competing writer and must remain untouched.
        await unlink(candidateMarker);
        if (err.code === 'EEXIST') return false;
        throw err;
      });
      if (!created) continue;
      snapshotId = candidateId;
      snapshotDir = candidateDir;
      parentMarker = candidateMarker;
      break;
    }
    if (!snapshotDir) throw new Error('Unable to reserve a fresh backup snapshot');
    const dataDestDir = join(snapshotDir, 'data');

    console.log(`💾 Backup starting: snapshot ${snapshotId} (excluding ${effectiveExcludes.length} paths)`);
    if (io) io.emit('backup:started', { snapshotId });
    await ensureDir(dataDestDir);
    activeSnapshotId = snapshotId;
    await writeFile(markerPath(snapshotDir), '');
    dashboardEvents.emit('backup:changed');

    // Freeze admitted file-plus-row publications across both stores. A writer
    // that started first drains completely; new writers wait until the dump
    // and manifest are published. Rendering/provider work is outside admission.
    const releaseSnapshotCut = await acquireBackupSnapshotCut();
    // The snapshot records how far that guarantee reaches: `global` only once
    // no durable asset owner remains outside admission.
    const assetConsistency = backupAssetConsistency();
    let pgResult;
    try {
      const excludeFlags = effectiveExcludes.flatMap(p => ['--exclude', p]);
      changedFiles = await runRsync(PATHS.data, dataDestDir, excludeFlags, { allowVanishedSources: true });
      console.log(`💾 Backup rsync complete: ${changedFiles.length} files changed (exit 0)`);

      // A configured-but-failed dump degrades the backup and alerts the user.
      const pgDumpPath = join(snapshotDir, 'portos-db.sql');
      pgResult = await dumpPostgres(pgDumpPath);
      manifest = await generateManifest(dataDestDir, join(snapshotDir, 'manifest.json'), pgDumpPath, {
        allowMissingDump: pgResult.status === 'skipped' || pgResult.status === 'failed',
        assetConsistency,
      });
    } finally {
      releaseSnapshotCut();
    }

    const status = backupStatusForPg(pgResult);
    const lastRun = new Date().toISOString();
    await saveState({
      lastRun,
      lastSnapshotId: snapshotId,
      status,
      filesChanged: changedFiles.length,
      pgBackup: pgResult,
      assetConsistency,
      error: pgResult.status === 'failed' ? `DB dump ${pgResult.reason}` : null
    });

    if (io) io.emit('backup:completed', { snapshotId, filesChanged: changedFiles.length, status, pgBackup: pgResult });

    // Loud-on-failure: surface a degraded DB dump as a warning toast, even on
    // unattended scheduled runs (which pass io=null) via the module-level io.
    if (pgResult.status === 'failed') {
      // Keep socket/auth initialization out of backup metadata reads and tests.
      const errIo = io || (await import('./socket.js')).getIo();
      if (errIo) {
        emitErrorEvent(errIo, new ServerError(
          `Backup DB dump failed: ${pgResult.reason}`,
          { status: 500, code: 'BACKUP_DB_DUMP_FAILED', severity: 'warning' }
        ));
      }
    }

    const result = await complete({ snapshotId, filesChanged: changedFiles.length, status, lastRun, manifest, pgBackup: pgResult, assetConsistency });

    // Prune only after `complete()` has cleared this snapshot's own
    // `.in-progress` marker and released `activeSnapshotId` — pruning any
    // earlier would make the run's OWN fresh snapshot read as incomplete
    // (via `snapshotState`) and drop out of the retention count entirely,
    // silently keeping one snapshot MORE than configured. A run that throws
    // before this point takes the `fail()` path below and never reaches
    // here, so a failed or in-progress snapshot is never a prune candidate.
    // Retention failures must not fail an otherwise-successful backup.
    let pruned = { pruned: 0 };
    if (pgResult.status === 'failed') {
      console.warn(`⚠️ Backup retention skipped: DB dump ${pgResult.reason} — keeping older snapshots`);
    } else {
      pruned = await pruneOldSnapshots(destPath, retentionCount).catch(err => {
        console.error(`❌ Backup retention prune failed: ${err.message}`);
        return { pruned: 0 };
      });
    }

    dashboardEvents.emit('backup:changed');
    return { ...result, prunedSnapshots: pruned.pruned };
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
 *   { status: 'failed', reason: 'pg_unreachable'|'pg_dump_missing'|'version_mismatch'|'dump_error'|'empty_dump'|'inspect_error'|'timeout', error }
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

  const { host: pgHost, port, database: pgDb, user: pgUser } = POOL_CONFIG;
  const pgPort = String(port);

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

  return withPgToolEnv(POOL_CONFIG, pgEnv => new Promise((resolvePromise) => {
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
      '--no-comments',
      '--clean',
      '--if-exists',
      // Machine-local replay receipts (#9725) describe this install's past
      // restores, not application data; the table definition is still dumped.
      '--exclude-table-data=restore_receipts',
      // The asynchronous media mirror can lag its authoritative files. Rebuild
      // it after restore rather than snapshotting stale file references.
      '--exclude-table-data=media_assets',
      '-f', outputPath
    ], {
      shell: false,
      env: pgEnv
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
      // Stream the dump for its table count — reading it whole would scale
      // server heap with database size. Own the rejection here: this is an
      // event callback, so a throw would leave the outer Promise unsettled.
      const inspected = await inspectDatabaseDump(outputPath).catch((err) => {
        console.warn(`⚠️ pg_dump inspection failed: ${err.code || err.message}`);
        return null;
      });
      if (!inspected) {
        resolvePromise({ status: 'failed', reason: 'inspect_error', error: 'dump could not be read for verification' });
        return;
      }
      const tableCount = inspected.tableCount;
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
  }));
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
 * @param {object} [options.assetConsistency] - The file-and-row consistency this snapshot claims
 */
export async function generateManifest(snapshotDataDir, manifestPath, pgDumpPath = null, { allowMissingDump = false, assetConsistency } = {}) {
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
      // (alongside it, not inside it). A future manifest-verify must not assume
      // every key resolves under snapshotDataDir.
      files['../portos-db.sql'] = await sha256File(pgDumpPath)
        .catch(err => { throw manifestReadFailure('dump hash', err); });
    }
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    fileCount: Object.keys(files).length,
    files,
    ...(assetConsistency ? { assetConsistency } : {}),
  };

  await atomicWrite(manifestPath, manifest);
  console.log(`💾 Backup manifest: ${manifest.fileCount} files`);
  return manifest;
}

// Keep filesystem diagnostics bounded: native errors include private paths.
function inventoryReadError(cause, operation) {
  const code = ['ENOENT', 'EACCES', 'EPERM', 'EIO', 'ENOTDIR', 'EMFILE', 'ENFILE', 'ESTALE']
    .includes(cause?.code) ? cause.code : 'UNKNOWN';
  return new ServerError(`Backup inventory unavailable: ${operation} (${code})`, {
    code: 'BACKUP_INVENTORY_UNAVAILABLE',
    context: { operation, filesystemCode: code },
  });
}

/**
 * List all snapshots in the backup destination.
 * @param {string} destPath - Path to external drive backup root
 * @returns {Array<{ id, source, selectionKey, createdAt, fileCount, incomplete, failed }>} sorted newest-first
 */
export async function listSnapshots(destPath) {
  if (!destPath) return [];

  const snapshotsRoot = join(destPath, 'snapshots');
  // withFileTypes so we can skip non-directory entries: the backup target is
  // commonly an iCloud/Finder folder, where macOS drops a `.DS_Store` FILE into
  // every directory. Treating it as a snapshot id and reading
  // `<.DS_Store>/manifest.json` throws ENOTDIR. Also skip dotfile-named dirs so
  // nothing hidden can masquerade as a snapshot (real ids are timestamps).
  const rootEntries = await readdir(snapshotsRoot, { withFileTypes: true }).catch(async cause => {
    if (cause?.code !== 'ENOENT') throw inventoryReadError(cause, 'read-snapshots-root');
    // Absence is empty only when the configured destination itself is readable.
    await readdir(destPath).catch(error => { throw inventoryReadError(error, 'read-destination'); });
    return [];
  });
  const directories = rootEntries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'));
  const descriptors = (await Promise.all(directories.map(async (entry) => {
    const rootEntryPath = join(snapshotsRoot, entry.name);
    const contents = await readdir(rootEntryPath, { withFileTypes: true }).catch(cause => {
      if (cause?.code === 'ENOENT') return [];
      throw inventoryReadError(cause, 'read-namespace');
    });
    const isLegacySnapshot = SNAPSHOT_ID_PATTERN.test(entry.name) && contents.some(child =>
      (child.name === 'data' && child.isDirectory())
      || child.name === 'manifest.json'
      || child.name === 'portos-db.sql'
      || child.name === SNAPSHOT_IN_PROGRESS_MARKER
      || child.name === SNAPSHOT_FAILED_MARKER);

    if (isLegacySnapshot) return [{ id: entry.name, source: LEGACY_SNAPSHOT_SOURCE }];
    if (!isSafeSnapshotSource(entry.name) || entry.name === LEGACY_SNAPSHOT_SOURCE) return [];

    return contents
      .filter(child => child.isDirectory() && !child.name.startsWith('.') && SNAPSHOT_ID_PATTERN.test(child.name))
      .map(child => ({ id: child.name, source: entry.name }));
  }))).flat();

  const snapshots = await Promise.all(
    descriptors.map(async ({ id, source }) => {
      const { snapshotDir, currentSource } = resolveSnapshotPath(destPath, id, source);
      const manifestPath = join(snapshotDir, 'manifest.json');
      // logError:false — a snapshot taken before manifests existed legitimately
      // has none; the null is handled below, so it isn't worth a warning per list.
      // Read-only listing metadata; generateManifest rebuilds from snapshot bytes.
      const manifest = await readJSONFile(manifestPath, null, { logError: false });
      // Report a still-being-written snapshot rather than hiding it: the row is
      // real and the user should see the run in flight, but download and restore
      // must not be offered for it. Mirrors assertSnapshotComplete's two signals.
      const { incomplete, failed } = await snapshotState(snapshotDir, id, currentSource);
      return {
        id,
        source,
        sourceLabel: source === LEGACY_SNAPSHOT_SOURCE
          ? 'Legacy (pre-namespace)'
          : source === MACHINE_HOST ? `${source} (current machine)` : source,
        selectionKey: `${source}/${id}`,
        currentMachine: source === MACHINE_HOST,
        createdAt: manifest?.generatedAt ?? null,
        fileCount: manifest?.fileCount ?? 0,
        incomplete,
        failed,
      };
    })
  );

  return snapshots.sort((a, b) => {
    if (a.createdAt && b.createdAt) return b.createdAt.localeCompare(a.createdAt)
      || a.selectionKey.localeCompare(b.selectionKey);
    if (a.createdAt) return -1;
    if (b.createdAt) return 1;
    return b.id.localeCompare(a.id) || a.source.localeCompare(b.source);
  });
}

/**
 * Delete the oldest COMPLETED snapshots in the CURRENT machine's source
 * namespace beyond `retentionCount`. Called only from `runBackup()` after a
 * run reaches a completed snapshot (rsync + a pg_dump attempt, even a
 * degraded one) — a run that fails earlier never reaches this call, so an
 * in-progress or `.failed` snapshot is never a candidate; both are re-checked
 * here anyway via `snapshotState` in case an unrelated run left one behind.
 * Only ever walks `snapshots/<MACHINE_HOST>/` — never another machine's
 * namespace and never the legacy pre-namespace root, both of which this
 * install has no authority to prune.
 * `retentionCount` of `null`/`undefined` means unlimited: no-op.
 * @param {string} destPath
 * @param {number|null} retentionCount
 * @returns {Promise<{ pruned: number }>}
 */
async function pruneOldSnapshots(destPath, retentionCount) {
  if (retentionCount === null || retentionCount === undefined) return { pruned: 0 };

  const sourceRoot = join(destPath, 'snapshots', MACHINE_HOST);
  const entries = await readdir(sourceRoot, { withFileTypes: true }).catch(() => []);
  const candidateIds = entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && SNAPSHOT_ID_PATTERN.test(entry.name))
    .map(entry => entry.name);

  const descriptors = (await Promise.all(candidateIds.map(async (id) => {
    const snapshotDir = join(sourceRoot, id);
    const { incomplete, failed } = await snapshotState(snapshotDir, id, true);
    if (incomplete || failed) return null;
    // Read-only listing metadata; matches listSnapshots' own read.
    const manifest = await readJSONFile(join(snapshotDir, 'manifest.json'), null, { logError: false });
    return { id, snapshotDir, createdAt: manifest?.generatedAt ?? null };
  }))).filter(Boolean);

  // Newest-first, same tiebreak as listSnapshots: dated entries by date, then
  // undated (pre-manifest legacy-in-namespace) entries by id.
  descriptors.sort((a, b) => {
    if (a.createdAt && b.createdAt) return b.createdAt.localeCompare(a.createdAt);
    if (a.createdAt) return -1;
    if (b.createdAt) return 1;
    return b.id.localeCompare(a.id);
  });

  const toDelete = descriptors.slice(retentionCount);
  let pruned = 0;
  for (const { snapshotDir, id } of toDelete) {
    // A snapshot a restore or download is reading stays; a later run prunes it
    // once the reader finishes (#10898).
    const { release, refusal } = await claimSnapshotLease(snapshotDir, 'delete');
    if (refusal) {
      console.warn(`⚠️ Backup retention: skipped snapshot ${id} (${refusal})`);
      continue;
    }
    await rm(snapshotDir, { recursive: true, force: true }).then(
      () => { pruned += 1; },
      err => console.error(`❌ Backup retention: failed to remove snapshot ${id}: ${err.message}`),
    );
    release();
  }
  if (pruned) {
    console.log(`💾 Backup retention: pruned ${pruned} snapshot(s), keeping ${retentionCount}`);
  }
  return { pruned };
}

function resolveSnapshotPath(destPath, snapshotId, source) {
  if (!snapshotId || !SNAPSHOT_ID_PATTERN.test(snapshotId)) {
    throw new ServerError(`Invalid snapshotId: ${snapshotId}`, {
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  }

  const resolvedSource = source ?? MACHINE_HOST;
  if (!isSafeSnapshotSource(resolvedSource)) {
    throw new ServerError(`Invalid snapshot source: ${resolvedSource}`, {
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  }

  const snapshotsRoot = resolve(join(destPath, 'snapshots'));
  const sourceRoot = resolvedSource === LEGACY_SNAPSHOT_SOURCE
    ? snapshotsRoot
    : resolve(join(snapshotsRoot, resolvedSource));
  const sourceRel = relative(snapshotsRoot, sourceRoot);
  if (resolvedSource !== LEGACY_SNAPSHOT_SOURCE
      && (!sourceRel || sourceRel.startsWith('..') || isAbsolute(sourceRel))) {
    throw new ServerError(`Path traversal detected for snapshot source: ${resolvedSource}`, {
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  }

  const snapshotDir = resolve(join(sourceRoot, snapshotId));
  const rel = relative(sourceRoot, snapshotDir);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new ServerError(`Path traversal detected for snapshotId: ${snapshotId}`, {
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  }

  return {
    snapshotsRoot: sourceRoot,
    snapshotsBase: snapshotsRoot,
    snapshotDir,
    resolvedSource,
    currentSource: resolvedSource === MACHINE_HOST,
    explicitSource: source !== undefined,
  };
}

async function assertExplicitSnapshotSourceSafe({
  snapshotsBase,
  snapshotsRoot,
  snapshotDir,
  explicitSource,
}, snapshotId) {
  if (!explicitSource) return;

  const [baseInfo, sourceInfo, snapshotInfo] = await Promise.all([
    lstat(snapshotsBase).catch(() => null),
    lstat(snapshotsRoot).catch(() => null),
    lstat(snapshotDir).catch(() => null),
  ]);
  if (baseInfo?.isSymbolicLink?.()
      || sourceInfo?.isSymbolicLink?.()
      || snapshotInfo?.isSymbolicLink?.()) {
    throw new ServerError(`Snapshot source escapes through a symbolic link: ${snapshotId}`, {
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  }
}

/**
 * Permanently delete one snapshot, identified by its (source, id) pair.
 * Immediate — there is no undo — so this is reserved for an explicit operator
 * action, never automatic retention (see `pruneOldSnapshots`, which shares the
 * traversal/symlink guards through `resolveSnapshotPath` but is driven by
 * `runBackup()` instead). Refuses a snapshot that is still being written
 * (`.in-progress`), matching the guard that blocks restore and download,
 * because the partial directory may still be owned by an in-flight
 * `runBackup()`. A `.failed` snapshot IS deletable — unlike restore, deletion
 * has no reason to require a successful backup. A snapshot a restore or
 * download is still reading is refused with `SNAPSHOT_IN_USE`.
 * @param {string} destPath - Path to external drive backup root
 * @param {string} snapshotId - Snapshot ID to delete
 * @param {{ source?: string }} [options]
 * @returns {Promise<{ deleted: true, snapshotId: string, source: string }>}
 */
export async function deleteSnapshot(destPath, snapshotId, { source } = {}) {
  const resolved = resolveSnapshotPath(destPath, snapshotId, source);
  const { snapshotDir, currentSource, resolvedSource } = resolved;
  await assertExplicitSnapshotSourceSafe(resolved, snapshotId);
  // Own the snapshot BEFORE the final existence and in-progress checks: an
  // active reader refuses this deletion (SNAPSHOT_IN_USE), and once admitted no
  // new reader can start until the directory is gone (#10898).
  const release = await acquireSnapshotLease(snapshotDir, snapshotId, 'delete');
  try {
    const info = await stat(snapshotDir).catch(() => null);
    if (!info?.isDirectory?.()) {
      throw new ServerError(`Snapshot not found: ${snapshotId}`, { status: 404, code: 'NOT_FOUND' });
    }
    const { incomplete } = await snapshotState(snapshotDir, snapshotId, currentSource);
    if (incomplete) {
      throw new ServerError(`Snapshot is still being written: ${snapshotId}`, {
        status: 409,
        code: 'SNAPSHOT_INCOMPLETE',
      });
    }
    await rm(snapshotDir, { recursive: true, force: true });
  } finally {
    release();
  }
  dashboardEvents.emit('backup:changed');
  console.log(`💾 Backup snapshot deleted: ${resolvedSource}/${snapshotId}`);
  return { deleted: true, snapshotId, source: resolvedSource };
}

/**
 * Open a gzip tar stream for one complete snapshot.
 * @param {string} destPath - Path to external drive backup root
 * @param {string} snapshotId - Snapshot ID to archive
 * @returns {Promise<import('stream').Readable>}
 */
export async function openSnapshotStream(destPath, snapshotId, { source } = {}) {
  const resolved = resolveSnapshotPath(destPath, snapshotId, source);
  const { snapshotsRoot, snapshotDir, currentSource } = resolved;
  await assertExplicitSnapshotSourceSafe(resolved, snapshotId);
  // The read lease outlives this call: tar reads the snapshot until its child
  // closes, however the download ends (#10898).
  const releaseRead = await acquireSnapshotLease(snapshotDir, snapshotId, 'read');
  let proc;
  try {
    const info = await stat(snapshotDir).catch(() => null);
    if (!info?.isDirectory?.()) {
      throw new ServerError(`Snapshot not found: ${snapshotId}`, { status: 404, code: 'NOT_FOUND' });
    }
    await assertSnapshotComplete(snapshotDir, snapshotId, currentSource);

    // tar's stderr is a pipe (spawn's default) and MUST be drained: left unread
    // it fills its ~64KB buffer on a tree that warns a lot — files changing under
    // the archiver, unreadable modes — and tar then blocks on the write forever,
    // hanging the download with the process still alive. Keep the tail so a
    // non-zero exit can say why rather than just reporting the code.
    proc = spawn('tar', ['-czf', '-', '-C', snapshotsRoot, snapshotId], { shell: false });
  } catch (err) {
    releaseRead();
    throw err;
  }
  proc.on('close', releaseRead);
  // A child that never spawned has no pid and nothing reading the snapshot.
  // Any other error (a failed kill) leaves the child alive until `close`.
  proc.on('error', () => { if (proc.pid === undefined) releaseRead(); });
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

async function reconcileLiveFileRestore(subdirFilter) {
  const refreshes = [
    ...(!subdirFilter || subdirFilter === 'brain' || subdirFilter.startsWith('brain/')
      ? [{ label: 'Brain cache invalidation', run: invalidateBrainCaches }]
      : []),
    { label: 'settings reload', run: reloadSettings },
    ...((!subdirFilter || ['images', 'videos', 'video-thumbnails', 'video-history.json']
      .some(path => subdirFilter === path || subdirFilter.startsWith(`${path}/`)))
      && getBackendName() !== 'file'
      ? [{ label: 'media index rebuild', run: async () => {
        const { reconcileMediaAssets } = await import('./mediaAssetIndex/db.js');
        await reconcileMediaAssets({ rebuild: true });
      } }] : []),
  ];
  const results = await Promise.allSettled(
    refreshes.map(({ run }) => Promise.resolve().then(run)),
  );
  const failures = results.flatMap((result, index) => result.status === 'rejected'
    ? [`${refreshes[index].label}: ${result.reason?.message ?? String(result.reason)}`]
    : []);

  if (failures.length > 0) {
    throw new Error(
      `Live restore cache reconciliation failed (${failures.join('; ')}). Restart PortOS before relying on restored settings, Brain data or media.`,
      { cause: results.find(result => result.status === 'rejected').reason },
    );
  }
}

function manifestDataEntries(manifest, srcDir, subdirFilter) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
      || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)
      || !Number.isInteger(manifest.fileCount) || manifest.fileCount < 0
      || typeof manifest.generatedAt !== 'string' || Number.isNaN(Date.parse(manifest.generatedAt))) {
    return null;
  }

  const entries = Object.entries(manifest.files);
  if (manifest.fileCount !== entries.length) return null;

  const selected = [];
  const dataPaths = new Set();
  for (const [entry, expectedHash] of entries) {
    if (typeof expectedHash !== 'string' || !SHA256_PATTERN.test(expectedHash)) return null;
    if (entry === '../portos-db.sql') continue;

    // Manifests are portable across supported platforms, so normalize both
    // separator forms before validating or comparing a literal filter. Validate
    // before resolving: resolve() would otherwise erase evidence of `..`.
    const normalized = entry.replaceAll('\\', '/');
    const segments = normalized.split('/');
    if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)
        || segments.some(segment => !segment || segment === '.' || segment === '..')) {
      return null;
    }

    const filePath = resolve(srcDir, ...segments);
    const rel = relative(resolve(srcDir), filePath);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
    if (dataPaths.has(normalized)) return null;
    dataPaths.add(normalized);

    if (isRestorePreservedPath(normalized)) continue;
    if (!subdirFilter || normalized === subdirFilter || normalized.startsWith(`${subdirFilter}/`)) {
      selected.push({ filePath, expectedHash });
    }
  }

  return { selected, dataPaths };
}

/**
 * Filesystem metadata the OS writes into a directory on its own, after the
 * manifest was sealed. The backup destination is commonly an iCloud/Finder
 * folder (see `listSnapshots`), so simply BROWSING a snapshot in Finder drops a
 * `.DS_Store` beside the data — which the unmanifested-file check below would
 * then read as tampering and refuse to restore, permanently, on a snapshot that
 * is byte-for-byte intact. These names are skipped by the inventory AND
 * excluded from the restore transfer, so "everything transferred was verified"
 * still holds.
 */
const OS_METADATA_FILES = new Set(['.DS_Store', '.localized', 'Thumbs.db', 'desktop.ini']);
const isOsMetadataFile = (name) => OS_METADATA_FILES.has(name) || name.startsWith('._');

/**
 * rsync filter form of `OS_METADATA_FILES`. Deliberately UNANCHORED, unlike
 * every path exclude in `DEFAULT_EXCLUDES`: these are basenames the OS writes
 * into any directory, so matching at every depth is the point, not a bug.
 */
const OS_METADATA_RSYNC_EXCLUDES = [...OS_METADATA_FILES, '._*'].map(name => `--exclude=${name}`);

/**
 * Data-root files a restore never installs, though a snapshot keeps them as
 * recovery evidence. `database-authority.json` names which database backend a
 * completed cutover retired ON THE MACHINE THAT RAN IT. Installing another
 * machine's record (or an older snapshot's, after a reverse cutover) would fence
 * a healthy local backend as `DATABASE_RETIRED_BACKEND`, including across
 * restarts. The destination keeps whatever authority it already has,
 * byte-for-byte: absent stays absent, damaged stays damaged. Root-anchored
 * relative names, like `DEFAULT_EXCLUDES`; this one list feeds the rsync
 * filter, the manifest selection and the scope inventory so preview,
 * verification and execution cannot disagree.
 */
const RESTORE_PRESERVED_FILES = Object.freeze([
  'database-authority.json', 'peer-execution', 'peer-execution-catalog.json', 'peer-execution-grants.json', 'peer-execution-authority.json', 'peer-execution-recovery.jsonl', 'workflow-maintenance', 'backup-admission',
]);
// Matched case-insensitively (rsync has no such flag, so each letter becomes a
// `[xX]` class): on a case-insensitive volume a `Database-Authority.json` entry
// would otherwise overwrite the destination's lowercase record.
const caseInsensitiveGlob = (name) => name.replace(/[a-z]/gi, ch => `[${ch.toLowerCase()}${ch.toUpperCase()}]`);
const RESTORE_PRESERVED_RSYNC_EXCLUDES = RESTORE_PRESERVED_FILES.map(name => `--exclude=/${caseInsensitiveGlob(name)}`);
const isRestorePreservedPath = (relativePath) => {
  if (typeof relativePath !== 'string') return false;
  const normalized = relativePath.toLowerCase();
  return RESTORE_PRESERVED_FILES.some(path => normalized === path || normalized.startsWith(`${path}/`));
};

// A filter naming a preserved file would otherwise be a silent no-op restore.
// Compared case-insensitively after dropping empty/`.` segments, so
// `./Database-Authority.json/` cannot slip past on a case-insensitive volume.
const restoreScopeIsPreservedFile = (subdirFilter) => {
  const normalized = subdirFilter?.split('/').filter(part => part && part !== '.').join('/').toLowerCase();
  return isRestorePreservedPath(normalized);
};

const snapshotFileIntegrityError = (snapshotId, unmanifestedPath = null) => new ServerError(
  // Name the offending entry: without it the operator is told their only backup
  // failed integrity and given nothing to act on.
  `Snapshot file integrity check failed: ${snapshotId}${unmanifestedPath ? ` (unmanifested file: ${unmanifestedPath})` : ''}`,
  { status: 409, code: 'BACKUP_FILE_INTEGRITY_FAILED' },
);

/**
 * Rebuild the in-scope regular-file inventory the manifest describes.
 * `paths` feed the unmanifested-file check; `largestFileBytes` is free here —
 * the same `stat`s produce it — and sizes the restore's idle-deadline floor
 * (rsync `--checksum` digests only regular files in scope, so the largest one
 * bounds the longest explainable silence between `-ii` heartbeats).
 */
async function snapshotScopeInventory(srcDir, subdirFilter) {
  const scopePath = subdirFilter
    ? resolve(srcDir, ...subdirFilter.split('/'))
    : srcDir;
  const scopeInfo = await lstat(scopePath).catch(err => {
    if (err?.code === 'ENOENT') return null;
    throw err;
  });
  if (!scopeInfo) return { paths: [], largestFileBytes: 0 };

  const candidates = scopeInfo.isDirectory()
    ? (await readdir(scopePath, { recursive: true })).map(entry => join(scopePath, entry))
    : [scopePath];
  const paths = [];
  let largestFileBytes = 0;

  for (const filePath of candidates) {
    const info = await stat(filePath).catch(async err => {
      // Match generateManifest(): dangling links are intentionally outside the
      // manifest, while readable links to regular files are hashed and tracked.
      if (err?.code === 'ENOENT') {
        const entryInfo = await lstat(filePath);
        if (entryInfo.isSymbolicLink()) return null;
      }
      throw err;
    });
    if (!info?.isFile()) continue;
    // OS metadata never reaches rsync (OS_METADATA_RSYNC_EXCLUDES), so it must
    // not inflate the digest floor either.
    if (isOsMetadataFile(basename(filePath))) continue;
    const scopedPath = relative(srcDir, filePath).replaceAll('\\', '/');
    if (isRestorePreservedPath(scopedPath)) continue;
    if (info.size > largestFileBytes) largestFileBytes = info.size;

    const normalized = relative(srcDir, filePath).replaceAll('\\', '/');
    if (!normalized || normalized.startsWith('../') || isAbsolute(normalized)) {
      throw new Error('Snapshot entry escaped the data directory');
    }
    paths.push(normalized);
  }

  return { paths, largestFileBytes };
}

async function verifySnapshotFiles(snapshotDir, srcDir, snapshotId, subdirFilter) {
  // A unique fallback distinguishes a genuinely absent legacy manifest from an
  // existing file whose parsed value is JSON null.
  const manifestRead = await readJSONFileStrict(
    join(snapshotDir, 'manifest.json'),
    MANIFEST_ABSENT,
    { logError: false },
  );
  if (!manifestRead.ok) {
    throw new ServerError(`Snapshot integrity manifest is unreadable: ${snapshotId}`, {
      status: 409,
      code: 'BACKUP_MANIFEST_UNREADABLE',
    });
  }
  if (manifestRead.value === MANIFEST_ABSENT) {
    // No manifest to verify against, but the restore's idle-deadline floor
    // still needs the largest in-scope file. Walk it best-effort: a scope that
    // can't be surveyed keeps the default deadline rather than failing a
    // restore that would previously have run.
    const legacyInventory = await snapshotScopeInventory(srcDir, subdirFilter).catch(() => null);
    return {
      status: 'unverified',
      reason: 'manifest_absent',
      checkedFiles: 0,
      largestFileBytes: legacyInventory?.largestFileBytes ?? 0,
    };
  }

  const manifestEntries = manifestDataEntries(manifestRead.value, srcDir, subdirFilter);
  if (!manifestEntries) {
    throw new ServerError(`Snapshot integrity manifest is invalid: ${snapshotId}`, {
      status: 409,
      code: 'BACKUP_MANIFEST_INVALID',
    });
  }
  const { selected, dataPaths } = manifestEntries;

  // Hash agreement is insufficient if rsync can also copy files the manifest
  // never recorded. Rebuild the same regular-file inventory in the selected
  // scope and reject additions before rsync reads or overwrites anything.
  const inventory = await snapshotScopeInventory(srcDir, subdirFilter)
    .catch(() => null);
  if (!inventory) throw snapshotFileIntegrityError(snapshotId);
  const { paths: snapshotPaths, largestFileBytes } = inventory;
  const unmanifested = snapshotPaths.find(entry => !dataPaths.has(entry));
  if (unmanifested) throw snapshotFileIntegrityError(snapshotId, unmanifested);

  for (const { filePath, expectedHash } of selected) {
    const info = await lstat(filePath).catch(() => null);
    if (!info || (!info.isFile() && !info.isSymbolicLink())) {
      throw snapshotFileIntegrityError(snapshotId);
    }
    const actualHash = await sha256File(filePath).catch(() => null);
    if (!actualHash || actualHash !== expectedHash) {
      throw snapshotFileIntegrityError(snapshotId);
    }
  }

  return { status: 'verified', checkedFiles: selected.length, largestFileBytes };
}

/**
 * Idle deadline for a restore's rsync. `--checksum` digests BOTH copies of a
 * same-size file before rsync reports the entry, so the largest in-scope file
 * bounds the longest silence a healthy scan can produce: floor the deadline at
 * both copies over a conservative worst-case throughput. A scope holding only
 * small files keeps the default — the relaxed deadline is spent only where a
 * long silence is explainable (#7302).
 */
function restoreIdleTimeoutMs(largestFileBytes = 0) {
  const digestMs = (2 * largestFileBytes * 1000) / RESTORE_DIGEST_WORST_CASE_BPS;
  return Math.max(BACKUP_PROCESS_IDLE_TIMEOUT_MS, Math.ceil(digestMs));
}

/**
 * Restore a snapshot back to PATHS.data using rsync.
 * @param {string} destPath - Path to external drive backup root
 * @param {string} snapshotId - Snapshot ID to restore
 * @param {object} options
 * @param {boolean} [options.dryRun=true] - If true, do not write any files
 * @param {string|null} [options.subdirFilter=null] - Limit restore to a subdirectory
 */
export async function restoreSnapshot(destPath, snapshotId, { dryRun = true, subdirFilter = null, source } = {}) {
  const resolved = resolveSnapshotPath(destPath, snapshotId, source);
  await assertExplicitSnapshotSourceSafe(resolved, snapshotId);

  // Defense-in-depth for non-route callers (the route already validates via
  // subdirFilterSchema). subdirFilter is interpolated into an rsync include arg,
  // so a `*` would override the filter chain (restoring everything) and `..`
  // would traverse out of the snapshot subdir. Reuse the same predicate the
  // schema does so the two can't drift — see issue #1822.
  if (subdirFilter != null && !isSafeSubdirFilter(subdirFilter)) {
    throw new Error(`Invalid subdirFilter: ${subdirFilter}`);
  }
  // Refused for previews too, before any verification or transfer, so a preview
  // never promises a restore that execution would silently skip.
  if (restoreScopeIsPreservedFile(subdirFilter)) {
    throw new ServerError(
      'These machine-local authority and recovery records (database-authority.json, peer-execution-authority.json, peer-execution-recovery.jsonl, workflow-maintenance and backup-admission) are never restored from a snapshot. Restore application records with a data or database restore; existing local authority and unresolved owners must be reconciled on this machine (see docs/STORAGE.md).',
      { status: 400, code: 'BACKUP_RESTORE_MACHINE_LOCAL' },
    );
  }

  // Hold the source from before the restorability and integrity preflight
  // until rsync has closed (and, for execution, caches are reconciled), so
  // neither explicit deletion nor retention can remove verified bytes while
  // rsync still reads them (#10898).
  return withSnapshotRead(resolved.snapshotDir, snapshotId,
    () => restoreHeldSnapshot(resolved, snapshotId, { dryRun, subdirFilter }));
}

async function restoreHeldSnapshot({ snapshotDir, currentSource }, snapshotId, { dryRun, subdirFilter }) {
  await assertSnapshotRestorable(snapshotDir, snapshotId, currentSource);
  const srcDir = join(snapshotDir, 'data');

  // Run the preflight independently for preview and execution. A preview is an
  // aid to confirmation, not an integrity lease: snapshot bytes may change
  // between requests, especially on removable or network-backed destinations.
  const verification = await verifySnapshotFiles(snapshotDir, srcDir, snapshotId, subdirFilter);

  // Restore must compare destination bytes even when size and mtime match.
  // Rsync's default quick-check would otherwise report a successful no-op for
  // equal-length edits that retain the snapshot timestamp.
  //
  // `-ii` is what keeps that affordable. `--checksum` makes rsync digest BOTH
  // copies of every file in scope, and a file that turns out to match emits
  // nothing under plain `--itemize-changes`/`--progress` — those report only
  // transferring files. A preview of a large unchanged tree therefore runs
  // silent for as long as the digest takes, and runRsync's idle watchdog
  // (BACKUP_PROCESS_IDLE_TIMEOUT_MS) SIGKILLs a perfectly healthy restore.
  // Doubling itemize makes rsync report unchanged entries too (`.f <path>`),
  // one line per file digested, which is what keeps the watchdog fed. The
  // changed-file count runRsync returns is unaffected: the added lines start
  // with `.`, and runRsync collects only `>`/`<` transfer lines.
  //
  // It must be the SHORT `-ii`, and it is deliberately not `--info=progress2`:
  // macOS ships openrsync, where the long `--itemize-changes` does NOT stack
  // when repeated and `--info=progress2` is rejected outright as an unknown
  // option (it arrived in rsync 3.1). `-ii` behaves identically on openrsync
  // and rsync 3.x, so no version probe is needed. See issue #7299.
  //
  // Before the include chain below: rsync takes the FIRST matching rule, so an
  // exclude placed after `--include=/<filter>/***` would never be consulted.
  // These are the files `snapshotScopeInventory` skips — keeping the two in
  // step is what preserves "everything transferred was verified".
  // Same placement rule: excluded before the include chain, and kept out of the
  // manifest selection and inventory above, so what rsync may write is exactly
  // what the preflight verified.
  const flags = ['-ii', '--checksum', ...OS_METADATA_RSYNC_EXCLUDES, ...RESTORE_PRESERVED_RSYNC_EXCLUDES];
  if (dryRun) flags.push('--dry-run');
  if (subdirFilter) {
    // Anchored with a leading `/` — rsync matches an unanchored pattern against
    // the END of every path, so a bare `youtube/***` would also restore
    // `data/brain/youtube/**` over live files the user never selected. The
    // integrity preflight above scopes itself to `data/<filter>/**` only, so an
    // unanchored transfer overwrites bytes it never verified.
    // Exact files need their own rule: rsync 3 excludes a file from the directory-only /*** pattern.
    flags.push(`--include=/${subdirFilter}`);
    flags.push(`--include=/${subdirFilter}/***`);
    flags.push('--include=*/');
    flags.push('--exclude=*');
  }

  // The preflight just walked the scope, so its largest file is free — one
  // file whose digest outlasts the default deadline emits no `-ii` heartbeat
  // until it finishes (#7302), so this restore's idle floor scales to it.
  const idleTimeoutMs = restoreIdleTimeoutMs(verification.largestFileBytes);
  const transferFiles = () => runRsync(srcDir, PATHS.data, flags, { idleTimeoutMs });
  // A preview holds no owner, fences no identity and reconciles no cache.
  if (dryRun) {
    const changedFiles = await transferFiles();
    return { dryRun, snapshotId, subdirFilter, changedFiles, verification };
  }

  // Applicability uses the normalized scope; reconciliation keeps the raw filter.
  const scope = subdirFilter?.split('/').filter(part => part && part !== '.').join('/');
  const changedFiles = await withLiveFileRestoreOwners(scope, () => transferAndReconcileLiveFiles({
    subdirFilter,
    transfer: () => transferWithIdentityFence({ scope, srcDir, transferFiles }),
  }));
  return { dryRun, snapshotId, subdirFilter, changedFiles, verification };
}

const COS_RESTORE_SCOPES = ['cos', 'cos/config.json', 'cos/state.json', 'cos/agents'];

/**
 * Owners a live file restore holds, OUTERMOST FIRST — this array order IS the
 * acquisition order, and each owner is released in reverse after everything
 * inside it (transfer plus partial-failure reconciliation) has settled.
 * `appliesTo` receives the normalized scope (`''`/undefined = full restore);
 * `hold` acquires the owner, runs `inner`, and releases on every exit. Domain
 * modules are imported only once every outer owner is held.
 *
 * - The snapshot cut drains in-flight asset publications BEFORE any domain
 *   queue they may need to finish, and keeps admission closed throughout.
 * - Schedule mutations can await CoS state, so their queue precedes CoS.
 * - The settings queue stays held through CoS reconciliation.
 * - CoS acquires config then runtime internally (`withLiveCosRestore`) and
 *   refuses a busy daemon/mind/agent with `COS_RESTORE_BUSY`.
 * - The media registry refuses edits for the whole hold and is acquired after
 *   CoS, so its write fence never outlives a refused CoS restore.
 * - Apple Health admission is acquired last, for the same reason: it closes
 *   import/archive admission and drains admitted day cycles (which wait on no
 *   other owner) before the transfer, then reopens after cache invalidation.
 */
const LIVE_FILE_RESTORE_OWNERS = Object.freeze([
  {
    name: 'backup snapshot cut',
    appliesTo: () => true,
    hold: async (inner) => {
      const releaseSnapshotCut = await acquireBackupSnapshotCut();
      try {
        return await inner();
      } finally {
        releaseSnapshotCut();
      }
    },
  },
  {
    name: 'task schedule',
    appliesTo: scope => !scope || scope === 'cos' || scope === 'cos/task-schedule.json',
    hold: async (inner) => {
      const { withLiveTaskScheduleRestore } = await import('./taskScheduleStore.js');
      return withLiveTaskScheduleRestore(inner);
    },
  },
  {
    name: 'settings',
    appliesTo: scope => !scope || scope === 'settings.json',
    hold: inner => withLiveSettingsRestore(inner),
  },
  {
    name: 'CoS config and runtime',
    appliesTo: scope => !scope || COS_RESTORE_SCOPES.includes(scope) || scope.startsWith('cos/agents/'),
    hold: async (inner) => {
      const { withLiveCosRestore } = await import('./cosState.js');
      return withLiveCosRestore(inner);
    },
  },
  {
    name: 'media model registry',
    appliesTo: scope => !scope || scope === 'media-models.json',
    hold: async (inner) => {
      const { withLiveMediaModelsRestore } = await import('../lib/mediaModels.js');
      return withLiveMediaModelsRestore(inner);
    },
  },
  {
    name: 'Apple Health day files',
    appliesTo: scope => !scope || scope === 'health' || scope.startsWith('health/'),
    hold: async (inner) => {
      const { withLiveHealthRestore } = await import('./appleHealthIngest.js');
      return withLiveHealthRestore(inner);
    },
  },
]);

/** Run `operation` inside every live-restore owner that applies to `scope`, in table order. */
function withLiveFileRestoreOwners(scope, operation) {
  const nested = LIVE_FILE_RESTORE_OWNERS.reduceRight(
    (inner, owner) => (owner.appliesTo(scope) ? () => owner.hold(inner) : inner),
    operation,
  );
  return nested();
}

/**
 * Peer-execution identity fence: shorter-lived than the owners above. It wraps
 * ONLY the rsync transfer, never reconciliation, and only when the scope can
 * touch instances.json AND the snapshot actually carries that file — probed
 * here, inside the already-held owners.
 */
async function transferWithIdentityFence({ scope, srcDir, transferFiles }) {
  const identityInScope = !scope || scope === 'instances.json';
  const snapshotHasIdentity = identityInScope && await stat(join(srcDir, 'instances.json')).then(
    info => info.isFile(),
    error => { if (error.code === 'ENOENT') return false; throw error; },
  );
  if (!snapshotHasIdentity) return transferFiles();
  const { withPeerExecutionIdentityRestore } = await import('./peerExecutionRuntime.js');
  return withPeerExecutionIdentityRestore(transferFiles);
}

/**
 * Rsync may overwrite live files before reporting failure, so settle the
 * transfer and reconcile caches while the owners are still held. A transfer
 * failure stays the primary error (keeping its code); a reconciliation failure
 * is appended to it, or thrown on its own after a successful transfer.
 */
async function transferAndReconcileLiveFiles({ subdirFilter, transfer }) {
  const [result] = await Promise.allSettled([transfer()]);
  const reconciliationError = await reconcileLiveFileRestore(subdirFilter).then(() => null, error => error);
  if (result.status === 'rejected') {
    const partialRestoreError = new Error(
      `${result.reason.message}. Some files may already have been overwritten because file restore is not transactional.${reconciliationError ? ` ${reconciliationError.message}` : ''}`,
      { cause: result.reason },
    );
    if (result.reason?.code) partialRestoreError.code = result.reason.code;
    throw partialRestoreError;
  }
  if (reconciliationError) throw reconciliationError;
  return result.value;
}

const DUMP_UNREADABLE = Object.freeze({ status: 'failed', reason: 'dump_unreadable', error: 'The snapshot database dump could not be read or staged for restore. Restore was refused without changing data.' });

/**
 * Restore the PostgreSQL dump from a snapshot. Dry-run by default — mirrors
 * restoreSnapshot's safety default. Both modes first admit the snapshot's
 * portos-db.sql (complete pg_dump envelope, manifest hash when recorded); a
 * real restore then replays the admitted private copy into psql. The dump was
 * written with --no-owner --no-acl so it replays cleanly.
 *   { status: 'ok', dryRun, sizeBytes, tableCount }   (dry-run or applied)
 *   { status: 'skipped', reason: 'no_dump' }           (no sql file in snapshot)
 *   { status: 'skipped', reason: 'not_configured' }    (real restore, PG unreachable)
 *   { status: 'failed', reason: 'manifest_unreadable'|'manifest_mismatch'|'dump_unreadable'|'dump_incomplete'|'restore_compatibility'|'restore_preflight'|'restore_journal'|'backup_snapshot_busy'|'restore_error'|'timeout', error? }
 *     (nothing changed; a failed replay is reported only once proven rolled back)
 *   { status: 'failed', reason: 'restore_recovery_pending'|'restore_commit_unknown'|'restore_schema_reconciliation'|'restore_catalog_reconciliation'|'restore_sync_resync'|'restore_recovery_release', error, recovery }
 *     (a restore awaits recovery: ordinary database work stays fenced until
 *     resumeDatabaseRestore finishes it — see backupRestoreRecovery.js, #9725)
 * A successful real restore also carries `syncCursorsRewound` (peer count).
 * @param {string} destPath - Backup destination root
 * @param {string} snapshotId
 * @param {{dryRun?: boolean}} [options]
 */
export async function restorePostgres(destPath, snapshotId, { dryRun = true, source } = {}) {
  const resolved = resolveSnapshotPath(destPath, snapshotId, source);
  await assertExplicitSnapshotSourceSafe(resolved, snapshotId);
  // Held for the whole call, which spans every read of snapshot bytes: the
  // restorability check, the manifest and the dump admission/spool read. (The
  // replay itself reads only the private spool copy.) Neither deletion nor
  // retention can remove the dump while it is being admitted (#10898).
  return withSnapshotRead(resolved.snapshotDir, snapshotId,
    () => restoreHeldDatabase(resolved, snapshotId, { dryRun }));
}

async function restoreHeldDatabase({ snapshotDir, currentSource }, snapshotId, { dryRun }) {
  await assertSnapshotRestorable(snapshotDir, snapshotId, currentSource);
  // A committed restore awaiting repair fences the database; neither a preview
  // nor another replay may start until it is resolved (#9725).
  const pendingRecovery = restoreRecoveryRefusal();
  if (pendingRecovery) return pendingRecovery;
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
  const expectedHash = manifestRead.value?.files?.['../portos-db.sql'];
  // Execution replays a private copy written by the same read that admits the
  // dump, so replay derives only from the checked bytes even if the
  // snapshot changes afterwards (#8782). Preview only inspects.
  const spoolDir = dryRun ? null : await mkdtemp(join(tmpdir(), 'portos-restore-')).catch((err) => {
    console.error(`❌ restore: cannot stage dump for snapshot ${snapshotId}: ${err.message}`);
    return false;
  });
  if (spoolDir === false) return DUMP_UNREADABLE;
  try {
    return await restoreAdmittedDump({ sqlPath, spoolPath: spoolDir && join(spoolDir, 'dump.sql'), expectedHash, snapshotId, dryRun, sizeBytes: info.size });
  } finally {
    if (spoolDir) {
      await rm(spoolDir, { recursive: true, force: true })
        .catch(err => console.error(`❌ restore: failed to remove dump spool ${spoolDir}: ${err.message}`));
    }
  }
}

async function restoreAdmittedDump({ sqlPath, spoolPath, expectedHash, snapshotId, dryRun, sizeBytes }) {
  // One streamed read supplies the checksum and the completeness proof. A read
  // failure is refused here — never mistaken for an empty dump.
  const targetServerMajor = await getServerMajorVersion().catch(() => null);
  const dump = await inspectDatabaseDump(sqlPath, { spoolTo: spoolPath, targetServerMajor }).catch((err) => {
    console.error(`❌ restore: dump unreadable for snapshot ${snapshotId}: ${err.message}`);
    return null;
  });
  if (!dump) {
    return DUMP_UNREADABLE;
  }
  if (expectedHash && dump.sha256 !== expectedHash) {
    console.error(`❌ restore: manifest hash mismatch for snapshot ${snapshotId} (expected ${expectedHash}, got ${dump.sha256})`);
    return { status: 'failed', reason: 'manifest_mismatch' };
  }
  // The restore resets every application table first, so a dump that parses
  // but stops early (header-only, or truncated between statements) would
  // commit an empty database. ON_ERROR_STOP cannot see that; the envelope can.
  if (!dump.complete || dump.missingTables.length) {
    const missing = [
      ...(dump.complete ? [] : ['the pg_dump completion marker']),
      ...dump.missingTables.map(name => `table ${name}`),
    ].join(', ');
    console.error(`❌ restore: incomplete dump for snapshot ${snapshotId} (missing ${missing})`);
    return { status: 'failed', reason: 'dump_incomplete', error: `The snapshot database dump is incomplete (missing ${missing}). Restore was refused without changing data.` };
  }
  const { tableCount } = dump;
  const health = await checkHealth();
  if (!health.connected) return { status: 'skipped', reason: 'not_configured' };
  if (!Number.isInteger(targetServerMajor) || targetServerMajor <= 0) {
    return {
      status: 'failed',
      reason: 'restore_compatibility',
      error: 'Cannot establish the target PostgreSQL major version. Check database connectivity and permission to SHOW server_version_num, then retry preview before restoring. No data was changed.',
    };
  }
  // Admission checks above always cover the original bytes. Only the private
  // replay copy omits extension comments and clean-dump extension drops,
  // whose ownership may belong to a provisioning role, plus the exact PG17
  // transaction_timeout header when replaying to an older target.
  const replayPath = dryRun ? null : await prepareDatabaseReplay(spoolPath, dump.extensionMetadata).catch(err => {
    console.error(`❌ restore: cannot normalize admitted dump for snapshot ${snapshotId}: ${err.message}`);
    return null;
  });
  if (!dryRun && !replayPath) return DUMP_UNREADABLE;

  // Preview remains read-only. Recheck inside the replay transaction as well,
  // so a changed catalog cannot turn a previously safe preview into a cascade.
  const { getDatabaseResetPlan } = await import('./backupDatabaseReset.js');
  const { preflight, reset } = await getDatabaseResetPlan();
  const preflightError = await query(preflight).then(() => null, error => error);
  if (preflightError) {
    return { status: 'failed', reason: 'restore_preflight', error: 'Database contains unexpected objects, ownership, or dependencies. Restore was refused without changing data.' };
  }
  if (dryRun) return { status: 'ok', dryRun: true, sizeBytes, tableCount };

  // The replay replaces every row. Take the backup boundary first so no admitted
  // file-plus-row publication is half done underneath it and no backup cut is
  // capturing the database mid-replay. Only this restore's own cut is released.
  let releaseSnapshotCut;
  try {
    releaseSnapshotCut = await acquireBackupSnapshotCut();
  } catch (err) {
    if (err.code !== 'BACKUP_SNAPSHOT_BUSY') throw err;
    console.warn(`⚠️ restore: refused for snapshot ${snapshotId}: ${err.message}`);
    return {
      status: 'failed',
      reason: 'backup_snapshot_busy',
      error: 'A backup is capturing the database or an asset publication did not finish draining. Restore was refused without changing data; retry when it finishes.',
    };
  }
  try {
    return await replayAdmittedDump({ tableCount, sizeBytes, snapshotId, dump, reset, replayPath });
  } finally {
    releaseSnapshotCut();
  }
}

async function replayAdmittedDump({ tableCount, sizeBytes, snapshotId, dump, reset, replayPath }) {
  return withDatabaseMaintenance(async ({ adoptRestoreRecovery }) => {
    // Read before the replay rewinds them, then make them durable together
    // with this operation's identity BEFORE anything destructive runs: a
    // committed replay whose repair fails (or a restart) must floor sequences
    // at THESE positions, never at values re-read after the dump reset them.
    const feedPositions = await captureSyncFeedPositions();
    let record;
    try {
      record = databaseRestoreRecovery.begin({ snapshotId, dumpSha256: dump.sha256, feedPositions });
      adoptRestoreRecovery(record.id);
    } catch (err) {
      if (record) throw err;
      console.error(`❌ restore: recovery journal could not be written for snapshot ${snapshotId}: ${err.message}`);
      return {
        status: 'failed',
        reason: 'restore_journal',
        error: 'The restore recovery journal could not be written. Restore was refused without changing data.',
      };
    }
    try {
      const { preparePeerExecutionRestore } = await import('./peerExecutionRestore.js');
      await preparePeerExecutionRestore(record.id);
    } catch (err) {
      console.error(`❌ restore: execution consumption capture failed: ${err.message}`);
      return pendingRecoveryResult('restore_execution_reconciliation', record);
    }
    const { host: pgHost, port, database: pgDb, user: pgUser } = POOL_CONFIG;
    const pgPort = String(port);

    const replay = await withPgToolEnv(POOL_CONFIG, pgEnv => new Promise((resolveP) => {
      // ON_ERROR_STOP=1 aborts on the first failed statement; --single-transaction
      // wraps the whole replay in one transaction so that abort ROLLs BACK every
      // prior statement. Together they make the restore atomic: it either fully
      // applies or leaves the live DB untouched — never a mixed snapshot/current
      // state. (The dump is written with --clean --if-exists, so the DROPs and
      // recreates all commit or roll back as one unit.) psql reads the admitted
      // spool copy, never the snapshot path. The trailing receipt commits with
      // the dump or not at all, and the application name identifies this
      // replay's session to recovery (#9725).
      const proc = spawn('psql', [
        '-X', '-v', 'ON_ERROR_STOP=1',
        '--single-transaction',
        '--echo-all',
        '-h', pgHost, '-p', pgPort, '-U', pgUser, '-d', pgDb, '-c', reset, '-f', replayPath,
        '-c', restoreReceiptSql(record),
      ], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...pgEnv, PGAPPNAME: restoreApplicationName(record.id) } });

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
          resolveP({ status: 'ok', dryRun: false, sizeBytes, tableCount });
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
    })).catch((err) => ({ status: 'failed', reason: 'restore_error', error: err.message }));

    if (replay.status === 'ok') {
      // psql exit 0 under --single-transaction means COMMIT succeeded.
      record = databaseRestoreRecovery.markCommitted(record.id);
    } else {
      // A failed/killed/lost psql may still have committed (a crash or lost
      // response at COMMIT). Only the receipt can say; an unknown outcome stays
      // fenced instead of reopening writes or replaying again.
      const settled = await settleReplayOutcome(record);
      if (settled.outcome === 'rolled_back') return replay;
      if (settled.outcome === 'uncertain') return pendingRecoveryResult(settled.reason ?? 'restore_commit_unknown', record);
      record = settled.record;
    }

    // Replay has committed. Still inside maintenance and still fenced, so no
    // sync apply or feed write can interleave with the repair, and a failed
    // step leaves ordinary work closed with the original positions recorded.
    const repaired = await repairCommittedRestore(record);
    if (repaired.status !== 'ok') return repaired;
    return { status: 'ok', dryRun: false, sizeBytes, tableCount, syncCursorsRewound: repaired.syncCursorsRewound };
  });
}

/**
 * Get backup state with process-local failure and running projections.
 */
export async function getState() {
  const state = await readJSONFile(STATE_PATH, DEFAULT_STATE, { strict: true });
  const projected = failedStateProjection ? { ...state, ...failedStateProjection } : state;
  return isRunning ? { ...projected, status: 'running' } : projected;
}

/**
 * Merge patch into current backup state and persist.
 * @param {object} patch - Fields to merge into state
 * @param {Function} [onFailure] - Handle a rejected write inside the serialized queue
 */
export async function saveState(patch, onFailure) {
  return queueStateWrite(() => (async () => {
    await ensureDir(join(PATHS.data, 'backup'));
    // Status projections are read-only and must never become durable state.
    const current = await readJSONFile(STATE_PATH, DEFAULT_STATE, { strict: true });
    const updated = { ...current, ...patch };
    await atomicWrite(STATE_PATH, updated);
    failedStateProjection = null;
    return updated;
  })().catch((error) => {
    // Handle the failed transition inside the queue: a later successful write
    // must clear it, never race with an out-of-queue failure handler.
    if (onFailure) return onFailure(error);
    throw error;
  }));
}

/**
 * Get the next scheduled backup run time from eventScheduler.
 * @returns {string|null} ISO timestamp of next run, or null
 */
export function getNextRunTime() {
  const event = getEvent('backup-daily');
  return event?.nextRunAt ? new Date(event.nextRunAt).toISOString() : null;
}

/**
 * Whether THIS process has a backup snapshot in flight right now, for the
 * system-idle gate. Deliberately reads the in-process `isRunning` flag rather
 * than scanning for an on-disk `.in-progress` marker: that marker is designed
 * to OUTLIVE a crash/PM2 restart so a restore never mistakes a partial
 * snapshot for a complete one, but nothing ever clears an orphaned one on its
 * own (the next run writes a fresh snapshot id) — gating the updater on its
 * mere existence would block it forever after a single interrupted backup on
 * a drive that might not even be mounted. The gate only needs to know whether
 * restarting would kill a live rsync/pg_dump in this server instance, and
 * `isRunning` answers exactly that, with no I/O and nothing that can fail to
 * read.
 */
export function isBackupInProgress() {
  return isRunning;
}
