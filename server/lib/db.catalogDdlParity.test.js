/**
 * Catalog DDL parity test — locks the schema definitions in
 * `server/scripts/init-db.sql` (fresh-install path) and the `catalogDDL`
 * array inside `server/lib/db.js` `ensureSchema()` (upgrade path) so a future
 * PR that updates one without the other surfaces here instead of in the wild.
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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const INIT_SQL = readFileSync(join(HERE, '..', 'scripts', 'init-db.sql'), 'utf8');
const DB_JS = readFileSync(join(HERE, 'db.js'), 'utf8');

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
    const sqlTrgs = extractTriggerNames(INIT_SQL);
    const jsTrgs = extractTriggerNames(DB_JS);
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
