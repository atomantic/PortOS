/**
 * One-time importer: data/settings.json `catalogUserTypes` → PostgreSQL (catalog_user_types), #1001.
 * Runs on the first PG-backed access (services/catalogUserTypes/store.js) BEFORE the boot registry
 * warm reads any type.
 *
 *   - The MARKER is the absence of the legacy `catalogUserTypes` key in settings.json; a fresh
 *     install no-ops immediately.
 *   - INSERT … ON CONFLICT (id) DO NOTHING: the DB row is authoritative, so a partial prior run is
 *     never clobbered.
 *   - The legacy slice is RENAMED to `catalogUserTypes_imported` (not deleted) as a recovery
 *     source; nothing reads that key, so it can't resurrect stale types via settings:updated.
 *   - The rename happens only after every insert succeeded, so a crash leaves the live key and
 *     the next boot retries safely.
 *
 * NOT gated via data/migrations.applied.json: that list runs before the DB gate, while this must
 * run only when Postgres is the confirmed-healthy backend (invoked from the backend selector,
 * like migrateCreativeDirectorToDB).
 */

import { query } from '../lib/db.js';
import { mirrorTimestamp } from '../lib/pgTimestamp.js';
import { getSettings, updateSettingsWith } from '../services/settings.js';
import { toPgJson } from '../lib/pgJson.js';

const LEGACY_KEY = 'catalogUserTypes';
const IMPORTED_KEY = 'catalogUserTypes_imported';

// Park the legacy key's value under the recovery key but NEVER overwrite an existing recovery
// copy (the original slice is the one worth keeping); a re-introduced legacy key is dropped.
const renameLegacyAside = (cur) => {
  const { [LEGACY_KEY]: old, ...rest } = cur;
  if (rest[IMPORTED_KEY] !== undefined) return rest; // keep the original recovery copy
  return { ...rest, [IMPORTED_KEY]: old };
};

export async function migrateCatalogUserTypesToDB() {
  const settings = await getSettings();
  const legacy = settings[LEGACY_KEY];

  // No legacy key → already imported on a prior boot, or a fresh install.
  if (legacy === undefined) return { ok: true, reason: 'already-applied', imported: 0 };

  if (!Array.isArray(legacy)) {
    // A hand-edited non-array shouldn't block boot. Rename it aside so the
    // garbage can't keep feeding the registry, but import nothing.
    console.warn(`⚠️ catalog-user-types→DB import: settings.${LEGACY_KEY} is not an array — renaming aside, imported 0`);
    await updateSettingsWith(renameLegacyAside);
    return { ok: false, reason: 'not-an-array', imported: 0 };
  }

  let imported = 0;
  let skipped = 0;
  for (const type of legacy) {
    if (!type || typeof type !== 'object' || typeof type.id !== 'string' || !type.id) {
      skipped += 1;
      continue;
    }
    // Import verbatim — the full definition goes into `data`. The typed mirror
    // columns are bind-sanitized so a hand-edited timestamp can't make the
    // INSERT throw and abort the whole import (which runs during backend init).
    const result = await query(
      `INSERT INTO catalog_user_types (id, data, updated_at, deleted_at)
       VALUES ($1, $2::jsonb, COALESCE($3::timestamptz, NOW()), $4)
       ON CONFLICT (id) DO NOTHING`,
      [type.id, toPgJson(type), mirrorTimestamp(type.updatedAt, null), mirrorTimestamp(type.deletedAt, null)],
    );
    if (result.rowCount > 0) imported += 1;
    else skipped += 1;
  }

  // Rename AFTER all rows land so a crash mid-import leaves the live key and the next boot retries.
  await updateSettingsWith(renameLegacyAside);

  console.log(`🧩 catalog-user-types→DB import: imported ${imported} type(s) into catalog_user_types (${skipped} skipped); settings.${LEGACY_KEY} renamed to ${IMPORTED_KEY}`);
  return { ok: true, reason: 'imported', imported, skipped };
}
