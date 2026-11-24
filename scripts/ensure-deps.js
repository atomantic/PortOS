/**
 * Ensures all workspace dependencies are installed before starting.
 * Repairs missing or stale dependencies only in workspaces that own their tree.
 * Handles ENOTEMPTY npm bug by retrying with clean node_modules.
 */
import { existsSync, rmSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { rebuildTrusted } from './trusted-rebuilds.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { dependencyHash, npmConfigHash, readDependencyHashes, saveDependencyHashes } from './lib/dependencyReceipts.js';
import { dependencyWorkspaces, hasLinkedDependencies } from './lib/workspaceDependencies.js';
// Node refuses to spawn npm's `.cmd` shim under `shell:false` (CVE-2024-27980),
// so every npm spawn goes through this wrap. Safe to import before `npm install`
// has ever run — bufferedSpawn's whole import graph is Node builtins only.
import { prepareCliSpawn } from '../server/lib/bufferedSpawn.js';

const npmSpawn = (args, options) => {
  const { command, args: spawnArgs } = prepareCliSpawn('npm', args);
  return execFileSync(command, spawnArgs, options);
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const WORKSPACES = dependencyWorkspaces(ROOT);

// Filesystem fallback for the no-baseline case (first run after this feature
// lands, or a fresh manual checkout): npm writes node_modules/.package-lock.json
// at the end of every install, so its mtime is the last-install time. If
// either dependency input was modified more recently — e.g. a `git pull`
// brought a new lockfile over a still-present node_modules — clean-reinstall
// even though we have no stored hash to compare against.
// Returns false when we can't tell (missing marker, stat error) so we never
// wipe a tree we can't prove is stale.
function dependenciesNewerThanInstall(dir) {
  const markerPath = join(dir, 'node_modules', '.package-lock.json');
  const installMarker = existsSync(markerPath) ? markerPath : join(dir, 'node_modules');
  try {
    const installedAt = statSync(installMarker).mtimeMs;
    return ['package.json', 'package-lock.json'].some((name) => {
      const input = join(dir, name);
      return existsSync(input) && statSync(input).mtimeMs > installedAt;
    });
  } catch {
    return false;
  }
}

// Wipe `node_modules` ONLY. Every workspace lockfile ensure-deps touches (root,
// client, server) is tracked, so `npm install` re-resolves from the
// committed lock — which is the state we want. Deleting it would let a clean
// reinstall silently float transitive versions past the `overrides` pins.
export function cleanWorkspaceDeps(dir) {
  try {
    rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
  } catch { /* best effort */ }
}

// The trusted install-script allowlist lives in scripts/trusted-rebuilds.js —
// shared with scripts/setup.js (which installs through installWorkspace below),
// update.sh, update.ps1 and CI so the list has exactly one home.
// Every workspace pins `ignore-scripts=true` in its own .npmrc, so a plain
// `npm install` leaves these native deps unbuilt and the server crashes on a
// missing node-pty binding. Run after every (re)install — not just the
// clean-reinstall path — so a fresh install into a missing node_modules is
// equally whole.
// Exported so scripts/setup.js runs the same cwd-based install and clean retry
// as startup repair instead of keeping a second copy of the loop.
export function installWorkspace(dir, label) {
  try {
    // This repairs an installed tree; it never authors dependencies. Keep the
    // committed lockfile byte-stable even when the local npm writer is older.
    npmSpawn(['install', '--no-save'], { cwd: dir, stdio: 'inherit', windowsHide: true });
    return rebuildTrusted(dir, label);
  } catch (err) {
    console.error(`⚠️  npm install failed for ${label}: ${err.message ?? err}`);
    console.log(`⚠️  Cleaning node_modules and retrying...`);
    try {
      rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
    } catch (cleanupErr) {
      console.error(`❌ Failed to clean node_modules for ${label}: ${cleanupErr.message}`);
      return false;
    }
    try {
      npmSpawn(['install', '--no-save'], { cwd: dir, stdio: 'inherit', windowsHide: true });
      return rebuildTrusted(dir, label);
    } catch (retryErr) {
      console.error(`❌ npm install failed for ${label} after retry: ${retryErr.message ?? retryErr}`);
      return false;
    }
  }
}

// Import-safe driver: the module exposes its helpers to scripts/ensure-deps.test.js,
// and only performs installs when run as `node scripts/ensure-deps.js`.
function main() {
  // Ordinary CoS worktrees borrow the source checkout's dependencies. Refuse
  // the entire repair before any install, cleanup or receipt write;
  // checking inside the repair loop could already mutate an earlier workspace.
  // lstat also catches dangling links and Windows directory junctions.
  for (const { dir, label } of WORKSPACES) {
    if (hasLinkedDependencies(dir)) {
      console.error(`⛔ Refusing dependency repair: ${label}/node_modules is linked. Run startup in the source checkout; use its workspace binaries for worktree tests.`);
      process.exitCode = 1;
      return;
    }
  }

  const storedHashes = readDependencyHashes(ROOT);
  let hashesDirty = false;
  let needed = false;

  for (const { dir, label } of WORKSPACES) {
    const currentHash = dependencyHash(dir);
    const currentConfig = npmConfigHash(dir);
    const storedConfig = storedHashes.npmrc[label];
    const configChanged = storedConfig !== undefined && storedConfig !== currentConfig;
    const nodeModulesMissing = !existsSync(join(dir, 'node_modules'));
    const storedHash = storedHashes[label];
    // With a stored baseline, a differing hash means a dependency input moved
    // since the last install. Without one (first run after this feature lands, or a fresh
    // manual checkout), fall back to the install-marker mtime so a `git pull` +
    // `npm start` catches a changed manifest or lockfile over a present
    // node_modules instead of silently seeding the stale tree.
    const depsChanged = configChanged || (storedHash != null
      ? currentHash != null && storedHash !== currentHash
      : !nodeModulesMissing && dependenciesNewerThanInstall(dir));

    if (nodeModulesMissing || depsChanged) {
      if (depsChanged) {
        // Clean whenever dependency inputs changed — even if node_modules is
        // already gone — so npm rebuilds the tree from the committed lockfile instead of
        // layering onto a tree resolved against the previous manifest.
        console.log(`🧹 ${label} dependency inputs changed since last install — clean reinstall...`);
        cleanWorkspaceDeps(dir);
      } else {
        console.log(`📦 Missing node_modules for ${label} — installing...`);
      }
      if (!installWorkspace(dir, label)) process.exit(1);
      storedHashes.npmrc[label] = currentConfig;
      hashesDirty = true;
      needed = true;
    }

    if (currentHash != null && storedHashes[label] !== currentHash) {
      storedHashes[label] = currentHash;
      hashesDirty = true;
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
    if (!installWorkspace(dir, label)) process.exit(1);
    storedHashes.npmrc[label] = npmConfigHash(dir);
    hashesDirty = true;
    needed = true;

    const stillMissing = pkgs.filter(pkg => !existsSync(join(dir, 'node_modules', ...pkg.split('/'))));
    if (stillMissing.length) {
      console.error(`❌ Still missing in ${label} after reinstall: ${stillMissing.map(p => p.split('/')[0]).join(', ')}`);
      process.exit(1);
    }
  }

  if (hashesDirty) {
    try {
      saveDependencyHashes(ROOT, storedHashes);
    } catch (err) {
      console.error(`⚠️  Could not persist deps hashes: ${err.message ?? err}`);
    }
  }

  if (needed) console.log('✅ Dependencies verified');
}

if (isDirectlyInvoked(import.meta.url)) main();
