/**
 * Registration stub for the friendly-universe-tag data repair.
 *
 * The original bible→catalog backfill stamped MACHINE tags onto every promoted
 * character/place/object — a literal `from-universe` marker plus a
 * `universe:<universeId>` id tag. Those are unreadable in the Catalog UI (a raw
 * UUID means nothing to a human) and leak an internal id into the tag taxonomy.
 * The structured universe link already lives durably in
 * `catalog_ingredient_refs`, so the repair rewrites the machine tags into the
 * friendly universe NAME tag while preserving every user-supplied tag.
 *
 * The actual repair walks every catalog ingredient and PATCHes its tags, so it
 * needs the Postgres pool — but the `scripts/migrations/` runner executes
 * BEFORE the pool is initialized (the same reason migrations 048–052 are
 * boot-time + stub-registered). The repair therefore runs at boot from
 * `server/scripts/repairUniverseTags.js` (after `ensureSchema()` + the bible→
 * catalog backfill), marker-gated in `data/catalog-universe-tags.applied.json`.
 *
 * This stub exists so the change is *registered the standard way*: it lands in
 * `data/migrations.applied.json` so the migration ledger and `git log` show
 * when the friendly-tag repair was introduced.
 *
 * No-op + idempotent: nothing to do in the file runner.
 */

export default {
  async up() {
    console.log('🏷️  friendly universe tags: repair runs at boot (repairUniverseTags.js); nothing to do in the file runner');
  },
};
