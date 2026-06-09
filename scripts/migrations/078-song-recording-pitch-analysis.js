/**
 * Registration stub for per-take pitch analysis on song recordings (#1027).
 *
 * The `Recording` shape (`server/services/songs.js`) gained two OPTIONAL,
 * absent-tolerant fields — `pitchTrack` (a bounded, downsampled tuner trace) and
 * `accuracy` (a color-match summary) — so the tuner history and grading aren't
 * recomputed on every open. Both are additive: a legacy take simply has neither
 * field, the sanitizer reads it back unchanged, and the Zod schema treats both as
 * optional, so an older client's payload (no pitch analysis) still validates.
 *
 * Because the change is purely additive and the read path is absent-tolerant,
 * there is no on-disk data to rewrite — existing `data/songs.json` records load
 * as-is and gain the fields only when the user records a scored take. This stub
 * ships anyway so the schema bump is RECORDED in `data/migrations.applied.json`:
 * the distribution model is many installs upgrading independently (CLAUDE.md →
 * Distribution model), and a recorded migration is the audit trail showing when
 * the new recording shape was introduced.
 *
 * No-op + idempotent: nothing to rewrite in the file runner.
 */

export default {
  async up() {
    console.log('🎤 migration 078: song recording pitch-analysis fields are additive/absent-tolerant; nothing to rewrite — recording the schema bump.');
    return { updated: 0, reason: 'additive-no-op' };
  },
};
