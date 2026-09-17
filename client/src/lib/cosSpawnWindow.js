/**
 * Re-export of the CoS spawn-window settlement from the pure server leaf
 * `server/lib/cosSpawnWindow.js`.
 *
 * Importing rather than copying means the Tasks tab and the server's own
 * counters cannot drift into disagreeing about which side of the pending/active
 * line a mid-spawn task falls on. See that file for the full contract.
 */
export {
  SPAWN_CLAIM_GRACE_MS,
  spawnClaimAgeMs,
  runningAgentsByTaskId,
  spawningAgentForTask,
  isSpawningTask,
  withoutSpawningTasks,
  unclaimedTaskIds,
} from '../../../server/lib/cosSpawnWindow.js';
