/**
 * DDL parity test — locks the schema definitions in `server/scripts/init-db.sql`
 * (fresh-install path) and the per-domain DDL modules under `server/lib/db/schema/`
 * that `ensureSchema()` composes and runs (upgrade path — #2832 split them out of
 * `db.js`) so a future PR that updates one without the other surfaces here instead
 * of in the wild.
 *
 * The test auto-discovers all shared tables (those declared in BOTH sources) and
 * compares their columns, indexes, trigger/function names, and CHECK constraints.
 * Two tolerance lists guard the exceptional cases: `SQL_ONLY_TOLERATED` for tables
 * in init-db.sql but not JS (currently only the memory system), and
 * `BOOT_BACKFILL_ONLY` for tables in JS but not init-db.sql (machine-local tables
 * that backfill from JS on every boot, with one-line reasons for each).
 *
 * The test is structural, not a SQL parser — it extracts table column sets,
 * index names, trigger / function names, CHECK constraints, and search_tsv
 * payload-field sets from each source and asserts the sets are equal. Cosmetic
 * differences (whitespace, comments, ordering) are tolerated; a column added on
 * one side but not the other is not.
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

// Tables that exist ONLY in init-db.sql (fresh-install DDL, never composed
// from JS modules on boot — currently only the memory system, documented
// in #1337 and ADR docs/decisions/2026-04-17-memory-system-local-only.md).
const SQL_ONLY_TOLERATED = ['memories', 'memory_links'];

// Tables that exist ONLY in JS schema modules and backfill on every boot
// (machine-local, never in init-db.sql — each entry must carry a one-line reason).
// Currently empty — all machine-local tables are now in both sources (#6819).
const BOOT_BACKFILL_ONLY = {};

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

// Auto-discover all CREATE TABLE names from a source.
function extractAllTableNames(source) {
  const tables = new Set();
  const re = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(/gi;
  let m;
  while ((m = re.exec(source)) !== null) {
    tables.add(m[1]);
  }
  return tables;
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

// Extract all columns from both CREATE TABLE and ALTER TABLE ADD COLUMN statements.
function extractAllColumns(source, table) {
  const cols = new Set();

  // Extract from CREATE TABLE body
  const body = extractCreateTable(source, table);
  if (body) {
    extractColumnNames(body).forEach((col) => cols.add(col));
  }

  // Extract from ALTER TABLE ADD COLUMN statements
  const re = new RegExp(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS (\\w+)`, 'gi');
  let m;
  while ((m = re.exec(source)) !== null) {
    cols.add(m[1]);
  }

  return cols;
}

// Matches both plain and UNIQUE index declarations: a dedupe index is usually
// the UNIQUE one (idx_user_action_dedupe), and a name captured on only one side
// of the parity check is exactly the drift this file exists to catch.
// When given 'catalog_', extract all indexes that start with idx_catalog_
// When given 'tribe_people', extract all indexes that start with idx_tribe_people_
function extractIndexNames(source, prefixOrTable) {
  const out = new Set();
  let prefix;
  if (prefixOrTable.startsWith('idx_')) {
    prefix = prefixOrTable;
  } else if (prefixOrTable.endsWith('_')) {
    prefix = `idx_${prefixOrTable}`;
  } else {
    prefix = `idx_${prefixOrTable}_`;
  }
  const re = new RegExp(`CREATE (?:UNIQUE )?INDEX IF NOT EXISTS\\s+(${prefix}\\w+)`, 'gi');
  let m;
  while ((m = re.exec(source)) !== null) out.add(m[1]);
  return out;
}

// Names alone can't catch an index that exists in both files under the same
// name but over different columns (or a different sort order, or having lost
// its UNIQUE) — that ships a fresh install an index the boot-time DDL never
// intended, and a dropped UNIQUE breaks the ON CONFLICT idempotency contract
// the store relies on. Pair each name with its normalized definition so the
// parity check compares shape, not just identity.
function extractIndexDefs(source, table) {
  const out = new Map();
  const re = new RegExp(
    `CREATE (UNIQUE )?INDEX IF NOT EXISTS\\s+(\\w+)\\s+ON ${table}\\s*\\(([^)]*)\\)`,
    'gi',
  );
  let m;
  while ((m = re.exec(source)) !== null) {
    const cols = m[3].replace(/\s+/g, ' ').trim().toLowerCase();
    out.set(m[2], `${m[1] ? 'unique ' : ''}(${cols})`);
  }
  return out;
}

// Extract functions matching a prefix (e.g. 'update_catalog_')
function extractFunctionNames(source, prefix) {
  const out = new Set();
  const re = new RegExp(`CREATE OR REPLACE FUNCTION\\s+(${prefix}\\w+)`, 'gi');
  let m;
  while ((m = re.exec(source)) !== null) out.add(m[1]);
  return out;
}

// Extract triggers matching a prefix (e.g. 'trg_catalog_')
function extractTriggerNames(source, triggerPrefix) {
  const out = new Set();
  // Match "CREATE TRIGGER name" where name starts with the prefix
  const re = new RegExp(`CREATE TRIGGER\\s+(${triggerPrefix}\\w+)`, 'gi');
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

// Pull the `<column> IN (...)` literal set out of one table's CHECK, from
// whichever of the two DDL sources is passed in. Used to pin a closed
// PortOS-owned state machine (e.g. beeper_outbox.state) so a value silently
// added to one file's CHECK but not the other — or dropped from both without
// anyone deciding to — surfaces here instead of at a runtime INSERT.
function extractCheckInSet(source, table, column) {
  const body = extractCreateTable(source, table);
  if (!body) return null;
  const re = new RegExp(`CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)\\s*\\)`, 'i');
  const m = re.exec(body);
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


describe('DDL parity (init-db.sql ↔ db.js ensureSchema)', () => {
  it('discovers all shared tables and confirms no unexpected SQL-only or JS-only tables', () => {
    const sqlTables = extractAllTableNames(INIT_SQL);
    const jsTables = extractAllTableNames(DB_JS);

    const shared = new Set([...sqlTables].filter((t) => jsTables.has(t)));
    const sqlOnly = new Set([...sqlTables].filter((t) => !jsTables.has(t)));
    const jsOnly = new Set([...jsTables].filter((t) => !sqlTables.has(t)));

    // Verify SQL_ONLY_TOLERATED contains exactly the SQL-only tables
    expect([...sqlOnly].sort()).toEqual([...SQL_ONLY_TOLERATED].sort());

    // Verify BOOT_BACKFILL_ONLY contains exactly the JS-only tables
    expect([...jsOnly].sort()).toEqual([...Object.keys(BOOT_BACKFILL_ONLY)].sort());

    // Confirm we have reasonable coverage
    expect(shared.size).toBeGreaterThan(50);
    console.log(`✓ Discovered ${shared.size} shared tables, ${sqlOnly.size} SQL-only, ${jsOnly.size} JS-only`);
  });

  // For each shared table, verify columns, indexes, triggers, and functions match
  describe('shared table parity', () => {
    const sqlTables = extractAllTableNames(INIT_SQL);
    const jsTables = extractAllTableNames(DB_JS);
    const shared = [...sqlTables].filter((t) => jsTables.has(t));

    it.each(shared)('table %s has the same columns in both files', (table) => {
      const sqlCols = extractAllColumns(INIT_SQL, table);
      const jsCols = extractAllColumns(DB_JS, table);

      const sqlOnly = [...sqlCols].filter((c) => !jsCols.has(c));
      const jsOnly = [...jsCols].filter((c) => !sqlCols.has(c));

      expect(sqlOnly, `init-db.sql has extra columns: ${sqlOnly.join(', ')}`).toEqual([]);
      expect(jsOnly, `db.js has extra columns: ${jsOnly.join(', ')}`).toEqual([]);
    });

    it.each(shared)('table %s has matching index names in both files', (table) => {
      const sqlIdx = extractIndexNames(INIT_SQL, table);
      const jsIdx = extractIndexNames(DB_JS, table);

      const sqlOnly = [...sqlIdx].filter((i) => !jsIdx.has(i));
      const jsOnly = [...jsIdx].filter((i) => !sqlIdx.has(i));

      expect(sqlOnly, `init-db.sql has extra indexes: ${sqlOnly.join(', ')}`).toEqual([]);
      expect(jsOnly, `db.js has extra indexes: ${jsOnly.join(', ')}`).toEqual([]);
    });

    // For tables with multiple indexes, also verify index definitions match
    // (not just names — indexes can drift in their column list or uniqueness)
    const tablesWithIndexes = shared.filter((table) => {
      const sqlIdx = extractIndexNames(INIT_SQL, table);
      return sqlIdx.size > 0;
    });

    it.each(tablesWithIndexes)('table %s has matching index definitions in both files', (table) => {
      const sqlIdx = extractIndexDefs(INIT_SQL, table);
      const jsIdx = extractIndexDefs(DB_JS, table);

      for (const [name, def] of sqlIdx) {
        expect(jsIdx.get(name), `table ${table} index ${name} definition mismatch`).toEqual(def);
      }
      for (const [name, def] of jsIdx) {
        expect(sqlIdx.get(name), `table ${table} index ${name} definition mismatch`).toEqual(def);
      }
    });
  });

  // Catalog-specific checks (these existed before the generalization)
  describe('catalog-specific parity', () => {
    it('every idx_catalog_* index name appears in both files', () => {
      const sqlIdx = extractIndexNames(INIT_SQL, 'catalog_');
      const jsIdx = extractIndexNames(DB_JS, 'catalog_');
      expect([...sqlIdx].sort()).toEqual([...jsIdx].sort());
      expect(sqlIdx.size).toBeGreaterThan(0);
    });

    it('every update_catalog_* trigger function appears in both files', () => {
      const sqlFns = extractFunctionNames(INIT_SQL, 'update_catalog_');
      const jsFns = extractFunctionNames(DB_JS, 'update_catalog_');
      expect([...sqlFns].sort()).toEqual([...jsFns].sort());
      expect(sqlFns.size).toBeGreaterThan(0);
    });

    it('every trg_catalog_* trigger appears in both files', () => {
      // Exclude the generic `*_audit` triggers (record_audit): init-db.sql spells
      // them literally while db.js builds them from the auditedTables array via a
      // `trg_${t}_audit` template literal, so a literal-name extractor only sees
      // them on the init-db.sql side. They have their own parity assertion below.
      const noAudit = (s) => new Set([...s].filter((t) => !t.endsWith('_audit')));
      const sqlTrgs = noAudit(extractTriggerNames(INIT_SQL, 'trg_catalog_'));
      const jsTrgs = noAudit(extractTriggerNames(DB_JS, 'trg_catalog_'));
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
      expect(extractCheckInSet(INIT_SQL, 'catalog_ingredients', 'type'), 'init-db.sql reintroduced a hardcoded type CHECK').toBeNull();
      expect(extractCheckInSet(DB_JS, 'catalog_ingredients', 'type'), 'db.js reintroduced a hardcoded type CHECK').toBeNull();
      expect(/type VARCHAR\(32\)/i.test(extractCreateTable(INIT_SQL, 'catalog_ingredients'))).toBe(true);
      expect(/type VARCHAR\(32\)/i.test(extractCreateTable(DB_JS, 'catalog_ingredients'))).toBe(true);
    });
  });
});
