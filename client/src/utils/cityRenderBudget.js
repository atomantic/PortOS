// Pure render-budget state machine for CyberCity's Auto quality mode (issue #2592).
//
// It observes per-frame delta times and decides when the *effective* detail tier
// should step down (frame pressure) or up (headroom), with hysteresis + a cooldown
// so it settles instead of oscillating between adjacent tiers. It is intentionally
// side-effect free: `recordFrame` takes the wall-clock `now` and frame `dt` as inputs
// (never reads `performance.now()` itself) so the whole decision path is deterministic
// and unit-testable. The component that drives it (`CityAdaptiveQuality`) owns all the
// impurity (useFrame, timers, React state).
//
// Tiers are ordered low → medium → high → ultra. A "decision" can move at most one
// tier. Runtime tier lives here, entirely separate from the user's persisted settings —
// nothing in this module reads or writes localStorage.

export const QUALITY_TIERS = ['low', 'medium', 'high', 'ultra'];

// Thresholds from the issue's acceptance criteria. p75 frame time is the signal:
// > 25ms (≈40fps) for 2 windows → step down; < 18ms (≈55fps) for 5 windows → step up.
// The 18–25ms dead band is the hysteresis gap — a window landing there breaks both
// streaks so we never ping-pong across an adjacent boundary.
export const DEFAULT_RENDER_BUDGET_CONFIG = Object.freeze({
  warmupMs: 1200, // ignore frames within this window after start/resume
  maxFrameGapMs: 250, // ignore a frame whose dt exceeds this (tab-hidden, GC, alt-tab)
  windowMs: 2000, // rolling window length
  percentile: 0.75, // frame-time percentile evaluated per window
  downshiftFrameMs: 25,
  downshiftWindows: 2,
  upshiftFrameMs: 18,
  upshiftWindows: 5,
  cooldownMs: 10000, // no further tier change for this long after a change
});

export function tierToIndex(tier) {
  const i = QUALITY_TIERS.indexOf(tier);
  return i === -1 ? QUALITY_TIERS.indexOf('high') : i;
}

export function getEffectiveTier(state) {
  return QUALITY_TIERS[state.tierIndex];
}

// Nearest-rank percentile over an unsorted sample array. Returns null for empty input.
export function percentile(samples, p) {
  if (!samples || samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  const idx = Math.min(sorted.length, Math.max(1, rank)) - 1;
  return sorted[idx];
}

function mean(samples) {
  if (!samples || samples.length === 0) return null;
  let total = 0;
  for (const s of samples) total += s;
  return total / samples.length;
}

export function createRenderBudget(startTier = 'high', now = 0) {
  const idx = tierToIndex(startTier);
  return {
    tierIndex: idx,
    startedAt: now, // warm-up baseline
    windowStart: now,
    samples: [],
    pressureStreak: 0,
    headroomStreak: 0,
    lastChangeAt: -Infinity, // first change is allowed immediately once a streak is met
    windowClosed: false, // true on the frame that just closed & classified a window
    diagnostics: {
      effectiveTier: QUALITY_TIERS[idx],
      p75: null,
      fps: null,
      sampleCount: 0,
      windows: 0,
    },
  };
}

// Re-arm the warm-up without touching the current tier — used when the City frameloop
// resumes after the tab was hidden, so the first sluggish post-resume frames (and any
// pre-hide pressure/headroom streaks) don't drive a bogus decision.
export function restartWarmup(state, now) {
  return {
    ...state,
    startedAt: now,
    windowStart: now,
    samples: [],
    pressureStreak: 0,
    headroomStreak: 0,
    windowClosed: false,
  };
}

// Reset the whole machine to a fresh start at `startTier` (e.g. Manual→Auto switch, or
// the Auto starting tier changing). Keeps the module pure — caller passes `now`.
export function resetRenderBudget(state, startTier, now) {
  return createRenderBudget(startTier, now);
}

// Feed one frame. Returns a NEW state object (never mutates). `sample` is { now, dt }
// in milliseconds. Frames during warm-up or with a gap above maxFrameGapMs are dropped
// from the window (but still advance nothing else). A window is classified only once
// `windowMs` of wall-clock has elapsed AND it holds at least one valid sample.
export function recordFrame(state, sample, config = DEFAULT_RENDER_BUDGET_CONFIG) {
  const { now, dt } = sample;
  const inWarmup = now - state.startedAt < config.warmupMs;
  const isGap = dt > config.maxFrameGapMs || dt <= 0;

  const samples = !inWarmup && !isGap ? state.samples.concat(dt) : state.samples;

  // Window still open — accumulate and return.
  if (now - state.windowStart < config.windowMs) {
    return { ...state, samples, windowClosed: false };
  }

  // Window elapsed but no valid samples (e.g. entire window was warm-up or gaps):
  // roll the window forward without classifying so streaks stay intact.
  if (samples.length === 0) {
    return { ...state, windowStart: now, samples: [], windowClosed: false };
  }

  const p75 = percentile(samples, config.percentile);
  const fps = 1000 / mean(samples);

  let tierIndex = state.tierIndex;
  let lastChangeAt = state.lastChangeAt;
  const cooledDown = now - state.lastChangeAt >= config.cooldownMs;

  // Observation freeze during cooldown: windows classified inside the cooldown do NOT
  // bank a streak. Otherwise a streak accumulated while cooling would fire the instant
  // the cooldown expires, producing a quality "pop" — and, for a workload that straddles
  // the two thresholds (comfortable at tier N, over-budget at tier N+1), an endless
  // downshift↔upshift bounce. Streaks are only counted from windows observed entirely
  // after the last change, so a change requires fresh, post-cooldown evidence.
  let pressureStreak = 0;
  let headroomStreak = 0;
  if (cooledDown) {
    if (p75 > config.downshiftFrameMs) {
      pressureStreak = state.pressureStreak + 1;
    } else if (p75 < config.upshiftFrameMs) {
      headroomStreak = state.headroomStreak + 1;
    }
    // else: dead band (18–25ms) — a mixed window breaks both streaks (anti-oscillation gap).

    if (pressureStreak >= config.downshiftWindows && tierIndex > 0) {
      tierIndex -= 1;
      lastChangeAt = now;
      pressureStreak = 0;
      headroomStreak = 0;
    } else if (headroomStreak >= config.upshiftWindows && tierIndex < QUALITY_TIERS.length - 1) {
      tierIndex += 1;
      lastChangeAt = now;
      pressureStreak = 0;
      headroomStreak = 0;
    }
  }

  return {
    ...state,
    tierIndex,
    windowStart: now,
    samples: [],
    pressureStreak,
    headroomStreak,
    lastChangeAt,
    windowClosed: true,
    diagnostics: {
      effectiveTier: QUALITY_TIERS[tierIndex],
      p75,
      fps,
      sampleCount: samples.length,
      windows: state.diagnostics.windows + 1,
    },
  };
}
