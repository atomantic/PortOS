/**
 * Beeper sweep progress — the leaf state `beeperStatus.js` and `beeperSync.js`
 * both touch. Standalone so the status route can report a running sweep without
 * importing the ingestion stack (DB pool, HTTP client, beeperTribe).
 *
 * One process-wide in-memory snapshot (a restart mid-sweep loses the run anyway).
 * `running` is what consumers gate on; the rest describe the CURRENT pass, then
 * the LAST completed pass, never reset when a sweep ends so "Last synced" still
 * shows what moved.
 */

const initialSnapshot = () => ({
  running: false,
  startedAt: null,
  finishedAt: null,
  reason: null,
  accountsDone: 0,
  // `null`, not 0: the roster is unknown until `refreshAccounts()` resolves
  // mid-sweep, and "0 of 0" would read as nothing to do.
  accountsTotal: null,
  chats: 0,
  messages: 0,
});

let snapshot = initialSnapshot();

/**
 * A fresh read-only copy for a status payload.
 */
export function getBeeperSweepProgress() {
  return { ...snapshot };
}

/** Merge a partial update into the current snapshot; returns the new snapshot. */
export function updateBeeperSweepProgress(patch) {
  snapshot = { ...snapshot, ...patch };
  return snapshot;
}

/** Test-only reset, mirroring the reset helpers other leaf state modules expose. */
export function __resetBeeperSweepProgressForTests() {
  snapshot = initialSnapshot();
}
