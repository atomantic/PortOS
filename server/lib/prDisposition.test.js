import { describe, expect, it } from 'vitest';
import { PR_COMPLETIONS, PR_CREATION, prClaimWasVerified, resolvePrCompletion, resolvePrCreation } from './prDisposition.js';

describe('resolvePrCompletion', () => {
  it('prefers an explicit valid disposition', () => {
    expect(resolvePrCompletion({ prCompletion: PR_COMPLETIONS.LEAVE_OPEN, reviewLoop: true }))
      .toBe(PR_COMPLETIONS.LEAVE_OPEN);
  });

  it.each([
    [{ openPR: true, reviewLoop: true }, PR_COMPLETIONS.REVIEW_THEN_MERGE],
    [{ openPR: true, reviewLoop: 'true' }, PR_COMPLETIONS.REVIEW_THEN_MERGE],
    [{ openPR: true, reviewLoop: false }, PR_COMPLETIONS.MERGE_ON_GREEN],
    [{ openPR: true }, PR_COMPLETIONS.MERGE_ON_GREEN],
  ])('preserves legacy behavior for %o', (metadata, expected) => {
    expect(resolvePrCompletion(metadata)).toBe(expected);
  });

  it('falls back to legacy behavior when an unrecognized value is stored', () => {
    expect(resolvePrCompletion({ prCompletion: 'later', reviewLoop: true }))
      .toBe(PR_COMPLETIONS.REVIEW_THEN_MERGE);
  });
});

describe('resolvePrCreation (#3733)', () => {
  it('never creates one for a task that asked for no PR', () => {
    expect(resolvePrCreation({ taskOpenPR: false, agentOwnsPr: false, prClaimVerified: false })).toBe(PR_CREATION.NEVER);
    // …even if the agent would otherwise have owned it.
    expect(resolvePrCreation({ taskOpenPR: false, agentOwnsPr: true, prClaimVerified: false })).toBe(PR_CREATION.NEVER);
  });

  it('creates one outright when PortOS owns the lifecycle (a lean --bare session)', () => {
    expect(resolvePrCreation({ taskOpenPR: true, agentOwnsPr: false, prClaimVerified: false })).toBe(PR_CREATION.ALWAYS);
  });

  it('never creates an empty PR after finalize proves an opted-in audit is a no-op', () => {
    expect(resolvePrCreation({
      taskOpenPR: true,
      agentOwnsPr: false,
      prClaimVerified: false,
      noChangesToShip: true,
    })).toBe(PR_CREATION.NEVER);
  });

  it('backstops an owner finalize did NOT verify — the slashdo-free harnesses', () => {
    expect(resolvePrCreation({ taskOpenPR: true, agentOwnsPr: true, prClaimVerified: false })).toBe(PR_CREATION.IF_MISSING);
  });

  it('backstops an owner whose claim was never actually verified', () => {
    // `prClaimVerified` is the ACTUAL verdict, not "was one expected" — finalize
    // substitutes a bare `{ok:true}` when its check throws or the run was
    // user-terminated, and a throw from finalize skips the assignment entirely.
    expect(resolvePrCreation({ taskOpenPR: true, agentOwnsPr: true, prClaimVerified: false })).toBe(PR_CREATION.IF_MISSING);
  });

  it('stands down for an owner finalize already verified, rather than re-asking the forge', () => {
    // A slashdo-capable run that reaches cleanup as a success already passed
    // verifyPrClaim; a second `gh pr list` would be pure duplication.
    expect(resolvePrCreation({ taskOpenPR: true, agentOwnsPr: true, prClaimVerified: true })).toBe(PR_CREATION.NEVER);
  });
});

describe('prClaimWasVerified (#3733)', () => {
  it('accepts only a forge answer about a real branch', () => {
    expect(prClaimWasVerified({ ok: true, branch: 'feature-x' })).toBe(true);
    expect(prClaimWasVerified({ ok: true, branch: 'feature-x', noChangesToShip: true })).toBe(true);
  });

  it('rejects a bare ok — that is "nothing was verified", not "a PR exists"', () => {
    // verifyPrClaim returns this shape for a run it never checked (prExpected
    // false, a failed run, no workspace) and for a branch it could not name
    // (detached HEAD); both finalize and cleanup also substitute it when the
    // check throws or the run was user-terminated. Reading it as a confirmed PR
    // is what let a stand-down delete an unpushed branch with no PR.
    expect(prClaimWasVerified({ ok: true })).toBe(false);
    expect(prClaimWasVerified({ ok: true, branch: null })).toBe(false);
    expect(prClaimWasVerified({ ok: true, branch: '' })).toBe(false);
  });

  it('rejects a real negative verdict, and a missing one', () => {
    expect(prClaimWasVerified({ ok: false, branch: 'b', category: 'pr-missing' })).toBe(false);
    expect(prClaimWasVerified({ ok: false, branch: 'b', category: 'forge-unreachable' })).toBe(false);
    expect(prClaimWasVerified(undefined)).toBe(false);
    expect(prClaimWasVerified(null)).toBe(false);
  });
});
