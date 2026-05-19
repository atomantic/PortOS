#!/usr/bin/env node
import { readdir, readFile, writeFile, mkdir, rename } from 'fs/promises';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIR = join(__dirname, '..');
const DEFAULT_MIGRATIONS_DIR = join(__dirname, 'migrations');

export async function runMigrations({
  rootDir = DEFAULT_ROOT_DIR,
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
} = {}) {
  const appliedFile = join(rootDir, 'data', 'migrations.applied.json');

  // Ensure data/ exists so we can persist applied state (migrationsDir
  // ships in the repo and always exists).
  await mkdir(dirname(appliedFile), { recursive: true });

  // Load applied migrations list. Default to [] on missing/unreadable file.
  // If the file is corrupt (mid-write truncation, bad JSON, wrong shape), rename
  // it aside and rebuild from scratch — migrations are idempotent, so re-running
  // is safe, and this prevents one bad write from bricking every subsequent boot.
  let applied = [];
  const raw = await readFile(appliedFile, 'utf-8').catch(err => {
    if (err.code !== 'ENOENT') {
      console.warn(`⚠️ Could not read ${appliedFile}: ${err.message}, defaulting to []`);
    }
    return null;
  });
  if (raw !== null) {
    let parsed;
    let corruptReason = null;
    try { parsed = JSON.parse(raw); } catch (err) {
      corruptReason = `invalid JSON: ${err.message}`;
    }
    if (corruptReason === null && !Array.isArray(parsed)) {
      corruptReason = `expected array, got ${typeof parsed}`;
    }
    if (corruptReason !== null) {
      const aside = `${appliedFile}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      await rename(appliedFile, aside);
      console.warn(`⚠️ Corrupt migrations file ${appliedFile} (${corruptReason}); renamed to ${aside} and rebuilding from scratch`);
    } else {
      applied = parsed;
    }
  }

  // Scan for migration files (*.js, sorted by filename). Co-located vitest
  // files (*.test.js) are excluded — they don't export `up()` and would
  // throw the runner if imported as migrations. The vitest config picks
  // them up via its own glob (`../scripts/**/*.test.js` in
  // server/vitest.config.js). `_`-prefixed files (e.g. `_lib.js`,
  // `_testHelpers.js`) are shared helpers consumed by migration files and
  // their tests — they're never migrations themselves.
  const files = (await readdir(migrationsDir))
    .filter(f => f.endsWith('.js') && !f.endsWith('.test.js') && !f.startsWith('_'))
    .sort();

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
