import { getMemoryStats } from './memoryStats.js';

/**
 * Shared plumbing for a local daemon PortOS runs as an optional PM2 process
 * (`llamaServerManager.js` → `portos-llama-server`, `mtplxServerManager.js` →
 * `portos-mtplx`, `slotstreamServerManager.js` → `portos-slotstream`).
 *
 * Both managers answer the same two questions the same way, and the answers are
 * fiddly enough that two copies drift:
 *
 *   - **What did it print?** A launcher card is useless without the daemon's
 *     recent output, and the output lives in two places — the lines PortOS
 *     itself logged around the launch, and what `pm2 logs` has. They have to be
 *     merged without duplicating the overlap and without growing unbounded.
 *   - **What was it launched with?** After a PortOS restart the only record of a
 *     still-online daemon's configuration is its PM2 argv, so both managers
 *     recover the launch flags by reading values back out of that array.
 *
 * Deliberately NOT a "daemon manager" abstraction: what each daemon's launch
 * line means, when it may be started, and what a refusal should say are exactly
 * the parts that differ, and folding them together would produce a base class
 * with two special cases. This is the shared *mechanism* only.
 */

/**
 * The PM2 process names of the local model servers PortOS manages.
 *
 * Declared here rather than in each manager so the health monitor can recognize
 * them without importing a manager (and its whole PM2/model-probe dependency
 * chain); `llamaServerManager.js`, `mtplxServerManager.js`, and
 * `slotstreamServerManager.js` re-export these as `LLAMA_APP` / `MTPLX_APP` /
 * `SLOTSTREAM_APP`.
 */
export const LLAMA_APP = 'portos-llama-server';
export const MTPLX_APP = 'portos-mtplx';
export const SLOTSTREAM_APP = 'portos-slotstream';
const MODEL_SERVER_APPS = [LLAMA_APP, MTPLX_APP, SLOTSTREAM_APP];

/**
 * Whether a PM2 process is one of those model servers.
 *
 * A model server's resident size IS the checkpoint it loaded — llama.cpp,
 * MTPLX, and Slotstream hold multi-GB weights for as long as they are up, by
 * design. Measuring
 * them against a generic per-process memory cap produces a warning the user can
 * never clear (a 24GB llama-server against a 2GB cap is a correctly-running
 * server, not a leak), so callers policing per-process memory skip them. Genuine
 * host-wide pressure is still reported — `services/proactiveAlerts.js` alerts on
 * total used-vs-installed memory, which is where a too-large model actually
 * shows up.
 *
 * @param {string} [name] PM2 process name
 */
export const isModelServerProcess = (name) => MODEL_SERVER_APPS.includes(name);

/** Same cap both managers used, and what the launcher cards render. */
const DEFAULT_MAX_LINES = 100;

/**
 * A bounded, timestamped ring buffer of a daemon's recent output.
 *
 * `withPm2Logs` does NOT fold the PM2 output into the buffer: PM2 owns those
 * lines and re-reads them on every status call, so remembering them here would
 * grow a second copy that outlives the process they came from. It returns the
 * merged VIEW a status response renders.
 *
 * @param {{maxLines?: number}} [options]
 */
export function createDaemonLogBuffer({ maxLines = DEFAULT_MAX_LINES } = {}) {
  let lines = [];

  const append = (line) => {
    if (!line) return;
    const text = String(line).trimEnd();
    if (!text) return;
    lines.push(`[${new Date().toISOString()}] ${text}`);
    if (lines.length > maxLines) lines = lines.slice(-maxLines);
  };

  return {
    append,
    maxLines,
    reset: () => { lines = []; },
    snapshot: () => [...lines],
    /**
     * This buffer's lines followed by anything in `pm2Output` it does not
     * already hold, capped to the same budget.
     * @param {string} pm2Output combined stdout + stderr from `pm2 logs`
     * @returns {string[]}
     */
    withPm2Logs(pm2Output) {
      const merged = [...lines];
      const seen = new Set(merged);
      for (const line of String(pm2Output || '').split('\n').map((l) => l.trimEnd()).filter(Boolean)) {
        if (seen.has(line)) continue;
        merged.push(line);
        seen.add(line);
      }
      return merged.length > maxLines ? merged.slice(-maxLines) : merged;
    },
  };
}

/**
 * The value following `flag` in a PM2 process's recorded argv, or `null`.
 *
 * `null` means the flag was NOT on the launch line, which is distinct from a
 * flag whose value happens to be falsy — a caller reconstructing a config must
 * leave an absent flag off a relaunch rather than substituting a default the
 * daemon never saw.
 *
 * @param {string[]|string} args PM2's `args` (an array, or the space-joined string it sometimes reports)
 * @param {string} flag
 * @returns {string|null}
 */
export function pm2ArgValue(args, flag) {
  const list = Array.isArray(args) ? args : String(args || '').split(' ');
  const idx = list.indexOf(flag);
  return idx !== -1 && idx + 1 < list.length ? list[idx + 1] : null;
}

/**
 * Shared watcher for a local daemon PortOS owns through PM2.
 *
 * Managers supply their daemon-specific launch-line parser and endpoint probe;
 * the watcher owns the common PM2 adoption, status skeleton, bounded logs, and
 * stop-then-relaunch port-release wait. State remains in the manager through
 * `getConfig` / `setConfig`, so install and tuning paths can keep their domain
 * rules without reaching into this mechanism.
 *
 * Dependency callbacks are explicit both to keep this module side-effect free
 * and to preserve the managers' existing test seams around PM2 and networking.
 */
export function createDaemonWatcher({
  appName,
  defaultHost = '127.0.0.1',
  defaultPort,
  endpointFor,
  parseConfigFromArgs,
  probe,
  isPortInUse,
  sleep,
  getConfig,
  setConfig,
  getLastExitError,
  getAppStatus,
  getSavedProcessNames,
  execPm2,
  getPortReleaseTimeoutMs,
  preserveConfigOnReadFailure = false,
  maxLogLines,
}) {
  const logs = createDaemonLogBuffer({ maxLines: maxLogLines });

  const recoverConfig = (pm2Status) => {
    const current = getConfig();
    if (current || pm2Status?.status !== 'online' || !pm2Status.args) return current;
    const recovered = parseConfigFromArgs(pm2Status.args);
    setConfig(recovered);
    return recovered;
  };

  const readLaunch = async () => {
    const pm2Status = await getAppStatus(appName);
    if (pm2Status === null) return { managed: false, config: null, readFailed: true };
    if (pm2Status.status !== 'online') return { managed: false, config: null, readFailed: false };
    return { managed: true, config: recoverConfig(pm2Status), readFailed: false };
  };

  const endpoint = () => endpointFor(getConfig());

  const getStatusBase = async ({ installed }) => {
    const [pm2Status, savedApps] = await Promise.all([getAppStatus(appName), getSavedProcessNames()]);
    const isReadFailed = pm2Status === null;
    const isManagedActive = pm2Status?.status === 'online';
    const config = recoverConfig(pm2Status);
    const resolvedEndpoint = endpointFor(config);
    const reachable = await probe(resolvedEndpoint);
    const pm2Logs = pm2Status && pm2Status.status !== 'not_found'
      ? await execPm2(['logs', appName, '--nostream', '--lines', String(logs.maxLines)]).catch(() => null)
      : null;

    return {
      installed,
      running: isManagedActive || reachable,
      managed: isReadFailed ? null : isManagedActive,
      pid: isManagedActive ? (pm2Status.pid || null) : null,
      host: config?.host || defaultHost,
      port: config?.port ?? defaultPort,
      endpoint: resolvedEndpoint,
      config: isManagedActive || (isReadFailed && preserveConfigOnReadFailure) ? config : null,
      runAtStartup: savedApps === null ? null : savedApps.includes(appName),
      recentLogs: logs.withPm2Logs(`${pm2Logs?.stdout || ''}\n${pm2Logs?.stderr || ''}`),
      lastExitError: isReadFailed ? 'Failed to read PM2 status' : getLastExitError(),
      releaseReason: isManagedActive ? null : (idleDaemons.get(appName)?.releaseReason ?? null),
    };
  };

  const waitForPortRelease = async (port) => {
    const deadline = Date.now() + getPortReleaseTimeoutMs();
    while (Date.now() < deadline && await isPortInUse(port)) await sleep(200);
  };

  return {
    appendLog: logs.append,
    endpoint,
    getStatusBase,
    readLaunch,
    resetLogs: logs.reset,
    snapshotLogs: logs.snapshot,
    waitForPortRelease,
  };
}

// =============================================================================
// IDLE REAPER
// =============================================================================

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

/** name → `{ getIdleMs, isPinned, isRunning, stop, lastUsedAt, releaseReason, releasedAt }`. */
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
 *   stop: () => Promise<unknown>
 * }} daemon
 *   `getIdleMs` resolves the CURRENT configured window on every sweep; `null`/`0` = never stop.
 *   `isPinned` returns true if user pinned the server ("keep loaded") — pinned servers are never stopped.
 *   `isRunning` checks if the daemon process is online.
 */
export function registerIdleDaemon({ name, getIdleMs, isPinned, isRunning, stop }) {
  const existing = idleDaemons.get(name);
  idleDaemons.set(name, {
    getIdleMs,
    isPinned: typeof isPinned === 'function' ? isPinned : () => Boolean(isPinned),
    isRunning: typeof isRunning === 'function' ? isRunning : null,
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

/** The recorded last-use timestamp for `name`, or `null`. Exposed for status cards. */
export function daemonLastUsedAt(name) {
  return idleDaemons.get(name)?.lastUsedAt ?? null;
}

/** The recorded release reason for `name`, or `null`. */
export function daemonReleaseReason(name) {
  return idleDaemons.get(name)?.releaseReason ?? null;
}

/** Explicitly clear release reason for `name`. */
export function clearDaemonReleaseReason(name) {
  const entry = idleDaemons.get(name);
  if (entry) {
    entry.releaseReason = null;
    entry.releasedAt = null;
  }
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
    // Fail-safe to pinned on a transient read error, matching the pressure-aware
    // pass below — assuming "not pinned" here would risk stopping a keepLoaded
    // daemon on a flaky settings read.
    const isPinned = await Promise.resolve(entry.isPinned?.()).catch(() => true);
    if (isPinned) continue; // Pinned servers are exempt

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
      const isPinned = await Promise.resolve(entry.isPinned?.()).catch(() => true);
      const isRunning = entry.isRunning
        ? await Promise.resolve(entry.isRunning()).catch(() => false)
        : true;
      daemonList.push({
        name,
        entry,
        lastUsedAt: entry.lastUsedAt,
        pinned: isPinned,
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

    if (decision.shouldRelease && decision.target) {
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

