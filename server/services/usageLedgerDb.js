/**
 * Storage: `db-primary`. Aggregate buckets and exact reconciliation evidence
 * commit together. Markers stay machine-local and outside the hot ledger.
 */
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { query, withTransaction } from '../lib/db.js';
import { normalizePgString, toPgJson } from '../lib/pgJson.js';
import { readJSONFile } from '../lib/fileUtils.js';

const BUCKET_GROUPS = ['dailyActivity', 'monthlyActivity', 'byProvider', 'byModel'];
const MARKER_GROUPS = ['reconciledRuns', 'siblingReconciledRuns', 'grokRepairIds'];
const META = 'totals';

// Provider and model names come from older files and callers with no fixed
// length limit. Index a fixed-size key even when the stored name is lengthy.
function bucketRow(bucket, key, value) {
  return { bucket, key, key_hash: createHash('sha256').update(normalizePgString(key)).digest('hex'), value };
}

function bucketChanges(previous, next, compare) {
  const totals = { ...next };
  const changes = [];
  for (const group of MARKER_GROUPS) delete totals[group];
  for (const group of BUCKET_GROUPS) {
    delete totals[group];
    if (previous?.[group] === next[group]) continue;
    const before = previous?.[group] ?? {};
    const after = next[group] ?? {};
    for (const [key, value] of Object.entries(after)) {
      if (!compare(before[key], value)) changes.push(bucketRow(group, key, value));
    }
    for (const key of Object.keys(before)) {
      if (!Object.hasOwn(after, key)) changes.push(bucketRow(group, key, null));
    }
  }
  changes.push(bucketRow(META, '', totals));
  return changes;
}

function markerChanges(before, next) {
  const changes = [];
  for (const kind of MARKER_GROUPS.slice(0, 2)) {
    const old = before[kind] ?? {};
    const current = next[kind] ?? {};
    for (const [id, value] of Object.entries(current)) {
      if (isDeepStrictEqual(old[id], value)) continue;
      const claimAt = Array.isArray(value?.codexHighWater) && value.codexHighWater.length
        ? Date.parse(value.at) : NaN;
      changes.push({ kind, id, value, claim_at: Number.isFinite(claimAt) ? claimAt : null });
    }
    for (const id of Object.keys(old)) {
      if (!Object.hasOwn(current, id)) changes.push({ kind, id, value: null });
    }
  }
  for (const id of next.grokRepairIds ?? []) {
    if (typeof id === 'string' && id) changes.push({ kind: 'grokRepairIds', id, value: true });
  }
  return changes;
}

async function writeBuckets(client, changes) {
  const removed = changes.filter(({ value }) => value === null);
  if (removed.length) {
    await client.query(`
      DELETE FROM usage_ledger_buckets AS bucket
      USING jsonb_to_recordset($1::jsonb) AS incoming(bucket text, key_hash text)
      WHERE (bucket.bucket, bucket.key_hash) = (incoming.bucket, incoming.key_hash)
    `, [toPgJson(removed)]);
  }
  await client.query(`
    INSERT INTO usage_ledger_buckets (bucket, key_hash, key, value)
    SELECT bucket, key_hash, key, value
    FROM jsonb_to_recordset($1::jsonb) AS incoming(bucket text, key_hash text, key text, value jsonb)
    ON CONFLICT (bucket, key_hash) DO UPDATE SET value = EXCLUDED.value
  `, [toPgJson(changes.filter(({ value }) => value !== null))]);
}

async function writeMarkers(client, changes, preserveExisting = false) {
  const removed = changes.filter(({ value }) => value === null);
  const written = changes.filter(({ value }) => value !== null);
  if (removed.length) {
    await client.query(`
      DELETE FROM usage_ledger_markers AS marker
      USING jsonb_to_recordset($1::jsonb) AS incoming(kind text, id text)
      WHERE (marker.kind, marker.id) = (incoming.kind, incoming.id)
    `, [toPgJson(removed)]);
  }
  for (let offset = 0; offset < written.length; offset += 1000) {
    await client.query(`
      INSERT INTO usage_ledger_markers (kind, id, value, claim_at)
      SELECT DISTINCT ON (kind, id) kind, id, value, claim_at
      FROM jsonb_to_recordset($1::jsonb) AS incoming(kind text, id text, value jsonb, claim_at bigint)
      ON CONFLICT (kind, id) DO UPDATE SET value = EXCLUDED.value, claim_at = EXCLUDED.claim_at
      WHERE NOT $2::boolean
    `, [toPgJson(written.slice(offset, offset + 1000)), preserveExisting]);
  }
}

export async function importLegacyUsageLedger(client, path) {
  // An empty initialized ledger (including a reset) is still authoritative.
  // Keep the old JSON readable for upgrades and old file-only snapshots.
  await client.query("SELECT pg_advisory_xact_lock(hashtext('portos.usageLedgerImport'))");
  const { rowCount } = await client.query("SELECT 1 FROM usage_ledger_buckets WHERE bucket = 'totals' AND key = ''");
  if (rowCount) return;
  const legacy = await readJSONFile(path, null, { strict: true });
  if (legacy === null) return;
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) {
    throw new Error('Legacy usage ledger must contain a JSON object');
  }
  await writeBuckets(client, bucketChanges(null, legacy, Object.is));
  await writeMarkers(client, markerChanges({}, legacy));
}

export async function readUsageLedger(client = { query }) {
  const { rows } = await client.query('SELECT bucket, key, value FROM usage_ledger_buckets ORDER BY bucket, key');
  const totals = rows.find(({ bucket }) => bucket === META)?.value;
  if (!totals) return null;
  for (const group of BUCKET_GROUPS) {
    totals[group] = Object.fromEntries(rows.filter(({ bucket }) => bucket === group)
      .map(({ key, value }) => [key, value]));
  }
  return totals;
}

export async function readUsageMarkers(kind, { ids = null, since = null, claimsOnly = false } = {}) {
  if (ids?.length === 0) return [];
  const { rows } = await query(`
    SELECT id, value FROM usage_ledger_markers
    WHERE kind = $1
      AND ($2::text[] IS NULL OR id = ANY($2))
      AND ($3::bigint IS NULL OR claim_at >= $3)
      AND (NOT $4::boolean OR value ? 'codexHighWater')
    ORDER BY id
  `, [kind, ids, since, claimsOnly]);
  return rows;
}

export async function readUsageLedgerExport() {
  return withTransaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows: [table] } = await client.query("SELECT to_regclass('usage_ledger_buckets') AS name");
    if (!table.name) return null;
    const aggregates = await readUsageLedger(client);
    if (!aggregates) return null;
    const { rows } = await client.query('SELECT kind, id, value FROM usage_ledger_markers ORDER BY kind, id');
    for (const kind of MARKER_GROUPS) {
      const markers = rows.filter((row) => row.kind === kind);
      aggregates[kind] = kind === 'grokRepairIds'
        ? markers.map(({ id }) => id)
        : Object.fromEntries(markers.map(({ id, value }) => [id, value]));
    }
    return aggregates;
  });
}

export async function writeUsageLedger(previous, next, { markers, reset, copyOnWrite }) {
  const changes = bucketChanges(previous, next, copyOnWrite ? Object.is : isDeepStrictEqual);
  const updates = markerChanges(markers, next);
  await withTransaction(async (client) => {
    if (reset) {
      await client.query('DELETE FROM usage_ledger_markers');
      await client.query("DELETE FROM usage_ledger_buckets WHERE bucket <> 'totals'");
    }
    await writeBuckets(client, changes);
    // Live batches only add markers. Keep the first durable transcript
    // boundary on conflict without fetching historical markers up front.
    await writeMarkers(client, updates, copyOnWrite);
  });
}
