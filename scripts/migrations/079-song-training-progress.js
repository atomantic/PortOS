/**
 * Registration stub for song training progress (#1028 — the capstone of the
 * #1021 song-system umbrella).
 *
 * The song shape (`server/services/songs.js`) gained one OPTIONAL,
 * absent-tolerant field — `progress` (`{ history: { <scope>: [attempt…] } }`),
 * a bounded per-scope rolling accuracy history for the memorize/learn/track
 * training mode. It's additive: a legacy song simply has no `progress` field,
 * the sanitizer reads it back unchanged, and the Zod schema treats it as
 * optional, so an older client's payload (no training data) still validates.
 *
 * Because the change is purely additive and the read path is absent-tolerant,
 * there is no on-disk data to rewrite — existing `data/songs.json` records load
 * as-is and gain the field only when the user records a training attempt. This
 * stub ships anyway so the schema bump is RECORDED in
 * `data/migrations.applied.json`: the distribution model is many installs
 * upgrading independently (CLAUDE.md → Distribution model), and a recorded
 * migration is the audit trail showing when the training-progress shape was
 * introduced.
 *
 * No-op + idempotent: nothing to rewrite in the file runner.
 */

export default {
  async up() {
    console.log('🎓 migration 079: song training-progress field is additive/absent-tolerant; nothing to rewrite — recording the schema bump.');
    return { updated: 0, reason: 'additive-no-op' };
  },
};
