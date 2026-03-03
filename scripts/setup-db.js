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

import { execFileSync, execSync } from 'child_process';
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
        execSync('sleep 1', { stdio: 'pipe' });
      }
    }
  }
  return false;
}

console.log('🗄️  Setting up PostgreSQL + pgvector...');

if (!hasDocker()) {
  console.log('⏭️  Docker not found — skipping database setup');
  console.log('   Memory system will use file-based JSON storage');
  console.log('   Install Docker to enable PostgreSQL: https://docs.docker.com/get-docker/');
  process.exit(0);
}

if (!isDockerRunning()) {
  console.log('⏭️  Docker daemon not running — skipping database setup');
  console.log('   Memory system will use file-based JSON storage');
  console.log('   Start Docker Desktop or run: sudo systemctl start docker');
  process.exit(0);
}

if (!hasCompose()) {
  console.log('⏭️  docker compose not available — skipping database setup');
  console.log('   Memory system will use file-based JSON storage');
  process.exit(0);
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
