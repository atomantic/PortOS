/**
 * Brain THREAD rules — the pure, dependency-free half of the bullet journal
 * (#7664): status/priority vocabularies, the terminal-status test, the overdue
 * predicate and the list comparator.
 *
 * A Brain *thread* is a tracked topic or commitment (an open loop), NOT a
 * message thread — `messageSync.js` / `messageGmailSync.js` / `beeperSync.js`
 * own that other sense of the word.
 *
 * Deliberately a leaf (no zod, no services, no db): `server/lib/brainValidation.js`
 * builds its enums from these arrays, `server/routes/brainThreads.js` sorts with
 * the comparator, and the client re-exports the whole module
 * (`client/src/lib/brainThreads.js`) so the Threads tab, the dashboard widget
 * and the server can never disagree about which statuses are "done", which
 * threads are overdue, or what order a list comes in.
 */

export const THREAD_STATUSES = Object.freeze(['open', 'waiting', 'someday', 'done', 'archived']);
export const THREAD_PRIORITIES = Object.freeze(['low', 'normal', 'high', 'urgent']);
export const THREAD_TERMINAL_STATUSES = Object.freeze(['done', 'archived']);

/** The statuses that make up the working set — everything not finished. */
export const THREAD_ACTIVE_STATUSES = Object.freeze(
  THREAD_STATUSES.filter((status) => !THREAD_TERMINAL_STATUSES.includes(status)),
);

export const isTerminalThreadStatus = (status) => THREAD_TERMINAL_STATUSES.includes(status);

/**
 * Past its due date and still open. A finished thread is never overdue, however
 * old its date — the badge means "needs you", not "was late".
 */
export function isThreadOverdue(thread, now = Date.now()) {
  if (isTerminalThreadStatus(thread?.status)) return false;
  const due = Date.parse(thread?.dueAt ?? '');
  return !Number.isNaN(due) && due < now;
}

/**
 * The one line a list row shows under the title: who a waiting thread is
 * blocked on, else the next concrete step. Empty when the thread has neither.
 */
export function threadNextLine(thread) {
  if (thread?.status === 'waiting' && thread.waitingOn) return `Waiting on ${thread.waitingOn}`;
  return thread?.nextAction || thread?.waitingOn || '';
}

// Sort key for the due date: a thread with no due date sorts AFTER every dated
// one rather than poisoning the comparator with NaN.
export const dueSortKey = (thread) => {
  const t = Date.parse(thread?.dueAt ?? '');
  return Number.isNaN(t) ? Infinity : t;
};

/**
 * Pinned first, then soonest-due, then most recently touched, with the id as a
 * deterministic tiebreak — a stable order matters because the list paginates,
 * and an unstable one drops or duplicates rows at the slice boundary.
 */
export function compareThreads(a, b) {
  if (Boolean(b.pinned) !== Boolean(a.pinned)) return Boolean(b.pinned) - Boolean(a.pinned);
  // Compared, not subtracted: two UNDATED threads are both Infinity, and
  // `Infinity - Infinity` is NaN — a comparator returning NaN skips the
  // remaining tiebreaks and leaves the order engine-defined, which the
  // pagination slice cannot tolerate.
  const aDue = dueSortKey(a);
  const bDue = dueSortKey(b);
  if (aDue !== bDue) return aDue - bDue;
  const touched = Date.parse(b?.updatedAt ?? '') - Date.parse(a?.updatedAt ?? '');
  if (!Number.isNaN(touched) && touched !== 0) return touched;
  return String(a.id).localeCompare(String(b.id));
}
