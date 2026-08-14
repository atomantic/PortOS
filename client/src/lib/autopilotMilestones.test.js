import { describe, it, expect } from 'vitest';
import {
  buildAutopilotMilestones,
  summarizeAutopilotMilestones,
  describeAutopilotVerification,
  autopilotStepLabel,
  MILESTONE_STATUS,
} from './autopilotMilestones';

const PLAN = [
  { kind: 'generateArc', count: 1, estActions: 1 },
  { kind: 'verifyArcSpine', count: 1, note: 'up to 3 round(s)', estActions: 4 },
  { kind: 'foundationGate', count: 1, estActions: 4 },
  { kind: 'textStages', count: 4, estActions: 4 },
  { kind: 'editorialReview', count: 1, estActions: 3 },
];

const statuses = (rows) => Object.fromEntries(rows.map((r) => [r.kind, r.status]));

describe('buildAutopilotMilestones', () => {
  it('is all-pending for a plan with no progress yet (the dry-run case)', () => {
    const rows = buildAutopilotMilestones(PLAN, {});
    expect(rows.every((r) => r.status === MILESTONE_STATUS.PENDING)).toBe(true);
    expect(summarizeAutopilotMilestones(rows)).toMatchObject({ done: 0, percent: 0, steps: 5 });
  });

  it('marks finished steps done, the running step active, and the rest pending', () => {
    const rows = buildAutopilotMilestones(PLAN, {
      completed: { generateArc: 1, verifyArcSpine: 1, foundationGate: 1, textStages: 1 },
      currentStep: 'textStages',
    });
    expect(statuses(rows)).toEqual({
      generateArc: MILESTONE_STATUS.DONE,
      verifyArcSpine: MILESTONE_STATUS.DONE,
      foundationGate: MILESTONE_STATUS.DONE,
      textStages: MILESTONE_STATUS.ACTIVE,
      editorialReview: MILESTONE_STATUS.PENDING,
    });
    // The active multi-count step reports its own partial progress.
    expect(rows.find((r) => r.kind === 'textStages')).toMatchObject({ done: 1, count: 4 });
  });

  it('settles the running step once it reports complete', () => {
    const rows = buildAutopilotMilestones(PLAN, {
      completed: { generateArc: 1, verifyArcSpine: 1, foundationGate: 1, textStages: 4 },
      currentStep: 'textStages',
      currentStepComplete: true,
    });
    expect(statuses(rows).textStages).toBe(MILESTONE_STATUS.DONE);
  });

  it('does not un-finish later milestones when the run revisits an earlier gate', () => {
    // The foundation gate re-checks after an arc repair, so `currentStep` moves
    // BACKWARDS while later steps already have completions.
    const rows = buildAutopilotMilestones(PLAN, {
      completed: { generateArc: 1, verifyArcSpine: 1, foundationGate: 1, textStages: 4, editorialReview: 1 },
      currentStep: 'foundationGate',
    });
    expect(statuses(rows)).toMatchObject({
      textStages: MILESTONE_STATUS.DONE,
      editorialReview: MILESTONE_STATUS.DONE,
    });
    // …and the revisited gate is still shown as the one doing work.
    expect(statuses(rows).foundationGate).toBe(MILESTONE_STATUS.ACTIVE);
  });

  it('flags the step a paused run stopped on as blocked, not active', () => {
    const rows = buildAutopilotMilestones(
      PLAN,
      { completed: { generateArc: 1 }, currentStep: 'verifyArcSpine' },
      { terminal: 'paused' },
    );
    expect(statuses(rows).verifyArcSpine).toBe(MILESTONE_STATUS.BLOCKED);
    expect(statuses(rows).editorialReview).toBe(MILESTONE_STATUS.PENDING);
  });

  it('settles every milestone of a completed run, skipping ones it never stepped through', () => {
    const rows = buildAutopilotMilestones(
      PLAN,
      { completed: { generateArc: 1, verifyArcSpine: 1, textStages: 4, editorialReview: 1 } },
      { terminal: 'complete' },
    );
    expect(statuses(rows).foundationGate).toBe(MILESTONE_STATUS.SKIPPED);
    // A settled-but-unstepped milestone still counts toward the meter, or a
    // finished run would sit permanently short of 100%.
    expect(summarizeAutopilotMilestones(rows).percent).toBe(100);
  });

  it('counts a step the run passed without completing as skipped, not still-owed', () => {
    const rows = buildAutopilotMilestones(PLAN, {
      completed: { generateArc: 1, foundationGate: 1 },
      currentStep: 'foundationGate',
    });
    expect(statuses(rows).verifyArcSpine).toBe(MILESTONE_STATUS.SKIPPED);
  });

  it('surfaces sub-step skips and the gate verification on their own milestone', () => {
    const rows = buildAutopilotMilestones(PLAN, {
      completed: { generateArc: 1, verifyArcSpine: 1 },
      skipped: { textStages: 2 },
      verified: { verifyArcSpine: { round: 2, findings: 5, blocking: 0 } },
      currentStep: 'verifyArcSpine',
    });
    expect(rows.find((r) => r.kind === 'textStages').skipped).toBe(2);
    expect(rows.find((r) => r.kind === 'verifyArcSpine').verification)
      .toEqual({ round: 2, findings: 5, blocking: 0 });
  });

  it('weights the meter by step count, not by milestone', () => {
    const rows = buildAutopilotMilestones(PLAN, {
      completed: { generateArc: 1, verifyArcSpine: 1, foundationGate: 1, textStages: 2 },
      currentStep: 'textStages',
    });
    // 3 single-count steps + 2 of 4 text stages, out of 8 units.
    expect(summarizeAutopilotMilestones(rows)).toMatchObject({ total: 8, done: 5, percent: 63, stepsDone: 3 });
  });

  it('tolerates a missing/empty plan', () => {
    expect(buildAutopilotMilestones(null, { completed: { generateArc: 1 } })).toEqual([]);
    expect(summarizeAutopilotMilestones(null)).toMatchObject({ total: 0, percent: 0 });
  });
});

describe('describeAutopilotVerification', () => {
  it('reads a gate by its blocking count', () => {
    expect(describeAutopilotVerification('verifyArc', { findings: 4, blocking: 0 }))
      .toBe('0 blocking of 4 finding(s)');
    expect(describeAutopilotVerification('verifyArc', { findings: 9, blocking: 3 }))
      .toBe('3 blocking of 9 finding(s)');
  });

  it('calls out checks that errored — an unevaluated dimension is not "clean"', () => {
    expect(describeAutopilotVerification('editorialChecks', { findings: 2, blocking: 0, errored: 1 }))
      .toContain('1 errored');
  });

  it('scores the foundation gate instead of counting findings', () => {
    expect(describeAutopilotVerification('foundationGate', { weightedScore: 8.1, threshold: 7.5, weakest: 'craft' }))
      .toBe('weighted 8.1/7.5 · next target: craft');
  });

  it('is null for a gate that has not reported yet', () => {
    expect(describeAutopilotVerification('verifyArc', null)).toBe(null);
    expect(describeAutopilotVerification('verifyArc', {})).toBe(null);
  });
});

describe('autopilotStepLabel', () => {
  it('labels known step kinds and falls back to the raw kind', () => {
    expect(autopilotStepLabel('editorialHealthGate')).toBe('Editorial health gate');
    expect(autopilotStepLabel('somethingNew')).toBe('somethingNew');
  });
});
