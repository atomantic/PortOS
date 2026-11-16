import { describe, it, expect } from 'vitest';
import {
  validateReasonerResponse,
  isHandoffEligible,
  buildHandoffTask,
  resolveBlockOnIssue,
  filerForTracker,
  trackerSupportsPause,
} from './proposal.js';
import {
  HANDOFF_COMPLEXITY,
} from './constants.js';

describe('validateReasonerResponse', () => {
  it('keeps a valid proposal and normalizes the slug', () => {
    const r = validateReasonerResponse({
      analysis: 'a',
      proposal: { scope: 'app-improvement', slug: 'Do The Thing', title: 'Do the thing', body: 'b', value: 'v' }
    });
    expect(r.proposal.slug).toBe('do-the-thing');
    expect(r.proposal.scope).toBe('app-improvement');
    expect(r.pause).toBe(null);
  });

  it('drops a proposal with an unrecognized scope', () => {
    const r = validateReasonerResponse({ proposal: { scope: 'nuke', slug: 'x', title: 'X' } });
    expect(r.proposal).toBe(null);
  });

  it('drops a proposal missing a title', () => {
    const r = validateReasonerResponse({ proposal: { scope: 'app-improvement', slug: 'x', title: '  ' } });
    expect(r.proposal).toBe(null);
  });

  it('drops a proposal with an empty slug', () => {
    const r = validateReasonerResponse({ proposal: { scope: 'app-improvement', slug: '!!', title: 'X' } });
    expect(r.proposal).toBe(null);
  });

  it('keeps a pause with an integer issue number', () => {
    const r = validateReasonerResponse({ pause: { blockOnIssue: 42, reason: 'blocked' } });
    expect(r.pause).toEqual({ blockOnIssue: 42, reason: 'blocked' });
  });

  it('keeps pause "this" ONLY when a proposal survives', () => {
    const withProp = validateReasonerResponse({
      proposal: { scope: 'app-improvement', slug: 'x', title: 'X' },
      pause: { blockOnIssue: 'this', reason: 'block on the new one' }
    });
    expect(withProp.pause).toEqual({ blockOnIssue: 'this', reason: 'block on the new one' });
  });

  it('drops pause "this" when there is no proposal to block on', () => {
    const r = validateReasonerResponse({ proposal: null, pause: { blockOnIssue: 'this', reason: 'x' } });
    expect(r.pause).toBe(null);
  });

  it('drops a pause with no reason', () => {
    const r = validateReasonerResponse({ pause: { blockOnIssue: 42, reason: '' } });
    expect(r.pause).toBe(null);
  });

  it('coerces a numeric-string issue number', () => {
    const r = validateReasonerResponse({ pause: { blockOnIssue: '17', reason: 'x' } });
    expect(r.pause.blockOnIssue).toBe(17);
  });

  it('handles garbage input without throwing', () => {
    expect(validateReasonerResponse(null)).toEqual({ analysis: '', proposal: null, pause: null, invalidFields: [] });
    expect(validateReasonerResponse('nope')).toEqual({ analysis: '', proposal: null, pause: null, invalidFields: [] });
    expect(validateReasonerResponse({ proposal: [], pause: [] }))
      .toEqual({ analysis: '', proposal: null, pause: null, invalidFields: ['proposal', 'pause'] });
  });

  it('normalizes proposal complexity + safe (defaults: null / false)', () => {
    const bare = validateReasonerResponse({ proposal: { scope: 'app-improvement', slug: 'x', title: 'X' } });
    expect(bare.proposal.complexity).toBe(null);
    expect(bare.proposal.safe).toBe(false);

    const trivial = validateReasonerResponse({ proposal: { scope: 'app-improvement', slug: 'x', title: 'X', complexity: 'trivial', safe: true } });
    expect(trivial.proposal.complexity).toBe('trivial');
    expect(trivial.proposal.safe).toBe(true);

    // Unknown complexity → null; a non-strict-true safe → false.
    const junk = validateReasonerResponse({ proposal: { scope: 'app-improvement', slug: 'x', title: 'X', complexity: 'epic', safe: 'yes' } });
    expect(junk.proposal.complexity).toBe(null);
    expect(junk.proposal.safe).toBe(false);
  });

  it('validates optional model/effort independently of complexity and of each other', () => {
    const bare = validateReasonerResponse({ proposal: { scope: 'app-improvement', slug: 'x', title: 'X' } });
    expect(bare.proposal.model).toBe(null);
    expect(bare.proposal.effort).toBe(null);
    expect(bare.proposal.goodFirstIssue).toBe(false);
    expect(bare.proposal.helpWanted).toBe(false);

    const offDiagonal = validateReasonerResponse({
      proposal: { scope: 'app-improvement', slug: 'x', title: 'X', complexity: 'complex', model: 'light', effort: 'max' }
    });
    expect(offDiagonal.proposal.complexity).toBe('complex');
    expect(offDiagonal.proposal.model).toBe('light');
    expect(offDiagonal.proposal.effort).toBe('max');

    const junk = validateReasonerResponse({
      proposal: { scope: 'app-improvement', slug: 'x', title: 'X', model: 'opus', effort: 'none', goodFirstIssue: 'yes' }
    });
    expect(junk.proposal.model).toBe(null);
    expect(junk.proposal.effort).toBe(null);
    expect(junk.proposal.goodFirstIssue).toBe(false);

    const contributor = validateReasonerResponse({
      proposal: { scope: 'app-improvement', slug: 'x', title: 'X', model: 'light', goodFirstIssue: true, helpWanted: true, helpWantedReason: 'user-perspectives' }
    });
    expect(contributor.proposal.goodFirstIssue).toBe(true);
    expect(contributor.proposal.helpWanted).toBe(true);
  });

  describe('invalidFields (#4166)', () => {
    it('reports a wrong-typed analysis and drops it', () => {
      const r = validateReasonerResponse({ analysis: 7 });
      expect(r.analysis).toBe('');
      expect(r.invalidFields).toEqual(['analysis']);
    });

    it('reports a supplied-but-unusable proposal', () => {
      expect(validateReasonerResponse({ proposal: { scope: 'nuke', slug: 'x', title: 'X' } }).invalidFields).toEqual(['proposal']);
      expect(validateReasonerResponse({ proposal: 'do the thing' }).invalidFields).toEqual(['proposal']);
    });

    it('reports a supplied-but-unusable pause', () => {
      expect(validateReasonerResponse({ pause: { blockOnIssue: 42, reason: '' } }).invalidFields).toEqual(['pause']);
      expect(validateReasonerResponse({ pause: { reason: 'no target' } }).invalidFields).toEqual(['pause']);
      // "this" with nothing to block on is malformed, not an empty answer.
      expect(validateReasonerResponse({ proposal: null, pause: { blockOnIssue: 'this', reason: 'x' } }).invalidFields).toEqual(['pause']);
    });

    it('does not double-report a "this" pause dropped as collateral of an invalid proposal', () => {
      // The pause is well-formed — it was dropped only because the proposal it pointed
      // at failed validation. One root cause, one report.
      const r = validateReasonerResponse({
        proposal: { scope: 'nuke', slug: 'x', title: 'X' },
        pause: { blockOnIssue: 'this', reason: 'block on the new one' }
      });
      expect(r.pause).toBe(null);
      expect(r.invalidFields).toEqual(['proposal']);
    });

    it('still reports a "this" pause that is itself malformed alongside a bad proposal', () => {
      // No reason → the pause is broken on its own terms, not collateral.
      const r = validateReasonerResponse({
        proposal: { scope: 'nuke', slug: 'x', title: 'X' },
        pause: { blockOnIssue: 'this', reason: '' }
      });
      expect(r.invalidFields).toEqual(['proposal', 'pause']);
    });

    it('treats an absent or explicitly-null field as absent, never malformed', () => {
      expect(validateReasonerResponse({ analysis: 'nothing to propose', proposal: null, pause: null }).invalidFields).toEqual([]);
      expect(validateReasonerResponse({ proposal: null }).invalidFields).toEqual([]);
      expect(validateReasonerResponse({ analysis: '' }).invalidFields).toEqual([]);
      expect(validateReasonerResponse({}).invalidFields).toEqual([]);
    });

    it('stays empty for a fully valid envelope', () => {
      const r = validateReasonerResponse({
        analysis: 'a',
        proposal: { scope: 'app-improvement', slug: 'x', title: 'X' },
        pause: { blockOnIssue: 'this', reason: 'block on the new one' }
      });
      expect(r.invalidFields).toEqual([]);
    });

    it('collects every unusable field, in envelope order', () => {
      const r = validateReasonerResponse({ analysis: [], proposal: {}, pause: 3 });
      expect(r.invalidFields).toEqual(['analysis', 'proposal', 'pause']);
    });
  });
});

describe('isHandoffEligible', () => {
  const trivialSafe = { complexity: HANDOFF_COMPLEXITY, safe: true };
  const on = { handoff: { enabled: true } };

  it('is eligible only when enabled + filed ref + trivial + safe', () => {
    expect(isHandoffEligible({ proposal: trivialSafe, config: on, filed: 42 })).toBe(true);
    expect(isHandoffEligible({ proposal: trivialSafe, config: on, filed: 'PROJ-7' })).toBe(true);
  });

  it('is NOT eligible when hand-off is disabled', () => {
    expect(isHandoffEligible({ proposal: trivialSafe, config: { handoff: { enabled: false } }, filed: 42 })).toBe(false);
    expect(isHandoffEligible({ proposal: trivialSafe, config: {}, filed: 42 })).toBe(false);
  });

  it('is NOT eligible without a concrete filed ref (plan-tracked apps)', () => {
    expect(isHandoffEligible({ proposal: trivialSafe, config: on, filed: null })).toBe(false);
    expect(isHandoffEligible({ proposal: trivialSafe, config: on, filed: '' })).toBe(false);
    expect(isHandoffEligible({ proposal: trivialSafe, config: on, filed: false })).toBe(false);
  });

  it('is NOT eligible unless BOTH trivial AND safe', () => {
    expect(isHandoffEligible({ proposal: { complexity: 'moderate', safe: true }, config: on, filed: 1 })).toBe(false);
    expect(isHandoffEligible({ proposal: { complexity: 'trivial', safe: false }, config: on, filed: 1 })).toBe(false);
    expect(isHandoffEligible({ proposal: null, config: on, filed: 1 })).toBe(false);
  });
});

describe('buildHandoffTask', () => {
  const app = { id: 'app-1', name: 'App One' };
  const proposal = { title: 'Fix the typo', body: 'change X to Y', value: 'clarity', slug: 'fix-typo' };

  it('builds an approval-gated internal task scoped to the app', () => {
    const t = buildHandoffTask({ app, proposal, issueRef: 42 });
    expect(t.approvalRequired).toBe(true);
    expect(t.app).toBe('app-1');
    expect(t.priority).toBe('MEDIUM');
    expect(t.description).toBe('LI hand-off: Fix the typo');
  });

  it('references the filed issue in the context (# for forge number, raw key for jira)', () => {
    expect(buildHandoffTask({ app, proposal, issueRef: 42 }).context).toContain('#42');
    const jira = buildHandoffTask({ app, proposal, issueRef: 'PROJ-7' }).context;
    expect(jira).toContain('PROJ-7');
    expect(jira).toContain('change X to Y'); // carries the proposal body
  });

  it('stamps the proposal identity + domain for per-domain execution tracking when recordExecution (#2765)', () => {
    const t = buildHandoffTask({ app, proposal: { ...proposal, scope: 'loop-meta' }, issueRef: 42, recordExecution: true });
    expect(t.liProposal).toEqual({ appId: 'app-1', slug: 'fix-typo', scope: 'loop-meta' });
  });

  it('omits the execution marker when outcomes tracking is off (recordExecution false/absent) (#2765)', () => {
    // Honors the `outcomes` source toggle: a hand-off filed while tracking is off must
    // not carry a marker, or recordProposalExecution's fallback would create an orphan
    // outcome row the toggle says isn't tracked (codex P2).
    expect(buildHandoffTask({ app, proposal: { ...proposal, scope: 'loop-meta' }, issueRef: 42, recordExecution: false }).liProposal).toBeUndefined();
    expect(buildHandoffTask({ app, proposal: { ...proposal, scope: 'loop-meta' }, issueRef: 42 }).liProposal).toBeUndefined();
  });
});

describe('resolveBlockOnIssue', () => {
  it('maps "this" to the just-filed issue number', () => {
    expect(resolveBlockOnIssue({ blockOnIssue: 'this' }, 99)).toBe(99);
  });

  it('returns null for "this" with no filed issue', () => {
    expect(resolveBlockOnIssue({ blockOnIssue: 'this' }, null)).toBe(null);
  });

  it('passes an integer through', () => {
    expect(resolveBlockOnIssue({ blockOnIssue: 7 }, null)).toBe(7);
  });

  it('returns null for a null pause', () => {
    expect(resolveBlockOnIssue(null, 5)).toBe(null);
  });
});

describe('filerForTracker / trackerSupportsPause (dispatch)', () => {
  it('routes forges to the forge filer', () => {
    expect(filerForTracker('github')).toBe('forge');
    expect(filerForTracker('gitlab')).toBe('forge');
  });

  it('routes jira to the jira filer', () => {
    expect(filerForTracker('jira')).toBe('jira');
  });

  it('routes plan (and unknowns) to the plan filer', () => {
    expect(filerForTracker('plan')).toBe('plan');
    expect(filerForTracker(undefined)).toBe('plan');
    expect(filerForTracker('weird')).toBe('plan');
  });

  it('plan does not support pause; forge/jira do', () => {
    expect(trackerSupportsPause('plan')).toBe(false);
    expect(trackerSupportsPause('github')).toBe(true);
    expect(trackerSupportsPause('jira')).toBe(true);
  });
});
