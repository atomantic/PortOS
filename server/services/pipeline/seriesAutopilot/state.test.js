import { describe, it, expect } from 'vitest';
import { AUTOPILOT_TERMINAL_TYPES, emptyProgress, noteProgress } from './state.js';

it('exposes the terminal frame types a server-side consumer settles on', () => {
  expect([...AUTOPILOT_TERMINAL_TYPES]).toEqual(['complete', 'paused', 'canceled', 'error']);
});

describe('noteProgress (pure fold)', () => {
  it('marks the running step and clears its complete flag when the run RE-ENTERS a gate', () => {
    const run = { progress: emptyProgress() };
    noteProgress(run, { type: 'step:start', kind: 'foundationGate', ordinal: 3 });
    noteProgress(run, { type: 'step:complete', kind: 'foundationGate' });
    expect(run.progress).toMatchObject({
      currentStep: 'foundationGate', currentStepComplete: true, completed: { foundationGate: 1 },
    });
    // The arc repair sends it back through the same gate — the map must show it
    // working again rather than reading as the step it just finished.
    noteProgress(run, { type: 'step:start', kind: 'foundationGate', ordinal: 5 });
    expect(run.progress).toMatchObject({ currentStep: 'foundationGate', currentStepComplete: false });
  });

  it('files each gate verification under the step it was measured in', () => {
    const run = { progress: emptyProgress() };
    noteProgress(run, { type: 'step:start', kind: 'verifyArcSpine' });
    noteProgress(run, { type: 'verify:round', scope: 'arcSpine', round: 2, findings: 5, blocking: 0 });
    noteProgress(run, { type: 'step:start', kind: 'foundationGate' });
    noteProgress(run, { type: 'foundation:round', round: 1, weightedScore: 8.1, threshold: 7.5, weakest: 'craft' });
    expect(run.progress.verified).toEqual({
      verifyArcSpine: { round: 2, findings: 5, blocking: 0 },
      foundationGate: { round: 1, weightedScore: 8.1, threshold: 7.5, weakest: 'craft' },
    });
  });

  it('drops gate telemetry that arrives outside a step rather than filing it nowhere', () => {
    const run = { progress: emptyProgress() };
    expect(noteProgress(run, { type: 'verify:round', scope: 'arc', findings: 1, blocking: 1 })).toBe(false);
    expect(run.progress.verified).toEqual({});
  });

  it('counts sub-step skips without advancing the milestone', () => {
    const run = { progress: emptyProgress() };
    noteProgress(run, { type: 'step:skip', kind: 'visualDraft', reason: 'locked' });
    expect(run.progress).toMatchObject({ skipped: { visualDraft: 1 }, completed: {} });
  });

  it('ignores frames the map does not track — including every terminal', () => {
    const run = { progress: emptyProgress() };
    for (const type of ['note', 'check:complete', 'complete', 'paused', 'canceled', 'error']) {
      expect(noteProgress(run, { type })).toBe(false);
    }
    expect(run.progress).toEqual(emptyProgress());
  });
});
