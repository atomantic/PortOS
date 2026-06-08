/**
 * Registration stub for the legacy file→Postgres artifact prune.
 *
 * Every file→DB migrator (universes, pipeline-issues/series, story-builder,
 * writers-room, creative-director) renames its source aside — `.imported` /
 * `index.json.imported` / `manifest.imported.json` — kept "as a recovery source
 * for at least one release." Nothing ever removed them, so they linger in ./data
 * (multiple MB on a long-lived install) even though the authoritative copy is now
 * in Postgres + the pg_dump. (The deeper `.bak-NNN` monolith backups from the
 * file→file split migrations 034–036 are intentionally NOT pruned — see the
 * SCOPE note in pruneImportedLegacyFiles.js.)
 *
 * The actual prune verifies record identity in Postgres (every parked record id
 * still present) before deleting a recovery copy, but the `scripts/migrations/`
 * runner runs BEFORE the DB pool is up — the same reason migrations 048–053 are
 * boot-time + stub-registered. So the prune runs at boot from
 * `server/scripts/pruneImportedLegacyFiles.js` (after ensureSchema + every
 * store's file→DB warm import), marker-gated in `data/legacy-prune.applied.json`,
 * with a count-vs-marker guard that withholds deletion when the live row count
 * is short of what the migration marker recorded (wiped / restored DB).
 *
 * This stub exists so the change is registered the standard way — it lands in
 * `data/migrations.applied.json` so the migration ledger and `git log` show when
 * the artifact prune was introduced.
 *
 * No-op + idempotent: nothing to do in the file runner.
 */

export default {
  async up() {
    console.log('🧹 legacy-prune: artifact cleanup runs at boot (pruneImportedLegacyFiles.js); nothing to do in the file runner');
  },
};
