/**
 * The generated fresh-install schema builds the same catalog as the boot path
 * (#16092). One scratch schema gets `server/scripts/init-db.sql` as a single
 * simple-query batch (how setup-db-test.mjs, psql and Docker's initdb apply it);
 * the other gets the base file's memory tables, then every buildUpgradeDdl() and
 * buildCatalogDdl() statement one at a time (how ensureSchemaImpl runs them),
 * then the base file's tail. Tables, columns (type, nullability, default,
 * generation), indexes, constraints, triggers, functions, views and sequences
 * must match.
 *
 * Both schemas live inside one transaction that is always rolled back, so the
 * shared `portos_test` schema is never altered. `*.db.test.js` → runs ONLY via
 * `npm run test:db`.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkHealth, close, withTransaction } from '../../db.js';
import { requireDbOrSkip } from '../../dbTestGate.js';
import { buildCatalogDdl, buildUpgradeDdl } from './index.js';
import { INIT_DB_BASE_PATH, INIT_DB_SQL_PATH, splitInitDbBase } from '../../../../scripts/generate-init-db-sql.js';

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((e) => ({ connected: false, error: e?.message }));
  if (health.connected) dbReady = true;
  else skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
}
const runDb = requireDbOrSkip('lib/db/schema/initDbSql.db.test', dbReady, skipReason);

afterAll(async () => {
  if (dbReady) await close();
});

const FROM_FILE = 'init_db_from_file';
const FROM_BOOT = 'init_db_from_boot';

// Each query takes the schema name as $1 and returns rows describing one
// catalog object; definitions are made schema-independent before comparing.
const CATALOG_QUERIES = {
  columns: `SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull,
      pg_get_expr(d.adbin, d.adrelid) AS default_expr, a.attgenerated, a.attidentity
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm') AND a.attnum > 0 AND NOT a.attisdropped`,
  indexes: 'SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = $1',
  constraints: `SELECT c.relname, k.conname, pg_get_constraintdef(k.oid) AS def
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1`,
  triggers: `SELECT c.relname, t.tgname, pg_get_triggerdef(t.oid) AS def
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND NOT t.tgisinternal`,
  functions: `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, p.prosrc
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1`,
  views: `SELECT c.relname, pg_get_viewdef(c.oid) AS def
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('v', 'm')`,
  sequences: `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relkind = 'S'`,
};

async function snapshotCatalog(client, schema) {
  const out = {};
  for (const [kind, sql] of Object.entries(CATALOG_QUERIES)) {
    const { rows } = await client.query(sql, [schema]);
    out[kind] = rows.map((row) => JSON.stringify(row).replaceAll(`${schema}.`, '')).sort();
  }
  return out;
}

// Build each schema with the scratch schema first on the search path, so every
// unqualified CREATE lands there while the extensions stay resolvable in public.
async function buildSchema(client, schema, apply) {
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET LOCAL search_path = ${schema}, public`);
  await apply();
  return snapshotCatalog(client, schema);
}

const ROLLBACK = Symbol('rollback');

describe.skipIf(!runDb)('generated init-db.sql ↔ ensureSchema catalog', () => {
  it('a database built from the generated file matches one built by the boot DDL', async () => {
    const { before, after } = splitInitDbBase(readFileSync(INIT_DB_BASE_PATH, 'utf8'));
    let fromFile;
    let fromBoot;
    await withTransaction(async (client) => {
      fromFile = await buildSchema(client, FROM_FILE, () => client.query(readFileSync(INIT_DB_SQL_PATH, 'utf8')));
      fromBoot = await buildSchema(client, FROM_BOOT, async () => {
        await client.query(before);
        for (const sql of [...buildUpgradeDdl(), ...buildCatalogDdl()]) await client.query(sql);
        await client.query(after);
      });
      throw ROLLBACK;
    }).catch((err) => {
      if (err !== ROLLBACK) throw err;
    });

    expect(new Set(fromFile.columns.map((row) => JSON.parse(row).relname)).size, 'schema built no tables').toBeGreaterThan(100);
    const indexes = new Map(fromBoot.indexes.map((row) => {
      const { indexname, indexdef } = JSON.parse(row);
      return [indexname, indexdef];
    }));
    expect(indexes.get('idx_media_assets_visible_images_created'))
      .toContain("ON media_assets USING btree (created_at DESC, media_key) WHERE (((kind)::text = 'image'::text) AND (NOT is_hidden))");
    expect(indexes.get('idx_media_assets_visible_image_facets'))
      .toContain("ON media_assets USING btree (universe_id, universe_name, entry_category, entry_kind) WHERE (((kind)::text = 'image'::text) AND (NOT is_hidden))");
    expect(indexes.get('idx_media_assets_kind_ref')).toContain('ON media_assets USING btree (kind, ref)');
    expect(indexes.get('idx_human_activity_happened_id'))
      .toContain('ON human_activity_events USING btree (happened_at DESC, id DESC)');
    expect(indexes.get('idx_human_activity_participants'))
      .toContain('ON human_activity_events USING gin (participants jsonb_path_ops)');
    expect(indexes.get('idx_human_activity_account_happened'))
      .toContain('ON human_activity_events USING btree (account_id, happened_at DESC) WHERE (account_id IS NOT NULL)');
    expect(indexes.get('idx_user_action_happened_id'))
      .toContain('ON user_action_events USING btree (happened_at DESC, id DESC)');

    for (const kind of Object.keys(CATALOG_QUERIES)) {
      expect(fromFile[kind], `${kind} differ between init-db.sql and ensureSchema`).toEqual(fromBoot[kind]);
    }
  }, 120_000);
});
