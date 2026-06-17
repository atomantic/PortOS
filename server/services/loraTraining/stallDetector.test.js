import { describe, it, expect } from 'vitest';
import { makeStallDetector } from './stallDetector.js';

// Drives the detector with a synthetic, injected clock so step intervals and
// idle gaps are deterministic — no real time, no child process.
function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => { t += ms; return t; },
    set: (ms) => { t = ms; return t; },
  };
}

describe('makeStallDetector', () => {
  it('does not arm during model load / non-training phases', () => {
    const clock = makeClock();
    const d = makeStallDetector({ now: clock.now });
    d.observe('STAGE:load-model');
    clock.advance(60 * 60 * 1000); // an hour of silence loading a multi-GB model
    expect(d.getPhase()).toBe('load-model');
    expect(d.checkStall().stalled).toBe(false);
  });

  it('uses the generous warmup budget before enough step samples', () => {
    const clock = makeClock();
    const d = makeStallDetector({ now: clock.now, warmupBudgetMs: 20 * 60 * 1000 });
    d.observe('STAGE:training');
    d.observe('STEP:1:600:0.42'); // first step — graph compile, no interval yet
    clock.advance(10 * 60 * 1000); // 10 min: slow, but under the warmup budget
    expect(d.checkStall().stalled).toBe(false);
    clock.advance(11 * 60 * 1000); // now 21 min since the step — past warmup
    expect(d.checkStall().stalled).toBe(true);
  });

  it('arms a tight budget once step intervals are observed and trips on a wedge', () => {
    const clock = makeClock();
    const d = makeStallDetector({
      now: clock.now,
      minStepSamples: 3,
      stepMultiplier: 6,
      minBudgetMs: 90_000,
    });
    d.observe('STAGE:training', clock.now());
    // Four steps, 10s apart → three observed 10s intervals (>= minStepSamples).
    for (let i = 1; i <= 4; i += 1) {
      d.observe(`STEP:${i}:600:0.4`, clock.now());
      clock.advance(10_000);
    }
    expect(d.getStepSamples()).toBeGreaterThanOrEqual(3);
    // Budget = max(90s floor, 10s × 6) = 90s. 80s idle is fine.
    clock.advance(80_000);
    expect(d.checkStall().stalled).toBe(false);
    // 100s total idle exceeds the 90s floor budget.
    clock.advance(20_000);
    const res = d.checkStall();
    expect(res.stalled).toBe(true);
    expect(res.phase).toBe('training');
    expect(res.budgetMs).toBe(90_000);
  });

  it('derives a larger budget from slower steps (multiplier above the floor)', () => {
    const clock = makeClock();
    const d = makeStallDetector({
      now: clock.now,
      minStepSamples: 3,
      stepMultiplier: 6,
      minBudgetMs: 90_000,
      maxBudgetMs: 15 * 60 * 1000,
    });
    d.observe('STAGE:training', clock.now());
    for (let i = 1; i <= 4; i += 1) {
      d.observe(`STEP:${i}:600:0.4`, clock.now());
      clock.advance(60_000); // 60s/step
    }
    // Budget = 60s × 6 = 360s (above the 90s floor, below the 15min cap).
    expect(d.checkStall().budgetMs).toBe(360_000);
    clock.advance(300_000); // 5 min idle — under 6 min budget
    expect(d.checkStall().stalled).toBe(false);
    clock.advance(70_000); // now 370s idle — over budget
    expect(d.checkStall().stalled).toBe(true);
  });

  it('caps the budget so it always fires before the flat 30-min watchdog', () => {
    const clock = makeClock();
    const d = makeStallDetector({
      now: clock.now,
      minStepSamples: 3,
      stepMultiplier: 6,
      maxBudgetMs: 15 * 60 * 1000,
    });
    d.observe('STAGE:training', clock.now());
    for (let i = 1; i <= 4; i += 1) {
      d.observe(`STEP:${i}:600:0.4`, clock.now());
      clock.advance(10 * 60 * 1000); // absurdly slow 10min/step → ×6 = 60min, capped to 15min
    }
    expect(d.checkStall().budgetMs).toBe(15 * 60 * 1000);
  });

  it('does not double-count tqdm redraws at the same step number', () => {
    const clock = makeClock();
    const d = makeStallDetector({ now: clock.now, minStepSamples: 3 });
    d.observe('STAGE:training', clock.now());
    d.observe('STEP:1:600:0.4', clock.now());
    clock.advance(5_000);
    d.observe('STEP:1:600:0.4', clock.now()); // same step redraw — no interval
    clock.advance(5_000);
    d.observe('STEP:1:600:0.4', clock.now());
    expect(d.getStepSamples()).toBe(0); // never advanced past step 1
  });

  it('treats heartbeat keep-alives as activity, not a phase change', () => {
    const clock = makeClock();
    const d = makeStallDetector({ now: clock.now });
    d.observe('STAGE:training', clock.now());
    d.observe('STAGE:training:heartbeat:30s', clock.now());
    expect(d.getPhase()).toBe('training');
    // A cooldown-phase heartbeat must not re-arm training enforcement.
    d.observe('STAGE:cooldown', clock.now());
    d.observe('STAGE:cooldown:heartbeat:30s', clock.now());
    expect(d.getPhase()).toBe('cooldown');
    clock.advance(60 * 60 * 1000);
    expect(d.checkStall().stalled).toBe(false); // cooldown is not enforced
  });

  it('disables enforcement when training transitions to sampling, re-arms warmup on return', () => {
    const clock = makeClock();
    const d = makeStallDetector({ now: clock.now, minStepSamples: 3, minBudgetMs: 90_000 });
    d.observe('STAGE:training', clock.now());
    for (let i = 1; i <= 4; i += 1) {
      d.observe(`STEP:${i}:600:0.4`, clock.now());
      clock.advance(10_000);
    }
    expect(d.getStepSamples()).toBeGreaterThanOrEqual(3);
    // Mid-training sampling phase — long, legitimately silent.
    d.observe('STAGE:sampling', clock.now());
    clock.advance(10 * 60 * 1000);
    expect(d.checkStall().stalled).toBe(false);
    // Returning to training resets timing → warmup budget, samples cleared.
    d.observe('STAGE:training', clock.now());
    expect(d.getStepSamples()).toBe(0);
  });

  it('treats a STEP line as entering training even without a STAGE:training first', () => {
    const clock = makeClock();
    const d = makeStallDetector({ now: clock.now });
    d.observe('STEP:1:600:0.4', clock.now());
    expect(d.getPhase()).toBe('training');
  });

  it('does not trip during the gap between entering training and the first step (warmup)', () => {
    const clock = makeClock();
    const d = makeStallDetector({ now: clock.now, warmupBudgetMs: 20 * 60 * 1000 });
    d.observe('STAGE:training', clock.now());
    clock.advance(19 * 60 * 1000); // graph compile, no step yet — under warmup
    expect(d.checkStall().stalled).toBe(false);
    clock.advance(2 * 60 * 1000); // 21 min — past warmup, never stepped
    expect(d.checkStall().stalled).toBe(true);
  });

  it('ignores blank lines', () => {
    const clock = makeClock();
    const d = makeStallDetector({ now: clock.now });
    d.observe('   ', clock.now());
    d.observe('', clock.now());
    expect(d.getPhase()).toBe(null);
    expect(d.checkStall().stalled).toBe(false);
  });
});
