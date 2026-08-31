/**
 * Ensures all workspace dependencies are installed before starting.
 * Runs npm install only for workspaces with missing node_modules.
 * Handles ENOTEMPTY npm bug by retrying with clean node_modules.
 */
import { existsSync, rmSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { rebuildTrusted } from './trusted-rebuilds.js';
// Node refuses to spawn npm's `.cmd` shim under `shell:false` (CVE-2024-27980),
// so every npm spawn goes through this wrap. Safe to import before `npm install`
// has ever run — bufferedSpawn's whole import graph is Node builtins only.
import { prepareCliSpawn } from '../server/lib/bufferedSpawn.js';

const npmSpawn = (args, options) => {
  const { command, args: spawnArgs } = prepareCliSpawn('npm', args);
  return execFileSync(command, spawnArgs, options);
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Persisted package.json hashes (per workspace) from the last successful install.
// A changed hash means the manifest moved since we last resolved the tree, so an
// in-place `npm install` over the existing node_modules could leave a stale /
// duplicated tree (e.g. a react@18 copy lingering beside react@19 after a major
// bump) — which builds fine but throws "Invalid hook call" at runtime. When the
// hash changes we wipe node_modules first and reinstall from scratch instead.
// This mirrors update.sh's pull-diff clean-reinstall for the manual
// `git pull` + `npm start` path, which has no pull context to diff against.
const HASH_FILE = join(ROOT, 'data', 'deps-hashes.json');

const WORKSPACES = [
  { dir: ROOT, label: 'root' },
  { dir: join(ROOT, 'client'), label: 'client' },
  { dir: join(ROOT, 'server'), label: 'server' },
  { dir: join(ROOT, 'autofixer'), label: 'autofixer' }
];

function pkgHash(dir) {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return null;
  return createHash('sha256').update(readFileSync(pkgPath)).digest('hex');
}

function loadHashes() {
  try {
    return JSON.parse(readFileSync(HASH_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveHashes(hashes) {
  try {
    mkdirSync(dirname(HASH_FILE), { recursive: true });
    writeFileSync(HASH_FILE, JSON.stringify(hashes, null, 2));
  } catch (err) {
    // Non-fatal — the worst case is we re-evaluate the hash next boot.
    console.error(`⚠️  Could not persist deps hashes: ${err.message ?? err}`);
  }
}

// True only when the lockfile is gitignored (the per-install client/server
// locks). A tracked root lockfile is kept — it's consistent with package.json.
function lockfileIsGitignored(dir) {
  try {
    execFileSync('git', ['check-ignore', '-q', join(dir, 'package-lock.json')], {
      cwd: ROOT,
      stdio: 'ignore',
      windowsHide: true
    });
    return true;
  } catch {
    return false;
  }
}

// Filesystem fallback for the no-baseline case (first run after this feature
// lands, or a fresh manual checkout): npm writes node_modules/.package-lock.json
// at the end of every install, so its mtime is the last-install time. If
// package.json was modified more recently — e.g. a `git pull` just brought a
// new manifest over a still-present node_modules — the tree is stale and must
// be clean-reinstalled even though we have no stored hash to compare against.
// Returns false when we can't tell (missing marker, stat error) so we never
// wipe a tree we can't prove is stale.
function manifestNewerThanInstall(dir) {
  const markerPath = join(dir, 'node_modules', '.package-lock.json');
  const installMarker = existsSync(markerPath) ? markerPath : join(dir, 'node_modules');
  try {
    return statSync(join(dir, 'package.json')).mtimeMs > statSync(installMarker).mtimeMs;
  } catch {
    return false;
  }
}

function cleanWorkspaceDeps(dir) {
  try {
    rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
  } catch { /* best effort */ }
  if (lockfileIsGitignored(dir)) {
    try {
      rmSync(join(dir, 'package-lock.json'), { force: true });
    } catch { /* best effort */ }
  }
}

// The trusted install-script allowlist lives in scripts/trusted-rebuilds.js —
// shared with the root `setup` script, setup.ps1, update.sh, update.ps1 and CI so
// the list has exactly one home.
// Every workspace pins `ignore-scripts=true` in its own .npmrc, so a plain
// `npm install` leaves these native deps unbuilt and the server crashes on a
// missing node-pty binding. Run after every (re)install — not just the
// clean-reinstall path — so a fresh install into a missing node_modules is
// equally whole.

function install(dir, label) {
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

const storedHashes = loadHashes();
let hashesDirty = false;
let needed = false;

for (const { dir, label } of WORKSPACES) {
  const currentHash = pkgHash(dir);
  const nodeModulesMissing = !existsSync(join(dir, 'node_modules'));
  const storedHash = storedHashes[label];
  // With a stored baseline, a differing hash means the manifest moved since the
  // last install. Without one (first run after this feature lands, or a fresh
  // manual checkout), fall back to the install-marker mtime so a `git pull` +
  // `npm start` that changed package.json over a present node_modules is still
  // caught — instead of silently seeding the stale tree.
  const depsChanged = storedHash != null
    ? currentHash != null && storedHash !== currentHash
    : !nodeModulesMissing && manifestNewerThanInstall(dir);

  if (nodeModulesMissing || depsChanged) {
    if (depsChanged) {
      // Clean whenever the manifest changed — even if node_modules is already
      // gone — so the stale gitignored lockfile is removed and npm resolves the
      // tree from scratch instead of reusing the old per-install lock.
      console.log(`🧹 ${label} package.json changed since last install — clean reinstall...`);
      cleanWorkspaceDeps(dir);
    } else {
      console.log(`📦 Missing node_modules for ${label} — installing...`);
    }
    if (!install(dir, label)) process.exit(1);
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
  if (!install(dir, label)) process.exit(1);
  needed = true;

  const stillMissing = pkgs.filter(pkg => !existsSync(join(dir, 'node_modules', ...pkg.split('/'))));
  if (stillMissing.length) {
    console.error(`❌ Still missing in ${label} after reinstall: ${stillMissing.map(p => p.split('/')[0]).join(', ')}`);
    process.exit(1);
  }
}

if (hashesDirty) saveHashes(storedHashes);

if (needed) console.log('✅ Dependencies verified');
