#!/usr/bin/env node

/**
 * Database Setup Script
 *
 * Ensures PostgreSQL + pgvector is running via Docker Compose.
 * Gracefully skips if Docker is not available — the memory system
 * falls back to file-based JSON storage automatically.
 *
 * Called by: npm run setup, npm run update, npm start, npm run dev
 */

import { execFileSync } from 'child_process';
import { createInterface } from 'readline';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

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

// Prompt user to continue without Docker (TTY only)
function promptContinue(message, hint) {
  return new Promise((resolve) => {
    // Non-TTY (CI, piped scripts) — skip silently
    if (!process.stdin.isTTY) {
      console.log(`⏭️  ${message}`);
      console.log(`   ${hint}`);
      console.log('   Memory system will use file-based JSON storage');
      resolve(true);
      return;
    }

    console.log(`⚠️  ${message}`);
    console.log(`   ${hint}`);
    console.log('');

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question('   Continue without Docker (file-based storage)? [Y/n] ', (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      // Default is Y (continue)
      resolve(trimmed === '' || trimmed === 'y' || trimmed === 'yes');
    });
  });
}

async function handleDockerUnavailable(message, issue) {
  const hint = getDockerHints(issue);
  const shouldContinue = await promptContinue(message, hint);

  if (shouldContinue) {
    console.log('   Memory system will use file-based JSON storage');
    process.exit(0);
  } else {
    console.log('   Exiting — install/start Docker and try again');
    process.exit(1);
  }
}

console.log('🗄️  Setting up PostgreSQL + pgvector...');

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
