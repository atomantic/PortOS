/**
 * Re-export of server Brain thread helpers: statuses, `isTerminalThreadStatus`, `isThreadOverdue`,
 * `threadNextLine` and `compareThreads` for consistent client ordering.
 *
 * Re-export of `server/lib/brainThreads.js` — Brain THREAD statuses, `isTerminalThreadStatus` /
 * `isThreadOverdue`, `threadNextLine` and the server's list comparator `compareThreads`, so the
 * Threads tab and the Open Threads widget group, badge and order rows exactly as `GET
 * /api/brain/threads` does (a *thread* is a tracked open loop, never a message thread).
 */

/**
 * Brain THREAD rules — statuses, the terminal/overdue predicates, the row's
 * next-action line and the list comparator.
 *
 * Re-export of `server/lib/brainThreads.js` — the one definition of these
 * rules, imported rather than copied so the Threads tab, the Open Threads
 * dashboard widget and the server list order cannot drift (the "One pure
 * module, one definition" convention in this directory's README).
 *
 * A Brain *thread* is a tracked topic or commitment, not a message thread.
 */
export { THREAD_STATUSES, THREAD_PRIORITIES, THREAD_ACTIVE_STATUSES, isTerminalThreadStatus, isThreadOverdue, threadNextLine, compareThreads } from '../../../server/lib/brainThreads.js';
