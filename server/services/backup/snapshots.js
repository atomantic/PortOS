/**
 * Backup snapshot lifecycle: in-progress/failed markers, the in-process read and
 * delete leases, snapshot path resolution, inventory listing, retention pruning,
 * deletion and download streaming.
 */

import { dashboardEvents } from '../dashboardEvents.js';
import { spawn } from '../../lib/childProcess.js';
import { killWithEscalation } from '../../lib/killWithEscalation.js';
import { access, lstat, readdir, readFile, realpath, rm, stat, unlink, writeFile } from 'fs/promises';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { hostname } from 'os';
import { join, resolve, relative, isAbsolute, posix } from 'path';
import { PATHS, readJSONFile, readJSONFileStrict } from '../../lib/fileUtils.js';
import { getBackendName } from '../memoryBackend.js';
import { ServerError } from '../../lib/errorHandler.js';
import { isSafeSnapshotSource } from '../../lib/sharedSchemas.js';
import { watchBackupProcess } from './rsync.js';
import { isOsMetadataFile, isRestorePreservedPath } from './excludes.js';

// A snapshot mid-assembly is a truncated tree that looks like a finished backup.
// Two signals guard it, because neither alone is sufficient:
//   - `activeSnapshotId` catches the in-process case with no I/O.
//   - the `.in-progress` marker survives a hard crash or PM2 restart, which
//     resets module state while the partial directory stays on the drive.
// A finished failure replaces these guards with `.failed`: downloads remain
// available for manual salvage, while restore paths can distinguish the partial
// tree from both completed and legacy snapshots after a restart.
// Each in-progress marker carries the writing process's start id. Only the
// server process runs `runBackup`, so in this host's namespace a marker with
// any other token (or the legacy empty marker) belongs to a killed run: that
// snapshot is `interrupted` — never restorable or downloadable, but deletable,
// pruned once a newer complete snapshot exists, and converged to `.failed`
// with INTERRUPTED_FAILURE_REASON by the next run (#12618).
const SNAPSHOT_IN_PROGRESS_MARKER = '.in-progress';
const SNAPSHOT_FAILED_MARKER = '.failed';
export const BACKUP_PROCESS_START_ID = randomUUID();
const INTERRUPTED_FAILURE_REASON = 'interrupted by restart';
const MARKER_UNREADABLE = Symbol('marker-unreadable');
let activeSnapshotId = null;
// runBackup (backup.js) owns this value, but an importer cannot assign an ES
// module binding, so the run sets it through setActiveSnapshotId().
export const setActiveSnapshotId = (id) => {
  activeSnapshotId = id;
};

export const markerPath = (snapshotDir) => join(snapshotDir, SNAPSHOT_IN_PROGRESS_MARKER);
export const failedMarkerPath = (snapshotDir) => join(snapshotDir, SNAPSHOT_FAILED_MARKER);
export const parentMarkerPath = (snapshotDir, snapshotId) =>
  join(resolve(snapshotDir, '..'), `.${snapshotId}${SNAPSHOT_IN_PROGRESS_MARKER}`);
const markerExistsAt = (path) =>
  access(path).then(
    () => true,
    (err) => err?.code === 'ENOENT' || err?.code === 'ENOTDIR' ? false : true,
  );
// null when absent, the marker's text when readable, MARKER_UNREADABLE when it
// exists (or cannot be proven absent) but its owner cannot be read.
const readMarkerAt = async (path) => {
  if (!await markerExistsAt(path)) return null;
  return readFile(path, 'utf8').catch(() => MARKER_UNREADABLE);
};

async function snapshotState(snapshotDir, snapshotId, currentSource = true) {
  const [snapshotMarker, parentMarker, failedMarker] = await Promise.all([
    readMarkerAt(markerPath(snapshotDir)),
    snapshotId ? readMarkerAt(parentMarkerPath(snapshotDir, snapshotId)) : null,
    readMarkerAt(failedMarkerPath(snapshotDir)),
  ]);
  const inProgressMarkers = [snapshotMarker, parentMarker].filter(marker => marker !== null);
  const failed = failedMarker !== null;
  const active = currentSource && snapshotId === activeSnapshotId;
  // Another machine's namespace stays `incomplete`: its run may still be
  // live. An unreadable owner, or one this process wrote (the reservation
  // window before `activeSnapshotId` is set), is never presumed dead.
  const abandoned = currentSource && !active && !failed && inProgressMarkers.length > 0
    && inProgressMarkers.every(marker => marker !== MARKER_UNREADABLE && marker !== BACKUP_PROCESS_START_ID);
  return {
    failed,
    // Once `.failed` exists the run is finished even if marker cleanup was
    // interrupted. The durable failed state still blocks every restore.
    incomplete: active || (inProgressMarkers.length > 0 && !failed && !abandoned),
    interrupted: abandoned || (!active && failedMarker === INTERRUPTED_FAILURE_REASON),
  };
}

const snapshotInterruptedError = (snapshotId) =>
  new ServerError(`Snapshot backup was interrupted by a restart: ${snapshotId}. Delete it or choose a completed backup.`, {
    status: 409,
    code: 'SNAPSHOT_INTERRUPTED',
  });

/** Reject a snapshot that is still being written, or was abandoned mid-write, before any consumer reads it. */
async function assertSnapshotComplete(snapshotDir, snapshotId, currentSource) {
  const { incomplete, interrupted } = await snapshotState(snapshotDir, snapshotId, currentSource);
  if (incomplete) {
    throw new ServerError(`Snapshot is still being written: ${snapshotId}`, {
      status: 409,
      code: 'SNAPSHOT_INCOMPLETE',
    });
  }
  if (interrupted) throw snapshotInterruptedError(snapshotId);
}

/** Reject snapshots whose backup run finished unsuccessfully before restoring. */
export async function assertSnapshotRestorable(snapshotDir, snapshotId, currentSource) {
  const { incomplete, failed, interrupted } = await snapshotState(snapshotDir, snapshotId, currentSource);
  if (incomplete) {
    throw new ServerError(`Snapshot is still being written: ${snapshotId}`, {
      status: 409,
      code: 'SNAPSHOT_INCOMPLETE',
    });
  }
  if (interrupted) throw snapshotInterruptedError(snapshotId);
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
export async function withSnapshotRead(snapshotDir, snapshotId, operation) {
  const release = await acquireSnapshotLease(snapshotDir, snapshotId, 'read');
  try {
    return await operation();
  } finally {
    release();
  }
}

// Snapshots live under snapshots/<hostname>/<snapshotId> so a single shared
// destination (e.g. iCloud) can host backups from multiple machines without
// their snapshot IDs colliding.
export const MACHINE_HOST = hostname().toLowerCase().replace(/[^\w.-]/g, '_') || 'unknown';
const LEGACY_SNAPSHOT_SOURCE = '@legacy';
const SNAPSHOT_ID_PATTERN = /^[\w\-.:T]+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const MANIFEST_ABSENT = Symbol('manifest-absent');

/**
 * The explicit file escape hatch (MEMORY_BACKEND=file, or a backend that
 * resolved to 'file'): the one state in which PostgreSQL is not required. The
 * backend initializes lazily (ensureBackend), so the env var is consulted too —
 * an uninitialized backend under the hatch must not count as "Postgres required".
 * Shared by the dump, the restore compatibility check and restore reconciliation
 * so the three cannot disagree about one install.
 */
export const usesFileEscapeHatch = () => process.env.MEMORY_BACKEND === 'file' || getBackendName() === 'file';

export function missingDumpParts({ complete, missingTables }) {
  return [
    ...(complete ? [] : ['the pg_dump completion marker']),
    ...missingTables.map(name => `table ${name}`),
  ].join(', ');
}

// Keep filesystem diagnostics bounded: native errors include private paths.
export function inventoryReadError(cause, operation) {
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
 * @returns {Array<{ id, source, selectionKey, createdAt, fileCount, incomplete, failed, interrupted }>} sorted newest-first
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
      const { incomplete, failed, interrupted } = await snapshotState(snapshotDir, id, currentSource);
      return {
        id,
        source,
        sourceLabel: source === LEGACY_SNAPSHOT_SOURCE
          ? 'Legacy (pre-namespace)'
          : source === MACHINE_HOST ? `${source} (current machine)` : source,
        selectionKey: `${source}/${id}`,
        currentMachine: source === MACHINE_HOST,
        createdAt: typeof manifest?.generatedAt === 'string' && !Number.isNaN(Date.parse(manifest.generatedAt))
          ? manifest.generatedAt : null,
        fileCount: manifest?.fileCount ?? 0,
        incomplete,
        failed,
        interrupted,
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
 * Converge every interrupted snapshot in this host's namespace to a durable
 * `.failed` (reason INTERRUPTED_FAILURE_REASON), then drop its in-progress
 * markers — the same order `fail()` uses, so a failed write leaves the
 * snapshot guarded. Holds the exclusive lease so a concurrent delete or
 * reader cannot interleave with the marker writes.
 */
export async function markInterruptedSnapshotsFailed(snapshotsRoot) {
  const entries = await readdir(snapshotsRoot, { withFileTypes: true });
  let marked = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || !SNAPSHOT_ID_PATTERN.test(entry.name)) continue;
    const id = entry.name;
    const snapshotDir = join(snapshotsRoot, id);
    const isCandidate = ({ interrupted, failed }) => interrupted && !failed;
    // Lease only candidates, so a download starting now is not refused
    // SNAPSHOT_DELETING by a healthy snapshot's sweep.
    if (!isCandidate(await snapshotState(snapshotDir, id, true))) continue;
    // Own the snapshot before the final state check, as deleteSnapshot does.
    const { release, refusal } = await claimSnapshotLease(snapshotDir, 'delete');
    if (refusal) continue;
    try {
      const exists = await stat(snapshotDir).then(info => info.isDirectory(), () => false);
      if (!exists || !isCandidate(await snapshotState(snapshotDir, id, true))) continue;
      const removeIfPresent = (path) => unlink(path).catch(err => { if (err.code !== 'ENOENT') throw err; });
      await writeFile(failedMarkerPath(snapshotDir), INTERRUPTED_FAILURE_REASON)
        .then(() => removeIfPresent(markerPath(snapshotDir)))
        .then(() => removeIfPresent(parentMarkerPath(snapshotDir, id)))
        .then(
          () => { marked += 1; },
          err => console.error(`❌ Backup: failed to mark interrupted snapshot ${id} failed: code=${err?.code ?? 'UNKNOWN'}`),
        );
    } finally {
      release();
    }
  }
  if (marked) console.log(`💾 Backup: marked ${marked} interrupted snapshot(s) failed`);
}

async function isRetentionEligibleSnapshot(snapshotDir, id, requiresDatabase) {
  // Only confirmed absence is legacy. An existing manifest must pass the
  // same structural checks as a file restore, without hashing old payloads.
  const srcDir = join(snapshotDir, 'data');
  const manifestRead = await readJSONFileStrict(join(snapshotDir, 'manifest.json'), MANIFEST_ABSENT, { logError: false });
  const manifest = manifestRead.value;
  const legacy = manifest === MANIFEST_ABSENT;
  const entries = manifestRead.ok && !legacy ? manifestDataEntries(manifest, srcDir, null) : null;
  if (!manifestRead.ok || (!legacy && !entries)) {
    console.warn(`⚠️ Backup retention: kept snapshot ${id} (manifest unreadable or invalid)`);
    return false;
  }
  if (!requiresDatabase) return true;
  if (!legacy && !Object.hasOwn(manifest.files, '../portos-db.sql')) return false;

  // A recorded hash alone cannot establish that the dump remains available.
  // For pre-manifest snapshots the regular, nonempty dump is the only record.
  const dump = await lstat(join(snapshotDir, 'portos-db.sql')).catch(err => {
    if (err?.code !== 'ENOENT') {
      console.warn(`⚠️ Backup retention: kept snapshot ${id} (dump metadata unreadable: ${err?.code ?? 'UNKNOWN'})`);
    }
    return null;
  });
  if (!dump?.isFile() || dump.size === 0) return false;
  return legacy || (await legacyDbMetadataDomains(srcDir, [...entries.dataPaths])).length === 0;
}

/**
 * Delete the oldest COMPLETED snapshots in the CURRENT machine's source
 * namespace beyond `retentionCount`, plus every interrupted snapshot older
 * than the newest healthy completed one. Interrupted snapshots never count
 * toward the budget and are pruned even under unlimited retention: they can
 * never be restored or downloaded, so they only fill the drive.
 * Called only from `runBackup()` after a run reaches a completed snapshot
 * with a successful or explicitly skipped database dump — a run that fails
 * earlier never reaches this call, so an in-progress snapshot is never a
 * candidate; state is re-checked here anyway via `snapshotState` in case an
 * unrelated run left one behind. Ordinary `.failed` snapshots and completed
 * snapshots excluded from the database budget stay available for salvage.
 * Only walks `snapshots/<MACHINE_HOST>/`; other machines' namespaces and the
 * legacy pre-namespace root stay outside this install's pruning scope.
 * `retentionCount` of `null`/`undefined` means unlimited completed snapshots.
 * @param {string} destPath
 * @param {number|null} retentionCount
 * @returns {Promise<{ pruned: number }>}
 */
export async function pruneOldSnapshots(destPath, retentionCount) {
  const unlimited = retentionCount === null || retentionCount === undefined;
  const requiresDatabase = !usesFileEscapeHatch();
  const sourceRoot = join(destPath, 'snapshots', MACHINE_HOST);
  // A completed snapshot was just written here; even ENOENT is a failed
  // inventory, not proof that there is nothing to prune. Keep paths private.
  const entries = await readdir(sourceRoot, { withFileTypes: true }).catch(cause => {
    throw inventoryReadError(cause, 'read-retention-namespace');
  });
  const candidateIds = entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && SNAPSHOT_ID_PATTERN.test(entry.name))
    .map(entry => entry.name);

  const descriptors = (await Promise.all(candidateIds.map(async (id) => {
    const snapshotDir = join(sourceRoot, id);
    const { incomplete, failed, interrupted } = await snapshotState(snapshotDir, id, true);
    if (interrupted) return { id, snapshotDir, interrupted: true };
    if (incomplete || failed) return null;
    // Unlimited retention prunes only interrupted snapshots; completed ones are
    // never candidates, so their manifests need no admission check.
    if (unlimited) return { id, snapshotDir };
    return await isRetentionEligibleSnapshot(snapshotDir, id, requiresDatabase) ? { id, snapshotDir } : null;
  }))).filter(Boolean);

  // Newest-first by snapshot id (an ISO-style timestamp that never depends on
  // reading the manifest). IDs are unique within this source namespace.
  descriptors.sort((a, b) => b.id.localeCompare(a.id));

  const healthy = descriptors.filter(d => !d.interrupted);
  // An interrupted snapshot is only dropped once a newer healthy one exists.
  const newestHealthyId = healthy[0]?.id;
  const toDelete = [
    ...(newestHealthyId ? descriptors.filter(d => d.interrupted && d.id.localeCompare(newestHealthyId) < 0) : []),
    ...(unlimited ? [] : healthy.slice(retentionCount)),
  ];
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
    console.log(`💾 Backup retention: pruned ${pruned} snapshot(s) (limit: ${retentionCount ?? 'unlimited'})`);
  }
  return { pruned };
}

export function resolveSnapshotPath(destPath, snapshotId, source) {
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

export async function assertExplicitSnapshotSourceSafe({
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
 * (`incomplete`), matching the guard that blocks restore and download,
 * because the partial directory may still be owned by an in-flight
 * `runBackup()`. A `.failed` or interrupted snapshot IS deletable — unlike
 * restore, deletion has no reason to require a successful backup. A snapshot
 * a restore or download is still reading is refused with `SNAPSHOT_IN_USE`.
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

  // Arm only the wall-time ceiling: a slow browser backpressuring stdout must
  // not trigger an idle kill, while a tar wedged on a stalled mount still hits
  // the 4-hour backstop even when the client stays connected.
  const watchdog = watchBackupProcess(proc, {
    label: `snapshot download ${snapshotId}`,
    wallOnly: true,
  });

  let finished = false;
  const finish = (error = null) => {
    if (finished) return;
    finished = true;
    watchdog.finish();
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
    watchdog.finish();
    const timeoutError = watchdog.getTimeoutError();
    if (timeoutError) {
      finish(timeoutError);
      return;
    }
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

export function manifestDataEntries(manifest, srcDir, subdirFilter, isSkippedPath = isRestorePreservedPath) {
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

    // Still recorded in dataPaths (inventory consistency), but never hashed:
    // Finder may rewrite a hashed metadata file that restore never transfers.
    if (isSkippedPath(normalized) || isOsMetadataFile(segments.at(-1))) continue;
    if (!subdirFilter || normalized === subdirFilter || normalized.startsWith(`${subdirFilter}/`)) {
      selected.push({ filePath, expectedHash });
    }
  }

  return { selected, dataPaths };
}

// These exact paths belonged to historical file→DB imports.
// Sibling assets and parked .imported evidence remain file-primary recovery data.
const LEGACY_DB_METADATA = [
  ['universes', /^universes\/[^/]+\/index\.json$/],
  ['pipeline-issues', /^pipeline-issues\/iss-[A-Za-z0-9-]+\/index\.json$/],
  ['pipeline-series', /^pipeline-series\/ser-[A-Za-z0-9-]+\/index\.json$/],
  ['story-builder', /^story-builder\/stb-[A-Za-z0-9-]+\/index\.json$/],
  ['writers-room', /^writers-room\/(?:(?:folders|exercises)\.json|works\/[^/]+\/manifest\.json)$/],
  ['creative-director', /^creative-director-projects\.json$/],
  ['cos-tasks', /^(?:COS-)?TASKS\.md$/],
];

// Migrations 018/019 read config.json first and fall back to state.json's
// config slice. Read from the snapshot even when the selected scope omits CoS.
async function snapshotLegacyCosTaskPaths(srcDir) {
  const cosDir = join(srcDir, 'cos');
  for (const directory of [srcDir, cosDir]) {
    const info = await lstat(directory).catch(() => null);
    if (!info?.isDirectory()) return [];
  }
  for (const name of ['config.json', 'state.json']) {
    const path = join(cosDir, name);
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile()) continue;
    const { ok, value } = await readJSONFileStrict(path, null, { logError: false });
    const config = name === 'config.json' ? value : value?.config;
    if (!ok || !config || typeof config !== 'object' || Array.isArray(config)) continue;

    return [config.userTasksFile, config.cosTasksFile]
      .filter(path => typeof path === 'string' && path.trim())
      .map(path => snapshotCosTaskPath(srcDir, path.trim()))
      .filter(Boolean);
  }
  return [];
}

function snapshotCosTaskPath(srcDir, configured) {
  // Only compare archive member names. A config path never grants filesystem
  // access. Relative paths in the old config are relative to the checkout.
  if (isAbsolute(configured)) {
    for (const root of [PATHS.data, srcDir]) {
      const rel = relative(root, configured).replaceAll('\\', '/');
      if (rel && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)) return rel;
    }
    return null;
  }
  const path = posix.normalize(configured.replaceAll('\\', '/'));
  return path.startsWith('data/') ? path.slice('data/'.length) : null;
}

export async function legacyDbMetadataDomains(srcDir, paths) {
  // Manifest paths use native separators; restore inventory uses forward slashes.
  paths = paths.map(path => path.replaceAll('\\', '/'));
  const domains = new Set(LEGACY_DB_METADATA
    .filter(([, pattern]) => paths.some(path => pattern.test(path)))
    .map(([domain]) => domain));
  if (paths.includes('universes/index.json')) {
    const index = await readJSONFileStrict(join(srcDir, 'universes', 'index.json'), null, { logError: false });
    if (!index.ok || index.value?.config?.runs !== undefined) domains.add('universes');
  }
  if (paths.length && !domains.has('cos-tasks') && (await snapshotLegacyCosTaskPaths(srcDir)).some(path => paths.includes(path))) {
    domains.add('cos-tasks');
  }
  return [...domains];
}

export const legacyDbMetadataMessage = domains => `Historical file metadata for ${domains.join(', ')} cannot restore database-primary records. Convert this backup in a disposable offline upgrade install, verify its records, then restore a current-format file/database backup (docs/BACKUP.md).`;
