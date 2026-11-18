/**
 * Shared vocabulary for the creative tool registry (#2183, CDO Phase 1).
 *
 * Cost classes drive the dispatch budget gate: `free` tools (record creation,
 * DB reads) never charge; `llm` and `render` tools charge one autonomous action
 * against the daily budget. `longRunning` tools return a handle immediately and
 * complete via events (media jobs, autopilot). `destructive` tools (delete /
 * overwrite) are excluded from the default spec set an agent prompt sees.
 */

export { COST_FREE, COST_LLM, COST_RENDER, COST_CLASSES, BUDGETED_COST_CLASSES } from '../../../lib/creativeDirectorPresets.js';

/**
 * Owner tag for a media job enqueued through the orchestrator. Free-form string
 * used only for `listJobs({ owner })` filtering (no enforcement) — we tag it to
 * the calling project so its jobs are attributable back to the orchestration.
 *
 * @param {{owner?: string}} args
 * @param {{projectId?: string}} ctx
 * @returns {string}
 */
export function resolveOwner(args, ctx) {
  if (args?.owner) return String(args.owner);
  if (ctx?.projectId) return `creative-director:${ctx.projectId}`;
  return 'creative';
}
