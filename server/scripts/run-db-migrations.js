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

import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { scanDatabaseMigrationFiles } from '../../scripts/lib/migrationFiles.js';
import { isDirectlyInvoked } from '../../scripts/lib/directInvocation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = join(__dirname, 'db-migrations');

// Dedicated transaction-scoped advisory lock key for serializing pending DB
// migrations across concurrent boot/CLI processes. Distinct from
// SCHEMA_DDL_ADVISORY_LOCK_KEY (5977001), DB_RUN_ADVISORY_LOCK_KEY (5977002),
// and SYNC_FEED_LOCK_KEY (8315001).
export const DB_MIGRATIONS_LOCK_KEY = 5977003;

async function loadMigrationExecutor(migrationsDir, file) {
  const fullPath = join(migrationsDir, file);
  if (file.endsWith('.sql')) {
    const sql = await readFile(fullPath, 'utf-8');
    return (client) => client.query(sql);
  }
  const mod = await import(pathToFileURL(fullPath).href);
  const migration = (mod?.default && typeof mod.default.up === 'function') ? mod.default : mod;
  if (!migration || typeof migration.up !== 'function') {
    throw new Error(`DB migration "${file}" does not export an up() function`);
  }
  return (client) => migration.up(client);
}

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
  // so it always exists by the time this runs. Read the applied set once to
  // skip already-applied files fast, then re-verify per migration under an
  // advisory lock inside withTransaction.
  const { rows } = await query('SELECT id FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.id));

  const files = await scanDatabaseMigrationFiles(migrationsDir);

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) continue;

    const applyMigration = await loadMigrationExecutor(migrationsDir, file);
    // Acquire a transaction-scoped advisory lock and re-check schema_migrations
    // before running the migration body so overlapping boots/CLI runs cannot
    // race on the same migration or hit duplicate-key 23505 on insert.
    const didApply = await withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [DB_MIGRATIONS_LOCK_KEY]);
      const { rows: existing } = await client.query(
        'SELECT 1 FROM schema_migrations WHERE id = $1',
        [file],
      );
      if (existing.length > 0) return false;

      console.log(`🔄 Running DB migration: ${file}`);
      await applyMigration(client);
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
      return true;
    });

    if (didApply) {
      ran++;
      console.log(`✅ DB migration applied: ${file}`);
    } else {
      console.log(`⏭️ DB migration already applied by concurrent runner: ${file}`);
    }
  }

  if (ran === 0) {
    console.log('✅ No pending DB migrations');
  } else {
    console.log(`✅ ${ran} DB migration(s) applied`);
  }
  return ran;
}

if (isDirectlyInvoked(import.meta.url)) {
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
