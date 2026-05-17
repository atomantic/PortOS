#!/usr/bin/env node
import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIR = join(__dirname, '..');
const MIGRATIONS_DIR = join(__dirname, 'migrations');

export async function runMigrations({ rootDir = DEFAULT_ROOT_DIR } = {}) {
  const appliedFile = join(rootDir, 'data', 'migrations.applied.json');

  // Ensure data/ exists so we can persist applied state (migrationsDir
  // ships in the repo and always exists).
  await mkdir(dirname(appliedFile), { recursive: true });

  // Load applied migrations list (default to [] on missing/unreadable file, throw on corrupted JSON)
  let applied = [];
  const raw = await readFile(appliedFile, 'utf-8').catch(err => {
    if (err.code !== 'ENOENT') {
      console.warn(`⚠️ Could not read ${appliedFile}: ${err.message}, defaulting to []`);
    }
    return null;
  });
  if (raw !== null) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch (err) {
      throw new Error(`Corrupted migrations file ${appliedFile} — fix or delete it manually: ${err.message}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`Corrupted migrations file ${appliedFile} — expected array, got ${typeof parsed}`);
    }
    applied = parsed;
  }

  // Scan for migration files (*.js, sorted by filename). Test files live
  // alongside their migration; exclude them so the runner doesn't try to
  // import a vitest module as a migration.
  const files = (await readdir(MIGRATIONS_DIR))
    .filter(f => f.endsWith('.js') && !f.endsWith('.test.js'))
    .sort();

  let ran = 0;
  for (const file of files) {
    if (applied.includes(file)) continue;

    console.log(`🔄 Running migration: ${file}`);
    const mod = await import(pathToFileURL(join(MIGRATIONS_DIR, file)).href);
    const migration = (mod?.default && typeof mod.default.up === 'function') ? mod.default : mod;
    if (!migration || typeof migration.up !== 'function') {
      throw new Error(`Migration "${file}" does not export an up() function`);
    }
    await migration.up({ rootDir, migrationsDir: MIGRATIONS_DIR });
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
