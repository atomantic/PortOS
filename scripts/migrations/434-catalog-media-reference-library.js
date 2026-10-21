/**
 * Registration stub for the Casting reference library: the
 * `catalog_ingredient_media.library` JSONB column (variant age/era/wardrobe,
 * tags, render-guide flag).
 *
 * Like 052, the DDL lives in `ensureSchema()` (server/lib/db/schema/catalog.js)
 * and `server/scripts/init-db.sql`, because this runner executes before the DB
 * pool exists. ensureSchema also performs the one-time seeding, gated on the
 * presence of its INPUT (existing portrait / sheet media rows whose `library`
 * is still empty): portraits become render guides, sheet rows get their sheet
 * role as the variant label, and `look:<wardrobeId>` rows get that wardrobe.
 * A row the user already edited has a non-empty `library` and is never
 * touched again. No data.reference seed ships.
 */

export default {
  async up() {
    console.log('🎭 catalog_ingredient_media.library: column + seeding applied idempotently by ensureSchema at boot; nothing to do in the file runner');
  },
};
