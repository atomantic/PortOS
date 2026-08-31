/**
 * Register machine-local character voice profiles (issue #5380).
 *
 * The additive `voice_profiles` / `voice_profile_renders` DDL lives in `ensureSchema()` and
 * `server/scripts/init-db.sql`: this runner is intentionally before the
 * database pool exists, so it only records the rollout in the migration
 * ledger. New installs receive the same idempotent schema at boot.
 */

export default {
  async up() {
    console.log('🎙️ voice profile tables created idempotently by ensureSchema at boot; nothing to do in the file runner');
  },
};
