import { describe, it, expect } from 'vitest';
import {
  QUALITY_TIERS,
  DEFAULT_RENDER_BUDGET_CONFIG,
  createRenderBudget,
  recordFrame,
  restartWarmup,
  resetRenderBudget,
  getEffectiveTier,
  percentile,
  tierToIndex,
} from './cityRenderBudget.js';

const CFG = DEFAULT_RENDER_BUDGET_CONFIG;

// Deterministic driver over the pure state machine. `now` is a monotonic virtual
// clock (starts just past warm-up so samples are actually recorded). `window(dt)`
// feeds constant-`dt` frames until EXACTLY one window is classified — sidestepping
// the frame-count/window-boundary drift that makes raw counts brittle.
function makeDriver(startTier) {
  let s = createRenderBudget(startTier, 0);
  let now = CFG.warmupMs + 1;
  return {
    get tier() { return getEffectiveTier(s); },
    get state() { return s; },
    window(dt) {
      let guard = 0;
      for (;;) {
        now += dt;
        s = recordFrame(s, { now, dt });
        if (s.windowClosed) return s;
        if ((guard += 1) > 200000) throw new Error('window never closed');
      }
    },
    advance(ms) { now += ms; },
    hide(gapMs = 60000) { now += gapMs; s = restartWarmup(s, now); },
    raw(dt) { now += dt; s = recordFrame(s, { now, dt }); return s; },
  };
}

describe('cityRenderBudget — helpers', () => {
  it('percentile uses nearest-rank and handles empty input', () => {
    expect(percentile([], 0.75)).toBeNull();
    expect(percentile([10, 20, 30, 40], 0.75)).toBe(30);
    expect(percentile([5], 0.75)).toBe(5);
  });

  it('tierToIndex falls back to high on unknown tier', () => {
    expect(tierToIndex('low')).toBe(0);
    expect(tierToIndex('ultra')).toBe(QUALITY_TIERS.length - 1);
    expect(tierToIndex('bogus')).toBe(QUALITY_TIERS.indexOf('high'));
  });
});

describe('cityRenderBudget — warm-up & gap rejection (ignored samples)', () => {
  it('ignores frames inside the warm-up window but records after it', () => {
    let s = createRenderBudget('high', 0);
    // Frames before warmupMs never accumulate (dt=40 would otherwise be pressure).
    for (let now = 40; now <= 800; now += 40) s = recordFrame(s, { now, dt: 40 });
    expect(s.samples.length).toBe(0);
    expect(s.diagnostics.windows).toBe(0);
    // A frame past the warm-up baseline IS recorded.
    s = recordFrame(s, { now: CFG.warmupMs + 100, dt: 16 });
    expect(s.samples.length).toBe(1);
  });

  it('ignores frames with a dt above maxFrameGapMs', () => {
    let s = createRenderBudget('high', 0);
    s = recordFrame(s, { now: CFG.warmupMs + 5000, dt: 4000 });
    expect(s.samples.length).toBe(0);
    expect(s.diagnostics.windows).toBe(0);
  });
});

describe('cityRenderBudget — downshift', () => {
  it('steps down exactly one tier after two consecutive pressure windows', () => {
    const d = makeDriver('high');
    d.window(30); // window 1: p75 30ms > 25ms
    expect(d.tier).toBe('high');
    d.window(30); // window 2 → downshift by one
    expect(d.tier).toBe('medium');
    expect(d.state.tierIndex).toBe(tierToIndex('medium'));
  });

  it('does not downshift below the lowest tier', () => {
    const d = makeDriver('low');
    for (let w = 0; w < 6; w += 1) {
      d.window(40);
      d.advance(CFG.cooldownMs); // clear cooldown between decisions
    }
    expect(d.tier).toBe('low');
  });
});

describe('cityRenderBudget — recovery (upshift)', () => {
  it('steps up one tier after five consecutive headroom windows', () => {
    const d = makeDriver('medium');
    for (let w = 0; w < 4; w += 1) d.window(10); // four fast windows: not enough
    expect(d.tier).toBe('medium');
    d.window(10); // fifth → step up
    expect(d.tier).toBe('high');
  });

  it('dead-band windows (18–25ms) break the streak and prevent oscillation', () => {
    const d = makeDriver('medium');
    for (let w = 0; w < 4; w += 1) d.window(10);
    d.window(21); // neutral → resets headroom streak
    expect(d.state.headroomStreak).toBe(0);
    d.window(10); // only one fast window again → no upshift
    expect(d.tier).toBe('medium');
  });
});

describe('cityRenderBudget — cooldown', () => {
  it('blocks a second tier change until the cooldown elapses', () => {
    const d = makeDriver('high');
    d.window(30);
    d.window(30); // → downshift to medium, cooldown starts
    expect(d.tier).toBe('medium');
    d.window(30);
    d.window(30); // pressure windows within cooldown are frozen, not banked
    expect(d.tier).toBe('medium');
    expect(d.state.pressureStreak).toBe(0); // no banked streak to fire at expiry
    d.advance(CFG.cooldownMs); // let the cooldown fully elapse
    d.window(30); // one fresh post-cooldown window — not enough on its own
    expect(d.tier).toBe('medium');
    d.window(30); // second fresh window → downshift
    expect(d.tier).toBe('low');
  });

  it('does not rebound to the tier it just left after a single quiet window', () => {
    // Straddling workload: fast enough at the current tier, but the cooldown freeze
    // means a lone headroom window can't immediately undo a downshift.
    const d = makeDriver('high');
    d.window(30);
    d.window(30); // → medium
    expect(d.tier).toBe('medium');
    d.window(10); // headroom window during cooldown → frozen, no upshift
    expect(d.tier).toBe('medium');
    expect(d.state.headroomStreak).toBe(0);
  });
});

describe('cityRenderBudget — visibility transitions', () => {
  it('restartWarmup re-arms warm-up and clears streaks/samples without changing tier', () => {
    const d = makeDriver('high');
    d.window(30); // pressure streak = 1
    expect(d.state.pressureStreak).toBe(1);
    d.hide(); // tab hidden, then visible → restartWarmup
    expect(d.state.pressureStreak).toBe(0);
    expect(d.state.samples.length).toBe(0);
    expect(d.tier).toBe('high');
    // First frames after resume land in the fresh warm-up → ignored.
    d.raw(30);
    expect(d.state.samples.length).toBe(0);
  });

  it('resetRenderBudget returns a fresh machine at the given start tier', () => {
    const s = resetRenderBudget(createRenderBudget('low', 0), 'ultra', 5000);
    expect(getEffectiveTier(s)).toBe('ultra');
    expect(s.startedAt).toBe(5000);
    expect(s.diagnostics.windows).toBe(0);
  });
});

describe('cityRenderBudget — purity', () => {
  it('recordFrame does not mutate the input state', () => {
    const s = createRenderBudget('high', 0);
    const before = JSON.stringify(s);
    recordFrame(s, { now: CFG.warmupMs + 100, dt: 16 });
    expect(JSON.stringify(s)).toBe(before);
  });
});
