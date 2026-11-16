/**
 * Registration stub for the Creative Director project → Creative Commission back-pointer (`project.commissionId`).
 *
 * A commission fire used to SNAPSHOT its LLM pin onto the project (`modelOverrides.{treatment,plan}`), freezing the provider for the project's life (the orphan sweep respawns the stale task verbatim), and nothing linked a project
 * back to its commission, so pausing or deleting it cancelled only the CRON. The pin is now resolved LIVE at dispatch from this id (`creativeCommissions/projectControl.js#commissionStagePin`), which is also how pause/delete finds the projects.
 *
 * Nothing to do in the file runner: (1) no DDL (the field lives in the `creative_director_projects` `data` JSONB and round-trips via `sanitizeProjectForSync` / `mergeProjectRecord`; purely additive, no `PORTOS_SCHEMA_VERSIONS` bump);
 * (2) the backfill needs the DB pool, which this runner runs before (like migrations 048–052, 108, 160–162, 176, 178, 194), so `backfillProjectCommissionIds()` in `services/creativeCommissions/projectControl.js` runs at boot from
 * `bootstrapSequence.js#armCommissionScheduler`: pure data movement, idempotent. Recovery is best-effort (the run ledger is capped at MAX_PERSISTED_RUNS); an unlinked project keeps its pre-change behavior. This stub lands the change in `data/migrations.applied.json`.
 */

export default {
  async up() {
    console.log('🎯 CD project commissionId: additive JSONB field (no DDL); the ledger backfill runs at boot via backfillProjectCommissionIds — nothing to do in the file runner');
  },
};
