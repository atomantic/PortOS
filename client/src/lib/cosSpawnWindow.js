/**
 * Re-export of the spawn-window settlement from the pure server leaf `server/lib/cosSpawnWindow.js`.
 *
 * A task keeps `status: 'pending'` for a beat after its agent registers as `running`, so a view
 * rendering both lists must decide which side it belongs to (ACTIVE, until `SPAWN_CLAIM_GRACE_MS`).
 * `GET /api/cos/tasks` already settles its payload, so most surfaces just read `task.spawning`;
 * `cos/tabs/TasksTab.jsx` settles client-side because it also has the socket agent feed, which lands
 * ahead of the next task refetch.
 */

/**
 * Re-export of the CoS spawn-window settlement from the pure server leaf
 * `server/lib/cosSpawnWindow.js`.
 *
 * Importing rather than copying means the Tasks tab and the server's own
 * counters cannot drift into disagreeing about which side of the pending/active
 * line a mid-spawn task falls on. See that file for the full contract.
 */
export { runningAgentsByTaskId, isSpawningTask, withoutSpawningTasks } from '../../../server/lib/cosSpawnWindow.js';
