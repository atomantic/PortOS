/**
 * Per-record catalog payload schemaVersion migration.
 *
 * Every `catalog_ingredients` row carries `payload.schemaVersion` (stamped at
 * create time by `catalogDB.createIngredient`). When a TYPE's payload shape
 * evolves, the registry (`server/lib/catalogTypes.js`) bumps that type's
 * `payloadSchemaVersion` and registers `payloadUpgraders` keyed by FROM
 * version. This script walks every row whose stored `payload.schemaVersion`
 * is below the registry-current for its type and applies the upgrader chain,
 * persisting the upgraded payload (which re-stamps `schemaVersion` to current).
 *
 * Distinct from:
 *   - the cross-instance WIRE contract (`PORTOS_SCHEMA_VERSIONS.catalog`),
 *     which gates whether a peer push is even accepted; and
 *   - the storage-LAYOUT version (Postgres tables) handled by `ensureSchema`.
 * This is the per-record payload-SHAPE version, mirroring the
 * `data/{type}/index.json` `schemaVersion` convention documented in CLAUDE.md.
 *
 * Idempotency: a marker in `data/catalog-payload.applied.json` records the
 * highest registry payload version this install has fully migrated to, so the
 * walk only runs when a new code version actually raised a type's
 * `payloadSchemaVersion`. The per-row predicate (`stored < current`) is itself
 * idempotent, so re-running is always safe.
 *
 * Invoked from server/index.js at boot, after `ensureSchema()` (it needs the
 * tables) and alongside `migrateBibleToCatalog` — both are DB walks that can't
 * ride the pre-DB `scripts/migrations/` file runner.
 */

import { readMarker, writeMarker } from '../lib/migrationMarker.js';
import { query } from '../lib/db.js';
import { CATALOG_TYPES, currentPayloadSchemaVersion, upgradePayload } from '../lib/catalogTypes.js';

const MARKER_FILENAME = 'catalog-payload.applied.json';

// The aggregate "fully-migrated-to" version is the max payloadSchemaVersion
// across all types. When code bumps any type past this, the marker is stale
// and the walk runs. (A per-type marker would be finer-grained but the walk's
// row predicate is already per-type, so a single high-water mark is enough to
// skip the no-op boot scan on an already-migrated install.)
const targetHighWater = () => Math.max(...CATALOG_TYPES.map((t) => t.payloadSchemaVersion));

/**
 * Walk one type's below-current rows and apply the upgrader chain. Returns the
 * number of rows upgraded. Rows whose stored `schemaVersion` is absent are
 * treated as v1 (the original shape) by `upgradePayload`.
 *
 * Only types that declare at least one upgrader are walked — a type that
 * bumped its version without registering an upgrader has nothing to apply, and
 * `upgradePayload` would only re-stamp the marker (harmless but pointless work
 * across potentially many rows), so we skip it.
 */
async function migrateType(type) {
  const current = currentPayloadSchemaVersion(type.id);
  if (current <= 1) return 0;
  if (!type.payloadUpgraders || Object.keys(type.payloadUpgraders).length === 0) return 0;

  // `payload->>'schemaVersion'` is text; a missing key yields NULL → treated as
  // below-current. `COALESCE(...,'1')::int` lets the comparison run in SQL.
  const result = await query(
    `SELECT id, payload FROM catalog_ingredients
      WHERE type = $1
        AND deleted = false
        AND COALESCE((payload->>'schemaVersion')::int, 1) < $2`,
    [type.id, current],
  );

  let upgraded = 0;
  for (const row of result.rows) {
    const next = upgradePayload(type.id, row.payload || {});
    await query(
      `UPDATE catalog_ingredients SET payload = $2::jsonb WHERE id = $1`,
      [row.id, JSON.stringify(next)],
    );
    upgraded++;
  }
  return upgraded;
}

/**
 * Public entry point. No-ops when the marker shows this install is already at
 * (or above) the current high-water version, unless `force` is set.
 */
export async function migrateCatalogPayload({ force = false } = {}) {
  const highWater = targetHighWater();
  const marker = await readMarker(MARKER_FILENAME);
  if (!force && marker?.highWater >= highWater) {
    return { skipped: true, marker };
  }

  console.log(`🧬 catalog payload migration: starting (target v${highWater})`);
  const totals = { typesWalked: 0, upgraded: 0 };
  for (const type of CATALOG_TYPES) {
    const n = await migrateType(type);
    if (n > 0) {
      totals.typesWalked++;
      totals.upgraded += n;
      console.log(`🧬 ${type.id}: upgraded ${n} row(s) to v${currentPayloadSchemaVersion(type.id)}`);
    }
  }

  const payload = { highWater, completedAt: new Date().toISOString(), stats: totals };
  await writeMarker(MARKER_FILENAME, payload);
  console.log(`🧬 catalog payload migration: ${totals.upgraded} row(s) upgraded across ${totals.typesWalked} type(s)`);
  return { skipped: false, ...payload };
}
