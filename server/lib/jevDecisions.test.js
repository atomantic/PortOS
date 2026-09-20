import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JEV_MAX_HYPOTHESES, JEV_MAX_HYPOTHESIS_CHARS } from './jev.js';
import {
  JEV_DECISIONS,
  JEV_DECISION_IDS,
  getJevDecision,
  isValidJevDecision,
  jevHypotheses,
  jevMinMarginFor,
  jevValueForHypothesis,
} from './jevDecisions.js';
import { UNTRUSTED_CONTENT_SOURCES, untrustedContentPolicySchema } from './untrustedContent.js';

// Keep the contract assertion from making the broad jev test suite eagerly
// instantiate the Stacker News service subtree.
const { modelAnalysisSchema } = await import('../services/stackerNewsPolicy.js');

describe('shipped jev decisions', () => {
  // A typo here is silent in production: the scorer rejects the request, the
  // caller falls back, and the chat model keeps answering forever.
  it('every descriptor is actually scorable', () => {
    for (const id of JEV_DECISION_IDS) {
      const decision = JEV_DECISIONS[id];
      expect(isValidJevDecision(decision), id).toBe(true);
      expect(decision.options.length, id).toBeLessThanOrEqual(JEV_MAX_HYPOTHESES);
      // `source` is the ingress CHANNEL, and `null` for a decision that has
      // none (see the field's note in jevDecisions.js). A channel-free
      // decision must say so with an explicit null rather than by omitting the
      // key, or a typo'd channel would read as "not a channel" and skip this
      // guard entirely.
      expect(Object.hasOwn(decision, 'source'), id).toBe(true);
      if (decision.source !== null) expect(UNTRUSTED_CONTENT_SOURCES, id).toContain(decision.source);
      expect(typeof decision.label, id).toBe('string');
    }
    expect(isValidJevDecision({ minMargin: 0.2, options: [{ value: 'a', hypothesis: 'a'.repeat(JEV_MAX_HYPOTHESIS_CHARS + 1) }, { value: 'b', hypothesis: 'b' }] })).toBe(false);
    // One option is a yes/no question, not a closed set: there is no runner-up
    // to measure a margin against.
    expect(isValidJevDecision({ minMargin: 0.2, options: [{ value: 'a', hypothesis: 'a' }] })).toBe(false);
    expect(isValidJevDecision({ minMargin: 0.2, options: [{ value: 'a', hypothesis: 'same' }, { value: 'b', hypothesis: 'same' }] })).toBe(false);
  });

  it('round-trips a hypothesis back to the enum value it stands for', () => {
    for (const id of JEV_DECISION_IDS) {
      const hypotheses = jevHypotheses(id);
      expect(hypotheses.map((hypothesis) => jevValueForHypothesis(id, hypothesis)))
        .toEqual(JEV_DECISIONS[id].options.map((option) => option.value));
    }
    expect(jevValueForHypothesis('issue-comment-reply', 'a hypothesis nobody shipped')).toBeNull();
    expect(getJevDecision('no-such-decision')).toBeNull();
    expect(jevHypotheses('no-such-decision')).toBeNull();
  });

  it('keeps a decision floor unreachable from the operator setting, and raises it per option', () => {
    // The setting may only tighten. A `jevMinMargin: 0` install still holds
    // `delete` to its own floor, which is the entire safety argument for
    // letting a local argmax touch a real person's mail.
    expect(jevMinMarginFor('message-triage', { policyMinMargin: 0 })).toBe(JEV_DECISIONS['message-triage'].minMargin);
    expect(jevMinMarginFor('message-triage', { optionValue: 'delete', policyMinMargin: 0 })).toBe(0.6);
    expect(jevMinMarginFor('message-triage', { optionValue: 'archive', policyMinMargin: 0 })).toBe(JEV_DECISIONS['message-triage'].minMargin);
    expect(jevMinMarginFor('message-triage', { optionValue: 'archive', policyMinMargin: 0.9 })).toBe(0.9);
    expect(jevMinMarginFor('stacker-news-classification', { optionValue: 'allowed', policyMinMargin: 0 })).toBe(1);
    expect(jevMinMarginFor('no-such-decision')).toBeNull();
    // Every destructive-leaning option carries a floor above its decision's.
    for (const [decisionId, optionValue] of [['message-triage', 'delete'], ['forge-maintenance-disposition', 'inspect-trusted-change']]) {
      expect(jevMinMarginFor(decisionId, { optionValue }), `${decisionId}/${optionValue}`)
        .toBeGreaterThan(JEV_DECISIONS[decisionId].minMargin);
    }
  });

  it('accepts the policy fields the panel writes and rejects an out-of-range margin', () => {
    expect(untrustedContentPolicySchema.safeParse({ jevMode: 'prefer', jevMinMargin: 0.4 }).success).toBe(true);
    expect(untrustedContentPolicySchema.safeParse({ jevMinMargin: null }).success).toBe(true);
    expect(untrustedContentPolicySchema.safeParse({ jevMode: 'always' }).success).toBe(false);
    expect(untrustedContentPolicySchema.safeParse({ jevMinMargin: 1.5 }).success).toBe(false);
  });

  it('projects onto the enums the callers already validate against', () => {
    // The plans build values for contracts that are declared in the services.
    // Mirroring the enums here is what catches a descriptor and a caller schema
    // drifting apart — the scorer would then answer with a member the caller's
    // own validator rejects, and the fallback would be permanent and silent.
    const enums = {
      'issue-comment-reply': z.enum(['reply', 'none']),
      'message-triage': z.enum(['reply', 'archive', 'delete', 'review']),
      'message-priority': z.enum(['high', 'medium', 'low']),
      'stacker-news-classification': modelAnalysisSchema.shape.classification,
      'stacker-news-risk': modelAnalysisSchema.shape.risk,
      'forge-maintenance-disposition': z.enum(['inspect-trusted-change', 'defer']),
      'scope-adherence': z.enum(['aligned', 'unrelated', 'contradicts']),
    };
    expect(Object.keys(enums).sort()).toEqual([...JEV_DECISION_IDS].sort());
    for (const [id, contract] of Object.entries(enums)) {
      expect(JEV_DECISIONS[id].options.map((option) => option.value).sort(), id)
        .toEqual([...contract.options].sort());
    }
  });
});
