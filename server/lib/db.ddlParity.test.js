/**
 * Fresh-install schema guard (#16092). `server/scripts/init-db.sql` is GENERATED
 * from the per-domain modules under `server/lib/db/schema/` (the DDL
 * `ensureSchema()` runs on every boot) plus the hand-written
 * `server/scripts/init-db.base.sql`, by `scripts/generate-init-db-sql.js`. So the
 * fresh-install and upgrade paths share one source, and the old two-file
 * structural comparison is replaced by a staleness check: the committed file must
 * equal the generator's output.
 *
 * The targeted pins below guard contracts that one source can still break on
 * both paths at once — an index, CHECK value or trigger clock dropped from the
 * module reads as a valid generated file. They read the generated SQL, which
 * holds every statement ensureSchema() runs. A database built from the generated
 * file is compared with one built by ensureSchema() in
 * `server/lib/db/schema/initDbSql.db.test.js`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { REQUIRED_DB_EXTENSIONS } from './db/extensions.js';
import { FTS_PAYLOAD_FIELDS } from './catalog/catalogTypes.js';
import {
  INIT_DB_BASE_PATH, INIT_DB_SQL_PATH, SCHEMA_MODULES_MARKER, generateInitDbSql,
} from '../../scripts/generate-init-db-sql.js';

const INIT_SQL = readFileSync(INIT_DB_SQL_PATH, 'utf8');
const BASE_SQL = readFileSync(INIT_DB_BASE_PATH, 'utf8');

function extractCreateTable(source, table) {
  const m = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(([\\s\\S]*?)\\)\\s*;`, 'i').exec(source);
  return m ? m[1].replace(/--[^\n]*\n/g, '\n').replace(/\s+/g, ' ').trim() : null;
}

// Every index keyed by the table its ON clause names, as a normalized definition
// that keeps UNIQUE, the access method, the column list and a partial predicate.
function extractIndexesByTable(source) {
  const out = new Map();
  const re = /CREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+(\w+)\s+ON\s+(\w+)\s*(?:USING\s+(\w+)\s*)?\(([^)]*)\)(?:\s*(WHERE\s+[^;]*?))?\s*;/gi;
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

const extractCheckInSet = (source, table, column) => {
  const re = /CHECK\s*\(\s*(\w+)\s+IN\s*\(([^)]*)\)\s*\)/gi;
  let m;
  while ((m = re.exec(extractCreateTable(source, table) ?? '')) !== null) {
    if (m[1] === column) return new Set(m[2].split(',').map((s) => s.replace(/['"\s]/g, '')).filter(Boolean));
  }
  return null;
};

const asObject = (map) => Object.fromEntries(map ?? []);

describe('init-db.sql (generated from db/schema)', () => {
  const indexes = extractIndexesByTable(INIT_SQL);

  it('matches the generator output — run `node scripts/generate-init-db-sql.js` after a schema module change', () => {
    expect(INIT_SQL === generateInitDbSql(), 'server/scripts/init-db.sql is stale').toBe(true);
  });

  it('requires the same extensions as the hand-written base schema', () => {
    const declarations = BASE_SQL.matchAll(/^\s*CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"((?:""|[^"])+)"|([\w$]+))/gim);
    const extensions = Array.from(declarations, ([, quoted, bare]) => quoted?.replaceAll('""', '"') ?? bare.toLowerCase());
    expect([...REQUIRED_DB_EXTENSIONS].sort()).toEqual(extensions.sort());
  });

  // The base file is for what ensureSchema() must not run on every boot. A table
  // declared there would reach fresh installs only, never an upgraded one.
  it('the hand-written base declares only the memory system tables', () => {
    expect(BASE_SQL.split('\n').filter((line) => line === SCHEMA_MODULES_MARKER)).toHaveLength(1);
    const tables = [...BASE_SQL.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/gi)].map((m) => m[1]).sort();
    expect(tables).toEqual(['memories', 'memory_links']);
  });

  // ── Targeted pins: contracts one source can break on both install paths ────

  // #12500: a transaction-start NOW() clock would let LWW ties lose writes.
  it('every catalog LWW trigger stamps the monotonic change clock', () => {
    expect(INIT_SQL).toMatch(/CREATE OR REPLACE FUNCTION catalog_next_change_clock\(previous TIMESTAMPTZ\)/);
    for (const fn of ['update_catalog_ingredient_timestamp', 'update_catalog_scrap_timestamp', 'update_catalog_ref_sync_seq',
      'update_catalog_relation_sync_seq', 'update_catalog_media_sync_seq', 'update_catalog_tag_timestamp']) {
      const body = new RegExp(`CREATE OR REPLACE FUNCTION ${fn}\\(\\)([\\s\\S]*?)\\$\\$ LANGUAGE plpgsql`).exec(INIT_SQL)?.[1];
      expect(body, fn).toContain('NEW.updated_at := catalog_next_change_clock(OLD.updated_at)');
      expect(body, fn).not.toMatch(/NEW\.updated_at := NOW\(\)/);
    }
  });

  // The operator-action ledger (#5594) and the human-activity timeline (#2150)
  // rely on their dedupe index as the ON CONFLICT idempotency contract, and on
  // the composites (#5715) to keep a source-scoped read off a full happened_at walk.
  it('human_activity_events keeps its dedupe and query indexes', () => {
    expect(asObject(indexes.get('human_activity_events'))).toEqual({
      idx_human_activity_account_happened: '(account_id, happened_at desc) where account_id is not null',
      idx_human_activity_dedupe: 'unique (source, dedupe_key)',
      idx_human_activity_happened: '(happened_at)',
      idx_human_activity_happened_id: '(happened_at desc, id desc)',
      idx_human_activity_participants: 'using gin (participants jsonb_path_ops)',
      idx_human_activity_source_happened: '(source, happened_at desc)',
      idx_human_activity_source_kind_happened: '(source, kind, happened_at desc)',
    });
  });

  it('user_action_events keeps its dedupe and query indexes', () => {
    expect([...(indexes.get('user_action_events') ?? new Map()).keys()].sort()).toEqual([
      'idx_user_action_actor_time',
      'idx_user_action_dedupe',
      'idx_user_action_happened',
      'idx_user_action_happened_id',
      'idx_user_action_type_time',
    ]);
    expect(indexes.get('user_action_events').get('idx_user_action_dedupe')).toMatch(/^unique /);
  });

  // LENS-7: beeper_outbox's `state` CHECK is PortOS's own send-lifecycle state
  // machine, so a value silently dropped from it fails here, not at an INSERT.
  it('beeper_outbox.state CHECK literal set is pinned', () => {
    expect(extractCheckInSet(INIT_SQL, 'beeper_outbox', 'state'))
      .toEqual(new Set(['draft', 'approved', 'sending', 'awaiting-confirmation', 'sent', 'failed']));
  });

  // A column a beeper_* table gained after its first ship reaches existing
  // installs only through an additive ALTER; inside the CREATE alone it would
  // reach fresh installs only.
  it('beeper_* additive columns carry an ALTER TABLE for existing installs', () => {
    for (const { table, columns } of [
      { table: 'beeper_messages', columns: ['is_sender'] },
      { table: 'beeper_outbox', columns: ['send_requested_at'] },
      { table: 'beeper_attachments', columns: ['local_path', 'fetched_at', 'unavailable_at', 'fetch_error'] },
      { table: 'beeper_conversations', columns: ['seen_at'] },
    ]) {
      for (const column of columns) {
        expect(INIT_SQL, `${table}.${column}`).toMatch(new RegExp(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column}\\b`, 'i'));
      }
    }
  });

  // Valid ingredient types are gated at the app layer (INGREDIENT_TYPES + Zod)
  // and Beeper chat types are stored raw, so a new type is never a constraint migration.
  it('catalog_ingredients and beeper_conversations type are app-layer-gated (no hardcoded CHECK)', () => {
    expect(extractCheckInSet(INIT_SQL, 'catalog_ingredients', 'type')).toBeNull();
    expect(extractCheckInSet(INIT_SQL, 'beeper_conversations', 'type')).toBeNull();
    expect(extractCreateTable(INIT_SQL, 'catalog_ingredients')).toMatch(/type VARCHAR\(32\)/i);
  });

  // The registry is the single source of the payload keys the FTS column must
  // index; a type's `ftsFields` missing from the generated expression would be
  // silently unsearchable.
  it('search_tsv indexes every registry FTS payload field', () => {
    const keys = new Set([...INIT_SQL.matchAll(/payload->>'([a-zA-Z0-9_]+)'/g)].map((m) => m[1]));
    expect(FTS_PAYLOAD_FIELDS.length, 'registry declares no FTS payload fields').toBeGreaterThan(0);
    for (const required of FTS_PAYLOAD_FIELDS) expect(keys.has(required), required).toBe(true);
  });
});
