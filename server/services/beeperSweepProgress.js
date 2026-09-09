/**
 * Beeper sweep progress — the leaf state `beeperStatus.js` and `beeperSync.js`
 * both touch (fork issue #80).
 *
 * A standalone module for the same reason `beeperSocketEvents.js` is one
 * (see that file's own docblock): the status route needs to know whether a
 * sweep is running without importing the sweep module itself, which would
 * drag the whole ingestion stack (the DB pool, the live HTTP client,
 * beeperTribe) into `beeperStatus.js` — a read-only status card has no
 * business loading any of that just to report a boolean and a few counts.
 *
 * One in-memory snapshot, process-wide — matches `eventScheduler`'s own
 * process-local state, and for the same reason nothing here needs to be
 * durable: a restart mid-sweep already loses the run itself, and the next
 * sweep starts a fresh pass regardless. `running` is the field every
 * consumer gates on; the rest describe the CURRENT pass while one is running,
 * and the LAST completed pass once it finishes — never reset back to zero the
 * instant a sweep ends, so the "Last synced" card still shows what actually
 * moved rather than blanking to zero.
 */

const initialSnapshot = () => ({
  running: false,
  startedAt: null,
  finishedAt: null,
  reason: null,
  accountsDone: 0,
  // `null`, not 0: the account roster isn't known until `refreshAccounts()`
  // resolves partway into the sweep, and "0 of 0" would misreport a sweep
  // that just hasn't counted its accounts yet as one with nothing to do.
  accountsTotal: null,
  chats: 0,
  messages: 0,
});

let snapshot = initialSnapshot();

/**
 * A read-only copy for a status payload. Always a fresh object — callers
 * must not mutate the result, and mutating it could never reach back into
 * the module's own state anyway.
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
