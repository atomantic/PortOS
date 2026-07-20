import { describe, it, expect } from 'vitest';
import {
  REJECTION_REASONS,
  REJECTION_REASON_VALUES,
  UNKNOWN_REJECTION_REASON,
  classifyRejection,
  classifyClosingComment,
  classifyPrFailure,
  isPrRefinableReason,
  formatRejectionReason,
  formatRejectionReasons,
  summarizeRejectionReasons
} from './layeredIntelligenceRejections.js';

const rejected = (rejectionReason) => ({ outcome: 'rejected', rejectionReason });

describe('rejection taxonomy', () => {
  it('keeps the unknown sentinel OUT of the diagnosis vocabulary but inside the storable values', () => {
    // The sentinel is the ABSENCE of a diagnosis; letting it into REJECTION_REASONS
    // would make "we don't know" tally as a finding.
    expect(REJECTION_REASONS).not.toContain(UNKNOWN_REJECTION_REASON);
    expect(REJECTION_REASON_VALUES).toContain(UNKNOWN_REJECTION_REASON);
    expect(REJECTION_REASON_VALUES).toEqual([...REJECTION_REASONS, UNKNOWN_REJECTION_REASON]);
  });

  it('has no duplicate tokens', () => {
    expect(new Set(REJECTION_REASON_VALUES).size).toBe(REJECTION_REASON_VALUES.length);
  });

  it('glosses every storable token, and passes an unglossed token through', () => {
    for (const token of REJECTION_REASON_VALUES) {
      expect(formatRejectionReason(token)).toBeTruthy();
      expect(typeof formatRejectionReason(token)).toBe('string');
    }
    expect(formatRejectionReason('some-future-token')).toBe('some-future-token');
  });

  it('renders a nullish (unclassified) input as empty, NOT as the unknown sentinel', () => {
    // Mapping "not classified" onto "classified, found nothing" would invert the
    // module's central rule at its most-reused helper.
    expect(formatRejectionReason(null)).toBe('');
    expect(formatRejectionReason(undefined)).toBe('');
    expect(formatRejectionReason('')).toBe('');
  });
});

describe('classifyRejection', () => {
  it('never invents a reason for a merged or unresolved proposal', () => {
    // The load-bearing case: jira/plan report no stateReason at all, and their
    // common close path IS a merge. Empty signals must not read as a rejection.
    expect(classifyRejection({ outcome: 'merged', stateReason: null, labels: [] })).toBeNull();
    expect(classifyRejection({ outcome: null, stateReason: null, labels: [] })).toBeNull();
    expect(classifyRejection({})).toBeNull();
  });

  it('maps GitHub not_planned to a user rejection', () => {
    expect(classifyRejection({ outcome: 'rejected', stateReason: 'not_planned' })).toBe('user-rejected');
  });

  it('maps a duplicate close to duplicate', () => {
    expect(classifyRejection({ outcome: 'abandoned', stateReason: 'duplicate' })).toBe('duplicate');
  });

  it('classifies an abandoned proposal, not just a rejected one', () => {
    // `abandoned` is also a non-merge and is worth diagnosing.
    expect(classifyRejection({ outcome: 'abandoned', labels: ['wontfix'] })).toBe('user-rejected');
  });

  it('lets a specific label outrank the generic not_planned stateReason', () => {
    expect(classifyRejection({
      outcome: 'rejected',
      stateReason: 'not_planned',
      labels: ['duplicate']
    })).toBe('duplicate');
  });

  it('normalizes label and stateReason spelling (case, spaces, separators)', () => {
    expect(classifyRejection({ outcome: 'rejected', stateReason: 'Not Planned' })).toBe('user-rejected');
    expect(classifyRejection({ outcome: 'rejected', stateReason: 'not-planned' })).toBe('user-rejected');
    expect(classifyRejection({ outcome: 'rejected', labels: ['Out Of Scope'] })).toBe('scope-mismatch');
    expect(classifyRejection({ outcome: 'rejected', labels: ['NEEDS_INPUT'] })).toBe('missing-context');
  });

  it('maps a human-applied blocked label to an environment blocker', () => {
    expect(classifyRejection({ outcome: 'rejected', labels: ['blocked'] })).toBe('environment-blocker');
  });

  it("ignores LI's own machine-applied pause label instead of reading it as a diagnosis", () => {
    // LI stamps `layered-intelligence:blocking` on its own proposals to record that
    // the loop is paused there. Treating that as evidence would outrank the real
    // close reason and feed the loop "blocked on the environment" when the user
    // simply declined — LI corrupting its own feedback signal via its own marker.
    expect(classifyRejection({
      outcome: 'rejected',
      stateReason: 'not_planned',
      labels: ['layered-intelligence:blocking']
    })).toBe('user-rejected');
    // And with no other signal it is an honest unknown, not a fabricated blocker.
    expect(classifyRejection({
      outcome: 'rejected',
      labels: ['layered-intelligence', 'layered-intelligence:blocking']
    })).toBe(UNKNOWN_REJECTION_REASON);
  });

  it('ignores labels it has no mapping for and falls through to the stateReason', () => {
    expect(classifyRejection({
      outcome: 'rejected',
      stateReason: 'not_planned',
      labels: ['layered-intelligence', 'p2', 'backend']
    })).toBe('user-rejected');
  });

  it('returns the unknown sentinel — never a fake reason — when nothing explains the close', () => {
    expect(classifyRejection({ outcome: 'rejected', stateReason: null, labels: [] }))
      .toBe(UNKNOWN_REJECTION_REASON);
    expect(classifyRejection({ outcome: 'abandoned', stateReason: 'reopened', labels: ['chore'] }))
      .toBe(UNKNOWN_REJECTION_REASON);
  });

  it('tolerates a non-array labels value', () => {
    expect(classifyRejection({ outcome: 'rejected', stateReason: 'duplicate', labels: null })).toBe('duplicate');
  });

  it('classifies from the closing comment when no label or close reason fires (#2748)', () => {
    // The glab/jira gap: a human declines in prose with no matching label and no
    // close reason at all. The comment scan is what makes the token reachable.
    expect(classifyRejection({
      outcome: 'rejected',
      stateReason: null,
      labels: [],
      closingComment: 'Thanks, but this is out of scope for this app.'
    })).toBe('scope-mismatch');
    expect(classifyRejection({
      outcome: 'rejected',
      closingComment: "Closing — can't reproduce and the report is too vague."
    })).toBe('missing-context');
  });

  it('lets a label and a SPECIFIC close reason outrank a conflicting closing comment', () => {
    // Free text is noisier than a deliberately-applied signal, so a label and a
    // specific close reason (duplicate) both win over the comment.
    expect(classifyRejection({
      outcome: 'rejected',
      labels: ['duplicate'],
      closingComment: 'this is out of scope'
    })).toBe('duplicate');
    expect(classifyRejection({
      outcome: 'abandoned',
      stateReason: 'duplicate',
      closingComment: 'low quality proposal'
    })).toBe('duplicate');
  });

  it('lets a specific closing comment REFINE the generic not_planned decline (#2748)', () => {
    // not_planned says the proposal was declined but not WHY. A prose rationale
    // sharpens that generic decline into a precise taxonomy token — the primary
    // reachable case, since deriveOutcome hands most GitHub rejections a not_planned
    // reason. The outcome is unchanged, so this can't move the merge rate.
    expect(classifyRejection({
      outcome: 'rejected',
      stateReason: 'not_planned',
      closingComment: 'low quality proposal'
    })).toBe('quality-issue');
    expect(classifyRejection({
      outcome: 'rejected',
      stateReason: 'not_planned',
      closingComment: 'Appreciate it, but this is out of scope for the app.'
    })).toBe('scope-mismatch');
    // With no specific rationale in the comment, the generic decline stands.
    expect(classifyRejection({
      outcome: 'rejected',
      stateReason: 'not_planned',
      closingComment: 'Closing this out, thanks.'
    })).toBe('user-rejected');
  });

  it('falls through to the unknown sentinel when the closing comment states no rationale', () => {
    expect(classifyRejection({
      outcome: 'rejected',
      closingComment: 'Closing this one out. Thanks!'
    })).toBe(UNKNOWN_REJECTION_REASON);
  });

  it('only ever yields a storable token', () => {
    const got = classifyRejection({ outcome: 'rejected', stateReason: 'not_planned' });
    expect(REJECTION_REASON_VALUES).toContain(got);
    const fromComment = classifyRejection({ outcome: 'rejected', closingComment: 'out of scope' });
    expect(REJECTION_REASON_VALUES).toContain(fromComment);
  });

  describe('implementing-PR failure precedence (#2748, deliverable 2)', () => {
    it('refines a generic not_planned decline into the PR-failure token', () => {
      // The primary reachable case: an abandoned/rejected proposal whose implementing
      // PR failed CI. The bare not_planned says only THAT it was declined.
      expect(classifyRejection({
        outcome: 'rejected', stateReason: 'not_planned', prFailure: 'validation-failed'
      })).toBe('validation-failed');
      expect(classifyRejection({
        outcome: 'abandoned', prFailure: 'merge-conflict'
      })).toBe('merge-conflict');
    });

    it('diagnoses an otherwise-unknown close from the PR failure', () => {
      expect(classifyRejection({
        outcome: 'rejected', stateReason: null, labels: [], prFailure: 'merge-conflict'
      })).toBe('merge-conflict');
    });

    it('never overrides a human label or a specific close reason', () => {
      // A human wontfix / a duplicate close is a deliberate disposition; the mechanical
      // fact that the PR had a conflict must not outrank it.
      expect(classifyRejection({
        outcome: 'rejected', labels: ['wontfix'], prFailure: 'validation-failed'
      })).toBe('user-rejected');
      expect(classifyRejection({
        outcome: 'abandoned', stateReason: 'duplicate', prFailure: 'merge-conflict'
      })).toBe('duplicate');
    });

    it('sits BELOW the closing-comment rationale', () => {
      // A human who stated "out of scope" in prose outranks a mechanical PR conflict.
      expect(classifyRejection({
        outcome: 'rejected', stateReason: 'not_planned',
        closingComment: 'this is out of scope', prFailure: 'merge-conflict'
      })).toBe('scope-mismatch');
    });

    it('ignores a foreign / non-vocabulary prFailure token', () => {
      // Only a REJECTION_REASONS member is honoured, so a caller can't inject junk.
      expect(classifyRejection({
        outcome: 'rejected', stateReason: 'not_planned', prFailure: 'not-a-real-token'
      })).toBe('user-rejected');
      expect(classifyRejection({
        outcome: 'rejected', prFailure: 'not-a-real-token'
      })).toBe(UNKNOWN_REJECTION_REASON);
    });
  });
});

describe('classifyPrFailure (#2748, deliverable 2)', () => {
  it('returns null for a nullish or non-object input', () => {
    expect(classifyPrFailure(null)).toBeNull();
    expect(classifyPrFailure(undefined)).toBeNull();
    expect(classifyPrFailure('MERGED')).toBeNull();
  });

  it('never treats a merged PR as a failure', () => {
    // If it merged, the proposal is `merged` and there is nothing to diagnose.
    expect(classifyPrFailure({ state: 'MERGED', mergeStateStatus: 'DIRTY' })).toBeNull();
    expect(classifyPrFailure({ state: 'merged', statusCheckRollup: [{ conclusion: 'FAILURE' }] })).toBeNull();
  });

  it('reads a DIRTY merge state as a merge conflict, ahead of a failed check', () => {
    expect(classifyPrFailure({ state: 'CLOSED', mergeStateStatus: 'DIRTY' })).toBe('merge-conflict');
    // A conflicted branch is the more fundamental blocker, so it wins over a check fail.
    expect(classifyPrFailure({
      state: 'OPEN', mergeStateStatus: 'DIRTY', statusCheckRollup: [{ conclusion: 'FAILURE' }]
    })).toBe('merge-conflict');
  });

  it('reads a failing check verdict as validation-failed (CheckRun or StatusContext shape)', () => {
    expect(classifyPrFailure({ state: 'CLOSED', statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }] }))
      .toBe('validation-failed');
    // StatusContext rows carry `state`, not `conclusion`.
    expect(classifyPrFailure({ state: 'CLOSED', statusCheckRollup: [{ state: 'ERROR' }] })).toBe('validation-failed');
    expect(classifyPrFailure({ state: 'CLOSED', statusCheckRollup: [{ conclusion: 'TIMED_OUT' }] })).toBe('validation-failed');
  });

  it('returns null when checks all passed or are ambiguous (conservative)', () => {
    expect(classifyPrFailure({ state: 'CLOSED', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ conclusion: 'SUCCESS' }] }))
      .toBeNull();
    // CANCELLED/SKIPPED/NEUTRAL are ambiguous (superseded/opt-out) → honest null.
    expect(classifyPrFailure({ state: 'CLOSED', statusCheckRollup: [{ conclusion: 'CANCELLED' }, { conclusion: 'SKIPPED' }] }))
      .toBeNull();
  });

  it('only ever yields a storable rejection token', () => {
    for (const view of [
      { state: 'CLOSED', mergeStateStatus: 'DIRTY' },
      { state: 'CLOSED', statusCheckRollup: [{ conclusion: 'FAILURE' }] }
    ]) {
      expect(REJECTION_REASONS).toContain(classifyPrFailure(view));
    }
  });
});

describe('isPrRefinableReason (#2748, deliverable 2)', () => {
  it('is true only for the generic decline and the unknown sentinel', () => {
    expect(isPrRefinableReason('user-rejected')).toBe(true);
    expect(isPrRefinableReason(UNKNOWN_REJECTION_REASON)).toBe(true);
  });

  it('is false for every diagnosis a more authoritative signal already made', () => {
    for (const r of ['duplicate', 'scope-mismatch', 'missing-context', 'quality-issue', 'merge-conflict', 'validation-failed', null]) {
      expect(isPrRefinableReason(r)).toBe(false);
    }
  });
});

describe('classifyClosingComment', () => {
  it('returns null for a nullish, non-string, or blank comment', () => {
    expect(classifyClosingComment(null)).toBeNull();
    expect(classifyClosingComment(undefined)).toBeNull();
    expect(classifyClosingComment('')).toBeNull();
    expect(classifyClosingComment('   \n  ')).toBeNull();
    expect(classifyClosingComment(42)).toBeNull();
  });

  it('detects scope-mismatch rationales', () => {
    for (const text of [
      'This is out of scope.',
      'Sorry, this is outside the scope of the project.',
      "This does n't belong in this app",
      'Not aligned with where we are taking things.'
    ]) {
      expect(classifyClosingComment(text)).toBe('scope-mismatch');
    }
  });

  it('detects missing-context rationales', () => {
    for (const text of [
      'We need more information before we can act on this.',
      'Not enough detail to proceed.',
      "Can't reproduce from what's here.",
      'This is under-specified — please clarify.',
      'The description is too vague.',
      'This lacks information to act on.',
      'Lacks of context.',
      'Lacking detail.'
    ]) {
      expect(classifyClosingComment(text)).toBe('missing-context');
    }
  });

  it('detects quality-issue rationales', () => {
    for (const text of [
      'This is a low-quality proposal.',
      'The suggestion is malformed and does not make sense.',
      'Reads like a hallucinated feature.',
      'Not actionable as written.'
    ]) {
      expect(classifyClosingComment(text)).toBe('quality-issue');
    }
  });

  it('matches "could not reproduce" and its contractions', () => {
    for (const text of [
      'We could not reproduce this.',
      "We couldn't reproduce it.",
      'Cannot reproduce.',
      'can not reproduce'
    ]) {
      expect(classifyClosingComment(text)).toBe('missing-context');
    }
  });

  it('does not misread a "not something we can reproduce" close as a scope mismatch', () => {
    // The old broad "not something we" scope pattern misfired here. Dropping it
    // yields the honest null (the negation isn't something a keyword pass can
    // parse) — which falls through to unknown-reason — never a WRONG scope token.
    expect(classifyClosingComment('This is not something we can reproduce.')).toBeNull();
  });

  it('matches across newlines and mixed case', () => {
    expect(classifyClosingComment('Thanks for the idea!\n\nHowever this is\nOUT OF SCOPE here.'))
      .toBe('scope-mismatch');
  });

  it('is deterministic and resolves multi-bucket text by fixed group order', () => {
    // Trips both scope and quality; scope is the earlier, more-specific group.
    const text = 'out of scope and honestly low-quality too';
    expect(classifyClosingComment(text)).toBe('scope-mismatch');
    expect(classifyClosingComment(text)).toBe('scope-mismatch');
  });

  it('returns null when no keyword matches, never a fabricated reason', () => {
    expect(classifyClosingComment('Closing this out, thanks everyone.')).toBeNull();
    expect(classifyClosingComment('Merged in a follow-up, all good.')).toBeNull();
  });

  it('only ever yields a storable token or null', () => {
    for (const text of ['out of scope', 'need more info', 'malformed', 'nothing here']) {
      const got = classifyClosingComment(text);
      expect(got === null || REJECTION_REASONS.includes(got)).toBe(true);
    }
  });
});

describe('summarizeRejectionReasons', () => {
  it('counts diagnoses, the unknown gap, and the unclassified gap separately', () => {
    const { entries, unknown, unclassified, diagnosed, total } = summarizeRejectionReasons([
      rejected('duplicate'),
      rejected('duplicate'),
      rejected('user-rejected'),
      rejected(UNKNOWN_REJECTION_REASON),
      rejected(null)
    ]);
    expect(entries).toEqual([
      { reason: 'duplicate', count: 2 },
      { reason: 'user-rejected', count: 1 }
    ]);
    expect(unknown).toBe(1);
    expect(unclassified).toBe(1);
    expect(diagnosed).toBe(3);
    expect(total).toBe(5);
  });

  it('keeps the unknown sentinel out of entries so it cannot crowd out real diagnoses', () => {
    const { entries, unknown } = summarizeRejectionReasons([
      rejected(UNKNOWN_REJECTION_REASON),
      rejected(UNKNOWN_REJECTION_REASON),
      rejected(UNKNOWN_REJECTION_REASON),
      rejected('duplicate')
    ]);
    expect(entries).toEqual([{ reason: 'duplicate', count: 1 }]);
    expect(unknown).toBe(3);
  });

  it('ignores merged and pending proposals', () => {
    const { total, unknown } = summarizeRejectionReasons([
      { outcome: 'merged', rejectionReason: null },
      { outcome: null, rejectionReason: null }
    ]);
    expect(total).toBe(0);
    expect(unknown).toBe(0);
  });

  it('counts a pre-taxonomy record as unclassified, never as unknown', () => {
    // Reading a null as `unknown` would claim we looked and found nothing, when in
    // fact we never looked — overstating the measured gap and hiding the real one.
    const { total, unknown, unclassified, diagnosed } = summarizeRejectionReasons([
      { outcome: 'rejected', rejectionReason: null },
      { outcome: 'rejected', rejectionReason: 'duplicate' }
    ]);
    expect(diagnosed).toBe(1);
    expect(unknown).toBe(0);
    expect(unclassified).toBe(1);
    // The population is every non-merged resolved proposal, diagnosed or not.
    expect(total).toBe(2);
  });

  it('counts an unrecognized stored token as unclassified, not as a diagnosis', () => {
    const { total, unclassified, diagnosed } = summarizeRejectionReasons([rejected('not-a-real-token')]);
    expect(diagnosed).toBe(0);
    expect(unclassified).toBe(1);
    expect(total).toBe(1);
  });

  it('orders ties by taxonomy order so output does not depend on record order', () => {
    const forward = summarizeRejectionReasons([rejected('duplicate'), rejected('user-rejected')]);
    const reverse = summarizeRejectionReasons([rejected('user-rejected'), rejected('duplicate')]);
    expect(forward.entries).toEqual(reverse.entries);
    expect(forward.entries.map(e => e.reason)).toEqual(['duplicate', 'user-rejected']);
  });

  it('tolerates junk input', () => {
    expect(summarizeRejectionReasons(null).total).toBe(0);
    expect(summarizeRejectionReasons([null, undefined, 'x']).total).toBe(0);
  });
});

describe('formatRejectionReasons', () => {
  it('returns empty ONLY when nothing was closed unmerged', () => {
    expect(formatRejectionReasons([])).toBe('');
    expect(formatRejectionReasons([{ outcome: 'merged', rejectionReason: null }])).toBe('');
    expect(formatRejectionReasons([{ outcome: null, rejectionReason: null }])).toBe('');
  });

  it('never falls silent on a rejection it simply has not classified yet', () => {
    // The caller reads '' as "nothing to explain" and prints "nothing has been
    // closed unmerged yet". Returning '' here would contradict the "Rejected: 2"
    // line printed directly above it.
    const out = formatRejectionReasons([rejected(null), { outcome: 'abandoned', rejectionReason: null }]);
    expect(out).toBe('2 of 2 not yet classified');
  });

  it('renders glossed diagnoses with counts, commonest first', () => {
    const out = formatRejectionReasons([
      rejected('duplicate'),
      rejected('duplicate'),
      rejected('user-rejected')
    ]);
    expect(out).toBe('already tracked elsewhere (duplicate) (2); the user declined it (closed as not planned) (1)');
    expect(out).not.toContain('no recorded reason');
  });

  it('names the undiagnosed share alongside the diagnoses', () => {
    const out = formatRejectionReasons([rejected('duplicate'), rejected(UNKNOWN_REJECTION_REASON)]);
    expect(out).toBe('already tracked elsewhere (duplicate) (1) — 1 of 2 closed with no recorded reason');
  });

  it('reports a fully undiagnosed history as exactly that', () => {
    // The 0%-diagnosed case is the one the issue exists to surface; it must still
    // produce a line rather than falling back to silence.
    expect(formatRejectionReasons([rejected(UNKNOWN_REJECTION_REASON), rejected(UNKNOWN_REJECTION_REASON)]))
      .toBe('2 of 2 closed with no recorded reason');
  });

  it('caps the listed diagnoses at the limit but still counts the gap over everything', () => {
    const out = formatRejectionReasons([
      rejected('duplicate'),
      rejected('user-rejected'),
      rejected('scope-mismatch'),
      rejected('quality-issue'),
      rejected(UNKNOWN_REJECTION_REASON)
    ], 2);
    expect(out).toContain('already tracked elsewhere (duplicate) (1)');
    expect(out).toContain('1 of 5 closed with no recorded reason');
    expect(out).not.toContain('quality');
  });

  it('reports the measured and unmeasured gaps as separate facts', () => {
    // "we looked and found nothing" and "we never looked" have different remedies,
    // so the line must not merge them into one number.
    const out = formatRejectionReasons([
      rejected('duplicate'),
      rejected(UNKNOWN_REJECTION_REASON),
      rejected(null)
    ]);
    expect(out).toBe(
      'already tracked elsewhere (duplicate) (1) — 1 of 3 closed with no recorded reason — 1 of 3 not yet classified'
    );
  });
});
