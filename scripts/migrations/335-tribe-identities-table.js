/**
 * Registration stub for the `tribe_identities` table (#34, decided on #10).
 *
 * The actual DDL — `CREATE TABLE IF NOT EXISTS tribe_identities` (person_id,
 * kind, network, handle, source, linked_at, UNIQUE (kind, network, handle))
 * plus `idx_tribe_identities_person` — is idempotent and lives in
 * `ensureSchema()` (`server/lib/db/schema/tribe.js`), which runs at server
 * boot AFTER the DB pool is up, and the fresh-install seed
 * (`server/scripts/init-db.sql`). The `scripts/migrations/` runner executes
 * BEFORE the pool is initialized, so a DDL statement cannot live here — the
 * same reason migrations 048-052, 108, 161, and 163
 * (`scripts/migrations/163-tribe-people-phones.js`) are boot-time +
 * stub-registered.
 *
 * This stub exists so the new-table change is *registered the standard way*:
 * it lands in `data/migrations.applied.json` so the migration ledger and
 * `git log` show when `tribe_identities` was introduced. The table is
 * additive (a brand-new, machine-local store) and no backfill is possible —
 * there is no pre-existing local source of network-scoped handles anywhere in
 * PortOS (#10 resolution) — so this stub has nothing to transform.
 *
 * No-op + idempotent: nothing to do here.
 */

export default {
  async up() {
    console.log('🪪 tribe_identities: table + index created idempotently by ensureSchema at boot; nothing to do in the file runner');
  },
};
