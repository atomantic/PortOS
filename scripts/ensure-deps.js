/**
 * Ensures all workspace dependencies are installed before starting.
 * Runs npm install only for workspaces with missing node_modules.
 * Handles ENOTEMPTY npm bug by retrying with clean node_modules.
 */
import { existsSync, rmSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const WORKSPACES = [
  { dir: ROOT, label: 'root' },
  { dir: join(ROOT, 'client'), label: 'client' },
  { dir: join(ROOT, 'server'), label: 'server' }
];

function install(dir, label) {
  try {
    execSync('npm install', { cwd: dir, stdio: 'inherit' });
    return true;
  } catch {
    console.log(`⚠️  npm install failed for ${label} — cleaning node_modules and retrying...`);
    rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
    try {
      execSync('npm install', { cwd: dir, stdio: 'inherit' });
      return true;
    } catch {
      console.error(`❌ npm install failed for ${label} after retry`);
      return false;
    }
  }
}

let needed = false;
for (const { dir, label } of WORKSPACES) {
  if (!existsSync(join(dir, 'node_modules'))) {
    console.log(`📦 Missing node_modules for ${label} — installing...`);
    if (!install(dir, label)) process.exit(1);
    needed = true;
  }
}

// Verify critical packages exist even if node_modules dirs were present
const criticalPackages = [
  { dir: join(ROOT, 'client'), label: 'client', pkg: 'vite/bin/vite.js' },
  { dir: join(ROOT, 'server'), label: 'server', pkg: 'express/package.json' },
  { dir: join(ROOT, 'server'), label: 'server', pkg: 'pg/package.json' },
];

for (const { dir, label, pkg } of criticalPackages) {
  if (!existsSync(join(dir, 'node_modules', pkg))) {
    console.log(`📦 Missing ${pkg.split('/')[0]} in ${label} — reinstalling deps...`);
    if (!install(dir, label)) process.exit(1);
    needed = true;
  }
}

if (needed) console.log('✅ Dependencies verified');
