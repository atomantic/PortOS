#!/usr/bin/env node
/**
 * Inspect the deletion audit log (record_audit).
 *
 * Every tombstone / un-tombstone / hard-delete of a user-authored record
 * (universes, pipeline_series, pipeline_issues, story_builder_sessions,
 * writers_room_*, catalog_*, creative_director_projects, lora_training_runs)
 * is logged by a DB trigger — regardless of what caused it (the app, a test
 * suite's raw DELETE, or a manual psql session). This script reads that log so
 * you can answer "what got deleted, when, and by what."
 *
 * Usage:
 *   node scripts/show-deletions.mjs                 # last 50 events, all tables
 *   node scripts/show-deletions.mjs --table=universes
 *   node scripts/show-deletions.mjs --action=hard_delete
 *   node scripts/show-deletions.mjs --since='2026-06-13' --limit=200
 *   node scripts/show-deletions.mjs --id=<recordId> # full history for one record
 *
 * Uses `psql` (like scripts/recover-synced-test-fixtures.mjs) so it needs no
 * node_modules at the repo root. DB connection uses standard PG env
 * (PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE) or pass --port=5432.
 */
import { execFileSync } from 'child_process';

const args = process.argv.slice(2);
const val = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : def;
};

const PORT = val('port', process.env.PGPORT || '5432');
const DB = process.env.PGDATABASE || 'portos';
const HOST = process.env.PGHOST || 'localhost';
const limit = parseInt(val('limit', '50'), 10);

// Build the filter from simple, validated inputs (no string interpolation of
// raw user text into SQL beyond these whitelisted, escaped literals).
const esc = (s) => `'${String(s).replace(/'/g, "''")}'`;
const where = [];
if (val('table')) where.push(`table_name = ${esc(val('table'))}`);
if (val('action')) where.push(`action = ${esc(val('action'))}`);
if (val('id')) where.push(`record_id = ${esc(val('id'))}`);
if (val('since')) where.push(`occurred_at >= ${esc(val('since'))}`);

const sql = `
  SELECT to_char(occurred_at, 'YYYY-MM-DD"T"HH24:MI:SS') || '|' || action || '|' ||
         table_name || '|' || coalesce(record_name, record_id, '?') || '|' ||
         coalesce(actor, 'pid ' || backend_pid || coalesce(' (' || application_name || ')', '')) || '|' ||
         coalesce(regexp_replace(left(source_query, 120), '\\s+', ' ', 'g'), '')
    FROM record_audit
   ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
   ORDER BY occurred_at DESC
   LIMIT ${Number.isFinite(limit) ? limit : 50}`;

const out = execFileSync('psql', ['-h', HOST, '-p', PORT, '-d', DB, '-tAc', sql], {
  encoding: 'utf8',
}).trim();

if (!out) {
  console.log('No matching deletion-audit events.');
} else {
  const lines = out.split('\n');
  console.log(`📜 ${lines.length} event(s) (most recent first):\n`);
  for (const line of lines) {
    const [when, action, table, name, who, query] = line.split('|');
    console.log(`${when}  ${action.toUpperCase().padEnd(12)} ${table}/${name}`);
    console.log(`    by: ${who}`);
    if (query) console.log(`    sql: ${query}`);
  }
}
