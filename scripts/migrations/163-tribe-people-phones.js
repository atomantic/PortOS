/**
 * Registration stub for the `tribe_people.phones` column + GIN index (issue #2151).
 *
 * The actual DDL — `ALTER TABLE tribe_people ADD COLUMN IF NOT EXISTS phones
 * TEXT[] DEFAULT '{}'` plus `CREATE INDEX IF NOT EXISTS idx_tribe_people_phones
 * ... USING gin (phones)` — is idempotent and lives in `ensureSchema()`
 * (`server/lib/db.js`), which runs at server boot AFTER the DB pool is up. The
 * `scripts/migrations/` runner executes BEFORE the pool is initialized, so a
 * DDL statement cannot live here — the same reason migrations 048–052, 108, and
 * 161 are boot-time + stub-registered.
 *
 * This stub exists so the schema change is *registered the standard way*: it
 * lands in `data/migrations.applied.json` so the migration ledger and `git log`
 * show when `tribe_people.phones` was introduced. The column is additive
 * (mirroring the existing `emails[]`), defaults to `'{}'`, and needs no data
 * backfill — the iMessage sync (#2151) and the Tribe person editor populate it
 * going forward.
 *
 * No-op + idempotent: nothing to do here.
 */

export default {
  async up() {
    console.log('📞 tribe_people.phones: column + GIN index created idempotently by ensureSchema at boot; nothing to do in the file runner');
  },
};
