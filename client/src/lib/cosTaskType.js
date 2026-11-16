/**
 * `extractCosTaskType(task)` resolves a CoS task's learning bucket for ETA displays, mirroring the
 * server's metadata-first task type extraction.
 *
 * CoS task-learning bucket resolver for ETA surfaces: `extractCosTaskType(task)` mirrors the server's
 * metadata-first `extractTaskType` handling for live tasks and archived-agent projections, so
 * `self-improve:*`, `user-task`, and fallback estimates use the same history bucket that recorded the
 * run.
 */

/**
 * CoS task-learning bucket resolver for client-side duration displays.
 *
 * Re-export of `server/lib/taskTypeBucket.js` — the one definition of the
 * bucket rules, imported rather than copied so an ETA key cannot drift from
 * the history the server records (e.g. after a scheduled-task rename).
 */
export { extractTaskType as extractCosTaskType } from '../../../server/lib/taskTypeBucket.js';
