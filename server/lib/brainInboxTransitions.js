/**
 * Brain inbox status machine (#15155).
 *
 * `transitionInbox(entry, event, attemptId)` decides what one event may do to an
 * inbox row's status. `services/brain.js` applies it only inside
 * `brainStorage.updateWith('inbox', id, …)`, against the record re-read in the
 * per-id write queue, so two overlapping writers cannot both pass a check made
 * on a stale snapshot.
 *
 * A classifier completion owns the row only while `classificationAttempt` still
 * equals the attempt that started it. A completion whose attempt does not match
 * (a newer retry, a boot recovery, a user resolve, or a classify in flight
 * across the upgrade that introduced the field) is stale and must neither write
 * nor file. Statuses this build does not know (a legacy `error` row is known)
 * accept no user transition.
 */

import { isNonBlankStr as isAttemptId } from './textUtils.js';

export const INBOX_EVENTS = Object.freeze({
  CLASSIFY_FILED: 'classify-filed',
  CLASSIFY_REVIEW: 'classify-review',
  FAIL: 'fail',
  RESOLVE: 'resolve',
  CORRECT: 'correct',
  RETRY: 'retry',
  DONE: 'done',
});

const COMPLETION_TARGET = Object.freeze({
  [INBOX_EVENTS.CLASSIFY_FILED]: 'filed',
  [INBOX_EVENTS.CLASSIFY_REVIEW]: 'needs_review',
  [INBOX_EVENTS.FAIL]: 'needs_review',
});

// status → event → next status. An event a status does not list is a conflict.
const USER_TRANSITIONS = Object.freeze({
  needs_review: { resolve: 'filed', retry: 'classifying', done: 'done' },
  error: { retry: 'classifying', done: 'done' },
  filed: { correct: 'corrected', done: 'done' },
  corrected: { correct: 'corrected', done: 'done' },
  done: {},
});

const IGNORE = Object.freeze({ action: 'ignore' });
const CONFLICT = Object.freeze({ action: 'conflict' });
const NOOP = Object.freeze({ action: 'noop' });

/**
 * @returns {{ action: 'apply', patch: object } | { action: 'ignore' | 'conflict' | 'noop' }}
 *   `apply` carries the status fields to merge; `ignore` is a stale completion
 *   (no write); `conflict` is a refused user action (409); `noop` is a repeat
 *   that already holds (done → done).
 */
export function transitionInbox(entry, event, attemptId) {
  const status = entry?.status;
  const completionTarget = COMPLETION_TARGET[event];

  if (completionTarget) {
    if (status !== 'classifying') return IGNORE;
    if (!isAttemptId(attemptId) || entry.classificationAttempt !== attemptId) return IGNORE;
    return { action: 'apply', patch: { status: completionTarget, classificationAttempt: null } };
  }

  if (!Object.values(INBOX_EVENTS).includes(event)) {
    throw new Error(`Unknown inbox event: ${event}`);
  }
  if (status === 'done' && event === INBOX_EVENTS.DONE) return NOOP;

  const next = Object.hasOwn(USER_TRANSITIONS, status) ? USER_TRANSITIONS[status][event] : undefined;
  if (!next) return CONFLICT;
  if (event === INBOX_EVENTS.RETRY) {
    if (!isAttemptId(attemptId)) throw new Error('A retry needs a new classification attempt id');
    return { action: 'apply', patch: { status: next, classificationAttempt: attemptId } };
  }
  return { action: 'apply', patch: { status: next } };
}
