/**
 * Backup Service
 *
 * Rsync-based incremental backup from ./data/ to an external drive.
 * Generates SHA-256 manifests for integrity verification.
 * Integrates with eventScheduler for daily cron scheduling.
 */

import { spawn } from 'child_process';
import { access, readdir, readFile, stat, unlink } from 'fs/promises';
import { hostname } from 'os';
import { join, resolve, relative, isAbsolute } from 'path';
import { PATHS, ensureDir, readJSONFile, atomicWrite, sha256File } from '../lib/fileUtils.js';
import { getEvent } from './eventScheduler.js';
import { checkHealth, getServerMajorVersion } from '../lib/db.js';
import { resolvePgDumpBinary } from '../lib/pgTools.js';
import { getBackendName } from './memoryBackend.js';
import { emitErrorEvent, ServerError } from '../lib/errorHandler.js';
import { isSafeSubdirFilter } from '../lib/validation.js';
import { getIo } from './socket.js';
import { reloadSettings } from './settings.js';

// Module-level state
let isRunning = false;

const STATE_PATH = join(PATHS.data, 'backup', 'state.json');

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
  { path: '/browser-downloads/', reason: 'Browser downloads cache — large, re-downloadable', overridable: true }
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

/**
 * Run rsync from srcDir to destDir with optional flags.
 * Resolves with array of changed file lines. Rejects on non-zero exit (except 24).
 */
function runRsync(srcDir, destDir, flags = []) {
  return new Promise((resolve, reject) => {
    const args = ['--archive', '--itemize-changes', ...flags, srcDir + '/', destDir];
    const proc = spawn('/usr/bin/rsync', args, { shell: false });

    const changed = [];
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        if (line.startsWith('>') || line.startsWith('<')) {
          changed.push(line);
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      // Exit code 24 = some files vanished mid-transfer (normal for active system)
      if (code === 0 || code === 24) {
        resolve(changed);
      } else {
        reject(new Error(`rsync exited with code ${code}: ${stderr.trim()}`));
      }
    });

    proc.on('error', (err) => {
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

  await access(destPath).catch(() => {
    throw new Error(`Backup destination not found: ${destPath}`);
  });

  isRunning = true;
  const snapshotId = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
  const snapshotDir = join(destPath, 'snapshots', MACHINE_HOST, snapshotId);
  const dataDestDir = join(snapshotDir, 'data');

  const effectiveExcludes = computeEffectiveExcludes({ excludePaths, disabledDefaultExcludes });

  console.log(`💾 Backup starting: snapshot ${snapshotId} (excluding ${effectiveExcludes.length} paths)`);
  if (io) io.emit('backup:started', { snapshotId });

  await ensureDir(dataDestDir);

  let changedFiles = [];
  let manifest;

  const complete = async (result) => {
    isRunning = false;
    return result;
  };

  const fail = async (err) => {
    isRunning = false;
    await saveState({ lastRun: new Date().toISOString(), status: 'error', error: err.message, pgBackup: null });
    if (io) io.emit('backup:failed', { snapshotId, error: err.message });
    throw err;
  };

  const excludeFlags = effectiveExcludes.flatMap(p => ['--exclude', p]);
  changedFiles = await runRsync(PATHS.data, dataDestDir, excludeFlags).catch(fail);
  console.log(`💾 Backup rsync complete: ${changedFiles.length} files changed (exit 0)`);

  // Dump PostgreSQL alongside the file backup. Result is NO LONGER swallowed —
  // a configured-but-failed dump must degrade the backup and alert the user.
  const pgDumpPath = join(snapshotDir, 'portos-db.sql');
  const pgResult = await dumpPostgres(pgDumpPath);

  manifest = await generateManifest(dataDestDir, join(snapshotDir, 'manifest.json'), pgDumpPath).catch(fail);

  const status = backupStatusForPg(pgResult);
  const lastRun = new Date().toISOString();
  await saveState({
    lastRun,
    lastSnapshotId: snapshotId,
    status,
    filesChanged: changedFiles.length,
    pgBackup: pgResult,
    error: pgResult.status === 'failed' ? `DB dump ${pgResult.reason}` : null
  }).catch(fail);

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
}

/**
 * Run pg_dump to create a PostgreSQL backup alongside the rsync snapshot.
 * Returns an explicit status so the caller can distinguish the benign file
 * escape hatch from "PG required but dump failed" (data at risk):
 *   { status: 'ok', sizeBytes, tableCount }
 *   { status: 'skipped', reason: 'not_configured' }   (explicit file escape hatch only)
 *   { status: 'failed', reason: 'pg_unreachable'|'pg_dump_missing'|'version_mismatch'|'dump_error'|'empty_dump', error }
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
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', async (code) => {
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
      // pg_dump not installed — a configured-but-unbacked-up DB is at risk,
      // so this is a failure, not a silent skip.
      console.warn(`⚠️ pg_dump not available: ${err.message}`);
      resolvePromise({ status: 'failed', reason: 'pg_dump_missing', error: err.message });
    });
  });
}

/**
 * Generate a SHA-256 manifest for all files in snapshotDataDir, plus the
 * sibling pg dump (which lives outside the data/ tree). Hashing the dump means
 * a truncated/corrupt portos-db.sql is detectable, not silently trusted.
 * @param {string} snapshotDataDir - Directory to hash
 * @param {string} manifestPath - Path to write manifest.json
 * @param {string|null} [pgDumpPath=null] - Sibling SQL dump to also hash
 */
export async function generateManifest(snapshotDataDir, manifestPath, pgDumpPath = null) {
  const entries = await readdir(snapshotDataDir, { recursive: true }).catch(() => []);
  const files = {};

  for (const entry of entries) {
    const filePath = join(snapshotDataDir, entry);
    const info = await stat(filePath).catch(() => null);
    if (!info || !info.isFile()) continue;
    files[entry] = await sha256File(filePath);
  }

  if (pgDumpPath) {
    const dumpInfo = await stat(pgDumpPath).catch(() => null);
    if (dumpInfo?.isFile()) {
      // Parent-relative key: the dump lives one level ABOVE snapshotDataDir
      // (alongside it, not inside it). A future manifest-verify must not assume
      // every key resolves under snapshotDataDir.
      files['../portos-db.sql'] = await sha256File(pgDumpPath);
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
 * @returns {Array<{ id, createdAt, fileCount }>} sorted newest-first
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
      const manifestPath = join(snapshotsDir, id, 'manifest.json');
      // logError:false — a snapshot taken before manifests existed legitimately
      // has none; the null is handled below, so it isn't worth a warning per list.
      const manifest = await readJSONFile(manifestPath, null, { logError: false });
      return {
        id,
        createdAt: manifest?.generatedAt ?? null,
        fileCount: manifest?.fileCount ?? 0
      };
    })
  );

  return snapshots.sort((a, b) => {
    if (!a.createdAt) return 1;
    if (!b.createdAt) return -1;
    return b.createdAt.localeCompare(a.createdAt);
  });
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
  // Validate snapshotId to prevent path traversal
  if (!snapshotId || !/^[\w\-.:T]+$/.test(snapshotId)) {
    throw new Error(`Invalid snapshotId: ${snapshotId}`);
  }
  const snapshotsRoot = resolve(join(destPath, 'snapshots', MACHINE_HOST));
  const srcDir = join(snapshotsRoot, snapshotId, 'data');
  // Use path.relative to stay cross-platform and avoid prefix-match pitfalls
  // (e.g. /snaps vs /snaps2).
  const rel = relative(snapshotsRoot, resolve(srcDir));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path traversal detected for snapshotId: ${snapshotId}`);
  }

  // Defense-in-depth for non-route callers (the route already validates via
  // subdirFilterSchema). subdirFilter is interpolated into an rsync include arg,
  // so a `*` would override the filter chain (restoring everything) and `..`
  // would traverse out of the snapshot subdir. Reuse the same predicate the
  // schema does so the two can't drift — see issue #1822.
  if (subdirFilter != null && !isSafeSubdirFilter(subdirFilter)) {
    throw new Error(`Invalid subdirFilter: ${subdirFilter}`);
  }

  const flags = ['--itemize-changes'];
  if (dryRun) flags.push('--dry-run');
  if (subdirFilter) {
    flags.push(`--include=${subdirFilter}/***`);
    flags.push('--include=*/');
    flags.push('--exclude=*');
  }

  const changedFiles = await runRsync(srcDir, PATHS.data, flags);
  // A live restore rsyncs settings.json into place outside the save() path, so
  // getSettings()'s read-cache (and other settings:updated-driven caches) would
  // keep serving pre-restore values until the next save/restart. Re-sync them.
  if (!dryRun) await reloadSettings();
  return { dryRun, snapshotId, subdirFilter, changedFiles };
}

/**
 * Restore the PostgreSQL dump from a snapshot. Dry-run by default — mirrors
 * restoreSnapshot's safety default. A real restore pipes the snapshot's
 * portos-db.sql into psql; the dump was written with --no-owner --no-acl so
 * it replays cleanly.
 *   { status: 'ok', dryRun, sizeBytes, tableCount }   (dry-run or applied)
 *   { status: 'skipped', reason: 'no_dump' }           (no sql file in snapshot)
 *   { status: 'skipped', reason: 'not_configured' }    (real restore, PG unreachable)
 *   { status: 'failed', reason: 'restore_error', error }
 * @param {string} destPath - Backup destination root
 * @param {string} snapshotId
 * @param {{dryRun?: boolean}} [options]
 */
export async function restorePostgres(destPath, snapshotId, { dryRun = true } = {}) {
  if (!snapshotId || !/^[\w\-.:T]+$/.test(snapshotId)) {
    throw new Error(`Invalid snapshotId: ${snapshotId}`);
  }
  const snapshotsRoot = resolve(join(destPath, 'snapshots', MACHINE_HOST));
  const sqlPath = join(snapshotsRoot, snapshotId, 'portos-db.sql');
  const rel = relative(snapshotsRoot, resolve(sqlPath));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path traversal detected for snapshotId: ${snapshotId}`);
  }

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
  // proceed rather than hard-failing. Only a manifest that IS present AND
  // carries a mismatching hash refuses the restore.
  const manifestPath = join(snapshotsRoot, snapshotId, 'manifest.json');
  const manifest = await readJSONFile(manifestPath, null);
  const expectedHash = manifest?.files?.['../portos-db.sql'];
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
      '-h', pgHost, '-p', pgPort, '-U', pgUser, '-d', pgDb, '-f', sqlPath
    ], { shell: false, env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD || 'portos' } });

    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        console.log(`💾 psql restore complete from snapshot ${snapshotId}: ${tableCount} tables`);
        resolveP({ status: 'ok', dryRun: false, sizeBytes: info.size, tableCount });
      } else {
        console.warn(`⚠️ psql restore failed (code ${code}): ${stderr.trim()}`);
        resolveP({ status: 'failed', reason: 'restore_error', error: stderr.trim() });
      }
    });
    proc.on('error', (err) => {
      console.warn(`⚠️ psql not available: ${err.message}`);
      resolveP({ status: 'failed', reason: 'restore_error', error: err.message });
    });
  });
}

/**
 * Get current backup state from disk.
 */
export async function getState() {
  return readJSONFile(STATE_PATH, DEFAULT_STATE);
}

/**
 * Merge patch into current backup state and persist.
 * @param {object} patch - Fields to merge into state
 */
export async function saveState(patch) {
  await ensureDir(join(PATHS.data, 'backup'));
  const current = await getState();
  const updated = { ...current, ...patch };
  await atomicWrite(STATE_PATH, updated);
}

/**
 * Get the next scheduled backup run time from eventScheduler.
 * @returns {string|null} ISO timestamp of next run, or null
 */
export function getNextRunTime() {
  const event = getEvent('backup-daily');
  return event?.nextRunAt ? new Date(event.nextRunAt).toISOString() : null;
}
