/**
 * Registration stub for the storyboard_recipes table (the Make tab's saved
 * recipe library). The table itself is created idempotently by ensureSchema
 * at boot (server/lib/db/schema/media.js) — this stub records when the domain
 * arrived on an install. Mirrors 435-storyboards-table.js.
 */

export default {
  async up() {
    console.log('🧩 storyboard recipes: table created idempotently by ensureSchema at boot; nothing to do in the file runner');
  },
};
