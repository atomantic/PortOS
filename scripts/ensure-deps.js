/**
 * Ensures all workspace dependencies are installed before starting.
 * Runs npm install only for workspaces with missing node_modules.
 * Handles ENOTEMPTY npm bug by retrying with clean node_modules.
 */
import { existsSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const WORKSPACES = [
  { dir: ROOT, label: 'root' },
  { dir: join(ROOT, 'client'), label: 'client' },
  { dir: join(ROOT, 'server'), label: 'server' }
];

function install(dir, label) {
  try {
    execFileSync(NPM, ['install'], { cwd: dir, stdio: 'inherit', windowsHide: true });
    return true;
  } catch {
    console.log(`⚠️  npm install failed for ${label} — cleaning node_modules and retrying...`);
    try {
      rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
    } catch (cleanupErr) {
      console.error(`❌ Failed to clean node_modules for ${label}: ${cleanupErr.message}`);
      return false;
    }
    try {
      execFileSync(NPM, ['install'], { cwd: dir, stdio: 'inherit', windowsHide: true });
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
// Grouped by workspace to avoid redundant installs
const criticalPackages = [
  { dir: ROOT, label: 'root', pkg: 'pm2/package.json' },
  { dir: join(ROOT, 'client'), label: 'client', pkg: 'vite/bin/vite.js' },
  { dir: join(ROOT, 'server'), label: 'server', pkg: 'express/package.json' },
  { dir: join(ROOT, 'server'), label: 'server', pkg: 'pg/package.json' },
];

const criticalByDir = new Map();
for (const { dir, label, pkg } of criticalPackages) {
  if (!criticalByDir.has(dir)) criticalByDir.set(dir, { label, pkgs: [] });
  criticalByDir.get(dir).pkgs.push(pkg);
}

for (const [dir, { label, pkgs }] of criticalByDir) {
  const missing = pkgs.filter(pkg => !existsSync(join(dir, 'node_modules', ...pkg.split('/'))));
  if (!missing.length) continue;

  console.log(`📦 Missing ${missing.map(p => p.split('/')[0]).join(', ')} in ${label} — reinstalling deps...`);
  if (!install(dir, label)) process.exit(1);
  needed = true;

  const stillMissing = pkgs.filter(pkg => !existsSync(join(dir, 'node_modules', ...pkg.split('/'))));
  if (stillMissing.length) {
    console.error(`❌ Still missing in ${label} after reinstall: ${stillMissing.map(p => p.split('/')[0]).join(', ')}`);
    process.exit(1);
  }
}

if (needed) console.log('✅ Dependencies verified');
