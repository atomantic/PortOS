import { describe, it, expect } from 'vitest';
import { transitionInbox, INBOX_EVENTS } from './brainInboxTransitions.js';

const E = INBOX_EVENTS;
const LIVE = 'attempt-live';
const NEW = 'attempt-new';

const apply = (patch) => ({ action: 'apply', patch });
const ignore = { action: 'ignore' };
const conflict = { action: 'conflict' };
const noop = { action: 'noop' };
const settled = (status) => apply({ status, classificationAttempt: null });

// Every cell of the #15155 table. `classifying` rows carry the live attempt and
// completions report it, so these rows show the MATCHING case; the stale cases
// are pinned separately below.
const TABLE = {
  classifying: {
    [E.CLASSIFY_FILED]: settled('filed'),
    [E.CLASSIFY_REVIEW]: settled('needs_review'),
    [E.FAIL]: settled('needs_review'),
    [E.RESOLVE]: conflict,
    [E.CORRECT]: conflict,
    [E.RETRY]: conflict,
    [E.DONE]: conflict,
  },
  needs_review: {
    [E.CLASSIFY_FILED]: ignore,
    [E.CLASSIFY_REVIEW]: ignore,
    [E.FAIL]: ignore,
    [E.RESOLVE]: apply({ status: 'filed' }),
    [E.CORRECT]: conflict,
    [E.RETRY]: apply({ status: 'classifying', classificationAttempt: NEW }),
    [E.DONE]: apply({ status: 'done' }),
  },
  error: {
    [E.CLASSIFY_FILED]: ignore,
    [E.CLASSIFY_REVIEW]: ignore,
    [E.FAIL]: ignore,
    [E.RESOLVE]: conflict,
    [E.CORRECT]: conflict,
    [E.RETRY]: apply({ status: 'classifying', classificationAttempt: NEW }),
    [E.DONE]: apply({ status: 'done' }),
  },
  filed: {
    [E.CLASSIFY_FILED]: ignore,
    [E.CLASSIFY_REVIEW]: ignore,
    [E.FAIL]: ignore,
    [E.RESOLVE]: conflict,
    [E.CORRECT]: apply({ status: 'corrected' }),
    [E.RETRY]: conflict,
    [E.DONE]: apply({ status: 'done' }),
  },
  corrected: {
    [E.CLASSIFY_FILED]: ignore,
    [E.CLASSIFY_REVIEW]: ignore,
    [E.FAIL]: ignore,
    [E.RESOLVE]: conflict,
    [E.CORRECT]: apply({ status: 'corrected' }),
    [E.RETRY]: conflict,
    [E.DONE]: apply({ status: 'done' }),
  },
  done: {
    [E.CLASSIFY_FILED]: ignore,
    [E.CLASSIFY_REVIEW]: ignore,
    [E.FAIL]: ignore,
    [E.RESOLVE]: conflict,
    [E.CORRECT]: conflict,
    [E.RETRY]: conflict,
    [E.DONE]: noop,
  },
};

const COMPLETIONS = [E.CLASSIFY_FILED, E.CLASSIFY_REVIEW, E.FAIL];

describe('transitionInbox', () => {
  const cells = Object.entries(TABLE).flatMap(([status, row]) =>
    Object.entries(row).map(([event, expected]) => [status, event, expected]));

  it.each(cells)('%s + %s', (status, event, expected) => {
    const entry = { status, classificationAttempt: status === 'classifying' ? LIVE : undefined };
    const attemptId = COMPLETIONS.includes(event) ? LIVE : NEW;
    expect(transitionInbox(entry, event, attemptId)).toEqual(expected);
  });

  it.each(COMPLETIONS)('ignores a stale %s completion on a classifying row', (event) => {
    const entry = { status: 'classifying', classificationAttempt: NEW };
    expect(transitionInbox(entry, event, LIVE)).toEqual(ignore);
  });

  it.each(COMPLETIONS)('treats a %s completion with no attempt id as stale (in flight across the upgrade)', (event) => {
    expect(transitionInbox({ status: 'classifying' }, event, undefined)).toEqual(ignore);
    expect(transitionInbox({ status: 'classifying', classificationAttempt: LIVE }, event, undefined)).toEqual(ignore);
  });

  it('ignores a completion on a classifying row that recovery already cleared', () => {
    expect(transitionInbox({ status: 'classifying', classificationAttempt: null }, E.CLASSIFY_FILED, LIVE)).toEqual(ignore);
  });

  it('refuses every user action on a status this build does not know', () => {
    for (const event of [E.RESOLVE, E.CORRECT, E.RETRY, E.DONE]) {
      expect(transitionInbox({ status: 'archived-by-a-newer-peer' }, event, NEW)).toEqual(conflict);
    }
  });

  it('rejects an unknown event and a retry without a new attempt id', () => {
    expect(() => transitionInbox({ status: 'needs_review' }, 'teleport')).toThrow(/Unknown inbox event/);
    expect(() => transitionInbox({ status: 'needs_review' }, E.RETRY)).toThrow(/attempt id/);
  });
});
