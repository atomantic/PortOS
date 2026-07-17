import { describe, it, expect } from 'vitest';
import {
  REJECTION_REASONS,
  REJECTION_REASON_VALUES,
  UNKNOWN_REJECTION_REASON,
  classifyRejection,
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

  it('maps the LI blocking label to an environment blocker', () => {
    expect(classifyRejection({
      outcome: 'rejected',
      labels: ['layered-intelligence:blocking']
    })).toBe('environment-blocker');
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

  it('only ever yields a storable token', () => {
    const got = classifyRejection({ outcome: 'rejected', stateReason: 'not_planned' });
    expect(REJECTION_REASON_VALUES).toContain(got);
  });
});

describe('summarizeRejectionReasons', () => {
  it('counts diagnoses and the unknown gap separately', () => {
    const { entries, unknown, diagnosed, total } = summarizeRejectionReasons([
      rejected('duplicate'),
      rejected('duplicate'),
      rejected('user-rejected'),
      rejected(UNKNOWN_REJECTION_REASON)
    ]);
    expect(entries).toEqual([
      { reason: 'duplicate', count: 2 },
      { reason: 'user-rejected', count: 1 }
    ]);
    expect(unknown).toBe(1);
    expect(diagnosed).toBe(3);
    expect(total).toBe(4);
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

  it('counts an unclassified (pre-taxonomy) record in NEITHER bucket', () => {
    // Reading a null as `unknown` would overstate the very data gap this measures.
    const { total, unknown, diagnosed } = summarizeRejectionReasons([
      { outcome: 'rejected', rejectionReason: null },
      { outcome: 'rejected', rejectionReason: 'duplicate' }
    ]);
    expect(diagnosed).toBe(1);
    expect(unknown).toBe(0);
    expect(total).toBe(1);
  });

  it('drops an unrecognized stored token rather than counting it', () => {
    const { total } = summarizeRejectionReasons([rejected('not-a-real-token')]);
    expect(total).toBe(0);
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
  it('returns empty when nothing is classified, so the caller omits the line', () => {
    // '' must not become "reasons: none", which reads as "nothing was rejected".
    expect(formatRejectionReasons([])).toBe('');
    expect(formatRejectionReasons([{ outcome: 'merged', rejectionReason: null }])).toBe('');
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
});
