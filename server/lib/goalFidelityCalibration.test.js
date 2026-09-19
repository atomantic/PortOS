/**
 * The goal-fidelity calibration contract.
 *
 * Two properties carry the feature, and neither is visible from the service's
 * behaviour on one report:
 *
 *  - the fingerprint is keyed on the GAP ALONE, so N false positives from one
 *    blind spot fold into ONE fix rather than minting an agent each. Keying it
 *    on the run (or on the overturned finding, which is keyed on the task) is
 *    the regression, and it looks correct from a single report;
 *  - the calibration task must not read as permission to disarm the detector.
 *    The cheapest way to stop a false positive recurring is to stop the gate
 *    holding runs, an unattended agent will find that path, and the only thing
 *    standing between it and a silently-disabled gate is prose in this body.
 *
 * The report block is pinned against the vocabulary rather than against a
 * transcript: the gaps an agent is told to choose from and the gaps the server
 * dedupes on are the same list, and a drift between them silently files every
 * report under `other` — one undifferentiated task for every blind spot.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_GOAL_FIDELITY_CONTEXT_GAP,
  GOAL_FIDELITY_CALIBRATION_FREE_TEXT_CHARS,
  GOAL_FIDELITY_CONTEXT_GAPS,
  GOAL_FIDELITY_REVIEW_SURFACES,
  buildGoalFidelityCalibrationTask,
  goalFidelityReportIsSubstantive,
  buildGoalFidelityFalsePositiveReportBlock,
  describeGoalFidelityContextGap,
  formatGoalFidelityCalibrationSummary,
  goalFidelityCalibrationFingerprint,
  normalizeGoalFidelityContextGap,
} from './goalFidelityCalibration.js';
import { investigationFingerprint } from './investigationTasks.js';

describe('the context-gap vocabulary', () => {
  it('routes every gap to a named file, so a calibration never says only "context was missing"', () => {
    for (const gap of GOAL_FIDELITY_CONTEXT_GAPS) {
      // A pointer that names no source file sends the next agent back to
      // re-deriving the architecture, which is the cost this table exists to
      // remove. `goalFidelityCalibration.pointers.test.js` checks those paths
      // against the real files; here it is only that every gap gets one.
      expect(describeGoalFidelityContextGap(gap), `${gap}'s advice names no file`)
        .toMatch(/server\/(lib|services)\/[\w/]+\.js/);
    }
  });

  it('normalizes an unrecognized gap to `other` instead of dropping the report', () => {
    // A report with a bad enum still carries a real diagnosis in its prose; the
    // gap only decides which task it folds into.
    expect(normalizeGoalFidelityContextGap('the-model-was-confused')).toBe(DEFAULT_GOAL_FIDELITY_CONTEXT_GAP);
    expect(normalizeGoalFidelityContextGap(undefined)).toBe(DEFAULT_GOAL_FIDELITY_CONTEXT_GAP);
    expect(normalizeGoalFidelityContextGap('rubric-gap')).toBe('rubric-gap');
  });
});

describe('goalFidelityCalibrationFingerprint', () => {
  it('keeps distinct gaps distinct — they are different fixes in different files', () => {
    const keys = new Set(GOAL_FIDELITY_CONTEXT_GAPS.map(goalFidelityCalibrationFingerprint));
    expect(keys.size).toBe(GOAL_FIDELITY_CONTEXT_GAPS.length);
  });

  // The whole affordability argument, and the regression this pins: a scheduled
  // task drifting the same way produces one overturned finding per cadence, and
  // each must fold into the single fix rather than queue its own agent. The
  // literal fails the moment anything run-specific — a task id, an app, a
  // timestamp — enters the key.
  it('carries the gap and nothing else, so every report of one blind spot folds into one fix', () => {
    expect(goalFidelityCalibrationFingerprint('truncated-diff'))
      .toBe('goal-fidelity-calibration:context-gap:truncated-diff');
  });

  // The module inlines the `category:kind:scope` template rather than importing
  // `investigationTasks.js`, which would drag its closure into every consumer —
  // the same trade `goalFidelityFollowUp.js` makes, pinned the same way. The
  // test pays the import so production does not, and the two cannot drift.
  it('builds the same key the shared investigation formatter would', () => {
    expect(goalFidelityCalibrationFingerprint('rubric-gap')).toBe(investigationFingerprint({
      category: 'goal-fidelity-calibration', kind: 'context-gap', scope: 'rubric-gap',
    }));
  });
});

describe('buildGoalFidelityCalibrationTask', () => {
  const build = (over = {}) => buildGoalFidelityCalibrationTask({
    gap: 'objective-omits-context',
    detail: 'The objective referenced issue #41; the reviewer never received its body.',
    evidence: 'server/lib/retry.js:88 implements the cap the issue asked for.',
    findingFingerprint: 'goal-fidelity:user:comics/add-retry-caps',
    taskId: 'task-7',
    verdict: 'rethink',
    ...over,
  });

  it('states the gap, its fix pointer, and the investigator\'s own diagnosis', () => {
    const body = build();
    expect(body).toContain('objective-omits-context');
    expect(body).toContain(describeGoalFidelityContextGap('objective-omits-context'));
    expect(body).toContain('the reviewer never received its body');
    expect(body).toContain('server/lib/retry.js:88');
    expect(body).toContain('task-7');
    expect(body).toContain('goal-fidelity:user:comics/add-retry-caps');
  });

  it('forbids the cheap fix — weakening the gate — and demands a regression test', () => {
    // Without this the task is an unattended instruction to make a `rethink`
    // stop happening, and the shortest path to that is a detector that never
    // returns one again.
    const body = build();
    expect(body).toMatch(/do not disarm the detector/i);
    expect(body).toMatch(/regression test/i);
  });

  it('names the reviewer\'s whole context surface, which the agent cannot discover from the diff', () => {
    // Rendered from the surface table, so this is also what keeps the body's
    // addresses and the gap's own pointer from disagreeing.
    const body = build();
    for (const surface of Object.values(GOAL_FIDELITY_REVIEW_SURFACES)) {
      expect(body, `the body omits ${surface.symbol}`).toContain(surface.symbol);
      expect(body, `the body omits ${surface.file}`).toContain(surface.file);
    }
  });

  it('states an absent detail or evidence rather than leaving a blank section', () => {
    const body = build({ detail: '   ', evidence: undefined });
    expect(body).toContain('_The report named no detail beyond the gap._');
    expect(body).toContain('_The report cited no specific evidence._');
  });

  it('bounds model-authored free text before it lands in a task body', () => {
    const body = build({ detail: 'x'.repeat(GOAL_FIDELITY_CALIBRATION_FREE_TEXT_CHARS + 500) });
    expect(body).not.toContain('x'.repeat(GOAL_FIDELITY_CALIBRATION_FREE_TEXT_CHARS + 1));
  });

  it('normalizes an unknown gap in the body too, so the prose and the dedup key agree', () => {
    const body = build({ gap: 'nonsense' });
    expect(body).toContain(describeGoalFidelityContextGap(DEFAULT_GOAL_FIDELITY_CONTEXT_GAP));
  });

  it('still produces a usable task when the report named no run', () => {
    const body = buildGoalFidelityCalibrationTask({ gap: 'rubric-gap' });
    expect(body.startsWith('[Auto] Goal-fidelity calibration (rubric-gap)')).toBe(true);
    expect(body).toContain('## What to do');
  });
});

describe('the unfilled-template guard', () => {
  // The report block hands the agent a ready-to-run curl whose every field is a
  // `<…>` placeholder. Running it verbatim used to queue an `other` calibration
  // whose "diagnosis" was the template — a task that reads like a report, says
  // nothing, and costs a whole agent run to discover that.
  it('rejects the template exactly as the report block emits it', () => {
    expect(goalFidelityReportIsSubstantive({
      gap: '<one of: truncated-diff | other>',
      detail: '<what the reviewer could not see, in one or two sentences>',
      evidence: '<file:line, commit, or PR that shows the objective WAS delivered>',
    })).toBe(false);
  });

  it('accepts a report that filled in ANY one field, since a partial report still points somewhere', () => {
    expect(goalFidelityReportIsSubstantive({ gap: 'rubric-gap' })).toBe(true);
    expect(goalFidelityReportIsSubstantive({ gap: '<one of: …>', detail: 'the cap was already on main' })).toBe(true);
    expect(goalFidelityReportIsSubstantive({ gap: '<one of: …>', evidence: 'server/lib/retry.js:88' })).toBe(true);
  });

  it('rejects an empty report, which carries no more than the template does', () => {
    expect(goalFidelityReportIsSubstantive({})).toBe(false);
    expect(goalFidelityReportIsSubstantive({ gap: 'nonsense', detail: '  ' })).toBe(false);
  });

  it('keeps placeholder prose out of the task body when other fields were filled', () => {
    const body = buildGoalFidelityCalibrationTask({
      gap: 'rubric-gap',
      detail: '<what the reviewer could not see, in one or two sentences>',
      evidence: 'server/lib/retry.js:88',
    });
    expect(body).not.toContain('what the reviewer could not see');
    expect(body).toContain('_The report named no detail beyond the gap._');
    expect(body).toContain('server/lib/retry.js:88');
  });
});

describe('buildGoalFidelityFalsePositiveReportBlock', () => {
  const block = buildGoalFidelityFalsePositiveReportBlock({
    apiBase: 'http://127.0.0.1:5553',
    findingFingerprint: 'goal-fidelity:user:comics/add-retry-caps',
    taskId: 'task-7',
  });

  it('tells the investigator to check the finding before reconciling it', () => {
    expect(block).toMatch(/is the finding actually right/i);
    expect(block).toMatch(/do NOT ship a reconciliation/);
  });

  it('offers every gap the server can key a calibration on', () => {
    // The drift this catches: a vocabulary change on one side only, after which
    // the prompt keeps offering a value that now folds onto `other` — so two
    // distinct blind spots share one task and neither gets its own fix.
    for (const gap of GOAL_FIDELITY_CONTEXT_GAPS) expect(block).toContain(gap);
  });

  it('targets the report endpoint and keeps the auth argument the install needs', () => {
    expect(block).toContain('http://127.0.0.1:5553/api/cos/goal-fidelity/false-positive');
    expect(block).toContain('Authorization: Bearer ${PORTOS_API_TOKEN:-}');
  });

  it('carries the run\'s provenance so a report can be traced back to its finding', () => {
    expect(block).toContain('goal-fidelity:user:comics/add-retry-caps');
    expect(block).toContain('task-7');
  });

  it('omits provenance keys it was not given rather than sending empty ones', () => {
    const bare = buildGoalFidelityFalsePositiveReportBlock({ apiBase: 'http://127.0.0.1:5553' });
    expect(bare).not.toContain('"fingerprint"');
    expect(bare).not.toContain('"taskId"');
  });
});

describe('formatGoalFidelityCalibrationSummary', () => {
  it('distinguishes queued, folded, held-for-approval, and refused', () => {
    expect(formatGoalFidelityCalibrationSummary({ queued: true, gap: 'rubric-gap', taskId: 't1' }))
      .toBe('Goal-fidelity calibration (rubric-gap) queued as t1');
    expect(formatGoalFidelityCalibrationSummary({ queued: true, gap: 'rubric-gap', taskId: 't1', duplicate: true }))
      .toContain('folded into');
    // A held task is not a queued one — saying "queued" about a task nothing
    // will pick up is the one wrong thing to report.
    expect(formatGoalFidelityCalibrationSummary({ queued: true, gap: 'rubric-gap', taskId: 't1', approvalRequired: true }))
      .toContain('queued for approval as');
    expect(formatGoalFidelityCalibrationSummary({ queued: false, reason: 'the gate is disabled' }))
      .toBe('Goal-fidelity calibration not queued (the gate is disabled)');
  });
});
