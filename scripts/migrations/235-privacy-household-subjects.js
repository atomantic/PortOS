/**
 * Registration stub for the Privacy Center household-subjects slice (issue
 * #3658, epic #2138).
 *
 * The actual DDL — `CREATE TABLE IF NOT EXISTS privacy_subjects`, the seeded
 * `self` row + its consent row, and the `subject_id` ADD COLUMN / backfill /
 * SET DEFAULT / SET NOT NULL sweep across `privacy_vault_records`,
 * `privacy_orgs`, `privacy_org_holdings`, `privacy_change_events`,
 * `privacy_broker_cases`, and `privacy_consents` — is idempotent and lives in
 * `server/lib/db/schema/privacy.js` (run by `ensureSchema()` at boot) plus the
 * fresh-install seed `server/scripts/init-db.sql`.
 *
 * It cannot live here: the `scripts/migrations/` runner executes BEFORE the DB
 * pool is initialized, which is the same reason migrations 048–052, 108,
 * 160/161/162, 176, and 178 are boot-time + stub-registered.
 *
 * This stub exists so the change is *registered the standard way* — it lands in
 * `data/migrations.applied.json` so the migration ledger and `git log` show when
 * multi-subject scoping was introduced.
 *
 * Backward compatibility: every pre-existing row backfills to the seeded `self`
 * subject and every `subject_id` column defaults to it, so an install that never
 * adds a second household member sees no behavioral change. The one widening
 * that is NOT purely additive is the broker-case uniqueness index, which moves
 * from `(broker_id)` to `(broker_id, subject_id)` — the boot DDL drops the old
 * single-column index and creates the pair index after `subject_id` exists.
 *
 * No-op + idempotent: nothing to do here.
 */

export default {
  async up() {
    console.log('👥 privacy_subjects: table + subject_id scoping applied idempotently by ensureSchema at boot; nothing to do in the file runner');
  },
};
