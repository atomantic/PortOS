#!/usr/bin/env node
import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const migrationsDir = join(rootDir, 'data', 'migrations');
const appliedFile = join(migrationsDir, '.applied.json');

async function run() {
  // Ensure migrations directory exists
  await mkdir(migrationsDir, { recursive: true });

  // Load applied migrations list (default to [] on corrupt file)
  let applied = [];
  if (existsSync(appliedFile)) {
    const raw = await readFile(appliedFile, 'utf-8');
    try { applied = JSON.parse(raw); } catch { applied = []; }
    if (!Array.isArray(applied)) applied = [];
  }

  // Scan for migration files (*.js, sorted by filename)
  const files = (await readdir(migrationsDir))
    .filter(f => f.endsWith('.js'))
    .sort();

  let ran = 0;
  for (const file of files) {
    if (applied.includes(file)) continue;

    console.log(`🔄 Running migration: ${file}`);
    const migration = await import(pathToFileURL(join(migrationsDir, file)).href);
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
