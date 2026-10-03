#!/usr/bin/env node

/**
 * Database Setup Script
 *
 * Ensures PostgreSQL is available — either via Docker Compose (docker mode)
 * or the system PostgreSQL (native mode).
 *
 * Called by: npm run setup, npm run update, npm start, npm run dev
 */

import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parseEnvFile } from './lib/envFile.js';
import { parseDockerPort, parseNativePort } from './lib/setupDbChoice.js';
import { resolveBashBinary } from '../server/lib/bashResolver.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

const envFile = parseEnvFile(join(rootDir, '.env'));
// Resolve PG config from process.env first, then .env, then defaults — so a
// user who sets PGPASSWORD in .env (without exporting it into the shell) is
// respected the same way getMode() respects PGMODE in .env.
const envVar = (key, fallback) => process.env[key] ?? envFile[key] ?? fallback;
const PG_USER = envVar('PGUSER', 'portos');
const PG_DATABASE = envVar('PGDATABASE', 'portos');
const PG_PASSWORD = envVar('PGPASSWORD', 'portos');
// Same env > .env > default rule as PM2 (ecosystem.config.cjs), so a PGHOST set
// only in .env reaches both db.sh and the readiness probes.
const PG_HOST = envVar('PGHOST', 'localhost');
// A managed parent exports PGPORT for its active pool (possibly Docker), and
// preserves the native identity separately. Ordinary shells keep legacy PGPORT.
const PG_PORT_NATIVE = parseNativePort(process.env.PORTOS_NATIVE_PGPORT || envVar('PGPORT', 5432));
// Docker host-port mapping (docker-compose.yml maps `${PGPORT_DOCKER:-5561}:5432`).
// Resolve it the same tolerant way so the "ready on port N" log can't lie when a
// user overrides PGPORT_DOCKER — a misleading success port is exactly the kind of
// "looks fine but points at the wrong place" footgun this script exists to avoid.
const PG_PORT_DOCKER = parseDockerPort(envVar('PGPORT_DOCKER', 5561));

// Environment to pass to `db.sh` and other psql-wrapping subprocesses, so
// values configured in .env (but not exported into the shell) reach the
// child process. Without this, db.sh setup-native would provision the
// default `portos`/`portos` while isPortOSDbReady() probes with the
// customized creds — leaving setup looping forever.
const PG_CHILD_ENV = {
  ...process.env,
  PGUSER: PG_USER,
  PGDATABASE: PG_DATABASE,
  PGPASSWORD: PG_PASSWORD,
  PGHOST: PG_HOST,
  PGPORT: String(PG_PORT_NATIVE)
};

function getMode() {
  return envVar('PGMODE', 'docker');
}

// Check if Docker is available
function hasDocker() {
  try {
    execFileSync('docker', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Check if Docker daemon is running
function isDockerRunning() {
  try {
    execFileSync('docker', ['info'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Check if docker compose is available (v2 plugin)
function hasCompose() {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Domain-level readiness check: the configured PG_USER role can authenticate
// to PG_DATABASE AND the `memories` table from init-db.sql exists in the
// public schema. This is what `db.sh setup-native` produces. The probe
// itself is a single cheap psql round-trip; passing it lets us skip the
// full setup-native path (brew checks, ALTER USER, schema reapply) on
// every `npm start`/`npm run dev`, which would otherwise reset the role's
// password+SUPERUSER privileges on every invocation.
//
// `psql -tAc` exits 0 even when the SELECT returns no rows, so we capture
// stdout and require the literal "1" — without this, an empty result (db
// exists but schema not yet applied) would falsely report "ready" and the
// app would boot against an unmigrated database. `-X` skips the user's
// .psqlrc so a custom prompt or echo setting can't pollute stdout.
function isPortOSDbReady(port = PG_PORT_NATIVE) {
  try {
    const output = execFileSync(
      'psql',
      [
        '-X',
        '-h', PG_HOST,
        '-p', String(port),
        '-U', PG_USER,
        '-d', PG_DATABASE,
        '-tAc',
        "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'memories' LIMIT 1"
      ],
      { stdio: 'pipe', env: PG_CHILD_ENV }
    ).toString();
    return output.trim() === '1';
  } catch {
    return false;
  }
}

// Whether the Docker container's base schema exists. We probe `memories` (the
// first, always-present base table) — NOT a newest fresh-install table: an
// install whose volume was initialized before a later table (e.g.
// writers_room_exercises, #1017) existed is a valid UPGRADEABLE install, and
// `npm start` runs this BEFORE the server's idempotent boot-time ensureSchema()
// that adds the missing tables. Requiring the newest table here would wedge
// every pre-existing Docker install (the probe would never go true). The
// half-applied-init race that motivated checking the schema at all is handled
// by the TCP readiness gate in waitForHealth() below — the postgres image runs
// docker-entrypoint-initdb.d against a SOCKET-ONLY temp server and only opens
// the TCP listener after init finishes, so a TCP probe is false mid-init.
// `psql -tAc` exits 0 even on an empty result, so we require the literal "1".
function isDockerSchemaReady() {
  try {
    const output = execFileSync(
      'docker',
      ['compose', 'exec', '-T', 'db', 'psql', '-X', '-U', PG_USER, '-d', PG_DATABASE, '-tAc',
        "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'memories' LIMIT 1"],
      { stdio: 'pipe', cwd: rootDir }
    ).toString();
    return output.trim() === '1';
  } catch {
    return false;
  }
}

// Wait for PostgreSQL to accept TCP connections AND for the base schema to be
// in place. Both must hold before we report success, since PortOS now
// fail-fasts at boot when the schema is missing. pg_isready is forced over TCP
// (-h 127.0.0.1): during first-time init the entrypoint runs the schema load
// against a socket-only temp server (listen_addresses=''), so a default
// socket-based pg_isready would pass mid-init and let `npm start` race a
// half-applied schema. The TCP listener opens only after init completes, so a
// TCP probe cleanly distinguishes mid-init from done — for both fresh and
// upgraded volumes (an upgraded volume skips init entirely and is TCP-ready at
// once, then ensureSchema() backfills any newer tables at boot).
function waitForHealth(maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      execFileSync('docker', ['compose', 'exec', '-T', 'db', 'pg_isready', '-h', '127.0.0.1', '-U', PG_USER], {
        stdio: 'pipe',
        cwd: rootDir
      });
      if (isDockerSchemaReady()) return true;
    } catch {
      // not accepting TCP connections yet (mid-init or starting) — wait below
    }
    if (i < maxAttempts - 1) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }
  return false;
}

// Platform-specific Docker install/start hints
function getDockerHints(issue) {
  const platform = process.platform;
  const hints = { install: '', start: '' };

  if (platform === 'darwin') {
    hints.install = 'Install Docker Desktop: https://www.docker.com/products/docker-desktop/';
    hints.start = 'Open Docker Desktop or run: open -a Docker';
  } else if (platform === 'win32') {
    hints.install = 'Install Docker Desktop: https://www.docker.com/products/docker-desktop/';
    hints.start = 'Start Docker Desktop from the Start menu';
  } else {
    hints.install = 'Install Docker Engine: https://docs.docker.com/engine/install/';
    hints.start = 'Start Docker: sudo systemctl start docker';
  }

  return issue === 'not_installed' ? hints.install : hints.start;
}

// Attempt full native PostgreSQL setup via db.sh setup-native. Idempotent:
// db.sh setup-native re-checks each step (brew install, role, db, extensions,
// schema). Verifies success at the *domain* level — the role can auth and the
// schema is in place — not just that the port is listening, since the whole
// point of this PR is that port-listening isn't proof of usable PortOS state.
function setupNativePostgres() {
  const dbScript = join(rootDir, 'scripts', 'db.sh');
  try {
    console.log('🍺 Running native PostgreSQL setup...');
    // Pass resolved PG_* settings via env so db.sh provisions the same
    // role/db/port that isPortOSDbReady() probes. db.sh itself doesn't
    // source .env — without this, customized creds in .env would mismatch.
    execFileSync(resolveBashBinary(), [dbScript, 'setup-native'], {
      stdio: 'inherit',
      cwd: rootDir,
      env: PG_CHILD_ENV
    });
    if (isPortOSDbReady()) {
      console.log(`✅ PortOS database ready on port ${PG_PORT_NATIVE}`);
      return true;
    }
  } catch (err) {
    console.error(`⚠️  Native setup error: ${err.message}`);
  }
  return false;
}

// Exit with error when native PostgreSQL setup fails
function exitNativeSetupFailed() {
  if (process.platform === 'darwin') {
    console.error('❌ Native PostgreSQL setup failed — try manually: brew install postgresql@17 && brew services start postgresql@17');
  } else {
    console.error('❌ Native PostgreSQL setup failed — install and start PostgreSQL');
  }
  console.log('   Then re-run: npm run setup');
  process.exit(1);
}

function handleDockerUnavailable(message, issue) {
  console.error(`❌ ${message}`);
  console.error(`   ${getDockerHints(issue)}`);
  console.error('   Restore Docker and re-run: npm run setup:db');
  console.error('   Keeping the selected database unchanged. Setup never switches backends.');
  console.error('   For a fresh native install, select PGMODE=native in .env before setup.');
  console.error('   Existing installs require coordinated maintenance cutover; see docs/STORAGE.md.');
  process.exit(1);
}

const mode = getMode();

if (mode === 'file') {
  // Advanced/unsupported escape hatch: PGMODE=file is honored ONLY when a user
  // has explicitly set it in .env. It is not a normal setup choice — PostgreSQL
  // is a mandatory dependency for production installs and the creative catalog
  // has no file-backed equivalent. Kept for development/tests.
  console.error('🚫 PGMODE=file is UNSUPPORTED for production — PostgreSQL is required.');
  console.error('   File-based storage has no creative-catalog or vector-search support.');
  console.log('   For a fresh/development install, set PGMODE=native or PGMODE=docker in the');
  console.log('   repository-root .env, preserving other settings. Unset a conflicting exported');
  console.log('   PGMODE, then re-run: npm run setup:db');
  console.log('   Existing PostgreSQL installs must retain the backend holding their records;');
  console.log('   an intentional move requires coordinated maintenance cutover.');
  console.log('   See docs/STORAGE.md#setup-path-npm-run-setupdb.');
  process.exit(0);
}

console.log(`🗄️  Setting up PostgreSQL (mode: ${mode})...`);

if (mode === 'native') {
  // Fast path: portos role can already authenticate to portos db and the
  // schema is in place. Skip setup-native to avoid re-ALTERing credentials
  // and the brew/psql startup-time hit on every `npm start`.
  if (isPortOSDbReady()) {
    console.log(`✅ PortOS database ready on port ${PG_PORT_NATIVE}`);
    process.exit(0);
  }
  // Otherwise (fresh checkout, missing role, missing schema, wrong password)
  // run the full bootstrap.
  if (setupNativePostgres()) {
    process.exit(0);
  }

  exitNativeSetupFailed();
}

// Docker mode
if (!hasDocker()) {
  handleDockerUnavailable('Docker not found — database setup failed', 'not_installed');
}

if (!isDockerRunning()) {
  handleDockerUnavailable('Docker daemon not running — database setup failed', 'not_running');
}

if (!hasCompose()) {
  handleDockerUnavailable('docker compose not available — database setup failed', 'not_installed');
}

// Compose reconciles changed bindings/ports for existing containers while
// preserving the named data volume, and reuses unchanged running containers.
// Readiness inside a container cannot prove its host publication is current.
console.log('🐳 Reconciling PostgreSQL container configuration...');
try {
  execFileSync('docker', ['compose', 'up', '-d', 'db'], {
    stdio: 'inherit',
    cwd: rootDir
  });
} catch (err) {
  console.error(`❌ Failed to reconcile PostgreSQL container: ${err.message}`);
  console.error('   Keep the selected backend; check Docker and run: docker compose logs db');
  process.exit(1);
}

// Wait for health
console.log('⏳ Waiting for PostgreSQL to be ready...');
if (waitForHealth()) {
  console.log(`✅ PostgreSQL ready on port ${PG_PORT_DOCKER}`);
} else {
  // PG is mandatory and boot fail-fasts — a started-but-unresponsive container
  // must fail setup, not warn-and-continue, so the &&-chained `npm start` halts
  // here instead of crash-looping under PM2 against an unready DB.
  console.error('❌ PostgreSQL started but never became ready');
  console.error('   Check status: docker compose logs db');
  process.exit(1);
}
