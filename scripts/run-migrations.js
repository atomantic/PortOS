#!/usr/bin/env node
import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const migrationsDir = join(rootDir, 'data', 'migrations');
const appliedFile = join(migrationsDir, '.applied.json');

async function run() {
  // Ensure migrations directory exists
  await mkdir(migrationsDir, { recursive: true });

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

  // Scan for migration files (*.js, sorted by filename)
  const files = (await readdir(migrationsDir))
    .filter(f => f.endsWith('.js'))
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
}

run().catch(err => {
  console.error(`❌ Migration failed: ${err.message}`);
  process.exit(1);
});
