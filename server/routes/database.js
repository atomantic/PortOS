import { Router } from 'express';
import { execFile, execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { asyncHandler } from '../lib/errorHandler.js';
import { checkHealth, query } from '../lib/db.js';
import { PATHS } from '../lib/fileUtils.js';

const rootDir = PATHS.root;
const dbScript = join(rootDir, 'scripts', 'db.sh');

const router = Router();

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/**
 * Run a command and return { stdout, stderr, exitCode }.
 */
function runCmd(cmd, args, timeout = 120_000, env = process.env) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: rootDir, timeout, env }, (err, stdout, stderr) => {
      const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      if (exitCode !== 0) {
        const detail = stripAnsi(stderr || stdout || err.message || '');
        console.error(`🗄️ ${cmd} ${args.join(' ')} exited ${exitCode}:\n${detail}`);
      }
      resolve({
        stdout: stripAnsi(stdout || ''),
        stderr: stripAnsi(stderr || ''),
        exitCode
      });
    });
  });
}

const runDbScript = (args) => runCmd('bash', [dbScript, ...args]);

function parseDbMode(stdout) {
  const match = stdout.match(/Current mode:\s*(\w+)/);
  if (!match) console.warn('🗄️ Failed to parse mode from db.sh output');
  return match?.[1] || 'docker';
}

function emitProgress(io, event, message) {
  io?.emit('database:progress', { event, message });
}

/**
 * Get Docker container resource stats for portos-db.
 */
async function getDockerStats() {
  const result = await runCmd('docker', [
    'stats', 'portos-db', '--no-stream', '--format',
    '{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.BlockIO}}\t{{.PIDs}}'
  ], 10_000);
  if (result.exitCode !== 0) return null;
  const parts = result.stdout.trim().split('\t');
  if (parts.length < 6) return null;
  return {
    cpu: parts[0],
    memUsage: parts[1],
    memPercent: parts[2],
    netIO: parts[3],
    blockIO: parts[4],
    pids: parts[5]
  };
}

/**
 * Get Docker volume disk usage for portos-db data volume.
 */
async function getDockerDiskUsage() {
  // Get volume name and disk usage in parallel
  const [volResult, sizeResult] = await Promise.all([
    runCmd('docker', [
      'inspect', 'portos-db', '--format',
      '{{ range .Mounts }}{{ if eq .Destination "/var/lib/postgresql/data" }}{{ .Name }}{{ end }}{{ end }}'
    ], 5_000),
    runCmd('docker', ['system', 'df', '-v'], 10_000)
  ]);
  if (volResult.exitCode !== 0 || sizeResult.exitCode !== 0) return null;
  const volName = volResult.stdout.trim();
  if (!volName) return null;
  for (const line of sizeResult.stdout.split('\n')) {
    if (line.includes(volName)) {
      const match = line.match(/(\d+(?:\.\d+)?[KMGT]?B)/i);
      return match?.[1] || null;
    }
  }
  return null;
}

/**
 * Get native PostgreSQL process stats via ps.
 */
async function getNativeStats() {
  const result = await runCmd('bash', ['-c',
    'ps aux | grep "[p]ostgres.*-D" | head -1'
  ], 5_000);
  if (result.exitCode !== 0 || !result.stdout.trim()) return null;
  const parts = result.stdout.trim().split(/\s+/);
  // ps aux columns: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
  if (parts.length < 6) return null;
  const pid = parts[1];
  // Get all postgres child processes
  const childResult = await runCmd('bash', ['-c',
    `ps -o pid=,pcpu=,pmem=,rss= -p $(pgrep -P ${pid} | tr '\\n' ',')${pid} 2>/dev/null`
  ], 5_000);
  let totalCpu = 0, totalMem = 0, totalRss = 0, pids = 0;
  if (childResult.exitCode === 0) {
    for (const line of childResult.stdout.trim().split('\n')) {
      const cols = line.trim().split(/\s+/);
      if (cols.length >= 4) {
        totalCpu += parseFloat(cols[1]) || 0;
        totalMem += parseFloat(cols[2]) || 0;
        totalRss += parseInt(cols[3], 10) || 0;
        pids++;
      }
    }
  }
  return {
    cpu: `${totalCpu.toFixed(1)}%`,
    memUsage: `${(totalRss / 1024).toFixed(1)} MiB`,
    memPercent: `${totalMem.toFixed(1)}%`,
    pids: String(pids)
  };
}

/**
 * Get native PostgreSQL database size via SQL query.
 */
async function getNativeDiskUsage() {
  const nativePort = process.env.PGPORT || '5432';
  const result = await runCmd('psql', [
    '-h', 'localhost', '-p', nativePort, '-U', pgUser, '-d', pgDb,
    '-tAc', 'SELECT pg_size_pretty(pg_database_size(current_database()))'
  ], 5_000, pgEnv(nativePort));
  if (result.exitCode !== 0) return null;
  return result.stdout.trim() || null;
}

// GET /api/database/status — current mode, connectivity, row counts, resource stats
router.get('/status', asyncHandler(async (req, res) => {
  const [scriptResult, health, sizeResult] = await Promise.all([
    runDbScript(['status']),
    checkHealth(),
    query(`SELECT pg_database_size(current_database()) AS db_bytes,
                  (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public') AS table_count`)
      .then(r => r.rows[0])
      .catch(() => null)
  ]);

  // Parse mode from script output
  const modeMatch = scriptResult.stdout.match(/Current mode:\s*(\w+)/);
  const mode = modeMatch?.[1] || 'unknown';

  // Parse Docker status
  const dockerRunning = /Container portos-db is running/.test(scriptResult.stdout);
  const dockerInstalled = !/Docker not installed/.test(scriptResult.stdout);
  const dockerDaemon = !/Docker daemon is not running/.test(scriptResult.stdout);

  // Parse native status
  const nativeInstalled = !/Native PostgreSQL not installed/.test(scriptResult.stdout);
  const nativeRunning = /System PostgreSQL is running/.test(scriptResult.stdout);
  const nativeConfigured = nativeInstalled && /PortOS database exists/.test(scriptResult.stdout);

  // Parse row count
  const rowMatch = scriptResult.stdout.match(/Memories table has (\d+|N\/A) rows/);
  const memoryCount = rowMatch?.[1] === 'N/A' ? null : parseInt(rowMatch?.[1] || '0', 10);
  const connected = /Database is accepting connections/.test(scriptResult.stdout);

  // Fetch resource stats for running backends (in parallel)
  const [dockerStats, dockerDisk, nativeStats, nativeDisk] = await Promise.all([
    dockerRunning ? getDockerStats() : Promise.resolve(null),
    dockerRunning ? getDockerDiskUsage() : Promise.resolve(null),
    nativeRunning ? getNativeStats() : Promise.resolve(null),
    nativeConfigured ? getNativeDiskUsage() : Promise.resolve(null)
  ]);

  res.json({
    mode,
    connected,
    memoryCount,
    dbBytes: sizeResult ? parseInt(sizeResult.db_bytes, 10) : null,
    tableCount: sizeResult ? parseInt(sizeResult.table_count, 10) : null,
    health,
    docker: {
      installed: dockerInstalled,
      daemonRunning: dockerDaemon,
      containerRunning: dockerRunning,
      stats: dockerStats,
      diskUsage: dockerDisk
    },
    native: {
      installed: nativeInstalled,
      configured: nativeConfigured,
      running: nativeRunning,
      stats: nativeStats,
      diskUsage: nativeDisk
    }
  });
}));

// POST /api/database/switch — switch mode and optionally migrate
router.post('/switch', asyncHandler(async (req, res) => {
  const { target, migrate } = req.body;
  if (!target || !['docker', 'native'].includes(target)) {
    return res.status(400).json({ error: 'target must be "docker" or "native"' });
  }

  const io = req.app.get('io');
  const emit = (event, data) => io?.emit('database:progress', { event, ...data });

  if (migrate) {
    emit('start', { message: `Migrating data to ${target}...` });
    const result = await runDbScript(['migrate']);
    if (result.exitCode !== 0) {
      emit('error', { message: 'Migration failed' });
      return res.status(500).json({
        error: 'Migration failed',
        details: result.stderr || result.stdout
      });
    }
    emit('complete', { message: `Migration to ${target} complete` });
    return res.json({ success: true, output: result.stdout });
  }

  // Just switch mode without migrating
  emit('start', { message: `Switching to ${target}...` });
  const switchResult = await runDbScript([target === 'docker' ? 'use-docker' : 'use-native']);
  if (switchResult.exitCode !== 0) {
    emit('error', { message: 'Switch failed' });
    return res.status(500).json({
      error: 'Switch failed',
      details: switchResult.stderr || switchResult.stdout
    });
  }

  const startResult = await runDbScript(['start']);
  if (startResult.exitCode !== 0) {
    emit('error', { message: `Failed to start ${target} database` });
    return res.status(500).json({
      error: `Failed to start ${target} database`,
      details: startResult.stderr || startResult.stdout
    });
  }

  emit('complete', { message: `Switched to ${target}` });
  res.json({ success: true, output: switchResult.stdout + '\n' + startResult.stdout });
}));

const pgUser = process.env.PGUSER || 'portos';
const pgDb = process.env.PGDATABASE || 'portos';
const pgPassword = process.env.PGPASSWORD || 'portos';

// Native (5432) and Docker (5561) use different ports, so both can run simultaneously.
const NATIVE_PORT = '5432';
const DOCKER_PORT = '5561';

// Prefer Homebrew postgresql@17 binaries over system pg (avoids version mismatch)
// Check both arm64 (/opt/homebrew) and Intel (/usr/local) prefixes
const pg17Bin = (() => {
  for (const prefix of ['/opt/homebrew/opt/postgresql@17', '/usr/local/opt/postgresql@17']) {
    const bin = `${prefix}/bin`;
    if (existsSync(`${bin}/psql`)) return bin;
  }
  return null;
})();

/**
 * Build env object with PGPASSWORD for passing to child processes.
 * Avoids interpolating password into shell strings (shell metacharacter safety).
 */
const pgEnv = (port) => ({
  ...process.env,
  ...(pg17Bin ? { PATH: `${pg17Bin}:${process.env.PATH}` } : {}),
  PGPASSWORD: pgPassword,
  PGHOST: 'localhost',
  PGPORT: String(port),
  PGUSER: pgUser,
  PGDATABASE: pgDb
});

// POST /api/database/sync — copy data from active to non-active backend
// Since native (5432) and Docker (5561) use different ports, both can be
// running simultaneously. No need to stop the active backend.
router.post('/sync', asyncHandler(async (req, res) => {
  const io = req.app.get('io');
  const emit = (event, data) => io?.emit('database:progress', { event, ...data });

  const statusResult = await runDbScript(['status']);
  const currentMode = parseDbMode(statusResult.stdout);
  const targetMode = currentMode === 'docker' ? 'native' : 'docker';
  const targetPort = targetMode === 'docker' ? DOCKER_PORT : NATIVE_PORT;

  // Step 1: Export from active database (stays running)
  emit('start', { message: 'Exporting from active database...' });
  const exportResult = await runDbScript(['export', `sync-${Date.now()}`]);
  if (exportResult.exitCode !== 0) {
    emit('error', { message: 'Export failed' });
    return res.status(500).json({ error: 'Export failed', details: exportResult.stderr || exportResult.stdout });
  }
  const exportLines = exportResult.stdout.trim().split('\n');
  const dumpFile = exportLines[exportLines.length - 1]?.trim();
  console.log(`🗄️ Sync: exported to ${dumpFile}`);

  // Step 2: Ensure target is running and configured
  emit('start', { message: `Checking ${targetMode} is running...` });
  const readyResult = await runCmd('pg_isready', [
    '-h', 'localhost', '-p', targetPort
  ], 5_000, pgEnv(targetPort));
  if (readyResult.exitCode !== 0) {
    emit('error', { message: `${targetMode} database not running on port ${targetPort}. Start it first.` });
    return res.status(400).json({ error: `${targetMode} database not running on port ${targetPort}. Start it first.` });
  }

  // Ensure target has the portos role and database (native pg may lack the role)
  if (targetMode === 'native') {
    emit('start', { message: 'Ensuring native database role and schema exist...' });
    const sysUser = process.env.USER || 'postgres';
    const sysEnv = pgEnv(targetPort);
    // Create role if missing (connect as system superuser)
    await runCmd('psql', ['-h', 'localhost', '-p', targetPort, '-U', sysUser, '-d', 'postgres',
      '-c', `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${pgUser}') THEN CREATE ROLE ${pgUser} WITH LOGIN PASSWORD '${pgPassword}' CREATEDB SUPERUSER; END IF; END $$;`
    ], 10_000, sysEnv);
    // Create database if missing
    const dbCheck = await runCmd('psql', ['-h', 'localhost', '-p', targetPort, '-U', sysUser, '-d', 'postgres',
      '-tAc', `SELECT 1 FROM pg_database WHERE datname='${pgDb}'`
    ], 5_000, sysEnv);
    if (!dbCheck.stdout.trim().includes('1')) {
      await runCmd('psql', ['-h', 'localhost', '-p', targetPort, '-U', sysUser, '-d', 'postgres',
        '-c', `CREATE DATABASE ${pgDb} OWNER ${pgUser};`
      ], 10_000, sysEnv);
    }
    // Best-effort extensions (non-fatal — dump may handle schema, and pgvector may not be installed)
    await runCmd('psql', ['-h', 'localhost', '-p', targetPort, '-U', sysUser, '-d', pgDb,
      '-c', 'CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto;'
    ], 10_000, sysEnv);
  }

  // Step 3: Import into target (active backend untouched — different port)
  // Strip pg17-only features for compat with older psql: \restrict/\unrestrict, transaction_timeout
  emit('start', { message: `Importing into ${targetMode} (port ${targetPort})...` });
  const importResult = await runCmd('bash', ['-c',
    `sed -e '/^\\\\restrict /d' -e '/^\\\\unrestrict /d' -e '/^SET transaction_timeout/d' "${dumpFile}" | psql -h localhost -p ${targetPort} -U ${pgUser} -d ${pgDb} -v ON_ERROR_STOP=1 --single-transaction`
  ], 120_000, pgEnv(targetPort));

  if (importResult.exitCode !== 0) {
    emit('error', { message: `Import into ${targetMode} failed` });
    return res.status(500).json({ error: `Import into ${targetMode} failed`, details: importResult.stderr || importResult.stdout });
  }

  emit('complete', { message: `Data synced to ${targetMode}` });
  res.json({ success: true, dumpFile });
}));

// POST /api/database/start — start a specific backend
router.post('/start', asyncHandler(async (req, res) => {
  const { backend } = req.body;
  if (!backend || !['docker', 'native'].includes(backend)) {
    return res.status(400).json({ error: 'backend must be "docker" or "native"' });
  }

  if (backend === 'docker') {
    const result = await runCmd('docker', ['compose', 'up', '-d', 'db'], 60_000);
    return res.json({ success: result.exitCode === 0, output: result.stdout });
  }

  // Native: use db.sh which handles brew services / pg_ctl
  const result = await runCmd('bash', [dbScript, 'start'], 30_000);
  res.json({ success: result.exitCode === 0, output: result.stdout });
}));

// POST /api/database/stop — stop the non-active backend
router.post('/stop', asyncHandler(async (req, res) => {
  const { backend } = req.body;
  if (!backend || !['docker', 'native'].includes(backend)) {
    return res.status(400).json({ error: 'backend must be "docker" or "native"' });
  }

  if (backend === 'docker') {
    const result = await runCmd('docker', ['compose', 'stop', 'db'], 30_000);
    return res.json({ success: result.exitCode === 0, output: result.stdout });
  }

  // Native stop
  const result = await runCmd('bash', [dbScript, 'stop'], 15_000);
  res.json({ success: result.exitCode === 0, output: result.stdout });
}));

// POST /api/database/destroy — destroy the non-active backend's data
router.post('/destroy', asyncHandler(async (req, res) => {
  const { backend } = req.body;
  if (!backend || !['docker', 'native'].includes(backend)) {
    return res.status(400).json({ error: 'backend must be "docker" or "native"' });
  }

  // Safety: don't destroy the active backend
  const statusResult = await runDbScript(['status']);
  const currentMode = parseDbMode(statusResult.stdout);
  if (backend === currentMode) {
    return res.status(400).json({ error: 'Cannot destroy the active backend. Switch to the other backend first.' });
  }

  if (backend === 'docker') {
    // Stop and remove container + volume
    await runCmd('docker', ['compose', 'stop', 'db'], 15_000);
    await runCmd('docker', ['compose', 'rm', '-f', 'db'], 15_000);
    const result = await runCmd('docker', ['volume', 'rm', '-f', 'portos_portos-pgdata'], 15_000);
    // Also try alternate volume name
    await runCmd('docker', ['volume', 'rm', '-f', 'portos-pgdata'], 15_000);
    return res.json({ success: true, output: result.stdout });
  }

  // Native: drop the portos database (system pg stays running)
  const sysUser = process.env.USER || 'portos';
  const nativePort = process.env.PGPORT || '5432';
  const result = await runCmd('psql', [
    '-h', 'localhost', '-p', nativePort, '-U', sysUser, '-d', 'postgres',
    '-c', `DROP DATABASE IF EXISTS ${pgDb}`
  ], 15_000);
  res.json({ success: result.exitCode === 0, output: result.stdout });
}));

// POST /api/database/setup-native — install and configure native PostgreSQL
router.post('/setup-native', asyncHandler(async (req, res) => {
  const io = req.app.get('io');
  emitProgress(io, 'start', 'Setting up native PostgreSQL...');

  const result = await runDbScript(['setup-native']);
  if (result.exitCode !== 0) {
    emitProgress(io, 'error', 'Native setup failed');
    return res.status(500).json({
      error: 'Native PostgreSQL setup failed',
      details: result.stderr || result.stdout
    });
  }

  emitProgress(io, 'complete', 'Native PostgreSQL ready');
  res.json({ success: true, output: result.stdout });
}));

// POST /api/database/export — export database to SQL dump
// Optional body.backend: 'docker' | 'native' to export from a specific backend
// Default: exports from the active backend
router.post('/export', asyncHandler(async (req, res) => {
  const { backend } = req.body || {};
  const label = `backup-${Date.now()}`;

  if (backend && ['docker', 'native'].includes(backend)) {
    // Export from a specific backend by connecting directly to its port
    const port = backend === 'docker' ? DOCKER_PORT : NATIVE_PORT;
    const env = pgEnv(port);
    const readyResult = await runCmd('pg_isready', [
      '-h', 'localhost', '-p', port, '-U', pgUser
    ], 5_000, env);
    if (readyResult.exitCode !== 0) {
      return res.status(400).json({ error: `${backend} database not running on port ${port}` });
    }
    const dumpDir = join(rootDir, 'data', 'db-dumps');
    await runCmd('mkdir', ['-p', dumpDir], 5_000);
    const dumpFile = join(dumpDir, `portos-${backend}-${label}.sql`);
    const result = await runCmd('bash', ['-c',
      `pg_dump -h localhost -p ${port} -U ${pgUser} -d ${pgDb} --no-owner --no-privileges --if-exists --clean > "${dumpFile}"`
    ], 120_000, env);
    if (result.exitCode !== 0) {
      return res.status(500).json({ error: 'Export failed', details: result.stderr || result.stdout });
    }
    return res.json({ success: true, dumpFile });
  }

  // Default: export from active backend via db.sh
  const result = await runDbScript(['export']);
  if (result.exitCode !== 0) {
    return res.status(500).json({
      error: 'Export failed',
      details: result.stderr || result.stdout
    });
  }
  const dumpLines = result.stdout.trim().split('\n');
  const dumpFile = dumpLines[dumpLines.length - 1]?.trim();
  res.json({ success: true, dumpFile, output: result.stdout });
}));

// POST /api/database/fix — fix stale pid files
router.post('/fix', asyncHandler(async (req, res) => {
  const result = await runDbScript(['fix']);
  res.json({
    success: result.exitCode === 0,
    output: result.stdout,
    error: result.exitCode !== 0 ? (result.stderr || result.stdout) : undefined
  });
}));

export default router;
