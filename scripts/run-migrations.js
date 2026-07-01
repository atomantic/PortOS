#!/usr/bin/env node
import { readdir, readFile, writeFile, mkdir, rename } from 'fs/promises';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { resolveInstallRoot, isWorktreeRoot } from '../server/lib/dataRoot.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Prefer an explicit PORTOS_DATA_ROOT env var over the executing-file location
// so a process booted from inside a CoS agent git worktree still resolves to
// the real install (#1947). Falls back to the derived path when unset.
const DEFAULT_ROOT_DIR = resolveInstallRoot(join(__dirname, '..'));
const DEFAULT_MIGRATIONS_DIR = join(__dirname, 'migrations');

const appliedFilePath = (rootDir) => join(rootDir, 'data', 'migrations.applied.json');

/**
 * Scan for migration files (*.js, sorted by filename). Co-located vitest
 * files (*.test.js) are excluded — they don't export `up()` and would
 * throw the runner if imported as migrations. The vitest config picks
 * them up via its own scripts test glob in server/vitest.config.js.
 * `_`-prefixed files (e.g. `_lib.js`, `_testHelpers.js`) are shared
 * helpers consumed by migration files and their tests — they're never
 * migrations themselves.
 */
async function scanMigrationFiles(migrationsDir) {
  return (await readdir(migrationsDir))
    .filter(f => f.endsWith('.js') && !f.endsWith('.test.js') && !f.startsWith('_'))
    .sort();
}

/**
 * Read the applied-migrations list. Default to [] on missing/unreadable file.
 *
 * When `repair` is true and the file is corrupt (mid-write truncation, bad
 * JSON, wrong shape), rename it aside and rebuild from scratch — migrations are
 * idempotent, so re-running is safe, and this prevents one bad write from
 * bricking every subsequent boot. When `repair` is false (read-only callers
 * like listPendingMigrations), a corrupt file is treated as `[]` WITHOUT
 * mutating anything on disk.
 */
async function readAppliedList(appliedFile, { repair = false } = {}) {
  const raw = await readFile(appliedFile, 'utf-8').catch(err => {
    if (err.code !== 'ENOENT' && repair) {
      console.warn(`⚠️ Could not read ${appliedFile}: ${err.message}, defaulting to []`);
    }
    return null;
  });
  if (raw === null) return [];

  let parsed;
  let corruptReason = null;
  try { parsed = JSON.parse(raw); } catch (err) {
    corruptReason = `invalid JSON: ${err.message}`;
  }
  if (corruptReason === null && !Array.isArray(parsed)) {
    corruptReason = `expected array, got ${typeof parsed}`;
  }
  if (corruptReason !== null) {
    if (repair) {
      const aside = `${appliedFile}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      await rename(appliedFile, aside);
      console.warn(`⚠️ Corrupt migrations file ${appliedFile} (${corruptReason}); renamed to ${aside} and rebuilding from scratch`);
    }
    return [];
  }
  return parsed;
}

/**
 * List migration files present on disk that are NOT yet in the applied-list —
 * i.e. migrations a boot would run. Pure read: never applies, renames, or
 * writes anything (so it's safe to call from a status endpoint). Returns the
 * pending filenames in sorted (apply) order.
 */
export async function listPendingMigrations({
  rootDir = DEFAULT_ROOT_DIR,
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
} = {}) {
  const applied = await readAppliedList(appliedFilePath(rootDir), { repair: false });
  const appliedSet = new Set(applied);
  const files = await scanMigrationFiles(migrationsDir).catch(() => []);
  return files.filter(f => !appliedSet.has(f));
}

export async function runMigrations({
  rootDir = DEFAULT_ROOT_DIR,
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
} = {}) {
  // Backstop for #1947: a process booted from inside a CoS agent git worktree
  // (data/cos/worktrees/agent-*) has no gitignored data/ runtime tree, so
  // migrations that read/write data/ or data.reference/ crash on ENOENT. A
  // worktree checkout has no business running its own migration pass — skip it
  // with a clear warning instead of crashing boot.
  if (isWorktreeRoot(rootDir)) {
    console.warn(`⚠️ Skipping migrations: rootDir is a CoS agent worktree checkout (${rootDir}) — no data/ tree to migrate`);
    return 0;
  }

  const appliedFile = appliedFilePath(rootDir);

  // Ensure data/ exists so we can persist applied state (migrationsDir
  // ships in the repo and always exists).
  await mkdir(dirname(appliedFile), { recursive: true });

  // Load applied migrations list (repairing a corrupt file aside — see
  // readAppliedList).
  const applied = await readAppliedList(appliedFile, { repair: true });

  const files = await scanMigrationFiles(migrationsDir);

  let ran = 0;
  for (const file of files) {
    if (applied.includes(file)) continue;

    console.log(`🔄 Running migration: ${file}`);
    const mod = await import(pathToFileURL(join(migrationsDir, file)).href);
    const migration = (mod?.default && typeof mod.default.up === 'function') ? mod.default : mod;
    if (!migration || typeof migration.up !== 'function') {
      throw new Error(`Migration "${file}" does not export an up() function`);
    }
    await migration.up({ rootDir, migrationsDir });
    applied.push(file);
    await writeFile(appliedFile, JSON.stringify(applied, null, 2) + '\n');
    ran++;
    console.log(`✅ Migration applied: ${file}`);
  }

  if (ran === 0) {
    console.log('✅ No pending migrations');
  } else {
    console.log(`✅ ${ran} migration(s) applied`);
  }
  return ran;
}

// Only run as CLI when invoked directly (not when imported as a module).
// `pathToFileURL()` requires an absolute path, so we `resolve()` argv[1]
// first (it may be relative when launched as `node scripts/run-migrations.js`).
// URL-vs-URL comparison normalizes slashes / drive-letter casing on Windows.
// Kept synchronous so importing the module doesn't make it an async module
// or trigger filesystem I/O at evaluation time.
const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsScript) {
  runMigrations().catch(err => {
    console.error(`❌ Migration failed: ${err?.stack ?? err}`);
    process.exit(1);
  });
}
