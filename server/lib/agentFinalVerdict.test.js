import { describe, expect, it, vi } from 'vitest';
import { resolveAgentFinalVerdict } from './agentFinalVerdict.js';
import { GOAL_FIDELITY_HOLD_VERDICT } from './goalFidelity.js';

// The precedence ladder finalize persists, as a pure function (#9645). Each
// case is a layer the next one must NOT be able to override, or vice versa.
describe('resolveAgentFinalVerdict', () => {
  const PR_OK = { completionOk: true, completionVerdict: { ok: true } };
  const PR_MISSING = { completionOk: false, completionVerdict: { ok: false, category: 'pr-missing', message: 'No PR', branch: 'b' } };
  const DRIFT = { drifted: true, category: 'primary-checkout-mutated', message: 'Primary moved' };
  const HOLD = { verdict: GOAL_FIDELITY_HOLD_VERDICT, missing: ['x'], unrequested: [] };
  const rejected = (extra = {}) => ({ ran: true, outcome: { accepted: false, reason: 'output-missing', message: 'No output', ...extra } });
  const resolve = (overrides) => resolveAgentFinalVerdict({
    reportedSuccess: true, errorAnalysis: null, error: undefined, completionReason: undefined, prEvidence: PR_OK, ...overrides,
  });

  it('applies drift ahead of a missing PR, and only to an otherwise-successful run', () => {
    expect(resolve({ drift: DRIFT, prEvidence: PR_MISSING })).toMatchObject({ source: 'drift', success: false, error: 'Primary moved' });
    expect(resolve({ reportedSuccess: false, errorAnalysis: { category: 'unknown' }, drift: DRIFT }).source).toBe('reported');
    expect(resolve({ reportedSuccess: false, drift: DRIFT, prEvidence: PR_MISSING })).toMatchObject({ source: 'pr', completionReason: 'pr-missing' });
  });

  it('lets fidelity hold only a delivered success', () => {
    expect(resolve({ fidelityReview: HOLD })).toMatchObject({ source: 'fidelity', success: false });
    expect(resolve({ prEvidence: PR_MISSING, fidelityReview: HOLD }).source).toBe('pr');
  });

  it('fails a successful run on any hook rejection and returns a frozen verdict', () => {
    const verdict = resolve({ hookResult: rejected() });
    expect(verdict).toMatchObject({ source: 'hook', success: false, completionReason: 'output-missing', error: 'No output' });
    expect(verdict.errorAnalysis.permanent).toBeUndefined();
    expect(Object.isFrozen(verdict)).toBe(true);
  });

  it('escalates a permanent rejection of an unnamed failure only while that failure would retry', () => {
    const failed = { reportedSuccess: false, errorAnalysis: { category: 'unknown', message: 'Exited 1' }, hookResult: rejected({ permanent: true }) };
    expect(resolve({ ...failed, failureIsTerminal: () => false })).toMatchObject({
      source: 'hook', errorAnalysis: expect.objectContaining({ permanent: true }),
    });
    expect(resolve({ ...failed, failureIsTerminal: () => true })).toMatchObject({
      source: 'reported', error: 'Exited 1', completionReason: 'unknown',
    });
  });

  it('keeps a named cause or a prior downgrade when the hook rejects a failed run', () => {
    const terminal = vi.fn(() => false);
    expect(resolve({
      reportedSuccess: false, errorAnalysis: { category: 'rate-limit', message: 'Later' }, hookResult: rejected({ permanent: true }), failureIsTerminal: terminal,
    })).toMatchObject({ source: 'reported', completionReason: 'rate-limit', error: 'Later' });
    expect(terminal).not.toHaveBeenCalled();
    expect(resolve({ reportedSuccess: false, prEvidence: PR_MISSING, hookResult: rejected() })).toMatchObject({ source: 'pr', error: 'No PR' });
  });

  it('ignores a hook rejection on a user-terminated run', () => {
    expect(resolve({ reportedSuccess: false, terminatedByUser: true, error: 'stopped', hookResult: rejected({ permanent: true }) }))
      .toMatchObject({ source: 'reported', error: 'stopped' });
  });
});
