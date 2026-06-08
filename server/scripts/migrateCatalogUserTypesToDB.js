/**
 * One-time importer: data/settings.json `catalogUserTypes` → PostgreSQL
 * (catalog_user_types), for Phase 4 lead-in / issue #1001.
 *
 * User-defined ingredient types used to live in the settings blob. As of #1001
 * they live one-row-per-type in Postgres. On the first PG-backed access (from
 * services/catalogUserTypes/store.js, BEFORE the boot registry warm reads any
 * type), this importer copies each legacy type into the table.
 *
 * Idempotency / safety:
 *   - The MARKER is the absence of the legacy `catalogUserTypes` key in
 *     settings.json. Reading settings is already cheap + done at boot, so no
 *     separate marker file is needed (unlike the CD import, whose legacy state
 *     was a standalone file). A fresh install (no key) no-ops immediately.
 *   - INSERT … ON CONFLICT (id) DO NOTHING — a type already in the table (a
 *     partial prior run that crashed before the key was renamed) is never
 *     clobbered. The DB row is authoritative once it exists.
 *   - The legacy slice is RENAMED in place to `catalogUserTypes_imported` (not
 *     deleted) so it survives as a read-only recovery source for at least one
 *     release (Phase 5 note) — mirroring the CD import's `.imported` file
 *     rename. No live consumer reads the renamed key, so it can't drift or
 *     resurrect stale types via the settings:updated registry refresh.
 *   - The rename happens AFTER all rows land, so a crash mid-import leaves the
 *     live key in place → next boot retries (ON CONFLICT DO NOTHING makes the
 *     retry safe). The key is renamed ONLY if every insert succeeded.
 *
 * NOT marker-gated via data/migrations.applied.json: that list is the
 * prompt-replace runner under scripts/migrations/ and runs before the DB gate.
 * This import must run only when Postgres is the confirmed-healthy backend, so
 * it's gated on the settings-key presence and invoked from the backend selector
 * (mirrors migrateCreativeDirectorToDB).
 */

import { query } from '../lib/db.js';
import { mirrorTimestamp } from '../lib/pgTimestamp.js';
import { getSettings, updateSettingsWith } from '../services/settings.js';

const LEGACY_KEY = 'catalogUserTypes';
const IMPORTED_KEY = 'catalogUserTypes_imported';

// Remove the live legacy key, parking its value under the recovery key — but
// NEVER overwrite an existing recovery copy. The original (pre-migration) slice
// is the one worth keeping for a release; a later re-introduced legacy key (a
// restore bundle / hand-edit landing after the migration already ran) is just
// dropped, not promoted over the original recovery copy it would otherwise
// clobber. The DB rows are authoritative regardless.
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
      [type.id, JSON.stringify(type), mirrorTimestamp(type.updatedAt, null), mirrorTimestamp(type.deletedAt, null)],
    );
    if (result.rowCount > 0) imported += 1;
    else skipped += 1;
  }

  // Rename the legacy key aside AFTER all rows land (so a crash mid-import
  // leaves the live key in place → next boot retries the idempotent import).
  // Preserves the original recovery copy if one already exists (see helper).
  await updateSettingsWith(renameLegacyAside);

  console.log(`🧩 catalog-user-types→DB import: imported ${imported} type(s) into catalog_user_types (${skipped} skipped); settings.${LEGACY_KEY} renamed to ${IMPORTED_KEY}`);
  return { ok: true, reason: 'imported', imported, skipped };
}
