/**
 * Backup Service
 *
 * Rsync-based incremental backup from ./data/ to an external drive.
 * Generates SHA-256 manifests for integrity verification.
 * Integrates with eventScheduler for daily cron scheduling.
 */

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { access, readFile, readdir, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { PATHS, ensureDir, readJSONFile } from '../lib/fileUtils.js';
import { getEvent } from './eventScheduler.js';
import { checkHealth } from '../lib/db.js';

// Module-level state
let isRunning = false;

const STATE_PATH = join(PATHS.data, 'backup', 'state.json');
const DEFAULT_STATE = {
  lastRun: null,
  status: 'never',
  lastSnapshotId: null,
  filesChanged: 0,
  error: null
};

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
 * Run a full backup snapshot from PATHS.data to destPath.
 * @param {string} destPath - Path to external drive backup root
 * @param {object|null} io - Socket.IO instance for real-time events (optional)
 */
export async function runBackup(destPath, io = null, { excludePaths = [] } = {}) {
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
  const snapshotDir = join(destPath, 'snapshots', snapshotId);
  const dataDestDir = join(snapshotDir, 'data');

  console.log(`💾 Backup starting: snapshot ${snapshotId}${excludePaths.length ? ` (excluding ${excludePaths.length} paths)` : ''}`);
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
    await saveState({ lastRun: new Date().toISOString(), status: 'error', error: err.message });
    throw err;
  };

  const excludeFlags = excludePaths.filter(Boolean).flatMap(p => ['--exclude', p]);
  changedFiles = await runRsync(PATHS.data, dataDestDir, excludeFlags).catch(fail);
  console.log(`💾 Backup rsync complete: ${changedFiles.length} files changed (exit 0)`);

  // Dump PostgreSQL alongside the file backup
  const pgDumpPath = join(snapshotDir, 'portos-db.sql');
  const pgResult = await dumpPostgres(pgDumpPath).catch(() => ({ success: false }));

  manifest = await generateManifest(dataDestDir, join(snapshotDir, 'manifest.json')).catch(fail);

  const lastRun = new Date().toISOString();
  await saveState({
    lastRun,
    lastSnapshotId: snapshotId,
    status: 'ok',
    filesChanged: changedFiles.length,
    error: null
  }).catch(fail);

  if (io) io.emit('backup:completed', { snapshotId, filesChanged: changedFiles.length });

  return complete({ snapshotId, filesChanged: changedFiles.length, lastRun, manifest, pgDump: pgResult });
}

/**
 * Run pg_dump to create a PostgreSQL backup alongside the rsync snapshot.
 * Silently skips if PostgreSQL is not available.
 * @param {string} outputPath - Path to write the SQL dump file
 * @returns {Promise<{success: boolean, size?: number, error?: string}>}
 */
export async function dumpPostgres(outputPath) {
  const health = await checkHealth();
  if (!health.connected || !health.hasSchema) {
    return { success: false, error: 'PostgreSQL not available' };
  }

  const pgHost = process.env.PGHOST || 'localhost';
  const pgPort = process.env.PGPORT || '5561';
  const pgDb = process.env.PGDATABASE || 'portos';
  const pgUser = process.env.PGUSER || 'portos';

  return new Promise((resolve) => {
    const proc = spawn('pg_dump', [
      '-h', pgHost,
      '-p', pgPort,
      '-U', pgUser,
      '-d', pgDb,
      '--no-owner',
      '--no-acl',
      '-f', outputPath
    ], {
      shell: false,
      env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD || 'portos' }
    });

    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', async (code) => {
      if (code === 0) {
        const info = await stat(outputPath).catch(() => null);
        console.log(`💾 pg_dump complete: ${info ? Math.round(info.size / 1024) + 'KB' : 'unknown size'}`);
        resolve({ success: true, size: info?.size ?? 0 });
      } else {
        console.warn(`⚠️ pg_dump failed (code ${code}): ${stderr.trim()}`);
        resolve({ success: false, error: stderr.trim() });
      }
    });

    proc.on('error', (err) => {
      // pg_dump not installed — skip silently
      console.warn(`⚠️ pg_dump not available: ${err.message}`);
      resolve({ success: false, error: err.message });
    });
  });
}

/**
 * Generate a SHA-256 manifest for all files in snapshotDataDir.
 * @param {string} snapshotDataDir - Directory to hash
 * @param {string} manifestPath - Path to write manifest.json
 */
export async function generateManifest(snapshotDataDir, manifestPath) {
  const entries = await readdir(snapshotDataDir, { recursive: true }).catch(() => []);
  const files = {};

  for (const entry of entries) {
    const filePath = join(snapshotDataDir, entry);
    const info = await stat(filePath).catch(() => null);
    if (!info || !info.isFile()) continue;

    const relativePath = entry;
    let hash;

    if (info.size < 512 * 1024) {
      // Small file: read all at once
      const content = await readFile(filePath);
      hash = createHash('sha256').update(content).digest('hex');
    } else {
      // Large file: streaming hash
      hash = await new Promise((resolve, reject) => {
        const stream = createReadStream(filePath);
        const hasher = createHash('sha256');
        stream.pipe(hasher);
        stream.on('error', reject);
        hasher.on('finish', () => resolve(hasher.digest('hex')));
        hasher.on('error', reject);
      });
    }

    files[relativePath] = hash;
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    fileCount: Object.keys(files).length,
    files
  };

  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
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

  const snapshotsDir = join(destPath, 'snapshots');
  const entries = await readdir(snapshotsDir).catch(() => []);

  const snapshots = await Promise.all(
    entries.map(async (id) => {
      const manifestPath = join(snapshotsDir, id, 'manifest.json');
      const manifest = await readJSONFile(manifestPath, null);
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
  const srcDir = join(destPath, 'snapshots', snapshotId, 'data');

  const flags = ['--itemize-changes'];
  if (dryRun) flags.push('--dry-run');
  if (subdirFilter) {
    flags.push(`--include=${subdirFilter}/***`);
    flags.push('--include=*/');
    flags.push('--exclude=*');
  }

  const changedFiles = await runRsync(srcDir, PATHS.data, flags);
  return { dryRun, snapshotId, subdirFilter, changedFiles };
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
  await writeFile(STATE_PATH, JSON.stringify(updated, null, 2), 'utf-8');
}

/**
 * Get the next scheduled backup run time from eventScheduler.
 * @returns {string|null} ISO timestamp of next run, or null
 */
export function getNextRunTime() {
  const event = getEvent('backup-daily');
  return event?.nextRunAt ? new Date(event.nextRunAt).toISOString() : null;
}
