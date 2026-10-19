/**
 * Scoped event-loop lag attribution for slow-operation diagnostics (#12329).
 *
 * A stopwatch around an awaited phase measures asynchronous wait (storage, the
 * libuv threadpool, a queue) plus delayed scheduling, and cannot tell them
 * apart. While at least one span is open, one shared tick is rescheduled every
 * `intervalMs`; the time it spends overdue is time the loop could not run
 * timers — blocking JavaScript, GC, host CPU starvation or process suspension.
 * Each span charges that overdue time to the phase it was in, so a slow phase
 * splits into `lagMs` (scheduling) and the remainder (asynchronous wait).
 *
 * Nothing is scheduled while no span is open. Resolution is about one interval,
 * and an overdue stretch no longer than `toleranceMs` is ignored as timer
 * jitter. Phase names are caller-supplied constants; summaries are numbers only.
 */

/** Resolves the globals at call time, so fake timers in tests govern it. */
export const systemClock = {
  now: () => performance.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (timer) => clearTimeout(timer),
};

/**
 * A deterministic clock with the same contract. `advance(ms)` models a
 * responsive loop (every timer fires on schedule); `stall(ms)` models a blocked
 * one (time passes and overdue timers wait for the next `advance`).
 */
export function __createManualClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  const nextDue = (limit) => [...timers].filter(([, t]) => t.at <= limit)
    .sort(([a, x], [b, y]) => x.at - y.at || a - b)[0];
  return {
    now: () => now,
    setTimer: (fn, ms) => { timers.set(++seq, { fn, at: now + ms }); return seq; },
    clearTimer: (id) => { timers.delete(id); },
    advance(ms) {
      const target = now + ms;
      for (let due = nextDue(target); due; due = nextDue(target)) {
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
      }
      now = target;
    },
    stall(ms) { now += ms; },
  };
}

export const roundMs = (ms) => Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(ms)));

/**
 * @param {{ clock?: typeof systemClock, intervalMs?: number, toleranceMs?: number }} [options]
 * @returns {{ begin: (phase: string) => { mark: (phase: string) => void, snapshot: () => object, end: () => object } }}
 */
export function createEventLoopLagProbe({ clock = systemClock, intervalMs = 100, toleranceMs = 20 } = {}) {
  const spans = new Set();
  let timer = null;
  let dueAt = 0;

  // Charge the overdue part of [accountedTo, at] to the span's current phase.
  const account = (span, at) => {
    const from = Math.max(dueAt, span.accountedTo);
    span.accountedTo = Math.max(span.accountedTo, at);
    const lag = at - from;
    if (lag <= toleranceMs) return;
    span.phases[span.phase].lagMs += lag;
    span.lagMs += lag;
    span.lagMaxMs = Math.max(span.lagMaxMs, lag);
  };

  // The tick only observes; it must never keep the process alive.
  const schedule = (at) => {
    dueAt = at + intervalMs;
    timer = clock.setTimer(tick, intervalMs);
    timer?.unref?.();
  };

  function tick() {
    const at = clock.now();
    for (const span of spans) account(span, at);
    schedule(at);
  }

  const enter = (span, phase, at) => {
    span.phase = phase;
    span.phaseStartedAt = at;
    span.phaseEnteredAt = at;
    span.phases[phase] ??= { ms: 0, lagMs: 0 };
  };

  const close = (span, at) => {
    account(span, at);
    span.phases[span.phase].ms += at - span.phaseStartedAt;
    span.phaseStartedAt = at;
  };

  const summarize = (span, at) => ({
    phase: span.phase,
    phaseMs: roundMs(at - span.phaseEnteredAt),
    totalMs: roundMs(at - span.startedAt),
    lagMs: roundMs(span.lagMs),
    lagMaxMs: roundMs(span.lagMaxMs),
    phases: Object.fromEntries(Object.entries(span.phases)
      .map(([name, { ms, lagMs }]) => [name, { ms: roundMs(ms), lagMs: roundMs(lagMs) }])),
  });

  return {
    begin(phase) {
      const at = clock.now();
      if (timer === null) schedule(at);
      const span = { startedAt: at, accountedTo: at, lagMs: 0, lagMaxMs: 0, phases: {} };
      enter(span, phase, at);
      spans.add(span);
      let ended = null;
      return {
        mark(next) {
          if (ended) return;
          const now = clock.now();
          close(span, now);
          enter(span, next, now);
        },
        snapshot() {
          if (ended) return ended;
          const now = clock.now();
          close(span, now);
          return summarize(span, now);
        },
        end() {
          if (ended) return ended;
          const now = clock.now();
          close(span, now);
          ended = summarize(span, now);
          spans.delete(span);
          if (spans.size === 0 && timer !== null) {
            clock.clearTimer(timer);
            timer = null;
          }
          return ended;
        },
      };
    },
  };
}

/** Sum the named phase and its `name.` sub-phases from a span summary. */
export function phaseGroup(summary, name) {
  let ms = 0;
  let lagMs = 0;
  for (const [phase, value] of Object.entries(summary.phases)) {
    if (phase !== name && !phase.startsWith(`${name}.`)) continue;
    ms += value.ms;
    lagMs += value.lagMs;
  }
  return { ms, lagMs };
}
