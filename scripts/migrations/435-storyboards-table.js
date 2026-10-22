/**
 * Registration stub for the storyboards table (Create › Storyboards). The
 * table itself is created idempotently by ensureSchema at boot
 * (server/lib/db/schema/media.js) — this stub records when the domain arrived
 * on an install. Mirrors 287-fableloom-table.js.
 */

export default {
  async up() {
    console.log('🎬 storyboards: table created idempotently by ensureSchema at boot; nothing to do in the file runner');
  },
};
