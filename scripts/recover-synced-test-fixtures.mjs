#!/usr/bin/env node
/**
 * One-off recovery: undo the "tests wrote to the real Postgres + federated
 * fixtures to peers" incident (see memoryBackend.js fix — test mode now bypasses
 * a healthy DB).
 *
 * What happened: on machines with a live `portos` DB, the test suite created
 * hundreds of fixture universes/series and tombstoned the user's real records.
 * Fixtures are tiny (~700B–3KB of JSON); real authored universes/series are much
 * larger — so a size threshold separates them cleanly with a wide safety gap.
 *
 * This script (per machine):
 *   1. RESTORES real records that were tombstoned by test cleanup (data >=
 *      threshold AND the JSONB `data.deleted` is true) → clears `data.deleted` +
 *      `data.deletedAt`, bumps `data.updatedAt`, and resyncs the row columns.
 *      The app reads deleted-state from the JSONB, NOT the row's `deleted`
 *      column, so flipping only the column leaves records invisible in the UI.
 *   2. PURGES fixture records (data < threshold), whether live or deleted.
 *   3. PRUNES data/sharing/peer_subscriptions.json of subscriptions that point
 *      at records no longer present.
 *   4. LISTS writers_room_works for MANUAL review (a short real work can be
 *      small, so we never auto-purge WR by size — you decide by name).
 *
 * SAFETY: dry-run by default. Re-run with `--apply` to mutate. Stop the
 * portos-server first (`pm2 stop portos-server`) so sync can't race the cleanup,
 * and take a backup:
 *   pg_dump -h localhost -p <port> -d portos -t universes -t pipeline_series \
 *           -t writers_room_works -f backup.sql
 *
 * Thresholds are overridable: --uni-threshold=5000 --ser-threshold=2000
 * DB connection uses standard PG env (PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE)
 * or pass --port=5432.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : def;
};

const APPLY = has('--apply');
const UNI_THRESHOLD = Number(val('uni-threshold', 5000));
const SER_THRESHOLD = Number(val('ser-threshold', 2000));
const PORT = val('port', process.env.PGPORT || '5432');
const DB = process.env.PGDATABASE || 'portos';
const HOST = process.env.PGHOST || 'localhost';
const DATA_ROOT = val('data-root', join(process.cwd(), 'data'));

const psql = (sql) =>
  execFileSync('psql', ['-h', HOST, '-p', PORT, '-d', DB, '-tAc', sql], {
    encoding: 'utf8',
  }).trim();

const log = (m) => console.log(m);
const mode = APPLY ? '🔧 APPLY' : '🔎 DRY-RUN';
log(`${mode} — recover synced test fixtures  (uni<${UNI_THRESHOLD}B, ser<${SER_THRESHOLD}B = fixture)`);
log(`   DB: ${HOST}:${PORT}/${DB}\n`);

// The deleted state that the app actually reads lives INSIDE the `data` JSONB
// (the row's `deleted` column is just a denormalized index). Restore must clear
// `data.deleted` (+ `data.deletedAt`) and bump `data.updatedAt`, then resync the
// columns — flipping only the column leaves the record invisible in the UI.
const jsonbTombstoned = (col = 'data') => `(${col}->>'deleted')::boolean IS TRUE`;
const restoreSql = (table, threshold) => `
UPDATE ${table}
SET data = jsonb_set((data - 'deletedAt'), '{deleted}', 'false'::jsonb)
           || jsonb_build_object('updatedAt', to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
    deleted = false, deleted_at = NULL, updated_at = now()
WHERE ${jsonbTombstoned()} AND length(data::text) >= ${threshold};`;

// ---- Universes ----
const uniRestore = Number(psql(`SELECT count(*) FROM universes WHERE ${jsonbTombstoned()} AND length(data::text) >= ${UNI_THRESHOLD}`));
const uniPurge = Number(psql(`SELECT count(*) FROM universes WHERE length(data::text) < ${UNI_THRESHOLD}`));
log(`Universes:  restore ${uniRestore} tombstoned-real  |  purge ${uniPurge} fixtures`);
log('  Real universes that will be LIVE after restore:');
log(psql(
  `SELECT '    - '||name||'  ('||length(data::text)||'B)' FROM universes WHERE length(data::text) >= ${UNI_THRESHOLD} ORDER BY name`,
) || '    (none)');

// ---- Series ----
const serRestore = Number(psql(`SELECT count(*) FROM pipeline_series WHERE ${jsonbTombstoned()} AND length(data::text) >= ${SER_THRESHOLD}`));
const serPurge = Number(psql(`SELECT count(*) FROM pipeline_series WHERE length(data::text) < ${SER_THRESHOLD}`));
log(`\nSeries:  restore ${serRestore} tombstoned-real  |  purge ${serPurge} fixtures`);
log('  Real series that will be LIVE after restore:');
log(psql(
  `SELECT '    - '||name||'  ('||length(data::text)||'B)' FROM pipeline_series WHERE length(data::text) >= ${SER_THRESHOLD} ORDER BY name`,
) || '    (none)');

// ---- Writers Room (manual review only) ----
log('\nWriters Room works (MANUAL review — not auto-purged; delete the test ones by name yourself):');
log(psql(
  `SELECT '    - '||title||'  ('||length(data::text)||'B)'||CASE WHEN deleted THEN ' [deleted]' ELSE '' END FROM writers_room_works ORDER BY length(data::text) DESC`,
) || '    (none)');

if (!APPLY) {
  log('\nDry-run only. Re-run with --apply to execute (after stopping portos-server + backup).');
  process.exit(0);
}

// ---- APPLY ----
log('\n🔧 Applying…');
const out = execFileSync('psql', ['-h', HOST, '-p', PORT, '-d', DB, '-v', 'ON_ERROR_STOP=1'], {
  encoding: 'utf8',
  input: `
BEGIN;
${restoreSql('universes', UNI_THRESHOLD)}
DELETE FROM universes WHERE length(data::text) < ${UNI_THRESHOLD};
${restoreSql('pipeline_series', SER_THRESHOLD)}
DELETE FROM pipeline_series WHERE length(data::text) < ${SER_THRESHOLD};
COMMIT;
`,
});
log(out.trim());

// ---- Prune peer_subscriptions.json ----
const subsPath = join(DATA_ROOT, 'sharing', 'peer_subscriptions.json');
if (existsSync(subsPath)) {
  const uniIds = new Set(psql(`SELECT id FROM universes WHERE ${jsonbTombstoned()} IS NOT TRUE`).split('\n').filter(Boolean));
  const serIds = new Set(psql(`SELECT id FROM pipeline_series WHERE ${jsonbTombstoned()} IS NOT TRUE`).split('\n').filter(Boolean));
  copyFileSync(subsPath, `${subsPath}.bak`);
  const j = JSON.parse(readFileSync(subsPath, 'utf8'));
  const subs = Array.isArray(j.subscriptions) ? j.subscriptions : [];
  const before = subs.length;
  j.subscriptions = subs.filter((s) => {
    if (s.recordKind === 'universe') return uniIds.has(s.recordId);
    if (s.recordKind === 'series') return serIds.has(s.recordId);
    return true; // keep mediaCollection + other kinds
  });
  writeFileSync(subsPath, JSON.stringify(j, null, 2));
  log(`peer_subscriptions.json: ${before} -> ${j.subscriptions.length} (pruned ${before - j.subscriptions.length} dead; .bak saved)`);
}

log('\n✅ Done. Universes live: ' + psql(`SELECT count(*) FROM universes WHERE ${jsonbTombstoned()} IS NOT TRUE`) +
    ', series live: ' + psql(`SELECT count(*) FROM pipeline_series WHERE ${jsonbTombstoned()} IS NOT TRUE`));
log('   Clean every federated machine while sync is paused, then `pm2 start portos-server` to resume.');
