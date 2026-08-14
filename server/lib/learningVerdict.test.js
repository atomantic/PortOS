import { describe, it, expect } from 'vitest';
import { SKIP_LEARNING_VERDICT, isSkipLearningVerdict, toValidationVerdict } from './learningVerdict.js';

// The whole point of this module is that FOUR verdicts stay four verdicts
// (#4107). These tests pin the sentinel's identity and the two narrowings that
// keep it from leaking into consumers that only understand three.

describe('SKIP_LEARNING_VERDICT', () => {
  it('is a JSON-safe string that survives a persist/read round-trip', () => {
    // Not a Symbol: the verdict is written onto the agent record and read back by
    // the learning backfill, so it must survive JSON.
    expect(typeof SKIP_LEARNING_VERDICT).toBe('string');
    const roundTripped = JSON.parse(JSON.stringify({ validationPassed: SKIP_LEARNING_VERDICT }));
    expect(isSkipLearningVerdict(roundTripped.validationPassed)).toBe(true);
  });

  it('is distinct from every value the pre-#4107 contract could produce', () => {
    for (const other of [true, false, null, undefined, 0, '', 'true', 'false', 'skip']) {
      expect(SKIP_LEARNING_VERDICT).not.toBe(other);
    }
  });
});

describe('isSkipLearningVerdict', () => {
  it('recognizes only the exact sentinel', () => {
    expect(isSkipLearningVerdict(SKIP_LEARNING_VERDICT)).toBe(true);
  });

  it('rejects the three verdicts that DO get recorded', () => {
    // The regression this guards: collapsing "undeclared" or "criterion missed"
    // into the skip path would silently stop recording ordinary runs.
    expect(isSkipLearningVerdict(true)).toBe(false);
    expect(isSkipLearningVerdict(false)).toBe(false);
    expect(isSkipLearningVerdict(null)).toBe(false);
    expect(isSkipLearningVerdict(undefined)).toBe(false);
  });

  it('rejects near-miss and truthy-but-unrecognized values', () => {
    // An unknown string (a future sentinel written by a newer peer) must NOT be
    // treated as a skip — it falls through to the recorded, exit-code-fallback
    // path rather than silently vanishing from the metrics.
    for (const other of ['skip', 'skip-learning ', 'SKIP-LEARNING', 'future-sentinel', 1, {}]) {
      expect(isSkipLearningVerdict(other)).toBe(false);
    }
  });
});

describe('toValidationVerdict', () => {
  it('passes explicit booleans through unchanged', () => {
    expect(toValidationVerdict(true)).toBe(true);
    expect(toValidationVerdict(false)).toBe(false);
  });

  it('narrows the skip sentinel to null rather than leaking a string downstream', () => {
    // Consumers of `validationPassed` (failure signatures, LI execution verdicts)
    // understand three values. The sentinel must never reach them as a string.
    expect(toValidationVerdict(SKIP_LEARNING_VERDICT)).toBeNull();
  });

  it('narrows absent/malformed values to null, never to false', () => {
    // "Not evaluated" masquerading as "declared and missed" is the exact
    // conflation the repo sentinel rule forbids.
    for (const absent of [undefined, null, '', 0, 'yes', {}, []]) {
      expect(toValidationVerdict(absent)).toBeNull();
    }
  });
});
