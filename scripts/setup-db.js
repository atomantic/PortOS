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

// Read PGMODE from .env
function getMode() {
  try {
    const env = readFileSync(join(rootDir, '.env'), 'utf8');
    const match = env.match(/^PGMODE=(\w+)/m);
    return match?.[1] || 'docker';
  } catch {
    return 'docker';
  }
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

// Check if native PostgreSQL is accepting connections
function isNativeReady(port = 5432) {
  try {
    execFileSync('pg_isready', ['-h', 'localhost', '-p', String(port)], { stdio: 'pipe' });
    return true;
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
  return new Promise((resolve) => {
    // Non-TTY (CI, piped scripts) — default to file-based
    if (!process.stdin.isTTY) {
      resolve('file');
      return;
    }

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

// Attempt full native PostgreSQL setup via db.sh setup-native
function setupNativePostgres() {
  const dbScript = join(rootDir, 'scripts', 'db.sh');
  try {
    console.log('🍺 Running native PostgreSQL setup...');
    execFileSync('bash', [dbScript, 'setup-native'], { stdio: 'inherit', cwd: rootDir });
    if (isNativeReady()) {
      console.log('✅ System PostgreSQL ready on port 5432');
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
    if (isNativeReady()) {
      console.log('✅ System PostgreSQL ready on port 5432');
      process.exit(0);
    }
    // Attempt automatic setup via db.sh setup-native (installs + configures)
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
  // Native mode: check if system PostgreSQL is running
  if (isNativeReady()) {
    console.log('✅ System PostgreSQL ready on port 5432');
    process.exit(0);
  }

  // Attempt automatic setup via db.sh (installs + starts + configures)
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
