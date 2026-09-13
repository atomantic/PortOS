/**
 * DDL parity test — locks the schema definitions in `server/scripts/init-db.sql`
 * (fresh-install path) and the per-domain DDL modules under `server/lib/db/schema/`
 * that `ensureSchema()` composes and runs (upgrade path — #2832 split them out of
 * `db.js`) so a future PR that updates one without the other surfaces here instead
 * of in the wild.
 *
 * Coverage (#6819): every table declared in BOTH sources is auto-discovered and
 * compared on its column set (CREATE TABLE columns ∪ additive `ALTER TABLE … ADD
 * COLUMN IF NOT EXISTS`), its indexes (name AND normalized definition — UNIQUE,
 * access method, column list, partial-index predicate — keyed on the `ON <table>`
 * clause rather than a name prefix, because several tables name theirs
 * `idx_series_*` / `idx_stb_*` / `uq_*`), its non-audit triggers (event + function),
 * and its `<column> IN (...)` CHECK literal sets. Two tolerance lists guard the
 * one-sided cases: `SQL_ONLY_TOLERATED` for tables in init-db.sql but not JS
 * (currently only the memory system), and `BOOT_BACKFILL_ONLY` for tables in JS
 * but not init-db.sql (each entry must carry a one-line reason). The targeted pins
 * at the bottom guard contracts a two-sided set comparison cannot — an index or
 * CHECK value dropped from BOTH files still reads as a passing set match.
 *
 * The test is structural, not a SQL parser — cosmetic differences (whitespace,
 * comments, ordering) are tolerated; a column added on one side but not the
 * other is not. Column TYPES are not compared.
 */

import { describe, it, expect } from 'vitest';
import { FTS_PAYLOAD_FIELDS } from './catalogTypes.js';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const INIT_SQL = readFileSync(join(HERE, '..', 'scripts', 'init-db.sql'), 'utf8');
// The ensureSchema() DDL lives in per-domain modules under db/schema/ (#2832);
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

// Tables that exist ONLY in init-db.sql. The memory subsystem provisions its
// own tables via a separate path (server/scripts/migrate*Memories*.js), so they
// live in init-db.sql but intentionally NOT in ensureSchema (#1337, ADR
// docs/decisions/2026-04-17-memory-system-local-only.md).
const SQL_ONLY_TOLERATED = ['memories', 'memory_links'];

// Tables that exist ONLY in the JS schema modules and reach an install solely
// through the boot-time backfill. Every entry carries a one-line reason, so a
// table skipped in init-db.sql is a conscious decision, never silence. Empty as
// of #6819: the five tables that used to be here (ai_connections,
// ai_harness_bindings, ai_route_bindings, creative_commissions,
// commission_feedback) are ordinary db-primary records and now ship in both.
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

// Every `CREATE TABLE IF NOT EXISTS <name>` in a source. Templated names on the
// JS side (`${t}`) are not identifiers and are skipped by `\w+`.
function extractAllTableNames(source) {
  const tables = new Set();
  const re = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(/gi;
  let m;
  while ((m = re.exec(source)) !== null) tables.add(m[1]);
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

// CREATE TABLE columns ∪ additive `ALTER TABLE <t> ADD COLUMN IF NOT EXISTS`
// columns. A column that only ever shipped as an ALTER on one side and inside
// the CREATE on the other is still the same column set — which is what an
// upgraded install and a fresh install must agree on.
function extractAllColumns(source, table) {
  const cols = new Set(extractColumnNames(extractCreateTable(source, table) ?? ''));
  const re = new RegExp(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS (\\w+)`, 'gi');
  let m;
  while ((m = re.exec(source)) !== null) cols.add(m[1]);
  return cols;
}

// Every index in a source, keyed by the table its ON clause names. Keying on
// the table (not on an `idx_<table>_` name prefix) is the whole point: the
// pipeline, story-builder, writers-room and AI-graph tables name theirs
// `idx_series_*`, `idx_stb_*`, `idx_wr_*` and `uq_*`, which a prefix scan never
// sees — and an index only one side declares is exactly the drift this file
// exists to catch. The definition keeps UNIQUE, the access method (`USING gin`),
// the column list and the partial-index predicate, so the same name over a
// different shape fails too: a dropped UNIQUE breaks the ON CONFLICT
// idempotency contract the stores rely on, and a lost predicate ships a fresh
// install a different index than the boot-time DDL intended. Statements end
// with `;` in init-db.sql and with the closing template-literal backtick in JS.
function extractIndexesByTable(source) {
  const out = new Map();
  const re = /CREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+(\w+)\s+ON\s+(\w+)\s*(?:USING\s+(\w+)\s*)?\(([^)]*)\)(?:\s*(WHERE\s+[^;`]*?))?\s*(?:;|`)/gi;
  let m;
  while ((m = re.exec(source)) !== null) {
    const [, unique, name, table, using, cols, where] = m;
    const def = [
      unique ? 'unique' : null,
      using ? `using ${using.toLowerCase()}` : null,
      `(${cols.replace(/\s+/g, ' ').trim().toLowerCase()})`,
      where ? where.replace(/\s+/g, ' ').trim().toLowerCase() : null,
    ].filter(Boolean).join(' ');
    if (!out.has(table)) out.set(table, new Map());
    out.get(table).set(name, def);
  }
  return out;
}

// Every literally-named trigger in a source, keyed by table, as
// `<event> → <function>`. The generic `trg_<table>_audit` triggers are skipped:
// db/schema/audit.js builds them from the `auditedTables` array via a template
// literal, so a literal-name extractor only sees them on the init-db.sql side —
// they have their own parity assertion below.
function extractTriggersByTable(source) {
  const out = new Map();
  const re = /CREATE\s+TRIGGER\s+(\w+)\s+((?:BEFORE|AFTER|INSTEAD\s+OF)\s+[\w\s]+?)\s+ON\s+(\w+)\s+FOR\s+EACH\s+(ROW|STATEMENT)\s+EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(\w+)\s*\(/gi;
  let m;
  while ((m = re.exec(source)) !== null) {
    const [, name, events, table, scope, fn] = m;
    if (name.endsWith('_audit')) continue;
    if (!out.has(table)) out.set(table, new Map());
    out.get(table).set(name, `${events.replace(/\s+/g, ' ').trim().toLowerCase()} for each ${scope.toLowerCase()} → ${fn}`);
  }
  return out;
}

// Every `CHECK (<column> IN (...))` literal set in one CREATE TABLE body, keyed
// by column. A value added to one file's CHECK but not the other surfaces here
// instead of at a runtime INSERT on whichever install path lacks it.
function extractCheckInSets(body) {
  const out = new Map();
  const re = /CHECK\s*\(\s*(\w+)\s+IN\s*\(([^)]*)\)\s*\)/gi;
  let m;
  while ((m = re.exec(body ?? '')) !== null) {
    out.set(m[1], m[2].split(',').map((s) => s.replace(/['"\s]/g, '')).filter(Boolean).sort());
  }
  return out;
}

const extractCheckInSet = (source, table, column) => {
  const literals = extractCheckInSets(extractCreateTable(source, table)).get(column);
  return literals ? new Set(literals) : null;
};

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

const countEntries = (byTable) => [...byTable.values()].reduce((n, m) => n + m.size, 0);
const asObject = (map) => Object.fromEntries(map ?? []);

describe('DDL parity (init-db.sql ↔ db/schema ensureSchema)', () => {
  const sqlTables = extractAllTableNames(INIT_SQL);
  const jsTables = extractAllTableNames(DB_JS);
  const shared = [...sqlTables].filter((t) => jsTables.has(t)).sort();
  const sqlIndexes = extractIndexesByTable(INIT_SQL);
  const jsIndexes = extractIndexesByTable(DB_JS);
  const sqlTriggers = extractTriggersByTable(INIT_SQL);
  const jsTriggers = extractTriggersByTable(DB_JS);

  it('discovers the shared tables and accounts for every one-sided table', () => {
    expect(sqlTables.size, 'init-db.sql declares no tables — parser broke').toBeGreaterThan(50);
    expect(shared.length, 'the two sources share almost nothing — parser broke').toBeGreaterThan(50);
    const sqlOnly = [...sqlTables].filter((t) => !jsTables.has(t)).sort();
    const jsOnly = [...jsTables].filter((t) => !sqlTables.has(t)).sort();
    expect(sqlOnly, 'tables in init-db.sql but missing from db/schema (existing installs never get them)')
      .toEqual([...SQL_ONLY_TOLERATED].sort());
    expect(jsOnly, 'tables in db/schema but missing from init-db.sql — add them, or list them in BOOT_BACKFILL_ONLY with a reason')
      .toEqual(Object.keys(BOOT_BACKFILL_ONLY).sort());
    for (const [table, reason] of Object.entries(BOOT_BACKFILL_ONLY)) {
      expect(typeof reason === 'string' && reason.trim().length > 0, `BOOT_BACKFILL_ONLY.${table} needs a one-line reason`).toBe(true);
    }
  });

  // The per-table assertions below compare whatever the extractors found, so a
  // regex that silently stopped matching would make every one of them pass on
  // two empty sets. Pin the totals and the two shapes a name-prefix scan used to
  // miss (a gin index, a UNIQUE partial index under a `uq_` name).
  it('the index and trigger extractors see the real statements (no vacuous pass)', () => {
    expect(countEntries(sqlIndexes)).toBeGreaterThan(100);
    expect(countEntries(jsIndexes)).toBeGreaterThan(100);
    expect(sqlIndexes.get('tribe_people')?.get('idx_tribe_people_phones')).toBe('using gin (phones)');
    expect(sqlIndexes.get('ai_harness_bindings')?.get('uq_ai_harness_bindings_variant'))
      .toBe('unique (connection_id, harness_id, variant_key) where harness_id is not null');
    expect(countEntries(sqlTriggers)).toBeGreaterThan(5);
    expect(countEntries(jsTriggers)).toBeGreaterThan(5);
  });

  describe.each(shared)('table %s', (table) => {
    it('has the same columns in both files', () => {
      const sqlCols = extractAllColumns(INIT_SQL, table);
      const jsCols = extractAllColumns(DB_JS, table);
      const sqlOnly = [...sqlCols].filter((c) => !jsCols.has(c));
      const jsOnly = [...jsCols].filter((c) => !sqlCols.has(c));
      expect(sqlOnly, `init-db.sql has columns db/schema lacks (upgraded installs never get them): ${sqlOnly.join(', ')}`).toEqual([]);
      expect(jsOnly, `db/schema has columns init-db.sql lacks (fresh installs never get them): ${jsOnly.join(', ')}`).toEqual([]);
    });

    it('has the same indexes (name and definition) in both files', () => {
      expect(asObject(sqlIndexes.get(table)), `index drift on ${table}`).toEqual(asObject(jsIndexes.get(table)));
    });

    it('has the same non-audit triggers in both files', () => {
      expect(asObject(sqlTriggers.get(table)), `trigger drift on ${table}`).toEqual(asObject(jsTriggers.get(table)));
    });

    it('has the same CHECK literal sets in both files', () => {
      expect(asObject(extractCheckInSets(extractCreateTable(INIT_SQL, table))), `CHECK drift on ${table}`)
        .toEqual(asObject(extractCheckInSets(extractCreateTable(DB_JS, table))));
    });
  });

  it('every function a trigger executes is declared in both files', () => {
    const referenced = new Set();
    for (const byTable of [sqlTriggers, jsTriggers]) {
      for (const table of shared) {
        for (const def of (byTable.get(table) ?? new Map()).values()) referenced.add(def.split('→ ')[1]);
      }
    }
    referenced.add('record_audit_log');
    expect(referenced.size).toBeGreaterThan(5);
    for (const fn of referenced) {
      const re = new RegExp(`CREATE OR REPLACE FUNCTION\\s+${fn}\\b`, 'i');
      expect(re.test(INIT_SQL), `init-db.sql missing CREATE OR REPLACE FUNCTION ${fn}`).toBe(true);
      expect(re.test(DB_JS), `db/schema missing CREATE OR REPLACE FUNCTION ${fn}`).toBe(true);
    }
  });

  // ── Targeted pins: contracts a two-sided set comparison cannot see ──────────

  // The operator-action ledger (#5594) and the human-activity timeline (#2150)
  // rely on their dedupe index as the ON CONFLICT idempotency contract, and on
  // the composites (#5715) to keep a source-scoped read off a full happened_at
  // walk. Spell the expected shapes out: dropping one from BOTH files, or
  // silently losing the DESC ordering, would otherwise read as a passing match.
  it('human_activity_events keeps its dedupe + composite indexes in both files', () => {
    const expected = {
      idx_human_activity_dedupe: 'unique (source, dedupe_key)',
      idx_human_activity_happened: '(happened_at)',
      idx_human_activity_source_happened: '(source, happened_at desc)',
      idx_human_activity_source_kind_happened: '(source, kind, happened_at desc)',
    };
    expect(asObject(sqlIndexes.get('human_activity_events'))).toEqual(expected);
    expect(asObject(jsIndexes.get('human_activity_events'))).toEqual(expected);
  });

  it('user_action_events keeps its dedupe index in both files', () => {
    const expected = [
      'idx_user_action_actor_time',
      'idx_user_action_dedupe',
      'idx_user_action_happened',
      'idx_user_action_type_time',
    ];
    expect([...(sqlIndexes.get('user_action_events') ?? new Map()).keys()].sort()).toEqual(expected);
    expect([...(jsIndexes.get('user_action_events') ?? new Map()).keys()].sort()).toEqual(expected);
    expect(sqlIndexes.get('user_action_events').get('idx_user_action_dedupe')).toMatch(/^unique /);
  });

  // LENS-7: beeper_outbox's `state` CHECK is PortOS's own send-lifecycle state
  // machine (not a Beeper vocabulary), so — unlike beeper_conversations.type —
  // a new state SHOULD cost a two-file schema change. Pin the literal set so a
  // value added to one file's CHECK and not the other (or silently dropped
  // from both) fails here rather than at a runtime INSERT.
  it('beeper_outbox.state CHECK literal set is pinned and matches in both files', () => {
    const expected = new Set(['draft', 'approved', 'sending', 'awaiting-confirmation', 'sent', 'failed']);
    const sqlSet = extractCheckInSet(INIT_SQL, 'beeper_outbox', 'state');
    const jsSet = extractCheckInSet(DB_JS, 'beeper_outbox', 'state');
    expect(sqlSet, 'init-db.sql missing beeper_outbox.state CHECK').not.toBeNull();
    expect(jsSet, 'db/schema/beeper.js missing beeper_outbox.state CHECK').not.toBeNull();
    expect(sqlSet).toEqual(expected);
    expect(jsSet).toEqual(expected);
  });

  // Every column a beeper_* table gained after its first ship needs an
  // additive ALTER on the upgrade path too — a fresh install gets it from the
  // CREATE, an existing one only from here. The column-set parity above would
  // pass with the column inside the JS CREATE alone.
  it('beeper_* additive columns carry an ALTER TABLE for existing installs', () => {
    for (const { table, columns } of [
      { table: 'beeper_messages', columns: ['is_sender'] },
      { table: 'beeper_outbox', columns: ['send_requested_at'] },
      { table: 'beeper_attachments', columns: ['local_path', 'fetched_at', 'unavailable_at', 'fetch_error'] },
      { table: 'beeper_conversations', columns: ['seen_at'] },
    ]) {
      for (const column of columns) {
        const re = new RegExp(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column}\\b`, 'i');
        expect(re.test(DB_JS), `db/schema/beeper.js missing the additive ALTER for ${table}.${column}`).toBe(true);
        expect(extractCreateTable(INIT_SQL, table)).toContain(column);
      }
    }
  });

  // Deletion audit log (incident #1248-follow-up) — the record_audit table, the
  // record_audit_log() trigger function, and the per-content-table `_audit`
  // triggers all live in BOTH DDL sources. A one-sided edit (e.g. auditing a new
  // table only in db/schema) would leave fresh installs un-audited, so lock the
  // set. init-db.sql spells out a `trg_<table>_audit` per table; audit.js
  // builds them from the `auditedTables` array, so parse that array on the JS
  // side rather than matching literal trigger names.
  it('record_audit audit-trigger set matches in both files', () => {
    expect(shared).toContain('record_audit');
    const sqlAuditTables = new Set();
    const re = /CREATE TRIGGER\s+trg_([a-z0-9_]+)_audit\b/gi;
    let m;
    while ((m = re.exec(INIT_SQL)) !== null) sqlAuditTables.add(m[1]);
    const arr = /const auditedTables\s*=\s*\[([\s\S]*?)\]/i.exec(DB_JS);
    expect(arr, 'db/schema/audit.js missing the auditedTables array').toBeTruthy();
    const jsAuditTables = new Set([...arr[1].matchAll(/'([a-z0-9_]+)'/gi)].map((mm) => mm[1]));
    expect(sqlAuditTables.size, 'no _audit triggers found in init-db.sql — DDL broke').toBeGreaterThan(8);
    expect([...sqlAuditTables].sort()).toEqual([...jsAuditTables].sort());
    for (const table of jsAuditTables) expect(shared, `audited table ${table} is not declared in both sources`).toContain(table);
  });

  it('catalog_ingredients type is app-layer-gated (no hardcoded CHECK in either file)', () => {
    // The legacy `CHECK (type IN (...))` was dropped — valid types are gated at
    // the app layer via the INGREDIENT_TYPES registry + Zod enum, so a new type
    // is a registry entry, not a two-file constraint migration. Assert NEITHER
    // file reintroduces a hardcoded `type IN (...)` CHECK (a one-sided re-add
    // would drift the fresh-install and upgrade paths apart again), and that
    // both declare the widened VARCHAR(32) column.
    expect(extractCheckInSet(INIT_SQL, 'catalog_ingredients', 'type'), 'init-db.sql reintroduced a hardcoded type CHECK').toBeNull();
    expect(extractCheckInSet(DB_JS, 'catalog_ingredients', 'type'), 'db/schema reintroduced a hardcoded type CHECK').toBeNull();
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
      expect(jsKeys.has(required), `db/schema search_tsv missing registry FTS field ${required}`).toBe(true);
    }
  });
});
