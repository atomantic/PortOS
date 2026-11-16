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
 *
 * A span charged more than `attributeAboveMs` of lag also carries `load`
 * (#12852): this process's CPU time, GC time and involuntary context switches
 * over the span, plus host load, so lag can be told apart as busy-process
 * (`cpuMs` near the span's wall time; `gcMs` names the GC share) versus
 * starved-process (low `cpuMs`, `load1` at or above `cpus`).
 */

import os from 'node:os';
import { PerformanceObserver } from 'node:perf_hooks';

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
 * GC time by occurrence, not delivery: Node queues `gc` entries to a later
 * loop turn (`takeRecords()` does not see them synchronously), so each entry is
 * charged to the open windows by its `startTime`. A GC in a span's last loop
 * turn may arrive after the span is read. The observer runs only while a
 * window is open, and entries older than every open window are dropped.
 */
function createGcMeter() {
  const windows = new Set();
  let entries = [];
  let observer = null;
  const record = (list) => {
    for (const entry of list.getEntries()) entries.push([entry.startTime, entry.duration]);
  };
  return {
    begin() {
      const gcWindow = { since: performance.now() };
      if (windows.size === 0) {
        observer = new PerformanceObserver(record);
        observer.observe({ entryTypes: ['gc'] });
      }
      windows.add(gcWindow);
      let open = true;
      return {
        ms: () => entries.reduce((ms, [start, duration]) => (start >= gcWindow.since ? ms + duration : ms), 0),
        end() {
          if (!open) return;
          open = false;
          windows.delete(gcWindow);
          if (windows.size === 0) {
            observer.disconnect();
            observer = null;
            entries = [];
            return;
          }
          let oldest = Infinity;
          for (const { since } of windows) oldest = Math.min(oldest, since);
          entries = entries.filter(([start]) => start >= oldest);
        },
      };
    },
  };
}

/** Process and host counters for lag attribution; each is resolved at call time. */
export const systemResources = {
  cpuUsage: () => process.cpuUsage(),
  loadavg: () => os.loadavg(),
  cpus: () => os.availableParallelism(),
  involuntaryContextSwitches: () => process.resourceUsage().involuntaryContextSwitches,
  gc: createGcMeter(),
};

/**
 * Start counting this process's CPU, GC and involuntary context switches.
 * `read()` returns the deltas so far plus host load; `end()` stops the GC
 * window and is idempotent. Numbers only.
 */
export function beginLoadSample(resources = systemResources) {
  const cpuStart = resources.cpuUsage();
  const switchesStart = resources.involuntaryContextSwitches();
  const gc = resources.gc.begin();
  return {
    read() {
      const cpu = resources.cpuUsage();
      const [load1] = resources.loadavg();
      return {
        cpuMs: roundMs((cpu.user - cpuStart.user + cpu.system - cpuStart.system) / 1000),
        load1: Math.round(load1 * 100) / 100,
        cpus: resources.cpus(),
        gcMs: roundMs(gc.ms()),
        invCtx: Math.max(0, resources.involuntaryContextSwitches() - switchesStart),
      };
    },
    end: () => gc.end(),
  };
}

/** ` cpuMs=… load1=… cpus=… gcMs=… invCtx=…` for a log line, or '' without a sample. */
export const formatLoadAttribution = (load) => (load
  ? ` cpuMs=${load.cpuMs} load1=${load.load1} cpus=${load.cpus} gcMs=${load.gcMs} invCtx=${load.invCtx}`
  : '');

/**
 * @param {{ clock?: typeof systemClock, intervalMs?: number, toleranceMs?: number,
 *   resources?: typeof systemResources, attributeAboveMs?: number }} [options]
 * @returns {{ begin: (phase: string) => { mark: (phase: string) => void, snapshot: () => object, end: () => object } }}
 */
export function createEventLoopLagProbe({
  clock = systemClock, intervalMs = 100, toleranceMs = 20, resources = systemResources, attributeAboveMs = 1000,
} = {}) {
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
    load: span.lagMs > attributeAboveMs ? span.sample.read() : null,
  });

  return {
    begin(phase) {
      const at = clock.now();
      if (timer === null) schedule(at);
      const span = { startedAt: at, accountedTo: at, lagMs: 0, lagMaxMs: 0, phases: {}, sample: beginLoadSample(resources) };
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
          span.sample.end();
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
