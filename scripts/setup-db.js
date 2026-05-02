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
import { readFileSync, writeFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

// Parse .env into a key/value map. Tolerates blank lines, # comments, and
// optional surrounding single/double quotes around values. Returns {} when
// the file is missing.
function parseEnvFile() {
  const result = {};
  let content = '';
  try { content = readFileSync(join(rootDir, '.env'), 'utf8'); } catch { return result; }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

const envFile = parseEnvFile();
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

// Wait for PostgreSQL to accept connections
function waitForHealth(maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      execFileSync('docker', ['compose', 'exec', '-T', 'db', 'pg_isready', '-U', 'portos'], {
        stdio: 'pipe',
        cwd: rootDir
      });
      return true;
    } catch {
      if (i < maxAttempts - 1) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
      }
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
  const envPath = join(rootDir, '.env');
  let content = '';
  try {
    content = readFileSync(envPath, 'utf8');
  } catch { /* no .env yet */ }

  if (content.match(/^PGMODE=/m)) {
    content = content.replace(/^PGMODE=.*/m, `PGMODE=${mode}`);
  } else {
    content = `PGMODE=${mode}\n${content}`;
  }
  writeFileSync(envPath, content);
}

// Prompt user to choose storage mode (TTY only)
function promptStorageChoice(message, hint) {
  // Stdout redirected means we can't show the prompt — warn and exit 0 without changing mode.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(`⚠️  ${message}`);
    console.error(`   ${hint}`);
    console.error('   Start Docker then run: npm run setup');
    process.exit(0);
  }

  return new Promise((resolve) => {
    console.log(`⚠️  ${message}`);
    console.log(`   ${hint}`);
    console.log('');
    console.log('   Choose a storage backend:');
    console.log('');
    console.log('   1) Docker PostgreSQL (recommended — containerized, no system install)');
    console.log('   2) Native PostgreSQL (use system-installed PostgreSQL on port 5432)');
    console.log('   3) File-based JSON storage (deprecated — no vector search)');
    console.log('');

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question('   Enter choice [1/2/3]: ', (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (trimmed === '2') resolve('native');
      else if (trimmed === '3') resolve('file');
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

  if (choice === 'file') {
    setPgMode('file');
    console.log('   Memory system will use file-based JSON storage (deprecated)');
    process.exit(0);
  }

  // choice === 'exit' — user wants Docker, tell them to install/start it
  console.log(`   ${hint}`);
  console.log('   Install/start Docker and re-run setup');
  process.exit(1);
}

const mode = getMode();

if (mode === 'file') {
  console.log('🗄️  Storage mode: file-based JSON (deprecated)');
  console.log('   Tip: switch to PostgreSQL with: scripts/db.sh set-mode docker');
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
  console.log('✅ PostgreSQL already running');
  process.exit(0);
}

// Start the container
console.log('🐳 Starting PostgreSQL container...');
try {
  execFileSync('docker', ['compose', 'up', '-d', 'db'], {
    stdio: 'inherit',
    cwd: rootDir
  });
} catch (err) {
  console.error(`⚠️  Failed to start PostgreSQL: ${err.message}`);
  console.log('   Memory system will use file-based JSON storage');
  process.exit(0);
}

// Wait for health
console.log('⏳ Waiting for PostgreSQL to be ready...');
if (waitForHealth()) {
  console.log('✅ PostgreSQL ready on port 5561');
} else {
  console.warn('⚠️  PostgreSQL started but not responding yet — it may still be initializing');
  console.log('   Check status: docker compose logs db');
}
