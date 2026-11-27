/** Track managed daemon activity and release idle daemons under timeout or sustained memory pressure. */

import { getMemoryStats } from './memoryStats.js';

/**
 * Shared "stop this daemon when nothing has used it for a while" mechanism.
 *
 * ONLY for a daemon that cannot release its weights any other way. `llama-server`
 * deliberately does NOT register here: it carries its own `--sleep-idle-seconds`,
 * which unloads the model in place and reloads it on the next request without the
 * process ever going away (see `llamaServerManager.js`). Stopping that process to
 * reclaim the same memory would trade a cheap internal reload for a full PM2
 * cold start, and lose the launch line with it. MTPLX has no such flag — its
 * `--retrieval-idle-timeout` unloads retrieval models only, never the main
 * checkpoint — so stopping the process is the only way to get its 20GB back, and
 * it is the one registrant.
 *
 * One `setInterval` for every registrant, not one per daemon: the beat is a
 * coarse poll against a timestamp, so N timers would buy nothing but N chances
 * to leak one.
 */

/** How often the reaper checks. Coarse on purpose — the windows are minutes. */
const IDLE_REAP_INTERVAL_MS = 60_000;

/** Default free-memory threshold below which host memory is considered under pressure (4 GB). */
export const DEFAULT_PRESSURE_THRESHOLD_BYTES = 4 * 1024 * 1024 * 1024;
/** Dead-band: memory must rise above threshold + dead-band (4 GB + 2 GB = 6 GB) to exit pressure. */
export const DEFAULT_PRESSURE_DEAD_BAND_BYTES = 2 * 1024 * 1024 * 1024;
/** How long pressure must be sustained before a daemon is released early (30s). */
export const DEFAULT_SUSTAINED_PRESSURE_MS = 30_000;
/** Calm-down window after releasing a daemon before another daemon can be released (60s). */
export const DEFAULT_PRESSURE_CALM_DOWN_MS = 60_000;

/** Format a timestamp into HH:MM (e.g. 09:14) for human-legible release notes. */
export function formatReleaseTime(timestamp = Date.now()) {
  const d = new Date(timestamp);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** name → `{ getIdleMs, isPinned, isRunning, isBusy, warm, stop, lastUsedAt, releaseReason, releasedAt }`. */
const idleDaemons = new Map();
let reaperTimer = null;

let pressureHistory = [];
let lastPressureReleaseAt = null;
const MAX_PRESSURE_HISTORY = 100;

export function recordPressureSample({ at = Date.now(), free, used, total }) {
  pressureHistory.push({ at, free, used, total });
  if (pressureHistory.length > MAX_PRESSURE_HISTORY) {
    pressureHistory = pressureHistory.slice(-MAX_PRESSURE_HISTORY);
  }
}

export function getPressureHistory() {
  return [...pressureHistory];
}

export function getLastPressureReleaseTime() {
  return lastPressureReleaseAt;
}

export function setLastPressureReleaseTime(time) {
  lastPressureReleaseAt = time;
}

/**
 * A user-supplied idle window in minutes, as milliseconds.
 *
 * `0` means "never stop" and is returned as `0`, NOT as null — it is a real
 * choice (today's always-on behaviour) and must survive a round-trip through
 * settings distinguishably from "no value stored". Anything unparseable or
 * negative is `null` = not configured, which the reaper also treats as never.
 *
 * @param {unknown} minutes
 * @returns {number|null}
 */
export function idleWindowMs(minutes) {
  // `Number(null)` and `Number('')` are both 0, which would make "nothing
  // stored" indistinguishable from the user explicitly choosing "never stop".
  // They mean the same thing to the reaper, but not to a caller reporting what
  // is configured — so absent stays null.
  if (minutes === null || minutes === undefined || minutes === '') return null;
  const n = Number(minutes);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n) * 60_000;
}

/**
 * Register a daemon the reaper may stop.
 *
 * `lastUsedAt` is seeded to NOW rather than to null, so a daemon that was just
 * started by hand — or one PortOS re-adopted after its own restart — gets a
 * full idle window before it is eligible. Seeding null and treating it as
 * "infinitely idle" would reap a server the user started seconds ago.
 *
 * Re-registering the same name refreshes the hooks and leaves `lastUsedAt`
 * alone, so a manager reloaded under test doesn't reset a live clock.
 *
 * @param {{
 *   name: string,
 *   getIdleMs: () => Promise<number|null>|number|null,
 *   isPinned?: () => Promise<boolean>|boolean,
 *   isRunning?: () => Promise<boolean>|boolean,
 *   isBusy?: () => Promise<boolean>|boolean,
 *   warm?: () => Promise<void>|void,
 *   stop: () => Promise<unknown>
 * }} daemon
 *   `getIdleMs` resolves the CURRENT configured window on every sweep; `null`/`0` = never stop.
 *   `isPinned` returns true if user pinned the server ("keep loaded") — pinned servers are never stopped.
 *   `isRunning` checks if the daemon process is online.
 *   `isBusy` returns true while a wake/start, a still-loading checkpoint, or an inference request is in flight — busy servers are never stopped.
 *   `warm` may resolve the port `isBusy` reads before the synchronous re-check. It must not itself decide to stop.
 */
export function registerIdleDaemon({ name, getIdleMs, isPinned, isRunning, isBusy, warm, stop }) {
  const existing = idleDaemons.get(name);
  idleDaemons.set(name, {
    getIdleMs,
    isPinned: typeof isPinned === 'function' ? isPinned : () => Boolean(isPinned),
    isRunning: typeof isRunning === 'function' ? isRunning : null,
    isBusy: typeof isBusy === 'function' ? isBusy : () => Boolean(isBusy),
    warm: typeof warm === 'function' ? warm : null,
    stop,
    lastUsedAt: existing?.lastUsedAt ?? Date.now(),
    releaseReason: existing?.releaseReason ?? null,
    releasedAt: existing?.releasedAt ?? null,
  });
}

/**
 * Record that something just used `name` — the signal the whole mechanism runs
 * on. Call it on real traffic (an inference request, a lazy start), never on a
 * status poll: a status card that refreshes every few seconds would otherwise
 * hold a 24GB checkpoint resident forever while nobody used it.
 *
 * Clears any prior release reason now that the server is active again.
 *
 * @param {string} name
 */
export function markDaemonUsed(name) {
  const entry = idleDaemons.get(name);
  if (entry) {
    entry.lastUsedAt = Date.now();
    entry.releaseReason = null;
    entry.releasedAt = null;
  }
}

/** The recorded release reason for `name`, or `null`. */
export function daemonReleaseReason(name) {
  return idleDaemons.get(name)?.releaseReason ?? null;
}

/**
 * Pure policy function for memory pressure daemon eviction.
 * Evaluates current state, pressure reading, and recent history.
 *
 * Returns `{ shouldRelease: boolean, target?: object, reason?: string, ... }`.
 */
export function evaluateMemoryPressurePolicy({
  daemons = [],
  memoryStats = null,
  history = [],
  now = Date.now(),
  lastReleasedAt = null,
  options = {},
} = {}) {
  const thresholdBytes = options.pressureThresholdBytes ?? DEFAULT_PRESSURE_THRESHOLD_BYTES;
  const deadBandBytes = options.deadBandBytes ?? DEFAULT_PRESSURE_DEAD_BAND_BYTES;
  const sustainedDurationMs = options.sustainedDurationMs ?? DEFAULT_SUSTAINED_PRESSURE_MS;
  const calmDownMs = options.calmDownMs ?? DEFAULT_PRESSURE_CALM_DOWN_MS;

  if (!memoryStats || typeof memoryStats.free !== 'number') {
    return { shouldRelease: false, target: null, reason: 'memory stats unavailable' };
  }

  const free = memoryStats.free;
  const wasUnderPressure = Boolean(options.wasUnderPressure ?? (lastReleasedAt && (now - lastReleasedAt < calmDownMs * 2)));
  const exitThresholdBytes = thresholdBytes + deadBandBytes;
  const isRelieved = wasUnderPressure
    ? free >= exitThresholdBytes
    : free >= thresholdBytes;

  if (isRelieved) {
    return {
      shouldRelease: false,
      target: null,
      reason: 'host memory not under pressure',
      free,
      thresholdBytes,
      exitThresholdBytes,
      wasUnderPressure,
    };
  }

  if (lastReleasedAt && (now - lastReleasedAt < calmDownMs)) {
    return {
      shouldRelease: false,
      target: null,
      reason: 'in calm-down window',
      remainingCalmDownMs: calmDownMs - (now - lastReleasedAt),
    };
  }

  if (sustainedDurationMs > 0) {
    // Track "under pressure" against the same bar isRelieved just used above —
    // when wasUnderPressure, that's the higher exit threshold, not the base
    // threshold — otherwise samples sitting in the dead-band (below exitThresholdBytes
    // but above thresholdBytes) never count as sustained and eviction starves.
    const activeThresholdBytes = wasUnderPressure ? exitThresholdBytes : thresholdBytes;
    const validSamples = (history || [])
      .map((s) => ({
        at: s.at ?? s.timestamp ?? s.time ?? now,
        free: s.free ?? (s.total != null && s.used != null ? s.total - s.used : null),
      }))
      .filter((s) => s.at <= now && typeof s.free === 'number')
      .sort((a, b) => a.at - b.at);

    let earliestUnderPressureAt = null;
    for (let i = validSamples.length - 1; i >= 0; i--) {
      if (validSamples[i].free < activeThresholdBytes) {
        earliestUnderPressureAt = validSamples[i].at;
      } else {
        break;
      }
    }

    const sustainedMs = earliestUnderPressureAt != null ? (now - earliestUnderPressureAt) : 0;
    if (sustainedMs < sustainedDurationMs) {
      return {
        shouldRelease: false,
        target: null,
        reason: 'pressure not sustained',
        sustainedMs,
        requiredMs: sustainedDurationMs,
      };
    }
  }

  const list = Array.isArray(daemons)
    ? daemons
    : Array.from(daemons?.values?.() || []);
  const eligible = list.filter((d) => (
    d
    && d.running !== false
    && !d.busy
    && !d.pinned
    && !d.keepLoaded
  ));

  if (eligible.length === 0) {
    return {
      shouldRelease: false,
      target: null,
      reason: 'no eligible daemons to release',
    };
  }

  // Least recently used ordering: smallest lastUsedAt first
  eligible.sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0));
  const target = eligible[0];

  return {
    shouldRelease: true,
    target,
    reason: 'host memory pressure',
    free,
    thresholdBytes,
  };
}

// Synchronous on purpose. Awaiting here is the yield in which a request can
// start after the snapshot and still be stopped. A thenable fails safe to busy;
// its rejection is swallowed so the second call cannot become unhandled.
function readBusySync(entry) {
  try {
    const value = entry?.isBusy?.();
    if (value && typeof value.then === 'function') {
      value.catch(() => {});
      return true;
    }
    return Boolean(value);
  } catch {
    return true;
  }
}

/**
 * Sweep: stop daemons whose idle window has elapsed, and run pressure-aware pass
 * to release the least recently used unpinned daemon under sustained host memory pressure.
 *
 * @param {number} [now]
 * @param {object} [options]
 * @returns {Promise<string[]>} the names actually stopped
 */
export async function reapIdleDaemons(now = Date.now(), options = {}) {
  const stopped = [];

  // 1. Normal idle timeout pass
  for (const [name, entry] of idleDaemons) {
    // Fail-safe to pinned/busy on a transient read error, matching the pressure-aware
    // pass below — assuming "not pinned" or "not busy" here would risk stopping a
    // keepLoaded or actively serving daemon on a flaky read.
    await Promise.resolve(entry.warm?.()).catch(() => {});
    const isPinned = await Promise.resolve(entry.isPinned?.()).catch(() => true);
    if (isPinned) continue; // Pinned servers are exempt

    const isBusy = await Promise.resolve(entry.isBusy?.()).catch(() => true);
    if (isBusy) continue; // Active wake/start or in-flight request is exempt

    // Already stopped (by the pressure-aware pass, or externally) — skip so this
    // pass doesn't overwrite its release reason and doesn't preempt the
    // pressure-aware pass below via the early return once its idle window re-elapses.
    const isRunning = entry.isRunning
      ? await Promise.resolve(entry.isRunning()).catch(() => true)
      : true;
    if (!isRunning) continue;

    // Resolved per sweep, so lowering the window in Settings applies to the very
    // next beat rather than to the next server restart.
    const windowMs = await Promise.resolve(entry.getIdleMs()).catch(() => null);
    if (!windowMs || windowMs <= 0) continue;
    if (now - entry.lastUsedAt < windowMs) continue;
    if (readBusySync(entry)) continue;

    const idleMin = Math.round((now - entry.lastUsedAt) / 60_000);
    console.log(`💤 Stopping ${name} — idle ${idleMin}m (window ${Math.round(windowMs / 60_000)}m)`);
    // `stop` reaches PM2 over a subprocess. A failure here must not kill the
    // interval that every other daemon's reaping depends on.
    const failed = await Promise.resolve(entry.stop()).then(() => null, (err) => err);
    if (failed) {
      console.error(`❌ Idle stop of ${name} failed: ${failed.message}`);
      continue;
    }
    // Only on success: a failed stop that left the daemon up would otherwise
    // retry every beat forever with the clock reset each time.
    entry.lastUsedAt = now;
    entry.releasedAt = now;
    entry.releaseReason = `released at ${formatReleaseTime(now)} — idle timeout`;
    stopped.push(name);
  }

  // Release at most one daemon per tick and re-read before the next
  if (stopped.length > 0) {
    return stopped;
  }

  // 2. Pressure-aware pass
  const memoryStats = options.memoryStats ?? await getMemoryStats().catch(() => null);
  if (memoryStats) {
    recordPressureSample({
      at: now,
      free: memoryStats.free,
      used: memoryStats.used,
      total: memoryStats.total,
    });

    const daemonList = [];
    for (const [name, entry] of idleDaemons) {
      await Promise.resolve(entry.warm?.()).catch(() => {});
      const isPinned = await Promise.resolve(entry.isPinned?.()).catch(() => true);
      const isBusy = await Promise.resolve(entry.isBusy?.()).catch(() => true);
      const isRunning = entry.isRunning
        ? await Promise.resolve(entry.isRunning()).catch(() => false)
        : true;
      daemonList.push({
        name,
        entry,
        lastUsedAt: entry.lastUsedAt,
        pinned: isPinned,
        busy: isBusy,
        running: isRunning,
      });
    }

    const policyOptions = { ...options.policyOptions, ...options };
    const decision = evaluateMemoryPressurePolicy({
      daemons: daemonList,
      memoryStats,
      history: options.history ?? getPressureHistory(),
      now,
      lastReleasedAt: getLastPressureReleaseTime(),
      options: policyOptions,
    });

    if (decision.shouldRelease && decision.target && !readBusySync(decision.target.entry)) {
      const { target } = decision;
      const freeMb = Math.round((memoryStats.free || 0) / (1024 * 1024));
      console.log(`⚠️ Stopping ${target.name} — host memory pressure (free ${freeMb}MB)`);
      const failed = await Promise.resolve(target.entry.stop()).then(() => null, (err) => err);
      if (failed) {
        console.error(`❌ Pressure stop of ${target.name} failed: ${failed.message}`);
      } else {
        target.entry.lastUsedAt = now;
        target.entry.releasedAt = now;
        target.entry.releaseReason = `released at ${formatReleaseTime(now)} — host memory pressure`;
        setLastPressureReleaseTime(now);
        stopped.push(target.name);
      }
    }
  }

  return stopped;
}

/**
 * Arm the single reaper timer. Idempotent — a second call is a no-op rather than
 * a second interval.
 *
 * Boot-safe by construction: it arms a timer and reads timestamps. It makes no
 * AI provider call, which is what lets `server/index.js` start it unconditionally
 * under AGENTS.md's "No cold-bootstrap LLM calls" rule.
 *
 * @param {{intervalMs?: number}} [options]
 */
export function startIdleReaper({ intervalMs = IDLE_REAP_INTERVAL_MS } = {}) {
  if (reaperTimer) return;
  reaperTimer = setInterval(() => {
    // Outside the Express request lifecycle: an unhandled rejection here would
    // take the process down, so the sweep's own failures are swallowed after
    // logging (each daemon's stop failure is already reported individually).
    reapIdleDaemons().catch((err) => console.error(`❌ Idle reaper sweep failed: ${err.message}`));
  }, intervalMs);
  // Never hold the event loop open for this — a shutdown must not wait a minute
  // for a poll that has nothing to do.
  reaperTimer.unref?.();
  console.log(`💤 Idle reaper armed (checking every ${Math.round(intervalMs / 1000)}s)`);
}

/** Disarm the reaper. For shutdown and for test isolation. */
export function stopIdleReaper() {
  if (!reaperTimer) return;
  clearInterval(reaperTimer);
  reaperTimer = null;
}

/** Test seam: drop every registration, reset pressure state, and disarm the timer. */
export function _resetIdleDaemonsForTests() {
  stopIdleReaper();
  idleDaemons.clear();
  pressureHistory = [];
  lastPressureReleaseAt = null;
}
