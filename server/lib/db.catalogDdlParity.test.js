/**
 * Catalog DDL parity test — locks the schema definitions in
 * `server/scripts/init-db.sql` (fresh-install path) and the per-domain DDL
 * modules under `server/lib/db/schema/` that `ensureSchema()` composes and runs
 * (upgrade path — #2832 split them out of `db.js`) so a future PR that updates
 * one without the other surfaces here instead of in the wild.
 *
 * Same risk exists for the `memories` / `memory_links` DDL but has been
 * tolerated since the memory system landed; this test only covers catalog.
 *
 * The test is structural, not a SQL parser — it extracts table column sets,
 * index names, trigger / function names, the `type` CHECK list, and the
 * `search_tsv` payload-field set from each source and asserts the sets are
 * equal. Cosmetic differences (whitespace, comments, ordering) are tolerated;
 * a column added on one side but not the other is not.
 */

import { describe, it, expect } from 'vitest';
import { FTS_PAYLOAD_FIELDS } from './catalogTypes.js';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const INIT_SQL = readFileSync(join(HERE, '..', 'scripts', 'init-db.sql'), 'utf8');
// The ensureSchema() DDL now lives in per-domain modules under db/schema/ (#2832);
// db.js is the thin composer. Concatenate the module sources (plus db.js itself)
// so this structural parity check sees every CREATE TABLE / INDEX / trigger the
// upgrade path runs, exactly as it did when the DDL was inlined in db.js. The
// variable keeps the DB_JS name because it still represents "the JS-side DDL".
const SCHEMA_DIR = join(HERE, 'db', 'schema');
const DB_JS = [
  readFileSync(join(HERE, 'db.js'), 'utf8'),
  ...readdirSync(SCHEMA_DIR)
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
    .map((f) => readFileSync(join(SCHEMA_DIR, f), 'utf8')),
].join('\n');

const CATALOG_TABLES = [
  'catalog_scraps',
  'catalog_ingredients',
  'catalog_ingredient_sources',
  'catalog_ingredient_refs',
  'catalog_ingredient_relations',
  'catalog_tags',
  'catalog_ingredient_revisions',
  'catalog_ingredient_media',
];

// Strip line comments + collapse whitespace so column lists compare cleanly.
const normalize = (s) => s
  .replace(/--[^\n]*\n/g, '\n')
  .replace(/\s+/g, ' ')
  .trim();

function extractCreateTable(source, table) {
  const re = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(([\\s\\S]*?)\\)(?:\\s*;|\\s*\`)`, 'i');
  const m = re.exec(source);
  if (!m) return null;
  return normalize(m[1]);
}

// A column "name" for parity purposes: the identifier up to the first
// space. Strips inline comments, then splits on commas at depth-0 parens so
// `CHECK (type IN ('a','b'))` survives without breaking on its inner comma.
function extractColumnNames(body) {
  const parts = [];
  let depth = 0;
  let buf = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(buf.trim());
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts
    .map((p) => p.split(/\s+/)[0])
    .filter((p) => p && !/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)$/i.test(p));
}

function extractIndexNames(source, prefix = 'idx_catalog_') {
  const out = new Set();
  const re = new RegExp(`CREATE INDEX IF NOT EXISTS\\s+(${prefix}\\w+)`, 'gi');
  let m;
  while ((m = re.exec(source)) !== null) out.add(m[1]);
  return out;
}

function extractFunctionNames(source, prefix = 'update_catalog_') {
  const out = new Set();
  const re = new RegExp(`CREATE OR REPLACE FUNCTION\\s+(${prefix}\\w+)`, 'gi');
  let m;
  while ((m = re.exec(source)) !== null) out.add(m[1]);
  return out;
}

function extractTriggerNames(source, prefix = 'trg_catalog_') {
  const out = new Set();
  const re = new RegExp(`CREATE TRIGGER\\s+(${prefix}\\w+)`, 'gi');
  let m;
  while ((m = re.exec(source)) !== null) out.add(m[1]);
  return out;
}

// Pull the `type IN (...)` literal set out of the catalog_ingredients CHECK.
function extractTypeCheckSet(source) {
  const m = /CHECK\s*\(\s*type\s+IN\s*\(([^)]*)\)\s*\)/i.exec(source);
  if (!m) return null;
  return new Set(
    m[1]
      .split(',')
      .map((s) => s.replace(/['"\s]/g, ''))
      .filter(Boolean),
  );
}

// Pull the `payload->>'<key>'` identifiers from the `search_tsv` generated
// expression. Both files repeat them in the same per-line shape; we just
// collect the set across the whole source.
function extractPayloadFtsKeys(source) {
  const out = new Set();
  const re = /payload->>'([a-zA-Z0-9_]+)'/g;
  let m;
  while ((m = re.exec(source)) !== null) out.add(m[1]);
  return out;
}

describe('catalog DDL parity (init-db.sql ↔ db.js ensureSchema)', () => {
  it.each(CATALOG_TABLES)('table %s has the same columns in both files', (table) => {
    const sqlBody = extractCreateTable(INIT_SQL, table);
    const jsBody = extractCreateTable(DB_JS, table);
    expect(sqlBody, `init-db.sql missing CREATE TABLE ${table}`).toBeTruthy();
    expect(jsBody, `db.js missing CREATE TABLE ${table}`).toBeTruthy();
    const sqlCols = new Set(extractColumnNames(sqlBody));
    const jsCols = new Set(extractColumnNames(jsBody));
    expect([...sqlCols].sort()).toEqual([...jsCols].sort());
  });

  it('every idx_catalog_* index name appears in both files', () => {
    const sqlIdx = extractIndexNames(INIT_SQL);
    const jsIdx = extractIndexNames(DB_JS);
    expect([...sqlIdx].sort()).toEqual([...jsIdx].sort());
    expect(sqlIdx.size).toBeGreaterThan(0);
  });

  it('every update_catalog_* trigger function appears in both files', () => {
    const sqlFns = extractFunctionNames(INIT_SQL);
    const jsFns = extractFunctionNames(DB_JS);
    expect([...sqlFns].sort()).toEqual([...jsFns].sort());
    expect(sqlFns.size).toBeGreaterThan(0);
  });

  it('every trg_catalog_* trigger appears in both files', () => {
    // Exclude the generic `*_audit` triggers (record_audit): init-db.sql spells
    // them literally while db.js builds them from the auditedTables array via a
    // `trg_${t}_audit` template literal, so a literal-name extractor only sees
    // them on the init-db.sql side. They have their own parity assertion below.
    const noAudit = (s) => new Set([...s].filter((t) => !t.endsWith('_audit')));
    const sqlTrgs = noAudit(extractTriggerNames(INIT_SQL));
    const jsTrgs = noAudit(extractTriggerNames(DB_JS));
    expect([...sqlTrgs].sort()).toEqual([...jsTrgs].sort());
    expect(sqlTrgs.size).toBeGreaterThan(0);
  });

  it('catalog_ingredients type is app-layer-gated (no hardcoded CHECK in either file)', () => {
    // The legacy `CHECK (type IN (...))` was dropped — valid types are gated at
    // the app layer via the INGREDIENT_TYPES registry + Zod enum, so a new type
    // is a registry entry, not a two-file constraint migration. Assert NEITHER
    // file reintroduces a hardcoded `type IN (...)` CHECK (a one-sided re-add
    // would drift the fresh-install and upgrade paths apart again), and that
    // both declare the widened VARCHAR(32) column.
    expect(extractTypeCheckSet(INIT_SQL), 'init-db.sql reintroduced a hardcoded type CHECK').toBeNull();
    expect(extractTypeCheckSet(DB_JS), 'db.js reintroduced a hardcoded type CHECK').toBeNull();
    expect(/type VARCHAR\(32\)/i.test(extractCreateTable(INIT_SQL, 'catalog_ingredients'))).toBe(true);
    expect(/type VARCHAR\(32\)/i.test(extractCreateTable(DB_JS, 'catalog_ingredients'))).toBe(true);
  });

  // Non-catalog table that nonetheless lives in BOTH DDL sources (fresh-install
  // init-db.sql + upgrade-path ensureSchema) and so has the same drift risk.
  it('creative_director_projects has the same columns in both files', () => {
    const sqlBody = extractCreateTable(INIT_SQL, 'creative_director_projects');
    const jsBody = extractCreateTable(DB_JS, 'creative_director_projects');
    expect(sqlBody, 'init-db.sql missing CREATE TABLE creative_director_projects').toBeTruthy();
    expect(jsBody, 'db.js missing CREATE TABLE creative_director_projects').toBeTruthy();
    expect([...new Set(extractColumnNames(sqlBody))].sort())
      .toEqual([...new Set(extractColumnNames(jsBody))].sort());
  });

  // Media asset index (#1000) — non-catalog table in BOTH DDL sources, plus a
  // non-`idx_catalog_`-prefixed index, so it needs its own parity assertion.
  it('media_assets has the same columns and index in both files', () => {
    const sqlBody = extractCreateTable(INIT_SQL, 'media_assets');
    const jsBody = extractCreateTable(DB_JS, 'media_assets');
    expect(sqlBody, 'init-db.sql missing CREATE TABLE media_assets').toBeTruthy();
    expect(jsBody, 'db.js missing CREATE TABLE media_assets').toBeTruthy();
    expect([...new Set(extractColumnNames(sqlBody))].sort())
      .toEqual([...new Set(extractColumnNames(jsBody))].sort());
    const sqlIdx = extractIndexNames(INIT_SQL, 'idx_media_assets_');
    const jsIdx = extractIndexNames(DB_JS, 'idx_media_assets_');
    expect([...sqlIdx].sort()).toEqual([...jsIdx].sort());
    expect(sqlIdx.size).toBeGreaterThan(0);
  });

  // Catalog user-defined types (#1001) — non-`catalog_`-prefixed table name in
  // BOTH DDL sources (the parity `CATALOG_TABLES` loop matches by literal table
  // name, and this one isn't in that list), so it gets its own column assertion.
  // It declares no secondary index, so nothing to compare there.
  it('catalog_user_types has the same columns in both files', () => {
    const sqlBody = extractCreateTable(INIT_SQL, 'catalog_user_types');
    const jsBody = extractCreateTable(DB_JS, 'catalog_user_types');
    expect(sqlBody, 'init-db.sql missing CREATE TABLE catalog_user_types').toBeTruthy();
    expect(jsBody, 'db.js missing CREATE TABLE catalog_user_types').toBeTruthy();
    expect([...new Set(extractColumnNames(sqlBody))].sort())
      .toEqual([...new Set(extractColumnNames(jsBody))].sort());
  });

  // Universe Builder records (#1014) — non-`catalog_`-prefixed table in BOTH
  // DDL sources, with non-`idx_catalog_`-prefixed indexes, so it gets its own
  // column + index parity assertion.
  it('universes has the same columns and indexes in both files', () => {
    const sqlBody = extractCreateTable(INIT_SQL, 'universes');
    const jsBody = extractCreateTable(DB_JS, 'universes');
    expect(sqlBody, 'init-db.sql missing CREATE TABLE universes').toBeTruthy();
    expect(jsBody, 'db.js missing CREATE TABLE universes').toBeTruthy();
    expect([...new Set(extractColumnNames(sqlBody))].sort())
      .toEqual([...new Set(extractColumnNames(jsBody))].sort());
    const sqlIdx = extractIndexNames(INIT_SQL, 'idx_universes_');
    const jsIdx = extractIndexNames(DB_JS, 'idx_universes_');
    expect([...sqlIdx].sort()).toEqual([...jsIdx].sort());
    expect(sqlIdx.size).toBeGreaterThan(0);
  });

  // Universe render-history log (#1014) — same drift risk; its own table + index.
  it('universe_runs has the same columns and index in both files', () => {
    const sqlBody = extractCreateTable(INIT_SQL, 'universe_runs');
    const jsBody = extractCreateTable(DB_JS, 'universe_runs');
    expect(sqlBody, 'init-db.sql missing CREATE TABLE universe_runs').toBeTruthy();
    expect(jsBody, 'db.js missing CREATE TABLE universe_runs').toBeTruthy();
    expect([...new Set(extractColumnNames(sqlBody))].sort())
      .toEqual([...new Set(extractColumnNames(jsBody))].sort());
    const sqlIdx = extractIndexNames(INIT_SQL, 'idx_universe_runs_');
    const jsIdx = extractIndexNames(DB_JS, 'idx_universe_runs_');
    expect([...sqlIdx].sort()).toEqual([...jsIdx].sort());
    expect(sqlIdx.size).toBeGreaterThan(0);
  });

  // Pipeline series (#1015) — non-`catalog_`-prefixed table in BOTH DDL
  // sources, with non-`idx_catalog_`-prefixed indexes, so its own assertion.
  it('pipeline_series has the same columns and indexes in both files', () => {
    const sqlBody = extractCreateTable(INIT_SQL, 'pipeline_series');
    const jsBody = extractCreateTable(DB_JS, 'pipeline_series');
    expect(sqlBody, 'init-db.sql missing CREATE TABLE pipeline_series').toBeTruthy();
    expect(jsBody, 'db.js missing CREATE TABLE pipeline_series').toBeTruthy();
    expect([...new Set(extractColumnNames(sqlBody))].sort())
      .toEqual([...new Set(extractColumnNames(jsBody))].sort());
    const sqlIdx = extractIndexNames(INIT_SQL, 'idx_series_');
    const jsIdx = extractIndexNames(DB_JS, 'idx_series_');
    expect([...sqlIdx].sort()).toEqual([...jsIdx].sort());
    expect(sqlIdx.size).toBeGreaterThan(0);
  });

  // Pipeline issues (#1015) — same drift risk; its own table + indexes.
  it('pipeline_issues has the same columns and indexes in both files', () => {
    const sqlBody = extractCreateTable(INIT_SQL, 'pipeline_issues');
    const jsBody = extractCreateTable(DB_JS, 'pipeline_issues');
    expect(sqlBody, 'init-db.sql missing CREATE TABLE pipeline_issues').toBeTruthy();
    expect(jsBody, 'db.js missing CREATE TABLE pipeline_issues').toBeTruthy();
    expect([...new Set(extractColumnNames(sqlBody))].sort())
      .toEqual([...new Set(extractColumnNames(jsBody))].sort());
    const sqlIdx = extractIndexNames(INIT_SQL, 'idx_issues_');
    const jsIdx = extractIndexNames(DB_JS, 'idx_issues_');
    expect([...sqlIdx].sort()).toEqual([...jsIdx].sort());
    expect(sqlIdx.size).toBeGreaterThan(0);
  });

  // Story Builder sessions (#1016) — same drift risk; its own table + indexes.
  it('story_builder_sessions has the same columns and indexes in both files', () => {
    const sqlBody = extractCreateTable(INIT_SQL, 'story_builder_sessions');
    const jsBody = extractCreateTable(DB_JS, 'story_builder_sessions');
    expect(sqlBody, 'init-db.sql missing CREATE TABLE story_builder_sessions').toBeTruthy();
    expect(jsBody, 'db.js missing CREATE TABLE story_builder_sessions').toBeTruthy();
    expect([...new Set(extractColumnNames(sqlBody))].sort())
      .toEqual([...new Set(extractColumnNames(jsBody))].sort());
    const sqlIdx = extractIndexNames(INIT_SQL, 'idx_stb_');
    const jsIdx = extractIndexNames(DB_JS, 'idx_stb_');
    expect([...sqlIdx].sort()).toEqual([...jsIdx].sort());
    expect(sqlIdx.size).toBeGreaterThan(0);
  });

  // Writers Room (#1017) — four tables, each its own column + index parity
  // assertion (distinct idx_wr_<table>_ prefixes keep them isolated).
  for (const { table, idxPrefix } of [
    { table: 'writers_room_folders', idxPrefix: 'idx_wr_folders_' },
    { table: 'writers_room_works', idxPrefix: 'idx_wr_works_' },
    { table: 'writers_room_draft_versions', idxPrefix: 'idx_wr_drafts_' },
    { table: 'writers_room_exercises', idxPrefix: 'idx_wr_exercises_' },
  ]) {
    it(`${table} has the same columns and indexes in both files`, () => {
      const sqlBody = extractCreateTable(INIT_SQL, table);
      const jsBody = extractCreateTable(DB_JS, table);
      expect(sqlBody, `init-db.sql missing CREATE TABLE ${table}`).toBeTruthy();
      expect(jsBody, `db.js missing CREATE TABLE ${table}`).toBeTruthy();
      expect([...new Set(extractColumnNames(sqlBody))].sort())
        .toEqual([...new Set(extractColumnNames(jsBody))].sort());
      const sqlIdx = extractIndexNames(INIT_SQL, idxPrefix);
      const jsIdx = extractIndexNames(DB_JS, idxPrefix);
      expect([...sqlIdx].sort()).toEqual([...jsIdx].sort());
      expect(sqlIdx.size).toBeGreaterThan(0);
    });
  }

  // Versioned DB-migration tracker (#1029) — non-`catalog_`-prefixed table in
  // BOTH DDL sources (base schema), so it gets its own column parity assertion.
  // No secondary index, nothing to compare there.
  it('schema_migrations has the same columns in both files', () => {
    const sqlBody = extractCreateTable(INIT_SQL, 'schema_migrations');
    const jsBody = extractCreateTable(DB_JS, 'schema_migrations');
    expect(sqlBody, 'init-db.sql missing CREATE TABLE schema_migrations').toBeTruthy();
    expect(jsBody, 'db.js missing CREATE TABLE schema_migrations').toBeTruthy();
    expect([...new Set(extractColumnNames(sqlBody))].sort())
      .toEqual([...new Set(extractColumnNames(jsBody))].sort());
  });

  // Deletion audit log (incident #1248-follow-up) — the record_audit table, the
  // record_audit_log() trigger function, and the per-content-table `_audit`
  // triggers all live in BOTH DDL sources. A one-sided edit (e.g. auditing a new
  // table only in db.js) would leave fresh installs un-audited, so lock all three.
  it('record_audit table + trigger function + audit triggers match in both files', () => {
    // table columns
    const sqlBody = extractCreateTable(INIT_SQL, 'record_audit');
    const jsBody = extractCreateTable(DB_JS, 'record_audit');
    expect(sqlBody, 'init-db.sql missing CREATE TABLE record_audit').toBeTruthy();
    expect(jsBody, 'db.js missing CREATE TABLE record_audit').toBeTruthy();
    expect([...new Set(extractColumnNames(sqlBody))].sort())
      .toEqual([...new Set(extractColumnNames(jsBody))].sort());

    // generic trigger function present in both
    expect(/CREATE OR REPLACE FUNCTION\s+record_audit_log\b/i.test(INIT_SQL)).toBe(true);
    expect(/CREATE OR REPLACE FUNCTION\s+record_audit_log\b/i.test(DB_JS)).toBe(true);

    // The set of audited tables is identical across both. init-db.sql spells out
    // a `trg_<table>_audit` per table; db.js builds them from the `auditedTables`
    // array via a `trg_${t}_audit` template literal, so we parse that array on the
    // js side rather than matching literal trigger names.
    const sqlAuditTables = (() => {
      const out = new Set();
      const re = /CREATE TRIGGER\s+trg_([a-z0-9_]+)_audit\b/gi;
      let m;
      while ((m = re.exec(INIT_SQL)) !== null) out.add(m[1]);
      return out;
    })();
    const jsAuditTables = (() => {
      const m = /const auditedTables\s*=\s*\[([\s\S]*?)\]/i.exec(DB_JS);
      expect(m, 'db.js missing the auditedTables array').toBeTruthy();
      const out = new Set();
      const re = /'([a-z0-9_]+)'/gi;
      let mm;
      while ((mm = re.exec(m[1])) !== null) out.add(mm[1]);
      return out;
    })();
    expect(sqlAuditTables.size, 'no _audit triggers found in init-db.sql — DDL broke').toBeGreaterThan(8);
    expect([...sqlAuditTables].sort()).toEqual([...jsAuditTables].sort());
  });

  // Broad drift guard for the whole upgrade-vs-fresh-install gap (beyond the
  // catalog tables above). init-db.sql runs ONLY on fresh `db.sh setup-native`
  // provisioning; existing installs + federated peers get new tables solely
  // through db.js `ensureSchema()`'s catalogDDL array. A table added to one
  // source but not the other is invisible until a real upgrade fails in the
  // wild (e.g. lora_training_runs shipped in init-db.sql but was missing from
  // ensureSchema — every existing install would 500 on the first training run).
  it('every table in init-db.sql is also created in db.js ensureSchema', () => {
    const tableNames = (source) => {
      const out = new Set();
      const re = /CREATE TABLE IF NOT EXISTS\s+([a-z0-9_]+)/gi;
      let m;
      while ((m = re.exec(source)) !== null) out.add(m[1].toLowerCase());
      return out;
    };
    // The memory subsystem provisions its own tables via a separate path
    // (server/scripts/migrate*Memories*.js), so they live in init-db.sql but
    // intentionally NOT in ensureSchema — the documented exception in this
    // file's header. Everything else must be in both.
    const PROVISIONED_ELSEWHERE = new Set(['memories', 'memory_links']);
    const sqlTables = tableNames(INIT_SQL);
    const jsTables = tableNames(DB_JS);
    expect(sqlTables.size, 'init-db.sql declares no tables — parser broke').toBeGreaterThan(8);
    const missing = [...sqlTables]
      .filter((t) => !jsTables.has(t) && !PROVISIONED_ELSEWHERE.has(t));
    expect(missing, `tables in init-db.sql but missing from db.js ensureSchema (existing installs won't get them): ${missing.join(', ')}`).toEqual([]);
  });

  it('search_tsv payload field set matches', () => {
    // Both files re-declare the GENERATED ALWAYS expression character-for-
    // character today. If one side adds a payload key (e.g. voiceNotes) and
    // the other lags, the FTS index expression mismatches and search returns
    // different rows on a fresh install vs an upgraded install.
    const sqlKeys = extractPayloadFtsKeys(INIT_SQL);
    const jsKeys = extractPayloadFtsKeys(DB_JS);
    expect([...sqlKeys].sort()).toEqual([...jsKeys].sort());
    // The registry (`catalogTypes.FTS_PAYLOAD_FIELDS`) is the single source of
    // truth for which payload keys the FTS column must index. Derive the
    // required set from it rather than a hand-maintained list, so adding a
    // type's `ftsFields` without updating BOTH DDL sources fails here instead
    // of silently de-indexing the field.
    expect(FTS_PAYLOAD_FIELDS.length, 'registry declares no FTS payload fields').toBeGreaterThan(0);
    for (const required of FTS_PAYLOAD_FIELDS) {
      expect(sqlKeys.has(required), `init-db.sql search_tsv missing registry FTS field ${required}`).toBe(true);
      expect(jsKeys.has(required), `db.js search_tsv missing registry FTS field ${required}`).toBe(true);
    }
  });
});
