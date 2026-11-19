import { describe, it, expect } from 'vitest';
import {
  LI_DELIVERY_MIN_SAMPLE,
  LI_HARD_GATE_DELIVERY_THRESHOLD,
  LI_HARD_GATE_EXECUTION_THRESHOLD,
} from './constants.js';
import {
  computeHandoffRouting,
} from './awareness.js';
import {
  computeHardExclusionGate,
  computeHardExclusionNotice,
  SELF_IMPROVE_SCOPES,
} from './gates.js';

describe('computeHardExclusionGate (#2824)', () => {
  // Degraded (below the 75% gate line) AND confident (>= LI_DEGRADED_MIN_SAMPLE runs).
  const degraded = { read: true, metrics: { completed: 10, succeeded: 3, failed: 7, successRate: 30, recentOutcomes: [] } };
  // Healthy: at/above the gate line.
  const healthy = { read: true, metrics: { completed: 10, succeeded: 9, failed: 1, successRate: 90, recentOutcomes: [] } };
  // Below the sample floor even though 0%.
  const thinSample = { read: true, metrics: { completed: 2, succeeded: 0, failed: 2, successRate: 0, recentOutcomes: [] } };
  const poorDelivery = [
    { outcome: 'merged', executionOutcome: 'success' },
    ...Array.from({ length: 4 }, () => ({ outcome: 'merged', executionOutcome: null }))
  ];

  it('never excludes a null/invalid proposal', () => {
    expect(computeHardExclusionGate({ proposal: null, liTaskStats: degraded })).toEqual({ excluded: false, reason: null });
    expect(computeHardExclusionGate({ liTaskStats: degraded })).toEqual({ excluded: false, reason: null });
  });

  it('is DISARMED when execution health is unknown, healthy, or below the sample floor', () => {
    const p = { scope: 'loop-meta' };
    expect(computeHardExclusionGate({ proposal: p, liTaskStats: null }).excluded).toBe(false);
    expect(computeHardExclusionGate({ proposal: p, liTaskStats: healthy }).excluded).toBe(false);
    expect(computeHardExclusionGate({ proposal: p, liTaskStats: thinSample }).excluded).toBe(false);
  });

  it('arms on a confidently-low delivery rate even when LI runs are healthy', () => {
    const res = computeHardExclusionGate({
      proposal: { scope: 'loop-meta' },
      liTaskStats: healthy,
      outcomes: poorDelivery
    });
    expect(res.excluded).toBe(true);
    expect(res.rule).toBe('self-improve-scope');
    expect(res.reason).toContain('approval-to-completion delivery health 20%');
    expect(res.reason).toContain(`< ${LI_HARD_GATE_DELIVERY_THRESHOLD}%`);
  });

  it('does not arm the delivery signal with no approvals or fewer than its sample floor', () => {
    const p = { scope: 'loop-meta' };
    expect(computeHardExclusionGate({ proposal: p, liTaskStats: healthy, outcomes: [] }).excluded).toBe(false);
    expect(computeHardExclusionGate({
      proposal: p,
      liTaskStats: healthy,
      outcomes: Array.from({ length: LI_DELIVERY_MIN_SAMPLE - 1 }, () => ({ outcome: 'merged', executionOutcome: null }))
    }).excluded).toBe(false);
  });

  it('excludes EVERY self-improve scope when armed, regardless of domain history', () => {
    for (const scope of SELF_IMPROVE_SCOPES) {
      const res = computeHardExclusionGate({ proposal: { scope }, liTaskStats: degraded, outcomes: [] });
      expect(res.excluded).toBe(true);
      expect(res.rule).toBe('self-improve-scope');
      expect(res.reason).toContain(scope);
      expect(res.reason).toContain(`< ${LI_HARD_GATE_EXECUTION_THRESHOLD}%`);
    }
  });

  it('excludes a non-self-improve proposal in a chronically-failing domain when armed', () => {
    const outcomes = [
      { scope: 'app-improvement', executionOutcome: 'success' },
      { scope: 'app-improvement', executionOutcome: 'failure', failureCategory: 'planning' },
      { scope: 'app-improvement', executionOutcome: 'failure', failureCategory: 'planning' } // 1/3 = 33% < 50%
    ];
    const res = computeHardExclusionGate({ proposal: { scope: 'app-improvement' }, liTaskStats: degraded, outcomes });
    expect(res.excluded).toBe(true);
    expect(res.rule).toBe('failing-domain');
    expect(res.reason).toContain('app-improvement');
    expect(res.reason).toContain('33%');
  });

  it('does NOT exclude a non-self-improve proposal in a healthy/unknown domain even when armed', () => {
    // app-data-gap has no failing execution history → domain rule can't fire.
    expect(computeHardExclusionGate({ proposal: { scope: 'app-data-gap' }, liTaskStats: degraded, outcomes: [] }).excluded).toBe(false);
    // A domain at/above the avoid line is not chronically failing.
    const okOutcomes = [
      { scope: 'app-improvement', executionOutcome: 'success' },
      { scope: 'app-improvement', executionOutcome: 'success' },
      { scope: 'app-improvement', executionOutcome: 'failure' } // 2/3 = 67% >= 50%
    ];
    expect(computeHardExclusionGate({ proposal: { scope: 'app-improvement' }, liTaskStats: degraded, outcomes: okOutcomes }).excluded).toBe(false);
  });

  it('agrees with computeHandoffRouting on which non-self-improve domains are chronically failing', () => {
    const outcomes = [
      { scope: 'app-improvement', executionOutcome: 'failure' },
      { scope: 'app-improvement', executionOutcome: 'failure' } // 0/2 = 0%
    ];
    // Both the hand-off gate and the filing gate flag the same domain; the filing gate
    // additionally requires degraded overall health to fire.
    expect(computeHandoffRouting({ proposal: { scope: 'app-improvement' }, outcomes }).handoff).toBe(false);
    expect(computeHardExclusionGate({ proposal: { scope: 'app-improvement' }, liTaskStats: degraded, outcomes }).excluded).toBe(true);
    // …but with healthy execution health, the filing gate stays disarmed.
    expect(computeHardExclusionGate({ proposal: { scope: 'app-improvement' }, liTaskStats: healthy, outcomes }).excluded).toBe(false);
  });
});

describe('computeHardExclusionNotice (#2824)', () => {
  const degraded = { read: true, metrics: { completed: 10, succeeded: 3, failed: 7, successRate: 30, recentOutcomes: [] } };
  const healthy = { read: true, metrics: { completed: 10, succeeded: 9, failed: 1, successRate: 90, recentOutcomes: [] } };
  const poorDelivery = [
    { outcome: 'merged', executionOutcome: 'success' },
    ...Array.from({ length: 4 }, () => ({ outcome: 'merged', executionOutcome: null }))
  ];

  it('is empty when the gate is disarmed (healthy / unknown health)', () => {
    expect(computeHardExclusionNotice({ liTaskStats: healthy })).toBe('');
    expect(computeHardExclusionNotice({ liTaskStats: null })).toBe('');
  });

  it('names the self-improve scopes, the armed health, and the GATE CHECK step', () => {
    const notice = computeHardExclusionNotice({ liTaskStats: degraded, outcomes: [] });
    expect(notice).toContain('HARD EXCLUSION GATE ARMED');
    expect(notice).toContain('30%');
    expect(notice).toContain(`below ${LI_HARD_GATE_EXECUTION_THRESHOLD}%`);
    for (const scope of SELF_IMPROVE_SCOPES) expect(notice).toContain(scope);
    expect(notice).toContain('GATE CHECK');
    expect(notice).toContain('return proposal: null');
  });

  it('names a currently chronically-failing domain when one exists', () => {
    const outcomes = [
      { scope: 'app-improvement', executionOutcome: 'failure' },
      { scope: 'app-improvement', executionOutcome: 'failure' } // 0% over 2
    ];
    const notice = computeHardExclusionNotice({ liTaskStats: degraded, outcomes });
    expect(notice).toContain('chronically-failing execution domain');
    expect(notice).toContain('app-improvement');
  });

  it('names delivery health when that independent signal arms the gate', () => {
    const notice = computeHardExclusionNotice({ liTaskStats: healthy, outcomes: poorDelivery });
    expect(notice).toContain('approval-to-completion delivery health 20%');
    expect(notice).toContain(`below ${LI_HARD_GATE_DELIVERY_THRESHOLD}%`);
  });
});
