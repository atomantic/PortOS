/**
 * Phase-aware soft-hang stall detector for LoRA training.
 *
 * The mediaJobQueue idle watchdog (WATCHDOG_TRAINING_MS, flat 30 min) only
 * trips on *total* silence — any non-noise line resets it. That's the right
 * backstop for a wedged model-load or dataset-encode (which legitimately go
 * silent for minutes), but it's blind to a soft GPU hang *during training*:
 * once steps are flowing every few seconds, a 30-min gap between `STEP:` lines
 * is clearly wedged long before the flat watchdog fires.
 *
 * This detector keys off the trainer line protocol (`STAGE:<name>`,
 * `STEP:<cur>:<total>:<loss>` — same lines progress.js parses) to apply a
 * *tight* budget only while `STAGE:training` is active: consecutive `STEP:`
 * lines must arrive within a few × the observed per-step interval. Every other
 * phase (load-model, precompute-latents, sampling, cooldown, or pre-first-step
 * graph-compile) is left to the flat queue watchdog so a legitimately slow
 * load/encode is never false-killed — the budget is *derived from the first few
 * observed step intervals*, never a hardcoded per-step value.
 *
 * Pure factory, no I/O — the clock is injected so unit tests drive it with
 * synthetic line streams. Caller (runTraining) feeds raw lines via observe()
 * and polls checkStall(); a stalled training phase triggers SIGKILL +
 * checkpoint-resume in the orchestrator.
 *
 * IMPORTANT: this recovers *soft* GPU hangs faster — it does NOT address the
 * hard-reboot kernel panics (the machine is gone before any userspace watchdog
 * runs; checkpoint-resume already covers those).
 */

// Env-overridable like mediaJobQueue's WATCHDOG_* knobs. `Number(non-numeric)`
// → NaN; fall back to the default when the parsed value isn't positive-finite.
const envMs = (value, defaultMs) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : defaultMs;
};
const envNum = (value, defaultN) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : defaultN;
};

// Budget = (slowest of the recent step intervals) × this. "A few ×" the
// observed per-step time, so normal jitter (a GC pause, a checkpoint write
// between steps) never trips it — only a genuine multi-step-long wedge does.
export const STALL_STEP_MULTIPLIER = envNum(process.env.LORA_TRAIN_STALL_STEP_MULTIPLIER, 6);
// Need at least this many consecutive intervals before the tight budget arms —
// until then the generous warmup budget applies (first step compiles the Metal
// graph and is pathologically slower than steady state).
export const STALL_MIN_STEP_SAMPLES = envNum(process.env.LORA_TRAIN_STALL_MIN_SAMPLES, 3);
// Floor: never kill faster than this even when steps are sub-second apart, so a
// burst of fast early steps can't set a budget so tight that one slow step trips.
export const STALL_MIN_BUDGET_MS = envMs(process.env.LORA_TRAIN_STALL_MIN_BUDGET_MS, 90_000);
// Cap: kept below the flat WATCHDOG_TRAINING_MS (30 min) so the phase-aware
// detector always fires first during training — even for slow steps.
export const STALL_MAX_BUDGET_MS = envMs(process.env.LORA_TRAIN_STALL_MAX_BUDGET_MS, 15 * 60 * 1000);
// Generous budget before the tight one arms (and for the gap between entering
// STAGE:training and the first STEP — the graph compile). Defers to the flat
// queue watchdog in practice; here only to bound a never-stepping training phase.
export const STALL_WARMUP_BUDGET_MS = envMs(process.env.LORA_TRAIN_STALL_WARMUP_BUDGET_MS, 20 * 60 * 1000);

// Same STAGE/STEP grammar progress.js uses. The `:heartbeat:<N>s` suffix is a
// keep-alive that must NOT count as a phase change (it's emitted during a long
// cooldown to feed the flat watchdog without altering the displayed stage).
const STAGE_RE = /^STAGE:([a-zA-Z0-9_-]+)(?::heartbeat:(\d+)s)?/;
const STEP_RE = /^STEP:(\d+):(\d+):/;

/**
 * @param {object} [opts]
 * @param {() => number} [opts.now]  injected clock (ms) — tests pass a stub.
 * @returns {{ observe, checkStall, getPhase, getStepSamples }}
 */
export function makeStallDetector({
  now = () => Date.now(),
  stepMultiplier = STALL_STEP_MULTIPLIER,
  minStepSamples = STALL_MIN_STEP_SAMPLES,
  minBudgetMs = STALL_MIN_BUDGET_MS,
  maxBudgetMs = STALL_MAX_BUDGET_MS,
  warmupBudgetMs = STALL_WARMUP_BUDGET_MS,
} = {}) {
  let phase = null;            // current non-heartbeat STAGE name
  let trainingEnteredAt = null; // ms the current training segment began
  let lastStepAt = null;        // ms of the last STEP line in this segment
  let lastStepNum = null;       // dedupe tqdm redraws at the same step
  const intervals = [];         // gaps (ms) between consecutive STEP lines

  // Each training segment is timed independently: a resume / post-sampling
  // re-entry spawns a fresh compile, so prior step-rate data doesn't apply and
  // the warmup window must restart. Conservative by design (re-enters warmup
  // after every sampling/cooldown boundary) — zero false kills beats faster
  // detection across a segment seam.
  const resetTrainingTiming = () => {
    trainingEnteredAt = null;
    lastStepAt = null;
    lastStepNum = null;
    intervals.length = 0;
  };

  const enterTraining = (ts) => {
    if (phase !== 'training') {
      resetTrainingTiming();
      trainingEnteredAt = ts;
    }
    phase = 'training';
  };

  const observe = (rawLine, ts = now()) => {
    const line = String(rawLine).trim();
    if (!line) return;

    const stage = STAGE_RE.exec(line);
    if (stage) {
      if (stage[2]) return; // heartbeat keep-alive — not a phase transition
      if (stage[1] === 'training') {
        enterTraining(ts);
      } else {
        phase = stage[1];
        resetTrainingTiming(); // leaving training disables tight enforcement
      }
      return;
    }

    const step = STEP_RE.exec(line);
    if (step) {
      const cur = Number(step[1]);
      // A STEP implies training even if the STAGE:training line was missed or
      // arrived out of order (stderr/stdout interleave).
      enterTraining(ts);
      if (lastStepAt != null && cur !== lastStepNum) {
        intervals.push(ts - lastStepAt);
        // Keep a bounded recent window — late-run steps may slow as memory
        // pressure builds, so the budget should track the recent rate.
        if (intervals.length > minStepSamples * 3) intervals.shift();
      }
      lastStepAt = ts;
      lastStepNum = cur;
    }
  };

  // Derived budget: slowest of the recent intervals × multiplier, clamped to
  // [min, max]. Until enough samples, the generous warmup budget applies.
  const currentBudgetMs = () => {
    if (intervals.length < minStepSamples) return warmupBudgetMs;
    const recent = intervals.slice(-minStepSamples * 2);
    const slowest = Math.max(...recent);
    return Math.min(maxBudgetMs, Math.max(minBudgetMs, slowest * stepMultiplier));
  };

  const checkStall = (ts = now()) => {
    if (phase !== 'training') {
      return { stalled: false, phase, idleMs: 0, budgetMs: 0, stepSamples: intervals.length };
    }
    const since = lastStepAt ?? trainingEnteredAt;
    if (since == null) {
      return { stalled: false, phase, idleMs: 0, budgetMs: 0, stepSamples: intervals.length };
    }
    const idleMs = ts - since;
    const budgetMs = currentBudgetMs();
    return { stalled: idleMs > budgetMs, phase, idleMs, budgetMs, stepSamples: intervals.length };
  };

  return {
    observe,
    checkStall,
    getPhase: () => phase,
    getStepSamples: () => intervals.length,
  };
}
