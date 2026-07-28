/**
 * Registration stub for the games table and Game collection (#3177).
 *
 * The PostgreSQL DDL is idempotent and lives in ensureSchema(), which runs
 * after the pool is available; the file migration runner executes before that
 * point. Fresh installs receive the matching DDL from server/scripts/init-db.sql.
 * The table is additive, so no data backfill is required. Tests and the
 * unsupported MEMORY_BACKEND=file escape hatch mint the collectionStore v1
 * index lazily on first write.
 */

export default {
  async up() {
    console.log('🎮 games: table created idempotently by ensureSchema at boot; nothing to do in the file runner (#3177)');
  },
};
