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
import { createInterface } from 'readline';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parseEnvFile, upsertEnvKey } from './lib/envFile.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

const envFile = parseEnvFile(join(rootDir, '.env'));
// Resolve PG config from process.env first, then .env, then defaults — so a
// user who sets PGPASSWORD in .env (without exporting it into the shell) is
// respected the same way getMode() respects PGMODE in .env.
const envVar = (key, fallback) => process.env[key] ?? envFile[key] ?? fallback;
// Tolerate accidental whitespace / inline comments / non-numeric junk in
// .env values — fall back to the canonical native port (5432) on anything
// that doesn't parse to a finite integer, instead of letting NaN flow into
// `psql -p` and the success log.
const parsePgPort = (value) => {
  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(parsed) ? parsed : 5432;
};
const PG_USER = envVar('PGUSER', 'portos');
const PG_DATABASE = envVar('PGDATABASE', 'portos');
const PG_PASSWORD = envVar('PGPASSWORD', 'portos');
const PG_PORT_NATIVE = parsePgPort(envVar('PGPORT', 5432));

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

// Check if the container is already running
function isContainerRunning() {
  try {
    const output = execFileSync('docker', ['compose', 'ps', '--format', 'json', 'db'], {
      stdio: 'pipe',
      cwd: rootDir
    }).toString();
    return output.includes('"running"') || output.includes('"Running"');
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
        '-h', 'localhost',
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

// Whether the Docker container has finished applying init-db.sql. pg_isready
// only proves the server accepts connections — it can pass while the
// docker-entrypoint-initdb.d schema load is still running, so the `memories`
// table (and the rest of the required schema) may not exist yet. Probing the
// schema inside the container avoids reporting "ready" to a server that would
// then fail-fast on its own boot-time schema gate. `psql -tAc` exits 0 even on
// an empty result, so we require the literal "1".
function isDockerSchemaReady() {
  try {
    const output = execFileSync(
      'docker',
      ['compose', 'exec', '-T', 'db', 'psql', '-X', '-U', 'portos', '-d', 'portos', '-tAc',
        "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'memories' LIMIT 1"],
      { stdio: 'pipe', cwd: rootDir }
    ).toString();
    return output.trim() === '1';
  } catch {
    return false;
  }
}

// Wait for PostgreSQL to accept connections AND for the required schema to be
// in place. Both must hold before we report success, since PortOS now
// fail-fasts at boot when the schema is missing.
function waitForHealth(maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      execFileSync('docker', ['compose', 'exec', '-T', 'db', 'pg_isready', '-U', 'portos'], {
        stdio: 'pipe',
        cwd: rootDir
      });
      if (isDockerSchemaReady()) return true;
    } catch {
      // not accepting connections yet — fall through to the wait below
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

// Write PGMODE to .env (create or update)
function setPgMode(mode) {
  upsertEnvKey(join(rootDir, '.env'), 'PGMODE', mode);
}

// Prompt user to choose storage mode (TTY only)
function promptStorageChoice(message, hint) {
  // Non-interactive (stdout/stdin redirected, e.g. `npm start` under PM2): we
  // can't prompt. By the time we reach here, handleDockerUnavailable() has
  // already ruled out a healthy native PostgreSQL, so there is no usable DB and
  // no file fallback anymore — setup genuinely failed. Exit NON-ZERO so the
  // `&&`-chained `npm start` / `npm run setup` halts here instead of launching
  // a server that would immediately fail-fast and crash-loop under PM2.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(`❌ ${message}`);
    console.error(`   ${hint}`);
    console.error('   PostgreSQL is required. Start Docker (or set up native PostgreSQL) then run: npm run setup');
    process.exit(1);
  }

  return new Promise((resolve) => {
    console.log(`⚠️  ${message}`);
    console.log(`   ${hint}`);
    console.log('');
    console.log('   Choose a PostgreSQL hosting mode:');
    console.log('');
    console.log('   1) Docker PostgreSQL (recommended — containerized, no system install)');
    console.log('   2) Native PostgreSQL (use system-installed PostgreSQL on port 5432)');
    console.log('');
    // NOTE: File-based JSON storage is intentionally NOT offered here. PostgreSQL
    // is a mandatory dependency (the creative catalog has no file-backed
    // equivalent). `PGMODE=file` survives only as an advanced/unsupported dev
    // escape hatch honored when already present in .env — never a menu choice.

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question('   Enter choice [1/2]: ', (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (trimmed === '2') resolve('native');
      else resolve('exit'); // 1 or default = they want docker, so exit to install it
    });
  });
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
    execFileSync('bash', [dbScript, 'setup-native'], {
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

async function handleDockerUnavailable(message, issue) {
  // Default to native when a healthy local PortOS PostgreSQL is already
  // reachable — no need to prompt or fall back to Docker. The schema-ready
  // probe (role can auth + memories table present) is the proof that a usable
  // native PostgreSQL 17 + pgvector install is in place.
  if (isPortOSDbReady()) {
    console.log('   Healthy native PostgreSQL detected — using native mode.');
    setPgMode('native');
    console.log(`✅ PortOS database ready on port ${PG_PORT_NATIVE}`);
    process.exit(0);
  }

  const hint = getDockerHints(issue);
  const choice = await promptStorageChoice(message, hint);

  if (choice === 'native') {
    console.log('   Switching to native PostgreSQL mode...');
    setPgMode('native');
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

  // choice === 'exit' — user wants Docker, tell them to install/start it
  console.log(`   ${hint}`);
  console.log('   Install/start Docker and re-run setup');
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
  console.log('   Switch to a supported mode with: scripts/db.sh set-mode native (or docker)');
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
  await handleDockerUnavailable('Docker not found — skipping database setup', 'not_installed');
}

if (!isDockerRunning()) {
  await handleDockerUnavailable('Docker daemon not running — skipping database setup', 'not_running');
}

if (!hasCompose()) {
  await handleDockerUnavailable('docker compose not available — skipping database setup', 'not_installed');
}

if (isContainerRunning()) {
  // "running" is the container state, not DB readiness — Postgres inside it may
  // still be initializing. Now that PG is mandatory and boot fail-fasts, confirm
  // it actually accepts connections before reporting success, or `npm start`
  // proceeds into PM2 against a not-yet-ready DB and crash-loops.
  if (waitForHealth()) {
    console.log('✅ PostgreSQL already running');
    process.exit(0);
  }
  console.error('❌ PostgreSQL container is running but not accepting connections');
  console.error('   Check status: docker compose logs db');
  process.exit(1);
}

// Start the container
console.log('🐳 Starting PostgreSQL container...');
try {
  execFileSync('docker', ['compose', 'up', '-d', 'db'], {
    stdio: 'inherit',
    cwd: rootDir
  });
} catch (err) {
  console.error(`❌ Failed to start PostgreSQL container: ${err.message}`);
  console.error('   PostgreSQL is required — try native mode instead:');
  console.error('   scripts/db.sh set-mode native && npm run setup');
  process.exit(1);
}

// Wait for health
console.log('⏳ Waiting for PostgreSQL to be ready...');
if (waitForHealth()) {
  console.log('✅ PostgreSQL ready on port 5561');
} else {
  // PG is mandatory and boot fail-fasts — a started-but-unresponsive container
  // must fail setup, not warn-and-continue, so the &&-chained `npm start` halts
  // here instead of crash-looping under PM2 against an unready DB.
  console.error('❌ PostgreSQL started but never became ready');
  console.error('   Check status: docker compose logs db');
  process.exit(1);
}
