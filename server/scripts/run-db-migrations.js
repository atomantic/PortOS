#!/usr/bin/env node
/**
 * Versioned PostgreSQL schema-migration runner (#1029).
 *
 * Mirrors the file-migration runner at `scripts/run-migrations.js` (repo root)
 * but tracks state in a Postgres table instead of a JSON file, since a row is
 * more robust than a hand-editable applied-list — there's no corrupt-file
 * recovery branch because the table can't half-write.
 *
 * WHAT THIS IS FOR: deltas on EXISTING installs that `ensureSchema()`'s additive
 * `CREATE/ADD IF NOT EXISTS` gates can't express — column renames, type changes,
 * data transforms, embedding-dimension changes. The fresh-install schema stays
 * in `ensureSchema()` + `init-db.sql`; this runner applies the ordered diffs.
 *
 * HOW IT WORKS: read applied ids from `schema_migrations`, scan
 * `db-migrations/` in lexical order, and run each unapplied file inside a single
 * `withTransaction` — the migration's SQL/`up(client)` AND the
 * `INSERT INTO schema_migrations` share one transaction, so a failed migration
 * rolls BOTH back: it is never marked applied and a re-run retries it cleanly.
 * Idempotent on re-run (already-applied ids are skipped).
 *
 * FILE FORMATS (both supported):
 *   - `NNN-name.sql` — raw SQL run verbatim against the transaction client.
 *   - `NNN-name.js`  — ESM module exporting `async function up(client)` (or a
 *     default object with an `up` method). Receives the pg transaction client so
 *     data transforms / multi-step changes can query + mutate in the same tx.
 *
 * The migration ID recorded in `schema_migrations` is the filename, matching the
 * file-migration runner's convention.
 */

import { readdir, readFile } from 'fs/promises';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = join(__dirname, 'db-migrations');

/**
 * Apply pending DB migrations.
 *
 * @param {object} opts
 * @param {string} [opts.migrationsDir] - directory of ordered migration files.
 * @param {object} [opts.db] - injectable db module (query + withTransaction),
 *   defaults to the live `server/lib/db.js`. Tests pass a live or stub module.
 * @returns {Promise<number>} count of migrations applied this run.
 */
export async function runDbMigrations({
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
  db,
} = {}) {
  const { query, withTransaction } = db ?? await import('../lib/db.js');

  // The tracking table is part of the base schema (ensureSchema + init-db.sql),
  // so it always exists by the time this runs. Read the applied set once.
  const { rows } = await query('SELECT id FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.id));

  // Scan for migration files (*.sql / *.js, sorted by filename). Co-located
  // vitest files (*.test.js) are excluded — they don't export `up()` and would
  // throw the runner if imported as migrations. `_`-prefixed files are shared
  // helpers / fixtures consumed by migrations and their tests, never migrations
  // themselves. A missing directory is treated as "no migrations".
  const entries = await readdir(migrationsDir).catch((err) => {
    if (err.code !== 'ENOENT') throw err;
    return [];
  });
  const files = entries
    .filter((f) => (f.endsWith('.sql') || f.endsWith('.js')) && !f.endsWith('.test.js') && !f.startsWith('_'))
    .sort();

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) continue;

    console.log(`🔄 Running DB migration: ${file}`);
    // Each migration + its bookkeeping insert share ONE transaction so a
    // failure rolls back both: the migration is NOT marked applied, and a
    // subsequent boot retries it. Nothing half-applies.
    if (file.endsWith('.sql')) {
      const sql = await readFile(join(migrationsDir, file), 'utf-8');
      await withTransaction(async (client) => {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
      });
    } else {
      const mod = await import(pathToFileURL(join(migrationsDir, file)).href);
      const migration = (mod?.default && typeof mod.default.up === 'function') ? mod.default : mod;
      if (!migration || typeof migration.up !== 'function') {
        throw new Error(`DB migration "${file}" does not export an up() function`);
      }
      await withTransaction(async (client) => {
        await migration.up(client);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
      });
    }
    ran++;
    console.log(`✅ DB migration applied: ${file}`);
  }

  if (ran === 0) {
    console.log('✅ No pending DB migrations');
  } else {
    console.log(`✅ ${ran} DB migration(s) applied`);
  }
  return ran;
}

// Only run as CLI when invoked directly (not when imported as a module).
// `pathToFileURL()` requires an absolute path, so we `resolve()` argv[1] first
// (it may be relative when launched as `node server/scripts/run-db-migrations.js`).
// URL-vs-URL comparison normalizes slashes / drive-letter casing on Windows.
const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsScript) {
  const { close } = await import('../lib/db.js');
  await runDbMigrations()
    .then(() => close())
    .catch(async (err) => {
      console.error(`❌ DB migration failed: ${err?.stack ?? err}`);
      // Close the pool so the failure path exits the event loop too; ignore a
      // secondary close error so the original failure is the one we exit on.
      await close().catch(() => {});
      process.exit(1);
    });
}
